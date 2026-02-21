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

  // Log every redirect so we can see the full chain
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 300 && status < 400) {
      console.log(`  ↳ [${status}] ${response.url()}`);
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

    // E-mail field: name="username", type="email"
    const emailField = page.locator('input[name="username"]');
    await emailField.click();
    await emailField.fill(email);
    await page.keyboard.press("Tab"); // trigger Angular change detection / blur

    // Senha field: name="password"
    const passField = page.locator('input[name="password"]');
    await passField.click();
    await passField.fill(senha);
    await page.keyboard.press("Tab"); // trigger Angular form validation
    await screenshot(page, OUTPUT_DIR, "03-form-filled");

    // ── Step 4: Submit ────────────────────────────────────────────────────────
    // button.bt-rede is now "Entrar" — Playwright's actionability check waits
    // until Angular enables it (i.e. the form becomes valid) before clicking.
    console.log("[DownloadAgent] Submitting Rede AGU form...");
    await redeAguBtn.click();
    console.log("[DownloadAgent] Submitted. Waiting for navigation...");

    await page.waitForLoadState("networkidle", { timeout: 60_000 });
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
