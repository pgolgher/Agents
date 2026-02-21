import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";

export interface ParsedPdf {
  filePath: string;
  text: string;
  numPages: number;
  parsedAt: string;
}

/**
 * Parses a PDF file from disk and extracts its text content.
 */
export async function parsePdfFile(filePath: string): Promise<ParsedPdf> {
  const absolutePath = path.resolve(filePath);
  const buffer = fs.readFileSync(absolutePath);
  const data = await pdfParse(buffer);

  return {
    filePath: absolutePath,
    text: data.text.replace(/\s+/g, " ").trim(),
    numPages: data.numpages,
    parsedAt: new Date().toISOString(),
  };
}

/**
 * Parses a PDF from a raw Buffer (e.g. downloaded from the web).
 */
export async function parsePdfBuffer(buffer: Buffer, label = "buffer"): Promise<ParsedPdf> {
  const data = await pdfParse(buffer);

  return {
    filePath: label,
    text: data.text.replace(/\s+/g, " ").trim(),
    numPages: data.numpages,
    parsedAt: new Date().toISOString(),
  };
}
