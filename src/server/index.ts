/**
 * LuAI Dashboard Server
 *
 * Express server providing:
 *  - REST API to start/stop download and analysis agents
 *  - Server-Sent Events for real-time log streaming
 *  - REST API to browse the downloads/ folder
 *  - Static file serving for the public/ frontend
 *
 * Run: npm run serve
 */

import express, { Request, Response } from "express";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { config } from "../config";

dotenv.config({ override: true });

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = process.env.DASHBOARD_PORT
  ? parseInt(process.env.DASHBOARD_PORT, 10)
  : 3000;

const PROJECT_ROOT  = path.resolve(__dirname, "../../");
const DOWNLOADS_DIR = path.join(PROJECT_ROOT, "downloads");
const PUBLIC_DIR    = path.join(PROJECT_ROOT, "public");
// Use process.execPath so the spawned child inherits the exact same node binary
// that is running the server — avoids "env: node: No such file or directory" when
// the server was launched via a full NVM path and the shebang in ts-node cannot
// resolve "node" through PATH.
const NODE_BIN  = process.execPath;
const TS_REGISTER = path.join(PROJECT_ROOT, "node_modules", "ts-node", "register");

const LOG_BUFFER_SIZE = 500;

// ─── Runtime config (mutable) ─────────────────────────────────────────────────

let activeModel: string = config.model;
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// ─── Types ────────────────────────────────────────────────────────────────────

type AgentName = "download" | "analysis";

interface ProcessState {
  process: ChildProcess | null;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
}

interface LogEntry {
  ts: number;
  line: string;
  type: "stdout" | "stderr" | "system";
}

interface NupSummary {
  nup: string;
  especie: string;
  prazo: string;
  setor: string;
  fileCount: number;
  pdfFiles: string[];
  hasEvidence: boolean;
  hasVerdict: boolean;
  hasAnalysis: boolean;
  skipped: boolean;
  evidencePageCount: number;
  analyzedAt: string | null;
  downloadedAt: string | null;
}

// ─── Agent process state ──────────────────────────────────────────────────────

const agentState: Record<AgentName, ProcessState> = {
  download: { process: null, running: false, pid: null, startedAt: null },
  analysis: { process: null, running: false, pid: null, startedAt: null },
};

const sseClients: Record<AgentName, Response[]> = {
  download: [],
  analysis: [],
};

const logBuffers: Record<AgentName, LogEntry[]> = {
  download: [],
  analysis: [],
};

const AGENT_COMMANDS: Record<AgentName, string[]> = {
  download: [NODE_BIN, "-r", TS_REGISTER, "src/agents/downloadAgent.ts"],
  analysis: [NODE_BIN, "-r", TS_REGISTER, "src/agents/analysisAgent.ts"],
};

// ─── Log helpers ──────────────────────────────────────────────────────────────

function addLogLine(agent: AgentName, line: string, type: LogEntry["type"]): void {
  const entry: LogEntry = { ts: Date.now(), line, type };
  logBuffers[agent].push(entry);
  if (logBuffers[agent].length > LOG_BUFFER_SIZE) {
    logBuffers[agent].shift();
  }
  broadcastLogEntry(agent, entry);
}

function broadcastLogEntry(agent: AgentName, entry: LogEntry): void {
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  const dead: Response[] = [];
  for (const res of sseClients[agent]) {
    try {
      res.write(data);
    } catch {
      dead.push(res);
    }
  }
  for (const d of dead) {
    sseClients[agent] = sseClients[agent].filter((r) => r !== d);
  }
}

function broadcastStatus(agent: AgentName): void {
  const state = agentState[agent];
  const entry: LogEntry = {
    ts: Date.now(),
    line: JSON.stringify({
      type: "status",
      running: state.running,
      pid: state.pid,
      startedAt: state.startedAt,
    }),
    type: "system",
  };
  // Use a special prefix so the frontend can distinguish status from log lines
  const data = `data: ${JSON.stringify({
    ts: Date.now(),
    type: "status",
    running: state.running,
    pid: state.pid,
    startedAt: state.startedAt,
  })}\n\n`;
  const dead: Response[] = [];
  for (const res of sseClients[agent]) {
    try {
      res.write(data);
    } catch {
      dead.push(res);
    }
  }
  for (const d of dead) {
    sseClients[agent] = sseClients[agent].filter((r) => r !== d);
  }
  // Also add a system log line for visibility
  void entry;
}

// ─── Process management ───────────────────────────────────────────────────────

function startAgentProcess(agent: AgentName): void {
  const [cmd, ...args] = AGENT_COMMANDS[agent];
  const child = spawn(cmd, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, LUAI_MODEL: activeModel },
    stdio: ["ignore", "pipe", "pipe"],
  });

  agentState[agent] = {
    process: child,
    running: true,
    pid: child.pid ?? null,
    startedAt: new Date().toISOString(),
  };

  broadcastStatus(agent);
  addLogLine(agent, `▶ Agent started (PID ${child.pid ?? "unknown"})`, "system");

  // Line-buffer stdout
  let stdoutBuf = "";
  child.stdout!.setEncoding("utf-8");
  child.stdout!.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) addLogLine(agent, line, "stdout");
    }
  });

  // Line-buffer stderr
  let stderrBuf = "";
  child.stderr!.setEncoding("utf-8");
  child.stderr!.on("data", (chunk: string) => {
    stderrBuf += chunk;
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) addLogLine(agent, line, "stderr");
    }
  });

  child.on("close", (code) => {
    // Flush any remaining buffered content
    if (stdoutBuf.trim()) addLogLine(agent, stdoutBuf, "stdout");
    if (stderrBuf.trim()) addLogLine(agent, stderrBuf, "stderr");

    const msg = code === 0
      ? `✅ Agent finished (exit code 0)`
      : `⚠ Agent exited with code ${code ?? "null"}`;
    addLogLine(agent, msg, "system");

    agentState[agent] = { process: null, running: false, pid: null, startedAt: null };
    broadcastStatus(agent);
  });
}

function stopAgentProcess(agent: AgentName): void {
  const state = agentState[agent];
  if (!state.process || !state.running) return;

  addLogLine(agent, "⏹ Stop requested — sending SIGTERM…", "system");
  state.process.kill("SIGTERM");

  // SIGKILL fallback after 5 seconds
  const killTimer = setTimeout(() => {
    if (agentState[agent].running && agentState[agent].process) {
      addLogLine(agent, "Force-killing with SIGKILL…", "system");
      agentState[agent].process!.kill("SIGKILL");
    }
  }, 5_000);

  // Cancel the SIGKILL if the process exits cleanly
  state.process.once("close", () => clearTimeout(killTimer));
}

// ─── Downloads folder helpers ─────────────────────────────────────────────────

function readNupSummary(nup: string): NupSummary {
  const dir = path.join(DOWNLOADS_DIR, nup);
  const manifestPath = path.join(dir, "_manifest.json");
  const analysisPath = path.join(dir, "_analysis.json");

  let especie = "";
  let prazo = "";
  let setor = "";
  let skipped = false;
  let downloadedAt: string | null = null;
  let evidencePageCount = 0;
  let analyzedAt: string | null = null;

  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      especie      = m.especie ?? m.tipoProcesso ?? "";
      prazo        = m.prazo ?? "";
      setor        = m.setor ?? "";
      skipped      = m.skipped === true;
      downloadedAt = m.downloadedAt ?? null;
    } catch { /* ignore corrupt manifests */ }
  }

  if (fs.existsSync(analysisPath)) {
    try {
      const a = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));
      analyzedAt       = a.analyzedAt ?? null;
      evidencePageCount = a.evidencePageCount ?? 0;
    } catch { /* ignore */ }
  }

  let allFiles: string[] = [];
  try { allFiles = fs.readdirSync(dir); } catch { /* ignore */ }

  const pdfFiles = allFiles.filter(
    (f) => f.toLowerCase().endsWith(".pdf") && f !== "EVIDENCE.pdf"
  );

  return {
    nup,
    especie,
    prazo,
    setor,
    fileCount: pdfFiles.length,
    pdfFiles,
    hasEvidence: allFiles.includes("EVIDENCE.pdf"),
    hasVerdict:  allFiles.includes("VERIDICT.md"),
    hasAnalysis: allFiles.includes("_analysis.json"),
    skipped,
    evidencePageCount,
    analyzedAt,
    downloadedAt,
  };
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ─── Agent routes ─────────────────────────────────────────────────────────────

/** GET /api/agents/status — both agents */
app.get("/api/agents/status", (_req, res) => {
  res.json({
    download: {
      running: agentState.download.running,
      pid: agentState.download.pid,
      startedAt: agentState.download.startedAt,
    },
    analysis: {
      running: agentState.analysis.running,
      pid: agentState.analysis.pid,
      startedAt: agentState.analysis.startedAt,
    },
  });
});

/** POST /api/agents/:agent/start */
app.post("/api/agents/:agent/start", (req, res) => {
  const agent = req.params.agent as AgentName;
  if (agent !== "download" && agent !== "analysis") {
    return res.status(400).json({ error: "Unknown agent" });
  }
  if (agentState[agent].running) {
    return res.status(409).json({ error: "Agent is already running" });
  }
  startAgentProcess(agent);
  return res.json({ ok: true, pid: agentState[agent].pid });
});

/** POST /api/agents/:agent/stop */
app.post("/api/agents/:agent/stop", (req, res) => {
  const agent = req.params.agent as AgentName;
  if (agent !== "download" && agent !== "analysis") {
    return res.status(400).json({ error: "Unknown agent" });
  }
  if (!agentState[agent].running) {
    return res.status(409).json({ error: "Agent is not running" });
  }
  stopAgentProcess(agent);
  return res.json({ ok: true });
});

/** POST /api/agents/:agent/restart — stop (if running), clear log buffer, start fresh */
app.post("/api/agents/:agent/restart", (req, res) => {
  const agent = req.params.agent as AgentName;
  if (agent !== "download" && agent !== "analysis") {
    return res.status(400).json({ error: "Unknown agent" });
  }

  const doStart = () => {
    logBuffers[agent] = [];
    startAgentProcess(agent);
  };

  if (agentState[agent].running) {
    addLogLine(agent, "🔄 Restart requested — stopping current process…", "system");
    stopAgentProcess(agent);
    // Wait for the process to exit before starting a new one
    agentState[agent].process!.once("close", () => doStart());
  } else {
    doStart();
  }

  return res.json({ ok: true });
});

/** GET /api/agents/:agent/logs/stream — SSE */
app.get("/api/agents/:agent/logs/stream", (req, res) => {
  const agent = req.params.agent as AgentName;
  if (agent !== "download" && agent !== "analysis") {
    return res.status(400).json({ error: "Unknown agent" });
  }

  res.writeHead(200, {
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    "Connection":        "keep-alive",
    "X-Accel-Buffering": "no",   // disable Nginx buffering
  });
  res.flushHeaders();

  // 1. Immediately send current agent status
  const state = agentState[agent];
  res.write(
    `data: ${JSON.stringify({
      ts: Date.now(),
      type: "status",
      running: state.running,
      pid: state.pid,
      startedAt: state.startedAt,
    })}\n\n`
  );

  // 2. Replay buffered log lines
  for (const entry of logBuffers[agent]) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  // 3. Register this response as a live client
  sseClients[agent].push(res);

  // 4. Heartbeat every 20s to keep the connection alive
  const heartbeat = setInterval(() => {
    try { res.write(": hb\n\n"); }
    catch { clearInterval(heartbeat); }
  }, 20_000);

  // 5. Clean up on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients[agent] = sseClients[agent].filter((r) => r !== res);
  });

  // Prevent Express from ending the response
  return;
});

// ─── Downloads routes ─────────────────────────────────────────────────────────

/** GET /api/downloads — list all NUP folders with metadata */
app.get("/api/downloads", (_req, res) => {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    return res.json([]);
  }
  const entries = fs.readdirSync(DOWNLOADS_DIR);
  const nups: NupSummary[] = entries
    .filter((e) => {
      const ep = path.join(DOWNLOADS_DIR, e);
      try { return fs.statSync(ep).isDirectory(); } catch { return false; }
    })
    .map((nup) => readNupSummary(nup));

  return res.json(nups);
});

/** GET /api/downloads/:nup — list files in a NUP folder */
app.get("/api/downloads/:nup", (req, res) => {
  const nup    = path.basename(req.params.nup);
  const dir    = path.join(DOWNLOADS_DIR, nup);

  if (!dir.startsWith(DOWNLOADS_DIR + path.sep)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: "NUP not found" });
  }

  const files = fs.readdirSync(dir).map((filename) => {
    const fp = path.join(dir, filename);
    let size = 0;
    try { size = fs.statSync(fp).size; } catch { /* ignore */ }
    return { filename, size };
  });

  return res.json({ nup, files, summary: readNupSummary(nup) });
});

/** GET /api/downloads/:nup/:filename — serve a file */
app.get("/api/downloads/:nup/:filename", (req, res) => {
  const nup      = path.basename(req.params.nup);
  const filename = path.basename(req.params.filename);
  const filePath = path.join(DOWNLOADS_DIR, nup, filename);

  // Path traversal guard
  if (!filePath.startsWith(DOWNLOADS_DIR + path.sep)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  // Set MIME type explicitly for common types
  if (filename.endsWith(".pdf")) {
    res.contentType("application/pdf");
  } else if (filename.endsWith(".json")) {
    res.contentType("application/json");
  } else if (filename.endsWith(".md")) {
    res.contentType("text/plain; charset=utf-8");
  }

  return res.sendFile(filePath);
});

// ─── Config routes ────────────────────────────────────────────────────────────

/** GET /api/config — current model + list of available Claude models */
app.get("/api/config", async (_req, res) => {
  try {
    const page = await anthropic.models.list({ limit: 100 });
    const availableModels = page.data
      .filter((m) => m.id.startsWith("claude-"))
      .map((m) => ({ id: m.id, displayName: m.display_name ?? m.id }));
    return res.json({ model: activeModel, availableModels });
  } catch (err) {
    // Fall back to just returning the current model if API is unreachable
    return res.json({ model: activeModel, availableModels: [{ id: activeModel, displayName: activeModel }] });
  }
});

/** POST /api/config — set active model */
app.post("/api/config", async (req, res) => {
  const { model } = req.body as { model?: string };
  if (!model || typeof model !== "string") {
    return res.status(400).json({ error: "model is required" });
  }
  if (agentState.download.running || agentState.analysis.running) {
    return res.status(409).json({ error: "Cannot change model while an agent is running" });
  }
  // Validate against live model list
  try {
    const page = await anthropic.models.list({ limit: 100 });
    const valid = page.data.some((m) => m.id === model);
    if (!valid) {
      return res.status(400).json({ error: `Unknown model: ${model}` });
    }
  } catch {
    // If API is unreachable, allow any claude- prefixed model
    if (!model.startsWith("claude-")) {
      return res.status(400).json({ error: "Model must start with 'claude-'" });
    }
  }
  activeModel = model;
  return res.json({ ok: true, model: activeModel });
});

// ─── Cleanup route ────────────────────────────────────────────────────────────

/** POST /api/downloads/cleanup — delete NUP folders not in the current index.json */
app.post("/api/downloads/cleanup", (_req, res) => {
  if (agentState.download.running || agentState.analysis.running) {
    return res.status(409).json({ error: "Cannot clean up while an agent is running" });
  }

  const indexPath = path.join(DOWNLOADS_DIR, "index.json");
  if (!fs.existsSync(indexPath)) {
    return res.status(400).json({ error: "index.json not found — run the download agent first" });
  }

  let currentNups: Set<string>;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as Array<{ nup: string }>;
    currentNups = new Set(index.map((t) => t.nup));
  } catch {
    return res.status(500).json({ error: "Failed to parse index.json" });
  }

  const deleted: string[] = [];
  let kept = 0;

  const entries = fs.existsSync(DOWNLOADS_DIR) ? fs.readdirSync(DOWNLOADS_DIR) : [];
  for (const entry of entries) {
    const dirPath = path.join(DOWNLOADS_DIR, entry);
    // Only delete subdirectories, not files like index.json
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
    } catch { continue; }

    // Path traversal guard
    if (!dirPath.startsWith(DOWNLOADS_DIR + path.sep)) continue;

    if (currentNups.has(entry)) {
      kept++;
    } else {
      fs.rmSync(dirPath, { recursive: true, force: true });
      deleted.push(entry);
    }
  }

  return res.json({ ok: true, deleted, kept });
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  ◈ LuAI Dashboard  →  http://localhost:${PORT}\n`);
});
