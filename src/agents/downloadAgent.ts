import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ override: true });

const AGU_URL =
  "https://supersapiens.agu.gov.br/apps/tarefas/judicial/minhas-tarefas/entrada";

const OUTPUT_DIR = path.resolve(process.cwd(), "downloads");
const OUTPUT_FILE = path.join(
  OUTPUT_DIR,
  `tarefas-${new Date().toISOString().slice(0, 10)}.json`
);

export interface Tarefa {
  id?: string;
  titulo?: string;
  descricao?: string;
  prazo?: string;
  status?: string;
  rawText?: string;
}

/**
 * Logs in to SuperSapiens via "Rede AGU" and downloads the task list
 * from the "Minhas Tarefas - Entrada" page.
 *
 * Credentials are read from environment variables:
 *   AGU_EMAIL   — your Rede AGU login
 *   AGU_SENHA   — your Rede AGU password
 */
export async function downloadTarefas(): Promise<Tarefa[]> {
  const email = process.env.AGU_EMAIL;
  const senha = process.env.AGU_SENHA;

  if (!email || !senha) {
    throw new Error(
      "AGU_EMAIL and AGU_SENHA must be set in your .env file."
    );
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false, // set to true once the login flow is confirmed working
    slowMo: 300,     // slightly slow so we can see what's happening
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  try {
    console.log("[DownloadAgent] Navigating to SuperSapiens...");
    await page.goto(AGU_URL, { waitUntil: "networkidle", timeout: 60_000 });

    // ── Step 1: Click "Rede AGU" on the login selection screen ──────────────
    console.log("[DownloadAgent] Looking for 'Rede AGU' button...");
    const redeAguButton = page.getByRole("button", { name: /rede\s*agu/i })
      .or(page.getByText(/rede\s*agu/i).first());

    await redeAguButton.waitFor({ timeout: 20_000 });
    await redeAguButton.click();
    console.log("[DownloadAgent] Clicked 'Rede AGU'.");

    // ── Step 2: Fill login form ───────────────────────────────────────────────
    console.log("[DownloadAgent] Filling credentials...");
    await page.waitForSelector("input[type='text'], input[type='email'], input[name*='user'], input[name*='login']", {
      timeout: 20_000,
    });

    // Fill email/username — try common field selectors
    const emailField =
      page.locator("input[type='email']").first() ||
      page.locator("input[name*='user']").first() ||
      page.locator("input[name*='login']").first() ||
      page.locator("input[type='text']").first();

    await emailField.fill(email);

    // Fill password
    await page.locator("input[type='password']").first().fill(senha);

    // Submit
    const submitBtn =
      page.getByRole("button", { name: /entrar|login|acessar|sign in/i }).first();
    await submitBtn.click();
    console.log("[DownloadAgent] Submitted login form.");

    // ── Step 3: Wait for the tasks page to load ───────────────────────────────
    console.log("[DownloadAgent] Waiting for tasks page...");
    await page.waitForURL(/minhas-tarefas/, { timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 60_000 });
    console.log("[DownloadAgent] Tasks page loaded.");

    // ── Step 4: Scroll to load all tasks (infinite scroll) ───────────────────
    console.log("[DownloadAgent] Scrolling to load all tasks...");
    let previousHeight = 0;
    for (let i = 0; i < 30; i++) {
      const currentHeight: number = await page.evaluate(
        () => document.body.scrollHeight
      );
      if (currentHeight === previousHeight) break;
      previousHeight = currentHeight;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1_500);
    }

    // ── Step 5: Extract task data ─────────────────────────────────────────────
    console.log("[DownloadAgent] Extracting task data...");
    const tarefas: Tarefa[] = await page.evaluate(() => {
      const results: Array<{
        id?: string;
        titulo?: string;
        descricao?: string;
        prazo?: string;
        status?: string;
        rawText?: string;
      }> = [];

      // Try to find task cards — adjust selectors based on actual page structure
      const cards = document.querySelectorAll(
        "[class*='tarefa'], [class*='task'], [class*='card'], [class*='item-tarefa'], li[class*='item']"
      );

      if (cards.length > 0) {
        cards.forEach((card: Element) => {
          results.push({
            titulo: card.querySelector("[class*='titulo'], [class*='title'], h3, h4, strong")?.textContent?.trim(),
            descricao: card.querySelector("[class*='descricao'], [class*='desc'], p")?.textContent?.trim(),
            prazo: card.querySelector("[class*='prazo'], [class*='date'], [class*='data']")?.textContent?.trim(),
            status: card.querySelector("[class*='status'], [class*='badge']")?.textContent?.trim(),
            rawText: card.textContent?.replace(/\s+/g, " ").trim(),
          });
        });
      } else {
        // Fallback: grab the full visible page text structured by sections
        const main = document.querySelector("main, [role='main'], app-root, .content");
        const el = (main ?? document.body) as HTMLElement;
        results.push({ rawText: el.innerText.slice(0, 200_000) });
      }

      return results;
    });

    // ── Step 6: Take a screenshot for verification ────────────────────────────
    const screenshotPath = path.join(OUTPUT_DIR, `screenshot-${new Date().toISOString().slice(0, 10)}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[DownloadAgent] Screenshot saved: ${screenshotPath}`);

    // ── Step 7: Save JSON ─────────────────────────────────────────────────────
    const output = {
      fetchedAt: new Date().toISOString(),
      url: page.url(),
      count: tarefas.length,
      tarefas,
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
    console.log(`[DownloadAgent] Saved ${tarefas.length} task(s) to: ${OUTPUT_FILE}`);

    return tarefas;
  } finally {
    await context.close();
    await browser.close();
  }
}

// ── Run directly ─────────────────────────────────────────────────────────────
if (require.main === module) {
  downloadTarefas()
    .then((tarefas) => {
      console.log(`\n✅ Done — ${tarefas.length} task(s) downloaded.`);
      console.log(`📄 File: ${OUTPUT_FILE}`);
    })
    .catch((err) => {
      console.error("❌ Error:", err.message);
      process.exit(1);
    });
}
