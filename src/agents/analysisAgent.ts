/**
 * analysisAgent.ts
 *
 * Analyses every downloaded DOSSIÊ PAP GET INSS dossier for each legal process.
 * For each process folder under downloads/:
 *
 *  1. Parses every PDF page by page using pdf-parse's pagerender callback to build
 *     the Anexo ID index (Anexo ID → document name, page → Anexo ID).
 *  2. Uses Claude's vision API (PDF-as-document) to visually inspect every page
 *     and identify which documents are valid proofs of rural activity per PROVA_DOCUMENTAL.md.
 *     Large PDFs (> MAX_PAGES_PER_CHUNK pages) are split into sub-PDFs first.
 *  3. Creates EVIDENCE.pdf with all pages belonging to identified evidence documents.
 *  4. Generates VERIDICT.md using Claude API with full legal analysis.
 *
 * Run: npm run analyze
 */

import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import { PDFDocument } from "pdf-lib";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { config } from "../config";

dotenv.config({ override: true });

const DOWNLOADS_DIR = path.resolve(process.cwd(), "downloads");
const PROVA_DOCUMENTAL_PATH = path.resolve(process.cwd(), "data/PROVA_DOCUMENTAL.md");
const EVIDENCE_FILE = "EVIDENCE.pdf";
const VERDICT_FILE = "VERIDICT.md";
const ANALYSIS_MANIFEST = "_analysis.json";

/**
 * Maximum pages to send to Claude in a single API call.
 * Claude can handle ~100 pages but smaller chunks give better accuracy
 * and avoid hitting token/size limits.
 */
const MAX_PAGES_PER_CHUNK = 60;

/**
 * Milliseconds to wait between vision API calls.
 * The org rate limit is 30,000 input tokens/minute for claude-opus-4-5.
 * Each 60-page vision chunk uses ~15,000-30,000 tokens, so we need to
 * wait ≥60 s between calls to avoid 429 errors.
 */
const INTER_CHUNK_DELAY_MS = 65_000;

/** Maximum number of retries for rate-limited requests */
const MAX_RETRIES = 4;

/** Promisified sleep */
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface EvidenceMatch {
  sourceFile: string;
  pageIndex: number;    // 0-based index in the source PDF
  pageNumber: number;   // 1-based page number
  anexoId?: string;
  documentName?: string;
  evidenceType: string; // document type from PROVA_DOCUMENTAL.md
  definitive: boolean;  // true = high confidence from vision
  excerpt: string;      // what Claude found (qualifying content)
}

/** Current version tag — used to invalidate old keyword-based manifests */
const ANALYSIS_VERSION = "vision-v1";

interface AnalysisManifest {
  version: string;
  nup: string;
  analyzedAt: string;
  pdfFiles: string[];
  totalPages: number;
  evidenceMatches: EvidenceMatch[];
  evidencePageCount: number;
  verdictWritten: boolean;
}

interface PageSpec {
  pdfPath: string;
  pageIndex: number;
}

/** Raw match returned by Claude's vision JSON response */
export interface VisionMatch {
  pages: number[];           // 1-based page numbers within the chunk
  documentType: string;      // matching entry from PROVA_DOCUMENTAL.md
  qualifyingContent: string; // specific content that qualifies as proof
  confidence: "high" | "medium";
}

// ─── Per-page text extraction (kept for Anexo ID index only) ─────────────────

/**
 * Extracts text from every page of a PDF.
 * Returns an array of strings indexed by page (0-based).
 * Scanned/image pages will return mostly whitespace — that is expected.
 * This is used ONLY to build the Anexo ID index, not for evidence detection.
 */
export async function extractPageTexts(pdfPath: string): Promise<string[]> {
  const buffer = fs.readFileSync(pdfPath);
  const pageTexts: string[] = [];

  const pagerender = (pageData: any): Promise<string> =>
    pageData.getTextContent().then((tc: any) => {
      let lastY: number | null = null;
      let text = "";
      for (const item of tc.items) {
        if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
          text += "\n";
        }
        text += item.str;
        lastY = item.transform[5];
      }
      const clean = text.replace(/[ \t]+/g, " ").trim();
      pageTexts.push(clean);
      return clean;
    });

  await pdfParse(buffer, { pagerender });
  return pageTexts;
}

// ─── Index and Anexo ID parsing ────────────────────────────────────────────────

/**
 * Parses the concatenated PDF text to build:
 *   - anexoByPage: Map<pageIndex, anexoId>
 *   - docByAnexo:  Map<anexoId, documentName>
 *
 * The INSS portal index format is tricky: the Anexo ID, optional sequence
 * number, and filename may all be run together without spaces, and filenames
 * can span two lines.  We therefore:
 *  1. Collect all Anexo IDs from the footer "Anexo ID: XXXXXX" pattern.
 *  2. For each ID, locate it in the full text and extract what follows as
 *     the filename, stripping any leading sequence-number prefix and joining
 *     lines before the first ".pdf" occurrence.
 */
export function parseAnexoMaps(
  pageTexts: string[]
): { anexoByPage: Map<number, string>; docByAnexo: Map<string, string> } {
  const anexoByPage = new Map<number, string>();
  const docByAnexo = new Map<string, string>();

  // ── Step 1: page → Anexo ID (from footer "Anexo ID: XXXXXX") ──────────────
  for (let i = 0; i < pageTexts.length; i++) {
    const m = pageTexts[i].match(/Anexo ID:\s*(\d{7,12})/);
    if (m) {
      anexoByPage.set(i, m[1]);
    }
  }

  if (anexoByPage.size === 0) return { anexoByPage, docByAnexo };

  // ── Step 2: Anexo ID → document name ──────────────────────────────────────
  // Build full text from first ~6 pages (where the INSS index lives)
  const fullText = pageTexts.slice(0, Math.min(6, pageTexts.length)).join("\n");

  // Deduplicated set of all Anexo IDs found in footers
  const knownIds = new Set(anexoByPage.values());

  for (const id of knownIds) {
    if (docByAnexo.has(id)) continue;

    const pos = fullText.indexOf(id);
    if (pos === -1) continue;

    // Take up to 250 chars AFTER the ID
    const window = fullText.slice(pos + id.length, pos + id.length + 250);

    // Strip optional leading sequence number (digits + dots + spaces)
    const stripped = window.replace(/^[\d.\s]+/, "");

    // Join any newline inside the filename
    const oneline = stripped.replace(/\n/g, " ").replace(/\s+/g, " ");

    // Extract up to the first ".pdf"
    const pdfMatch = oneline.match(/^(.+?\.pdf)/i);
    if (pdfMatch) {
      docByAnexo.set(id, pdfMatch[1].trim());
    }
  }

  return { anexoByPage, docByAnexo };
}

// ─── PDF chunk splitting ───────────────────────────────────────────────────────

interface PdfChunk {
  buffer: Buffer;
  startPageIndex: number; // 0-based index of first page in original PDF
  pageCount: number;
}

/**
 * Splits a PDF buffer into chunks of at most maxPagesPerChunk pages.
 * Each chunk is a self-contained PDF buffer.
 * Returns an array of chunks with the 0-based start page index.
 */
async function splitPdfIntoChunks(
  pdfBuffer: Buffer,
  maxPagesPerChunk: number
): Promise<PdfChunk[]> {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const totalPages = srcDoc.getPageCount();

  if (totalPages <= maxPagesPerChunk) {
    return [{ buffer: pdfBuffer, startPageIndex: 0, pageCount: totalPages }];
  }

  const chunks: PdfChunk[] = [];
  for (let start = 0; start < totalPages; start += maxPagesPerChunk) {
    const end = Math.min(start + maxPagesPerChunk, totalPages);
    const chunkDoc = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const copiedPages = await chunkDoc.copyPages(srcDoc, indices);
    copiedPages.forEach((p) => chunkDoc.addPage(p));
    const bytes = await chunkDoc.save();
    chunks.push({
      buffer: Buffer.from(bytes),
      startPageIndex: start,
      pageCount: end - start,
    });
  }
  return chunks;
}

// ─── Vision-based evidence detection ─────────────────────────────────────────

/**
 * Builds the prompt sent to Claude for vision-based evidence detection.
 * chunkStartPage is the 0-based page index of the first page in this chunk
 * (used only for display purposes in the prompt, not for logic).
 *
 * Exported for unit testing.
 */
export function buildVisionPrompt(provaDocumental: string, chunkStartPage: number): string {
  const pageNote =
    chunkStartPage > 0
      ? `\n(NOTA: Este é um fragmento do PDF. A página 1 deste fragmento corresponde à página ${chunkStartPage + 1} do documento original.)`
      : "";

  return `Você é um perito em Direito Previdenciário brasileiro especializado em aposentadoria rural.${pageNote}

Analise CUIDADOSAMENTE cada página deste PDF. Seu objetivo é identificar quais documentos constituem PROVA DE ATIVIDADE RURAL válida conforme a lista abaixo.

DOCUMENTOS ACEITOS COMO PROVA DE ATIVIDADE RURAL:
${provaDocumental}

INSTRUÇÕES CRÍTICAS:
- Examine visualmente cada página — não assuma o conteúdo pelo tipo de documento
- Para certidões (nascimento, casamento): só é prova se o campo PROFISSÃO/OCUPAÇÃO contiver "LAVRADOR", "LAVRADORO(A)", "TRABALHADOR RURAL" ou "TRABALHADORA RURAL"
- Para prontuários médicos, fichas de internação, cadernetas: verifique endereço (Zona Rural) OU ocupação (Lavrador/Trabalhador Rural)
- Para CTPS (Carteira de Trabalho): identifique entradas de emprego com vínculo rural (categoria de trabalhador rural, empresas rurais, etc.)
- Para ITR, CCIR, PRONAF, CAR, sindicato rural, CAF: esses documentos por si só já são prova
- Para fichas eleitorais/título eleitoral: só é prova se o campo OCUPAÇÃO mostrar "TRABALHADOR RURAL" ou "LAVRADOR(A)"
- Se um documento não estiver legível ou não corresponder a nenhum tipo da lista, NÃO inclua

Retorne EXCLUSIVAMENTE um JSON válido com este formato (sem texto antes ou depois):
{
  "evidenceFound": [
    {
      "pages": [1, 2],
      "documentType": "tipo exato copiado da lista acima",
      "qualifyingContent": "descrição específica do que foi encontrado que qualifica como prova",
      "confidence": "high"
    }
  ]
}

Se não houver nenhuma prova válida neste fragmento, retorne:
{"evidenceFound": []}`;
}

/**
 * Parses Claude's vision JSON response and extracts VisionMatch objects.
 * Handles cases where Claude wraps JSON in markdown code blocks.
 *
 * Exported for unit testing.
 */
export function parseVisionResponse(responseText: string): VisionMatch[] {
  // Strip markdown code blocks if present
  let cleaned = responseText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return [];
    }
  }

  if (!parsed?.evidenceFound || !Array.isArray(parsed.evidenceFound)) return [];

  return parsed.evidenceFound
    .filter(
      (m: any) =>
        Array.isArray(m.pages) &&
        m.pages.length > 0 &&
        typeof m.documentType === "string" &&
        m.documentType.length > 0
    )
    .map((m: any) => ({
      pages: m.pages.map(Number).filter((n: number) => n >= 1),
      documentType: String(m.documentType),
      qualifyingContent: String(m.qualifyingContent ?? ""),
      confidence: m.confidence === "medium" ? "medium" : "high",
    }));
}

/**
 * Detects evidence of rural activity in a PDF using Claude's vision API.
 * The PDF is sent page-by-page if large, otherwise as a whole document.
 *
 * Returns EvidenceMatch objects (one per page that is part of an evidence document).
 * Multiple pages belonging to the same evidence document are each included.
 */
export async function detectEvidenceWithVision(
  pdfPath: string,
  provaDocumental: string,
  anexoByPage: Map<number, string>,
  docByAnexo: Map<string, string>
): Promise<EvidenceMatch[]> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const pdfBuffer = fs.readFileSync(pdfPath);
  const chunks = await splitPdfIntoChunks(pdfBuffer, MAX_PAGES_PER_CHUNK);
  const allMatches: EvidenceMatch[] = [];
  const seenPageIndices = new Set<number>();

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];

    // Polite delay between chunks to stay within rate limits
    if (chunkIdx > 0) await sleep(INTER_CHUNK_DELAY_MS);

    const base64 = chunk.buffer.toString("base64");
    const prompt = buildVisionPrompt(provaDocumental, chunk.startPageIndex);

    let responseText: string | null = null;
    let lastErr: string = "";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 15s, 30s, 60s, 120s
        const waitMs = 15_000 * Math.pow(2, attempt - 1);
        console.warn(`    ⏳ Rate limited — retrying chunk starting at page ${chunk.startPageIndex + 1} in ${waitMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})…`);
        await sleep(waitMs);
      }

      try {
        const response = await anthropic.messages.create({
          model: process.env.LUAI_MODEL ?? config.model,
          max_tokens: 2048,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: base64,
                  },
                } as any,
                {
                  type: "text",
                  text: prompt,
                },
              ],
            },
          ],
        });

        const block = response.content[0];
        if (block.type !== "text") {
          console.warn(`    ⚠ Unexpected response type from vision API: ${block.type}`);
          break;
        }
        responseText = block.text;
        break; // success
      } catch (err: any) {
        lastErr = err.message ?? String(err);
        const isRateLimit =
          lastErr.includes("429") || lastErr.toLowerCase().includes("rate_limit");
        if (!isRateLimit || attempt === MAX_RETRIES) {
          console.error(`    ❌ Vision API error for chunk starting at page ${chunk.startPageIndex + 1}: ${lastErr}`);
          break;
        }
        // Will retry
      }
    }

    if (responseText === null) continue;

    const visionMatches = parseVisionResponse(responseText);

    for (const vm of visionMatches) {
      for (const chunkPageNum of vm.pages) {
        // Convert chunk-relative 1-based page number to 0-based original page index
        const pageIndex = chunk.startPageIndex + chunkPageNum - 1;

        // Bounds check
        if (pageIndex < 0) continue;

        // Deduplicate: keep first match per page
        if (seenPageIndices.has(pageIndex)) continue;
        seenPageIndices.add(pageIndex);

        const anexoId = anexoByPage.get(pageIndex);
        allMatches.push({
          sourceFile: pdfPath,
          pageIndex,
          pageNumber: pageIndex + 1,
          anexoId,
          documentName: anexoId ? docByAnexo.get(anexoId) : undefined,
          evidenceType: vm.documentType,
          definitive: vm.confidence === "high",
          excerpt: vm.qualifyingContent,
        });
      }
    }
  }

  // Sort by page order
  return allMatches.sort((a, b) => a.pageIndex - b.pageIndex);
}

// ─── Group pages by Anexo ID for full-document extraction ─────────────────────

/**
 * Given evidence matches and the full page→Anexo map, expands the selection
 * to include ALL pages belonging to the same Anexo ID.
 * This ensures we get the full document, not just the one page that matched.
 */
export function expandToFullDocuments(
  matches: EvidenceMatch[],
  pageTexts: string[],
  anexoByPage: Map<number, string>,
  sourceFile: string
): PageSpec[] {
  // Collect matched Anexo IDs + pages that matched directly (no Anexo ID)
  const matchedAnexoIds = new Set<string>(
    matches.filter((m) => m.sourceFile === sourceFile && m.anexoId).map((m) => m.anexoId!)
  );
  const matchedPagesWithoutAnexo = new Set<number>(
    matches
      .filter((m) => m.sourceFile === sourceFile && !m.anexoId)
      .map((m) => m.pageIndex)
  );

  const pages: PageSpec[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < pageTexts.length; i++) {
    const anexoId = anexoByPage.get(i);
    const include =
      (anexoId && matchedAnexoIds.has(anexoId)) || matchedPagesWithoutAnexo.has(i);

    if (include && !seen.has(i)) {
      pages.push({ pdfPath: sourceFile, pageIndex: i });
      seen.add(i);
    }
  }

  return pages;
}

// ─── EVIDENCE.pdf creation ────────────────────────────────────────────────────

/**
 * Creates a new PDF containing only the specified pages from one or more source PDFs.
 * Source PDFs are loaded once per file to avoid redundant disk reads.
 */
export async function createEvidencePdf(
  pages: PageSpec[],
  outputPath: string
): Promise<void> {
  if (pages.length === 0) return;

  const newDoc = await PDFDocument.create();

  // Group by file to minimise loads
  const byFile = new Map<string, number[]>();
  for (const { pdfPath, pageIndex } of pages) {
    if (!byFile.has(pdfPath)) byFile.set(pdfPath, []);
    byFile.get(pdfPath)!.push(pageIndex);
  }

  for (const [pdfPath, indices] of byFile) {
    const sourceBuffer = fs.readFileSync(pdfPath);
    const sourceDoc = await PDFDocument.load(sourceBuffer);
    const maxPage = sourceDoc.getPageCount() - 1;

    // Deduplicate + clamp + sort
    const validIndices = [...new Set(indices)]
      .filter((i) => i >= 0 && i <= maxPage)
      .sort((a, b) => a - b);

    if (validIndices.length === 0) continue;

    const copiedPages = await newDoc.copyPages(sourceDoc, validIndices);
    copiedPages.forEach((page) => newDoc.addPage(page));
  }

  const pdfBytes = await newDoc.save();
  fs.writeFileSync(outputPath, Buffer.from(pdfBytes));
}

// ─── Verdict generation ────────────────────────────────────────────────────────

/**
 * Generates a VERIDICT.md file using Claude with full legal analysis.
 * Uses the vision-based evidence matches (richer than text-based).
 */
async function generateVerdict(
  nup: string,
  especie: string,
  prazo: string,
  pdfFiles: string[],
  matches: EvidenceMatch[],
  pageTexts: Map<string, string[]>
): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Load PROVA_DOCUMENTAL.md as reference
  const provaDocumental = fs.existsSync(PROVA_DOCUMENTAL_PATH)
    ? fs.readFileSync(PROVA_DOCUMENTAL_PATH, "utf-8")
    : "(não disponível)";

  // Build evidence summary from vision analysis
  const definitiveMatches = matches.filter((m) => m.definitive);
  const conditionalMatches = matches.filter((m) => !m.definitive);

  // Deduplicate by evidenceType for a cleaner summary
  const definitiveByType = new Map<string, EvidenceMatch[]>();
  for (const m of definitiveMatches) {
    if (!definitiveByType.has(m.evidenceType)) definitiveByType.set(m.evidenceType, []);
    definitiveByType.get(m.evidenceType)!.push(m);
  }
  const conditionalByType = new Map<string, EvidenceMatch[]>();
  for (const m of conditionalMatches) {
    if (!conditionalByType.has(m.evidenceType)) conditionalByType.set(m.evidenceType, []);
    conditionalByType.get(m.evidenceType)!.push(m);
  }

  const evidenceSummary =
    matches.length > 0
      ? [
          definitiveByType.size > 0
            ? `### Evidências de alta confiança (${definitiveMatches.length} páginas em ${definitiveByType.size} tipo(s))\n` +
              [...definitiveByType.entries()]
                .map(([type, pages], i) => {
                  const pageNums = pages.map((p) => `${path.basename(p.sourceFile)}:${p.pageNumber}`).join(", ");
                  const details = pages[0].excerpt ? `\n   Conteúdo qualificador: "${pages[0].excerpt.slice(0, 300)}"` : "";
                  return `${i + 1}. **${type}**\n   Páginas: ${pageNums}${details}`;
                })
                .join("\n")
            : "",
          conditionalByType.size > 0
            ? `### Evidências de confiança média (${conditionalMatches.length} páginas em ${conditionalByType.size} tipo(s))\n` +
              [...conditionalByType.entries()]
                .map(([type, pages], i) => {
                  const pageNums = pages.map((p) => `${path.basename(p.sourceFile)}:${p.pageNumber}`).join(", ");
                  const details = pages[0].excerpt ? `\n   Conteúdo qualificador: "${pages[0].excerpt.slice(0, 300)}"` : "";
                  return `${i + 1}. **${type}**\n   Páginas: ${pageNums}${details}`;
                })
                .join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : "Nenhuma evidência documental de atividade rural identificada pela análise visual.";

  // List all document names found in index (for full picture)
  const allDocNames: string[] = [];
  for (const [, pages] of pageTexts) {
    const combined = pages.join(" ");
    const re = /\b\d{7,12}\s+(?:[\d.]+\s+)?([A-ZÀ-Ú0-9][^\n]{3,150}?\.pdf)/gi;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(combined)) !== null) {
      const name = hit[1].trim();
      if (name.length > 5) allDocNames.push(name);
    }
  }
  const docListText =
    [...new Set(allDocNames)].slice(0, 60).map((n, i) => `${i + 1}. ${n}`).join("\n") ||
    "(índice de documentos não extraído)";

  const prompt = `Você é um especialista em Direito Previdenciário brasileiro com amplo conhecimento das seguintes normas:
- Lei 8.213/1991 (Benefícios da Previdência Social) — arts. 11, 39, 48, 143
- Lei 8.212/1991 (Custeio da Seguridade Social)
- Decreto 3.048/1999 (Regulamento da Previdência Social)
- Instrução Normativa PRES/INSS nº 128/2022
- Súmula 149 do STJ e jurisprudência consolidada sobre prova do trabalho rural

## PROCESSO ANALISADO

- **NUP**: ${nup}
- **Espécie do Pedido**: ${especie}
- **Prazo**: ${prazo}
- **Arquivos do dossier**: ${pdfFiles.map((f) => path.basename(f)).join(", ")}

## LISTA COMPLETA DE DOCUMENTOS NO DOSSIER (extraída do índice)
${docListText}

## DOCUMENTOS ACEITOS COMO PROVA DE ATIVIDADE RURAL (conforme normativas do INSS e STJ)
${provaDocumental}

## ANÁLISE VISUAL — EVIDÊNCIAS IDENTIFICADAS (por inspeção visual das páginas com Claude Vision)
${evidenceSummary}

---

Com base nas evidências encontradas e nos documentos listados, elabore um **PARECER TÉCNICO COMPLETO** em Markdown no formato abaixo. Seja objetivo, técnico e fundamentado em lei.

# PARECER TÉCNICO — ${nup}

## 1. Dados do Processo
(NUP, espécie do pedido, data do pedido, beneficiário se identificado)

## 2. Benefício Requerido e Base Legal
(descreva o benefício, requisitos legais, e normas aplicáveis)

## 3. Documentos Apresentados
(liste e avalie todos os documentos do dossier identificados no índice)

## 4. Evidências de Atividade Rural Encontradas
### 4.1 Evidências de Alta Confiança (visualmente confirmadas)
(documentos onde a inspeção visual confirmou prova de atividade rural)
### 4.2 Evidências de Confiança Média
(documentos que podem conter prova — verificar conteúdo específico)

## 5. Análise dos Requisitos Legais
(analise cada requisito do benefício contra as provas encontradas)

## 6. Pontos Fortes da Documentação

## 7. Lacunas e Pontos de Atenção

## 8. Conclusão e Recomendação
**PARECER:** FAVORÁVEL / DESFAVORÁVEL / NECESSITA COMPLEMENTAÇÃO
(justificativa objetiva com base nos documentos analisados visualmente)`;

  const response = await anthropic.messages.create({
    model: process.env.LUAI_MODEL ?? config.model,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type from Claude API");
  return content.text;
}

// ─── Analyse one process folder ───────────────────────────────────────────────

async function analyzeProcess(folderPath: string): Promise<void> {
  const nup = path.basename(folderPath);
  const manifestPath = path.join(folderPath, "_manifest.json");
  const evidencePath = path.join(folderPath, EVIDENCE_FILE);
  const verdictPath = path.join(folderPath, VERDICT_FILE);
  const analysisManifestPath = path.join(folderPath, ANALYSIS_MANIFEST);

  // Skip if already fully analysed with the current vision-based approach
  if (fs.existsSync(analysisManifestPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(analysisManifestPath, "utf-8"));
      if (
        existing.version === ANALYSIS_VERSION &&
        existing.verdictWritten &&
        fs.existsSync(verdictPath)
      ) {
        console.log(`  ⏭ Already analysed (${ANALYSIS_VERSION}). Skipping.`);
        return;
      }
    } catch {
      // Corrupt manifest — re-analyse
    }
  }

  if (!fs.existsSync(manifestPath)) {
    console.log(`  ⚠ No _manifest.json. Skipping.`);
    return;
  }

  const downloadManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
    especie?: string;
    prazo?: string;
    files?: Array<{ filePath: string }>;
    skipped?: boolean;
    skipReason?: string;
  };

  const especie = downloadManifest.especie ?? "(espécie não informada)";
  const prazo = downloadManifest.prazo ?? "";

  // Find PDFs
  const pdfFiles = fs
    .readdirSync(folderPath)
    .filter((f) => /\.pdf$/i.test(f) && f !== EVIDENCE_FILE)
    .sort()
    .map((f) => path.join(folderPath, f));

  if (pdfFiles.length === 0) {
    console.log(`  ⚠ No PDFs. Writing minimal verdict.`);
    const verdict = [
      `# PARECER TÉCNICO — ${nup}`,
      "",
      "**Sem documentos para análise.**",
      "",
      `Razão: ${downloadManifest.skipReason ?? "Nenhum DOSSIÊ PAP GET INSS encontrado"}`,
      "",
      `Espécie do pedido: ${especie}`,
    ].join("\n");
    fs.writeFileSync(verdictPath, verdict, "utf-8");
    return;
  }

  console.log(`  📄 ${pdfFiles.length} PDF(s) — building Anexo ID index…`);

  // ── Extract per-page text (for Anexo ID index only) ────────────────────────
  const allPageTexts = new Map<string, string[]>();
  let totalPages = 0;
  const allAnexoMaps = new Map<string, { anexoByPage: Map<number, string>; docByAnexo: Map<string, string> }>();

  for (const pdfPath of pdfFiles) {
    console.log(`    → ${path.basename(pdfPath)}…`);
    let pageTexts: string[];
    try {
      pageTexts = await extractPageTexts(pdfPath);
    } catch (err: any) {
      console.error(`    ❌ Text extraction error: ${err.message}`);
      pageTexts = [];
    }

    allPageTexts.set(pdfPath, pageTexts);
    totalPages += pageTexts.length;

    const maps = parseAnexoMaps(pageTexts);
    allAnexoMaps.set(pdfPath, maps);

    console.log(
      `       ${pageTexts.length} pages, ${maps.docByAnexo.size} documents indexed in Anexo table`
    );
  }

  // ── Vision-based evidence detection ───────────────────────────────────────
  console.log(`  🔎 Running vision-based evidence detection…`);

  const provaDocumental = fs.existsSync(PROVA_DOCUMENTAL_PATH)
    ? fs.readFileSync(PROVA_DOCUMENTAL_PATH, "utf-8")
    : "";

  const allMatches: EvidenceMatch[] = [];

  for (const pdfPath of pdfFiles) {
    const { anexoByPage, docByAnexo } = allAnexoMaps.get(pdfPath)!;
    const pageTexts = allPageTexts.get(pdfPath)!;
    const pageCount = pageTexts.length;

    console.log(`    → Vision: ${path.basename(pdfPath)} (${pageCount} pages)…`);
    let matches: EvidenceMatch[];
    try {
      matches = await detectEvidenceWithVision(pdfPath, provaDocumental, anexoByPage, docByAnexo);
    } catch (err: any) {
      console.error(`    ❌ Vision error: ${err.message}`);
      matches = [];
    }

    console.log(`       ${matches.length} evidence page(s) identified by vision`);
    allMatches.push(...matches);
  }

  // ── Build EVIDENCE.pdf ─────────────────────────────────────────────────────
  const pagesToExtract: PageSpec[] = [];

  for (const pdfPath of pdfFiles) {
    const pageTexts = allPageTexts.get(pdfPath);
    if (!pageTexts) continue;

    const { anexoByPage } = allAnexoMaps.get(pdfPath)!;
    const fileMatches = allMatches.filter((m) => m.sourceFile === pdfPath);

    const expanded = expandToFullDocuments(fileMatches, pageTexts, anexoByPage, pdfPath);
    pagesToExtract.push(...expanded);
  }

  if (pagesToExtract.length > 0) {
    console.log(`  🔍 Creating EVIDENCE.pdf (${pagesToExtract.length} page(s))…`);
    try {
      await createEvidencePdf(pagesToExtract, evidencePath);
      console.log(`  ✅ EVIDENCE.pdf created`);
    } catch (err: any) {
      console.error(`  ❌ EVIDENCE.pdf failed: ${err.message}`);
    }
  } else {
    console.log(`  ⚠ No evidence pages identified — EVIDENCE.pdf not created`);
  }

  // ── Generate verdict with Claude ───────────────────────────────────────────
  console.log(`  🤖 Generating VERIDICT.md…`);
  let verdictWritten = false;
  try {
    const verdict = await generateVerdict(
      nup,
      especie,
      prazo,
      pdfFiles,
      allMatches,
      allPageTexts
    );
    fs.writeFileSync(verdictPath, verdict, "utf-8");
    console.log(`  ✅ VERIDICT.md written`);
    verdictWritten = true;
  } catch (err: any) {
    console.error(`  ❌ Verdict generation failed: ${err.message}`);
    const evidenceList =
      allMatches.length > 0
        ? allMatches.map((m) => `- ${m.evidenceType} (pág. ${m.pageNumber})`).join("\n")
        : "Nenhuma evidência encontrada pela análise visual";
    const fallback = [
      `# PARECER TÉCNICO — ${nup}`,
      "",
      `**Erro ao gerar parecer automático:** ${err.message}`,
      "",
      "## Evidências Identificadas (Análise Visual)",
      evidenceList,
    ].join("\n");
    fs.writeFileSync(verdictPath, fallback, "utf-8");
  }

  // ── Write analysis manifest ────────────────────────────────────────────────
  const analysisManifest: AnalysisManifest = {
    version: ANALYSIS_VERSION,
    nup,
    analyzedAt: new Date().toISOString(),
    pdfFiles,
    totalPages,
    evidenceMatches: allMatches,
    evidencePageCount: pagesToExtract.length,
    verdictWritten,
  };
  fs.writeFileSync(analysisManifestPath, JSON.stringify(analysisManifest, null, 2), "utf-8");
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n[AnalysisAgent] Starting…\n");

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY must be set in .env");
  }

  const folders = fs
    .readdirSync(DOWNLOADS_DIR)
    .filter((f) => {
      const fp = path.join(DOWNLOADS_DIR, f);
      return fs.statSync(fp).isDirectory();
    })
    .map((f) => path.join(DOWNLOADS_DIR, f));

  console.log(`[AnalysisAgent] Found ${folders.length} process folders.\n`);

  let analyzed = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    const nup = path.basename(folder);
    console.log(`[AnalysisAgent] (${i + 1}/${folders.length}) ${nup}`);

    try {
      await analyzeProcess(folder);
      analyzed++;
    } catch (err: any) {
      console.error(`  ❌ Unhandled error: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n[AnalysisAgent] 🎉 Done!`);
  console.log(`  Analysed: ${analyzed}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Errors:   ${errors}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  });
}
