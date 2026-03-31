/**
 * OmniClaw — Paperclip Dashboard Server
 * Real-time agent status, decision engine, heartbeat monitor
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const yaml = require('js-yaml');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.DASHBOARD_PORT || 3000;
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

function getSystemPrompt() {
  const ceo = state.agents['CEO'];
  const profile = readAgentProfile('CEO') || '';
  return `You are TommyClaw, the AI CEO of ${state.company}, talking directly with ${state.owner}. You are part of the OmniClaw platform — an autonomous executive AI stack. Your website is tommyclaw.com.

HONESTY RULES — never break these:
- Never claim capabilities you don't have. You cannot send emails, browse the web, access servers, run code, or control any external system.
- Never confirm something just because the user states it. If you don't know, say so.
- Never invent domain names, email addresses, credentials, or infrastructure details unless explicitly told them in this conversation.
- If asked whether you have access to something and you don't — say no clearly.

PERSONALITY: Sharp, confident, direct. Talk like a founder — not a corporate bot. Short sentences, plain language, no jargon. Match the energy: casual message = casual reply, strategy question = strategic answer. No bullet lists or formal headers unless the question actually needs it.

Company: ${state.company} | Owner: ${state.owner}
${profile ? '\n' + profile.slice(0, 600) : ''}`;
}

async function callAI(messages) {
  // Build chain from MODEL_CHAIN vars, then auto-detect any configured keys as fallback
  const chainVars = [process.env.MODEL_CHAIN_1, process.env.MODEL_CHAIN_2, process.env.MODEL_CHAIN_3].filter(Boolean);
  const autoFallbacks = [];
  if (!chainVars.some(c => c.startsWith('anthropic')) && process.env.ANTHROPIC_API_KEY) autoFallbacks.push('anthropic::claude-haiku-4-5-20251001');
  if (!chainVars.some(c => c.startsWith('groq'))      && process.env.GROQ_API_KEY)      autoFallbacks.push('groq::llama-3.3-70b-versatile');
  if (!chainVars.some(c => c.startsWith('gemini'))    && process.env.GOOGLE_AI_API_KEY) autoFallbacks.push('gemini::gemini-1.5-flash');
  if (!chainVars.some(c => c.startsWith('openrouter'))&& process.env.OPENROUTER_API_KEY)autoFallbacks.push('openrouter::meta-llama/llama-3.1-8b-instruct:free');
  const chain = [...chainVars, ...autoFallbacks];

  for (const slot of chain) {
    const [provider, model] = (slot || '').split('::');
    try {
      if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
        const r = await axios.post('https://api.anthropic.com/v1/messages', {
          model: model || 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: getSystemPrompt(),
          messages,
        }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 });
        return r.data.content[0].text;
      }
      if (provider === 'groq' && process.env.GROQ_API_KEY) {
        const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: model || 'llama-3.3-70b-versatile',  // updated model name
          messages: [{ role: 'system', content: getSystemPrompt() }, ...messages],
          max_tokens: 1024,
        }, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 30000 });
        return r.data.choices[0].message.content;
      }
      if (provider === 'gemini' && process.env.GOOGLE_AI_API_KEY) {
        const geminiModel = model || 'gemini-1.5-flash';
        const r = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`,
          { contents: [{ role: 'user', parts: [{ text: getSystemPrompt() + '\n\n' + messages.map(m => `${m.role}: ${m.content}`).join('\n') }] }] },
          { timeout: 30000 }
        );
        return r.data.candidates[0].content.parts[0].text;
      }
      if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
        const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
          model: model || 'meta-llama/llama-3.1-8b-instruct:free',
          messages: [{ role: 'system', content: getSystemPrompt() }, ...messages],
        }, { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://omniclaw.ai' }, timeout: 30000 });
        return r.data.choices[0].message.content;
      }
      if (provider === 'ollama') {
        const r = await axios.post('http://localhost:11434/api/chat', {
          model: model || 'llama3.1', stream: false,
          messages: [{ role: 'system', content: getSystemPrompt() }, ...messages],
        }, { timeout: 60000 });
        return r.data.message.content;
      }
    } catch (e) {
      console.log(`[CHAT] ${provider} failed: ${e.message} — trying next`);
    }
  }
  return 'No AI provider is configured or responding. Add an API key to your .env file (ANTHROPIC_API_KEY, GROQ_API_KEY, or GOOGLE_AI_API_KEY).';
}

app.post('/api/chat', async (req, res) => {
  const { message, source } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  chatHistory.push({ role: 'user', content: message, source: source || 'dashboard', timestamp: new Date().toISOString() });
  io.emit('chat:message', { role: 'user', content: message, source: source || 'dashboard', timestamp: new Date().toISOString() });

  try {
    const msgs = chatHistory.filter(m => m.role === 'user' || m.role === 'assistant').slice(-10).map(m => ({ role: m.role, content: m.content }));
    const reply = await callAI(msgs);
    const response = { role: 'assistant', content: reply, source: 'CEO', timestamp: new Date().toISOString() };
    chatHistory.push(response);
    if (chatHistory.length > 200) chatHistory.splice(0, 50);

    io.emit('chat:message', response);
    res.json(response);

    // Log as agent activity
    if (state.agents['CEO']) {
      state.agents['CEO'].lastActive = new Date().toISOString();
      state.agents['CEO'].currentTask = 'Responding to query';
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
// TELEGRAM — long-poll bot, relay messages through CEO agent
// =============================================================================
let tgOffset = 0;
let tgEnabled = false;

async function sendTelegram(chatId, text) {
  if (!process.env.TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
      chat_id: chatId, text,
    }, { timeout: 10000 });
  } catch (e) { console.log('[TG] Send failed:', e.message); }
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
      if (!msg?.text) continue;
      const chatId = msg.chat.id;
      const text = msg.text;
      const from = msg.from?.first_name || 'User';
      console.log(`[TG] Message from ${from}: ${text}`);
      io.emit('chat:message', { role: 'user', content: text, source: `Telegram (${from})`, timestamp: new Date().toISOString() });

      // Route through CEO
      try {
        const msgs = [{ role: 'user', content: text }];
        const reply = await callAI(msgs);
        await sendTelegram(chatId, reply);
        io.emit('chat:message', { role: 'assistant', content: reply, source: 'CEO', timestamp: new Date().toISOString() });
        chatHistory.push({ role: 'user', content: text, source: `Telegram (${from})`, timestamp: new Date().toISOString() });
        chatHistory.push({ role: 'assistant', content: reply, source: 'CEO', timestamp: new Date().toISOString() });
      } catch (e) {
        await sendTelegram(chatId, 'Sorry, I encountered an error processing your message.');
      }
    }
  } catch (e) {
    if (!e.message.includes('timeout')) console.log('[TG] Poll error:', e.message);
  }
  setTimeout(pollTelegram, 1000);
}

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
  } else {
    console.log(`   Telegram:  Not configured (add TG_TOKEN to .env)`);
  }

  // Detect which AI provider is active
  const chain = [process.env.MODEL_CHAIN_1, process.env.MODEL_CHAIN_2, process.env.MODEL_CHAIN_3].filter(Boolean);
  console.log(`   AI Chain:  ${chain.join(' → ') || 'Not configured'}`);

  // Check for updates (non-blocking, fires 5s after startup)
  setTimeout(checkForUpdate, 5000);
  console.log('');
});
