/**
 * inspectDossie.ts — v3
 *
 * Discovery script: logs in, clicks the first task, then finds DOSSIÊ PAP GET INSS
 * documents in the document list, clicks one, and captures the PDF.
 *
 * Run: npx ts-node src/agents/inspectDossie.ts
 */

import { chromium, Response } from "playwright";
import dotenv from "dotenv";

dotenv.config({ override: true });

const AGU_URL =
  "https://supersapiens.agu.gov.br/apps/tarefas/judicial/minhas-tarefas/entrada";
const BACKEND = "https://supersapiensbackend.agu.gov.br";

// ── scrollToCard helper (same as in downloadAgent) ─────────────────────────
async function scrollToCard(
  page: import("playwright").Page,
  taskId: number
): Promise<boolean> {
  const listX = 470;
  const listY = 400;
  for (let attempt = 0; attempt < 40; attempt++) {
    const found = await page.evaluate((id: number) =>
      Array.from(document.querySelectorAll("cdk-tarefa-list-item")).some(
        (c) => c.textContent?.includes(`Id ${id}`)
      ), taskId);
    if (found) return true;
    await page.mouse.move(listX, listY);
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(150);
  }
  return page.evaluate((id: number) =>
    Array.from(document.querySelectorAll("cdk-tarefa-list-item")).some(
      (c) => c.textContent?.includes(`Id ${id}`)
    ), taskId);
}

async function main() {
  const email = process.env.AGU_EMAIL;
  const senha = process.env.AGU_SENHA;
  if (!email || !senha) throw new Error("AGU_EMAIL / AGU_SENHA not set");

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // ── Login ──────────────────────────────────────────────────────────────────
  console.log("\n[inspect] Logging in…");
  await page.goto(AGU_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
  await page.locator("button.bt-rede").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("button.bt-rede").click();
  await page.locator('input[name="username"][type="email"]').waitFor({ state: "visible", timeout: 10_000 });

  await page.locator('input[name="username"][type="email"]').click();
  await page.keyboard.press("Control+a");
  await page.locator('input[name="username"][type="email"]').pressSequentially(email, { delay: 50 });
  await page.keyboard.press("Tab");

  await page.locator('input[name="password"]').click();
  await page.keyboard.press("Control+a");
  await page.locator('input[name="password"]').pressSequentially(senha, { delay: 50 });

  const btnDisabled = await page.locator("button.bt-rede").evaluate((el: HTMLButtonElement) => el.disabled);
  if (btnDisabled) await page.locator('input[name="password"]').press("Enter");
  else await page.locator("button.bt-rede").click();

  await page.waitForURL((url) => !url.toString().includes("/auth/login"), { timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  console.log(`[inspect] ✅ Logged in → ${page.url()}`);

  // ── JWT ────────────────────────────────────────────────────────────────────
  const jwtToken = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      const val = localStorage.getItem(key);
      if (val && val.startsWith("ey")) return val;
    }
    return null;
  });
  if (!jwtToken) throw new Error("JWT not found");
  const authHeaders = { Authorization: `Bearer ${jwtToken}` };

  // ── Fetch task list ────────────────────────────────────────────────────────
  const profileResp = await context.request.get(`${BACKEND}/profile`, { headers: authHeaders });
  const profile = await profileResp.json();
  const userId: number = profile.id;

  const taskResp = await context.request.get(`${BACKEND}/v1/administrativo/tarefa`, {
    headers: authHeaders,
    params: {
      where: JSON.stringify({
        "usuarioResponsavel.id": `eq:${userId}`,
        dataHoraConclusaoPrazo: "isNull",
        "especieTarefa.generoTarefa.nome": "eq:JUDICIAL",
        "folder.id": "isNull",
      }),
      limit: "50",
      offset: "0",
      order: JSON.stringify({ dataHoraFinalPrazo: "ASC" }),
      populate: JSON.stringify(["processo"]),
      context: JSON.stringify({ modulo: "judicial" }),
    },
  });
  const taskData = await taskResp.json();
  // Use a specific task known to have DOSSIÊ PAP GET INSS documents (confirmed in previous session)
  const TARGET_TASK_ID = 285524165;
  const allTasks = taskData.entities ?? [];
  const firstTask = allTasks.find((t: any) => t.id === TARGET_TASK_ID) ?? allTasks[0];
  if (!firstTask) throw new Error("No tasks found");
  const taskId: number = firstTask.id;
  const nup: string = firstTask.processo?.NUP ?? "";
  console.log(`[inspect] Target task: id=${taskId} nup=${nup}`);

  // ── Wait for CDK task list ─────────────────────────────────────────────────
  await page.locator("cdk-tarefa-list-item").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(5_000);

  // ── Click first task using scrollToCard ───────────────────────────────────
  console.log("[inspect] Scrolling to card and clicking div.info…");
  const found = await scrollToCard(page, taskId);
  console.log(`[inspect] Card found: ${found}`);

  if (!found) {
    console.error("[inspect] ❌ Card not found!");
    await page.waitForTimeout(10_000);
    await browser.close();
    return;
  }

  const card = page.locator("cdk-tarefa-list-item").filter({ hasText: `Id ${taskId}` });
  await card.locator("div.info").first().click();

  await page
    .waitForURL((url) => url.toString().includes(`/tarefa/${taskId}/`), { timeout: 20_000 })
    .then(() => console.log(`[inspect] ✅ URL updated: ${page.url()}`))
    .catch(() => console.warn("[inspect] ⚠ URL did not update"));

  await page
    .waitForFunction(() => {
      const capa = document.querySelector("processo-capa") as HTMLElement | null;
      return capa != null && capa.innerText.trim().length > 50;
    }, { timeout: 25_000 })
    .then(() => console.log("[inspect] ✅ processo-capa ready"))
    .catch(() => console.warn("[inspect] ⚠ processo-capa timeout"));

  // ── Dump ALL scroll containers on page ────────────────────────────────────
  console.log("\n[inspect] ─── All scrollable containers ───");
  const scrollInfo = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("*").forEach((el) => {
      const s = window.getComputedStyle(el);
      const oy = s.overflowY;
      const sh = (el as HTMLElement).scrollHeight;
      const ch = (el as HTMLElement).clientHeight;
      if ((oy === "auto" || oy === "scroll") && sh > ch + 10) {
        const rect = el.getBoundingClientRect();
        out.push(
          `${el.tagName.toLowerCase()} x=${Math.round(rect.x + rect.width / 2)} y=${Math.round(rect.y + rect.height / 2)} ` +
          `scroll=${sh} client=${ch} classes="${(typeof el.className === "string" ? el.className : "").slice(0, 50)}"`
        );
      }
    });
    return out;
  });
  scrollInfo.forEach((s) => console.log(" ", s));

  // ── Get ALL text from tarefa-detail (confirms what's in DOM) ──────────────
  console.log("\n[inspect] ─── tarefa-detail full innerText excerpt ───");
  const detailText = await page.evaluate(() => {
    const el = document.querySelector("tarefa-detail") as HTMLElement | null;
    if (!el) return "NOT FOUND";
    return el.innerText.trim().slice(0, 3000);
  });
  console.log(detailText.slice(0, 2000));

  // ── Find DOSSIÊ PAP GET INSS via Playwright getByText ─────────────────────
  console.log("\n[inspect] ─── Playwright getByText('PAP GET INSS') ───");
  const dossieLocators = page.getByText(/PAP GET INSS/i);
  const dossieCount = await dossieLocators.count();
  console.log(`[inspect] getByText count: ${dossieCount}`);

  for (let i = 0; i < Math.min(dossieCount, 6); i++) {
    const loc = dossieLocators.nth(i);
    const text = await loc.innerText().catch(() => "?");
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "?");
    const classes = await loc.evaluate((el) => typeof el.className === "string" ? el.className.slice(0, 60) : "").catch(() => "?");
    const rect = await loc.boundingBox().catch(() => null);
    console.log(`  [${i}] tag=${tag} classes="${classes}" text="${text.replace(/\n/g, " ").slice(0, 80)}" bbox=${JSON.stringify(rect)}`);
  }

  // ── Try scrolling document list if nothing found ──────────────────────────
  if (dossieCount === 0) {
    console.log("\n[inspect] ─── Trying scroll on document list panel ───");

    // From previous run, the juntadas scroll container was at x=784, y=602
    // (div.cdk-virtual-scrollable.juntadas). Also try the content div at x=1183, y=665.
    const scrollX = 784;
    const scrollY = 602;
    console.log(`[inspect] Scrolling juntadas container at x=${scrollX} y=${scrollY}`);

    for (let i = 0; i < 30; i++) {
      await page.mouse.move(scrollX, scrollY);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(300);

      const count = await page.getByText(/PAP GET INSS/i).count();
      if (count > 0) {
        console.log(`[inspect] ✅ Found ${count} DOSSIÊ items after ${i + 1} scrolls`);
        break;
      }

      if (i % 5 === 4) {
        // Log what's currently visible
        const visible = await page.evaluate(() => {
          const items: string[] = [];
          document.querySelectorAll(".cdk-virtual-scrollable.juntadas *").forEach((el) => {
            const t = (el as HTMLElement).innerText?.trim();
            if (t && t.length > 3 && t.length < 60 && el.children.length === 0) items.push(t);
          });
          return items.slice(0, 20);
        });
        console.log(`  After ${i + 1} scrolls, visible items:`, visible);
      }
    }

    const finalCount = await page.getByText(/PAP GET INSS/i).count();
    console.log(`[inspect] After scroll: ${finalCount} items`);
    for (let i = 0; i < Math.min(finalCount, 6); i++) {
      const loc = page.getByText(/PAP GET INSS/i).nth(i);
      const text = await loc.innerText().catch(() => "?");
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "?");
      const classes = await loc.evaluate((el) => typeof el.className === "string" ? el.className.slice(0, 80) : "").catch(() => "?");
      const rect = await loc.boundingBox().catch(() => null);
      console.log(`  [${i}] tag=${tag} classes="${classes}" text="${text.replace(/\n/g, " ").slice(0, 80)}" bbox=${JSON.stringify(rect)}`);
    }
  }

  // ── Click first DOSSIÊ PAP GET INSS and capture PDF ───────────────────────
  const finalDossieCount = await page.getByText(/PAP GET INSS/i).count();
  if (finalDossieCount > 0) {
    console.log("\n[inspect] ─── Clicking first DOSSIÊ PAP GET INSS item ───");

    const capturedResponses: { url: string; ct: string; size: number }[] = [];
    let pdfBuf: Buffer | null = null;
    let pdfUrl = "";

    const onResponse = async (r: Response) => {
      const ct = r.headers()["content-type"] ?? "";
      const url = r.url();
      if (r.status() === 200 && (
        ct.includes("pdf") || ct.includes("octet-stream") || ct.includes("image/") ||
        url.includes("documento") || url.includes("conteudo") || url.includes("arquivo")
      )) {
        try {
          const body = await r.body();
          capturedResponses.push({ url, ct, size: body.length });
          if ((ct.includes("pdf") || ct.includes("octet-stream") || body.length > 10000) && !pdfBuf) {
            pdfBuf = body;
            pdfUrl = url;
            console.log(`[inspect] 📄 Captured: ${ct} ${body.length} bytes  ${url.slice(0, 100)}`);
          }
        } catch {}
      }
    };
    page.on("response", onResponse);

    const urlBefore = page.url();
    const firstDossie = page.getByText(/PAP GET INSS/i).first();
    await firstDossie.scrollIntoViewIfNeeded().catch(() => {});
    await firstDossie.click();
    await page.waitForTimeout(6_000);
    const urlAfter = page.url();

    page.off("response", onResponse);

    console.log(`[inspect] URL before: ${urlBefore}`);
    console.log(`[inspect] URL after:  ${urlAfter}`);
    console.log(`[inspect] URL changed: ${urlBefore !== urlAfter}`);

    // Inspect right panel
    const rightPanel = await page.evaluate(() => {
      const info: string[] = [];
      ["iframe", "embed", "object"].forEach((tag) => {
        document.querySelectorAll(tag).forEach((el, i) => {
          const src = (el as any).src ?? (el as any).data ?? "";
          info.push(`${tag}[${i}]: src="${src.slice(0, 120)}" type="${(el as HTMLObjectElement).type ?? ""}"`);
        });
      });
      // Angular viewer components
      ["documento-viewer", "app-documento-viewer", "pdf-viewer", "[class*='viewer']", "canvas"].forEach((sel) => {
        try {
          const el = document.querySelector(sel);
          if (el) info.push(`${sel}: found, innerText="${(el as HTMLElement).innerText?.slice(0, 60)}"`);
        } catch {}
      });
      return info;
    });
    console.log("\n[inspect] ─── Right panel DOM ───");
    rightPanel.forEach((l) => console.log(" ", l));

    // Check performance entries for document URLs
    const perfUrls = await page.evaluate(() =>
      (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        .filter((e) => e.name.includes("documento") || e.name.includes("conteudo") || e.name.includes("arquivo") || e.name.includes("pdf"))
        .map((e) => `${e.initiatorType.padEnd(8)} ${e.name.slice(0, 120)}`)
    );
    console.log("\n[inspect] ─── Performance URLs (documento/conteudo/arquivo) ───");
    if (perfUrls.length === 0) console.log("  (none)");
    else perfUrls.forEach((u) => console.log(" ", u));

    console.log("\n[inspect] ─── Captured responses ───");
    if (capturedResponses.length === 0) console.log("  (none)");
    else capturedResponses.forEach((r) => console.log(`  ${r.ct.padEnd(30)} ${r.size.toString().padStart(9)} bytes  ${r.url.slice(0, 100)}`));

    if (pdfBuf) {
      const magic = (pdfBuf as Buffer).subarray(0, 5).toString("ascii");
      console.log(`\n[inspect] ✅ PDF magic: "${magic}" | URL: ${pdfUrl}`);
    } else {
      console.log("\n[inspect] ⚠ No PDF captured. Checking current page full response list…");
      const allPerfUrls = await page.evaluate(() =>
        (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
          .slice(-30)
          .map((e) => `${e.initiatorType.padEnd(8)} ${e.name.slice(0, 120)}`)
      );
      allPerfUrls.forEach((u) => console.log(" ", u));
    }
  } else {
    console.log("\n[inspect] ⚠ No DOSSIÊ PAP GET INSS items found. Dumping all visible document list items:");
    const listItems = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("tarefa-detail *").forEach((el) => {
        const t = (el as HTMLElement).innerText?.trim();
        if (t && t.length > 5 && t.length < 100 && el.children.length < 4) {
          out.push(`[${el.tagName}.${typeof el.className === "string" ? el.className.slice(0, 30) : ""}] ${t}`);
        }
      });
      return out.slice(0, 60);
    });
    listItems.forEach((l) => console.log(" ", l));
  }

  console.log("\n[inspect] Done. Browser stays open 30s…");
  await page.waitForTimeout(30_000);
  await browser.close();
}

main().catch((e) => { console.error("❌ Fatal:", e.message); process.exit(1); });
