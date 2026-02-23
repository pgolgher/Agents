/**
 * Tests for analysisAgent.ts
 *
 * Coverage strategy:
 *  - Pure functions (parseAnexoMaps, expandToFullDocuments,
 *    parseVisionResponse, buildVisionPrompt) are tested directly.
 *  - detectEvidenceWithVision is tested via jest mocks for the
 *    Anthropic SDK and the pdf-lib / fs modules.
 *  - createEvidencePdf is tested with a minimal in-memory PDF fixture.
 */

import fs from "fs";
import path from "path";
import os from "os";
import {
  parseAnexoMaps,
  expandToFullDocuments,
  parseVisionResponse,
  buildVisionPrompt,
  detectEvidenceWithVision,
  createEvidencePdf,
  EvidenceMatch,
  VisionMatch,
} from "../analysisAgent";

// ─── parseAnexoMaps ────────────────────────────────────────────────────────────

describe("parseAnexoMaps", () => {
  it("returns empty maps when page texts are empty", () => {
    const { anexoByPage, docByAnexo } = parseAnexoMaps([]);
    expect(anexoByPage.size).toBe(0);
    expect(docByAnexo.size).toBe(0);
  });

  it("returns empty maps when no 'Anexo ID:' markers are found", () => {
    const { anexoByPage, docByAnexo } = parseAnexoMaps([
      "Some irrelevant text",
      "Another page with no markers",
    ]);
    expect(anexoByPage.size).toBe(0);
    expect(docByAnexo.size).toBe(0);
  });

  it("builds page→Anexo map from footer 'Anexo ID: XXXXXXX'", () => {
    const pages = [
      "Page 0 content\nAnexo ID: 1234567",
      "Page 1 content\nAnexo ID: 7654321",
      "Page 2 — no Anexo",
    ];
    const { anexoByPage } = parseAnexoMaps(pages);
    expect(anexoByPage.get(0)).toBe("1234567");
    expect(anexoByPage.get(1)).toBe("7654321");
    expect(anexoByPage.has(2)).toBe(false);
  });

  it("builds Anexo→docName map from index table in first pages", () => {
    // Simulates INSS portal index format: ID then docname up to ".pdf"
    const indexPage =
      "Índice de Documentos\n" +
      "1234567 1.1 CERTIDAO DE NASCIMENTO DIVINA.pdf\n" +
      "7654321 1.2 CTPS PRIMEIRA VIA.pdf\n";
    const pages = [
      indexPage,
      "Some page Anexo ID: 1234567",
      "Another page Anexo ID: 7654321",
    ];
    const { docByAnexo } = parseAnexoMaps(pages);
    expect(docByAnexo.get("1234567")).toBe("CERTIDAO DE NASCIMENTO DIVINA.pdf");
    expect(docByAnexo.get("7654321")).toBe("CTPS PRIMEIRA VIA.pdf");
  });

  it("handles multiline document names (wrapped across lines in index)", () => {
    // The parseAnexoMaps joins lines when building the index string
    const indexPage =
      "1234567 1.1 CERTIDAO\nDE NASCIMENTO LONGA.pdf\n";
    const pages = [
      indexPage,
      "content Anexo ID: 1234567",
    ];
    const { docByAnexo } = parseAnexoMaps(pages);
    // The doc name should include the continuation, joined by space
    const docName = docByAnexo.get("1234567") ?? "";
    expect(docName).toMatch(/\.pdf$/i);
  });

  it("ignores ID with 6 or fewer digits (too short to be a valid Anexo ID)", () => {
    const pages = ["Page content Anexo ID: 123", "Another page"];
    const { anexoByPage } = parseAnexoMaps(pages);
    expect(anexoByPage.size).toBe(0);
  });

  it("accepts 7-digit and 12-digit IDs", () => {
    const pages = [
      "Anexo ID: 1234567",
      "Anexo ID: 123456789012",
    ];
    const { anexoByPage } = parseAnexoMaps(pages);
    expect(anexoByPage.get(0)).toBe("1234567");
    expect(anexoByPage.get(1)).toBe("123456789012");
  });

  it("uses the same Anexo ID across multiple pages (same document)", () => {
    const pages = [
      "Índice\n9876543 CTPS.pdf",
      "Page 1 of CTPS Anexo ID: 9876543",
      "Page 2 of CTPS Anexo ID: 9876543",
    ];
    const { anexoByPage, docByAnexo } = parseAnexoMaps(pages);
    expect(anexoByPage.get(1)).toBe("9876543");
    expect(anexoByPage.get(2)).toBe("9876543");
    expect(docByAnexo.get("9876543")).toBe("CTPS.pdf");
  });
});

// ─── expandToFullDocuments ─────────────────────────────────────────────────────

describe("expandToFullDocuments", () => {
  const SOURCE = "/fake/source.pdf";

  it("returns empty array when there are no matches", () => {
    const pages = expandToFullDocuments([], ["p0", "p1", "p2"], new Map(), SOURCE);
    expect(pages).toHaveLength(0);
  });

  it("expands a single matched page to all pages with the same AnexoID", () => {
    // Pages 0-2 all belong to AnexoID "AAA111"
    const anexoByPage = new Map([
      [0, "AAA111"],
      [1, "AAA111"],
      [2, "AAA111"],
      [3, "BBB222"],
    ]);
    const pageTexts = ["p0", "p1", "p2", "p3"];
    const match: EvidenceMatch = {
      sourceFile: SOURCE,
      pageIndex: 1,
      pageNumber: 2,
      anexoId: "AAA111",
      evidenceType: "CTPS",
      definitive: true,
      excerpt: "test",
    };

    const pages = expandToFullDocuments([match], pageTexts, anexoByPage, SOURCE);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1, 2]);
  });

  it("includes only the directly matched page when there is no AnexoID", () => {
    const anexoByPage = new Map<number, string>(); // no Anexo IDs
    const pageTexts = ["p0", "p1", "p2"];
    const match: EvidenceMatch = {
      sourceFile: SOURCE,
      pageIndex: 1,
      pageNumber: 2,
      evidenceType: "text match",
      definitive: true,
      excerpt: "LAVRADOR",
    };

    const pages = expandToFullDocuments([match], pageTexts, anexoByPage, SOURCE);
    expect(pages.map((p) => p.pageIndex)).toEqual([1]);
  });

  it("handles multiple matched documents without duplicating pages", () => {
    const anexoByPage = new Map([
      [0, "DOC1"],
      [1, "DOC1"],
      [2, "DOC2"],
      [3, "DOC2"],
    ]);
    const pageTexts = ["p0", "p1", "p2", "p3"];
    const matches: EvidenceMatch[] = [
      { sourceFile: SOURCE, pageIndex: 0, pageNumber: 1, anexoId: "DOC1", evidenceType: "t", definitive: true, excerpt: "" },
      { sourceFile: SOURCE, pageIndex: 2, pageNumber: 3, anexoId: "DOC2", evidenceType: "t", definitive: true, excerpt: "" },
    ];

    const pages = expandToFullDocuments(matches, pageTexts, anexoByPage, SOURCE);
    expect(pages.map((p) => p.pageIndex)).toEqual([0, 1, 2, 3]);
  });

  it("filters by sourceFile so pages from other files are not included", () => {
    const anexoByPage = new Map([[0, "DOC1"], [1, "DOC1"]]);
    const pageTexts = ["p0", "p1"];
    const matchFromOtherFile: EvidenceMatch = {
      sourceFile: "/other/file.pdf",
      pageIndex: 0,
      pageNumber: 1,
      anexoId: "DOC1",
      evidenceType: "t",
      definitive: true,
      excerpt: "",
    };

    const pages = expandToFullDocuments([matchFromOtherFile], pageTexts, anexoByPage, SOURCE);
    expect(pages).toHaveLength(0);
  });

  it("preserves page ordering", () => {
    const anexoByPage = new Map([
      [5, "X1"],
      [3, "X1"],
      [1, "X1"],
    ]);
    const pageTexts = Array.from({ length: 6 }, (_, i) => `p${i}`);
    const match: EvidenceMatch = {
      sourceFile: SOURCE,
      pageIndex: 3,
      pageNumber: 4,
      anexoId: "X1",
      evidenceType: "t",
      definitive: true,
      excerpt: "",
    };

    const pages = expandToFullDocuments([match], pageTexts, anexoByPage, SOURCE);
    // Should be sorted by page index
    expect(pages.map((p) => p.pageIndex)).toEqual([1, 3, 5]);
  });
});

// ─── parseVisionResponse ───────────────────────────────────────────────────────

describe("parseVisionResponse", () => {
  it("returns empty array for empty string", () => {
    expect(parseVisionResponse("")).toHaveLength(0);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseVisionResponse("not json at all")).toHaveLength(0);
    expect(parseVisionResponse("{broken: json}")).toHaveLength(0);
  });

  it("returns empty array for valid JSON with no evidenceFound key", () => {
    expect(parseVisionResponse('{"other": "key"}')).toHaveLength(0);
  });

  it("returns empty array when evidenceFound is an empty array", () => {
    expect(parseVisionResponse('{"evidenceFound": []}')).toHaveLength(0);
  });

  it("parses a single valid evidence match", () => {
    const json = JSON.stringify({
      evidenceFound: [
        {
          pages: [3, 4],
          documentType: "Certidão de nascimento constando profissão LAVRADOR",
          qualifyingContent: "Campo profissão: LAVRADOR",
          confidence: "high",
        },
      ],
    });
    const result = parseVisionResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0].pages).toEqual([3, 4]);
    expect(result[0].documentType).toBe("Certidão de nascimento constando profissão LAVRADOR");
    expect(result[0].qualifyingContent).toBe("Campo profissão: LAVRADOR");
    expect(result[0].confidence).toBe("high");
  });

  it("strips markdown ```json code fences before parsing", () => {
    const wrapped =
      "```json\n" +
      '{"evidenceFound": [{"pages": [1], "documentType": "CTPS", "qualifyingContent": "rural", "confidence": "high"}]}' +
      "\n```";
    const result = parseVisionResponse(wrapped);
    expect(result).toHaveLength(1);
    expect(result[0].documentType).toBe("CTPS");
  });

  it("strips plain ``` code fences before parsing", () => {
    const wrapped =
      "```\n" +
      '{"evidenceFound": [{"pages": [2], "documentType": "ITR", "qualifyingContent": "imposto rural", "confidence": "medium"}]}' +
      "\n```";
    const result = parseVisionResponse(wrapped);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe("medium");
  });

  it("extracts JSON from surrounding prose when parsing fails directly", () => {
    const withProse =
      'Aqui está a análise:\n{"evidenceFound": [{"pages": [5], "documentType": "PRONAF", "qualifyingContent": "acesso pronaf", "confidence": "high"}]}\nFim da análise.';
    const result = parseVisionResponse(withProse);
    expect(result).toHaveLength(1);
    expect(result[0].documentType).toBe("PRONAF");
  });

  it("filters out entries with missing or empty documentType", () => {
    const json = JSON.stringify({
      evidenceFound: [
        { pages: [1], documentType: "", qualifyingContent: "x", confidence: "high" },
        { pages: [2], qualifyingContent: "y", confidence: "high" }, // missing documentType
        { pages: [3], documentType: "CCIR", qualifyingContent: "z", confidence: "high" },
      ],
    });
    const result = parseVisionResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0].documentType).toBe("CCIR");
  });

  it("filters out entries where pages is not an array", () => {
    const json = JSON.stringify({
      evidenceFound: [
        { pages: "1,2", documentType: "CTPS", qualifyingContent: "x", confidence: "high" },
        { pages: [1], documentType: "CTPS", qualifyingContent: "y", confidence: "high" },
      ],
    });
    const result = parseVisionResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0].pages).toEqual([1]);
  });

  it("filters out entries where pages is an empty array", () => {
    const json = JSON.stringify({
      evidenceFound: [
        { pages: [], documentType: "CTPS", qualifyingContent: "x", confidence: "high" },
      ],
    });
    expect(parseVisionResponse(json)).toHaveLength(0);
  });

  it("coerces page numbers to numbers", () => {
    const json = JSON.stringify({
      evidenceFound: [
        { pages: ["3", "4"], documentType: "CCIR", qualifyingContent: "x", confidence: "high" },
      ],
    });
    const result = parseVisionResponse(json);
    expect(result[0].pages).toEqual([3, 4]);
  });

  it("filters out page numbers less than 1 (0-indexed mistake)", () => {
    const json = JSON.stringify({
      evidenceFound: [
        { pages: [0, 1, 2], documentType: "CCIR", qualifyingContent: "x", confidence: "high" },
      ],
    });
    const result = parseVisionResponse(json);
    expect(result[0].pages).toEqual([1, 2]); // 0 is removed
  });

  it("defaults confidence to 'high' for unknown values", () => {
    const json = JSON.stringify({
      evidenceFound: [
        { pages: [1], documentType: "ITR", qualifyingContent: "x", confidence: "very_high" },
      ],
    });
    const result = parseVisionResponse(json);
    expect(result[0].confidence).toBe("high");
  });

  it("preserves confidence: 'medium'", () => {
    const json = JSON.stringify({
      evidenceFound: [
        { pages: [1], documentType: "Prontuário", qualifyingContent: "zona rural", confidence: "medium" },
      ],
    });
    const result = parseVisionResponse(json);
    expect(result[0].confidence).toBe("medium");
  });

  it("defaults qualifyingContent to empty string when absent", () => {
    const json = JSON.stringify({
      evidenceFound: [
        { pages: [1], documentType: "CCIR", confidence: "high" },
      ],
    });
    const result = parseVisionResponse(json);
    expect(result[0].qualifyingContent).toBe("");
  });

  it("parses multiple valid matches at once", () => {
    const json = JSON.stringify({
      evidenceFound: [
        { pages: [1, 2], documentType: "CTPS", qualifyingContent: "rural entry", confidence: "high" },
        { pages: [5], documentType: "CCIR", qualifyingContent: "imóvel rural", confidence: "high" },
        { pages: [10, 11, 12], documentType: "Certidão de casamento constando profissão LAVRADORA", qualifyingContent: "profissão", confidence: "medium" },
      ],
    });
    const result = parseVisionResponse(json);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.documentType)).toEqual(["CTPS", "CCIR", "Certidão de casamento constando profissão LAVRADORA"]);
  });
});

// ─── buildVisionPrompt ─────────────────────────────────────────────────────────

describe("buildVisionPrompt", () => {
  const sampleProva = "Certidão de nascimento constando profissão LAVRADOR\nCTPS com vínculos rurais";

  it("includes the provaDocumental content", () => {
    const prompt = buildVisionPrompt(sampleProva, 0);
    expect(prompt).toContain("Certidão de nascimento constando profissão LAVRADOR");
    expect(prompt).toContain("CTPS com vínculos rurais");
  });

  it("does NOT include a fragment note when chunkStartPage is 0", () => {
    const prompt = buildVisionPrompt(sampleProva, 0);
    // The static prompt text contains the word "fragmento" in the last line
    // ("Se não houver nenhuma prova válida neste fragmento, retorne…").
    // The actual NOTA annotation should NOT be present when chunkStartPage is 0.
    expect(prompt).not.toContain("NOTA:");
    expect(prompt).not.toContain("deste fragmento corresponde");
  });

  it("includes a fragment note with the correct page number when chunkStartPage > 0", () => {
    const prompt = buildVisionPrompt(sampleProva, 60);
    // Should mention that page 1 of this chunk = page 61 of the original
    expect(prompt).toContain("61");
    expect(prompt).toMatch(/fragmento/i);
  });

  it("uses chunkStartPage + 1 as the displayed original page number", () => {
    const prompt = buildVisionPrompt(sampleProva, 119);
    expect(prompt).toContain("120");
  });

  it("contains the evidenceFound JSON schema instruction", () => {
    const prompt = buildVisionPrompt(sampleProva, 0);
    expect(prompt).toContain("evidenceFound");
    expect(prompt).toContain("documentType");
    expect(prompt).toContain("qualifyingContent");
    expect(prompt).toContain("confidence");
  });

  it("instructs Claude to return ONLY JSON", () => {
    const prompt = buildVisionPrompt(sampleProva, 0);
    expect(prompt).toMatch(/apenas.*json|only.*json|somente.*json|exclusivamente.*json/i);
  });

  it("mentions key qualifying criteria (LAVRADOR, Zona Rural)", () => {
    const prompt = buildVisionPrompt(sampleProva, 0);
    expect(prompt).toMatch(/LAVRADOR/);
    expect(prompt).toMatch(/rural/i);
  });
});

// ─── detectEvidenceWithVision ─────────────────────────────────────────────────

// Mock the Anthropic SDK so no real API calls are made.
// We use a single shared `createFn` attached to the mock constructor so that
// all instances created inside detectEvidenceWithVision share the same mock.
jest.mock("@anthropic-ai/sdk", () => {
  const createFn = jest.fn();
  const MockAnthropic: any = jest.fn().mockImplementation(() => ({
    messages: { create: createFn },
  }));
  MockAnthropic.__mockCreate = createFn;
  return { __esModule: true, default: MockAnthropic };
});

// Mock pdf-lib (used inside splitPdfIntoChunks)
jest.mock("pdf-lib", () => {
  const mockPage = {};
  const mockCopyPages = jest.fn().mockResolvedValue([mockPage]);
  const mockAddPage = jest.fn();
  const mockSave = jest.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70])); // %PDF
  const mockGetPageCount = jest.fn().mockReturnValue(30);

  const mockDoc = {
    getPageCount: mockGetPageCount,
    copyPages: mockCopyPages,
    addPage: mockAddPage,
    save: mockSave,
  };

  return {
    PDFDocument: {
      load: jest.fn().mockResolvedValue(mockDoc),
      create: jest.fn().mockResolvedValue(mockDoc),
    },
  };
});

describe("detectEvidenceWithVision", () => {
  let tmpDir: string;
  let fakePdfPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luai-vision-test-"));
    fakePdfPath = path.join(tmpDir, "fake.pdf");
    // Write a minimal fake PDF so fs.readFileSync works
    fs.writeFileSync(fakePdfPath, Buffer.from("%PDF-1.4 fake"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function getAnthropicMock(): jest.Mock {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = require("@anthropic-ai/sdk").default;
    return (Anthropic as any).__mockCreate;
  }

  it("returns empty array when vision API returns no evidenceFound", async () => {
    const createMock = getAnthropicMock();
    createMock.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"evidenceFound": []}' }],
    });

    const matches = await detectEvidenceWithVision(
      fakePdfPath,
      "PROVA_DOC_LIST",
      new Map(),
      new Map()
    );
    expect(matches).toHaveLength(0);
  });

  it("returns EvidenceMatch objects for identified evidence pages", async () => {
    const createMock = getAnthropicMock();
    createMock.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            evidenceFound: [
              {
                pages: [3, 4],
                documentType: "CTPS com vínculos rurais",
                qualifyingContent: "Trabalhadora Rural na Plantar",
                confidence: "high",
              },
            ],
          }),
        },
      ],
    });

    const anexoByPage = new Map([[2, "DOC001"], [3, "DOC001"]]);
    const docByAnexo = new Map([["DOC001", "CTPS.pdf"]]);

    const matches = await detectEvidenceWithVision(
      fakePdfPath,
      "PROVA_DOCS",
      anexoByPage,
      docByAnexo
    );

    expect(matches).toHaveLength(2);
    // chunk page 3 → pageIndex 2 (0-based), chunk page 4 → pageIndex 3
    expect(matches[0].pageIndex).toBe(2);
    expect(matches[0].pageNumber).toBe(3);
    expect(matches[0].evidenceType).toBe("CTPS com vínculos rurais");
    expect(matches[0].definitive).toBe(true);
    expect(matches[0].excerpt).toBe("Trabalhadora Rural na Plantar");
    expect(matches[0].sourceFile).toBe(fakePdfPath);
    // Page 2 has anexoId DOC001
    expect(matches[0].anexoId).toBe("DOC001");
    expect(matches[0].documentName).toBe("CTPS.pdf");
  });

  it("sets definitive=false for medium-confidence matches", async () => {
    const createMock = getAnthropicMock();
    createMock.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            evidenceFound: [
              {
                pages: [1],
                documentType: "Prontuário médico",
                qualifyingContent: "endereço zona rural",
                confidence: "medium",
              },
            ],
          }),
        },
      ],
    });

    const matches = await detectEvidenceWithVision(fakePdfPath, "DOCS", new Map(), new Map());
    expect(matches[0].definitive).toBe(false);
  });

  it("deduplicates pages — if the same page appears in multiple vision matches, keeps the first", async () => {
    const createMock = getAnthropicMock();
    createMock.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            evidenceFound: [
              { pages: [5], documentType: "CTPS", qualifyingContent: "rural 1", confidence: "high" },
              { pages: [5], documentType: "PRONAF", qualifyingContent: "pronaf", confidence: "high" },
            ],
          }),
        },
      ],
    });

    const matches = await detectEvidenceWithVision(fakePdfPath, "DOCS", new Map(), new Map());
    // Page 5 should appear only once
    expect(matches.filter((m) => m.pageIndex === 4)).toHaveLength(1);
    expect(matches.find((m) => m.pageIndex === 4)?.evidenceType).toBe("CTPS");
  });

  it("returns empty array when API throws a non-rate-limit error", async () => {
    const createMock = getAnthropicMock();
    createMock.mockRejectedValueOnce(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process PDF"}}'));

    const matches = await detectEvidenceWithVision(fakePdfPath, "DOCS", new Map(), new Map());
    expect(matches).toHaveLength(0);
  });

  it("retries on 429 rate-limit errors and returns result from the retry", async () => {
    const createMock = getAnthropicMock();
    // First call: 429 rate limit
    createMock.mockRejectedValueOnce(new Error("429 rate_limit exceeded"));
    // Second call (retry): success
    createMock.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            evidenceFound: [
              { pages: [1], documentType: "CCIR", qualifyingContent: "imóvel rural", confidence: "high" },
            ],
          }),
        },
      ],
    });

    // Speed up the test — use fake timers and drain all async timers
    jest.useFakeTimers();
    try {
      const matchesPromise = detectEvidenceWithVision(fakePdfPath, "DOCS", new Map(), new Map());
      // Advance timers past the 15s backoff sleep
      await jest.runAllTimersAsync();
      const matches = await matchesPromise;

      expect(matches).toHaveLength(1);
      expect(matches[0].evidenceType).toBe("CCIR");
      expect(createMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("sorts returned matches by page index ascending", async () => {
    const createMock = getAnthropicMock();
    createMock.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            evidenceFound: [
              { pages: [10, 2, 7], documentType: "CTPS", qualifyingContent: "x", confidence: "high" },
            ],
          }),
        },
      ],
    });

    const matches = await detectEvidenceWithVision(fakePdfPath, "DOCS", new Map(), new Map());
    const indices = matches.map((m) => m.pageIndex);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it("returns empty array when API returns unexpected content type", async () => {
    const createMock = getAnthropicMock();
    createMock.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
    });

    const matches = await detectEvidenceWithVision(fakePdfPath, "DOCS", new Map(), new Map());
    expect(matches).toHaveLength(0);
  });
});

// ─── createEvidencePdf ─────────────────────────────────────────────────────────

describe("createEvidencePdf", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luai-pdf-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it("does not create any file when pages array is empty", async () => {
    const outputPath = path.join(tmpDir, "out.pdf");
    await createEvidencePdf([], outputPath);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("calls PDFDocument.create and writes output for non-empty pages", async () => {
    const { PDFDocument } = require("pdf-lib");
    const outputPath = path.join(tmpDir, "out.pdf");

    // The mocked PDFDocument.create returns a doc that has copyPages + save
    const fakeSrcPath = path.join(tmpDir, "src.pdf");
    fs.writeFileSync(fakeSrcPath, Buffer.from("%PDF-1.4 fake"));

    await createEvidencePdf([{ pdfPath: fakeSrcPath, pageIndex: 0 }], outputPath);

    expect(PDFDocument.create).toHaveBeenCalled();
    expect(PDFDocument.load).toHaveBeenCalledWith(expect.any(Buffer));
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("filters out out-of-range page indices without throwing", async () => {
    const { PDFDocument } = require("pdf-lib");
    // Mock says the source doc has 30 pages (getPageCount returns 30)
    const fakeSrcPath = path.join(tmpDir, "src.pdf");
    fs.writeFileSync(fakeSrcPath, Buffer.from("%PDF-1.4 fake"));

    const outputPath = path.join(tmpDir, "out.pdf");
    // pageIndex 99 is beyond the 30-page mock — should be silently skipped
    await createEvidencePdf([{ pdfPath: fakeSrcPath, pageIndex: 99 }], outputPath);

    // With no valid pages, nothing is written
    expect(PDFDocument.create).toHaveBeenCalled();
    // The save / write still happens because the new doc was created (even empty in some implementations)
    // Key assertion: no exception was thrown
  });
});
