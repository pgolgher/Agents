import { orchestrate, CaseInput } from "./agents/orchestrator";

/**
 * LuAI — Brazilian Social Security Legal Assistant
 *
 * Entry point. Replace the sample CaseInput below with real case data.
 */
async function main() {
  const caseInput: CaseInput = {
    query:
      "O segurado possui 35 anos de contribuição e 62 anos de idade. " +
      "Tem direito à aposentadoria por tempo de contribuição ou apenas à aposentadoria programada " +
      "prevista na Reforma da Previdência (EC 103/2019)?",
    // urls: ["https://www.gov.br/inss/pt-br"],
    // pdfPaths: ["./documentos/cnis.pdf"],
  };

  console.log("=".repeat(60));
  console.log("LuAI — Assistente Jurídico Previdenciário");
  console.log("=".repeat(60));
  console.log(`\nConsulta: ${caseInput.query}\n`);
  console.log("-".repeat(60));

  const result = await orchestrate(caseInput);

  console.log("\n📋 DECISÃO:\n");
  console.log(result.decision);

  if (result.reasoning) {
    console.log("\n📖 FUNDAMENTAÇÃO:\n");
    console.log(result.reasoning);
  }

  if (result.sources.length > 0) {
    console.log("\n🔗 FONTES CONSULTADAS:");
    result.sources.forEach((s) => console.log(`  - ${s}`));
  }
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
