import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { webAgent } from "./webAgent";
import { pdfAgent } from "./pdfAgent";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface CaseInput {
  /** Free-text description of the case or question */
  query: string;
  /** Optional URLs to pages that should be fetched and analyzed */
  urls?: string[];
  /** Optional local PDF file paths to be parsed */
  pdfPaths?: string[];
}

export interface CaseResult {
  decision: string;
  reasoning: string;
  sources: string[];
}

/**
 * Orchestrator agent: coordinates web and PDF sub-agents, then produces
 * a reasoned legal decision grounded in Brazilian social security law.
 */
export async function orchestrate(input: CaseInput): Promise<CaseResult> {
  const sources: string[] = [];
  const contextParts: string[] = [];

  // 1. Gather data from URLs
  for (const url of input.urls ?? []) {
    console.log(`[Orchestrator] Fetching: ${url}`);
    const result = await webAgent(url, input.query);
    contextParts.push(`## Fonte web: ${url}\n${result}`);
    sources.push(url);
  }

  // 2. Gather data from PDFs
  for (const pdfPath of input.pdfPaths ?? []) {
    console.log(`[Orchestrator] Parsing PDF: ${pdfPath}`);
    const result = await pdfAgent(pdfPath, input.query);
    contextParts.push(`## Documento PDF: ${pdfPath}\n${result}`);
    sources.push(pdfPath);
  }

  const context = contextParts.join("\n\n---\n\n");

  // 3. Make final decision
  const stream = client.messages.stream({
    model: config.model,
    max_tokens: 8192,
    system: `Você é LuAI, um assistente jurídico especializado em Direito Previdenciário brasileiro,
desenvolvido para auxiliar advogados do governo federal em casos do INSS.

Suas decisões devem ser fundamentadas em:
- Lei n.º 8.213/1991 (Plano de Benefícios da Previdência Social)
- Lei n.º 8.212/1991 (Custeio da Seguridade Social)
- Decreto n.º 3.048/1999 (Regulamento da Previdência Social)
- Instrução Normativa PRES/INSS n.º 128/2022
- Jurisprudência do STJ e STF em matéria previdenciária

Estruture sempre sua resposta com:
1. DECISÃO (benefício concedido / negado / análise necessária)
2. FUNDAMENTAÇÃO JURÍDICA (artigos e normas aplicáveis)
3. ANÁLISE DOS FATOS (baseada nos documentos e fontes fornecidos)
4. RECOMENDAÇÕES (próximos passos para o advogado)

Responda em português brasileiro com linguagem jurídica adequada.`,
    messages: [
      {
        role: "user",
        content: context
          ? `Caso / Consulta:\n${input.query}\n\n---\n\nInformações coletadas pelos agentes:\n${context}`
          : `Caso / Consulta:\n${input.query}`,
      },
    ],
  });

  const finalMessage = await stream.finalMessage();
  const textBlock = finalMessage.content.find((b) => b.type === "text");
  const fullText = textBlock?.type === "text" ? textBlock.text : "";

  // Split decision from reasoning heuristically (first paragraph is decision)
  const [firstParagraph, ...rest] = fullText.split("\n\n");

  return {
    decision: firstParagraph ?? fullText,
    reasoning: rest.join("\n\n"),
    sources,
  };
}
