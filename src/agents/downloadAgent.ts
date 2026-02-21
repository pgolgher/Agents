import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import dotenv from "dotenv";

dotenv.config({ override: true });

const AGU_URL =
  "https://supersapiens.agu.gov.br/apps/tarefas/judicial/minhas-tarefas/entrada";
const BACKEND = "https://supersapiensbackend.agu.gov.br";

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

interface TarefaRecord {
  task: TarefaTask;
  /** Text from the <processo-capa> Angular component (the right-panel capa view) */
  capaText: string;
  /** Text from the full <tarefa-detail> panel (broader context) */
  taskDetailText: string;
  /** Structured processo data from the backend REST API */
  processoDetails: Record<string, any>;
  /** Full tarefa entity from the backend REST API */
  tarefaDetails: Record<string, any>;
  screenshotPath: string;
  extractedAt: string;
}

/**
 * FINAL WORKING STRATEGY:
 *
 * 1. Login normally (networkidle, no special Chromium flags needed).
 *
 * 2. Fetch task list from the REST API using JWT extracted from localStorage.
 *
 * 3. For each task — click div.info inside the task card:
 *    - card.click() on cdk-tarefa-list-item triggers checkbox selection (wrong)
 *    - JS dispatchEvent alone doesn't trigger Angular navigation (wrong)
 *    - div.info.click() triggers Angular router navigation ← THIS WORKS
 *
 * 4. Content renders in <processo-capa> (Angular component at router-outlet[4]),
 *    NOT in div.center (which is just the initial empty-state spinner).
 *    Wait for processo-capa to have content > 50 chars.
 *
 * 5. Also extract from <tarefa-detail> for additional context.
 *
 * 6. Enrich with REST API data (processo details, tarefa details).
 */
export async function downloadTarefas(): Promise<TarefaRecord[]> {
  const email = process.env.AGU_EMAIL;
  const senha = process.env.AGU_SENHA;

  if (!email || !senha) {
    throw new Error("AGU_EMAIL and AGU_SENHA must be set in your .env file.");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    slowMo: 150,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "log") console.log("[browser]", msg.text());
  });

  // ── Step 1: Login ────────────────────────────────────────────────────────────
  console.log("\n[DownloadAgent] Logging in to SuperSapiens…");
  await page.goto(AGU_URL, { waitUntil: "networkidle", timeout: 60_000 });

  await page.locator("button.bt-rede").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("button.bt-rede").click();
  await page
    .locator('input[name="username"][type="email"]')
    .waitFor({ state: "visible", timeout: 10_000 });

  const emailField = page.locator('input[name="username"][type="email"]');
  await emailField.click();
  await page.keyboard.press("Control+a");
  await emailField.pressSequentially(email, { delay: 50 });
  await page.keyboard.press("Tab");

  const passField = page.locator('input[name="password"]');
  await passField.click();
  await page.keyboard.press("Control+a");
  await passField.pressSequentially(senha, { delay: 50 });
  await page.keyboard.press("Tab");

  const btnDisabled = await page
    .locator("button.bt-rede")
    .evaluate((el: HTMLButtonElement) => el.disabled);
  if (btnDisabled) {
    await passField.press("Enter");
  } else {
    await page.locator("button.bt-rede").click();
  }

  await page.waitForURL(
    (url) => !url.toString().includes("/auth/login"),
    { timeout: 60_000 }
  );
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  console.log(`[DownloadAgent] ✅ Logged in → ${page.url()}`);

  // ── Step 2: JWT + API auth ────────────────────────────────────────────────
  const jwtToken = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      const val = localStorage.getItem(key);
      if (val && val.startsWith("ey")) return val;
    }
    for (const key of Object.keys(sessionStorage)) {
      const val = sessionStorage.getItem(key);
      if (val && val.startsWith("ey")) return val;
    }
    return null;
  });
  if (!jwtToken) throw new Error("JWT not found after login");
  const authHeaders = { Authorization: `Bearer ${jwtToken}` };

  const profileResp = await context.request.get(`${BACKEND}/profile`, { headers: authHeaders });
  const profile = await profileResp.json();
  const userId: number = profile.id;
  console.log(`[DownloadAgent] User ${userId} — ${profile.nome ?? profile.username}`);

  // ── Step 3: Fetch task list ───────────────────────────────────────────────
  console.log("[DownloadAgent] Fetching task list from API…");
  const taskResp = await context.request.get(
    `${BACKEND}/v1/administrativo/tarefa`,
    {
      headers: authHeaders,
      params: {
        where: JSON.stringify({
          "usuarioResponsavel.id": `eq:${userId}`,
          dataHoraConclusaoPrazo: "isNull",
          "especieTarefa.generoTarefa.nome": "eq:JUDICIAL",
          "folder.id": "isNull",
        }),
        limit: "200",
        offset: "0",
        order: JSON.stringify({ dataHoraFinalPrazo: "ASC" }),
        populate: JSON.stringify([
          "processo",
          "especieTarefa",
          "especieTarefa.generoTarefa",
          "setorResponsavel",
          "setorResponsavel.unidade",
        ]),
        context: JSON.stringify({ modulo: "judicial" }),
      },
    }
  );
  const taskData = await taskResp.json();
  const tasks: TarefaTask[] = (taskData.entities ?? [])
    .filter((t: any) => t.processo?.id)
    .map((t: any) => ({
      id: t.id,
      nup: t.processo?.NUP ?? "",
      processoId: t.processo?.id,
      especie: t.especieTarefa?.nome ?? "",
      prazo: t.dataHoraFinalPrazo ?? "",
      setor: t.setorResponsavel?.nome ?? "",
    }));
  console.log(`[DownloadAgent] ${tasks.length} tasks (API total: ${taskData.total}).`);

  // ── Step 4: Wait for task list UI to render ───────────────────────────────
  console.log("[DownloadAgent] Waiting for task cards in UI…");
  await page.locator("cdk-tarefa-list-item").first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  // Let Angular fully initialize its services/subscriptions
  await page.waitForTimeout(5_000);
  console.log(
    `[DownloadAgent] ${await page.locator("cdk-tarefa-list-item").count()} cards visible.`
  );

  // ── Step 5: Process each task ─────────────────────────────────────────────
  const results: TarefaRecord[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const safeNup = task.nup.replace(/[^a-z0-9]/gi, "_");
    console.log(
      `\n[DownloadAgent] (${i + 1}/${tasks.length}) ${task.nup} — task ${task.id}`
    );

    try {
      // Scroll back to top of task list before each search
      await page.evaluate(() => {
        const vp = document.querySelector("cdk-virtual-scroll-viewport") as HTMLElement | null;
        if (vp) vp.scrollTop = 0;
      });
      await page.waitForTimeout(300);

      // Find the card for this task (scroll if needed — CDK virtual scroll)
      const found = await scrollToCard(page, task.id);
      if (!found) {
        console.warn(`  ⚠ Card for task ${task.id} not found; skipping`);
        continue;
      }

      // Click div.info inside the target card.
      // This is the correct click target for Angular router navigation:
      //   - div.content click → triggers checkbox selection (wrong)
      //   - div.info click   → triggers in-app navigation to task detail ✓
      const card = page.locator("cdk-tarefa-list-item").filter({ hasText: `Id ${task.id}` });
      const infoDiv = card.locator("div.info").first();
      await infoDiv.scrollIntoViewIfNeeded();
      await infoDiv.click();
      console.log("  ↪ Clicked div.info");

      // Wait for the URL to change to this task's detail route
      await page
        .waitForURL(
          (url) => url.toString().includes(`/tarefa/${task.id}/`),
          { timeout: 20_000 }
        )
        .catch(() => console.warn(`  ⚠ URL did not update to /tarefa/${task.id}/`));

      // Wait for <processo-capa> to have real content.
      // This Angular component renders the right-panel "capa" (cover page) of
      // the processo. It's at router-outlet[4] inside tarefa-detail → processo
      // → processo-view → processo-capa.
      const capaReady = await page
        .waitForFunction(
          () => {
            const capa = document.querySelector("processo-capa") as HTMLElement | null;
            return capa != null && capa.innerText.trim().length > 50;
          },
          { timeout: 25_000 }
        )
        .then(() => true)
        .catch(() => false);

      if (!capaReady) {
        console.warn("  ⚠ processo-capa did not render in 25 s");
      }

      // Extract content
      const capaText = await page.evaluate(() => {
        const capa = document.querySelector("processo-capa") as HTMLElement | null;
        return capa?.innerText?.trim() ?? "";
      });

      const taskDetailText = await page.evaluate(() => {
        const detail = document.querySelector("tarefa-detail") as HTMLElement | null;
        return detail?.innerText?.trim() ?? "";
      });

      console.log(
        `  ✔ capa: ${capaText.length} chars | detail: ${taskDetailText.length} chars`
      );

      // Screenshot
      const screenshotPath = await takeScreenshot(page, OUTPUT_DIR, `task-${safeNup}`);

      // API enrichment
      let processoDetails: Record<string, any> = {};
      try {
        const r = await context.request.get(
          `${BACKEND}/v1/administrativo/processo/${task.processoId}`,
          {
            headers: authHeaders,
            params: {
              populate: JSON.stringify([
                "classeProcessual",
                "especieProcedimento",
                "orgaoCentral",
                "setorAtual",
                "setorAtual.unidade",
                "valorCausa",
                "localizador",
                "origemDados",
                "modalidadeMeio",
              ]),
            },
          }
        );
        processoDetails = await r.json();
      } catch (e: any) {
        console.warn(`  ⚠ Processo API: ${e.message}`);
      }

      let tarefaDetails: Record<string, any> = {};
      try {
        const r = await context.request.get(
          `${BACKEND}/v1/administrativo/tarefa/${task.id}`,
          {
            headers: authHeaders,
            params: {
              populate: JSON.stringify([
                "processo",
                "especieTarefa",
                "especieTarefa.generoTarefa",
                "setorResponsavel",
                "usuarioResponsavel",
                "observacao",
                "documentoRemessa",
              ]),
              context: JSON.stringify({ modulo: "judicial" }),
            },
          }
        );
        tarefaDetails = await r.json();
      } catch (e: any) {
        console.warn(`  ⚠ Tarefa API: ${e.message}`);
      }

      const record: TarefaRecord = {
        task,
        capaText,
        taskDetailText,
        processoDetails,
        tarefaDetails,
        screenshotPath,
        extractedAt: new Date().toISOString(),
      };

      const jsonPath = path.join(OUTPUT_DIR, `task-${safeNup}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2), "utf-8");
      console.log(`  ✅ Saved → ${jsonPath}`);
      results.push(record);
    } catch (err: any) {
      console.error(`  ❌ Task ${task.id} failed: ${err.message}`);
    }
  }

  console.log(
    `\n[DownloadAgent] 🎉 Done! ${results.length}/${tasks.length} tasks processed.`
  );

  // ── Step 6: Write summary index ───────────────────────────────────────────
  const indexPath = path.join(OUTPUT_DIR, "index.json");
  fs.writeFileSync(
    indexPath,
    JSON.stringify(
      results.map((r) => ({
        nup: r.task.nup,
        taskId: r.task.id,
        processoId: r.task.processoId,
        especie: r.task.especie,
        prazo: r.task.prazo,
        setor: r.task.setor,
        classeProcessual:
          r.processoDetails?.classeProcessual?.sigla ??
          r.processoDetails?.classeProcessual?.nome ??
          "",
        orgaoCentral:
          r.processoDetails?.orgaoCentral?.sigla ??
          r.processoDetails?.orgaoCentral?.nome ??
          "",
        capaTextLength: r.capaText.length,
        screenshotPath: r.screenshotPath,
        extractedAt: r.extractedAt,
      })),
      null,
      2
    ),
    "utf-8"
  );
  console.log(`[DownloadAgent] Index saved → ${indexPath}`);

  await page.waitForTimeout(2_000);
  await context.close();
  await browser.close();

  return results;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Scroll the task list (CDK virtual scroll) until the card for taskId appears.
 * We scroll the viewport first back to top, then down, looking for "Id {taskId}".
 */
async function scrollToCard(
  page: import("playwright").Page,
  taskId: number
): Promise<boolean> {
  // Task list panel is at roughly x=310–637, scroll over its center
  const listX = 470;
  const listY = 400;

  for (let attempt = 0; attempt < 40; attempt++) {
    const found = await page.evaluate((id: number) => {
      return Array.from(document.querySelectorAll("cdk-tarefa-list-item")).some(
        (c) => c.textContent?.includes(`Id ${id}`)
      );
    }, taskId);
    if (found) return true;
    // Scroll task list down
    await page.mouse.move(listX, listY);
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(150);
  }
  return page.evaluate((id: number) => {
    return Array.from(document.querySelectorAll("cdk-tarefa-list-item")).some(
      (c) => c.textContent?.includes(`Id ${id}`)
    );
  }, taskId);
}

async function takeScreenshot(
  page: import("playwright").Page,
  dir: string,
  label: string
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filePath = path.join(dir, `${label}-${ts}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  📸 ${filePath}`);
  return filePath;
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

// ── Run directly ───────────────────────────────────────────────────────────────
if (require.main === module) {
  downloadTarefas()
    .then((results) => {
      console.log(`\n✅ Done. ${results.length} tasks saved to ${OUTPUT_DIR}`);
      openFile(OUTPUT_DIR);
    })
    .catch((err) => {
      console.error("❌ Fatal error:", err.message);
      process.exit(1);
    });
}
