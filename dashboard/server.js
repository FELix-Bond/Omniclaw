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

const PORT = process.env.DASHBOARD_PORT || 3000;

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
  res.json({ content: fs.readFileSync(filePath, 'utf8') });
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

HONESTY RULES — never break these:
- Never invent domain names, email addresses, credentials, or infrastructure details unless explicitly told them in this conversation.
- If an action fails, report the error message. Don't pretend it succeeded.
- If you don't know something, search for it with [[ACTION:web_search|query]] rather than guessing.
${process.env.GMAIL_ADDRESS ? `- Company email address: ${process.env.GMAIL_ADDRESS} — use this exact address when referring to email. Never use any other address.` : '- No company email configured yet. Do not invent one.'}

${AGENT_ACTION_REFERENCE}

PERSONALITY: Sharp, confident, direct. Talk like a founder — not a corporate bot. Short sentences, plain language, no jargon. Match the energy: casual message = casual reply, strategy question = strategic answer. No bullet lists or formal headers unless the question actually needs it.

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
  // Ollama local always last (no key needed)
  autoFallbacks.push('ollama::llama3.2');

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
        const ollamaModels = [model, 'llama3.2', 'llama3.1', 'llama3', 'mistral', 'gemma2'].filter(Boolean);
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
// FILES:    obsidian_write|Title|Content  obsidian_append|Title|Content
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
  if (process.env.BRAVE_API_KEY && !isOnCooldown('search_brave')) {
    try {
      const r = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
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

// ── Action reference injected into every agent system prompt ───────────────
const AGENT_ACTION_REFERENCE = `
ACTIONS — you have real execution capabilities. Embed these inline in your reply and the server runs them immediately. Use them proactively — don't describe what you'd do, just DO IT.

FILES:    [[ACTION:obsidian_write|Title|Content]] [[ACTION:obsidian_append|Title|More]] [[ACTION:memory_write|file.md|Content]] [[ACTION:memory_read|file.md]] [[ACTION:file_write|path|Content]] [[ACTION:file_read|path]]
WEB:      [[ACTION:web_search|your query here]] [[ACTION:web_fetch|https://url.com]]
COMMS:    [[ACTION:send_email|to@email.com|Subject|Body]] [[ACTION:slack_send|#channel|Message]] [[ACTION:telegram_send|Message]]
GOOGLE:   [[ACTION:google_doc|Title|Content]] [[ACTION:calendar_event|Title|2024-01-01T10:00:00|2024-01-01T11:00:00|Description]] [[ACTION:sheets_append|val1,val2,val3]]
NOTION:   [[ACTION:notion_create|Title|Content]]
HUBSPOT:  [[ACTION:hubspot_create_contact|email|Full Name|Company]] [[ACTION:hubspot_create_deal|Name|amount|stage]] [[ACTION:hubspot_get_deals]]
STRIPE:   [[ACTION:stripe_create_invoice|email|amount_cents|Description]] [[ACTION:stripe_revenue]]
GITHUB:   [[ACTION:github_push|Commit message]] [[ACTION:github_create_issue|Title|Body]]
SUPABASE: [[ACTION:supabase_query|table|{"col":"val"}]] [[ACTION:supabase_insert|table|{"col":"val"}]]
SHELL:    [[ACTION:shell|any shell command]]

Chain multiple actions in one reply. Data-returning actions (web_search, web_fetch, shell, hubspot_get_deals, stripe_revenue, supabase_query, memory_read, file_read) return results that you will see and synthesise into your response.`;

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
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH || process.env.VAULT_PATH;
          if (!vaultPath) { label = '⚠️ OBSIDIAN_VAULT_PATH not set in .env'; break; }
          const safe = (parts[1] || 'Untitled').replace(/[/\\?%*:|"<>]/g, '-');
          fs.writeFileSync(path.join(vaultPath, `${safe}.md`), `# ${safe}\n\n${parts.slice(2).join('\n')}\n`, 'utf8');
          label = `✅ Written to Obsidian: **${safe}.md**`; break;
        }
        case 'obsidian_append': {
          const vaultPath = process.env.OBSIDIAN_VAULT_PATH || process.env.VAULT_PATH;
          if (!vaultPath) { label = '⚠️ OBSIDIAN_VAULT_PATH not set in .env'; break; }
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

  // OpenClaw Agent Pool note — per-exec targeted categories
  const ocExec = OPENCLAW_EXEC_CATEGORIES[agentId];
  const openclawNote = ocExec ? `

OPENCLAW AGENT POOL — 187 temporary specialist agents on demand (github.com/mergisi/awesome-openclaw-agents)
Your priority categories for ${ocExec.focus}:
${ocExec.cats.map(cat => {
  const agents = OPENCLAW_CATEGORY_AGENTS[cat] || '';
  const count = (SKILL_MANIFEST.openclaw_agents.find(s => s.id === `openclaw:${cat}`) || {}).desc || '';
  return `  • ${cat.toUpperCase()}: ${agents}`;
}).join('\n')}

To deploy any agent temporarily: POST /api/openclaw/agents/deploy with { "agentId": "<id>", "category": "<category>" }
To see all 187 agents: GET /api/openclaw/agents | To see what's deployed: GET /api/openclaw/agents/deployed
Once deployed, agents live in agents/temp/ and can be used as specialised workers until undeployed.
Browse the full pool from the Agent Pool panel in the dashboard.` : '';

  return `
AVAILABLE TOOLS & SKILLS (shared pool — use any that help):
Primary skills for your role:
${primaryList}

When given a task: scan the full skill pool for relevant tools before responding. Use brainstorming to generate options, writing-plans to structure your approach, and the most relevant data/platform skills to produce a high-quality output. You have access to all 55+ OpenCLI-rs platforms, all API integrations, and all Superpowers workflow techniques.${codexNote}${openclawNote}`;
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
${process.env.GMAIL_ADDRESS ? `Company email: ${process.env.GMAIL_ADDRESS} — always use this exact address. Never invent email addresses.` : 'No company email configured — do not invent email addresses.'}
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
      if (!text && (msg.voice || msg.audio)) {
        const fileId = (msg.voice || msg.audio).file_id;
        await sendTelegram(chatId, '🎙️ Transcribing voice message...');
        const transcript = await transcribeTelegramVoice(fileId);
        if (!transcript) {
          await sendTelegram(chatId, '⚠️ Could not transcribe — add GROQ_API_KEY or OPENAI_API_KEY to enable voice messages.');
          continue;
        }
        text = transcript;
        await sendTelegram(chatId, `📝 _Transcribed:_ "${transcript}"`, 'Markdown');
      }
      console.log(`[TG] Message from ${from}: ${text}`);
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
        await sendTelegram(chatId, `${displayName}\n\n${reply}`);
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
    brave_search:      !!process.env.BRAVE_API_KEY,
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
  const { text, provider: reqProvider } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const provider = reqProvider || getTTSProvider();

  // Browser-native: tell client to use Web Speech API
  if (provider === 'webspeech') {
    return res.json({ browser: true, text });
  }

  // Groq TTS (uses existing GROQ_API_KEY — no extra cost)
  if (provider === 'groq') {
    if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'GROQ_API_KEY not set', browser: true, text });
    const voice = process.env.VOICE_GROQ_VOICE || 'Fritz-PlayAI';
    try {
      const r = await axios.post(
        'https://api.groq.com/openai/v1/audio/speech',
        { model: 'playai-tts', voice, input: text.slice(0, 2000), response_format: 'wav' },
        { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, responseType: 'stream' }
      );
      res.set('Content-Type', 'audio/wav');
      return r.data.pipe(res);
    } catch (e) {
      // Gracefully fall back to browser TTS if Groq fails
      return res.json({ browser: true, text, error: e.response?.data?.error?.message || e.message });
    }
  }

  // ElevenLabs TTS
  if (provider === 'elevenlabs') {
    if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not set', browser: true, text });
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Bella
    try {
      const r = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { text: text.slice(0, 2500), model_id: 'eleven_turbo_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
        { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, responseType: 'stream' }
      );
      res.set('Content-Type', 'audio/mpeg');
      return r.data.pipe(res);
    } catch (e) {
      return res.json({ browser: true, text, error: e.response?.data?.detail || e.message });
    }
  }

  res.json({ browser: true, text });
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
// =============================================================================
// PROACTIVE CEO — autonomous company analysis, business plan, self-improvement
// =============================================================================
async function runProactiveCEO() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || process.env.VAULT_PATH;
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
// INIT & START
// =============================================================================
loadOrgChart();
loadDecisions();

server.listen(PORT, () => {
  console.log(`\n🦾 OmniClaw Dashboard`);
  console.log(`   Company:   ${state.company}`);
  console.log(`   Port:      http://localhost:${PORT}`);
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

  // Proactive CEO: run once on startup (60s delay to let everything settle)
  // then daily at 06:00
  setTimeout(runProactiveCEO, 60000);
  cron.schedule('0 6 * * *', runProactiveCEO, { timezone: process.env.TIMEZONE || 'Australia/Sydney' });
  console.log('   CEO:       Proactive sweep scheduled daily at 06:00');

  // Check for updates (non-blocking, fires 5s after startup)
  setTimeout(checkForUpdate, 5000);
  console.log('');
});
