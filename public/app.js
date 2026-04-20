/**
 * LuAI Dashboard — Frontend Application
 *
 * Vanilla JS SPA. No build step, no framework, no CDN dependencies.
 * All state lives in the `State` object. UI is updated by targeted
 * DOM mutations triggered by state changes.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

const State = {
  activeTab: 'dashboard',
  agents: {
    download: { running: false, pid: null, startedAt: null },
    analysis: { running: false, pid: null, startedAt: null },
  },
  /** Uptime interval handles */
  uptimeTimers: { download: null, analysis: null },
  /** SSE EventSource instances */
  eventSources: { download: null, analysis: null },
  /** NUP list */
  nups: [],
  nupsFiltered: [],
  nupsLoaded: false,
  selectedNup: null,
  selectedFiles: [],
  activeFile: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour12: false });
}

function fmtUptime(startedAt) {
  if (!startedAt) return '';
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const s    = secs % 60;
  if (mins < 60) return `${mins}m ${s}s`;
  const hrs = Math.floor(mins / 60);
  const m   = mins % 60;
  return `${hrs}h ${m}m`;
}

function fileIcon(filename) {
  if (filename.endsWith('.pdf'))  return '📄';
  if (filename.endsWith('.md'))   return '📝';
  if (filename.endsWith('.json')) return '{}';
  return '📁';
}

function fileChipClass(filename) {
  if (filename.endsWith('.pdf'))  return 'file-chip--pdf';
  if (filename.endsWith('.md'))   return 'file-chip--md';
  if (filename.endsWith('.json')) return 'file-chip--json';
  return '';
}

function fmtDate(isoStr) {
  if (!isoStr) return '';
  // Accepts "2026-03-18T23:59:59" or "2026-03-18" → "18/03/2026"
  const m = isoStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return isoStr;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

function switchTab(tabName) {
  State.activeTab = tabName;

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('tab-btn--active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const isActive = panel.id === `tab-${tabName}`;
    panel.classList.toggle('tab-panel--active', isActive);
    panel.setAttribute('aria-hidden', String(!isActive));
  });

  if (tabName === 'files' && !State.nupsLoaded) {
    loadNupList();
  }
}

function setupTabNav() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

// ─── Agent card rendering ─────────────────────────────────────────────────────

function renderAgentCard(agent) {
  const info = State.agents[agent];

  const dot    = document.getElementById(`dot-${agent}`);
  const btnStart = document.getElementById(`btn-start-${agent}`);
  const btnStop  = document.getElementById(`btn-stop-${agent}`);
  const uptime   = document.getElementById(`uptime-${agent}`);

  if (info.running) {
    dot.classList.add('status-dot--running');
    dot.title = `Running — PID ${info.pid ?? '?'}`;
    btnStart.disabled = true;
    btnStop.disabled  = false;

    // Start uptime ticker
    if (!State.uptimeTimers[agent]) {
      State.uptimeTimers[agent] = setInterval(() => {
        const el = document.getElementById(`uptime-${agent}`);
        if (el) el.textContent = fmtUptime(State.agents[agent].startedAt);
      }, 1000);
    }
    uptime.textContent = fmtUptime(info.startedAt);
  } else {
    dot.classList.remove('status-dot--running');
    dot.title = 'Idle';
    btnStart.disabled = false;
    btnStop.disabled  = true;

    // Stop uptime ticker
    if (State.uptimeTimers[agent]) {
      clearInterval(State.uptimeTimers[agent]);
      State.uptimeTimers[agent] = null;
    }
    uptime.textContent = '';
  }
}

// ─── Log terminal ─────────────────────────────────────────────────────────────

function appendLogLine(agent, entry) {
  const terminal = document.getElementById(`log-${agent}`);
  if (!terminal) return;

  // Remove the empty-state placeholder if present
  const emptyEl = terminal.querySelector('.log-empty');
  if (emptyEl) emptyEl.remove();

  const line = document.createElement('div');
  line.className = `log-line log-line--${entry.type}`;

  const ts = document.createElement('span');
  ts.className = 'log-ts';
  ts.textContent = fmt(entry.ts);

  const text = document.createElement('span');
  text.textContent = entry.line;

  line.append(ts, text);
  terminal.appendChild(line);

  // Auto-scroll only if user is already near the bottom (within 120px)
  const nearBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 120;
  if (nearBottom) terminal.scrollTop = terminal.scrollHeight;
}

function clearLogs(agent) {
  const terminal = document.getElementById(`log-${agent}`);
  if (!terminal) return;
  terminal.innerHTML = '<div class="log-empty">Logs limpos.</div>';
}

// ─── SSE connection ───────────────────────────────────────────────────────────

function connectSSE(agent) {
  if (State.eventSources[agent]) {
    State.eventSources[agent].close();
  }

  const es = new EventSource(`/api/agents/${agent}/logs/stream`);
  State.eventSources[agent] = es;

  es.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); }
    catch { return; }

    if (msg.type === 'status') {
      const wasRunning = State.agents[agent].running;
      State.agents[agent] = {
        running: msg.running,
        pid: msg.pid,
        startedAt: msg.startedAt,
      };
      renderAgentCard(agent);
      // Auto-refresh stats when agent finishes
      if (wasRunning && !msg.running) {
        preloadStats();
        if (State.nupsLoaded) loadNupList();
      }
      return;
    }

    // Regular log line
    appendLogLine(agent, msg);
  };

  es.onerror = () => {
    // EventSource auto-reconnects; just show a note once if not running
    // (silence errors to avoid flooding if server is restarting)
  };
}

// ─── Agent control ────────────────────────────────────────────────────────────

async function startAgent(agent) {
  const res  = await fetch(`/api/agents/${agent}/start`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    appendLogLine(agent, {
      ts: Date.now(),
      line: `❌ Não foi possível iniciar: ${err.error}`,
      type: 'system',
    });
  }
}

async function stopAgent(agent) {
  const res = await fetch(`/api/agents/${agent}/stop`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    appendLogLine(agent, {
      ts: Date.now(),
      line: `❌ Não foi possível parar: ${err.error}`,
      type: 'system',
    });
  }
}

// ─── Stats bar ────────────────────────────────────────────────────────────────

function updateStats(nups) {
  const total    = nups.length;
  const analysed = nups.filter((n) => n.hasAnalysis).length;
  const evidence = nups.filter((n) => n.hasEvidence).length;
  const verdict  = nups.filter((n) => n.hasVerdict).length;

  document.getElementById('stat-total').textContent    = total;
  document.getElementById('stat-analysed').textContent = analysed;
  document.getElementById('stat-evidence').textContent = evidence;
  document.getElementById('stat-verdict').textContent  = verdict;
}

// ─── NUP list (files tab) ─────────────────────────────────────────────────────

async function loadNupList() {
  State.nupsLoaded = true;
  const listEl = document.getElementById('nup-list');
  listEl.innerHTML = '<div class="empty-state"><div class="spinner" style="margin:0 auto"></div></div>';

  try {
    const res  = await fetch('/api/downloads');
    const nups = await res.json();
    State.nups         = nups;
    State.nupsFiltered = nups;
    updateStats(nups);
    document.getElementById('nup-count').textContent = nups.length;
    renderNupList(nups);
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">Erro ao carregar processos: ${escapeHtml(String(err))}</div>`;
  }
}

function filterNups(query) {
  const q = query.toLowerCase().trim();
  State.nupsFiltered = q
    ? State.nups.filter((n) =>
        n.nup.includes(q) ||
        (n.especie && n.especie.toLowerCase().includes(q)) ||
        (n.prazo && n.prazo.includes(q))
      )
    : State.nups;
  document.getElementById('nup-count').textContent = State.nupsFiltered.length;
  renderNupList(State.nupsFiltered);
}

function renderNupList(nups) {
  const listEl = document.getElementById('nup-list');

  if (!nups || nups.length === 0) {
    listEl.innerHTML = '<div class="empty-state">Nenhum processo encontrado.</div>';
    return;
  }

  listEl.innerHTML = nups.map((n) => {
    const badges = [];
    if (n.fileCount > 0) {
      badges.push(`<span class="badge badge--files">📄 ${n.fileCount} PDF${n.fileCount > 1 ? 's' : ''}</span>`);
    }
    if (n.hasEvidence) {
      const pages = n.evidencePageCount ? ` (${n.evidencePageCount}p)` : '';
      badges.push(`<span class="badge badge--evidence">✓ Evidência${pages}</span>`);
    }
    if (n.hasVerdict) {
      badges.push(`<span class="badge badge--verdict">✦ Parecer</span>`);
    }
    if (n.hasAnalysis && !n.hasEvidence) {
      badges.push(`<span class="badge badge--analysis">◉ Analisado</span>`);
    }
    if (n.skipped) {
      badges.push(`<span class="badge badge--skipped">— Sem docs</span>`);
    }

    const prazoHtml = n.prazo
      ? `<div class="nup-item__prazo">⏱ ${escapeHtml(fmtDate(n.prazo))}</div>`
      : '';

    const selected = State.selectedNup === n.nup ? ' nup-item--selected' : '';

    return `
      <div class="nup-item${selected}" onclick="selectNup('${escapeHtml(n.nup)}')" data-nup="${escapeHtml(n.nup)}">
        <div class="nup-item__nup">${escapeHtml(n.nup)}</div>
        <div class="nup-item__especie">${escapeHtml(n.especie || '(tipo não informado)')}</div>
        <div class="nup-item__badges">${badges.join('')}</div>
        ${prazoHtml}
      </div>
    `;
  }).join('');
}

// ─── File viewer ──────────────────────────────────────────────────────────────

async function selectNup(nup) {
  State.selectedNup  = nup;
  State.activeFile   = null;

  // Highlight in sidebar
  document.querySelectorAll('.nup-item').forEach((el) => {
    el.classList.toggle('nup-item--selected', el.dataset.nup === nup);
  });

  // Show file viewer pane
  document.getElementById('file-viewer-empty').hidden  = true;
  document.getElementById('file-viewer-content').hidden = false;

  // Reset content area
  const contentArea = document.getElementById('file-content-area');
  contentArea.innerHTML = `
    <div class="file-viewer__empty">
      <div class="empty-icon">📄</div>
      <p>Selecione um arquivo acima</p>
    </div>
  `;

  // Load file list
  try {
    const res  = await fetch(`/api/downloads/${encodeURIComponent(nup)}`);
    const data = await res.json();
    State.selectedFiles = data.files || [];
    renderFileChips(nup, data.files || []);
    // Auto-open VERIDICT.md if it exists, otherwise open EVIDENCE.pdf
    const files = data.files || [];
    const autoOpen =
      files.find((f) => f.filename === 'VERIDICT.md') ||
      files.find((f) => f.filename === 'EVIDENCE.pdf') ||
      files.find((f) => f.filename.endsWith('.pdf'));
    if (autoOpen) {
      openFile(nup, autoOpen.filename);
    }
  } catch (err) {
    document.getElementById('file-chips').innerHTML =
      `<span style="color:var(--red);font-size:12px">Erro: ${escapeHtml(String(err))}</span>`;
  }
}

function renderFileChips(nup, files) {
  const chipsEl = document.getElementById('file-chips');

  // Priority ordering: PDFs first, then VERIDICT.md, then others
  const ordered = [...files].sort((a, b) => {
    const priority = (f) => {
      if (f.filename === 'VERIDICT.md') return 0;
      if (f.filename === 'EVIDENCE.pdf') return 1;
      if (f.filename.endsWith('.pdf')) return 2;
      if (f.filename.endsWith('.json')) return 4;
      return 3;
    };
    return priority(a) - priority(b);
  });

  chipsEl.innerHTML = ordered.map((f) => {
    const icon  = fileIcon(f.filename);
    const cls   = fileChipClass(f.filename);
    const size  = f.size ? ` · ${fmtBytes(f.size)}` : '';
    const title = `${f.filename}${size}`;
    return `
      <button
        class="file-chip ${cls}"
        onclick="openFile('${escapeHtml(nup)}', '${escapeHtml(f.filename)}')"
        data-filename="${escapeHtml(f.filename)}"
        title="${escapeHtml(title)}"
      >${icon} ${escapeHtml(f.filename)}</button>
    `;
  }).join('');
}

async function openFile(nup, filename) {
  State.activeFile = filename;

  // Highlight active chip
  document.querySelectorAll('.file-chip').forEach((el) => {
    el.classList.toggle('file-chip--active', el.dataset.filename === filename);
  });

  const contentArea = document.getElementById('file-content-area');
  const url = `/api/downloads/${encodeURIComponent(nup)}/${encodeURIComponent(filename)}`;

  // Show loading
  contentArea.innerHTML = `
    <div class="file-viewer__empty">
      <div class="spinner"></div>
      <p>Carregando…</p>
    </div>
  `;

  if (filename.endsWith('.pdf')) {
    // Native browser PDF viewer via iframe
    contentArea.innerHTML = `
      <iframe
        src="${url}"
        class="pdf-iframe"
        title="${escapeHtml(filename)}"
      ></iframe>
    `;

  } else if (filename.endsWith('.md')) {
    // Fetch markdown and render with marked.js
    try {
      const text = await fetch(url).then((r) => r.text());
      const html = (typeof marked !== 'undefined')
        ? marked.parse(text)
        : `<pre>${escapeHtml(text)}</pre>`;

      contentArea.innerHTML = `
        <div class="markdown-wrapper">
          <div class="markdown-body">${html}</div>
        </div>
      `;
    } catch (err) {
      contentArea.innerHTML = `<div class="file-viewer__empty" style="color:var(--red)">Erro: ${escapeHtml(String(err))}</div>`;
    }

  } else if (filename.endsWith('.json')) {
    // Fetch and pretty-print JSON
    try {
      const json = await fetch(url).then((r) => r.json());
      contentArea.innerHTML = `
        <pre class="json-viewer">${escapeHtml(JSON.stringify(json, null, 2))}</pre>
      `;
    } catch (err) {
      contentArea.innerHTML = `<div class="file-viewer__empty" style="color:var(--red)">Erro: ${escapeHtml(String(err))}</div>`;
    }

  } else {
    contentArea.innerHTML = `
      <div class="file-viewer__empty">
        <div class="empty-icon">📁</div>
        <p>Tipo de arquivo não suportado para visualização.</p>
        <a href="${url}" download="${escapeHtml(filename)}" class="btn btn--primary" style="margin-top:12px">⬇ Baixar</a>
      </div>
    `;
  }
}

// ─── Model selector ───────────────────────────────────────────────────────────

async function loadModelConfig() {
  try {
    const res  = await fetch('/api/config');
    const data = await res.json();
    const sel  = document.getElementById('model-select');
    sel.innerHTML = data.availableModels
      .map((m) => `<option value="${escapeHtml(m.id)}"${m.id === data.model ? ' selected' : ''}>${escapeHtml(m.displayName)}</option>`)
      .join('');
  } catch {
    // non-critical — leave placeholder
  }
}

async function setModel(model) {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    appendLogLine('analysis', { ts: Date.now(), line: `❌ Modelo não alterado: ${err.error}`, type: 'system' });
    // Revert selector to current model
    loadModelConfig();
  }
}

// ─── Cleanup old runs ─────────────────────────────────────────────────────────

async function cleanupOldRuns() {
  const res = await fetch('/api/downloads/cleanup', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendLogLine('download', { ts: Date.now(), line: `❌ Limpeza falhou: ${data.error ?? res.statusText}`, type: 'system' });
    return;
  }
  const msg = data.deleted.length > 0
    ? `🗑 Limpeza concluída: ${data.deleted.length} NUP(s) removido(s), ${data.kept} mantido(s). Removidos: ${data.deleted.join(', ')}`
    : `🗑 Nenhum NUP antigo encontrado (${data.kept} NUP(s) ativos mantidos).`;
  appendLogLine('download', { ts: Date.now(), line: msg, type: 'system' });
  // Refresh stats and NUP list
  preloadStats();
  if (State.nupsLoaded) loadNupList();
}

// ─── Initial status fetch ─────────────────────────────────────────────────────

async function loadInitialStatus() {
  try {
    const res  = await fetch('/api/agents/status');
    const data = await res.json();
    for (const agent of ['download', 'analysis']) {
      State.agents[agent] = data[agent];
      renderAgentCard(agent);
    }
  } catch {
    // Server might not be up yet — SSE will update state when connected
  }
}

// Preload stats for the dashboard without requiring a tab switch
async function preloadStats() {
  try {
    const res  = await fetch('/api/downloads');
    const nups = await res.json();
    State.nups = nups;
    updateStats(nups);
  } catch {
    // non-critical
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setupTabNav();

  loadInitialStatus();
  preloadStats();
  loadModelConfig();

  // Connect SSE for both agents so logs stream from the moment the page loads
  connectSSE('download');
  connectSSE('analysis');
});
