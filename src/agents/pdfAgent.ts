import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { parsePdfFile, parsePdfBuffer } from "../tools/pdfParser.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

/**
 * Parses a PDF (from file path or buffer) and uses Claude to extract
 * legally relevant information in the context of Brazilian social security.
 */
export async function pdfAgent(
  source: string | Buffer,
  question: string,
  label?: string
): Promise<string> {
  const parsed =
    typeof source === "string"
      ? await parsePdfFile(source)
      : await parsePdfBuffer(source, label ?? "documento.pdf");

  // Truncate to ~150k chars for context safety
  const safeText = parsed.text.slice(0, 150_000);

  const stream = client.messages.stream({
    model: config.model,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: `Você é um assistente jurídico especializado em Direito Previdenciário brasileiro.
Seu papel é analisar documentos em PDF para extrair informações relevantes
para casos de previdência social no Brasil (INSS, aposentadoria, benefícios, etc.).
Identifique datas, valores, períodos de contribuição, benefícios e qualquer dado
relevante para a análise previdenciária.
Responda em português brasileiro.`,
    messages: [
      {
        role: "user",
        content: `Documento analisado: ${parsed.filePath}
Número de páginas: ${parsed.numPages}
Data de análise: ${parsed.parsedAt}

Conteúdo extraído:
${safeText}

---
Pergunta: ${question}`,
      },
    ],
  });

  const finalMessage = await stream.finalMessage();

  const textBlock = finalMessage.content.find((b) => b.type === "text");
  return textBlock?.type === "text" ? textBlock.text : "";
}
