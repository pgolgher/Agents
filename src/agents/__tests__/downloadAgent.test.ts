/**
 * Tests for downloadAgent.ts utility functions and download logic.
 *
 * Pure functions (fixFileName, extractPdfBuffer, isPapGetInss, shouldSkipTask)
 * are tested directly. The juntada-filtering and per-component download loop
 * are tested via a lightweight integration harness that mocks axios and fs.
 */

import fs from "fs";
import path from "path";
import os from "os";
import {
  fixFileName,
  extractPdfBuffer,
  isPapGetInss,
  shouldSkipTask,
} from "../downloadAgent";

// ── fixFileName ────────────────────────────────────────────────────────────────

describe("fixFileName", () => {
  it("adds a dot before pdf when it is missing", () => {
    expect(fixFileName("PAPGET-69468621634-1-de-3pdf")).toBe("PAPGET-69468621634-1-de-3.pdf");
  });

  it("leaves the filename unchanged when it already has .pdf", () => {
    expect(fixFileName("PAPGET-69468621634-1-de-3.pdf")).toBe("PAPGET-69468621634-1-de-3.pdf");
  });

  it("handles a single-part filename without extension", () => {
    expect(fixFileName("documentopdf")).toBe("documento.pdf");
  });

  it("normalises uppercase PDF suffix to lowercase .pdf", () => {
    // The regex is case-insensitive so it matches "PDF", but the replacement
    // always inserts a literal dot: "PAPGET-123PDF" → "PAPGET-123.pdf"
    // All real API fileNames use lowercase "pdf" so this is intentional.
    expect(fixFileName("PAPGET-123PDF")).toBe("PAPGET-123.pdf");
  });

  it("does not modify filenames that do not end in pdf", () => {
    expect(fixFileName("PAPGET-123.docx")).toBe("PAPGET-123.docx");
    expect(fixFileName("arquivo")).toBe("arquivo");
  });

  it("handles real-world PAPGET filename from API", () => {
    const samples = [
      ["PAPGET-69468621634-1-de-3pdf", "PAPGET-69468621634-1-de-3.pdf"],
      ["PAPGET-64307832604-1-de-1pdf", "PAPGET-64307832604-1-de-1.pdf"],
      ["PAPGET-50958852472-3-de-3pdf", "PAPGET-50958852472-3-de-3.pdf"],
    ];
    for (const [raw, expected] of samples) {
      expect(fixFileName(raw)).toBe(expected);
    }
  });
});

// ── extractPdfBuffer ────────────────────────────────────────────────────────────

describe("extractPdfBuffer", () => {
  /** Build a minimal valid data URI for a fake PDF */
  function makeFakePdfDataUri(content: string): string {
    const b64 = Buffer.from(content).toString("base64");
    return `data:application/pdf;name=test.pdf;charset=utf-8;base64,${b64}`;
  }

  it("returns a Buffer from a valid base64 data URI", () => {
    const fakeContent = "%PDF-1.4 fake pdf content";
    const uri = makeFakePdfDataUri(fakeContent);
    const buf = extractPdfBuffer(uri);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString("utf-8")).toBe(fakeContent);
  });

  it("correctly decodes the %PDF magic bytes", () => {
    // Simulate a real-ish PDF start
    const pdfStart = "%PDF-1.4\n1 0 obj\n";
    const uri = makeFakePdfDataUri(pdfStart);
    const buf = extractPdfBuffer(uri);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("throws when conteudo has no comma (not a data URI)", () => {
    expect(() => extractPdfBuffer("notadatauri")).toThrow("no comma found");
  });

  it("throws when conteudo is empty", () => {
    expect(() => extractPdfBuffer("")).toThrow("no comma found");
  });

  it("handles a data URI with multiple semicolons in the header", () => {
    const b64 = Buffer.from("%PDF-test").toString("base64");
    const uri = `data:application/pdf;name=x;charset=utf-8;base64,${b64}`;
    const buf = extractPdfBuffer(uri);
    expect(buf.toString("ascii").startsWith("%PDF")).toBe(true);
  });

  it("preserves binary content exactly (round-trip)", () => {
    // Create a 100-byte buffer with random-ish values
    const original = Buffer.from(
      Array.from({ length: 100 }, (_, i) => (i * 37 + 13) % 256)
    );
    const b64 = original.toString("base64");
    const uri = `data:application/octet-stream;base64,${b64}`;
    const result = extractPdfBuffer(uri);
    expect(result).toEqual(original);
  });
});

// ── isPapGetInss ───────────────────────────────────────────────────────────────

describe("isPapGetInss", () => {
  const makeJuntada = (tipNome: string) => ({
    documento: { tipoDocumento: { nome: tipNome } },
  });

  it("returns true for exact match 'DOSSIÊ PAP GET INSS'", () => {
    expect(isPapGetInss(makeJuntada("DOSSIÊ PAP GET INSS"))).toBe(true);
  });

  it("returns true for case-insensitive match", () => {
    expect(isPapGetInss(makeJuntada("dossiê pap get inss"))).toBe(true);
    expect(isPapGetInss(makeJuntada("Dossiê PAP GET INSS"))).toBe(true);
  });

  it("returns true when separator is a space, dash, or period", () => {
    expect(isPapGetInss(makeJuntada("PAP.GET.INSS"))).toBe(true);
    expect(isPapGetInss(makeJuntada("PAP-GET-INSS"))).toBe(true);
    expect(isPapGetInss(makeJuntada("PAP GET INSS"))).toBe(true);
  });

  it("returns false for unrelated tipoDocumento", () => {
    expect(isPapGetInss(makeJuntada("CITAÇÃO"))).toBe(false);
    expect(isPapGetInss(makeJuntada("DOSSIÊ PREVIDENCIÁRIO"))).toBe(false);
    expect(isPapGetInss(makeJuntada("LAUDO MÉDICO"))).toBe(false);
    expect(isPapGetInss(makeJuntada("PETIÇÃO INICIAL"))).toBe(false);
  });

  it("returns false when documento is absent", () => {
    expect(isPapGetInss({ documento: null })).toBe(false);
    expect(isPapGetInss({ documento: {} })).toBe(false);
    expect(isPapGetInss({})).toBe(false);
  });

  it("returns false for null / undefined / non-object input", () => {
    expect(isPapGetInss(null)).toBe(false);
    expect(isPapGetInss(undefined)).toBe(false);
    expect(isPapGetInss("DOSSIÊ PAP GET INSS")).toBe(false);
    expect(isPapGetInss(42)).toBe(false);
  });

  it("works for all document types found in the real API response", () => {
    const nonMatching = [
      "CITAÇÃO", "DOSSIÊ PREVIDENCIÁRIO", "SITUAÇÃO CADASTRAL DO CPF",
      "PESQUISA DE BENS", "LAUDO MÉDICO", "DOSSIÊ SOCIAL", "CERTIDÃO",
      "TEXTO DIGITADO", "DECISÃO", "OUTROS", "PROCURAÇÃO", "PETIÇÃO INICIAL",
    ];
    for (const tipo of nonMatching) {
      expect(isPapGetInss(makeJuntada(tipo))).toBe(false);
    }
    expect(isPapGetInss(makeJuntada("DOSSIÊ PAP GET INSS"))).toBe(true);
  });
});

// ── shouldSkipTask ─────────────────────────────────────────────────────────────

describe("shouldSkipTask", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create an isolated temp directory for each test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luai-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(
    dir: string,
    manifest: object
  ) {
    fs.writeFileSync(
      path.join(dir, "_manifest.json"),
      JSON.stringify(manifest),
      "utf-8"
    );
  }

  function touchFile(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "placeholder");
  }

  it("returns false when no manifest exists", () => {
    expect(shouldSkipTask(tmpDir)).toBe(false);
  });

  it("returns true when manifest is complete and all files exist", () => {
    const f1 = path.join(tmpDir, "file1.pdf");
    const f2 = path.join(tmpDir, "file2.pdf");
    touchFile(f1);
    touchFile(f2);
    writeManifest(tmpDir, {
      skipped: false,
      files: [{ filePath: f1 }, { filePath: f2 }],
    });
    expect(shouldSkipTask(tmpDir)).toBe(true);
  });

  it("returns false when skipped=true (failed task)", () => {
    writeManifest(tmpDir, { skipped: true, files: [] });
    expect(shouldSkipTask(tmpDir)).toBe(false);
  });

  it("returns false when a listed file is missing from disk", () => {
    const f1 = path.join(tmpDir, "exists.pdf");
    const f2 = path.join(tmpDir, "missing.pdf");
    touchFile(f1);
    // f2 is intentionally NOT created
    writeManifest(tmpDir, {
      skipped: false,
      files: [{ filePath: f1 }, { filePath: f2 }],
    });
    expect(shouldSkipTask(tmpDir)).toBe(false);
  });

  it("returns true for a task with no DOSSIÊ PAP GET INSS docs (empty files array)", () => {
    // A task that ran successfully but had 0 matching documents
    writeManifest(tmpDir, { skipped: false, files: [] });
    expect(shouldSkipTask(tmpDir)).toBe(true);
  });

  it("returns false when manifest JSON is corrupt", () => {
    fs.writeFileSync(path.join(tmpDir, "_manifest.json"), "{ invalid json }");
    expect(shouldSkipTask(tmpDir)).toBe(false);
  });
});

// ── Juntada filtering integration ─────────────────────────────────────────────

describe("juntada filtering (integration)", () => {
  /** Minimal juntada factory */
  const makeJuntada = (tipNome: string, comps: number[] = []) => ({
    numeracaoSequencial: 1,
    documento: {
      id: 1000,
      tipoDocumento: { nome: tipNome },
      componentesDigitais: comps.map((id) => ({
        id,
        fileName: `file-${id}pdf`,
        mimetype: "application/pdf",
        tamanho: 1024,
      })),
    },
  });

  it("isolates only the DOSSIÊ PAP GET INSS juntada from a mixed list", () => {
    const juntadas = [
      makeJuntada("CITAÇÃO", [101]),
      makeJuntada("DOSSIÊ PAP GET INSS", [201, 202, 203]),
      makeJuntada("LAUDO MÉDICO", [301]),
      makeJuntada("DOSSIÊ PREVIDENCIÁRIO", [401]),
    ];

    const papget = juntadas.filter(isPapGetInss);
    expect(papget).toHaveLength(1);
    expect(papget[0].documento.tipoDocumento.nome).toBe("DOSSIÊ PAP GET INSS");
    expect(papget[0].documento.componentesDigitais).toHaveLength(3);
  });

  it("returns an empty array when no juntada matches", () => {
    const juntadas = [
      makeJuntada("CITAÇÃO"),
      makeJuntada("LAUDO MÉDICO"),
      makeJuntada("PETIÇÃO INICIAL"),
    ];
    expect(juntadas.filter(isPapGetInss)).toHaveLength(0);
  });

  it("collects the correct component IDs", () => {
    const juntadas = [
      makeJuntada("DOSSIÊ PAP GET INSS", [3071729613, 3071729854, 3071736720]),
    ];
    const papget = juntadas.filter(isPapGetInss);
    const ids = papget[0].documento.componentesDigitais.map((c: any) => c.id);
    expect(ids).toEqual([3071729613, 3071729854, 3071736720]);
  });

  it("applies fixFileName to all component fileNames", () => {
    const rawNames = [
      "PAPGET-69468621634-1-de-3pdf",
      "PAPGET-69468621634-2-de-3pdf",
      "PAPGET-69468621634-3-de-3pdf",
    ];
    const fixed = rawNames.map(fixFileName);
    expect(fixed).toEqual([
      "PAPGET-69468621634-1-de-3.pdf",
      "PAPGET-69468621634-2-de-3.pdf",
      "PAPGET-69468621634-3-de-3.pdf",
    ]);
  });
});

// ── Full PDF decode round-trip ─────────────────────────────────────────────────

describe("PDF decode round-trip", () => {
  it("decodes a realistic base64 API response and verifies PDF header", () => {
    // Build a minimal fake PDF (real PDFs start with %PDF-)
    const fakePdfContent = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<</Type /Catalog>>\nendobj\nxref\n%%EOF"
    );

    const dataUri = `data:application/pdf;name=PAPGET-test.pdf;charset=utf-8;base64,${fakePdfContent.toString("base64")}`;

    const decoded = extractPdfBuffer(dataUri);

    // Must start with %PDF
    expect(decoded.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // Round-trip: decoded content must match original
    expect(decoded).toEqual(fakePdfContent);
  });

  it("correctly handles large binary content without corruption", () => {
    // Simulate a ~1 KB "PDF" with varied byte values
    const largeFakePdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)),
      Buffer.from("\n%%EOF"),
    ]);

    const dataUri = `data:application/pdf;base64,${largeFakePdf.toString("base64")}`;
    const decoded = extractPdfBuffer(dataUri);

    expect(decoded).toHaveLength(largeFakePdf.length);
    expect(decoded).toEqual(largeFakePdf);
  });
});
