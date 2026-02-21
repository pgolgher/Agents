import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { fetchWebPage } from "../tools/webScraper";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

/**
 * Fetches a web page and uses Claude to extract legally relevant information
 * from it in the context of Brazilian social security law.
 */
export async function webAgent(url: string, question: string): Promise<string> {
  const page = await fetchWebPage(url);

  // Truncate content to fit within context limits (~150k chars ≈ ~40k tokens)
  const safeContent = page.content.slice(0, 150_000);

  const stream = client.messages.stream({
    model: config.model,
    max_tokens: 4096,
    system: `Você é um assistente jurídico especializado em Direito Previdenciário brasileiro.
Seu papel é analisar documentos e páginas web para extrair informações relevantes
para casos de previdência social no Brasil (INSS, aposentadoria, benefícios, etc.).
Sempre cite a fonte e a data de acesso nas suas respostas.
Responda em português brasileiro.`,
    messages: [
      {
        role: "user",
        content: `Página analisada: ${page.title} (${url})
Data de acesso: ${page.fetchedAt}

Conteúdo:
${safeContent}

---
Pergunta: ${question}`,
      },
    ],
  });

  const finalMessage = await stream.finalMessage();

  const textBlock = finalMessage.content.find((b) => b.type === "text");
  return textBlock?.type === "text" ? textBlock.text : "";
}
