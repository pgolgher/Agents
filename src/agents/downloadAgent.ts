import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import dotenv from "dotenv";

dotenv.config({ override: true });

const AGU_URL =
  "https://supersapiens.agu.gov.br/apps/tarefas/judicial/minhas-tarefas/entrada";

const OUTPUT_DIR = path.resolve(process.cwd(), "downloads");

/**
 * Navigates to SuperSapiens, follows all redirects, logs in via Rede AGU,
 * and saves a full-page screenshot of the resulting screen.
 *
 * Credentials are read from environment variables:
 *   AGU_EMAIL  — your Rede AGU login (e.g. luciana.aguiar)
 *   AGU_SENHA  — your Rede AGU password
 */
export async function previewTarefas(): Promise<string> {
  const email = process.env.AGU_EMAIL;
  const senha = process.env.AGU_SENHA;

  if (!email || !senha) {
    throw new Error("AGU_EMAIL and AGU_SENHA must be set in your .env file.");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false, // visible so you can watch the flow
    slowMo: 400,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  // Log all responses so we can trace the auth flow
  page.on("response", async (response) => {
    const status = response.status();
    const url = response.url();
    if (url.includes("supersapiens") || url.includes("agu.gov")) {
      console.log(`  [${status}] ${url}`);
    }
  });

  try {
    // ── Step 1: Navigate and follow all redirects ─────────────────────────────
    console.log(`\n[DownloadAgent] → ${AGU_URL}`);
    await page.goto(AGU_URL, { waitUntil: "networkidle", timeout: 60_000 });
    console.log(`[DownloadAgent] Landed on: ${page.url()}`);
    await screenshot(page, OUTPUT_DIR, "01-landing");

    // ── Step 2: Click "Rede AGU" (toggles form — no page navigation) ────────────
    console.log("[DownloadAgent] Looking for 'Rede AGU'...");
    // button.bt-rede serves dual purpose:
    //   1st click → switches form to "Autenticação Rede AGU" (button text becomes "Entrar")
    //   2nd click → submits the Rede AGU form (Playwright waits until form is valid/enabled)
    const redeAguBtn = page.locator("button.bt-rede");
    await redeAguBtn.waitFor({ state: "visible", timeout: 20_000 });
    await redeAguBtn.click();
    console.log("[DownloadAgent] Clicked 'Rede AGU'. Waiting for Rede AGU form...");

    // Angular toggles the form in-place — no page navigation occurs.
    // Wait for the email field to appear rather than waitForLoadState.
    await page.locator('input[name="username"]').waitFor({ state: "visible", timeout: 10_000 });
    console.log("[DownloadAgent] Rede AGU form is visible.");
    await screenshot(page, OUTPUT_DIR, "02-after-rede-agu");

    // ── Step 3: Fill the Rede AGU login form ─────────────────────────────────
    console.log("[DownloadAgent] Filling Rede AGU login form...");

    // Angular Material reactive forms require real keystrokes (keydown/keypress/keyup)
    // to mark fields as dirty/valid. fill() only fires a synthetic input event which
    // Angular ignores — the button stays disabled. pressSequentially() types character
    // by character, exactly like a real user, so Angular's FormControl updates correctly.

    // E-mail field: name="username", type="email"
    const emailField = page.locator('input[name="username"]');
    await emailField.click();
    await page.keyboard.press("Control+a"); // select any autofill
    await emailField.pressSequentially(email, { delay: 50 });
    await page.keyboard.press("Tab"); // blur → Angular marks field touched

    // Senha field: name="password"
    const passField = page.locator('input[name="password"]');
    await passField.click();
    await page.keyboard.press("Control+a");
    await passField.pressSequentially(senha, { delay: 50 });
    await page.keyboard.press("Tab"); // blur → Angular validates form, enables Entrar
    await screenshot(page, OUTPUT_DIR, "03-form-filled");

    // ── Step 4: Submit ────────────────────────────────────────────────────────
    // Debug: log button state and form validity before clicking
    const btnState = await page.evaluate(() => {
      const btn = document.querySelector("button.bt-rede") as HTMLButtonElement;
      const email = document.querySelector('input[name="username"]') as HTMLInputElement;
      const pass  = document.querySelector('input[name="password"]') as HTMLInputElement;
      return {
        btnDisabled:   btn?.disabled,
        btnHasDisabledClass: btn?.className.includes("mat-mdc-button-disabled"),
        emailValue:    email?.value,
        emailNgValid:  email?.className.includes("ng-valid"),
        passLength:    pass?.value.length,
        passNgValid:   pass?.className.includes("ng-valid"),
      };
    });
    console.log("[DownloadAgent] Pre-submit state:", JSON.stringify(btnState));

    if (btnState.btnDisabled) {
      // Button still disabled — Angular form not valid. Try pressing Enter instead.
      console.log("[DownloadAgent] Button disabled — pressing Enter to submit...");
      await passField.press("Enter");
    } else {
      console.log("[DownloadAgent] Button enabled — clicking Entrar...");
      await redeAguBtn.click();
    }
    console.log("[DownloadAgent] Submitted. Waiting for navigation away from login...");

    // waitForLoadState resolves too early on this Angular SPA — the auth API calls
    // (ldap_get_token, profile) happen after Angular's route transition.
    // Instead wait until the URL actually leaves /auth/login.
    await page.waitForURL((url) => !url.toString().includes("/auth/login"), {
      timeout: 60_000,
    });
    // Then wait for the page content to fully settle
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    console.log(`[DownloadAgent] Final URL: ${page.url()}`);

    // ── Step 5: Screenshot the final screen ───────────────────────────────────
    const finalShot = await screenshot(page, OUTPUT_DIR, "04-final");
    console.log(`\n✅ Final screen saved: ${finalShot}`);

    // Open the screenshot so it's immediately visible
    openFile(finalShot);

    return finalShot;
  } finally {
    // Keep the browser open for 5 s so you can inspect it, then close
    await page.waitForTimeout(5_000);
    await context.close();
    await browser.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function screenshot(
  page: import("playwright").Page,
  dir: string,
  label: string
): Promise<string> {
  const filePath = path.join(dir, `${label}-${timestamp()}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`[DownloadAgent] Screenshot: ${filePath}`);
  return filePath;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function openFile(filePath: string): void {
  try {
    // macOS: open, Linux: xdg-open, Windows: start
    const cmd =
      process.platform === "darwin"
        ? `open "${filePath}"`
        : process.platform === "win32"
        ? `start "" "${filePath}"`
        : `xdg-open "${filePath}"`;
    execSync(cmd);
  } catch {
    // Non-fatal — file is still saved
  }
}

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
  previewTarefas()
    .then((shot) => {
      console.log(`\n📸 Done. Screenshot: ${shot}`);
    })
    .catch((err) => {
      console.error("❌ Error:", err.message);
      process.exit(1);
    });
}
