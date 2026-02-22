/**
 * inspectJuntadaApi.ts
 *
 * Minimal inspector: login → JWT → fetch juntada API for task 285524165
 * → print document structure → try to download a componenteDigital.
 *
 * Run: npx ts-node src/agents/inspectJuntadaApi.ts
 */

import { chromium } from "playwright";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config({ override: true });

const BACKEND = "https://supersapiensbackend.agu.gov.br";
const AGU_URL = "https://supersapiens.agu.gov.br/apps/tarefas/judicial/minhas-tarefas/entrada";

// Known task for testing
const PROCESSO_ID = 58786172;   // task 285524165, NUP 00417018357202608
const OUTPUT_PATH = "/tmp/juntada-inspect.json";
const PDF_PATH = "/tmp/test-component.pdf";

async function main() {
  const email = process.env.AGU_EMAIL!;
  const senha = process.env.AGU_SENHA!;

  const browser = await chromium.launch({ headless: true }); // headless — we just need JWT
  const context = await browser.newContext();
  const page = await context.newPage();

  // ── Login ──────────────────────────────────────────────────────────────────
  console.log("[api-inspect] Logging in (headless)…");
  await page.goto(AGU_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);

  await page.locator("button.bt-rede").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("button.bt-rede").click();
  await page.locator('input[name="username"][type="email"]').waitFor({ state: "visible", timeout: 10_000 });
  await page.locator('input[name="username"][type="email"]').first().fill(email);
  await page.locator('input[name="password"]').first().fill(senha);
  await page.locator('input[name="password"]').first().press("Enter");
  await page.waitForURL((url) => !url.toString().includes("/auth/login"), { timeout: 60_000 });
  await page.waitForTimeout(5_000);
  console.log(`[api-inspect] ✅ Logged in → ${page.url()}`);

  // ── JWT ────────────────────────────────────────────────────────────────────
  const jwt = await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      const v = localStorage.getItem(k);
      if (v?.startsWith("ey")) return v;
    }
    return null;
  });
  if (!jwt) throw new Error("JWT not found");
  await browser.close();
  console.log("[api-inspect] JWT extracted. Closing browser.");

  const axiosHeaders = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };

  // ── Fetch juntada list for processo ────────────────────────────────────────
  console.log(`\n[api-inspect] Fetching juntada list for processo ${PROCESSO_ID}…`);
  const resp = await axios.get(`${BACKEND}/v1/administrativo/juntada`, {
    headers: axiosHeaders,
    params: {
      where: JSON.stringify({ "volume.processo.id": `eq:${PROCESSO_ID}` }),
      limit: "100",
      offset: "0",
      order: JSON.stringify({ numeracaoSequencial: "DESC" }),
      populate: JSON.stringify([
        "populateAll",
        "documento",
        "documento.componentesDigitais",
        "documento.tipoDocumento",
        "documento.vinculacoesDocumentos",
        "documento.vinculacoesDocumentos.documentoVinculado",
        "documento.vinculacoesDocumentos.documentoVinculado.componentesDigitais",
        "documento.vinculacoesDocumentos.documentoVinculado.tipoDocumento",
      ]),
      context: JSON.stringify({ incluiVinculacaoDocumentoPrincipal: true, incluiJuntadaDocumentoPrincipal: true }),
    },
  });

  const data = resp.data;
  const total = data.total ?? data.entities?.length ?? 0;
  console.log(`[api-inspect] Total juntadas: ${total}`);

  // Save full response for inspection
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));
  console.log(`[api-inspect] Full response saved to ${OUTPUT_PATH}`);

  // ── Find PAP GET INSS documents ───────────────────────────────────────────
  console.log("\n[api-inspect] ─── Searching for PAP GET INSS ───");
  const papgetComponents: { label: string; componenteId: number; documentoId: number; mimeType: string }[] = [];

  for (const juntada of data.entities ?? []) {
    const doc = juntada.documento;
    if (!doc) continue;

    const seq = juntada.numeracaoSequencial ?? "?";
    const docTipo = doc.tipoDocumento?.nome ?? "(no tipo)";
    const docTitle = doc.descricao ?? doc.nome ?? "(no title)";
    const vincs = doc.vinculacoesDocumentos ?? [];

    // Log top-level doc
    console.log(`  juntada #${seq}: tipo="${docTipo}" desc="${docTitle}" vincs=${vincs.length}`);

    // Check linked documents
    for (const vinc of vincs) {
      const linked = vinc.documentoVinculado;
      if (!linked) continue;
      const linkedTipo = linked.tipoDocumento?.nome ?? "";
      const linkedDesc = linked.descricao ?? "";
      const comps = linked.componentesDigitais ?? [];

      const isPapget = /PAP.GET.INSS/i.test(linkedTipo) || /PAP.GET.INSS/i.test(linkedDesc) || /PAPGET/i.test(linkedTipo);

      if (isPapget) {
        console.log(`    ✅ PAP GET INSS linked doc: tipo="${linkedTipo}" desc="${linkedDesc}" comps=${comps.length}`);
        for (const comp of comps) {
          console.log(`       componenteDigital id=${comp.id} mimeType="${comp.mimeType}" fileName="${comp.fileName ?? "?"}"`);
          papgetComponents.push({
            label: linkedTipo || linkedDesc || "DOSSIÊ PAP GET INSS",
            componenteId: comp.id,
            documentoId: linked.id,
            mimeType: comp.mimeType ?? "",
          });
        }
      } else if (/PAP/i.test(linkedTipo) || /PAP/i.test(linkedDesc)) {
        console.log(`    ↳ possible: tipo="${linkedTipo}" desc="${linkedDesc}"`);
      }
    }

    // Also check main documento type
    const mainIsPapget = /PAP.GET.INSS/i.test(docTipo) || /PAPGET/i.test(docTipo);
    if (mainIsPapget) {
      const comps = doc.componentesDigitais ?? [];
      console.log(`  ✅ PAP GET INSS main doc: tipo="${docTipo}" comps=${comps.length}`);
      for (const comp of comps) {
        console.log(`     componenteDigital id=${comp.id} mimeType="${comp.mimeType}" fileName="${comp.fileName ?? "?"}"`);
        papgetComponents.push({
          label: docTipo,
          componenteId: comp.id,
          documentoId: doc.id,
          mimeType: comp.mimeType ?? "",
        });
      }
    }
  }

  console.log(`\n[api-inspect] Found ${papgetComponents.length} PAP GET INSS components`);

  // ── Try downloading the first component ───────────────────────────────────
  if (papgetComponents.length > 0) {
    const first = papgetComponents[0];
    console.log(`\n[api-inspect] Downloading componenteDigital ${first.componenteId}…`);

    // Try common URL patterns (note: API uses underscore: componente_digital)
    const urlPatterns = [
      `${BACKEND}/v1/administrativo/componente_digital/${first.componenteId}/conteudo`,
      `${BACKEND}/v1/administrativo/componente_digital/${first.componenteId}/download`,
      `${BACKEND}/v1/administrativo/componente_digital/${first.componenteId}`,
      `${BACKEND}/v1/administrativo/componenteDigital/${first.componenteId}/conteudo`,
      `${BACKEND}/v1/administrativo/documento/${first.documentoId}/download`,
    ];

    for (const url of urlPatterns) {
      console.log(`  Trying: ${url}`);
      try {
        const dlResp = await axios.get(url, {
          headers: axiosHeaders,
          responseType: "arraybuffer",
          validateStatus: () => true,
        });
        const status = dlResp.status;
        const ct = dlResp.headers["content-type"] ?? "(no ct)";
        const body = Buffer.from(dlResp.data);
        const magic = body.subarray(0, 5).toString("ascii");
        console.log(`  → status=${status} ct="${ct}" size=${body.length} magic="${magic}"`);
        if (status === 200 && (magic.startsWith("%PDF") || body.length > 1000)) {
          fs.writeFileSync(PDF_PATH, body);
          console.log(`  ✅ Saved to ${PDF_PATH}`);
          break;
        }
      } catch (e: any) {
        console.log(`  → error: ${e.message}`);
      }
    }
  } else {
    console.log("\n[api-inspect] No PAP GET INSS components found.");
    console.log("[api-inspect] Top-level documento tipos in response:");
    (data.entities ?? []).slice(0, 30).forEach((j: any) => {
      const tipo = j.documento?.tipoDocumento?.nome ?? "(null)";
      const desc = j.documento?.descricao ?? j.documento?.nome ?? "";
      const vincsCount = j.documento?.vinculacoesDocumentos?.length ?? 0;
      console.log(`  #${j.numeracaoSequencial ?? "?"}: tipo="${tipo}" desc="${desc.slice(0, 50)}" vincs=${vincsCount}`);
    });
  }

  console.log("\n[api-inspect] Done.");
}

main().catch((e) => { console.error("❌ Fatal:", e.message); process.exit(1); });
