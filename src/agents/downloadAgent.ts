/**
 * downloadAgent.ts
 *
 * Downloads all "DOSSIÊ PAP GET INSS" documents from every judicial task
 * assigned to the logged-in user, saving each as a PDF file under:
 *
 *   downloads/{NUP}/PAPGET-{filename}.pdf
 *
 * Strategy (entirely API-based after login):
 *  1. Open browser, log in, extract JWT from localStorage, close browser.
 *  2. For each task in the judicial task list (REST API):
 *     a. Create downloads/{nup}/ subdirectory.
 *     b. Fetch the juntada (document) list for the processo via REST API.
 *     c. Find all juntadas whose tipoDocumento.nome matches "DOSSIÊ PAP GET INSS".
 *     d. For each component digital of those juntadas, download via:
 *           GET /v1/administrativo/componente_digital/{id}/download
 *        The response is JSON with a `conteudo` field containing a base64
 *        data URI: "data:application/pdf;...;base64,<B64_PDF_CONTENT>"
 *     e. Decode base64 → save as .pdf file.
 *     f. Write _manifest.json.
 *  3. Write top-level index.json.
 *
 * Run: npm run download
 */

import { chromium } from "playwright";
import axios, { AxiosInstance } from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ override: true });

const AGU_URL =
  "https://supersapiens.agu.gov.br/apps/tarefas/judicial/minhas-tarefas/entrada";
const BACKEND = "https://supersapiensbackend.agu.gov.br";
const OUTPUT_DIR = path.resolve(process.cwd(), "downloads");

// ── Pure utility functions (exported for testing) ──────────────────────────────

/**
 * Adds a dot before the file extension when the raw fileName from the API
 * omits it (e.g. "PAPGET-123-1-de-3pdf" → "PAPGET-123-1-de-3.pdf").
 */
export function fixFileName(raw: string): string {
  return raw.replace(/([^.])pdf$/i, "$1.pdf");
}

/**
 * Extracts a PDF Buffer from a base64 data URI returned by the
 * /componente_digital/{id}/download endpoint.
 *
 * Expected format: "data:application/pdf;name=...;charset=utf-8;base64,<B64>"
 * Throws if the string is not a valid data URI or decodes to non-PDF bytes.
 */
export function extractPdfBuffer(conteudo: string): Buffer {
  const commaIdx = conteudo.indexOf(",");
  if (commaIdx === -1) {
    throw new Error("conteudo is not a valid data URI (no comma found)");
  }
  const b64 = conteudo.slice(commaIdx + 1);
  const buf = Buffer.from(b64, "base64");
  return buf;
}

/**
 * Returns true when a juntada entity from the SuperSapiens API represents
 * a "DOSSIÊ PAP GET INSS" document.
 */
export function isPapGetInss(juntada: unknown): boolean {
  if (!juntada || typeof juntada !== "object") return false;
  const j = juntada as Record<string, any>;
  const nome: string = j.documento?.tipoDocumento?.nome ?? "";
  return /PAP.GET.INSS/i.test(nome);
}

/**
 * Decides whether to skip downloading a task directory that was already
 * fully processed in a previous run.
 *
 * Returns true only when:
 *  - A valid _manifest.json exists in taskDir
 *  - manifest.skipped is false
 *  - All listed files exist on disk
 */
export function shouldSkipTask(taskDir: string): boolean {
  const manifestPath = path.join(taskDir, "_manifest.json");
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      skipped: boolean;
      files: Array<{ filePath: string }>;
    };
    if (m.skipped) return false;
    return m.files.every((f) => fs.existsSync(f.filePath));
  } catch {
    return false; // corrupt manifest — re-process
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface TarefaTask {
  id: number;
  nup: string;
  processoId: number;
  especie: string;
  prazo: string;
  setor: string;
}

interface DownloadedFile {
  componenteId: number;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  juntadaSeq: number;
}

interface TaskManifest {
  taskId: number;
  nup: string;
  processoId: number;
  especie: string;
  prazo: string;
  setor: string;
  downloadedAt: string;
  files: DownloadedFile[];
  skipped: boolean;
  skipReason?: string;
}

// ── Auth helpers ───────────────────────────────────────────────────────────────

/**
 * Returns true when an axios error should trigger a JWT re-authentication.
 * Exported for unit testing.
 */
export function isReauthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, any>;
  return e.response?.status === 401;
}

/**
 * Opens a browser, logs in with the supplied credentials, extracts the JWT
 * from localStorage/sessionStorage and returns it. Exported for testing.
 */
export async function performLogin(email: string, senha: string): Promise<string> {
  console.log("\n[DownloadAgent] Opening browser for login…");
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await page.goto(AGU_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);

  await page.locator("button.bt-rede").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("button.bt-rede").click();
  await page.locator('input[name="username"][type="email"]').waitFor({ state: "visible", timeout: 10_000 });

  await page.locator('input[name="username"][type="email"]').click();
  await page.keyboard.press("Control+a");
  await page.locator('input[name="username"][type="email"]').pressSequentially(email, { delay: 50 });
  await page.keyboard.press("Tab");

  await page.locator('input[name="password"]').first().click();
  await page.keyboard.press("Control+a");
  await page.locator('input[name="password"]').first().pressSequentially(senha, { delay: 50 });

  const btnDisabled = await page.locator("button.bt-rede").evaluate((el: HTMLButtonElement) => el.disabled);
  if (btnDisabled) {
    await page.locator('input[name="password"]').first().press("Enter");
  } else {
    await page.locator("button.bt-rede").click();
  }

  await page.waitForURL((url) => !url.toString().includes("/auth/login"), { timeout: 60_000 });
  await page.waitForTimeout(5_000);
  console.log(`[DownloadAgent] ✅ Logged in → ${page.url()}`);

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

  await browser.close();

  if (!jwtToken) throw new Error("JWT not found in localStorage after login");
  console.log(`[DownloadAgent] JWT extracted (${jwtToken.length} chars). Browser closed.`);
  return jwtToken;
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function downloadTarefas(): Promise<TaskManifest[]> {
  const email = process.env.AGU_EMAIL;
  const senha = process.env.AGU_SENHA;
  if (!email || !senha) {
    throw new Error("AGU_EMAIL and AGU_SENHA must be set in .env");
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // ── Step 1: Login and extract JWT ─────────────────────────────────────────
  let jwtToken = await performLogin(email, senha);

  // ── Step 2: Build axios client with JWT ───────────────────────────────────
  const api: AxiosInstance = axios.create({
    baseURL: BACKEND,
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      "Content-Type": "application/json",
    },
    timeout: 600_000, // 10 min — large PDFs are returned as 13 MB base64 JSON
  });

  // ── Interceptor: re-authenticate on 401 (JWT expiry) ──────────────────────
  // When the JWT expires mid-run the server returns 401. We re-login once per
  // request (guarded by _retried) to get a fresh token, then retry.
  api.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (isReauthError(error) && !error.config._retried) {
        error.config._retried = true;
        console.log("[DownloadAgent] 🔑 JWT expired — re-authenticating…");
        jwtToken = await performLogin(email, senha);
        api.defaults.headers.common["Authorization"] = `Bearer ${jwtToken}`;
        error.config.headers["Authorization"] = `Bearer ${jwtToken}`;
        return api(error.config);
      }
      return Promise.reject(error);
    }
  );

  // ── Step 3: Get current user ──────────────────────────────────────────────
  const profileResp = await api.get("/profile");
  const userId: number = profileResp.data.id;
  const userName: string = profileResp.data.nome ?? profileResp.data.username ?? "?";
  console.log(`[DownloadAgent] User: ${userId} — ${userName}`);

  // ── Step 4: Fetch task list ───────────────────────────────────────────────
  console.log("[DownloadAgent] Fetching judicial task list…");
  const taskResp = await api.get("/v1/administrativo/tarefa", {
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
  });

  const tasks: TarefaTask[] = (taskResp.data.entities ?? [])
    .filter((t: any) => t.processo?.id)
    .map((t: any) => ({
      id: t.id,
      nup: t.processo?.NUP ?? "",
      processoId: t.processo?.id,
      especie: t.especieTarefa?.nome ?? "",
      prazo: t.dataHoraFinalPrazo ?? "",
      setor: t.setorResponsavel?.nome ?? "",
    }));

  console.log(`[DownloadAgent] ${tasks.length} tasks (API total: ${taskResp.data.total}).`);

  // ── Step 5: Process each task ─────────────────────────────────────────────
  const results: TaskManifest[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    console.log(`\n[DownloadAgent] (${i + 1}/${tasks.length}) NUP ${task.nup} — task ${task.id}`);

    // Create NUP subdirectory
    const taskDir = path.join(OUTPUT_DIR, task.nup);
    fs.mkdirSync(taskDir, { recursive: true });

    // Skip if already fully downloaded (manifest exists with no errors)
    if (shouldSkipTask(taskDir)) {
      const existing: TaskManifest = JSON.parse(
        fs.readFileSync(path.join(taskDir, "_manifest.json"), "utf-8")
      );
      console.log(`  ⏭ Already downloaded (${existing.files.length} files). Skipping.`);
      results.push(existing);
      continue;
    }
    if (fs.existsSync(path.join(taskDir, "_manifest.json"))) {
      console.log(`  ↩ Partial download detected — retrying.`);
    }

    const manifest: TaskManifest = {
      taskId: task.id,
      nup: task.nup,
      processoId: task.processoId,
      especie: task.especie,
      prazo: task.prazo,
      setor: task.setor,
      downloadedAt: new Date().toISOString(),
      files: [],
      skipped: false,
    };

    try {
      // ── Fetch juntada list for this processo ────────────────────────────
      const juntadaResp = await api.get("/v1/administrativo/juntada", {
        params: {
          where: JSON.stringify({ "volume.processo.id": `eq:${task.processoId}` }),
          limit: "200",
          offset: "0",
          order: JSON.stringify({ numeracaoSequencial: "ASC" }),
          populate: JSON.stringify([
            "documento",
            "documento.componentesDigitais",
            "documento.tipoDocumento",
          ]),
        },
      });

      const juntadas: any[] = juntadaResp.data.entities ?? [];
      console.log(`  Juntadas: ${juntadas.length}`);

      // ── Find DOSSIÊ PAP GET INSS juntadas ──────────────────────────────
      const papgetJuntadas = juntadas.filter(isPapGetInss);

      if (papgetJuntadas.length === 0) {
        console.log("  ⚠ No DOSSIÊ PAP GET INSS documents found.");
        manifest.skipped = false; // Not an error — just no matching docs
        manifest.skipReason = "No DOSSIÊ PAP GET INSS documents in this processo";
      } else {
        console.log(`  Found ${papgetJuntadas.length} PAP GET INSS juntada(s).`);

        for (const juntada of papgetJuntadas) {
          const jSeq: number = juntada.numeracaoSequencial ?? 0;
          const comps: any[] = juntada.documento?.componentesDigitais ?? [];
          console.log(`  Juntada #${jSeq} — ${comps.length} component(s)`);

          for (const comp of comps) {
            const compId: number = comp.id;
            const rawFileName: string = comp.fileName ?? `component-${compId}`;
            const fileName = fixFileName(rawFileName);

            // Skip if file already exists and looks valid
            const filePath = path.join(taskDir, fileName);
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
              const existingSize = fs.statSync(filePath).size;
              console.log(`    ⏭ ${fileName} already exists (${(existingSize / 1024 / 1024).toFixed(1)} MB). Skipping.`);
              manifest.files.push({
                componenteId: compId,
                fileName,
                filePath,
                sizeBytes: existingSize,
                juntadaSeq: jSeq,
              });
              continue;
            }

            // Download with retries (3 attempts)
            let downloaded = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                console.log(`    Downloading component ${compId} → ${fileName}${attempt > 1 ? ` (attempt ${attempt})` : ""}…`);
                const dlResp = await api.get(
                  `/v1/administrativo/componente_digital/${compId}/download`
                );

                // The response has a `conteudo` field: "data:application/pdf;...;base64,<B64>"
                const conteudo: string = dlResp.data?.conteudo ?? "";
                if (!conteudo) {
                  console.error(`    ❌ No 'conteudo' field in response for component ${compId}`);
                  break; // Don't retry — structural issue
                }

                const buffer = extractPdfBuffer(conteudo);

                // Verify PDF magic bytes
                const magic = buffer.subarray(0, 4).toString("ascii");
                if (!magic.startsWith("%PDF")) {
                  console.warn(`    ⚠ Unexpected magic bytes: "${magic}" (expected "%PDF")`);
                }

                fs.writeFileSync(filePath, buffer);
                console.log(`    ✅ Saved ${fileName} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

                manifest.files.push({
                  componenteId: compId,
                  fileName,
                  filePath,
                  sizeBytes: buffer.length,
                  juntadaSeq: jSeq,
                });
                downloaded = true;
                break;
              } catch (dlErr: any) {
                console.error(`    ❌ Attempt ${attempt} failed for component ${compId}: ${dlErr.message}`);
                if (attempt < 3) {
                  const waitSec = attempt * 10;
                  console.log(`    ⏳ Waiting ${waitSec}s before retry…`);
                  await new Promise((r) => setTimeout(r, waitSec * 1000));
                }
              }
            }
            if (!downloaded) {
              console.error(`    ❌ All attempts failed for component ${compId} — skipping.`);
            }
          }
        }
      }
    } catch (err: any) {
      console.error(`  ❌ Task ${task.id} failed: ${err.message}`);
      manifest.skipped = true;
      manifest.skipReason = err.message;
    }

    // Write per-task manifest
    const manifestPath = path.join(taskDir, "_manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    results.push(manifest);
  }

  // ── Step 6: Write summary index ───────────────────────────────────────────
  const indexPath = path.join(OUTPUT_DIR, "index.json");
  const index = results.map((r) => ({
    nup: r.nup,
    taskId: r.taskId,
    processoId: r.processoId,
    especie: r.especie,
    prazo: r.prazo,
    setor: r.setor,
    fileCount: r.files.length,
    files: r.files.map((f) => f.fileName),
    skipped: r.skipped,
    skipReason: r.skipReason,
    downloadedAt: r.downloadedAt,
  }));
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");

  const totalFiles = results.reduce((s, r) => s + r.files.length, 0);
  const tasksWithDocs = results.filter((r) => r.files.length > 0).length;
  const tasksWithoutDocs = results.filter((r) => r.files.length === 0 && !r.skipped).length;
  const failedTasks = results.filter((r) => r.skipped).length;

  console.log(`\n[DownloadAgent] 🎉 Done!`);
  console.log(`  Tasks with PAP GET INSS docs: ${tasksWithDocs}/${tasks.length}`);
  console.log(`  Tasks without PAP GET INSS docs: ${tasksWithoutDocs}`);
  console.log(`  Failed tasks: ${failedTasks}`);
  console.log(`  Total PDF files downloaded: ${totalFiles}`);
  console.log(`  Index saved → ${indexPath}`);

  return results;
}

// ── Run directly ───────────────────────────────────────────────────────────────
if (require.main === module) {
  downloadTarefas()
    .then((results) => {
      const totalFiles = results.reduce((s, r) => s + r.files.length, 0);
      console.log(`\n✅ Complete. ${totalFiles} PDFs saved to ${OUTPUT_DIR}`);
    })
    .catch((err) => {
      console.error("❌ Fatal error:", err.message);
      process.exit(1);
    });
}
