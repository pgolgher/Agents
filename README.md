# LuAI — Assistente Jurídico Previdenciário

LuAI is an AI-powered legal assistant designed to support Brazilian government lawyers handling social security (previdência social) cases. It orchestrates multiple specialized agents that fetch and parse data from websites and PDF documents, then produces reasoned legal decisions grounded in Brazilian social security legislation.

## Architecture

```
src/
├── index.ts                 # Entry point
├── config.ts                # API key & model config
├── agents/
│   ├── orchestrator.ts      # Main orchestrating agent
│   ├── webAgent.ts          # Web page fetching & analysis agent
│   └── pdfAgent.ts          # PDF parsing & analysis agent
└── tools/
    ├── webScraper.ts        # Cheerio-based web scraper
    └── pdfParser.ts         # pdf-parse wrapper
```

### Agent Flow

```
User Query
    │
    ▼
Orchestrator Agent
    ├── Web Agent(s)  ──►  [fetch URLs → extract legal info]
    ├── PDF Agent(s)  ──►  [parse PDFs → extract legal info]
    └── Decision      ──►  Reasoned legal output (PT-BR)
```

## Legal Knowledge Base

Decisions are grounded in:
- **Lei n.º 8.213/1991** — Plano de Benefícios da Previdência Social
- **Lei n.º 8.212/1991** — Custeio da Seguridade Social
- **Decreto n.º 3.048/1999** — Regulamento da Previdência Social
- **IN PRES/INSS n.º 128/2022** — Procedimentos do INSS
- **EC 103/2019** — Reforma da Previdência
- Jurisprudência do STJ e STF

## Setup

1. **Install Node.js** — Download LTS from [nodejs.org](https://nodejs.org)

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env and add your ANTHROPIC_API_KEY
   ```

4. **Run**
   ```bash
   npm run dev       # development (ts-node)
   npm run build     # compile TypeScript
   npm start         # run compiled output
   ```

## Usage

Edit `src/index.ts` to provide your case input:

```typescript
const caseInput: CaseInput = {
  query: "Descrição do caso ou pergunta jurídica",
  urls: ["https://www.gov.br/inss/..."],   // optional
  pdfPaths: ["./documentos/cnis.pdf"],     // optional
};
```

The orchestrator will:
1. Fetch and analyze any provided URLs
2. Parse and analyze any provided PDF documents
3. Synthesize all gathered information
4. Produce a structured legal decision in Portuguese

## Model

Uses **Claude Opus 4.6** with adaptive thinking for complex legal reasoning.
