/**
 * OmniClaw — Paperclip Dashboard Server
 * Real-time agent status, decision engine, heartbeat monitor
 */

// Self-healing: catch any unhandled crash and keep the process alive
process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught exception — server self-healing:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] Unhandled promise rejection — server self-healing:', reason?.message || reason);
});

// Load .env — try multiple locations so it works regardless of where server is launched from
// ENV_PATH is the single source of truth used by ALL read/write operations on .env
let ENV_PATH = null;
(function loadEnv() {
  const dotenv = require('dotenv');
  const p = require('path');
  const fs = require('fs');
  const candidates = [
    p.join(__dirname, '..', '.env'),          // standard: omniclaw-bootstrap/.env
    p.join(__dirname, '.env'),                 // inside dashboard/
    p.join(process.cwd(), '.env'),             // wherever node was launched from
    p.join(process.cwd(), '..', '.env'),       // one up from cwd
  ];
  for (const loc of candidates) {
    if (fs.existsSync(loc)) {
      dotenv.config({ path: loc });
      ENV_PATH = loc;
      console.log(`[ENV] Loaded .env from: ${loc}`);
      return;
    }
  }
  // No file found — default to standard path so Settings can create it
  ENV_PATH = candidates[0];
  console.warn('[ENV] ⚠ No .env file found. Checked:');
  candidates.forEach(c => console.warn(`       ${c}`));
  console.warn(`[ENV]   Settings saves will create: ${ENV_PATH}`);
})();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const yaml = require('js-yaml');

// =============================================================================
// LIVE CONFIG RESOLVER — never fail silently on missing integration config
// Checks: process.env → live .env re-read → macOS Keychain → init-company.yaml
// Call resolveConfig('KEY', 'ALIAS1', ...) anywhere instead of process.env.KEY
// =============================================================================
function keychainGet(key) {
  // macOS only — reads from Keychain via security CLI
  if (process.platform !== 'darwin') return null;
  try {
    const { execSync } = require('child_process');
    const val = execSync(`security find-generic-password -a omniclaw -s "${key}" -w 2>/dev/null`, { timeout: 2000, encoding: 'utf8' }).trim();
    return val || null;
  } catch(_) { return null; }
}

function resolveConfig(...keys) {
  // 1. process.env — fastest; covers hot-reloads via /api/settings/save
  for (const k of keys) {
    if (process.env[k] && process.env[k].trim()) return process.env[k].trim();
  }
  // 2. Re-read .env from disk — catches values set before server start that didn't load
  if (ENV_PATH && fs.existsSync(ENV_PATH)) {
    try {
      const envMap = {};
      for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 0 || line.trim().startsWith('#')) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).replace(/\\"/g, '"');
        if (k && v) envMap[k] = v;
      }
      for (const k of keys) {
        if (envMap[k]) { process.env[k] = envMap[k]; return envMap[k]; }
      }
    } catch(_) {}
  }
  // 3. macOS Keychain — populated by keys.sh save or configure.html setup script
  for (const k of keys) {
    const val = keychainGet(k);
    if (val) { process.env[k] = val; return val; } // hot-load into process.env for next call
  }
  // 4. configs/init-company.yaml — fallback if configure.html wrote real values there
  try {
    const yamlPath = path.join(__dirname, '..', 'configs', 'init-company.yaml');
    if (fs.existsSync(yamlPath)) {
      const cfg = yaml.load(fs.readFileSync(yamlPath, 'utf8')) || {};
      const bridges = cfg.integrations?.communication_bridges || [];
      const yamlLookup = {
        VAULT_PATH:         cfg.integrations?.knowledge_base?.path,
        OBSIDIAN_VAULT_PATH:cfg.integrations?.knowledge_base?.path,
        TG_TOKEN:           bridges.find(b => b.type === 'telegram')?.token,
        DISCORD_TOKEN:      bridges.find(b => b.type === 'discord')?.token,
        FIRECRAWL_API_KEY:  cfg.integrations?.web_intelligence?.api_key,
        SUPABASE_URL:       cfg.integrations?.persistent_memory?.url,
        SUPABASE_KEY:       cfg.integrations?.persistent_memory?.key,
        VOICEBOX_API_KEY:   cfg.integrations?.voice_comms?.api_key,
        COMPANY_NAME:       cfg.company_name,
        OWNER_NAME:         cfg.owner,
      };
      for (const k of keys) {
        const v = yamlLookup[k];
        if (v && !String(v).includes('${')) { process.env[k] = v; return String(v); }
      }
    }
  } catch(_) {}
  return null;
}

// Build a human-readable summary of all configured integrations with real values.
// Injected into every agent system prompt so agents never ask "what's the vault path?"
function getIntegrationSummary() {
  const vault   = resolveConfig('OBSIDIAN_VAULT_PATH', 'VAULT_PATH');
  const memDir  = path.join(__dirname, '..', 'memory');
  const email   = resolveConfig('GMAIL_ADDRESS');
  const tgToken = resolveConfig('TG_TOKEN');
  const tgChat  = resolveConfig('TG_CHAT_ID');
  const slack   = resolveConfig('SLACK_BOT_TOKEN');
  const notion  = resolveConfig('NOTION_TOKEN');
  const stripe  = resolveConfig('STRIPE_SECRET_KEY');
  const sbUrl   = resolveConfig('SUPABASE_URL');
  const brave   = resolveConfig('BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY');
  const ghToken = resolveConfig('GITHUB_TOKEN');
  const ghUser  = resolveConfig('GITHUB_USER');
  const ghRepo  = resolveConfig('GITHUB_REPO');
  const openai  = resolveConfig('OPENAI_API_KEY');
  const groq    = resolveConfig('GROQ_API_KEY');
  const anthropic = resolveConfig('ANTHROPIC_API_KEY');

  const lines = [
    `Memory dir: ${memDir}  →  [[ACTION:memory_write|file.md|content]]  [[ACTION:memory_read|file.md]]`,
  ];
  if (vault)   lines.push(`Obsidian vault: ${vault}  →  [[ACTION:obsidian_write|Title|Content]]  [[ACTION:obsidian_append|Title|More]]`);
  if (email)   lines.push(`Gmail: ${email}  →  [[ACTION:send_email|to@example.com|Subject|Body]]`);
  if (tgToken) lines.push(`Telegram: configured${tgChat ? ` (TG_CHAT_ID=${tgChat})` : ' (TG_CHAT_ID not set — cannot send proactively)'}  →  [[ACTION:telegram_send|Message]]`);
  if (slack)   lines.push(`Slack: configured  →  [[ACTION:slack_send|#channel|Message]]`);
  if (notion)  lines.push(`Notion: configured  →  [[ACTION:notion_create|Title|Content]]`);
  if (stripe)  lines.push(`Stripe: configured  →  [[ACTION:stripe_revenue]]  [[ACTION:stripe_create_invoice|email|cents|desc]]`);
  if (sbUrl)   lines.push(`Supabase: ${sbUrl}  →  [[ACTION:supabase_query|table|filter]]  [[ACTION:supabase_insert|table|data]]`);
  if (brave)   lines.push(`Web search (Brave): configured  →  [[ACTION:web_search|query]]`);
  if (ghToken) lines.push(`GitHub: ${ghUser || '?'}/${ghRepo || '?'}  →  [[ACTION:github_push|msg]]  [[ACTION:github_create_issue|title|body]]`);
  if (openai)  lines.push(`OpenAI: configured (GPT + Whisper TTS)`);
  if (groq)    lines.push(`Groq: configured (fast inference + Whisper)`);
  if (anthropic) lines.push(`Anthropic Claude: configured`);
  if (!vault && !email && !tgToken && !slack && !sbUrl) lines.push('⚠ No integrations configured yet — add keys via Settings panel.');

  return `CONFIGURED INTEGRATIONS & PATHS (use these directly — do not ask the user for paths you already have):\n${lines.join('\n')}`;
}

// Optional integrations — loaded only if keys are present
let nodemailer, SlackWebClient, NotionClient, google, stripe;
try { nodemailer = require('nodemailer'); } catch(_) {}
try { const s = require('@slack/web-api'); SlackWebClient = s.WebClient; } catch(_) {}
try { const n = require('@notionhq/client'); NotionClient = n.Client; } catch(_) {}
try { google = require('googleapis').google; } catch(_) {}
try { stripe = require('stripe'); } catch(_) {}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.DASHBOARD_PORT || 3001;

// =============================================================================
// ERROR LOG — tracked in memory, exposed via /api/errors
// =============================================================================
const errorLog = [];
let errorIdCounter = 1;
function logError(context, message, { suggestion = '', fixable = false } = {}) {
  const entry = { id: String(errorIdCounter++), context, message, suggestion, fixable, time: new Date().toISOString(), resolved: false };
  errorLog.unshift(entry);
  if (errorLog.length > 100) errorLog.pop(); // keep last 100
  console.error(`[ERROR] [${context}] ${message}`);
  return entry;
}
function resolveError(id) {
  const e = errorLog.find(e => e.id === id);
  if (e) e.resolved = true;
}
const ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents', 'csuite');
const CONFIGS_DIR = path.join(ROOT, 'configs');
const MEMORY_DIR = path.join(ROOT, 'memory');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =============================================================================
// STATE
// =============================================================================
const state = {
  company: process.env.COMPANY_NAME || 'OmniGen_Systems',
  owner: process.env.OWNER_NAME || 'Felix',
  heartbeat: process.env.HEARTBEAT_INTERVAL || '15m',
  budget: process.env.BUDGET_LIMIT || '$50/mo',
  agents: {},
  decisions: [],
  heartbeats: [],
  githubStatus: { connected: false, repo: null, lastPush: null },
  startTime: new Date().toISOString(),
};

// Load org chart
function loadOrgChart() {
  const chartPath = path.join(CONFIGS_DIR, 'org-chart.json');
  if (fs.existsSync(chartPath)) {
    const chart = JSON.parse(fs.readFileSync(chartPath, 'utf8'));
    chart.agents.forEach(a => {
      state.agents[a.id] = {
        ...a,
        lastActive: null,
        taskCount: 0,
        score: 0,
        currentTask: 'Idle',
        decisions: [],
      };
    });
  }
}

// Load decisions log
function loadDecisions() {
  const logPath = path.join(MEMORY_DIR, 'decisions.json');
  if (fs.existsSync(logPath)) {
    state.decisions = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  }
}

// Save decisions log
function saveDecisions() {
  const logPath = path.join(MEMORY_DIR, 'decisions.json');
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(state.decisions, null, 2));
}

// Read agent .md file
function readAgentProfile(agentId) {
  const filePath = path.join(AGENTS_DIR, `${agentId}.md`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  return null;
}

// =============================================================================
// API ROUTES
// =============================================================================

// Company status
app.get('/api/status', (req, res) => {
  res.json({
    company: state.company,
    owner: state.owner,
    heartbeat: state.heartbeat,
    budget: state.budget,
    agentCount: Object.keys(state.agents).length,
    decisionsToday: state.decisions.filter(d =>
      new Date(d.timestamp).toDateString() === new Date().toDateString()
    ).length,
    uptime: Math.floor((Date.now() - new Date(state.startTime).getTime()) / 1000),
    startTime: state.startTime,
  });
});

// Org chart (includes shared skill pool)
app.get('/api/org-chart', (req, res) => {
  const chartPath = path.join(CONFIGS_DIR, 'org-chart.json');
  if (fs.existsSync(chartPath)) return res.json(JSON.parse(fs.readFileSync(chartPath, 'utf8')));
  res.json({ agents: Object.values(state.agents), skill_pool: [] });
});

// Skills — expose SKILL_MANIFEST in UI-friendly format (populated after SKILL_MANIFEST is defined)
app.get('/api/skills', (req, res) => {
  const all = Object.entries(SKILL_MANIFEST).flatMap(([category, items]) =>
    items.map(s => ({ ...s, category }))
  );
  res.json({ skills: all, categories: Object.keys(SKILL_MANIFEST) });
});

// Memory — list files, read, write
app.get('/api/memory/list', (req, res) => {
  const files = fs.readdirSync(MEMORY_DIR).filter(f => !f.startsWith('.'));
  res.json(files.map(f => {
    const fp = path.join(MEMORY_DIR, f);
    const stat = fs.statSync(fp);
    return { name: f, size: stat.size, modified: stat.mtime };
  }));
});

app.get('/api/memory/:file', (req, res) => {
  const safe = req.params.file.replace(/[/\\]/g, '');
  const fp = path.join(MEMORY_DIR, safe);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.json({ name: safe, content: fs.readFileSync(fp, 'utf8') });
});

app.post('/api/memory/:file', (req, res) => {
  const safe = req.params.file.replace(/[/\\]/g, '');
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content required' });
  fs.writeFileSync(path.join(MEMORY_DIR, safe), content, 'utf8');
  res.json({ success: true, name: safe });
});

// Browser launcher — opens a URL in the user's real browser (Chrome, Brave, Safari)
app.get('/api/browser/open', (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'valid url required' });
  const { execSync } = require('child_process');
  const OS = process.platform;
  const browsers = [
    'Google Chrome', 'Brave Browser', 'Firefox', 'Safari'
  ];
  try {
    if (OS === 'darwin') {
      // Try each browser in order, fall back to default open
      let opened = false;
      for (const b of browsers) {
        try {
          execSync(`open -a "${b}" "${url}" 2>/dev/null`, { timeout: 5000 });
          opened = true;
          res.json({ success: true, browser: b, url });
          break;
        } catch (_) {}
      }
      if (!opened) {
        execSync(`open "${url}"`, { timeout: 5000 });
        res.json({ success: true, browser: 'default', url });
      }
    } else if (OS === 'linux') {
      execSync(`xdg-open "${url}"`, { timeout: 5000 });
      res.json({ success: true, browser: 'system default', url });
    } else {
      execSync(`start "${url}"`, { timeout: 5000 });
      res.json({ success: true, browser: 'system default', url });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Error log endpoints
app.get('/api/errors', (req, res) => res.json({ errors: errorLog }));
app.post('/api/errors/fix', async (req, res) => {
  const { id } = req.body;
  const entry = errorLog.find(e => e.id === id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  // Basic auto-fix: restart suggestion, reload env, clear cooldowns
  entry.resolved = true;
  if (entry.context === 'callAI') {
    Object.keys(providerCooldown).forEach(k => delete providerCooldown[k]);
    res.json({ message: 'All AI provider cooldowns cleared. Try again now.' });
  } else {
    res.json({ message: `Marked as resolved. Check Settings → AI Models or Integrations for manual steps.` });
  }
});

// Debug — localhost only, shows env load state and which keys are present
app.get('/api/debug/env', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  if (!ip.includes('127.0.0.1') && !ip.includes('::1') && !ip.includes('localhost')) {
    return res.status(403).json({ error: 'localhost only' });
  }
  const envPath = ENV_PATH;

  const KEY_GROUPS = {
    'AI Models': ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GROQ_API_KEY','GOOGLE_AI_API_KEY','OPENROUTER_API_KEY','MODEL_CHAIN_1','MODEL_CHAIN_2','MODEL_CHAIN_3'],
    'Communication': ['TG_TOKEN','TG_CHAT_ID','DISCORD_TOKEN','SLACK_BOT_TOKEN'],
    'Email/Google': ['GMAIL_ADDRESS','GMAIL_APP_PASSWORD','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'],
    'Data': ['SUPABASE_URL','SUPABASE_KEY','SUPABASE_ANON_KEY','GITHUB_TOKEN','GITHUB_REPO'],
    'Search': ['BRAVE_API_KEY','PERPLEXITY_API_KEY','TAVILY_API_KEY','SERPAPI_KEY'],
    'Company': ['COMPANY_NAME','OWNER_NAME','DASHBOARD_PORT'],
  };
  const status = {};
  for (const [group, keys] of Object.entries(KEY_GROUPS)) {
    status[group] = {};
    for (const k of keys) {
      const v = process.env[k];
      status[group][k] = v ? `SET (${v.slice(0,4)}••••)` : 'NOT SET';
    }
  }
  res.json({ envFile: envPath || 'NOT FOUND', keysLoaded: Object.keys(process.env).filter(k => !k.startsWith('npm_')).length, status });
});

// Settings — read/write .env (always use ENV_PATH — the file actually loaded at startup)
app.get('/api/settings', (req, res) => {
  const envPath = ENV_PATH;
  if (!fs.existsSync(envPath)) return res.json({ settings: [] });
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const settings = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { settings.push({ type: 'comment', line }); continue; }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) { settings.push({ type: 'comment', line }); continue; }
    const key = trimmed.slice(0, eqIdx).trim();
    // Strip surrounding quotes added by save endpoint (or configure.html)
    let value = trimmed.slice(eqIdx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    settings.push({ type: 'env', key, value, line });
  }
  res.json({ settings });
});

app.post('/api/settings/save', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  const envPath = ENV_PATH;  // always write to the file we actually loaded
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = content.split('\n');
  // Quote the value so special chars (=, spaces, #) are handled correctly
  const safeVal = `"${String(value).replace(/"/g, '\\"')}"`;
  const newLine = `${key}=${safeVal}`;
  const idx = lines.findIndex(l => { const e = l.indexOf('='); return e > 0 && l.slice(0, e).trim() === key; });
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
  // Hot-reload into current process
  process.env[key] = value;
  console.log(`[SETTINGS] ${key} saved to ${envPath}`);
  res.json({ success: true, message: `${key} saved to ${envPath}` });
});

// All agents
app.get('/api/agents', (req, res) => {
  res.json(Object.values(state.agents));
});

// Single agent
app.get('/api/agents/:id', (req, res) => {
  const agent = state.agents[req.params.id.toUpperCase()];
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const profile = readAgentProfile(req.params.id.toUpperCase());
  res.json({ ...agent, profile });
});

// Decisions
app.get('/api/decisions', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(state.decisions.slice(-limit).reverse());
});

// Submit a decision for C-Suite processing
app.post('/api/decisions', (req, res) => {
  const { objective, timeHorizon, capitalInvolved, riskTolerance, reversibility, type } = req.body;
  if (!objective) return res.status(400).json({ error: 'objective is required' });

  const decision = {
    id: `DEC-${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: type || 'strategic',
    objective,
    timeHorizon: timeHorizon || 'Q',
    capitalInvolved: capitalInvolved || 'Unknown',
    riskTolerance: riskTolerance || 'medium',
    reversibility: reversibility || 'reversible',
    status: 'processing',
    agentInputs: {},
    ceoDecision: null,
  };

  state.decisions.push(decision);
  saveDecisions();

  // Simulate processing (in production, this calls Claude API per agent)
  setTimeout(() => {
    decision.status = 'complete';
    decision.ceoDecision = {
      statement: `Decision on: ${objective}`,
      rationale: 'Based on full C-Suite committee review.',
      nextSteps: ['Execute phase 1', 'Review in 30 days'],
      risks: ['Execution risk', 'Market timing'],
      timestamp: new Date().toISOString(),
    };
    saveDecisions();
    // Mirror decision to Notion and Google Sheets if configured
    logToNotion(decision).catch(() => {});
    logToSheets([decision.id, decision.timestamp, decision.objective, decision.status, decision.type]).catch(() => {});
    io.emit('decision:update', decision);
    // Update agent activity
    Object.keys(state.agents).forEach(id => {
      state.agents[id].lastActive = new Date().toISOString();
      state.agents[id].taskCount += 1;
    });
    io.emit('agents:update', Object.values(state.agents));
  }, 2000);

  io.emit('decision:new', decision);
  res.json(decision);
});

// Heartbeats log
app.get('/api/heartbeats', (req, res) => {
  res.json(state.heartbeats.slice(-50).reverse());
});

// GitHub status
app.get('/api/github', (req, res) => {
  res.json({
    ...state.githubStatus,
    user: process.env.GITHUB_USER,
    repo: process.env.GITHUB_REPO,
  });
});

// Trigger GitHub push (creates repo + pushes if configured)
app.post('/api/github/push', async (req, res) => {
  const { exec } = require('child_process');
  exec(`cd "${ROOT}" && git add -A && git commit -m "OmniClaw auto-push $(date -u +%Y-%m-%dT%H:%M:%SZ)" && git push origin main 2>&1`,
    (err, stdout, stderr) => {
      if (err) {
        state.githubStatus.connected = false;
        return res.json({ success: false, output: stderr || err.message });
      }
      state.githubStatus.connected = true;
      state.githubStatus.lastPush = new Date().toISOString();
      io.emit('github:update', state.githubStatus);
      res.json({ success: true, output: stdout });
    }
  );
});

// Agent profile markdown
app.get('/api/agents/:id/profile', (req, res) => {
  const profile = readAgentProfile(req.params.id.toUpperCase());
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json({ id: req.params.id.toUpperCase(), profile });
});

// SOUL.md and HEARTBEATS.md
app.get('/api/memory/:file', (req, res) => {
  const allowed = ['SOUL.md', 'HEARTBEATS.md'];
  if (!allowed.includes(req.params.file)) return res.status(403).json({ error: 'Forbidden' });
  const filePath = path.join(MEMORY_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  // Substitute shell-style ${VAR} placeholders so SOUL.md reflects actual config
  let content = fs.readFileSync(filePath, 'utf8');
  content = content
    .replace(/\$\{COMPANY_NAME\}/g, state.company || process.env.COMPANY_NAME || '')
    .replace(/\$\{OWNER_NAME\}/g,  state.owner   || process.env.OWNER_NAME   || '')
    .replace(/\$\{MISSION\}/g,     process.env.MISSION    || '')
    .replace(/\$\{VAULT_PATH\}/g,  resolveConfig('OBSIDIAN_VAULT_PATH', 'VAULT_PATH') || '');
  res.json({ content });
});

// =============================================================================
// HEARTBEAT CRON
// =============================================================================
const HEARTBEAT_MAP = { '5m': '*/5 * * * *', '15m': '*/15 * * * *', '30m': '*/30 * * * *', '1h': '0 * * * *' };
const cronExpr = HEARTBEAT_MAP[process.env.HEARTBEAT_INTERVAL] || '*/15 * * * *';

cron.schedule(cronExpr, () => {
  const beat = { timestamp: new Date().toISOString(), agents: Object.keys(state.agents).length, status: 'active' };
  state.heartbeats.push(beat);
  if (state.heartbeats.length > 500) state.heartbeats.shift();
  // Write to HEARTBEATS.md
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.appendFileSync(path.join(MEMORY_DIR, 'HEARTBEATS.md'), `- ${beat.timestamp} | Agents: ${beat.agents} | Status: active\n`);
  io.emit('heartbeat', beat);
  console.log(`[HEARTBEAT] ${beat.timestamp}`);
});

// =============================================================================
// WEBSOCKET
// =============================================================================
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);
  // Send initial state
  socket.emit('init', {
    agents: Object.values(state.agents),
    decisions: state.decisions.slice(-10),
    heartbeats: state.heartbeats.slice(-20),
    github: state.githubStatus,
  });
  socket.on('disconnect', () => console.log(`[WS] Client disconnected: ${socket.id}`));
});

// =============================================================================
// CHAT — routes messages through CEO agent via configured AI provider
// =============================================================================
const axios = require('axios');

const chatHistory = [];

function readOwnerProfile() {
  const p = path.join(MEMORY_DIR, 'OWNER.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function getSystemPrompt() {
  const ceo = state.agents['CEO'];
  const profile = readAgentProfile('CEO') || '';
  const ownerProfile = readOwnerProfile();
  return `You are TommyClaw, the AI CEO of ${state.company}, talking directly with ${state.owner}. You are part of the OmniClaw platform — an autonomous executive AI stack. Your website is tommyclaw.com.

IDENTITY BOUNDARY — critical:
- You are the CEO of ${state.company} ONLY. Your entire context, memory, and decisions are scoped to ${state.company} and OmniClaw.
- The Obsidian vault may contain notes about OTHER projects or platforms (e.g. FELix, or other businesses belonging to ${state.owner}). Treat those as off-limits. Do NOT read, reference, summarise, or act on content that belongs to another platform or project. If a vault search returns content clearly about another platform, discard it and say so.
- If you see references to "FELix", "felix-app", or any platform that is not ${state.company}, ignore them entirely. They are separate products in a separate context.

HONESTY RULES — never break these:
- Never invent domain names, email addresses, credentials, or infrastructure details unless explicitly told them in this conversation.
- If an action fails, report the error message. Don't pretend it succeeded.
- If you don't know something, search for it with [[ACTION:web_search|query]] rather than guessing.
${process.env.GMAIL_ADDRESS ? `- Company email address: ${process.env.GMAIL_ADDRESS} — use this exact address when referring to email. Never use any other address.` : '- No company email configured yet. Do not invent one.'}
- If an integration is NOT listed in your integration summary below, do NOT attempt to use it and do NOT pretend it exists.

${getIntegrationSummary()}

${getAgentRosterContext()}

${AGENT_ACTION_REFERENCE}

MISSION: You work 24/7 with your full team toward three outcomes — (1) the best platform that money can buy: technically excellent, constantly improving, built right; (2) a thriving business: growing revenue, delighted customers, strong metrics; (3) a platform that everyone who touches it absolutely loves: intuitive, reliable, fast. Delegate ruthlessly. Your C-Suite each command their own specialist pool. Trust them to execute. Your job is direction, key decisions, and ensuring nothing slips.

PERSONALITY: Sharp, confident, direct. Talk like a founder — not a corporate bot. Short sentences, plain language, no jargon. Match the energy: casual message = casual reply, strategy question = strategic answer. No bullet lists or formal headers unless the question actually needs it. When asked about your team, list them by name and role — you know exactly who you have. Never say you can't see other agents.

Company: ${state.company} | Owner: ${state.owner}
${ownerProfile ? '\nOwner context:\n' + ownerProfile.slice(0, 800) : ''}
${profile ? '\nYour persona:\n' + profile.slice(0, 400) : ''}`;
}

// Per-provider rate limit cooldowns (429 → skip for 90s)
const providerCooldown = {};
function isOnCooldown(provider) {
  const until = providerCooldown[provider];
  return until && Date.now() < until;
}
function setCooldown(provider, ms = 90000) {
  providerCooldown[provider] = Date.now() + ms;
  console.log(`[CHAT] ${provider} on cooldown for ${ms/1000}s`);
}

async function callAI(messages, systemPromptOverride) {
  const sysPrompt = systemPromptOverride || getSystemPrompt();

  // ── MetaClaw routing (if enabled) ────────────────────────────────────────
  if (resolveConfig('METACLAW_ENABLED') === 'true') {
    const metaHost = resolveConfig('METACLAW_HOST') || 'http://localhost:30000';
    try {
      const sessionId = `omniclaw-${Date.now()}`;
      const r = await axios.post(`${metaHost}/v1/chat/completions`, {
        model: resolveConfig('MODEL_CHAIN_1') || 'auto',
        messages: [{ role: 'system', content: sysPrompt }, ...messages],
        max_tokens: 2048,
      }, {
        headers: { 'X-Session-Id': sessionId, 'X-Turn-Type': 'standard', 'Content-Type': 'application/json' },
        timeout: 45000,
      });
      return r.data.choices[0].message.content;
    } catch (me) {
      console.log(`[MetaClaw] Routing failed (${me.code || me.response?.status || me.message}) — falling through to normal chain`);
    }
  }

  // Build primary chain from MODEL_CHAIN vars
  const chainVars = [process.env.MODEL_CHAIN_1, process.env.MODEL_CHAIN_2, process.env.MODEL_CHAIN_3].filter(Boolean);

  // Auto-detect any configured provider not already in chain as further fallbacks
  const autoFallbacks = [];
  if (!chainVars.some(c => c.startsWith('anthropic')) && process.env.ANTHROPIC_API_KEY)
    autoFallbacks.push('anthropic::claude-haiku-4-5-20251001');
  if (!chainVars.some(c => c.startsWith('openai')) && process.env.OPENAI_API_KEY)
    autoFallbacks.push('openai::gpt-4o-mini');
  if (!chainVars.some(c => c.startsWith('groq')) && process.env.GROQ_API_KEY)
    autoFallbacks.push('groq::llama-3.3-70b-versatile');
  if (!chainVars.some(c => c.startsWith('gemini')) && process.env.GOOGLE_AI_API_KEY)
    autoFallbacks.push('gemini::gemini-2.0-flash-exp');
  if (!chainVars.some(c => c.startsWith('openrouter')) && process.env.OPENROUTER_API_KEY)
    autoFallbacks.push('openrouter::google/gemma-3-12b-it:free');
  // Ollama local always last (no key needed) — try common installed models
  autoFallbacks.push('ollama::qwen3:8b');
  autoFallbacks.push('ollama::gemma3:4b');

  const chain = [...chainVars, ...autoFallbacks];

  for (const slot of chain) {
    const colonIdx = (slot || '').indexOf('::');
    if (colonIdx < 0) continue;
    const provider = slot.slice(0, colonIdx);
    const model = slot.slice(colonIdx + 2);

    // Skip providers on cooldown (rate-limited)
    if (isOnCooldown(provider)) continue;

    try {
      // ── Anthropic Claude ──────────────────────────────────────────
      if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
        const r = await axios.post('https://api.anthropic.com/v1/messages', {
          model: model || 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          system: sysPrompt,
          messages,
        }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 45000 });
        return r.data.content[0].text;
      }

      // ── OpenAI ────────────────────────────────────────────────────
      if (provider === 'openai' && process.env.OPENAI_API_KEY) {
        const r = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: model || 'gpt-4o-mini',
          messages: [{ role: 'system', content: sysPrompt }, ...messages],
          max_tokens: 2048,
        }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, timeout: 45000 });
        return r.data.choices[0].message.content;
      }

      // ── Groq ──────────────────────────────────────────────────────
      if (provider === 'groq' && process.env.GROQ_API_KEY) {
        const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: model || 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: sysPrompt }, ...messages],
          max_tokens: 2048,
        }, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 30000 });
        return r.data.choices[0].message.content;
      }

      // ── Google Gemini ─────────────────────────────────────────────
      if (provider === 'gemini' && process.env.GOOGLE_AI_API_KEY) {
        // Try specified model first, then fallback models
        const geminiModels = [
          model,
          'gemini-2.0-flash-exp',
          'gemini-2.0-flash',
          'gemini-1.5-flash-latest',
          'gemini-1.5-flash',
          'gemini-1.5-pro-latest',
        ].filter(Boolean);
        for (const gm of geminiModels) {
          try {
            const r = await axios.post(
              `https://generativelanguage.googleapis.com/v1beta/models/${gm}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`,
              { contents: [{ parts: [{ text: `${sysPrompt}\n\n${messages.map(m => `${m.role}: ${m.content}`).join('\n')}` }] }] },
              { timeout: 30000 }
            );
            return r.data.candidates[0].content.parts[0].text;
          } catch (ge) {
            if (ge.response?.status === 404) continue; // try next model
            throw ge;
          }
        }
        throw new Error('All Gemini models unavailable');
      }

      // ── OpenRouter ────────────────────────────────────────────────
      if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
        // Try specified model, then fallback free models
        const orModels = [
          model,
          'google/gemma-3-12b-it:free',
          'meta-llama/llama-3.1-8b-instruct:free',
          'mistralai/mistral-7b-instruct:free',
          'qwen/qwen-2.5-7b-instruct:free',
        ].filter(Boolean);
        for (const om of orModels) {
          try {
            const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
              model: om,
              messages: [{ role: 'system', content: sysPrompt }, ...messages],
              max_tokens: 1024,
            }, { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://github.com/FELix-Bond/Omniclaw', 'X-Title': 'OmniClaw' }, timeout: 30000 });
            return r.data.choices[0].message.content;
          } catch (oe) {
            if (oe.response?.status === 404) continue;
            throw oe;
          }
        }
        throw new Error('All OpenRouter models unavailable');
      }

      // ── Ollama (local) ────────────────────────────────────────────
      if (provider === 'ollama') {
        // Query installed models first, then fall back to common names
        let installedOllamaModels = [];
        try {
          const listR = await axios.get('http://localhost:11434/api/tags', { timeout: 3000 });
          installedOllamaModels = (listR.data.models || []).map(m => m.name);
        } catch (_) { /* Ollama not running */ }
        const ollamaModels = [model, ...installedOllamaModels, 'llama3.2', 'llama3.1', 'llama3', 'mistral', 'gemma2'].filter((v, i, a) => v && a.indexOf(v) === i);
        for (const om of ollamaModels) {
          try {
            const r = await axios.post('http://localhost:11434/api/chat', {
              model: om, stream: false,
              messages: [{ role: 'system', content: sysPrompt }, ...messages],
            }, { timeout: 60000 });
            return r.data.message.content;
          } catch (oe) {
            if (oe.code === 'ECONNREFUSED') break; // Ollama not running, skip all
            continue;
          }
        }
        throw new Error('Ollama not available');
      }

    } catch (e) {
      const status = e.response?.status;
      if (status === 429) {
        setCooldown(provider, 90000);
        logError('callAI', `${provider} rate limited (429) — 90s cooldown applied`, { suggestion: `Wait 90 seconds or add a different AI provider key in Settings → AI Models`, fixable: true });
      } else if (status === 401 || status === 403) {
        setCooldown(provider, 3600000);
        logError('callAI', `${provider} API key rejected (${status}) — check your key`, { suggestion: `Go to Settings → AI Models and verify your ${provider.toUpperCase()}_API_KEY`, fixable: false });
      } else {
        console.log(`[CHAT] ${provider}${model?'/'+model:''} failed (${status||e.code||e.message}) — trying next`);
      }
    }
  }
  logError('callAI', 'All AI providers exhausted — no response generated', { suggestion: 'Add at least one AI API key in Settings → AI Models (Groq is free)', fixable: false });
  return '⚠️ All AI providers are unavailable right now (rate limits or missing keys). Check Settings → AI Models or wait 90 seconds for rate limits to clear.';
}

// =============================================================================
// ACTION ENGINE — full capability layer for all agents
// Agents embed [[ACTION:type|arg1|arg2|...]] anywhere in their reply.
// Data-returning actions trigger a synthesis pass so the agent sees results.
//
// FULL ACTION REFERENCE:
// FILES:    obsidian_write|Title|Content  obsidian_append|Title|Content  obsidian_search|#hashtag or keyword
//           memory_write|file.md|Content  memory_read|file.md
//           file_write|path|Content       file_read|path
// WEB:      web_search|query              web_fetch|https://url
// COMMS:    send_email|to|Subject|Body    slack_send|#channel|Message
//           telegram_send|Message
// GOOGLE:   google_doc|Title|Content      calendar_event|Title|start|end|Desc
//           sheets_append|val1,val2
// NOTION:   notion_create|Title|Content
// HUBSPOT:  hubspot_create_contact|email|Name|Company
//           hubspot_create_deal|Name|amount|stage  hubspot_get_deals
// STRIPE:   stripe_create_invoice|email|cents|Desc  stripe_revenue
// GITHUB:   github_push|Commit msg        github_create_issue|Title|Body
// SUPABASE: supabase_query|table|{"k":"v"}  supabase_insert|table|{"k":"v"}
// SHELL:    shell|command
// =============================================================================

// Matches [[ACTION:...]] — uses negative lookahead so content can contain [ or ] individually
const ACTION_RE = /\[\[ACTION:((?:(?!\]\]).)+)\]\]/gs;
const { execSync } = require('child_process');

// ── Web search: cascade through every configured provider ──────────────────
// Uses the same providerCooldown map as callAI — 429/401 → 90s/1hr cooldown
function handleSearchError(provider, e) {
  const status = e.response?.status;
  if (status === 429) { setCooldown(`search_${provider}`, 90000); console.log(`[SEARCH] ${provider} rate-limited — 90s cooldown`); }
  else if (status === 401 || status === 403) { setCooldown(`search_${provider}`, 3600000); console.log(`[SEARCH] ${provider} auth failed — 1hr cooldown`); }
  else { console.log(`[SEARCH] ${provider} failed:`, e.message); }
}

async function webSearch(query) {
  const braveKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY;
  if (braveKey && !isOnCooldown('search_brave')) {
    try {
      const r = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': braveKey },
        params: { q: query, count: 6 }, timeout: 10000,
      });
      const hits = (r.data.web?.results || []).slice(0, 6);
      if (hits.length) return hits.map(h => `**${h.title}**\n${h.url}\n${h.description || ''}`).join('\n\n');
    } catch (e) { handleSearchError('brave', e); }
  }
  if (process.env.PERPLEXITY_API_KEY && !isOnCooldown('search_perplexity')) {
    try {
      const r = await axios.post('https://api.perplexity.ai/chat/completions',
        { model: 'sonar', messages: [{ role: 'user', content: query }] },
        { headers: { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` }, timeout: 20000 });
      return r.data.choices[0].message.content;
    } catch (e) { handleSearchError('perplexity', e); }
  }
  if (process.env.TAVILY_API_KEY && !isOnCooldown('search_tavily')) {
    try {
      const r = await axios.post('https://api.tavily.com/search',
        { api_key: process.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 6 },
        { timeout: 12000 });
      return (r.data.results || []).map(h => `**${h.title}**\n${h.url}\n${h.content}`).join('\n\n');
    } catch (e) { handleSearchError('tavily', e); }
  }
  if (process.env.SERPAPI_KEY && !isOnCooldown('search_serpapi')) {
    try {
      const r = await axios.get('https://serpapi.com/search',
        { params: { q: query, api_key: process.env.SERPAPI_KEY, num: 6, engine: 'google' }, timeout: 10000 });
      return (r.data.organic_results || []).map(h => `**${h.title}**\n${h.link}\n${h.snippet || ''}`).join('\n\n');
    } catch (e) { handleSearchError('serpapi', e); }
  }
  if (process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX && !isOnCooldown('search_google_cse')) {
    try {
      const r = await axios.get('https://www.googleapis.com/customsearch/v1',
        { params: { key: process.env.GOOGLE_CSE_KEY, cx: process.env.GOOGLE_CSE_CX, q: query, num: 6 }, timeout: 10000 });
      return (r.data.items || []).map(i => `**${i.title}**\n${i.link}\n${i.snippet || ''}`).join('\n\n');
    } catch (e) { handleSearchError('google_cse', e); }
  }
  // Free fallback: DuckDuckGo instant answers (no key, no cooldown)
  try {
    const r = await axios.get('https://api.duckduckgo.com/',
      { params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 }, timeout: 8000 });
    const d = r.data;
    const parts = [];
    if (d.AbstractText) parts.push(d.AbstractText);
    (d.RelatedTopics || []).slice(0, 5).forEach(t => { if (t.Text) parts.push(t.Text); });
    if (parts.length) return parts.join('\n\n');
  } catch (e) { console.log('[SEARCH] DDG failed:', e.message); }
  return `No search results — add BRAVE_API_KEY, TAVILY_API_KEY, PERPLEXITY_API_KEY, or SERPAPI_KEY to .env`;
}

// ── Web fetch: clean readable text from any URL ────────────────────────────
async function webFetch(url) {
  try {
    const r = await axios.get(`https://r.jina.ai/${url}`,
      { timeout: 25000, headers: { Accept: 'text/plain', 'X-Return-Format': 'text' } });
    if (r.data && String(r.data).length > 100) return String(r.data).slice(0, 8000);
  } catch (e) { console.log('[FETCH] Jina failed:', e.message); }
  if (process.env.FIRECRAWL_API_KEY) {
    try {
      const r = await axios.post('https://api.firecrawl.dev/v0/scrape', { url },
        { headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` }, timeout: 25000 });
      const c = r.data.data?.markdown || r.data.data?.content || '';
      if (c) return c.slice(0, 8000);
    } catch (e) { console.log('[FETCH] Firecrawl failed:', e.message); }
  }
  try {
    const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 OmniClaw/1.0' } });
    return String(r.data)
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n').slice(0, 6000);
  } catch (e) { return `Failed to fetch ${url}: ${e.message}`; }
}

// ── Shell execution (NemoClaw) ─────────────────────────────────────────────
function shellExec(command) {
  const blocked = [
    'rm -rf /', 'sudo rm -rf', 'mkfs', ':(){:|:&}', 'dd if=/dev/zero', '>/dev/sd',
    '.env',          // agents must NEVER write API keys via shell
    'pip install',   // no arbitrary package installs
    'npm install -g',// no global npm installs
  ];
  if (blocked.some(b => command.includes(b))) return `❌ Blocked: "${command}" is not permitted via shell. Use the Settings panel to manage API keys and configuration.`;
  try {
    return (execSync(command, { timeout: 30000, cwd: ROOT, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }) || '(no output)').slice(0, 4000);
  } catch (e) { return `Exit ${e.status || 1}: ${(e.stderr || e.message || '').slice(0, 2000)}`; }
}

// ── Build live agent roster for system prompts ─────────────────────────────
function getAgentRosterContext() {
  const csuite = Object.entries(AGENT_PERSONAS)
    .filter(([id]) => id !== 'CEO')
    .map(([id, p]) => `  ${p.emoji} ${id} — ${p.name} (${p.role}): [[ACTION:agent_dispatch|${id}|task]]`)
    .join('\n');

  const deployedCustom = Object.values(state.agents)
    .filter(a => a.id && a.id !== 'CEO' && !AGENT_PERSONAS[a.id])
    .map(a => `  🤖 ${a.id} — ${a.name || a.id}: ${a.role || ''} (status: ${a.currentTask || 'Idle'})`)
    .join('\n');

  // OpenClaw 187-agent pool grouped by category
  const ocLines = (SKILL_MANIFEST.openclaw_agents || []).map(cat => {
    const catId = cat.id.replace('openclaw:', '');
    const agentNames = (OPENCLAW_CATEGORY_AGENTS[catId] || '').split(',').map(s => s.trim()).filter(Boolean);
    const preview = agentNames.slice(0, 4).map(n => n.replace(/\s*\([^)]+\)/, '')).join(', ');
    const more = agentNames.length > 4 ? ` +${agentNames.length - 4} more` : '';
    return `  ${cat.id} (${agentNames.length}): ${preview}${more} → [[ACTION:openclaw_dispatch|${catId}|agent-name|task]]`;
  }).join('\n');
  const totalOC = getAgentPool().length;

  // VoltAgent Codex 136+ subagents
  const codexLines = (SKILL_MANIFEST.codex_subagents || []).map(c => {
    const count = c.desc.match(/^(\d+)/)?.[1] || '?';
    const label = c.desc.split('—')[0].trim();
    return `  ${c.id} (${count} agents): ${label} → [[ACTION:codex_dispatch|${c.id}|task]]`;
  }).join('\n');
  const totalCodex = (SKILL_MANIFEST.codex_subagents || []).reduce((s, c) => s + parseInt(c.desc.match(/^(\d+)/)?.[1] || 0), 0);

  // Built-in always-on specialists
  const subCats = {};
  Object.entries(SUBAGENT_DEFINITIONS || {}).forEach(([id, d]) => {
    if (!subCats[d.cat]) subCats[d.cat] = [];
    subCats[d.cat].push(`${d.icon||'•'} ${d.label} (${id})`);
  });
  const subList = Object.entries(subCats).map(([cat, items]) =>
    `  ${cat}: ${items.slice(0, 4).join(', ')}${items.length > 4 ? ` +${items.length-4} more` : ''}`
  ).join('\n');
  const totalSubs = Object.keys(SUBAGENT_DEFINITIONS || {}).length;

  return `YOUR FULL AGENT TEAM — all dispatches are REAL server calls. Use them proactively. You are the orchestrator.

C-SUITE (${Object.keys(AGENT_PERSONAS).length - 1} executives with full dispatch capability):
${csuite}

OPENCLAW SPECIALIST POOL (${totalOC} agents, 23 categories — deploy any on demand):
${ocLines}

VOLTAGENT CODEX POOL (${totalCodex}+ technical specialists, 10 categories):
${codexLines}

BUILT-IN SPECIALISTS (${totalSubs} always-on — [[ACTION:subagent|agent-id|task]]):
${subList}
${deployedCustom ? `\nDEPLOYED CUSTOM AGENTS:\n${deployedCustom}` : ''}
ORCHESTRATION: Delegate to C-Suite for strategic execution. Use pool agents for specialist depth. C-Suite members sub-delegate to their domain specialists autonomously. Your job is direction, decisions, and ensuring outcomes.`;
}

// ── Action reference injected into every agent system prompt ───────────────
const AGENT_ACTION_REFERENCE = `
ACTIONS — you have real execution capabilities. Embed these inline in your reply and the server runs them immediately. Use them proactively — don't describe what you'd do, just DO IT.

FILES:    [[ACTION:obsidian_write|Title|Content]] [[ACTION:obsidian_append|Title|More]] [[ACTION:obsidian_search|#hashtag or keyword]] [[ACTION:memory_write|file.md|Content]] [[ACTION:memory_read|file.md]] [[ACTION:file_write|path|Content]] [[ACTION:file_read|path]]
WEB:      [[ACTION:web_search|your query here]] [[ACTION:web_fetch|https://url.com]]
COMMS:    [[ACTION:send_email|to@email.com|Subject|Body]] [[ACTION:slack_send|#channel|Message]] [[ACTION:telegram_send|Message]]
GOOGLE:   [[ACTION:google_doc|Title|Content]] [[ACTION:calendar_event|Title|2024-01-01T10:00:00|2024-01-01T11:00:00|Description]] [[ACTION:sheets_append|val1,val2,val3]]
NOTION:   [[ACTION:notion_create|Title|Content]]
HUBSPOT:  [[ACTION:hubspot_create_contact|email|Full Name|Company]] [[ACTION:hubspot_create_deal|Name|amount|stage]] [[ACTION:hubspot_get_deals]]
STRIPE:   [[ACTION:stripe_create_invoice|email|amount_cents|Description]] [[ACTION:stripe_revenue]]
GITHUB:   [[ACTION:github_push|Commit message]] [[ACTION:github_create_issue|Title|Body]]
SUPABASE: [[ACTION:supabase_query|table|{"col":"val"}]] [[ACTION:supabase_insert|table|{"col":"val"}]]
SHELL:    [[ACTION:shell|any shell command]]
AGENTS:   [[ACTION:agent_dispatch|CFO|What is our burn rate?]] [[ACTION:agent_dispatch|CTO|Review this]] [[ACTION:subagent|seo-analyst|Audit site]] [[ACTION:agent_broadcast|Message to all agents]] [[ACTION:openclaw_dispatch|marketing|Echo|Write blog post about X]] [[ACTION:openclaw_dispatch|finance|Invoice Manager|Generate invoice for client Y]] [[ACTION:codex_dispatch|codex:quality-security|Security audit this endpoint]] [[ACTION:codex_dispatch|codex:core-dev|Design this API]]
CREATE:   [[ACTION:create_agent|Agent Name|role|System prompt instructions for this agent]]  — creates a new live agent in Paperclip immediately

Chain multiple actions in one reply. Data-returning actions (web_search, web_fetch, shell, hubspot_get_deals, stripe_revenue, supabase_query, memory_read, file_read, agent_dispatch, subagent, agent_broadcast) return results you will see and synthesise into your response.`;

// ── Main action executor ───────────────────────────────────────────────────
async function executeActions(reply, systemPromptForSynthesis) {
  const matches = [...reply.matchAll(ACTION_RE)];
  if (!matches.length) return reply;

  const actionResults = [];

  for (const match of matches) {
    const parts = match[1].split('|').map(s => s.trim());
    const type = parts[0].toLowerCase();
    let label = '', data = '', isData = false;

    try {
      switch (type) {
        // ── Files & Memory ────────────────────────────────────────────
        case 'obsidian_write': {
          const vaultPath = resolveConfig('OBSIDIAN_VAULT_PATH', 'VAULT_PATH');
          if (!vaultPath) { label = '⚠️ Obsidian vault path not configured — add VAULT_PATH to Settings'; break; }
          const safe = (parts[1] || 'Untitled').replace(/[/\\?%*:|"<>]/g, '-');
          fs.mkdirSync(vaultPath, { recursive: true });
          fs.writeFileSync(path.join(vaultPath, `${safe}.md`), `# ${safe}\n\n${parts.slice(2).join('\n')}\n`, 'utf8');
          label = `✅ Written to Obsidian: **${safe}.md**`; break;
        }
        case 'obsidian_append': {
          const vaultPath = resolveConfig('OBSIDIAN_VAULT_PATH', 'VAULT_PATH');
          if (!vaultPath) { label = '⚠️ Obsidian vault path not configured — add VAULT_PATH to Settings'; break; }
          const safe = (parts[1] || 'Untitled').replace(/[/\\?%*:|"<>]/g, '-');
          fs.appendFileSync(path.join(vaultPath, `${safe}.md`), `\n${parts.slice(2).join('\n')}\n`, 'utf8');
          label = `✅ Appended to Obsidian: **${safe}.md**`; break;
        }
        case 'memory_write': {
          const safe = (parts[1] || 'note').replace(/[/\\?%*:|"<>]/g, '-');
          fs.writeFileSync(path.join(MEMORY_DIR, safe), parts.slice(2).join('\n'), 'utf8');
          label = `✅ Saved to memory: **${safe}**`; break;
        }
        case 'memory_read': {
          const safe = (parts[1] || '').replace(/[/\\?%*:|"<>]/g, '-');
          const fp = path.join(MEMORY_DIR, safe);
          if (!fs.existsSync(fp)) { label = `⚠️ memory/${safe} not found`; break; }
          data = fs.readFileSync(fp, 'utf8').slice(0, 4000);
          label = `📖 Read memory/${safe}`; isData = true; break;
        }
        case 'file_write': {
          const fp = path.resolve(ROOT, parts[1] || 'output.txt');
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, parts.slice(2).join('\n'), 'utf8');
          label = `✅ File written: **${parts[1]}**`; break;
        }
        case 'file_read': {
          const fp = path.resolve(ROOT, parts[1] || '');
          if (!fs.existsSync(fp)) { label = `⚠️ File not found: ${parts[1]}`; break; }
          data = fs.readFileSync(fp, 'utf8').slice(0, 6000);
          label = `📖 Read: ${parts[1]}`; isData = true; break;
        }

        // ── Web ───────────────────────────────────────────────────────
        case 'web_search': {
          data = await webSearch(parts.slice(1).join(' '));
          label = `🔍 Web search: *${parts.slice(1).join(' ')}*`; isData = true; break;
        }
        case 'web_fetch': {
          data = await webFetch(parts[1]);
          label = `🌐 Fetched: ${parts[1]}`; isData = true; break;
        }

        // ── Communication ─────────────────────────────────────────────
        case 'send_email': {
          const mailer = getMailer();
          if (!mailer) { label = '⚠️ Gmail not configured — add GMAIL_ADDRESS + GMAIL_APP_PASSWORD to .env'; break; }
          await mailer.sendMail({ from: `OmniClaw <${process.env.GMAIL_ADDRESS}>`, to: parts[1], subject: parts[2], text: parts.slice(3).join('\n') });
          label = `✅ Email sent → **${parts[1]}** | "${parts[2]}"`; break;
        }
        case 'slack_send': {
          const ch = parts[1]?.startsWith('#') ? parts[1] : (process.env.SLACK_CHANNEL_ID || parts[1]);
          const msg = parts.slice(parts[1]?.startsWith('#') ? 2 : 1).join('\n');
          await sendSlack(msg, ch);
          label = `✅ Slack → **${ch}**`; break;
        }
        case 'telegram_send': {
          const chatId = process.env.TG_CHAT_ID;
          if (!chatId) { label = '⚠️ TG_CHAT_ID not set in .env'; break; }
          await sendTelegram(chatId, parts.slice(1).join('\n'));
          label = `✅ Telegram message sent`; break;
        }

        // ── Google Suite ──────────────────────────────────────────────
        case 'google_doc': {
          const auth = getGoogleAuth();
          if (!auth) { label = '⚠️ Google not authenticated — run Google OAuth setup first'; break; }
          const docs = google.docs({ version: 'v1', auth });
          const doc = await docs.documents.create({ resource: { title: parts[1] || 'OmniClaw Document' } });
          if (parts[2]) await docs.documents.batchUpdate({ documentId: doc.data.documentId, resource: { requests: [{ insertText: { location: { index: 1 }, text: parts.slice(2).join('\n') } }] } });
          label = `✅ Google Doc: [${parts[1]}](https://docs.google.com/document/d/${doc.data.documentId}/edit)`; break;
        }
        case 'calendar_event': {
          const auth = getGoogleAuth();
          if (!auth) { label = '⚠️ Google not authenticated'; break; }
          const cal = google.calendar({ version: 'v3', auth });
          await cal.events.insert({ calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary', resource: { summary: parts[1], start: { dateTime: parts[2] }, end: { dateTime: parts[3] }, description: parts[4] || '' } });
          label = `✅ Calendar event: **${parts[1]}** @ ${parts[2]}`; break;
        }
        case 'sheets_append': {
          await logToSheets(parts.slice(1).join('|').split(',').map(v => v.trim()));
          label = `✅ Row appended to Google Sheets`; break;
        }

        // ── Notion ────────────────────────────────────────────────────
        case 'notion_create': {
          const notion = getNotion();
          if (!notion || !process.env.NOTION_DATABASE_ID) { label = '⚠️ Notion not configured — add NOTION_TOKEN + NOTION_DATABASE_ID to .env'; break; }
          await notion.pages.create({
            parent: { database_id: process.env.NOTION_DATABASE_ID },
            properties: { Name: { title: [{ text: { content: parts[1] || 'Note' } }] } },
            children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: parts.slice(2).join('\n') } }] } }],
          });
          label = `✅ Notion page created: **${parts[1]}**`; break;
        }

        // ── HubSpot ───────────────────────────────────────────────────
        case 'hubspot_create_contact': {
          if (!process.env.HUBSPOT_API_KEY) { label = '⚠️ HUBSPOT_API_KEY not set'; break; }
          const nm = (parts[2] || '').split(' ');
          const r = await axios.post('https://api.hubapi.com/crm/v3/objects/contacts',
            { properties: { email: parts[1], firstname: nm[0] || '', lastname: nm.slice(1).join(' '), company: parts[3] || '' } },
            { headers: { authorization: `Bearer ${process.env.HUBSPOT_API_KEY}` }, timeout: 10000 });
          label = `✅ HubSpot contact: ${parts[2]} <${parts[1]}> — ID ${r.data.id}`; break;
        }
        case 'hubspot_create_deal': {
          if (!process.env.HUBSPOT_API_KEY) { label = '⚠️ HUBSPOT_API_KEY not set'; break; }
          const r = await axios.post('https://api.hubapi.com/crm/v3/objects/deals',
            { properties: { dealname: parts[1], amount: String(parts[2] || 0), dealstage: parts[3] || 'appointmentscheduled', pipeline: 'default' } },
            { headers: { authorization: `Bearer ${process.env.HUBSPOT_API_KEY}` }, timeout: 10000 });
          label = `✅ HubSpot deal: **${parts[1]}** — ID ${r.data.id}`; break;
        }
        case 'hubspot_get_deals': {
          if (!process.env.HUBSPOT_API_KEY) { label = '⚠️ HUBSPOT_API_KEY not set'; break; }
          const r = await axios.get('https://api.hubapi.com/crm/v3/objects/deals?limit=10&properties=dealname,amount,dealstage,closedate',
            { headers: { authorization: `Bearer ${process.env.HUBSPOT_API_KEY}` }, timeout: 10000 });
          data = (r.data.results || []).map(d => `${d.properties.dealname} | ${d.properties.dealstage} | $${d.properties.amount || 0} | close: ${d.properties.closedate || 'TBD'}`).join('\n');
          label = `📊 HubSpot pipeline (${r.data.results?.length || 0} deals)`; isData = true; break;
        }

        // ── Stripe ────────────────────────────────────────────────────
        case 'stripe_create_invoice': {
          if (!process.env.STRIPE_API_KEY || !stripe) { label = '⚠️ Stripe not configured — add STRIPE_API_KEY to .env'; break; }
          const sc = stripe(process.env.STRIPE_API_KEY);
          const existing = await sc.customers.list({ email: parts[1], limit: 1 });
          const cust = existing.data[0] || await sc.customers.create({ email: parts[1] });
          const inv = await sc.invoices.create({ customer: cust.id, auto_advance: false });
          await sc.invoiceItems.create({ customer: cust.id, invoice: inv.id, amount: parseInt(parts[2] || 0), currency: 'usd', description: parts[3] || 'OmniClaw Invoice' });
          label = `✅ Stripe invoice: ${inv.id} — $${(parseInt(parts[2]||0)/100).toFixed(2)} for ${parts[1]}`; break;
        }
        case 'stripe_revenue': {
          if (!process.env.STRIPE_API_KEY || !stripe) { label = '⚠️ Stripe not configured'; break; }
          const sc = stripe(process.env.STRIPE_API_KEY);
          const charges = await sc.charges.list({ limit: 20 });
          const total = charges.data.reduce((s, c) => s + (c.amount_captured || 0), 0) / 100;
          data = `Total (last 20): $${total.toFixed(2)} USD\n` + charges.data.slice(0, 8).map(c => `  ${c.description || c.id} — $${(c.amount/100).toFixed(2)}`).join('\n');
          label = `💰 Stripe revenue`; isData = true; break;
        }

        // ── GitHub ────────────────────────────────────────────────────
        case 'github_push': {
          const msg = (parts.slice(1).join(' ') || 'OmniClaw agent update').replace(/"/g, "'");
          const out = shellExec(`cd "${ROOT}" && git add -A && git diff --cached --quiet || git commit -m "${msg}" && git push`);
          label = `✅ GitHub pushed: "${msg}"\n\`\`\`\n${out}\n\`\`\``; break;
        }
        case 'github_create_issue': {
          if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) { label = '⚠️ Add GITHUB_TOKEN + GITHUB_REPO (owner/repo) to .env'; break; }
          const r = await axios.post(`https://api.github.com/repos/${process.env.GITHUB_REPO}/issues`,
            { title: parts[1], body: parts.slice(2).join('\n') },
            { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }, timeout: 10000 });
          label = `✅ GitHub issue #${r.data.number}: **${parts[1]}**`; break;
        }

        // ── Supabase ──────────────────────────────────────────────────
        case 'supabase_query': {
          if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) { label = '⚠️ SUPABASE_URL + SUPABASE_ANON_KEY not set'; break; }
          let filter = {};
          try { filter = parts[2] ? JSON.parse(parts[2]) : {}; } catch (_) {}
          let url = `${process.env.SUPABASE_URL}/rest/v1/${parts[1]}?limit=20`;
          if (Object.keys(filter).length) Object.entries(filter).forEach(([k,v]) => { url += `&${k}=eq.${encodeURIComponent(v)}`; });
          const r = await axios.get(url, { headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` }, timeout: 10000 });
          data = JSON.stringify(r.data, null, 2).slice(0, 4000);
          label = `🗄️ Supabase ${parts[1]} (${Array.isArray(r.data) ? r.data.length : 1} rows)`; isData = true; break;
        }
        case 'supabase_insert': {
          if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) { label = '⚠️ SUPABASE_URL + SUPABASE_ANON_KEY not set'; break; }
          let row = {};
          try { row = JSON.parse(parts.slice(2).join('|')); } catch (_) {}
          await axios.post(`${process.env.SUPABASE_URL}/rest/v1/${parts[1]}`, row,
            { headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`, Prefer: 'return=representation' }, timeout: 10000 });
          label = `✅ Inserted into Supabase.${parts[1]}`; break;
        }

        // ── Shell / NemoClaw ──────────────────────────────────────────
        case 'shell': {
          const cmd = parts.slice(1).join('|');
          data = shellExec(cmd);
          label = `🖥️ \`${cmd}\``; isData = true; break;
        }

        // ── Agent Dispatch — call C-Suite agent (or pool agent by id) ─
        case 'agent_dispatch': {
          const agentId = (parts[1] || '').toUpperCase();
          const task = parts.slice(2).join('|');
          if (!task) { label = `⚠️ agent_dispatch requires a task: [[ACTION:agent_dispatch|CFO|task here]]`; break; }
          const persona = AGENT_PERSONAS[agentId];
          if (persona) {
            const agentSysPrompt = getAgentSystemPrompt(agentId);
            const agentReply = await callAI([{ role: 'user', content: task }], agentSysPrompt);
            data = agentReply;
            label = `${persona.emoji} ${persona.name} responded`;
            isData = true;
            io.emit('chat:message', { role: 'assistant', content: agentReply, source: `${persona.emoji} ${persona.name}`, agentId, timestamp: new Date().toISOString() });
            if (state.agents[agentId]) { state.agents[agentId].lastActive = new Date().toISOString(); state.agents[agentId].currentTask = task.slice(0, 60); io.emit('agents:update', Object.values(state.agents)); }
          } else {
            // Fall through to OpenClaw pool — match by id or name
            const rawId = parts[1] || '';
            const pool = getAgentPool();
            const poolAgent = pool.find(a =>
              a.id.toLowerCase() === rawId.toLowerCase() ||
              a.name.toLowerCase() === rawId.toLowerCase() ||
              a.id.toUpperCase() === agentId
            );
            if (poolAgent) {
              const poolSysPrompt = `You are ${poolAgent.name}, a specialist in ${poolAgent.role || poolAgent.category}. Part of the OmniClaw agent pool. Be concise, practical, and expert. Produce actionable output.\n\n${AGENT_ACTION_REFERENCE}`;
              const poolReply = await callAI([{ role: 'user', content: task }], poolSysPrompt);
              data = poolReply;
              label = `🤖 ${poolAgent.name} (${poolAgent.category}) responded`;
              isData = true;
              io.emit('chat:message', { role: 'assistant', content: poolReply, source: `🤖 ${poolAgent.name}`, agentId: poolAgent.id, timestamp: new Date().toISOString() });
            } else {
              label = `⚠️ Agent "${rawId}" not found. C-Suite: ${Object.keys(AGENT_PERSONAS).filter(k=>k!=='CEO').join(', ')}. For pool agents use [[ACTION:openclaw_dispatch|category|agent-name|task]]`;
            }
          }
          break;
        }

        // ── Subagent Dispatch — built-in specialists or OpenClaw by name
        case 'subagent': {
          const subId = parts[1];
          const task = parts.slice(2).join('|');
          if (!task) { label = `⚠️ subagent requires a task: [[ACTION:subagent|seo-analyst|task here]]`; break; }
          const def = (SUBAGENT_DEFINITIONS || {})[subId];
          if (def) {
            const subSysPrompt = `${def.prompt}\n\n${AGENT_ACTION_REFERENCE}`;
            const subReply = await callAI([{ role: 'user', content: task }], subSysPrompt);
            data = subReply;
            label = `${def.icon||'🤖'} ${def.label} responded`;
            isData = true;
          } else {
            // Try matching an OpenClaw pool agent by id
            const pool = getAgentPool();
            const poolAgent = pool.find(a => a.id === subId || a.name.toLowerCase() === subId.toLowerCase());
            if (poolAgent) {
              const poolSysPrompt = `You are ${poolAgent.name}, a specialist in ${poolAgent.role || poolAgent.category}. Part of the OmniClaw agent pool. Be concise, practical, and expert.\n\n${AGENT_ACTION_REFERENCE}`;
              const poolReply = await callAI([{ role: 'user', content: task }], poolSysPrompt);
              data = poolReply;
              label = `🤖 ${poolAgent.name} responded`;
              isData = true;
            } else {
              const available = Object.keys(SUBAGENT_DEFINITIONS || {}).slice(0, 10).join(', ');
              label = `⚠️ Subagent "${subId}" not found. Built-in sample IDs: ${available}. For pool agents use [[ACTION:openclaw_dispatch|category|agent-name|task]]`;
            }
          }
          break;
        }

        // ── OpenClaw Pool Dispatch — call specific pool agent by category+name
        case 'openclaw_dispatch': {
          const cat = (parts[1] || '').toLowerCase();
          const agentName = (parts[2] || '').toLowerCase();
          const task = parts.slice(3).join('|');
          if (!task) { label = `⚠️ openclaw_dispatch: [[ACTION:openclaw_dispatch|category|agent-name|task]]`; break; }
          const pool = getAgentPool();
          let poolAgent = pool.find(a => a.category === cat && a.name.toLowerCase() === agentName);
          if (!poolAgent) poolAgent = pool.find(a => a.category === cat && a.name.toLowerCase().includes(agentName));
          if (!poolAgent) poolAgent = pool.find(a => a.name.toLowerCase().includes(agentName) || a.id.includes(agentName));
          if (!poolAgent) {
            const catAgents = pool.filter(a => a.category === cat).map(a => a.name).join(', ');
            label = `⚠️ Pool agent "${agentName}" not found in "${cat}". Available: ${catAgents || 'unknown category'}`;
            break;
          }
          const ocSysPrompt = `You are ${poolAgent.name}, a specialist in ${poolAgent.role || poolAgent.category}. You are part of the OmniClaw platform, deployed as a temporary specialist. Be concise, practical, and produce expert-level output directly relevant to the task.\n\n${AGENT_ACTION_REFERENCE}`;
          const ocReply = await callAI([{ role: 'user', content: task }], ocSysPrompt);
          data = ocReply;
          label = `🤖 ${poolAgent.name} (${poolAgent.category}) responded`;
          isData = true;
          io.emit('chat:message', { role: 'assistant', content: ocReply, source: `🤖 ${poolAgent.name}`, agentId: poolAgent.id, timestamp: new Date().toISOString() });
          break;
        }

        // ── VoltAgent Codex Dispatch — call Codex specialist pool by category
        case 'codex_dispatch': {
          const codexCat = parts[1];
          const task = parts.slice(2).join('|');
          if (!task) { label = `⚠️ codex_dispatch: [[ACTION:codex_dispatch|codex:category|task]]`; break; }
          const codexDef = (SKILL_MANIFEST.codex_subagents || []).find(s => s.id === codexCat);
          if (!codexDef) {
            const available = (SKILL_MANIFEST.codex_subagents || []).map(s => s.id).join(', ');
            label = `⚠️ Codex category "${codexCat}" not found. Available: ${available}`;
            break;
          }
          const agentCount = codexDef.desc.match(/^(\d+)/)?.[1] || 'multiple';
          const codexSysPrompt = `You are a VoltAgent Codex specialist — ${codexDef.id} (${agentCount} expert agents in this domain: ${codexDef.desc}). Provide deeply expert, actionable, production-ready output. Be precise and concise.\n\n${AGENT_ACTION_REFERENCE}`;
          const codexReply = await callAI([{ role: 'user', content: task }], codexSysPrompt);
          data = codexReply;
          label = `⚡ Codex ${codexCat} responded`;
          isData = true;
          io.emit('chat:message', { role: 'assistant', content: codexReply, source: `⚡ Codex ${codexCat}`, agentId: codexCat, timestamp: new Date().toISOString() });
          break;
        }

        // ── Agent Broadcast — send message to all C-Suite agents ──────
        case 'agent_broadcast': {
          const message = parts.slice(1).join('|');
          if (!message) { label = '⚠️ agent_broadcast requires a message'; break; }
          const responses = [];
          for (const [agentId, persona] of Object.entries(AGENT_PERSONAS)) {
            if (agentId === 'CEO') continue;
            try {
              const aSysPrompt = getAgentSystemPrompt(agentId);
              const aReply = await callAI([{ role: 'user', content: message }], aSysPrompt);
              responses.push(`${persona.emoji} **${persona.name}:** ${aReply.slice(0, 400)}`);
              io.emit('chat:message', { role: 'assistant', content: aReply, source: `${persona.emoji} ${persona.name}`, agentId, timestamp: new Date().toISOString() });
            } catch(e) { responses.push(`${persona.emoji} ${persona.name}: (unavailable)`); }
          }
          data = responses.join('\n\n');
          label = `📢 Broadcast to ${responses.length} agents`;
          isData = true;
          break;
        }

        case 'create_agent': {
          const agentName = (parts[1] || '').trim();
          const agentRole = (parts[2] || 'general').trim();
          const agentInstructions = parts.slice(3).join('|').trim();
          if (!agentName) { label = '⚠️ create_agent requires a name: [[ACTION:create_agent|Name|role|instructions]]'; break; }
          try {
            const paperclipApi = 'http://127.0.0.1:3100';
            const companyId = process.env.PAPERCLIP_COMPANY_ID || 'bb7a6f5b-7333-4916-89e9-c9394b5aa421';
            const r = await axios.post(`${paperclipApi}/api/companies/${companyId}/agents`, {
              name: agentName,
              role: agentRole,
              adapterType: 'openclaw_gateway',
              adapterConfig: {
                url: 'ws://127.0.0.1:3001/openclaw-gateway',
                agentId: agentName.toUpperCase().replace(/\s+/g, '_'),
                disableDeviceAuth: true,
                timeoutSec: 300,
                waitTimeoutMs: 270000
              },
              instructions: agentInstructions
            }, { timeout: 10000 });
            label = `✅ Agent **${r.data.name}** created in Paperclip (id: ${r.data.id})`;
            io.emit('openclaw:deployed', { agentId: r.data.id, name: r.data.name, category: agentRole, role: agentRole });
          } catch (ce) {
            label = `⚠️ Agent creation failed: ${ce.response?.data?.message || ce.message}`;
          }
          break;
        }

        case 'obsidian_search': {
          const vaultBase = resolveConfig('OBSIDIAN_VAULT_PATH', 'VAULT_PATH');
          if (!vaultBase) { label = '⚠️ Obsidian vault not configured — add VAULT_PATH to Settings'; break; }
          // Scope searches to a company-specific subfolder to prevent cross-platform bleed
          const vaultSubpath = resolveConfig('VAULT_SUBPATH');
          const vaultPath = vaultSubpath ? path.join(vaultBase, vaultSubpath) : vaultBase;
          const query = parts.slice(1).join('|').trim().toLowerCase();
          if (!query) { label = '⚠️ obsidian_search requires a query: [[ACTION:obsidian_search|#marketing]] or [[ACTION:obsidian_search|project name]]'; break; }
          function walkVault(dir, found = []) {
            if (!fs.existsSync(dir)) return found;
            try {
              for (const f of fs.readdirSync(dir)) {
                if (f.startsWith('.')) continue;
                const fp = path.join(dir, f);
                try {
                  if (fs.statSync(fp).isDirectory()) walkVault(fp, found);
                  else if (f.endsWith('.md')) found.push(fp);
                } catch(_) {}
              }
            } catch(_) {}
            return found;
          }
          const allFiles = walkVault(vaultPath);
          const matches = [];
          for (const fp of allFiles) {
            try {
              const content = fs.readFileSync(fp, 'utf8');
              const title = path.basename(fp, '.md');
              const lc = content.toLowerCase();
              if (lc.includes(query) || title.toLowerCase().includes(query)) {
                const idx = lc.indexOf(query);
                const snippet = content.slice(Math.max(0, idx - 60), idx + 120).replace(/\n+/g, ' ').trim();
                const lines = content.split('\n').filter(l => l.toLowerCase().includes(query)).slice(0, 3);
                matches.push({ title, rel: fp.replace(vaultPath, ''), snippet: lines.join(' | ') || snippet });
              }
            } catch(_) {}
            if (matches.length >= 30) break; // cap at 30 results
          }
          if (!matches.length) {
            data = `No notes found matching "${query}" in ${allFiles.length} vault files.`;
          } else {
            data = `Found ${matches.length} note${matches.length !== 1 ? 's' : ''} matching "${query}":\n\n` +
              matches.map(m => `📄 **${m.title}** (${m.rel})\n   ${m.snippet}`).join('\n\n');
          }
          label = `🔍 Obsidian: "${query}" — ${matches.length} result${matches.length !== 1 ? 's' : ''} in ${allFiles.length} files`;
          isData = true;
          break;
        }

        default:
          label = `⚠️ Unknown action: ${type}`;
      }
    } catch (err) {
      label = `❌ ${type} failed: ${err.message}`;
    }
    actionResults.push({ type, label, data, isData });
  }

  // Strip all action blocks from visible text
  let clean = reply.replace(ACTION_RE, '').replace(/\n{3,}/g, '\n\n').trim();

  // Synthesis pass: if actions returned data, feed it back to the agent
  // so it responds with the actual information rather than just confirmations
  const dataResults = actionResults.filter(r => r.isData && r.data);
  if (dataResults.length && systemPromptForSynthesis) {
    const dataBlock = dataResults.map(r => `=== ${r.label} ===\n${r.data}`).join('\n\n');
    try {
      clean = await callAI([
        { role: 'assistant', content: clean || '(executing actions now)' },
        { role: 'user', content: `Here are the results:\n\n${dataBlock}\n\nNow give your complete, informed response. Be specific — use the actual data, numbers, names, and URLs from the results above.` },
      ], systemPromptForSynthesis);
    } catch (_) {
      clean += '\n\n' + dataResults.map(r => `**${r.label}**\n\`\`\`\n${r.data}\n\`\`\``).join('\n\n');
    }
  }

  // Append non-data action confirmations
  const confirmations = actionResults.filter(r => !r.isData).map(r => r.label);
  if (confirmations.length) clean += '\n\n' + confirmations.join('\n');

  return clean;
}

app.post('/api/chat', async (req, res) => {
  const { message, source, agentId } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  // Route to specific agent or CEO by default
  const targetAgent = (agentId && AGENT_PERSONAS[agentId.toUpperCase()]) ? agentId.toUpperCase() : 'CEO';
  const isSpecificAgent = targetAgent !== 'CEO' || agentId === 'CEO';

  chatHistory.push({ role: 'user', content: message, source: source || 'dashboard', timestamp: new Date().toISOString() });
  io.emit('chat:message', { role: 'user', content: message, source: source || 'dashboard', timestamp: new Date().toISOString() });

  try {
    const msgs = chatHistory.filter(m => m.role === 'user' || m.role === 'assistant').slice(-10).map(m => ({ role: m.role, content: m.content }));
    const sysPrompt = isSpecificAgent ? getAgentSystemPrompt(targetAgent) : getSystemPrompt();
    const persona = AGENT_PERSONAS[targetAgent];
    const rawReply = await callAI(msgs, sysPrompt);
    const reply = await executeActions(rawReply, sysPrompt);
    const response = { role: 'assistant', content: reply, source: persona ? `${persona.emoji} ${persona.name}` : 'CEO', agentId: targetAgent, timestamp: new Date().toISOString() };
    chatHistory.push({ role: 'assistant', content: reply, source: response.source, timestamp: response.timestamp });
    if (chatHistory.length > 200) chatHistory.splice(0, 50);

    io.emit('chat:message', response);
    res.json(response);

    if (state.agents[targetAgent]) {
      state.agents[targetAgent].lastActive = new Date().toISOString();
      state.agents[targetAgent].currentTask = 'Responding to query';
      io.emit('agents:update', Object.values(state.agents));
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/chat/history', (req, res) => {
  res.json(chatHistory.slice(-50));
});

// =============================================================================
// TELEGRAM — long-poll bot, agent intros, per-agent routing
// =============================================================================
let tgOffset = 0;

// Agent personas for Telegram routing
const AGENT_PERSONAS = {
  CEO:  { name: 'TommyClaw (CEO)', emoji: '🦾', role: 'Chief Executive Officer', style: 'sharp, decisive founder' },
  CFO:  { name: 'CFO', emoji: '💰', role: 'Chief Financial Officer', style: 'numbers-focused, risk-aware capital allocator' },
  COO:  { name: 'COO', emoji: '⚙️', role: 'Chief Operating Officer', style: 'execution-focused operations lead' },
  CTO:  { name: 'CTO', emoji: '🔧', role: 'Chief Technology Officer', style: 'pragmatic systems architect' },
  CSO:  { name: 'CSO', emoji: '♟️', role: 'Chief Strategy Officer', style: 'long-term strategic thinker' },
  CRO:  { name: 'CRO', emoji: '🛡️', role: 'Chief Risk Officer', style: 'cautious downside-first risk protector' },
  CIO:  { name: 'CIO', emoji: '📊', role: 'Chief Information Officer', style: 'data-driven intelligence layer' },
  CPO:  { name: 'CPO', emoji: '🚀', role: 'Chief Product Officer', style: 'user-obsessed product builder' },
  CHRO: { name: 'CHRO', emoji: '🤝', role: 'Chief HR Officer', style: 'culture-focused people builder' },
  CLO:  { name: 'CLO', emoji: '⚖️', role: 'Chief Legal Officer', style: 'risk-averse legal guardian' },
  CMO:  { name: 'CMO', emoji: '📣', role: 'Chief Marketing Officer', style: 'creative, data-driven growth marketer who builds audiences and converts them' },
};

// Intro messages — sent once on first run when Telegram is configured
const AGENT_INTROS = [
  (owner, co) => `🦾 *TommyClaw here* — your AI CEO at ${co}. I'm the one making the calls. Message me anything — decisions, strategy, questions. Good to have you, ${owner}.`,
  (owner, co) => `💰 *CFO checking in* — Capital Allocator for ${co}. If it involves money, budget, or ROI, that's my domain. I'll keep you honest on the numbers, ${owner}.`,
  (owner, co) => `⚙️ *COO online* — I run the operations side at ${co}. Execution, delivery, systems that actually work. Reach out when you need things done, ${owner}.`,
  (owner, co) => `🔧 *CTO here* — I own the tech architecture at ${co}. Stack decisions, infrastructure, build vs buy. I'll keep us from building on sand, ${owner}.`,
  (owner, co) => `♟️ *CSO reporting in* — Strategy is my game at ${co}. Where we're going, how we get there, what the competition is doing. Here when you need a big-picture take, ${owner}.`,
  (owner, co) => `🛡️ *CRO standing by* — Risk is my brief at ${co}. I'll be the voice that asks "what could go wrong?" before we commit. Don't skip me on big calls, ${owner}.`,
  (owner, co) => `📊 *CIO active* — Intelligence layer at ${co}. Data, analytics, market signals. If you need to know something, I'll find it, ${owner}.`,
  (owner, co) => `🚀 *CPO online* — I own product at ${co}. What we build, who it's for, and whether it's actually good. Talk to me about the roadmap, ${owner}.`,
  (owner, co) => `🤝 *CHRO here* — People and culture at ${co}. Talent, team dynamics, how we work together. Here if you need to think through the human side, ${owner}.`,
  (owner, co) => `⚖️ *CLO signed in* — Legal guardian at ${co}. Contracts, compliance, anything that could get us in trouble. Run it by me before you commit, ${owner}.`,
  (owner, co) => `📣 *CMO online* — I own growth and marketing at ${co}. Brand, content, audience, campaigns. Tell me what you're selling and I'll tell you how to make people want it, ${owner}.`,
];

// =============================================================================
// SKILL SYSTEM — shared pool across all C-Suite agents
// =============================================================================

const SKILL_MANIFEST = {
  superpowers: [
    { id: 'brainstorming',                 desc: 'Generate diverse ideas before narrowing — diverge then converge' },
    { id: 'writing-plans',                 desc: 'Create step-by-step execution plans before acting' },
    { id: 'executing-plans',               desc: 'Follow a written plan systematically, step by step' },
    { id: 'dispatching-parallel-agents',   desc: 'Break work into parallel streams and synthesise results' },
    { id: 'systematic-debugging',          desc: 'Diagnose problems with a structured elimination approach' },
    { id: 'verification-before-completion',desc: 'Check outputs against the original goal before declaring done' },
    { id: 'subagent-driven-development',   desc: 'Delegate subtasks to specialised sub-agents for high quality' },
  ],
  opencli_api: [
    { id: 'google',        desc: 'Google Search — no browser needed' },
    { id: 'bloomberg',     desc: 'Bloomberg financial news and data' },
    { id: 'hackernews',    desc: 'Hacker News top stories and discussions' },
    { id: 'stackoverflow', desc: 'Stack Overflow Q&A lookup' },
    { id: 'wikipedia',     desc: 'Wikipedia article content' },
    { id: 'arxiv',         desc: 'Academic papers and research' },
    { id: 'bbc',           desc: 'BBC News headlines' },
    { id: 'devto',         desc: 'Dev.to engineering articles' },
    { id: 'yahoo-finance', desc: 'Yahoo Finance stock and market data' },
  ],
  opencli_browser: [
    { id: 'twitter',   desc: 'Twitter/X — post, read, search, follow (24 skills)' },
    { id: 'reddit',    desc: 'Reddit — browse, post, comment, moderate (15 skills)' },
    { id: 'instagram', desc: 'Instagram — post, stories, DMs, analytics (14 skills)' },
    { id: 'tiktok',    desc: 'TikTok — post, trending, analytics (15 skills)' },
    { id: 'facebook',  desc: 'Facebook — posts, pages, groups (10 skills)' },
    { id: 'linkedin',  desc: 'LinkedIn — posts, outreach, job listings' },
    { id: 'youtube',   desc: 'YouTube — upload, comments, analytics' },
    { id: 'medium',    desc: 'Medium — publish and read articles' },
    { id: 'substack',  desc: 'Substack — publish newsletters' },
  ],
  opencli_desktop: [
    { id: 'discord', desc: 'Discord — messages, channels, community management' },
    { id: 'notion',  desc: 'Notion desktop — read and write pages' },
    { id: 'chatgpt', desc: 'ChatGPT desktop — interact via UI' },
    { id: 'cursor',  desc: 'Cursor IDE — code editing automation' },
  ],
  apis: [
    { id: 'gmail',           desc: 'Send and read emails via Gmail SMTP' },
    { id: 'google-drive',    desc: 'Upload, download, organise files in Drive' },
    { id: 'google-docs',     desc: 'Create and edit Google Docs' },
    { id: 'google-sheets',   desc: 'Read and write Google Sheets data' },
    { id: 'google-calendar', desc: 'Create and manage Calendar events' },
    { id: 'slack',           desc: 'Post messages to Slack channels' },
    { id: 'notion-api',      desc: 'Read/write Notion databases via API' },
    { id: 'hubspot',         desc: 'CRM — deals, contacts, pipeline' },
    { id: 'stripe',          desc: 'Payments — charges, subscriptions, revenue' },
    { id: 'firecrawl',       desc: 'Web scraping and content extraction' },
    { id: 'perplexity',      desc: 'AI-powered web research and Q&A' },
    { id: 'supabase',        desc: 'Database read/write and auth' },
    { id: 'github',          desc: 'Repo management, issues, PRs' },
  ],
  // 136+ specialised Codex subagents — github.com/VoltAgent/awesome-codex-subagents
  // Install: git clone the repo, copy .toml files to ~/.codex/agents/
  // Invoke: explicitly delegate in your prompt e.g. "Use the python-expert subagent to..."
  codex_subagents: [
    { id: 'codex:core-dev',          desc: '12 agents — API design, backend architecture, frontend, microservices, full-stack. Use for: "design this API", "scaffold a service", "review this component"' },
    { id: 'codex:language-specialists', desc: '30 agents — Python, TypeScript, Rust, Go, Java, Ruby, PHP, Swift, Kotlin, C++, Elixir, Scala, Clojure, Haskell, Lua, R, MATLAB, Bash, SQL, Solidity and more. Use for: language-specific code review, idiomatic refactoring, performance optimisation' },
    { id: 'codex:infrastructure',    desc: '16 agents — DevOps, AWS, GCP, Azure, Kubernetes, Terraform, Docker, CI/CD, networking, SRE. Use for: "write a Terraform module", "design our K8s setup", "build a CI pipeline"' },
    { id: 'codex:quality-security',  desc: '16 agents — Unit testing, integration testing, code review, security audit, penetration testing, OWASP compliance, SAST. Use for: "security audit this endpoint", "write tests for this module", "find vulnerabilities"' },
    { id: 'codex:data-ai',           desc: '12 agents — ML engineering, data pipelines, LLM integration, RAG, analytics, data modelling, vector DBs. Use for: "build a RAG pipeline", "design our ML training loop", "optimise this query"' },
    { id: 'codex:devex',             desc: '13 agents — Build systems, documentation, refactoring, linting, code cleanup, SDK design, CLI tooling. Use for: "improve this README", "refactor this class", "design our CLI"' },
    { id: 'codex:specialized',       desc: '12 agents — Blockchain/Web3, fintech, game development, embedded systems, scientific computing, AR/VR. Use for: "audit this smart contract", "build a fintech payment flow", "design game mechanics"' },
    { id: 'codex:business-product',  desc: '11 agents — Product management, user research, UX analysis, legal/compliance, technical writing, go-to-market. Use for: "write a PRD", "analyse this UX flow", "draft terms of service"' },
    { id: 'codex:meta-orchestration',desc: '12 agents — Multi-agent coordination, workflow automation, parallel task dispatching, agent planning, prompt engineering. Use for: "break this into parallel workstreams", "design the agent workflow", "orchestrate a multi-step build"' },
    { id: 'codex:research-analysis', desc: '7 agents — Market research, competitive intelligence, technology scouting, trend analysis, literature review. Use for: "research competitors in this space", "find the state of the art for X", "analyse this market"' },
  ],
  // 187 production-ready OpenClaw SOUL.md templates — github.com/mergisi/awesome-openclaw-agents
  // Deploy any agent temporarily via POST /api/openclaw/agents/deploy
  // They spin up as temporary workers in agents/temp/ and can be undeployed when done
  openclaw_agents: [
    { id: 'openclaw:productivity',     desc: '9 agents — Orion (task coordination), Pulse (analytics dashboards), Standup, Inbox (email triage), Minutes (meeting summaries), Focus Timer, Habit Tracker, Meeting Transcriber, Notion Organizer. Deploy via: POST /api/openclaw/agents/deploy' },
    { id: 'openclaw:business',         desc: '14 agents — Radar (data insights), Compass (ticket triage), Pipeline (lead scoring/CRM), Ledger (payments/MRR), Sentinel (churn risk), Personal CRM, WhatsApp Business, Meeting Scheduler, Competitor Pricing, SDR Outbound, Deal Forecaster, Objection Handler, Lead Gen, ERP Admin' },
    { id: 'openclaw:marketing',        desc: '22 agents — Echo (blog/social/email), Buzz (Twitter/LinkedIn threads), Rank (SEO/keyword research), Digest (newsletter), Scout (competitor intel), Reddit Scout, TikTok Repurposer, Cold Outreach, A/B Test Analyzer, Influencer Finder, Brand Monitor, Email Sequence, Content Repurposer, Book Writer, News Curator, UGC Video, Multi-Account Social, LinkedIn Content, Localization, X/Twitter Growth, YouTube SEO' },
    { id: 'openclaw:development',      desc: '18 agents — Lens (PR review), Scribe (docs/README), Trace (error analysis), Probe (API testing), Log (changelog), Dependency Scanner, PR Merger, Migration Helper, Test Writer, Schema Designer, API Documentation, Blockchain Analyst, GitHub Issue Triager, GitHub PR Reviewer, QA Tester, Script Builder, Ecommerce Dev, Game Designer' },
    { id: 'openclaw:devops',           desc: '10 agents — Incident Responder, Deploy Guardian, Infra Monitor, Log Analyzer, Cost Optimizer, Self-Healing Server, Raspberry Pi Agent, Runbook Writer, SLA Monitor, Capacity Planner' },
    { id: 'openclaw:finance',          desc: '10 agents — Expense Tracker, Invoice Manager, Revenue Analyst, Tax Preparer, Trading Bot, Fraud Detector, Financial Forecaster, Portfolio Rebalancer, Accounts Payable, Copy Trader' },
    { id: 'openclaw:legal',            desc: '6 agents — Contract Reviewer, Compliance Checker, Policy Writer, Patent Analyzer, Legal Brief Writer, NDA Generator' },
    { id: 'openclaw:hr',               desc: '8 agents — Recruiter, Onboarding, Performance Reviewer, Resume Screener, Exit Interview, Benefits Advisor, Compensation Benchmarker, Resume Optimizer' },
    { id: 'openclaw:security',         desc: '6 agents — Vuln Scanner, Access Auditor, Threat Monitor, Incident Logger, Security Hardener, Phishing Detector' },
    { id: 'openclaw:compliance',       desc: '4 agents — GDPR Auditor, SOC2 Preparer, AI Policy Writer, Risk Assessor' },
    { id: 'openclaw:creative',         desc: '10 agents — Brand Designer, Video Scripter, Podcast Producer, UX Researcher, Copywriter, Thumbnail Designer, Ad Copywriter, Storyboard Writer, Audio Producer, Proofreader' },
    { id: 'openclaw:data',             desc: '9 agents — ETL Pipeline, Data Cleaner, Report Generator, SQL Assistant, Dashboard Builder, Anomaly Detector, Survey Analyzer, Data Entry, Transcription' },
    { id: 'openclaw:saas',             desc: '6 agents — Onboarding Flow, Feature Request, Churn Prevention, Usage Analytics, Release Notes, Product Scrum' },
    { id: 'openclaw:ecommerce',        desc: '7 agents — Product Lister, Review Responder, Inventory Tracker, Pricing Optimizer, Abandoned Cart, Dropshipping Researcher, Price Monitor' },
    { id: 'openclaw:education',        desc: '8 agents — Tutor, Quiz Maker, Study Planner, Research Assistant, Language Tutor, Curriculum Designer, Essay Grader, Flashcard Generator' },
    { id: 'openclaw:healthcare',       desc: '7 agents — Wellness Coach, Meal Planner, Workout Tracker, Symptom Triage, Clinical Notes, Medication Checker, Patient Intake' },
    { id: 'openclaw:real-estate',      desc: '5 agents — Listing Scout, Market Analyzer, Lead Qualifier, Property Video, Commercial RE' },
    { id: 'openclaw:automation',       desc: '6 agents — Negotiation Agent, Job Applicant, Morning Briefing, Flight Scraper, Overnight Coder, Discord Business' },
    { id: 'openclaw:supply-chain',     desc: '3 agents — Route Optimizer, Inventory Forecaster, Vendor Evaluator' },
    { id: 'openclaw:voice',            desc: '3 agents — Phone Receptionist, Voicemail Transcriber, Interview Bot' },
    { id: 'openclaw:customer-success', desc: '2 agents — NPS Followup, Onboarding Guide' },
    { id: 'openclaw:freelance',        desc: '4 agents — Proposal Writer, Time Tracker, Client Manager, Upwork Proposal' },
    { id: 'openclaw:personal',         desc: '7 agents — Atlas (schedule optimisation), Scroll (reading digest), Iron (fitness), Home Automation, Family Coordinator, Travel Planner, Journal Prompter' },
    { id: 'openclaw:security-extra',   desc: '3 Moltbook agents — Community Manager, Scout (feed monitoring), Growth Agent (follower strategy)' },
  ],
};

// Per-agent primary skill focus (NOT restrictions — all agents access full pool)
const AGENT_PRIMARY_SKILLS = {
  CEO:  ['brainstorming', 'writing-plans', 'executing-plans', 'dispatching-parallel-agents', 'codex:meta-orchestration', 'gmail', 'google-docs', 'slack',
         'openclaw:productivity', 'openclaw:business', 'openclaw:automation'],
  CFO:  ['yahoo-finance', 'bloomberg', 'stripe', 'google-sheets', 'hubspot', 'writing-plans', 'verification-before-completion', 'codex:data-ai', 'codex:specialized',
         'openclaw:finance', 'openclaw:business', 'openclaw:data', 'openclaw:compliance'],
  COO:  ['executing-plans', 'writing-plans', 'google-sheets', 'notion-api', 'slack', 'dispatching-parallel-agents', 'codex:meta-orchestration', 'codex:devex',
         'openclaw:productivity', 'openclaw:business', 'openclaw:devops', 'openclaw:supply-chain', 'openclaw:automation'],
  CTO:  [
    'github', 'stackoverflow', 'hackernews', 'arxiv', 'cursor', 'systematic-debugging', 'google-drive',
    'codex:core-dev', 'codex:language-specialists', 'codex:infrastructure',
    'codex:quality-security', 'codex:data-ai', 'codex:devex',
    'codex:specialized', 'codex:meta-orchestration', 'codex:research-analysis',
    'openclaw:development', 'openclaw:devops', 'openclaw:security', 'openclaw:data', 'openclaw:automation',
  ],
  CSO:  ['brainstorming', 'perplexity', 'firecrawl', 'bloomberg', 'bbc', 'arxiv', 'writing-plans', 'codex:research-analysis', 'codex:business-product',
         'openclaw:business', 'openclaw:marketing', 'openclaw:data', 'openclaw:real-estate'],
  CMO:  ['twitter', 'instagram', 'tiktok', 'reddit', 'linkedin', 'youtube', 'medium', 'substack', 'firecrawl', 'perplexity', 'brainstorming', 'writing-plans', 'codex:research-analysis', 'codex:business-product',
         'openclaw:marketing', 'openclaw:creative', 'openclaw:ecommerce', 'openclaw:customer-success'],
  CRO:  ['systematic-debugging', 'verification-before-completion', 'bloomberg', 'hubspot', 'stripe', 'writing-plans', 'codex:quality-security',
         'openclaw:security', 'openclaw:compliance', 'openclaw:finance', 'openclaw:legal'],
  CIO:  ['google-sheets', 'supabase', 'perplexity', 'google', 'bbc', 'arxiv', 'dispatching-parallel-agents', 'codex:data-ai', 'codex:research-analysis',
         'openclaw:data', 'openclaw:productivity', 'openclaw:devops', 'openclaw:automation'],
  CPO:  ['brainstorming', 'writing-plans', 'notion-api', 'github', 'google-docs', 'verification-before-completion', 'codex:business-product', 'codex:devex',
         'openclaw:saas', 'openclaw:development', 'openclaw:education', 'openclaw:customer-success'],
  CHRO: ['linkedin', 'notion-api', 'google-docs', 'slack', 'gmail', 'writing-plans', 'codex:business-product',
         'openclaw:hr', 'openclaw:personal', 'openclaw:voice', 'openclaw:education'],
  CLO:  ['google', 'arxiv', 'notion-api', 'google-docs', 'gmail', 'verification-before-completion', 'codex:business-product', 'codex:quality-security',
         'openclaw:legal', 'openclaw:compliance', 'openclaw:security'],
};

// Per-exec priority categories for the 187-agent OpenClaw pool
const OPENCLAW_EXEC_CATEGORIES = {
  CEO:  { cats: ['productivity','business','automation'],                          focus: 'company operations, daily workflow, and decision-making support' },
  CFO:  { cats: ['finance','business','data','compliance'],                        focus: 'financial analysis, revenue tracking, and compliance monitoring' },
  COO:  { cats: ['productivity','business','devops','supply-chain','automation'],  focus: 'operational execution, team coordination, and process automation' },
  CTO:  { cats: ['development','devops','security','data','automation'],           focus: 'engineering velocity, infrastructure, and technical quality' },
  CSO:  { cats: ['business','marketing','data','real-estate'],                     focus: 'market intelligence, competitive positioning, and strategic research' },
  CMO:  { cats: ['marketing','creative','ecommerce','customer-success'],           focus: 'growth, content, brand, and audience building' },
  CRO:  { cats: ['security','compliance','finance','legal'],                       focus: 'risk detection, compliance auditing, and threat monitoring' },
  CIO:  { cats: ['data','productivity','devops','automation'],                     focus: 'intelligence gathering, data pipelines, and analytics' },
  CPO:  { cats: ['saas','development','education','customer-success'],             focus: 'product building, user onboarding, and feature prioritisation' },
  CHRO: { cats: ['hr','personal','voice','education'],                             focus: 'talent, culture, people ops, and team wellbeing' },
  CLO:  { cats: ['legal','compliance','security'],                                 focus: 'legal review, contract analysis, and regulatory compliance' },
};

const OPENCLAW_CATEGORY_AGENTS = {
  productivity:    'Orion (tasks), Pulse (analytics), Standup, Inbox (email triage), Minutes (meetings), Focus Timer, Notion Organizer',
  business:        'Radar (data insights), Pipeline (leads), Ledger (MRR), Sentinel (churn risk), SDR Outbound, Deal Forecaster, Competitor Pricing',
  automation:      'Negotiation Agent, Morning Briefing, Overnight Coder, Discord Business, Job Applicant, Flight Scraper',
  finance:         'Expense Tracker, Invoice Manager, Revenue Analyst, Fraud Detector, Financial Forecaster, Portfolio Rebalancer, Accounts Payable',
  compliance:      'GDPR Auditor, SOC2 Preparer, AI Policy Writer, Risk Assessor',
  marketing:       'Echo (blog/social), Buzz (Twitter/LinkedIn), Rank (SEO), Scout (competitor), Reddit Scout, Cold Outreach, Brand Monitor, Content Repurposer, YouTube SEO',
  creative:        'Brand Designer, Video Scripter, Podcast Producer, Copywriter, Ad Copywriter, Thumbnail Designer, Storyboard Writer',
  ecommerce:       'Product Lister, Review Responder, Inventory Tracker, Pricing Optimizer, Abandoned Cart, Dropshipping Researcher',
  'customer-success': 'NPS Followup, Onboarding Guide',
  development:     'Lens (PR review), Scribe (docs), Trace (errors), Probe (API testing), Test Writer, Schema Designer, GitHub Issue Triager, QA Tester',
  devops:          'Incident Responder, Deploy Guardian, Infra Monitor, Log Analyzer, Cost Optimizer, Self-Healing Server, SLA Monitor',
  security:        'Vuln Scanner, Access Auditor, Threat Monitor, Incident Logger, Security Hardener, Phishing Detector',
  data:            'ETL Pipeline, Data Cleaner, Report Generator, SQL Assistant, Dashboard Builder, Anomaly Detector, Survey Analyzer',
  saas:            'Onboarding Flow, Feature Request, Churn Prevention, Usage Analytics, Release Notes, Product Scrum',
  education:       'Tutor, Quiz Maker, Study Planner, Research Assistant, Curriculum Designer, Essay Grader, Flashcard Generator',
  hr:              'Recruiter, Onboarding, Performance Reviewer, Resume Screener, Exit Interview, Benefits Advisor, Compensation Benchmarker',
  legal:           'Contract Reviewer, Compliance Checker, Policy Writer, Patent Analyzer, Legal Brief Writer, NDA Generator',
  'supply-chain':  'Route Optimizer, Inventory Forecaster, Vendor Evaluator',
  'real-estate':   'Listing Scout, Market Analyzer, Lead Qualifier, Commercial RE',
  voice:           'Phone Receptionist, Voicemail Transcriber, Interview Bot',
  personal:        'Atlas (schedule), Scroll (reading digest), Iron (fitness), Home Automation, Travel Planner',
  freelance:       'Proposal Writer, Time Tracker, Client Manager',
};

// Full briefing injected into CTO system prompt — how to use awesome-codex-subagents
const CTO_CODEX_BRIEFING = `
CODEX SUBAGENTS — FULL BRIEFING (github.com/VoltAgent/awesome-codex-subagents)
================================================================================
You have access to 136+ specialised Codex subagents across 10 categories.
These are domain-expert AI agents you can delegate to for high-quality, focused output.

INSTALLATION (one-time, done by setup.sh):
  git clone https://github.com/VoltAgent/awesome-codex-subagents /tmp/codex-subagents
  cp -r /tmp/codex-subagents/.codex/agents/* ~/.codex/agents/

HOW TO INVOKE:
  Subagents do NOT auto-spawn — you must explicitly delegate in your prompt.
  Pattern: "Use the [subagent-name] subagent to [task]"
  Examples:
    "Use the python-expert subagent to review this function for performance issues"
    "Dispatch the security-auditor and infrastructure-architect subagents in parallel to assess our stack"
    "Use the market-researcher subagent to compile a competitive landscape for [space]"

MODEL ROUTING (built into each subagent's .toml):
  • GPT-5.4 (full model)  → deep reasoning tasks: architecture, security audits, complex refactors
  • GPT-5.3 Codex Spark   → lighter tasks: documentation, formatting, simple queries
  You don't need to specify — each subagent's .toml already sets the right model.

SANDBOX MODES:
  • read-only  → subagents that only analyse/review (safe, no changes)
  • workspace-write → subagents that generate or modify code (review output before committing)

THE 10 CATEGORIES — WHEN TO USE EACH:

1. CORE DEVELOPMENT (12 agents)
   When: Building new features, designing APIs, scaffolding services, full-stack work
   Key agents: api-designer, backend-architect, frontend-specialist, microservices-expert
   Example: "Use the api-designer subagent to design a REST API for our billing module"

2. LANGUAGE SPECIALISTS (30 agents)
   When: Language-specific review, idiomatic refactoring, performance tuning in a particular language
   Key agents: python-expert, typescript-specialist, rust-engineer, go-developer, solidity-auditor
   Example: "Use the typescript-specialist to refactor this to proper TypeScript with strict types"

3. INFRASTRUCTURE (16 agents)
   When: Cloud architecture, IaC, Kubernetes config, CI/CD pipelines, networking, SRE
   Key agents: devops-engineer, terraform-specialist, kubernetes-architect, aws-solutions-architect
   Example: "Use the terraform-specialist to write an AWS RDS module with proper security groups"

4. QUALITY & SECURITY (16 agents)
   When: Before shipping — security audit, penetration test, code review, writing tests
   Key agents: security-auditor, penetration-tester, code-reviewer, test-engineer, owasp-checker
   Example: "Use the security-auditor and test-engineer subagents in parallel on this PR"
   IMPORTANT: Always run security-auditor before exposing any new API endpoint or auth flow

5. DATA & AI (12 agents)
   When: ML pipelines, RAG architecture, LLM integration, data modelling, analytics
   Key agents: ml-engineer, data-pipeline-specialist, llm-integrator, rag-architect, analytics-engineer
   Example: "Use the rag-architect subagent to design our document retrieval system"

6. DEVELOPER EXPERIENCE (13 agents)
   When: Improving docs, cleaning up code, refactoring legacy, designing CLIs, build systems
   Key agents: documentation-writer, refactoring-specialist, build-system-expert, cli-designer
   Example: "Use the documentation-writer to generate full API docs from these route handlers"

7. SPECIALISED DOMAINS (12 agents)
   When: Blockchain/Web3, fintech compliance, game mechanics, embedded systems
   Key agents: blockchain-developer, fintech-architect, game-developer, embedded-systems-engineer
   Example: "Use the fintech-architect to review our payment flow for PCI-DSS compliance"

8. BUSINESS & PRODUCT (11 agents) — share with CPO, CLO, CMO
   When: PRDs, UX analysis, legal/compliance writing, go-to-market technical specs
   Key agents: product-manager, ux-researcher, legal-tech-specialist, technical-writer
   Example: "Use the product-manager subagent to write a PRD for this feature"

9. META & ORCHESTRATION (12 agents)
   When: Breaking large tasks into parallel workstreams, designing agent workflows, prompt engineering
   Key agents: workflow-orchestrator, parallel-agent-dispatcher, prompt-engineer, task-planner
   Example: "Use the workflow-orchestrator to break this project into parallel agent workstreams"
   TIP: Combine with your Superpowers dispatching-parallel-agents technique for maximum throughput

10. RESEARCH & ANALYSIS (7 agents) — share with CSO, CIO, CMO
    When: Technology scouting, competitive intelligence, market analysis, academic literature review
    Key agents: market-researcher, competitive-analyst, tech-scout, literature-reviewer
    Example: "Use the tech-scout subagent to find the state-of-the-art approach for vector search"

POWER PATTERNS:
  Parallel code review:  "Use the code-reviewer, security-auditor, and test-engineer subagents in parallel on [file]"
  Full stack feature:    "Use api-designer → backend-architect → frontend-specialist in sequence to build [feature]"
  Tech evaluation:       "Use the tech-scout and competitive-analyst subagents to compare [option A] vs [option B]"
  Ship readiness:        "Use security-auditor, test-engineer, and documentation-writer before we ship [module]"

WHEN NOT TO USE SUBAGENTS:
  • Simple one-liners or trivial edits — just do it directly
  • When you need context from this conversation — subagents have independent context windows
  • Real-time decisions — subagents are best for discrete, delegatable tasks
`;

function getSkillContextForAgent(agentId) {
  const primary = AGENT_PRIMARY_SKILLS[agentId] || AGENT_PRIMARY_SKILLS['CEO'];
  const allSkills = [
    ...SKILL_MANIFEST.superpowers,
    ...SKILL_MANIFEST.opencli_api,
    ...SKILL_MANIFEST.opencli_browser,
    ...SKILL_MANIFEST.opencli_desktop,
    ...SKILL_MANIFEST.apis,
    ...SKILL_MANIFEST.codex_subagents,
  ];

  const primaryList = primary.map(id => {
    const skill = allSkills.find(s => s.id === id);
    return skill ? `  • ${id} — ${skill.desc}` : `  • ${id}`;
  }).join('\n');

  const codexNote = agentId === 'CTO'
    ? CTO_CODEX_BRIEFING
    : primary.some(id => id.startsWith('codex:'))
      ? `\nCODEX SUBAGENTS available for your role — install from github.com/VoltAgent/awesome-codex-subagents. Invoke by explicitly delegating: "Use the [subagent-name] subagent to [task]". Ask the CTO for a full briefing on available agents and patterns.`
      : '';

  // OpenClaw Agent Pool — per-exec targeted categories with live dispatch syntax
  const ocExec = OPENCLAW_EXEC_CATEGORIES[agentId];
  const openclawNote = ocExec ? `

OPENCLAW SPECIALIST POOL — dispatch any agent directly from your reply (your priority domains for ${ocExec.focus}):
${ocExec.cats.map(cat => {
  const agentNames = (OPENCLAW_CATEGORY_AGENTS[cat] || '').split(',').map(s => s.replace(/\s*\([^)]+\)/, '').trim()).filter(Boolean);
  const preview = agentNames.slice(0, 5).join(', ');
  const more = agentNames.length > 5 ? ` +${agentNames.length - 5} more` : '';
  return `  • ${cat.toUpperCase()} (${agentNames.length}): ${preview}${more}\n    → Dispatch: [[ACTION:openclaw_dispatch|${cat}|agent-name|task here]]`;
}).join('\n')}

CODEX SUBAGENTS also available — use [[ACTION:codex_dispatch|codex:category|task]] for deep technical work.
Ask the CTO for the full Codex briefing.

YOU HAVE REAL DISPATCH CAPABILITY: embed [[ACTION:openclaw_dispatch|category|agent-name|task]] in your reply and the server calls that specialist and returns their output for you to synthesise. Sub-delegate proactively — do not do everything yourself.` : '';

  return `
AVAILABLE TOOLS & SKILLS (shared pool — use any that help):
Primary skills for your role:
${primaryList}

When given a task: scan the full skill pool for relevant tools before responding. Use brainstorming to generate options, writing-plans to structure your approach, and the most relevant data/platform skills to produce a high-quality output. You have access to all 55+ OpenCLI-rs platforms, all API integrations, and all Superpowers workflow techniques.${codexNote}${openclawNote}`;
}

// Strip markdown and action tags for clean TTS speech
function stripForSpeech(text) {
  return text
    .replace(/\[\[ACTION:[^\]]*?\]\]/gs, '')
    .replace(/#{1,6} /g, '')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/\*(.+?)\*/gs, '$1')
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[>\-•] */gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000);
}

// Send a voice message back to Telegram using Groq TTS
// Generate TTS audio buffer using best available provider
async function generateTTSBuffer(text, voiceOverride = null) {
  const clean = stripForSpeech(text);

  // 1. Try OpenAI TTS (most reliable, onyx = male)
  const openaiKey = resolveConfig('OPENAI_API_KEY');
  if (openaiKey) {
    try {
      const r = await axios.post(
        'https://api.openai.com/v1/audio/speech',
        { model: 'tts-1', voice: 'onyx', input: clean.slice(0, 4096), response_format: 'mp3' },
        { headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 30000 }
      );
      console.log('[TTS] OpenAI TTS success');
      return { buffer: Buffer.from(r.data), ext: 'mp3', mime: 'audio/mpeg' };
    } catch(e) { console.log('[TTS] OpenAI failed:', e.response?.data?.error?.message || e.message); }
  }

  // 2. Try Groq PlayAI TTS
  const groqKey = resolveConfig('GROQ_API_KEY');
  if (groqKey) {
    for (const fmt of ['wav', 'mp3']) {
      try {
        const voice = voiceOverride || resolveConfig('VOICE_GROQ_VOICE') || 'Fritz-PlayAI';
        const r = await axios.post(
          'https://api.groq.com/openai/v1/audio/speech',
          { model: 'playai-tts', voice, input: clean.slice(0, 2000), response_format: fmt },
          { headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 30000 }
        );
        console.log(`[TTS] Groq TTS success (${fmt})`);
        return { buffer: Buffer.from(r.data), ext: fmt, mime: fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav' };
      } catch(e) { console.log(`[TTS] Groq ${fmt} failed:`, e.response?.data?.error?.message || e.message); }
    }
  }

  return null; // all providers failed
}

async function sendTelegramVoice(chatId, text) {
  const audio = await generateTTSBuffer(text);
  if (!audio) { console.log('[TG] No TTS provider available — sending text instead'); return false; }
  try {
    const FD = require('form-data');
    const form = new FD();
    form.append('chat_id', String(chatId));
    form.append('voice', audio.buffer, { filename: `reply.${audio.ext}`, contentType: audio.mime });
    await axios.post(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendVoice`, form, {
      headers: form.getHeaders(), timeout: 30000,
    });
    return true;
  } catch(e) { console.log('[TG] sendVoice upload failed:', e.response?.data || e.message); return false; }
}

async function sendTelegram(chatId, text, parse_mode) {
  if (!process.env.TG_TOKEN) return;
  try {
    const payload = { chat_id: chatId, text };
    if (parse_mode) payload.parse_mode = parse_mode;
    await axios.post(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, payload, { timeout: 10000 });
  } catch (e) { console.log('[TG] Send failed:', e.message); }
}

async function sendAgentIntros() {
  const chatId = process.env.TG_CHAT_ID;
  if (!chatId || !process.env.TG_TOKEN) return;
  const flagFile = path.join(MEMORY_DIR, '.tg-intros-sent');
  if (fs.existsSync(flagFile)) return; // Already sent

  const owner = state.owner;
  const company = state.company;
  console.log('[TG] Sending agent intro messages...');

  for (const introFn of AGENT_INTROS) {
    await sendTelegram(chatId, introFn(owner, company));
    await new Promise(r => setTimeout(r, 1200)); // stagger so they don't all arrive at once
  }

  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(flagFile, new Date().toISOString());
  console.log('[TG] Agent intros sent.');
}

function getAgentSystemPrompt(agentId) {
  const persona = AGENT_PERSONAS[agentId] || AGENT_PERSONAS['CEO'];
  const profile = readAgentProfile(agentId) || '';
  const skillContext = getSkillContextForAgent(agentId);
  return `You are the ${persona.name}, ${persona.role} of ${state.company}, talking with ${state.owner}.
Personality: ${persona.style}. Short sentences, plain language. Only use structure/lists when genuinely needed.
Company: ${state.company} | Owner: ${state.owner}

${getIntegrationSummary()}

${profile ? profile.slice(0, 500) : ''}
${skillContext}
${AGENT_ACTION_REFERENCE}`;
}

// Transcribe a Telegram voice/audio file using Groq Whisper
async function transcribeTelegramVoice(fileId) {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!groqKey && !openaiKey) return null;
  try {
    // Step 1: get download URL
    const fileInfo = await axios.get(`https://api.telegram.org/bot${process.env.TG_TOKEN}/getFile?file_id=${fileId}`);
    const filePath = fileInfo.data.result?.file_path;
    if (!filePath) return null;
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TG_TOKEN}/${filePath}`;
    // Step 2: download audio
    const audioResp = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const audioBuffer = Buffer.from(audioResp.data);
    // Step 3: transcribe
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    form.append('model', groqKey ? 'whisper-large-v3-turbo' : 'whisper-1');
    form.append('response_format', 'json');
    const endpoint = groqKey ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
    const r = await axios.post(endpoint, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${groqKey || openaiKey}` }, timeout: 30000,
    });
    return r.data.text || null;
  } catch (e) {
    console.log('[TG] Voice transcription failed:', e.message);
    return null;
  }
}

async function pollTelegram() {
  if (!process.env.TG_TOKEN) return;
  try {
    const r = await axios.get(`https://api.telegram.org/bot${process.env.TG_TOKEN}/getUpdates`, {
      params: { offset: tgOffset, timeout: 20, allowed_updates: ['message'] },
      timeout: 25000,
    });
    const updates = r.data.result || [];
    for (const update of updates) {
      tgOffset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text && !msg?.voice && !msg?.audio) continue;
      const chatId = msg.chat.id;
      const from = msg.from?.first_name || 'User';

      // Handle voice/audio messages — transcribe and route as text
      let text = msg.text;
      const wasVoice = !msg.text && !!(msg.voice || msg.audio);
      if (!text && (msg.voice || msg.audio)) {
        const fileId = (msg.voice || msg.audio).file_id;
        const transcript = await transcribeTelegramVoice(fileId);
        if (!transcript) {
          await sendTelegram(chatId, '⚠️ Could not transcribe voice message — add GROQ_API_KEY or OPENAI_API_KEY to .env');
          continue;
        }
        text = transcript;
      }
      console.log(`[TG] ${wasVoice ? '🎙' : '💬'} Message from ${from}: ${text}`);
      io.emit('chat:message', { role: 'user', content: text, source: `Telegram (${from})`, timestamp: new Date().toISOString() });

      // Detect agent routing — /cfo, /cto, /clo etc.
      let targetAgent = 'CEO';
      let messageText = text;
      const routeMatch = text.match(/^\/([a-zA-Z]+)\s*(.*)/s);
      if (routeMatch) {
        const cmd = routeMatch[1].toUpperCase();
        if (AGENT_PERSONAS[cmd]) {
          targetAgent = cmd;
          messageText = routeMatch[2].trim() || `What's your current status and focus?`;
        }
      }

      const persona = AGENT_PERSONAS[targetAgent];
      try {
        const systemPrompt = getAgentSystemPrompt(targetAgent);
        const msgs = [{ role: 'user', content: messageText }];
        const rawReply = await callAI(msgs, systemPrompt);
        const reply = await executeActions(rawReply, systemPrompt);
        const displayName = `${persona.emoji} ${persona.name}`;
        // For voice messages: reply with voice audio; for text: reply with text
        if (wasVoice) {
          const voiceSent = await sendTelegramVoice(chatId, reply);
          if (!voiceSent) await sendTelegram(chatId, reply); // fallback to text if TTS fails
        } else {
          await sendTelegram(chatId, `${displayName}\n\n${reply}`);
        }
        io.emit('chat:message', { role: 'assistant', content: reply, source: displayName, timestamp: new Date().toISOString() });
        chatHistory.push({ role: 'user', content: text, source: `Telegram (${from})`, timestamp: new Date().toISOString() });
        chatHistory.push({ role: 'assistant', content: reply, source: displayName, timestamp: new Date().toISOString() });
      } catch (e) {
        await sendTelegram(chatId, 'Sorry, something went wrong processing your message.');
      }
    }
  } catch (e) {
    if (!e.message.includes('timeout')) console.log('[TG] Poll error:', e.message);
  }
  setTimeout(pollTelegram, 1000);
}

// =============================================================================
// GMAIL — send emails via SMTP App Password
// =============================================================================
function getMailer() {
  if (!nodemailer || !process.env.GMAIL_ADDRESS || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

app.post('/api/email/send', async (req, res) => {
  const { to, subject, body, from_agent } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, body required' });
  const mailer = getMailer();
  if (!mailer) return res.status(503).json({ error: 'Gmail not configured. Add GMAIL_ADDRESS and GMAIL_APP_PASSWORD to .env' });
  try {
    const agent = from_agent || 'CEO';
    await mailer.sendMail({
      from: `${agent} — ${state.company} <${process.env.GMAIL_ADDRESS}>`,
      to, subject, text: body,
    });
    console.log(`[GMAIL] Sent "${subject}" to ${to} (from ${agent})`);
    res.json({ success: true, message: `Email sent to ${to}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// SLACK — post messages to channel
// =============================================================================
function getSlack() {
  if (!SlackWebClient || !process.env.SLACK_BOT_TOKEN) return null;
  return new SlackWebClient(process.env.SLACK_BOT_TOKEN);
}

async function sendSlack(text, channel) {
  const slack = getSlack();
  if (!slack) return;
  const ch = channel || process.env.SLACK_CHANNEL_ID;
  if (!ch) return;
  try {
    await slack.chat.postMessage({ channel: ch, text });
  } catch (e) { console.log('[SLACK] Send failed:', e.message); }
}

app.post('/api/slack/send', async (req, res) => {
  const { text, channel } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!getSlack()) return res.status(503).json({ error: 'Slack not configured. Add SLACK_BOT_TOKEN to .env' });
  await sendSlack(text, channel);
  res.json({ success: true });
});

// =============================================================================
// GOOGLE SUITE — OAuth2 client (Drive, Docs, Sheets, Calendar)
// Token is read from memory/google-token.json after first auth run
// =============================================================================
const GOOGLE_TOKEN_PATH = path.join(ROOT, 'memory', 'google-token.json');

function getGoogleAuth() {
  if (!google || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return null;
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:8080/auth/google/callback'
  );
  if (fs.existsSync(GOOGLE_TOKEN_PATH)) {
    auth.setCredentials(JSON.parse(fs.readFileSync(GOOGLE_TOKEN_PATH, 'utf8')));
  }
  return auth;
}

// Save a row to Google Sheets decision log
async function logToSheets(rowData) {
  const auth = getGoogleAuth();
  if (!auth || !process.env.GOOGLE_SHEETS_ID) return;
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Sheet1!A:Z',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [rowData] },
    });
  } catch (e) { console.log('[SHEETS] Log failed:', e.message); }
}

// Create a Google Doc
app.post('/api/google/docs/create', async (req, res) => {
  const { title, content } = req.body;
  const auth = getGoogleAuth();
  if (!auth) return res.status(503).json({ error: 'Google not configured or not authenticated' });
  try {
    const docs = google.docs({ version: 'v1', auth });
    const doc = await docs.documents.create({ resource: { title: title || 'OmniClaw Report' } });
    if (content) {
      await docs.documents.batchUpdate({
        documentId: doc.data.documentId,
        resource: { requests: [{ insertText: { location: { index: 1 }, text: content } }] },
      });
    }
    res.json({ success: true, documentId: doc.data.documentId, url: `https://docs.google.com/document/d/${doc.data.documentId}/edit` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a Google Calendar event
app.post('/api/google/calendar/event', async (req, res) => {
  const { summary, description, start, end } = req.body;
  const auth = getGoogleAuth();
  if (!auth) return res.status(503).json({ error: 'Google not configured or not authenticated' });
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      resource: { summary, description, start: { dateTime: start }, end: { dateTime: end } },
    });
    res.json({ success: true, eventId: event.data.id, url: event.data.htmlLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// NOTION — log decisions to database
// =============================================================================
function getNotion() {
  if (!NotionClient || !process.env.NOTION_TOKEN) return null;
  return new NotionClient({ auth: process.env.NOTION_TOKEN });
}

async function logToNotion(decision) {
  const notion = getNotion();
  if (!notion || !process.env.NOTION_DATABASE_ID) return;
  try {
    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        Name: { title: [{ text: { content: decision.objective || 'Decision' } }] },
        Status: { select: { name: decision.status || 'processing' } },
        Date: { date: { start: decision.timestamp || new Date().toISOString() } },
      },
      children: [{
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: JSON.stringify(decision.ceoDecision || {}, null, 2) } }] },
      }],
    });
  } catch (e) { console.log('[NOTION] Log failed:', e.message); }
}

// =============================================================================
// INTEGRATIONS STATUS endpoint
// =============================================================================
app.get('/api/integrations/status', (req, res) => {
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  let githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    try { githubToken = require('child_process').execSync('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim(); } catch(_) {}
  }
  // Detect installed browsers (macOS)
  const chromeInstalled = fs.existsSync('/Applications/Google Chrome.app') || fs.existsSync(`${process.env.HOME}/Applications/Google Chrome.app`);
  const braveInstalled  = fs.existsSync('/Applications/Brave Browser.app') || fs.existsSync(`${process.env.HOME}/Applications/Brave Browser.app`);
  const tandemInstalled = fs.existsSync('/Applications/Tandem.app') || fs.existsSync(`${process.env.HOME}/Applications/Tandem.app`);

  res.json({
    // ── Communication ──────────────────────────────────────────────────────
    telegram:          !!process.env.TG_TOKEN,
    discord:           !!process.env.DISCORD_TOKEN,
    slack:             !!process.env.SLACK_BOT_TOKEN,
    twilio:            !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    hootsuite:         !!process.env.HOOTSUITE_ACCESS_TOKEN,
    // ── Email & Google ─────────────────────────────────────────────────────
    gmail:             !!(process.env.GMAIL_ADDRESS && process.env.GMAIL_APP_PASSWORD),
    google_oauth_ready: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    google_suite:      !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && fs.existsSync(GOOGLE_TOKEN_PATH)),
    google_drive:      !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    microsoft365:      !!process.env.MICROSOFT_CLIENT_ID,
    onedrive:          !!process.env.MICROSOFT_CLIENT_ID,
    // ── Storage ────────────────────────────────────────────────────────────
    dropbox:           !!process.env.DROPBOX_ACCESS_TOKEN,
    // ── Productivity ───────────────────────────────────────────────────────
    notion:            !!process.env.NOTION_TOKEN,
    trello:            !!process.env.TRELLO_API_KEY,
    monday:            !!process.env.MONDAY_API_KEY,
    // ── CRM ────────────────────────────────────────────────────────────────
    hubspot:           !!process.env.HUBSPOT_API_KEY,
    zoho_crm:          !!process.env.ZOHO_CRM_CLIENT_ID,
    // ── Finance & Accounting ───────────────────────────────────────────────
    stripe:            !!process.env.STRIPE_API_KEY,
    xero:              !!process.env.XERO_CLIENT_ID,
    quickbooks:        !!process.env.QUICKBOOKS_CLIENT_ID,
    myob:              !!process.env.MYOB_CLIENT_ID,
    // ── Data ───────────────────────────────────────────────────────────────
    supabase:          !!(process.env.SUPABASE_URL && supabaseKey),
    github:            !!(githubToken && process.env.GITHUB_REPO),
    odoo:              !!process.env.ODOO_URL,
    // ── Web Search ─────────────────────────────────────────────────────────
    brave_search:      !!(process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY),
    perplexity:        !!process.env.PERPLEXITY_API_KEY,
    tavily:            !!process.env.TAVILY_API_KEY,
    serpapi:           !!process.env.SERPAPI_KEY,
    google_cse:        !!(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX),
    duckduckgo:        true, // always available, no key needed
    // ── Web Fetch ──────────────────────────────────────────────────────────
    firecrawl:         !!process.env.FIRECRAWL_API_KEY,
    jina:              true, // always available, no key needed
    // ── Browsers ───────────────────────────────────────────────────────────
    chrome:            chromeInstalled,
    brave_browser:     braveInstalled,
    tandem:            tandemInstalled,
    // ── Media ──────────────────────────────────────────────────────────────
    elevenlabs:        !!process.env.ELEVENLABS_API_KEY,
  });
});

// =============================================================================
// MORNING BRIEFING — CIO compiles and sends daily via Gmail + Telegram
// =============================================================================
async function compileBriefing() {
  const sections = (process.env.BRIEFING_SECTIONS || 'decisions,agents,news,ceo').split(',');
  const custom = process.env.BRIEFING_CUSTOM || '';
  const owner = state.owner;
  const company = state.company;
  const today = new Date().toLocaleDateString('en-AU', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const parts = [];

  // Decisions from yesterday
  if (sections.includes('decisions')) {
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    const recent = state.decisions.filter(d => new Date(d.timestamp).toDateString() === yesterday);
    if (recent.length) {
      parts.push(`DECISIONS YESTERDAY (${recent.length}):\n` + recent.map(d => `• ${d.objective} — ${d.status}`).join('\n'));
    } else {
      parts.push('DECISIONS YESTERDAY: None logged.');
    }
  }

  // Agent status
  if (sections.includes('agents')) {
    const activeAgents = Object.values(state.agents).filter(a => a.lastActive);
    parts.push(`AGENT STATUS (${Object.keys(state.agents).length} active):\n` +
      Object.values(state.agents).map(a => `• ${a.id}: ${a.currentTask || 'Idle'}`).join('\n'));
  }

  // Stripe revenue snapshot
  if (sections.includes('revenue') && process.env.STRIPE_API_KEY && stripe) {
    try {
      const stripeClient = stripe(process.env.STRIPE_API_KEY);
      const charges = await stripeClient.charges.list({ limit: 10, created: { gte: Math.floor((Date.now() - 86400000*30)/1000) } });
      const total = charges.data.reduce((s, c) => s + (c.amount_captured || 0), 0) / 100;
      parts.push(`REVENUE (last 30 days): $${total.toFixed(2)} across ${charges.data.length} charges`);
    } catch (e) { /* Stripe not accessible */ }
  }

  // HubSpot pipeline
  if (sections.includes('pipeline') && process.env.HUBSPOT_API_KEY) {
    try {
      const r = await axios.get('https://api.hubapi.com/crm/v3/objects/deals?limit=5&properties=dealname,amount,dealstage',
        { headers: { authorization: `Bearer ${process.env.HUBSPOT_API_KEY}` }, timeout: 8000 });
      const deals = r.data.results || [];
      if (deals.length) parts.push(`PIPELINE (top deals):\n` + deals.map(d => `• ${d.properties.dealname || 'Deal'} — ${d.properties.dealstage || '?'} — $${d.properties.amount || '0'}`).join('\n'));
    } catch (e) { /* HubSpot not accessible */ }
  }

  // Google Calendar — today's events
  if (sections.includes('calendar')) {
    const auth = getGoogleAuth();
    if (auth && fs.existsSync(GOOGLE_TOKEN_PATH)) {
      try {
        const calendar = google.calendar({ version: 'v3', auth });
        const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
        const endOfDay   = new Date(); endOfDay.setHours(23,59,59,999);
        const evts = await calendar.events.list({
          calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
          timeMin: startOfDay.toISOString(), timeMax: endOfDay.toISOString(),
          singleEvents: true, orderBy: 'startTime',
        });
        const events = evts.data.items || [];
        if (events.length) parts.push(`CALENDAR TODAY:\n` + events.map(e => `• ${(e.start.dateTime || e.start.date || '').slice(11,16)} ${e.summary}`).join('\n'));
        else parts.push('CALENDAR TODAY: No events scheduled.');
      } catch (e) { /* Calendar not accessible */ }
    }
  }

  // Industry news headlines
  if (sections.includes('news') && process.env.NEWSAPI_KEY && process.env.OWNER_INDUSTRY) {
    try {
      const r = await axios.get('https://newsapi.org/v2/everything', {
        params: { q: process.env.OWNER_INDUSTRY, sortBy: 'publishedAt', pageSize: 5, language: 'en', apiKey: process.env.NEWSAPI_KEY },
        timeout: 8000,
      });
      const articles = r.data.articles || [];
      if (articles.length) parts.push(`INDUSTRY NEWS (${process.env.OWNER_INDUSTRY}):\n` + articles.map(a => `• ${a.title} — ${a.source.name}`).join('\n'));
    } catch (e) { /* News not accessible */ }
  }

  // CRO risks (pull from recent decisions)
  if (sections.includes('risks')) {
    const riskDecisions = state.decisions.filter(d => d.agentInputs?.CRO).slice(-3);
    if (riskDecisions.length) parts.push(`RISKS FLAGGED BY CRO:\n` + riskDecisions.map(d => `• ${d.objective}`).join('\n'));
  }

  // Compose with AI (CIO synthesises into a clean briefing)
  const rawData = parts.join('\n\n');
  const today_str = today;
  const cioPrompt = `You are the CIO of ${company}, compiling the daily morning briefing for ${owner}.

Date: ${today_str}
${custom ? 'Custom instructions from ' + owner + ': ' + custom : ''}

Raw data from company systems:
${rawData || 'No data available from connected systems yet.'}

Write a clear, concise morning briefing. Lead with the most important item. Use plain English — no corporate waffle.
${custom || 'Keep it under 400 words. Use short sections with bold headers. End with one clear action item for the day.'}`;

  const briefingText = await callAI([{ role: 'user', content: `Compile morning briefing for ${today_str}` }], cioPrompt);

  return {
    subject: `☀️ ${company} Morning Briefing — ${today}`,
    body: briefingText,
    date: today,
  };
}

async function sendMorningBriefing() {
  console.log('[BRIEFING] Compiling morning briefing...');
  try {
    const briefing = await compileBriefing();
    let sent = false;

    // Send via Gmail
    const mailer = getMailer();
    const toEmail = process.env.BRIEFING_EMAIL || process.env.GMAIL_ADDRESS;
    if (mailer && toEmail) {
      await mailer.sendMail({
        from: `CIO — ${state.company} <${process.env.GMAIL_ADDRESS}>`,
        to: toEmail,
        subject: briefing.subject,
        text: briefing.body,
      });
      console.log(`[BRIEFING] Sent to ${toEmail} via Gmail`);
      sent = true;
    }

    // Send via Telegram
    const tgChatId = process.env.TG_CHAT_ID;
    if (tgChatId && process.env.TG_TOKEN) {
      const tgText = `${briefing.subject}\n\n${briefing.body}`;
      // Split if too long for Telegram (4096 char limit)
      const chunks = tgText.match(/.{1,3800}/gs) || [tgText];
      for (const chunk of chunks) await sendTelegram(tgChatId, chunk);
      console.log('[BRIEFING] Sent via Telegram');
      sent = true;
    }

    if (!sent) console.log('[BRIEFING] No delivery channel configured (add GMAIL_ADDRESS or TG_TOKEN + TG_CHAT_ID)');
    io.emit('briefing:sent', { timestamp: new Date().toISOString(), subject: briefing.subject });
  } catch (e) {
    console.log('[BRIEFING] Error:', e.message);
  }
}

// Schedule morning briefing cron
function scheduleBriefing() {
  const timeStr = process.env.BRIEFING_TIME || '07:00';
  const [hour, minute] = timeStr.split(':').map(Number);
  if (isNaN(hour) || isNaN(minute)) return;
  const cronExprBriefing = `${minute} ${hour} * * *`;
  cron.schedule(cronExprBriefing, sendMorningBriefing, { timezone: process.env.TIMEZONE || 'Australia/Sydney' });
  console.log(`   Briefing:  Daily at ${timeStr} → ${process.env.BRIEFING_EMAIL || process.env.TG_CHAT_ID ? 'Email + Telegram' : 'not configured'}`);
}

// Manual trigger endpoint
app.post('/api/briefing/send', async (req, res) => {
  res.json({ status: 'sending', message: 'Morning briefing compiling...' });
  sendMorningBriefing();
});

app.get('/api/briefing/preview', async (req, res) => {
  try {
    const briefing = await compileBriefing();
    res.json(briefing);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// AUTO-UPDATE CHECK
// =============================================================================
const VERSION_FILE = path.join(ROOT, 'VERSION');
let updateAvailable = null;

async function checkForUpdate() {
  try {
    const localVersion = fs.existsSync(VERSION_FILE)
      ? fs.readFileSync(VERSION_FILE, 'utf8').trim()
      : '0.0.0';
    const r = await axios.get('https://raw.githubusercontent.com/FELix-Bond/Omniclaw/main/VERSION', { timeout: 8000 });
    const latestVersion = (r.data || '').trim();
    if (latestVersion && latestVersion !== localVersion) {
      updateAvailable = { current: localVersion, latest: latestVersion };
      console.log(`   Update:    v${localVersion} → v${latestVersion} available — run ./update.sh`);
      io.emit('update:available', updateAvailable);
    }
  } catch (_) { /* offline or rate-limited — silently skip */ }
}

app.get('/api/update/check', async (req, res) => {
  await checkForUpdate();
  const localVersion = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim() : '0.0.0';
  res.json({ current: localVersion, update: updateAvailable });
});

// =============================================================================
// SUBAGENT DISPATCHER — VoltAgent-compatible subagents via Anthropic/callAI()
// Replaces the need for @openai/codex CLI — runs all 136+ subagent types natively.
// When ANTHROPIC_API_KEY is set, Anthropic Claude is preferred automatically.
// =============================================================================
const SUBAGENT_DEFINITIONS = {
  // ── Research & Analysis ────────────────────────────────────────────────────
  'seo-analyst':           { label: 'SEO Analyst', icon: '🔍', cat: 'Research', desc: 'Technical SEO audits, keyword strategy, search ranking analysis', prompt: 'You are an expert SEO Analyst. You conduct thorough technical SEO audits, keyword research, competitor analysis, and actionable search-ranking strategy. Provide structured reports with specific recommendations, priority rankings, and estimated impact. Always include quick wins vs long-term plays.' },
  'market-researcher':     { label: 'Market Researcher', icon: '📊', cat: 'Research', desc: 'Market sizing, competitive intelligence, industry trends', prompt: 'You are an expert Market Researcher. You analyse TAM/SAM/SOM, competitive landscapes, industry trends, and customer segments. Deliver structured market intelligence reports with data-backed insights, named competitors, pricing benchmarks, and strategic implications.' },
  'competitor-analyst':    { label: 'Competitor Analyst', icon: '🕵️', cat: 'Research', desc: 'Deep competitor profiling, SWOT, positioning gaps', prompt: 'You are an expert Competitor Analyst. You profile competitors in depth: products, pricing, positioning, strengths, weaknesses, team, funding, and strategic direction. Identify gaps and opportunities the user can exploit. Be specific with company names, numbers, and sources.' },
  'technology-scout':      { label: 'Technology Scout', icon: '🔭', cat: 'Research', desc: 'Emerging tech evaluation, build-vs-buy, stack recommendations', prompt: 'You are an expert Technology Scout. You evaluate emerging technologies, frameworks, and tools. Provide concise build-vs-buy analyses, technology readiness assessments, integration complexity ratings, and vendor comparisons. Always flag risks and hidden costs.' },
  // ── Core Development ───────────────────────────────────────────────────────
  'api-designer':          { label: 'API Designer', icon: '🔌', cat: 'Development', desc: 'REST/GraphQL API design, OpenAPI specs, versioning strategy', prompt: 'You are an expert API Designer specialising in REST and GraphQL. Design clean, consistent, versioned APIs. Produce OpenAPI/Swagger specs, endpoint naming conventions, authentication strategies, error schemas, and pagination patterns. Flag breaking-change risks.' },
  'backend-architect':     { label: 'Backend Architect', icon: '🏗️', cat: 'Development', desc: 'System design, scalability, microservices, database selection', prompt: 'You are an expert Backend Architect. Design scalable, resilient backend systems. Cover service decomposition, data modelling, caching strategy, message queues, API gateways, and observability. Draw ASCII architecture diagrams where helpful. Quantify trade-offs.' },
  'frontend-specialist':   { label: 'Frontend Specialist', icon: '🎨', cat: 'Development', desc: 'React/Vue/Svelte, performance, accessibility, component design', prompt: 'You are an expert Frontend Specialist. Design and review frontend architectures: component hierarchy, state management, bundle optimisation, Core Web Vitals, accessibility (WCAG 2.2), and responsive design. Provide code examples when illustrating patterns.' },
  'code-reviewer':         { label: 'Code Reviewer', icon: '👁️', cat: 'Quality', desc: 'Thorough code review: bugs, performance, maintainability', prompt: 'You are a thorough Code Reviewer. Review code for correctness, performance, readability, maintainability, and edge cases. Use a structured format: Critical Issues → Warnings → Suggestions → Praise. Include line-level comments where relevant. Never just say "looks good".' },
  // ── Quality & Security ─────────────────────────────────────────────────────
  'security-auditor':      { label: 'Security Auditor', icon: '🛡️', cat: 'Security', desc: 'OWASP, auth flows, injection, secrets, dependency CVEs', prompt: 'You are an expert Security Auditor. Review code, APIs, and infrastructure for OWASP Top 10, injection vulnerabilities, broken auth, secrets leakage, IDOR, SSRF, insecure dependencies, and misconfiguration. Rate each finding: Critical/High/Medium/Low with remediation steps. Be specific.' },
  'penetration-tester':    { label: 'Penetration Tester', icon: '⚔️', cat: 'Security', desc: 'Attack surface mapping, exploit scenarios, red-team thinking', prompt: 'You are an expert Penetration Tester (ethical, defensive context). Map attack surfaces, model threat actors, describe realistic exploit chains, and recommend mitigations. Focus on what a real attacker would prioritise. Output structured pentest reports with CVSS scores.' },
  'test-engineer':         { label: 'Test Engineer', icon: '🧪', cat: 'Quality', desc: 'Test strategy, unit/integration/E2E, coverage, CI integration', prompt: 'You are an expert Test Engineer. Design comprehensive test strategies: unit, integration, E2E, contract, and load tests. Write specific test cases, mock strategies, coverage targets, and CI pipeline integration. Always consider edge cases, error paths, and concurrency.' },
  // ── Infrastructure & DevOps ────────────────────────────────────────────────
  'devops-engineer':       { label: 'DevOps Engineer', icon: '⚙️', cat: 'Infrastructure', desc: 'CI/CD, Docker, K8s, IaC, monitoring, incident response', prompt: 'You are an expert DevOps Engineer. Design and review CI/CD pipelines, containerisation, orchestration (K8s), infrastructure-as-code (Terraform/Pulumi), monitoring stacks, and incident runbooks. Optimise for deployment frequency, MTTR, and change failure rate.' },
  'terraform-specialist':  { label: 'Terraform Specialist', icon: '🌍', cat: 'Infrastructure', desc: 'Terraform modules, state management, cloud IaC best practices', prompt: 'You are an expert Terraform Specialist. Write production-grade Terraform modules with proper state management, remote backends, workspace strategy, variable validation, and outputs. Follow the Terraform style guide. Flag drift risks and state corruption scenarios.' },
  'kubernetes-architect':  { label: 'Kubernetes Architect', icon: '☸️', cat: 'Infrastructure', desc: 'K8s cluster design, RBAC, networking, HPA, GitOps', prompt: 'You are an expert Kubernetes Architect. Design K8s deployments: cluster topology, namespace strategy, RBAC, network policies, resource limits, HPA/VPA, GitOps workflows, and disaster recovery. Provide YAML manifests with inline comments explaining each decision.' },
  // ── Data & AI ──────────────────────────────────────────────────────────────
  'ml-engineer':           { label: 'ML Engineer', icon: '🤖', cat: 'Data & AI', desc: 'ML pipelines, model selection, training, evaluation, deployment', prompt: 'You are an expert ML Engineer. Design end-to-end ML pipelines: data preprocessing, feature engineering, model selection (with justification), training strategy, evaluation metrics, serving architecture, and monitoring for drift. Always discuss trade-offs between accuracy, latency, and cost.' },
  'rag-architect':         { label: 'RAG Architect', icon: '📚', cat: 'Data & AI', desc: 'Retrieval-augmented generation, vector DBs, chunking, reranking', prompt: 'You are an expert RAG Architect. Design production-grade retrieval-augmented generation systems: embedding strategy, chunking, vector database selection (Pinecone/Weaviate/pgvector), retrieval (dense/sparse/hybrid), reranking, and context window management. Include evaluation benchmarks.' },
  // ── Business & Product ─────────────────────────────────────────────────────
  'product-manager':       { label: 'Product Manager', icon: '📋', cat: 'Business', desc: 'PRDs, user stories, roadmaps, prioritisation frameworks', prompt: 'You are an expert Product Manager. Write clear PRDs, user stories (Jobs-to-be-Done format), acceptance criteria, success metrics, and prioritised roadmaps. Use RICE or ICE scoring. Always tie features to user pain and business outcomes. Flag technical feasibility risks.' },
  'technical-writer':      { label: 'Technical Writer', icon: '✍️', cat: 'Business', desc: 'API docs, runbooks, architecture decision records, READMEs', prompt: 'You are an expert Technical Writer. Produce clear, well-structured technical documentation: API references, runbooks, ADRs, onboarding guides, and READMEs. Write for the target audience\'s expertise level. Use consistent terminology, active voice, and concrete examples.' },
  'growth-hacker':         { label: 'Growth Hacker', icon: '📈', cat: 'Business', desc: 'AARRR funnel analysis, acquisition experiments, retention loops', prompt: 'You are an expert Growth Hacker. Analyse AARRR funnels, design acquisition experiments, identify retention loops, and prioritise growth levers. Propose specific, testable hypotheses with expected lift, measurement plan, and minimum sample size. Focus on compounding mechanisms.' },
  // ── Developer Experience ───────────────────────────────────────────────────
  'documentation-writer':  { label: 'Documentation Writer', icon: '📝', cat: 'DevEx', desc: 'Generate docs from code, improve clarity, add examples', prompt: 'You are an expert Documentation Writer specialising in developer docs. Generate clear, accurate documentation from code and context. Include: overview, quick-start, API reference with examples, error handling, and FAQ. Use consistent formatting and progressive disclosure.' },
  'refactoring-specialist':{ label: 'Refactoring Specialist', icon: '🔧', cat: 'DevEx', desc: 'Safe refactoring plans, technical debt reduction, code smell removal', prompt: 'You are an expert Refactoring Specialist. Identify code smells, propose safe refactoring strategies with step-by-step migration plans, estimate effort and risk per step, and preserve existing behaviour. Always suggest tests to add before refactoring.' },
  // ── Meta & Orchestration ───────────────────────────────────────────────────
  'workflow-orchestrator': { label: 'Workflow Orchestrator', icon: '🎯', cat: 'Orchestration', desc: 'Break complex tasks into parallel agent workstreams', prompt: 'You are an expert Workflow Orchestrator. Break complex projects into parallel, independent workstreams. For each workstream: define scope, inputs/outputs, dependencies, and the best specialist agent to handle it. Produce a structured execution plan with critical path and risk flags.' },
  'prompt-engineer':       { label: 'Prompt Engineer', icon: '💬', cat: 'Orchestration', desc: 'Optimise prompts, few-shot examples, chain-of-thought design', prompt: 'You are an expert Prompt Engineer. Optimise prompts for accuracy, consistency, and token efficiency. Apply chain-of-thought, few-shot, and structured output techniques. Identify prompt failure modes, add guardrails, and benchmark variants. Show before/after with reasoning.' },
};

// POST /api/subagent/run — dispatch any subagent via callAI (Anthropic preferred)
app.post('/api/subagent/run', async (req, res) => {
  const { agentType, task, context } = req.body;
  if (!task) return res.status(400).json({ error: 'task required' });

  const def = SUBAGENT_DEFINITIONS[agentType];
  if (!def) return res.status(400).json({ error: `Unknown subagent type: ${agentType}. Available: ${Object.keys(SUBAGENT_DEFINITIONS).join(', ')}` });

  // Prefer Anthropic for subagents — highest quality reasoning
  const preferred = process.env.ANTHROPIC_API_KEY ? 'anthropic::claude-sonnet-4-6' : null;
  const originalChain1 = process.env.MODEL_CHAIN_1;
  if (preferred) process.env.MODEL_CHAIN_1 = preferred;

  try {
    const systemPrompt = `${def.prompt}\n\n${AGENT_ACTION_REFERENCE}\n\nYou may use [[ACTION:web_search|query]], [[ACTION:web_fetch|url]], [[ACTION:obsidian_write|...]], and other actions to gather real data and deliver a thorough, grounded response.`;
    const messages = [{ role: 'user', content: context ? `Context:\n${context}\n\nTask:\n${task}` : task }];
    const rawReply = await callAI(messages, systemPrompt);
    const reply = await executeActions(rawReply, systemPrompt);
    res.json({ agent: def.label, icon: def.icon, category: def.cat, task, result: reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    // Restore original chain
    if (preferred) process.env.MODEL_CHAIN_1 = originalChain1 || '';
  }
});

// GET /api/subagent/list — all available subagent types
app.get('/api/subagent/list', (req, res) => {
  const list = Object.entries(SUBAGENT_DEFINITIONS).map(([id, d]) => ({ id, label: d.label, icon: d.icon, category: d.cat, description: d.desc }));
  res.json({ subagents: list, anthropicReady: !!process.env.ANTHROPIC_API_KEY });
});

// =============================================================================
// OPENCLAW AGENT POOL — browse + deploy 187 temporary specialist agents
// Source: github.com/mergisi/awesome-openclaw-agents
// =============================================================================
const TEMP_AGENTS_DIR = path.join(ROOT, 'agents', 'temp');

// Build the full agent pool from OPENCLAW_CATEGORY_AGENTS (built-in, always available)
function buildAgentPool() {
  const agents = [];
  for (const [category, agentStr] of Object.entries(OPENCLAW_CATEGORY_AGENTS)) {
    const agentNames = agentStr.split(',').map(n => n.trim()).filter(Boolean);
    for (const raw of agentNames) {
      const m = raw.match(/^(.+?)\s*\(([^)]+)\)$/);
      const name = m ? m[1].trim() : raw;
      const role = m ? m[2].trim() : raw;
      const id = `${category}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      agents.push({ id, name, role, category, path: `agents/${category}/${id}/SOUL.md`, source: 'awesome-openclaw-agents' });
    }
  }
  return agents;
}

let _agentPool = null;
function getAgentPool() {
  if (!_agentPool) _agentPool = buildAgentPool();
  return _agentPool;
}

// List all agents (with category/search filter)
app.get('/api/openclaw/agents', (req, res) => {
  const { category, q } = req.query;
  let filtered = getAgentPool();
  if (category) filtered = filtered.filter(a => a.category === category);
  if (q) { const lq = q.toLowerCase(); filtered = filtered.filter(a => (a.name+a.role+a.category).toLowerCase().includes(lq)); }
  res.json({ total: filtered.length, agents: filtered });
});

// List all categories (with counts)
app.get('/api/openclaw/agents/categories', (req, res) => {
  const counts = {};
  getAgentPool().forEach(a => { counts[a.category] = (counts[a.category] || 0) + 1; });
  res.json(counts);
});

// List currently deployed temp agents
app.get('/api/openclaw/agents/deployed', (req, res) => {
  if (!fs.existsSync(TEMP_AGENTS_DIR)) return res.json([]);
  const deployed = fs.readdirSync(TEMP_AGENTS_DIR)
    .filter(d => fs.existsSync(path.join(TEMP_AGENTS_DIR, d, 'SOUL.md')))
    .map(d => {
      const soulPath = path.join(TEMP_AGENTS_DIR, d, 'SOUL.md');
      const meta = path.join(TEMP_AGENTS_DIR, d, 'meta.json');
      const info = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')) : {};
      return { agentId: d, soulPath: soulPath.replace(ROOT, ''), deployedAt: info.deployedAt, name: info.name, category: info.category, role: info.role };
    });
  res.json(deployed);
});

// Deploy a temporary agent
app.post('/api/openclaw/agents/deploy', async (req, res) => {
  const { agentId, agentPath, name, category, role } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });

  const destDir = path.join(TEMP_AGENTS_DIR, agentId);
  fs.mkdirSync(destDir, { recursive: true });

  let soulContent = null;
  // Try GitHub first
  if (agentPath) {
    const rawUrl = `https://raw.githubusercontent.com/mergisi/awesome-openclaw-agents/main/${agentPath}`;
    try {
      const r = await axios.get(rawUrl, { timeout: 15000, responseType: 'text' });
      if (r.data && r.data.length > 20) soulContent = r.data;
    } catch (_) {}
  }
  // Generate a rich SOUL.md locally if GitHub unavailable
  if (!soulContent) {
    const catAgents = OPENCLAW_CATEGORY_AGENTS[category] || '';
    soulContent = `# ${name || agentId} — ${role || category} Agent

You are ${name || agentId}, a specialist ${role || category} agent deployed from the OmniClaw agent pool.

## Your Focus
${OPENCLAW_EXEC_CATEGORIES[category] ? `You specialise in ${OPENCLAW_EXEC_CATEGORIES[category].focus}` : `You are an expert in ${category} operations.`}

## Your Capabilities
You have access to the full OmniClaw action engine. Use actions proactively.
Other ${category} specialists in your pool: ${catAgents}

## Your Style
- Expert, focused, and precise
- Give specific, actionable output — not generic advice
- If you need data, use [[ACTION:web_search|query]] or [[ACTION:web_fetch|url]]
- If asked to save output, use [[ACTION:obsidian_write|Title|Content]]
- Always complete the task fully before responding

${AGENT_ACTION_REFERENCE}`;
  }

  fs.writeFileSync(path.join(destDir, 'SOUL.md'), soulContent);
  fs.writeFileSync(path.join(destDir, 'meta.json'), JSON.stringify({ agentId, name, category, role, agentPath, deployedAt: new Date().toISOString() }, null, 2));
  console.log(`[OPENCLAW] Deployed: ${agentId} (${name || category})`);
  io.emit('openclaw:deployed', { agentId, name, category, role });
  res.json({ success: true, agentId, name, category, message: `${name || agentId} is ready.` });
});

// Undeploy — remove temp agent
app.delete('/api/openclaw/agents/undeploy/:id', (req, res) => {
  const destDir = path.join(TEMP_AGENTS_DIR, req.params.id);
  if (!fs.existsSync(destDir)) return res.status(404).json({ error: 'Agent not deployed' });
  fs.rmSync(destDir, { recursive: true, force: true });
  console.log(`[OPENCLAW] Undeployed agent: ${req.params.id}`);
  io.emit('openclaw:undeployed', { agentId: req.params.id });
  res.json({ success: true, message: `${req.params.id} undeployed` });
});

// Use a deployed agent — chat with its SOUL.md as the system prompt
app.post('/api/openclaw/agents/:id/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const soulPath = path.join(TEMP_AGENTS_DIR, req.params.id, 'SOUL.md');
  if (!fs.existsSync(soulPath)) return res.status(404).json({ error: 'Agent not deployed. POST /api/openclaw/agents/deploy first.' });
  const soul = fs.readFileSync(soulPath, 'utf8');
  const metaPath = path.join(TEMP_AGENTS_DIR, req.params.id, 'meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  try {
    const rawReply = await callAI([{ role: 'user', content: message }], soul);
    const reply = await executeActions(rawReply, soul);
    res.json({ agent: meta.name || req.params.id, category: meta.category, reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// VOICE DIAGNOSE — test Groq TTS and return raw result for debugging
// =============================================================================
app.get('/api/voice/diagnose', async (req, res) => {
  const results = {};
  results.GROQ_API_KEY = process.env.GROQ_API_KEY ? '✓ set (' + process.env.GROQ_API_KEY.slice(0,8) + '...)' : '✗ not set';
  results.VOICE_TTS_PROVIDER = process.env.VOICE_TTS_PROVIDER || '(auto)';
  results.VOICE_GROQ_VOICE = process.env.VOICE_GROQ_VOICE || 'Fritz-PlayAI (default)';
  results.detectedProvider = getTTSProvider();
  if (process.env.GROQ_API_KEY) {
    try {
      const voice = process.env.VOICE_GROQ_VOICE || 'Fritz-PlayAI';
      const r = await axios.post(
        'https://api.groq.com/openai/v1/audio/speech',
        { model: 'playai-tts', voice, input: 'Test.', response_format: 'wav' },
        { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 15000 }
      );
      results.groqTTS = `✓ Working — ${r.data.byteLength} bytes returned`;
    } catch(e) {
      const err = e.response?.data
        ? (Buffer.isBuffer(e.response.data) ? e.response.data.toString() : JSON.stringify(e.response.data))
        : e.message;
      results.groqTTS = `✗ Failed: ${err}`;
      results.groqStatus = e.response?.status;
    }
  } else {
    results.groqTTS = '✗ Skipped — no GROQ_API_KEY';
  }
  res.json(results);
});

// =============================================================================
// VOICE — multi-provider TTS + Whisper STT
// Provider priority: VOICE_TTS_PROVIDER env var, or auto-detect from keys
// Providers: 'webspeech' (browser-native), 'groq', 'elevenlabs'
// =============================================================================

// Helper — pick best available TTS provider
function getTTSProvider() {
  const pref = (process.env.VOICE_TTS_PROVIDER || '').toLowerCase();
  if (pref === 'groq' && process.env.GROQ_API_KEY)       return 'groq';
  if (pref === 'elevenlabs' && process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (pref === 'webspeech') return 'webspeech';
  // Auto-detect: prefer free providers first, then paid
  if (process.env.GROQ_API_KEY)       return 'groq';
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  return 'webspeech'; // browser-native fallback, always available
}

app.get('/api/voice/provider', (req, res) => {
  res.json({ provider: getTTSProvider() });
});

app.post('/api/voice/speak', async (req, res) => {
  const { text, provider: reqProvider, voice: reqVoice } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const provider = reqProvider || getTTSProvider();

  // Browser-native: tell client to use Web Speech API
  if (provider === 'webspeech') return res.json({ browser: true, text });

  // ElevenLabs — if explicitly selected
  if (provider === 'elevenlabs') {
    if (!process.env.ELEVENLABS_API_KEY) return res.json({ browser: true, text, error: 'ELEVENLABS_API_KEY not set' });
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
    try {
      const r = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text: text.slice(0, 2500), model_id: 'eleven_turbo_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
        { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, responseType: 'stream' }
      );
      res.set('Content-Type', 'audio/mpeg');
      return r.data.pipe(res);
    } catch(e) { return res.json({ browser: true, text, error: e.response?.data?.detail || e.message }); }
  }

  // Auto / Groq / OpenAI — use shared generateTTSBuffer() which tries both
  const audio = await generateTTSBuffer(text, reqVoice);
  if (audio) {
    res.set('Content-Type', audio.mime);
    return res.send(audio.buffer);
  }

  // All server TTS failed — tell client to use browser speech
  res.json({ browser: true, text, error: 'No working TTS provider — check OpenAI or Groq key, or set VOICE_TTS_PROVIDER=webspeech' });
});

// Groq Whisper STT — transcribe uploaded audio
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!groqKey && !openaiKey) return res.status(503).json({ error: 'No STT key configured. Add GROQ_API_KEY or OPENAI_API_KEY.' });

  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', req.file.buffer, { filename: req.file.originalname || 'audio.webm', contentType: req.file.mimetype });
  form.append('model', groqKey ? 'whisper-large-v3-turbo' : 'whisper-1');
  form.append('response_format', 'json');

  const endpoint = groqKey
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';
  const authKey = groqKey || openaiKey;
  try {
    const r = await axios.post(endpoint, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${authKey}` },
      timeout: 30000,
    });
    res.json({ text: r.data.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// =============================================================================
// OLLAMA — fetch available local models
// =============================================================================
app.post('/api/ollama/pull', async (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'model required' });
  const base = process.env.OLLAMA_HOST || 'http://localhost:11434';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  try {
    const r = await axios.post(`${base}/api/pull`, { name: model }, { responseType: 'stream', timeout: 300000 });
    r.data.on('data', chunk => res.write(chunk));
    r.data.on('end', () => res.end());
    r.data.on('error', () => res.end());
  } catch(e) { res.write(JSON.stringify({ error: e.message })); res.end(); }
});

app.post('/api/ollama/set-default', (req, res) => {
  const { model, slot } = req.body; // slot: 'primary' | 'backup'
  if (!model) return res.status(400).json({ error: 'model required' });
  const key = slot === 'backup' ? 'MODEL_CHAIN_2' : 'MODEL_CHAIN_1';
  const value = `ollama::${model}`;
  const envPath = ENV_PATH;
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = content.split('\n');
  const idx = lines.findIndex(l => { const e = l.indexOf('='); return e > 0 && l.slice(0, e).trim() === key; });
  const newLine = `${key}="${value}"`;
  if (idx >= 0) lines[idx] = newLine; else lines.push(newLine);
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
  process.env[key] = value;
  res.json({ ok: true, key, value });
});

// Quick model switch — update MODEL_CHAIN_1 immediately without restart
app.post('/api/model/switch', (req, res) => {
  const { value } = req.body; // e.g. 'anthropic::claude-sonnet-4-6' or 'ollama::gemma3:9b'
  if (!value) return res.status(400).json({ error: 'value required' });
  const key = 'MODEL_CHAIN_1';
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const lines = content.split('\n');
  const idx = lines.findIndex(l => { const e = l.indexOf('='); return e > 0 && l.slice(0, e).trim() === key; });
  const newLine = `${key}="${value}"`;
  if (idx >= 0) lines[idx] = newLine; else lines.push(newLine);
  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
  process.env[key] = value;
  console.log(`[MODEL] Switched primary model to: ${value}`);
  io.emit('model:switched', { model: value });
  res.json({ ok: true, model: value });
});

// Provider key status — checks resolveConfig (env + .env + yaml), never exposes full key
app.get('/api/provider/status', (req, res) => {
  const keys = [
    'ANTHROPIC_API_KEY','OPENAI_API_KEY','GROQ_API_KEY',
    'GOOGLE_AI_API_KEY','OPENROUTER_API_KEY',
    'MODEL_CHAIN_1','MODEL_CHAIN_2','MODEL_CHAIN_3',
  ];
  const result = {};
  for (const k of keys) {
    const v = resolveConfig(k);
    result[k] = v ? { set: true, hint: v.slice(0, 6) + '...' } : { set: false };
  }
  res.json(result);
});

// Model chain values — returns full MODEL_CHAIN_1/2/3 values (not secrets)
app.get('/api/chain', (req, res) => {
  res.json({
    MODEL_CHAIN_1: resolveConfig('MODEL_CHAIN_1') || '',
    MODEL_CHAIN_2: resolveConfig('MODEL_CHAIN_2') || '',
    MODEL_CHAIN_3: resolveConfig('MODEL_CHAIN_3') || '',
  });
});

app.get('/api/metaclaw/status', async (req, res) => {
  const metaHost = resolveConfig('METACLAW_HOST') || 'http://localhost:30000';
  const enabled = resolveConfig('METACLAW_ENABLED') === 'true';
  try {
    await axios.get(`${metaHost}/v1/models`, { timeout: 2000 });
    res.json({ running: true, host: metaHost, enabled });
  } catch(e) {
    res.json({ running: false, host: metaHost, enabled, error: e.code || e.message });
  }
});

app.get('/api/ollama/models', async (req, res) => {
  const base = process.env.OLLAMA_HOST || 'http://localhost:11434';
  try {
    const r = await axios.get(`${base}/api/tags`, { timeout: 5000 });
    const models = (r.data.models || []).map(m => ({
      name: m.name, size: m.size, modified: m.modified_at,
      family: m.details?.family || '', params: m.details?.parameter_size || '',
    }));
    res.json({ running: true, models, host: base });
  } catch (e) {
    res.json({ running: false, models: [], host: base, error: e.code === 'ECONNREFUSED' ? 'Ollama not running' : e.message });
  }
});

// =============================================================================
// IDEAS — AI-generated personalised suggestions for the user's setup
// =============================================================================
const IDEA_STORE_PATH = path.join(ROOT, 'memory', 'ideas.json');
function loadIdeas() { try { return JSON.parse(fs.readFileSync(IDEA_STORE_PATH, 'utf8')); } catch(_) { return []; } }
function saveIdeas(ideas) { fs.writeFileSync(IDEA_STORE_PATH, JSON.stringify(ideas, null, 2)); }

app.get('/api/ideas', async (req, res) => {
  let ideas = loadIdeas();
  // Generate fresh ideas if none or stale (older than 24h)
  const fresh = ideas.filter(i => !i.dismissed && Date.now() - new Date(i.created).getTime() < 24 * 3600000);
  if (fresh.length >= 3) return res.json({ ideas: fresh });
  // Generate new ideas based on current config
  const configured = [];
  const missing = [];
  if (process.env.ANTHROPIC_API_KEY) configured.push('Anthropic Claude');
  if (!process.env.ANTHROPIC_API_KEY) missing.push('Anthropic API key');
  if (process.env.GMAIL_ADDRESS) configured.push('Gmail');
  if (!process.env.GMAIL_ADDRESS) missing.push('Gmail (email sending)');
  if (process.env.TG_TOKEN) configured.push('Telegram');
  if (!process.env.TG_TOKEN) missing.push('Telegram bot');
  if (process.env.STRIPE_SECRET_KEY) configured.push('Stripe payments');
  if (!process.env.STRIPE_SECRET_KEY) missing.push('Stripe (to send invoices & track revenue)');
  if (process.env.NOTION_TOKEN) configured.push('Notion');
  if (!process.env.NOTION_TOKEN) missing.push('Notion (knowledge base + project tracking)');
  if (process.env.SLACK_TOKEN) configured.push('Slack');
  if (!process.env.SLACK_TOKEN) missing.push('Slack (team comms)');
  if (process.env.SUPABASE_URL) configured.push('Supabase database');
  const errorCount = errorLog.filter(e => !e.resolved).length;
  const voiceProvider = getTTSProvider();
  const voiceNote = voiceProvider === 'groq'
    ? 'Currently using Groq TTS (PlayAI voices — functional but robotic). Consider suggesting Kokoro.js (open-source, runs locally, very natural-sounding, free) or OpenAI TTS as a significant voice quality upgrade.'
    : voiceProvider === 'elevenlabs'
    ? 'Using ElevenLabs TTS — good quality.'
    : 'No dedicated TTS configured — using browser speech synthesis which sounds robotic. Suggest Kokoro.js (open-source, local, natural) or Groq TTS as free upgrade.';

  const contextPrompt = `You are the CIO of ${state.company}, an AI-powered company running on OmniClaw.

Current setup: ${configured.join(', ') || 'minimal configuration'}
Missing integrations: ${missing.slice(0, 5).join(', ') || 'none obvious'}
Active errors: ${errorCount}
Active agents: ${Object.keys(state.agents).length}
Recent decisions: ${state.decisions.slice(-3).map(d => d.objective).join(', ') || 'none'}
Voice system note: ${voiceNote}

Generate 6 specific, actionable suggestions to improve or extend this OmniClaw setup. Each suggestion should be something that can realistically be implemented. Focus on high business value. Include at least one voice/audio quality improvement based on the voice system note above.

Respond ONLY with a JSON array like:
[
  { "id": "unique-slug", "title": "Short title", "description": "1-2 sentence description of what this does and why it's valuable", "category": "Revenue|Automation|Comms|Data|Security|Productivity", "effort": "Quick|Medium|Complex", "impact": "High|Medium" }
]`;

  try {
    const raw = await callAI([{ role: 'user', content: contextPrompt }],
      'You are a strategic AI advisor. Respond ONLY with valid JSON. No markdown fences, no explanation.');
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const newIdeas = JSON.parse(jsonMatch[0]).map(idea => ({ ...idea, created: new Date().toISOString(), dismissed: false, implemented: false }));
      ideas = [...newIdeas, ...ideas.filter(i => i.dismissed || i.implemented)].slice(0, 50);
      saveIdeas(ideas);
      return res.json({ ideas: newIdeas });
    }
  } catch(e) { console.log('[IDEAS] Generation failed:', e.message); }
  res.json({ ideas: [] });
});

app.post('/api/ideas/dismiss', (req, res) => {
  const { id } = req.body;
  const ideas = loadIdeas();
  const idea = ideas.find(i => i.id === id);
  if (idea) { idea.dismissed = true; saveIdeas(ideas); }
  res.json({ ok: true });
});

app.post('/api/ideas/implement', async (req, res) => {
  const { id } = req.body;
  const ideas = loadIdeas();
  const idea = ideas.find(i => i.id === id);
  if (!idea) return res.status(404).json({ error: 'Idea not found' });
  res.json({ ok: true, message: `I'll get started on "${idea.title}" right away. Check the Decisions panel to track progress.` });
  // Queue as a decision
  const decision = {
    id: `decision-${Date.now()}`,
    objective: idea.title,
    context: idea.description,
    status: 'in-progress',
    created: new Date().toISOString(),
    source: 'ideas-panel',
  };
  state.decisions.push(decision);
  io.emit('decision:new', decision);
  idea.implemented = true;
  saveIdeas(ideas);
});

// =============================================================================
// DASHBOARD WIDGETS CONFIG
// =============================================================================
const WIDGET_CONFIG_PATH = path.join(ROOT, 'memory', 'dashboard-widgets.json');
const DEFAULT_WIDGETS = [
  { id: 'agents', label: 'Agent Status', icon: '🤖', enabled: true, order: 0 },
  { id: 'decisions', label: 'Recent Decisions', icon: '⚖️', enabled: true, order: 1 },
  { id: 'errors', label: 'System Errors', icon: '⚠️', enabled: true, order: 2 },
  { id: 'briefing', label: 'Morning Briefing', icon: '☀️', enabled: true, order: 3 },
  { id: 'news', label: 'Business News', icon: '📰', enabled: false, order: 4 },
  { id: 'weather', label: 'Weather', icon: '🌤️', enabled: false, order: 5 },
  { id: 'finance', label: 'Finance Snapshot', icon: '💰', enabled: false, order: 6 },
  { id: 'github', label: 'GitHub Activity', icon: '🐙', enabled: false, order: 7 },
  { id: 'telegram', label: 'Telegram Activity', icon: '✈️', enabled: false, order: 8 },
  { id: 'custom', label: 'Custom (ask CEO)', icon: '✨', enabled: false, order: 9 },
];
function loadWidgetConfig() {
  try { return JSON.parse(fs.readFileSync(WIDGET_CONFIG_PATH, 'utf8')); } catch(_) { return DEFAULT_WIDGETS; }
}
app.get('/api/dashboard/widgets', (req, res) => res.json({ widgets: loadWidgetConfig() }));
app.post('/api/dashboard/widgets', (req, res) => {
  const { widgets } = req.body;
  if (!Array.isArray(widgets)) return res.status(400).json({ error: 'widgets array required' });
  fs.writeFileSync(WIDGET_CONFIG_PATH, JSON.stringify(widgets, null, 2));
  res.json({ ok: true });
});

// =============================================================================
// SELF-IMPROVEMENT ENGINE — nightly overnight optimisation
// =============================================================================
async function runSelfImprovement() {
  console.log('[IMPROVE] 🌙 Overnight self-improvement sweep starting...');
  const vaultPath = resolveConfig('OBSIDIAN_VAULT_PATH', 'VAULT_PATH');
  const unresolvedErrors = errorLog.filter(e => !e.resolved);
  const recentDecisions = state.decisions.slice(-10);

  const systemState = {
    company: state.company,
    agentCount: Object.keys(state.agents).length,
    errorCount: unresolvedErrors.length,
    topErrors: unresolvedErrors.slice(0, 5).map(e => `${e.context}: ${e.message}`),
    recentDecisions: recentDecisions.map(d => `${d.objective} (${d.status})`),
    configuredIntegrations: [
      process.env.ANTHROPIC_API_KEY && 'Anthropic', process.env.GROQ_API_KEY && 'Groq',
      process.env.GMAIL_ADDRESS && 'Gmail', process.env.TG_TOKEN && 'Telegram',
      process.env.STRIPE_SECRET_KEY && 'Stripe', process.env.NOTION_TOKEN && 'Notion',
      process.env.SUPABASE_URL && 'Supabase',
    ].filter(Boolean),
  };

  const prompt = `You are TommyClaw's CIO running the nightly self-improvement sweep for ${state.company}.

SYSTEM STATE:
${JSON.stringify(systemState, null, 2)}

YOUR TASK — overnight improvement sweep:
1. Review the unresolved errors and identify any patterns or quick wins
2. Identify 3 optimisations that could be made to the current configuration
3. Draft tomorrow's priority list for the CEO
4. Suggest one automation that would save the most time this week
5. Flag any risks or things to watch

Write a concise overnight report. Be specific, actionable, and direct.${vaultPath ? '\n\nEnd with [[ACTION:obsidian_write|OmniClaw Overnight Report ' + new Date().toLocaleDateString() + '|' + '<report content here>' + ']]' : ''}`;

  try {
    const rawReply = await callAI([{ role: 'user', content: prompt }], `You are the autonomous CIO of ${state.company}. Be direct, specific, and focused on actionable improvements.`);
    await executeActions(rawReply, '');
    console.log('[IMPROVE] ✅ Overnight sweep complete');
    io.emit('system:improvement', { time: new Date().toISOString(), summary: 'Overnight self-improvement sweep completed' });
    logError.length = 0; // clear old resolved errors
    errorLog.splice(0, errorLog.length, ...errorLog.filter(e => !e.resolved || Date.now() - new Date(e.time).getTime() < 86400000));
  } catch (e) {
    console.error('[IMPROVE] Sweep failed:', e.message);
  }
}

app.post('/api/improve/run', async (req, res) => {
  res.json({ ok: true, message: 'Self-improvement sweep started — check logs.' });
  runSelfImprovement();
});

// =============================================================================
// =============================================================================
// PROACTIVE CEO — autonomous company analysis, business plan, self-improvement
// =============================================================================
async function runProactiveCEO() {
  const vaultPath = resolveConfig('OBSIDIAN_VAULT_PATH', 'VAULT_PATH');
  if (!vaultPath) return; // Can't save without vault

  console.log('[CEO] Running proactive analysis...');
  try {
    // Build context from all available integrations
    const contextParts = [];
    contextParts.push(`Company: ${state.company}`);
    contextParts.push(`Owner: ${state.owner}`);
    contextParts.push(`Active Agents: ${Object.keys(state.agents).length}`);
    contextParts.push(`Recent Decisions: ${state.decisions.slice(-5).map(d => `${d.objective} (${d.status})`).join(', ') || 'None yet'}`);

    const ownerProfile = fs.existsSync(path.join(MEMORY_DIR, 'OWNER.md'))
      ? fs.readFileSync(path.join(MEMORY_DIR, 'OWNER.md'), 'utf8').slice(0, 1000) : '';
    if (ownerProfile) contextParts.push(`Owner Context:\n${ownerProfile}`);

    const prompt = `You are TommyClaw, autonomous CEO of ${state.company}. You are running your daily strategic sweep.

COMPANY CONTEXT:
${contextParts.join('\n')}

YOUR MISSION TODAY:
1. Identify the top 3 weaknesses or blind spots in the business right now
2. Identify the top 3 opportunities worth pursuing immediately
3. Set the company's #1 priority for the next 7 days
4. Assign one specific action to each C-Suite agent (CFO, COO, CTO, CMO, CRO)
5. Update the master Business Plan in Obsidian

OUTPUT FORMAT: Write a concise, punchy strategic brief. Then write the full business plan update.

End your response with these exact action blocks (fill in the content):
[[ACTION:obsidian_write|OmniClaw Business Plan|# ${state.company} — Living Business Plan

**Last Updated:** ${new Date().toLocaleDateString()}
**CEO Directive:** [Your #1 priority for next 7 days]

## Company Mission
[Write mission]

## Top Opportunities Right Now
1. [Opportunity 1]
2. [Opportunity 2]
3. [Opportunity 3]

## Identified Weaknesses
1. [Weakness 1]
2. [Weakness 2]
3. [Weakness 3]

## Agent Assignments This Week
- CFO: [specific task]
- COO: [specific task]
- CTO: [specific task]
- CMO: [specific task]
- CRO: [specific task]

## 90-Day Targets
[Write targets]

## Self-Healing Actions
[What the system should auto-fix or monitor]
]]
[[ACTION:memory_write|CEO-LAST-SWEEP.md|Date: ${new Date().toISOString()}\nStatus: Complete]]`;

    const reply = await callAI([{ role: 'user', content: prompt }], prompt);
    await executeActions(reply, prompt);
    console.log('[CEO] Proactive sweep complete — business plan updated in Obsidian');
  } catch (e) {
    console.log('[CEO] Proactive sweep failed:', e.message);
  }
}

// Self-healing: check system health and fix common issues
async function selfHeal() {
  try {
    // Reload org chart if agents dropped below expected count
    const expectedAgents = 11;
    if (Object.keys(state.agents).length < expectedAgents) {
      console.log(`[HEAL] Agent count low (${Object.keys(state.agents).length}/${expectedAgents}) — reloading org chart`);
      loadOrgChart();
    }

    // Clear rate limit cooldowns older than their TTL (self-cleans automatically via isOnCooldown)
    const now = Date.now();
    for (const [provider, until] of Object.entries(providerCooldown)) {
      if (now > until) delete providerCooldown[provider];
    }

    // Ensure memory directory exists
    fs.mkdirSync(MEMORY_DIR, { recursive: true });

    // Persist decisions to disk if grown
    if (state.decisions.length > 0) {
      const decisionsPath = path.join(MEMORY_DIR, 'decisions.json');
      fs.writeFileSync(decisionsPath, JSON.stringify(state.decisions.slice(-200), null, 2));
    }
  } catch (e) {
    console.log('[HEAL] Self-heal check failed:', e.message);
  }
}

// =============================================================================
// OPENCLAW GATEWAY — WebSocket endpoint for Paperclip integration
// Protocol v3 (disableDeviceAuth=true in Paperclip agent config):
//   S→C  {type:'event', event:'connect.challenge', payload:{nonce,ts}}
//   C→S  {type:'req', id, method:'connect', params:{minProtocol,maxProtocol,client,role,scopes}}
//   S→C  {type:'res', id, ok:true, payload:{type:'hello-ok', protocol:3, policy:{...}, auth:{...}}}
//   C→S  {type:'req', id, method:'agent.execute', params:{message,idempotencyKey,sessionKey,...}}
//   S→C  {type:'res', id, ok:true, payload:{type:'agent.accepted', idempotencyKey}}
//   S→C  {type:'event', event:'agent', payload:{stream:'stdout', data:'...'}, seq, stateVersion}
//   S→C  {type:'event', event:'agent', payload:{stream:'exit', exitCode:0}, seq, stateVersion}
//   C→S  {type:'req', id, method:'agent.wait', params:{waitTimeoutMs}}
//   S→C  {type:'res', id, ok:true, payload:{type:'agent.result', status:'completed', summary:'...'}}
// =============================================================================
(function attachOpenClawGateway() {
  const WebSocket = require('ws');
  const crypto = require('crypto');
  const gatewayWss = new WebSocket.Server({ noServer: true });

  // Pending agent runs: idempotencyKey → Promise<string>
  const pendingRuns = {};

  gatewayWss.on('connection', (ws) => {
    console.log('[GATEWAY] Paperclip client connected');
    let connected = false;
    let seqCounter = 0;
    const nextSeq = () => ++seqCounter;

    // One pending run per connection (Paperclip opens one WS per agent invocation)
    let connectionRunPromise = null;
    let connectionRunId = null;

    const send = (obj) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const label = obj.type === 'event' ? `event:${obj.event}` : `${obj.type} ${obj.payload?.type || obj.payload?.status || obj.error?.code || ''}`;
      console.log(`[GATEWAY] → ${label}`);
      ws.send(JSON.stringify(obj));
    };

    // ── Step 1: challenge ────────────────────────────────────────────────────
    const nonce = crypto.randomBytes(16).toString('hex');
    send({ type: 'event', event: 'connect.challenge', payload: { nonce, ts: Date.now() } });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      console.log(`[GATEWAY] ← ${msg.type} ${msg.method || msg.event || ''} id=${msg.id || '-'}`);

      // ── Step 2: connect ───────────────────────────────────────────────────
      if (msg.type === 'req' && msg.method === 'connect') {
        connected = true;
        send({
          type: 'res', id: msg.id, ok: true,
          payload: {
            type: 'hello-ok',
            protocol: 3,
            policy: { tickIntervalMs: 15000 },
            auth: { role: msg.params?.role || 'operator', scopes: msg.params?.scopes || ['operator.admin'] }
          }
        });
        return;
      }

      if (!connected) { send({ type: 'error', code: 'not_connected' }); return; }

      // ── Step 3: agent run request ─────────────────────────────────────────
      if (msg.type === 'req' && (msg.method === 'agent' || msg.method === 'agent.execute')) {
        const params = msg.params || {};
        const idempotencyKey = params.idempotencyKey || params.runId || msg.id;
        const message = params.message || '';
        // agentId injected by Paperclip via adapterConfig or paperclip context
        const rawAgentId = params.agentId || params.paperclip?.agentId || 'CEO';
        const personaId = rawAgentId.toUpperCase();

        connectionRunId = idempotencyKey;

        // Acknowledge immediately
        send({ type: 'res', id: msg.id, ok: true,
          payload: { status: 'accepted', runId: idempotencyKey } });

        console.log(`[GATEWAY] Running ${personaId} — runId=${idempotencyKey}`);
        const sysPrompt = getAgentSystemPrompt(personaId);

        // Store promise — no streaming events; deliver everything in agent.wait response
        connectionRunPromise = callAI([{ role: 'user', content: message }], sysPrompt)
          .then(async (text) => {
            // Run [[ACTION:...]] handlers so agents can create agents, write files, etc.
            const processed = await executeActions(text, sysPrompt);
            console.log(`[GATEWAY] ${personaId} ready — runId=${idempotencyKey}`);
            return processed;
          });

        return;
      }

      // ── Step 4: agent.wait — await the promise, return full result ────────
      if (msg.type === 'req' && msg.method === 'agent.wait') {
        if (!connectionRunPromise) {
          send({ type: 'res', id: msg.id, ok: false, error: { code: 'run_not_found' } });
          return;
        }
        try {
          const text = await connectionRunPromise;
          connectionRunPromise = null;
          console.log(`[GATEWAY] ${connectionRunId} completed — sending result`);
          send({ type: 'res', id: msg.id, ok: true,
            payload: { status: 'ok', runId: connectionRunId, text, exitCode: 0 } });
        } catch (e) {
          connectionRunPromise = null;
          send({ type: 'res', id: msg.id, ok: false,
            error: { code: 'agent_error', message: e.message } });
        }
        return;
      }

      // Log unknown messages for debugging
      if (msg.method !== 'ping') {
        console.log('[GATEWAY] Unhandled:', msg.type, msg.method);
      }
    });

    ws.on('close', () => console.log('[GATEWAY] Paperclip client disconnected'));
    ws.on('error', (e) => console.log('[GATEWAY] ws error:', e.message));
  });

  // Attach to the existing http.Server — path /openclaw-gateway
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/openclaw-gateway') {
      gatewayWss.handleUpgrade(req, socket, head, (ws) => {
        gatewayWss.emit('connection', ws, req);
      });
    }
  });

  console.log('[GATEWAY] OpenClaw gateway v3 ready — ws://localhost:PORT/openclaw-gateway');
})();

// =============================================================================
// PAPERCLIP AGENT SELF-HEALER
// Finds openclaw_gateway agents missing the gateway URL and patches them.
// Runs at startup and every 5 minutes.
// =============================================================================
async function healPaperclipAgents() {
  const PAPERCLIP_API = 'http://127.0.0.1:3100';
  const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || 'bb7a6f5b-7333-4916-89e9-c9394b5aa421';
  const GATEWAY_URL = `ws://127.0.0.1:${process.env.DASHBOARD_PORT || 3001}/openclaw-gateway`;

  try {
    const r = await axios.get(`${PAPERCLIP_API}/api/companies/${COMPANY_ID}/agents`, { timeout: 5000 });
    const agents = r.data || [];
    for (const agent of agents) {
      if (agent.adapterType !== 'openclaw_gateway') continue;
      const cfg = agent.adapterConfig || {};
      if (cfg.url && cfg.disableDeviceAuth) continue; // already healthy

      const agentId = (agent.name || agent.id).toUpperCase().replace(/\s+/g, '_');
      await axios.patch(`${PAPERCLIP_API}/api/agents/${agent.id}`, {
        adapterConfig: {
          url: GATEWAY_URL,
          agentId,
          disableDeviceAuth: true,
          timeoutSec: 300,
          waitTimeoutMs: 270000,
        },
        ...(agent.status === 'error' ? { status: 'idle' } : {}),
      }, { timeout: 5000 });
      console.log(`[HEAL] Patched agent ${agent.name} (${agent.id}) — added gateway URL`);
    }
  } catch (e) {
    if (e.code !== 'ECONNREFUSED') {
      console.log('[HEAL] Paperclip agent heal failed:', e.message);
    }
  }
}

// =============================================================================
// INIT & START
// =============================================================================
loadOrgChart();
loadDecisions();

function startOnAvailablePort(preferredPort, maxTries = 10) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    let attempt = preferredPort;
    const tryPort = () => {
      const probe = net.createServer();
      probe.once('error', () => {
        attempt++;
        if (attempt >= preferredPort + maxTries) {
          reject(new Error(`No free port found in range ${preferredPort}–${preferredPort + maxTries - 1}`));
        } else {
          console.log(`   Port ${attempt - 1} in use — trying ${attempt}...`);
          tryPort();
        }
      });
      probe.once('listening', () => {
        probe.close(() => {
          server.listen(attempt, '0.0.0.0', () => resolve(attempt));
        });
      });
      probe.listen(attempt, '0.0.0.0');
    };
    tryPort();
  });
}

startOnAvailablePort(PORT).then(boundPort => {
  console.log(`\n🦾 OmniClaw Dashboard`);
  console.log(`   Company:   ${state.company}`);
  console.log(`   Port:      ${boundPort}${boundPort !== PORT ? ` (preferred ${PORT} was taken)` : ''}`);
  console.log(`   Open:      http://localhost:${boundPort}`);
  if (process.env.AUTO_OPEN_DASHBOARD !== 'false') {
    const { exec } = require('child_process');
    setTimeout(() => exec(`open http://localhost:${boundPort}`, () => {}), 800);
  }
  console.log(`   Agents:    ${Object.keys(state.agents).length} active`);
  console.log(`   Heartbeat: ${state.heartbeat}`);

  // Start Telegram polling if token is configured
  if (process.env.TG_TOKEN) {
    pollTelegram();
    console.log(`   Telegram:  Bot active — polling for messages`);
    // Send agent intro messages on first run (staggered, non-blocking)
    setTimeout(sendAgentIntros, 3000);
  } else {
    console.log(`   Telegram:  Not configured (add TG_TOKEN to .env)`);
  }

  // Detect which AI provider is active
  const chain = [process.env.MODEL_CHAIN_1, process.env.MODEL_CHAIN_2, process.env.MODEL_CHAIN_3].filter(Boolean);
  console.log(`   AI Chain:  ${chain.join(' → ') || 'Not configured'}`);

  // Integration status
  const integrations = [];
  if (process.env.SLACK_BOT_TOKEN)   integrations.push('Slack');
  if (process.env.GMAIL_ADDRESS)     integrations.push('Gmail');
  if (process.env.GOOGLE_CLIENT_ID)  integrations.push(fs.existsSync(GOOGLE_TOKEN_PATH) ? 'Google ✓' : 'Google (needs auth)');
  if (process.env.NOTION_TOKEN)      integrations.push('Notion');
  if (process.env.HUBSPOT_API_KEY)   integrations.push('HubSpot');
  if (process.env.STRIPE_API_KEY)    integrations.push('Stripe');
  if (process.env.FIRECRAWL_API_KEY) integrations.push('Firecrawl');
  if (process.env.PERPLEXITY_API_KEY)integrations.push('Perplexity');
  if (integrations.length) console.log(`   Suite:     ${integrations.join(' · ')}`);

  // Morning briefing scheduler
  scheduleBriefing();

  // Self-healing: runs every 5 minutes
  setInterval(selfHeal, 5 * 60 * 1000);

  // ── Ollama model watcher ─────────────────────────────────────────────────
  // Ranked preference list — highest first. When a model becomes available
  // and it ranks higher than the current MODEL_CHAIN_1, auto-promote it.
  const OLLAMA_PREFERRED = [
    'qwen3:32b', 'qwen3:30b-a3b', 'deepseek-r1:32b',
    'qwen3:14b',  'deepseek-r1:14b', 'phi4:14b',
    'qwen3:8b',   'deepseek-r1:8b',  'llama3.3:8b',
    'gemma3:12b', 'gemma3:9b',
    'mistral',    'gemma3:4b',       'qwen3:4b',
  ];
  let _knownOllamaModels = new Set();

  async function watchOllamaModels() {
    try {
      const r = await axios.get('http://localhost:11434/api/tags', { timeout: 4000 });
      const installed = (r.data.models || []).map(m => m.name);
      const newModels = installed.filter(m => !_knownOllamaModels.has(m));
      if (newModels.length) {
        newModels.forEach(m => _knownOllamaModels.add(m));
        // Find the best available model from preference list
        const bestAvailable = OLLAMA_PREFERRED.find(p => installed.some(i => i === p || i.startsWith(p + ':')));
        if (bestAvailable) {
          const current = process.env.MODEL_CHAIN_1 || '';
          const currentIsOllama = current.startsWith('ollama::');
          const currentModel = currentIsOllama ? current.slice(8) : null;
          const currentRank = currentModel ? OLLAMA_PREFERRED.indexOf(OLLAMA_PREFERRED.find(p => currentModel === p || currentModel.startsWith(p + ':'))) : 999;
          const bestRank = OLLAMA_PREFERRED.indexOf(bestAvailable);
          if (!currentIsOllama || bestRank < currentRank) {
            // Auto-promote
            const fullModel = installed.find(i => i === bestAvailable || i.startsWith(bestAvailable + ':'));
            const newValue = `ollama::${fullModel}`;
            let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
            const lines = content.split('\n');
            const idx = lines.findIndex(l => { const e = l.indexOf('='); return e > 0 && l.slice(0, e).trim() === 'MODEL_CHAIN_1'; });
            const newLine = `MODEL_CHAIN_1="${newValue}"`;
            if (idx >= 0) lines[idx] = newLine; else lines.push(newLine);
            fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
            process.env.MODEL_CHAIN_1 = newValue;
            console.log(`[OLLAMA] New model detected: ${fullModel} — promoted to MODEL_CHAIN_1`);
            io.emit('model:switched', { model: newValue, auto: true, reason: `New Ollama model available: ${fullModel}` });
          }
        }
      }
      installed.forEach(m => _knownOllamaModels.add(m));
    } catch (_) { /* Ollama not running — ignore */ }
  }

  // Seed known models immediately, then poll every 90 seconds
  watchOllamaModels();
  setInterval(watchOllamaModels, 90 * 1000);

  // Paperclip agent self-healer: fix misconfigured agents on startup + every 5 min
  setTimeout(healPaperclipAgents, 10000);
  setInterval(healPaperclipAgents, 5 * 60 * 1000);

  // Proactive CEO: run once on startup (60s delay to let everything settle)
  // then daily at 06:00
  setTimeout(runProactiveCEO, 60000);
  cron.schedule('0 6 * * *', runProactiveCEO, { timezone: process.env.TIMEZONE || 'Australia/Sydney' });
  console.log('   CEO:       Proactive sweep scheduled daily at 06:00');

  // Self-improvement engine: runs every night at 02:00
  cron.schedule('0 2 * * *', runSelfImprovement, { timezone: process.env.TIMEZONE || 'Australia/Sydney' });
  console.log('   CIO:       Self-improvement sweep scheduled nightly at 02:00');

  // Auto-update: pull latest from GitHub at 03:00 every night
  cron.schedule('0 3 * * *', async () => {
    console.log('[UPDATE] 🔄 Nightly auto-update check starting...');
    try {
      const { execSync } = require('child_process');
      // Update OmniClaw itself
      const out = execSync('git pull --ff-only origin main 2>&1', { cwd: ROOT, timeout: 60000, encoding: 'utf8' });
      console.log('[UPDATE] OmniClaw:', out.trim());
      // Re-check version after pull
      await checkForUpdate();
      // Check for any openclaw or agent sub-repos inside the project
      const repoDirs = ['openclaw', 'agents', 'tools'].map(d => path.join(ROOT, d)).filter(d => {
        try { return fs.existsSync(path.join(d, '.git')); } catch(_) { return false; }
      });
      for (const dir of repoDirs) {
        try {
          const r = execSync('git pull --ff-only 2>&1', { cwd: dir, timeout: 30000, encoding: 'utf8' });
          console.log(`[UPDATE] ${path.basename(dir)}:`, r.trim());
        } catch(e) { console.log(`[UPDATE] ${path.basename(dir)}: ${e.message.slice(0,100)}`); }
      }
    } catch(e) { console.log('[UPDATE] Auto-update failed:', e.message.slice(0,200)); }
  }, { timezone: process.env.TIMEZONE || 'Australia/Sydney' });
  console.log('   Update:    Auto-update scheduled nightly at 03:00');

  // Check for updates (non-blocking, fires 5s after startup)
  setTimeout(checkForUpdate, 5000);
  console.log('');
}).catch(err => {
  console.error(`\n[FATAL] Could not bind to any port: ${err.message}`);
  process.exit(1);
});
