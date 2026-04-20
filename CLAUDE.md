# LuAI — Claude Code Instructions

## Project Overview

LuAI is a Brazilian social security (previdência social) legal assistant powered by Claude AI.
It orchestrates specialized agents that download, parse, and analyse INSS/PAP GET INSS PDFs,
then produces reasoned legal decisions grounded in Brazilian previdência social legislation.

All output (logs, decisions, reasoning) must be in **Portuguese (pt-BR)** with appropriate
juridical language, unless the code itself (identifiers, comments) where English is preferred.

---

## Architecture

```
src/
├── config.ts                    # API key + model config (single source of truth)
├── index.ts                     # CLI entry point
├── agents/
│   ├── orchestrator.ts          # Coordinates sub-agents → legal decision
│   ├── downloadAgent.ts         # Downloads PAP GET INSS PDFs via REST
│   ├── analysisAgent.ts         # Vision-based evidence detection via Claude
│   ├── webAgent.ts              # Web page fetching + analysis
│   └── pdfAgent.ts              # PDF parsing + analysis
├── tools/
│   ├── webScraper.ts            # Cheerio-based scraper
│   └── pdfParser.ts             # pdf-parse wrapper
└── server/
    └── index.ts                 # Express dashboard (localhost only)
```

Agent tests live in `src/agents/__tests__/`.
Mocks live in `src/__mocks__/`.

---

## SECURITY REQUIREMENTS — NON-NEGOTIABLE

> These rules are permanent constraints. They apply to every file edit, every new route,
> every new server, and every npm script change. They must never be relaxed or worked around.

### 1. Localhost binding — ALWAYS required

**Every server in this project MUST bind to `127.0.0.1` only.**

The canonical pattern, already established in `src/server/index.ts`:

```typescript
// CORRECT — only accepts connections from the local machine
app.listen(PORT, "127.0.0.1", () => { ... });
```

The following are **forbidden** under any circumstance:

```typescript
// FORBIDDEN — binds to all interfaces, exposes to the network
app.listen(PORT, () => { ... });
app.listen(PORT, "0.0.0.0", () => { ... });
```

This rule applies to:
- Express / HTTP servers
- WebSocket servers
- Any future dev server, proxy, or preview tool
- Any `npm run` script (never add `--host 0.0.0.0` or `--host ::`)

If a library or framework defaults to `0.0.0.0`, you must explicitly override it to
`127.0.0.1` before adding it to this project.

### 2. No CORS

Do not add any `Access-Control-Allow-Origin` headers or CORS middleware. This server is
exclusively local; cross-origin access has no valid use case here.

### 3. No arbitrary file paths or shell commands from the client

No API route may accept a file path, directory name, or shell command supplied by the
client and use it directly in `fs`, `path.join`, `spawn`, or `exec` calls.

All file-serving routes must:
- Sanitise with `path.basename()` before constructing any path
- Verify the resolved path starts with the expected base directory (prefix check)
- Return HTTP 403 on traversal attempts

Example (already in `src/server/index.ts`):
```typescript
const nup      = path.basename(req.params.nup);       // strip traversal
const filePath = path.join(DOWNLOADS_DIR, nup, ...);
if (!filePath.startsWith(DOWNLOADS_DIR + path.sep)) {  // prefix check
  return res.status(403).json({ error: "Forbidden" });
}
```

### 4. Never log credentials

`AGU_EMAIL`, `AGU_SENHA`, `ANTHROPIC_API_KEY`, JWT tokens, and any other secret loaded
from `.env` must **never** appear in `console.log`, `console.error`, log buffers, SSE
streams, or API responses — not even partially or truncated.

If you need to confirm a value is set, log its presence, not its value:

```typescript
// CORRECT
console.log(`[DownloadAgent] AGU_SENHA is ${senha ? "set" : "missing"}`);

// FORBIDDEN
console.log(`[DownloadAgent] Logging in as ${email} / ${senha}`);
```

### 6. No sensitive data in URLs

API keys, tokens, NUPs, or any user-identifying data must never appear in URL query
parameters. Use request bodies (POST/PUT) or headers instead.

### 7. Verification after every server change

After editing `src/server/index.ts` or any file that affects the running server:
1. Restart the server via `preview_start`
2. Confirm the bound address is `127.0.0.1` with `lsof -iTCP:<PORT> -sTCP:LISTEN`
3. Confirm the UI loads at `http://localhost:<PORT>` with `preview_screenshot`

---

## TypeScript Rules

- **Strict mode is on** — never disable `strict`, `noImplicitAny`, or `strictNullChecks`.
- **No `any`** — use `unknown` with a type guard, or a proper interface/type.
- **Explicit return types** on all exported functions.
- **No non-null assertions (`!`)** unless the value was just checked in the same scope.
- Use `const` by default; `let` only when reassignment is necessary.
- Prefer `interface` for object shapes, `type` for unions and aliases.
- Import order: Node built-ins → third-party → local (`../` or `./`).

---

## Testability Rules

### Pure functions first
Extract all business logic into pure, exported functions before writing agent runners.
Agent runners (functions with side effects: API calls, file I/O, spawning processes) are
not unit-tested directly — they are integration-tested with mocks.

Good pattern (already used in `downloadAgent.ts`):
```typescript
// Pure — easy to unit test
export function fixFileName(name: string): string { ... }

// Side-effectful runner — mock axios/fs in tests
export async function downloadAgent(): Promise<void> { ... }
```

### Dependency injection for external services
Pass external dependencies (Anthropic client, axios instance, fs module) as parameters
or construct them at the top of the module so they can be replaced in tests via
`jest.mock(...)` or module-level mocking.

### Test file location
All tests go in `src/agents/__tests__/` or `src/tools/__tests__/`.
File naming: `<module>.test.ts`.

### What must be tested
- Every exported pure function must have unit tests covering happy path + edge cases.
- Every agent must have at least one integration test with mocked I/O.
- New API routes must have tests for: success, 400/404/409 error cases, path traversal
  attempts.

### Coverage
Run `npm run test:coverage` to check. Thresholds enforced in `jest.config.ts`:
- Lines: 80 %
- Functions: 80 %
- Branches: 70 %

---

## Code Style

- **No magic strings** — use `const` or `enum` for repeated values (agent names,
  file extensions, status codes).
- **No `console.log` in library code** — agents may log to stdout via `console.log`
  (they are the leaf processes), but shared utilities (`tools/`, `config.ts`) must not.
- **Error handling at boundaries only** — do not swallow errors silently inside
  utilities. Let them propagate; catch and log only at the agent/server level.
- **No orphaned `async` calls** — every `async` call must be awaited or explicitly
  handled with `.catch(...)`. The ESLint `no-floating-promises` rule enforces this.
- Keep functions short (< 40 lines). Extract when they grow.

---

## Model Configuration

The Anthropic model is defined **once** in `src/config.ts`.
Do not hardcode model names anywhere else. Always import from `config`.

Current model: `claude-haiku-4-5` for speed/cost.
For heavy reasoning tasks use `claude-sonnet-4-6` — change it in `config.ts` only.

---

## Running the Project

```bash
npm run serve        # Start the dashboard server (localhost:3000)
npm run download     # Run the download agent
npm run analyze      # Run the analysis agent
npm run test         # Run all tests
npm run test:coverage # Tests + coverage report
npm run lint         # ESLint check
npm run build        # Compile TypeScript
```

Never run `ts-node` directly in production or CI — always use the compiled output
(`npm run build && npm start`).

---

## Domain Context

- NUP: process number (Número Único de Protocolo)
- PAP GET INSS: the external REST API used to download case dossiers
- EVIDENCE.pdf: compiled evidence pages extracted from the dossier
- VERIDICT.md: the final legal analysis output
- `_manifest.json`: metadata written after download
- `_analysis.json`: metadata written after analysis

Legal basis for decisions:
- Lei n.º 8.213/1991 — Benefícios da Previdência Social
- Lei n.º 8.212/1991 — Custeio da Seguridade Social
- Decreto n.º 3.048/1999 — Regulamento da Previdência Social
- IN PRES/INSS n.º 128/2022
- EC 103/2019 — Reforma da Previdência
- Jurisprudência STJ/STF
