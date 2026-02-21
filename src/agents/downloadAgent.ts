import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import dotenv from "dotenv";

dotenv.config({ override: true });

const AGU_URL =
  "https://supersapiens.agu.gov.br/apps/tarefas/judicial/minhas-tarefas/entrada";
const BACKEND = "https://supersapiensbackend.agu.gov.br";
const SAPIENS  = "https://supersapiens.agu.gov.br";

const OUTPUT_DIR = path.resolve(process.cwd(), "downloads");

// ── Types ──────────────────────────────────────────────────────────────────────

interface TarefaTask {
  id: number;
  nup: string;
  processoId: number;
  especie: string;
  prazo: string;
  setor: string;
}

interface TarefaContent {
  task: TarefaTask;
  extractedAt: string;
  pageTitle: string;
  textContent: string;
  screenshotPath: string;
}

/**
 * Navigates to SuperSapiens, logs in via Rede AGU, then iterates over all
 * judicial tasks in "Entrada", clicks each one, and saves a JSON + screenshot
 * of the resulting right-panel content.
 *
 * Credentials are read from environment variables:
 *   AGU_EMAIL  — your Rede AGU login (e.g. luciana.aguiar)
 *   AGU_SENHA  — your Rede AGU password (wrap in quotes if it contains #)
 */
export async function downloadTarefas(): Promise<TarefaContent[]> {
  const email = process.env.AGU_EMAIL;
  const senha = process.env.AGU_SENHA;

  if (!email || !senha) {
    throw new Error("AGU_EMAIL and AGU_SENHA must be set in your .env file.");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    slowMo: 200,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  // ── Step 1: Login ────────────────────────────────────────────────────────────
  console.log(`\n[DownloadAgent] → ${AGU_URL}`);
  await page.goto(AGU_URL, { waitUntil: "networkidle", timeout: 60_000 });

  // Click "Rede AGU" to toggle the Rede AGU form
  const redeAguBtn = page.locator("button.bt-rede");
  await redeAguBtn.waitFor({ state: "visible", timeout: 20_000 });
  await redeAguBtn.click();
  await page.locator('input[name="username"]').waitFor({ state: "visible", timeout: 10_000 });

  // Fill credentials with real keystrokes so Angular reactive form validates
  const emailField = page.locator('input[name="username"]');
  await emailField.click();
  await page.keyboard.press("Control+a");
  await emailField.pressSequentially(email, { delay: 50 });
  await page.keyboard.press("Tab");

  const passField = page.locator('input[name="password"]');
  await passField.click();
  await page.keyboard.press("Control+a");
  await passField.pressSequentially(senha, { delay: 50 });
  await page.keyboard.press("Tab");

  // Submit — Playwright waits until Angular enables the button
  const btnDisabled = await page.locator("button.bt-rede").evaluate(
    (el: HTMLButtonElement) => el.disabled
  );
  if (btnDisabled) {
    await passField.press("Enter");
  } else {
    await redeAguBtn.click();
  }

  // Wait until we leave the login page
  await page.waitForURL((url) => !url.toString().includes("/auth/login"), {
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  console.log(`[DownloadAgent] ✅ Logged in. URL: ${page.url()}`);

  // ── Step 2: Fetch all tasks from API ─────────────────────────────────────────
  console.log("[DownloadAgent] Fetching task list from API...");

  const tasks: TarefaTask[] = await page.evaluate(async (backend: string) => {
    // Get current user ID from profile
    const profileResp = await fetch(`${backend}/profile`);
    const profile = await profileResp.json();
    const userId: number = profile.id;

    // Fetch all judicial tasks for this user
    const url = new URL(`${backend}/v1/administrativo/tarefa`);
    url.searchParams.set("where", JSON.stringify({
      "usuarioResponsavel.id": `eq:${userId}`,
      "dataHoraConclusaoPrazo": "isNull",
      "especieTarefa.generoTarefa.nome": "eq:JUDICIAL",
      "folder.id": "isNull",
    }));
    url.searchParams.set("limit", "200");
    url.searchParams.set("offset", "0");
    url.searchParams.set("order", JSON.stringify({ dataHoraFinalPrazo: "ASC" }));
    url.searchParams.set("populate", JSON.stringify([
      "processo",
      "especieTarefa",
      "especieTarefa.generoTarefa",
      "setorResponsavel",
      "setorResponsavel.unidade",
    ]));
    url.searchParams.set("context", JSON.stringify({ modulo: "judicial" }));

    const resp = await fetch(url.toString());
    const data = await resp.json();

    return (data.entities ?? [])
      .filter((t: any) => t.processo?.id)   // only tasks that have a linked processo
      .map((t: any) => ({
        id:         t.id,
        nup:        t.processo?.NUP ?? "",
        processoId: t.processo?.id,
        especie:    t.especieTarefa?.nome ?? "",
        prazo:      t.dataHoraFinalPrazo ?? "",
        setor:      t.setorResponsavel?.nome ?? "",
      }));
  }, BACKEND);

  console.log(`[DownloadAgent] Found ${tasks.length} tasks.`);

  // ── Step 3: Iterate, click each task, extract & save content ──────────────────
  const results: TarefaContent[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const safeNup = task.nup.replace(/[^a-z0-9]/gi, "_");
    console.log(`\n[DownloadAgent] (${i + 1}/${tasks.length}) ${task.nup} — task ${task.id}`);

    // Navigate directly to the task detail page
    const taskUrl = `${SAPIENS}/apps/tarefas/judicial/minhas-tarefas/entrada/tarefa/${task.id}/processo/${task.processoId}/visualizar/capa`;
    await page.goto(taskUrl, { waitUntil: "networkidle", timeout: 30_000 });

    // Wait for the right panel to render (action bar is the first sign it's loaded)
    await page.locator("text=Minutas").waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => console.warn(`  ⚠ Minutas toolbar not found for task ${task.id}`));

    // Extract text from the main content area (the center panel, right of task list)
    const textContent = await page.evaluate(() => {
      // The center div contains the full task detail area
      const center = document.querySelector("div.center") as HTMLElement | null;
      return center?.innerText?.trim() ?? document.body.innerText.trim();
    });

    // Screenshot of the full page
    const screenshotPath = await screenshot(page, OUTPUT_DIR, `task-${safeNup}`);

    // Save structured JSON
    const content: TarefaContent = {
      task,
      extractedAt: new Date().toISOString(),
      pageTitle: await page.title(),
      textContent,
      screenshotPath,
    };

    const jsonPath = path.join(OUTPUT_DIR, `task-${safeNup}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(content, null, 2), "utf-8");
    console.log(`  ✅ Saved: ${jsonPath}`);

    results.push(content);
  }

  console.log(`\n[DownloadAgent] 🎉 Done! Processed ${results.length} tasks.`);

  // Write a summary index file
  const indexPath = path.join(OUTPUT_DIR, "index.json");
  fs.writeFileSync(
    indexPath,
    JSON.stringify(
      results.map((r) => ({
        nup:            r.task.nup,
        taskId:         r.task.id,
        processoId:     r.task.processoId,
        especie:        r.task.especie,
        prazo:          r.task.prazo,
        setor:          r.task.setor,
        screenshotPath: r.screenshotPath,
        extractedAt:    r.extractedAt,
      })),
      null,
      2
    ),
    "utf-8"
  );
  console.log(`[DownloadAgent] Index saved: ${indexPath}`);

  await page.waitForTimeout(3_000);
  await context.close();
  await browser.close();

  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function screenshot(
  page: import("playwright").Page,
  dir: string,
  label: string
): Promise<string> {
  const filePath = path.join(dir, `${label}-${timestamp()}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`  📸 ${filePath}`);
  return filePath;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function openFile(filePath: string): void {
  try {
    const cmd =
      process.platform === "darwin"
        ? `open "${filePath}"`
        : process.platform === "win32"
        ? `start "" "${filePath}"`
        : `xdg-open "${filePath}"`;
    execSync(cmd);
  } catch {
    // Non-fatal
  }
}

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
  downloadTarefas()
    .then((results) => {
      console.log(`\n✅ Done. ${results.length} tasks saved to ${OUTPUT_DIR}`);
      openFile(OUTPUT_DIR);
    })
    .catch((err) => {
      console.error("❌ Error:", err.message);
      process.exit(1);
    });
}
