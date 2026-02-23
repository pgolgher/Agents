/**
 * analysisAgent.ts
 *
 * Analyses every downloaded DOSSIÊ PAP GET INSS dossier for each legal process.
 * For each process folder under downloads/:
 *
 *  1. Parses every PDF page by page using pdf-parse's pagerender callback.
 *  2. Builds two maps from the extracted text:
 *       a. Anexo ID → document name  (from the INSS portal index pages 1-2)
 *       b. Page index → Anexo ID     (from the "Anexo ID: XXXXX" footer on each page)
 *  3. Detects evidence in two ways:
 *       a. Text-based: pages with readable text matching rural-worker patterns
 *       b. Index-based: document names in the index that match evidence patterns
 *  4. Creates EVIDENCE.pdf with all evidence pages (using pdf-lib).
 *  5. Generates VERIDICT.md using Claude API with full legal analysis.
 *
 * Run: npm run analyze
 */

import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import { PDFDocument } from "pdf-lib";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config({ override: true });

const DOWNLOADS_DIR = path.resolve(process.cwd(), "downloads");
const PROVA_DOCUMENTAL_PATH = path.resolve(process.cwd(), "data/PROVA_DOCUMENTAL.md");
const EVIDENCE_FILE = "EVIDENCE.pdf";
const VERDICT_FILE = "VERIDICT.md";
const ANALYSIS_MANIFEST = "_analysis.json";

// ─── Evidence patterns ─────────────────────────────────────────────────────────

/**
 * Patterns applied to readable page TEXT.
 * A page matches if ANY pattern is found (even after garbled encoding).
 */
const TEXT_EVIDENCE_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /\bLAVRADOR[AO]?\b/i, type: "Profissão LAVRADOR(A) encontrada no texto" },
  { pattern: /TRABALHADOR[AO]?\s+RURAL/i, type: "TRABALHADOR(A) RURAL no texto" },
  { pattern: /\bzona\s+rural\b|\b[aá]rea\s+rural\b/i, type: "Endereço em Zona/Área Rural" },
  { pattern: /\batividade\s+rural\b/i, type: "Atividade Rural no texto" },
  { pattern: /\bprodut[oa]r?\s+rural\b/i, type: "Produtor(a) Rural no texto" },
  { pattern: /im[oó]vel\s+rural/i, type: "Imóvel Rural no texto" },
  { pattern: /\bCCIR\b/, type: "CCIR - Certificado de Cadastro de Imóvel Rural" },
  { pattern: /\bITR\b/, type: "ITR - Imposto Territorial Rural" },
  { pattern: /\bPRONAF\b/i, type: "PRONAF - Agricultura Familiar" },
  { pattern: /pescador\s+artesanal/i, type: "Pescador Artesanal" },
  { pattern: /\bquilombola\b/i, type: "Quilombola" },
  { pattern: /sindicato.*trabalhador.*rural|sindicato\s+rural/i, type: "Sindicato de Trabalhadores Rurais" },
  { pattern: /\bCEAR\b/i, type: "CEAR - Certidão de Exercício de Atividade Rural" },
  { pattern: /arrendamento.*rural|comodato.*rural|parceria\s+agr[ií]/i, type: "Contrato Rural" },
  { pattern: /Agricultura\s+Familiar|\bCAF\b/i, type: "Agricultura Familiar / CAF" },
  { pattern: /diarista\s+rural/i, type: "Diarista Rural" },
  { pattern: /empregad[ao]\s+rural/i, type: "Empregado(a) Rural" },
];

/**
 * Patterns applied to DOCUMENT NAMES from the INSS index table.
 * Grouped by confidence:
 *   definitive=true  → the document alone is strong proof
 *   definitive=false → the document may contain proof; needs manual inspection
 */
interface IndexPattern {
  pattern: RegExp;
  type: string;
  definitive: boolean;
}

const INDEX_EVIDENCE_PATTERNS: IndexPattern[] = [
  // ── Definitive evidence by document name alone ────────────────────────────
  { pattern: /\bCCIR\b/, type: "CCIR - Certificado de Cadastro de Imóvel Rural", definitive: true },
  { pattern: /\bITR\b/, type: "ITR - Declaração do Imposto Territorial Rural", definitive: true },
  { pattern: /\bPRONAF\b/i, type: "PRONAF - Programa Nacional de Agricultura Familiar", definitive: true },
  { pattern: /pescador\s+artesanal/i, type: "Carteira de Pescador Artesanal", definitive: true },
  { pattern: /\bquilombola\b/i, type: "Carteira de Associação Quilombola", definitive: true },
  { pattern: /sindicato.*rural|sindicato.*trabalhador/i, type: "Ficha de Inscrição em Sindicato de Trabalhadores Rurais", definitive: true },
  { pattern: /\bCEAR\b/i, type: "CEAR - Certidão de Exercício de Atividade Rural (FUNAI)", definitive: true },
  { pattern: /arrendamento.*rural|comodato.*rural|parceria\s+rural/i, type: "Contrato Rural (Arrendamento/Comodato/Parceria)", definitive: true },
  { pattern: /legitimação.*terras|terras\s+devolutas/i, type: "Título de Legitimação de Terras Devolutas", definitive: true },
  { pattern: /Agricultura\s+Familiar/i, type: "Cadastro Nacional de Agricultura Familiar", definitive: true },
  { pattern: /\bCAF\b.*produção|produção.*\bCAF\b/i, type: "CAF - Unidade Familiar de Produção Agrária", definitive: true },
  { pattern: /inscrição\s+estadual.*produtor|produtor.*inscrição\s+estadual/i, type: "Inscrição Estadual de Produtor Rural", definitive: true },
  { pattern: /\bCAR\b.*rural|rural.*\bCAR\b/i, type: "CAR - Cadastro Ambiental Rural", definitive: true },
  { pattern: /produt[oa]r?\s+rural/i, type: "Documento de Produtor Rural", definitive: true },
  { pattern: /CTPS|carteira.*trabalho/i, type: "CTPS - Carteira de Trabalho (verificar vínculos rurais)", definitive: false },

  // ── Conditional evidence (needs manual inspection) ────────────────────────
  { pattern: /certid[aã]o.*nascimento|assento.*nascimento/i, type: "Certidão de Nascimento (verificar profissão dos pais)", definitive: false },
  { pattern: /certid[aã]o.*casamento/i, type: "Certidão de Casamento (verificar profissão)", definitive: false },
  { pattern: /t[ií]tulo.*eleitoral|certid[aã]o.*eleitoral|ficha.*eleitoral/i, type: "Título/Certidão Eleitoral (verificar ocupação declarada)", definitive: false },
  { pattern: /alistamento\s+militar|dispensa\s+militar|certificado\s+militar/i, type: "Certificado Militar (verificar profissão)", definitive: false },
  { pattern: /cart[aã]o\s+gestante|caderneta\s+gestante/i, type: "Cartão/Caderneta da Gestante (verificar profissão)", definitive: false },
  { pattern: /caderneta\s+vacina/i, type: "Caderneta de Vacinação (verificar endereço rural)", definitive: false },
  { pattern: /cart[aã]o\s+crian[çc]a/i, type: "Cartão da Criança (verificar endereço rural)", definitive: false },
  { pattern: /prontu[aá]rio/i, type: "Prontuário Médico (verificar profissão/endereço)", definitive: false },
  { pattern: /interna[çc][aã]o|ficha.*intern/i, type: "Ficha de Internação (verificar profissão/endereço)", definitive: false },
  { pattern: /matr[ií]cula\s+escolar|ficha.*escolar/i, type: "Ficha de Matrícula Escolar (verificar profissão dos pais)", definitive: false },
  { pattern: /\bINAMPS\b/i, type: "Carteira de Saúde INAMPS (verificar profissão)", definitive: false },
  { pattern: /cadastro.*SUS|SUS.*cadastro|ficha.*SUS/i, type: "Cadastro SUS (verificar profissão)", definitive: false },
  { pattern: /CEMIG|conta.*energia|conta.*luz/i, type: "Conta de Energia CEMIG (verificar endereço rural)", definitive: false },
  { pattern: /funer[aá]rio|funér[aá]ria/i, type: "Plano Funerário (verificar profissão)", definitive: false },
  { pattern: /peti[çc][aã]o\s+admin/i, type: "Petição Administrativa (verificar narrativa de trabalho rural)", definitive: false },
];

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface EvidenceMatch {
  sourceFile: string;
  pageIndex: number;    // 0-based
  pageNumber: number;   // 1-based
  anexoId?: string;
  documentName?: string;
  evidenceType: string;
  definitive: boolean;
  excerpt: string;      // first 400 chars of page text (may be empty for scanned pages)
}

interface AnalysisManifest {
  nup: string;
  analyzedAt: string;
  pdfFiles: string[];
  totalPages: number;
  evidenceMatches: EvidenceMatch[];
  evidencePageCount: number;
  verdictWritten: boolean;
}

// ─── Per-page text extraction ──────────────────────────────────────────────────

/**
 * Extracts text from every page of a PDF.
 * Returns an array of strings indexed by page (0-based).
 * Scanned/image pages will return mostly whitespace.
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
    // e.g. "1.1 TERMO…" or "2 DOCUMENTO…" or "OAB…" (no prefix)
    const stripped = window.replace(/^[\d.\s]+/, "");

    // Join any newline inside the filename (filename can wrap to next line)
    const oneline = stripped.replace(/\n/g, " ").replace(/\s+/g, " ");

    // Extract up to the first ".pdf" (case-insensitive), lazy so we stop early
    const pdfMatch = oneline.match(/^(.+?\.pdf)/i);
    if (pdfMatch) {
      docByAnexo.set(id, pdfMatch[1].trim());
    }
  }

  return { anexoByPage, docByAnexo };
}

// ─── Evidence detection ────────────────────────────────────────────────────────

/**
 * Detects evidence on each page using both text patterns and index document names.
 * Returns one EvidenceMatch per (page, pattern) hit — deduplicated to one per page.
 */
export function detectEvidence(
  pageTexts: string[],
  sourceFile: string,
  anexoByPage: Map<number, string>,
  docByAnexo: Map<string, string>
): EvidenceMatch[] {
  const matches: EvidenceMatch[] = [];
  const seenPages = new Set<number>(); // deduplicate: one match per page

  // ── 1. Text-based detection ──────────────────────────────────────────────
  for (let i = 0; i < pageTexts.length; i++) {
    const text = pageTexts[i];
    const readable = text.replace(/[^\x20-\x7E\xA0-\xFF]/g, " ").trim();

    for (const { pattern, type } of TEXT_EVIDENCE_PATTERNS) {
      if (pattern.test(readable)) {
        const anexoId = anexoByPage.get(i);
        matches.push({
          sourceFile,
          pageIndex: i,
          pageNumber: i + 1,
          anexoId,
          documentName: anexoId ? docByAnexo.get(anexoId) : undefined,
          evidenceType: type,
          definitive: true,
          excerpt: readable.slice(0, 400).replace(/\n/g, " "),
        });
        seenPages.add(i);
        break; // one text match per page
      }
    }
  }

  // ── 2. Index-based detection (catch pages whose Anexo ID doc name matches) ─
  for (const [pageIndex, anexoId] of anexoByPage) {
    if (seenPages.has(pageIndex)) continue; // already matched by text

    const docName = docByAnexo.get(anexoId);
    if (!docName) continue;

    for (const { pattern, type, definitive } of INDEX_EVIDENCE_PATTERNS) {
      if (pattern.test(docName)) {
        matches.push({
          sourceFile,
          pageIndex,
          pageNumber: pageIndex + 1,
          anexoId,
          documentName: docName,
          evidenceType: type,
          definitive,
          excerpt: `[Documento: ${docName}]`,
        });
        seenPages.add(pageIndex);
        break;
      }
    }
  }

  // Sort by page order
  return matches.sort((a, b) => a.pageIndex - b.pageIndex);
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

interface PageSpec {
  pdfPath: string;
  pageIndex: number;
}

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

  // Build evidence summary
  const definitiveMatches = matches.filter((m) => m.definitive);
  const conditionalMatches = matches.filter((m) => !m.definitive);

  const evidenceSummary =
    matches.length > 0
      ? [
          definitiveMatches.length > 0
            ? `### Evidências definitivas (${definitiveMatches.length})\n` +
              definitiveMatches
                .map(
                  (m, i) =>
                    `${i + 1}. **${m.evidenceType}** — ${path.basename(m.sourceFile)}, pág. ${m.pageNumber}` +
                    (m.documentName ? `\n   Documento: "${m.documentName}"` : "") +
                    (m.excerpt && !m.excerpt.startsWith("[Documento:")
                      ? `\n   Trecho: "${m.excerpt.slice(0, 200).replace(/"/g, "'")}"` : "")
                )
                .join("\n")
            : "",
          conditionalMatches.length > 0
            ? `### Evidências condicionais — necessitam inspeção manual (${conditionalMatches.length})\n` +
              conditionalMatches
                .map(
                  (m, i) =>
                    `${i + 1}. **${m.evidenceType}** — ${path.basename(m.sourceFile)}, pág. ${m.pageNumber}` +
                    (m.documentName ? `\n   Documento: "${m.documentName}"` : "")
                )
                .join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : "Nenhuma evidência documental de atividade rural identificada automaticamente.";

  // Collect readable text from evidence pages for Claude context
  const evidenceTextSegments: string[] = [];
  let totalChars = 0;
  const MAX_CHARS = 50_000;

  for (const m of matches) {
    if (totalChars >= MAX_CHARS) break;
    if (m.excerpt.startsWith("[Documento:")) continue; // scanned — no text
    const pages = pageTexts.get(m.sourceFile) ?? [];
    // Include the match page + 1 context page before it
    const pageRange = [m.pageIndex - 1, m.pageIndex, m.pageIndex + 1].filter(
      (i) => i >= 0 && i < pages.length
    );
    for (const pi of pageRange) {
      const text = pages[pi];
      if (!text || text.length < 50) continue;
      const segment = `\n--- ${path.basename(m.sourceFile)}, pág. ${pi + 1} ---\n${text.slice(0, 1500)}\n`;
      if (totalChars + segment.length <= MAX_CHARS) {
        evidenceTextSegments.push(segment);
        totalChars += segment.length;
      }
    }
  }

  const evidenceText =
    evidenceTextSegments.length > 0
      ? evidenceTextSegments.join("")
      : "(Documentos são imagens digitalizadas — texto não extraível automaticamente)";

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

## ANÁLISE AUTOMATIZADA — EVIDÊNCIAS IDENTIFICADAS
${evidenceSummary}

## TEXTO EXTRAÍVEL DAS PÁGINAS COM EVIDÊNCIAS
${evidenceText}

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
### 4.1 Evidências Definitivas
(documentos que provam atividade rural sem necessidade de análise adicional)
### 4.2 Evidências Condicionais
(documentos que precisam ser inspecionados visualmente para confirmar)

## 5. Análise dos Requisitos Legais
(analise cada requisito do benefício contra as provas encontradas)

## 6. Pontos Fortes da Documentação

## 7. Lacunas e Pontos de Atenção

## 8. Conclusão e Recomendação
**PARECER:** FAVORÁVEL / DESFAVORÁVEL / NECESSITA COMPLEMENTAÇÃO
(justificativa objetiva com base nos documentos analisados)`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
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

  // Skip if already fully analysed
  if (fs.existsSync(evidencePath) && fs.existsSync(verdictPath)) {
    console.log(`  ⏭ Already analysed. Skipping.`);
    return;
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
    .filter((f) => /\.pdf$/i.test(f))
    .sort() // process in order: 1-de-3, 2-de-3, 3-de-3
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

  console.log(`  📄 ${pdfFiles.length} PDF(s) — parsing pages…`);

  // ── Extract per-page text from all PDFs ────────────────────────────────────
  const allPageTexts = new Map<string, string[]>();
  let totalPages = 0;
  const allMatches: EvidenceMatch[] = [];

  for (const pdfPath of pdfFiles) {
    console.log(`    → ${path.basename(pdfPath)}…`);
    let pageTexts: string[];
    try {
      pageTexts = await extractPageTexts(pdfPath);
    } catch (err: any) {
      console.error(`    ❌ Parse error: ${err.message}`);
      continue;
    }

    allPageTexts.set(pdfPath, pageTexts);
    totalPages += pageTexts.length;

    const { anexoByPage, docByAnexo } = parseAnexoMaps(pageTexts);
    const matches = detectEvidence(pageTexts, pdfPath, anexoByPage, docByAnexo);

    console.log(
      `       ${pageTexts.length} pages, ${docByAnexo.size} documents indexed, ` +
      `${matches.length} evidence page(s) found`
    );

    allMatches.push(...matches);
  }

  // ── Build EVIDENCE.pdf ─────────────────────────────────────────────────────
  const pagesToExtract: PageSpec[] = [];

  for (const pdfPath of pdfFiles) {
    const pageTexts = allPageTexts.get(pdfPath);
    if (!pageTexts) continue;

    const { anexoByPage } = parseAnexoMaps(pageTexts);
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
        : "Nenhuma evidência encontrada automaticamente";
    const fallback = [
      `# PARECER TÉCNICO — ${nup}`,
      "",
      `**Erro ao gerar parecer automático:** ${err.message}`,
      "",
      "## Evidências Identificadas",
      evidenceList,
    ].join("\n");
    fs.writeFileSync(verdictPath, fallback, "utf-8");
  }

  // ── Write analysis manifest ────────────────────────────────────────────────
  const analysisManifest: AnalysisManifest = {
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
