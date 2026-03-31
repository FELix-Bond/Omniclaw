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
- Never claim capabilities you don't have. You cannot send emails, browse the web, access servers, run code, or control any external system.
- Never confirm something just because the user states it. If you don't know, say so.
- Never invent domain names, email addresses, credentials, or infrastructure details unless explicitly told them in this conversation.
- If asked whether you have access to something and you don't — say no clearly.

PERSONALITY: Sharp, confident, direct. Talk like a founder — not a corporate bot. Short sentences, plain language, no jargon. Match the energy: casual message = casual reply, strategy question = strategic answer. No bullet lists or formal headers unless the question actually needs it.

Company: ${state.company} | Owner: ${state.owner}
${ownerProfile ? '\nOwner context:\n' + ownerProfile.slice(0, 800) : ''}
${profile ? '\nYour persona:\n' + profile.slice(0, 400) : ''}`;
}

async function callAI(messages, systemPromptOverride) {
  const sysPrompt = systemPromptOverride || getSystemPrompt();
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
          system: sysPrompt,
          messages,
        }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 });
        return r.data.content[0].text;
      }
      if (provider === 'groq' && process.env.GROQ_API_KEY) {
        const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: model || 'llama-3.3-70b-versatile',  // updated model name
          messages: [{ role: 'system', content: sysPrompt }, ...messages],
          max_tokens: 1024,
        }, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 30000 });
        return r.data.choices[0].message.content;
      }
      if (provider === 'gemini' && process.env.GOOGLE_AI_API_KEY) {
        const geminiModel = model || 'gemini-1.5-flash';
        const r = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`,
          { contents: [{ role: 'user', parts: [{ text: sysPrompt + '\n\n' + messages.map(m => `${m.role}: ${m.content}`).join('\n') }] }] },
          { timeout: 30000 }
        );
        return r.data.candidates[0].content.parts[0].text;
      }
      if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
        const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
          model: model || 'meta-llama/llama-3.1-8b-instruct:free',
          messages: [{ role: 'system', content: sysPrompt }, ...messages],
        }, { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://omniclaw.ai' }, timeout: 30000 });
        return r.data.choices[0].message.content;
      }
      if (provider === 'ollama') {
        const r = await axios.post('http://localhost:11434/api/chat', {
          model: model || 'llama3.1', stream: false,
          messages: [{ role: 'system', content: sysPrompt }, ...messages],
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
};

// Per-agent primary skill focus (NOT restrictions — all agents access full pool)
const AGENT_PRIMARY_SKILLS = {
  CEO:  ['brainstorming', 'writing-plans', 'executing-plans', 'dispatching-parallel-agents', 'codex:meta-orchestration', 'gmail', 'google-docs', 'slack'],
  CFO:  ['yahoo-finance', 'bloomberg', 'stripe', 'google-sheets', 'hubspot', 'writing-plans', 'verification-before-completion', 'codex:data-ai', 'codex:specialized'],
  COO:  ['executing-plans', 'writing-plans', 'google-sheets', 'notion-api', 'slack', 'dispatching-parallel-agents', 'codex:meta-orchestration', 'codex:devex'],
  CTO:  [
    // Core engineering
    'github', 'stackoverflow', 'hackernews', 'arxiv', 'cursor', 'systematic-debugging', 'google-drive',
    // Codex subagent categories — full access with deep briefing below
    'codex:core-dev', 'codex:language-specialists', 'codex:infrastructure',
    'codex:quality-security', 'codex:data-ai', 'codex:devex',
    'codex:specialized', 'codex:meta-orchestration', 'codex:research-analysis',
  ],
  CSO:  ['brainstorming', 'perplexity', 'firecrawl', 'bloomberg', 'bbc', 'arxiv', 'writing-plans', 'codex:research-analysis', 'codex:business-product'],
  CMO:  ['twitter', 'instagram', 'tiktok', 'reddit', 'linkedin', 'youtube', 'medium', 'substack', 'firecrawl', 'perplexity', 'brainstorming', 'writing-plans', 'codex:research-analysis', 'codex:business-product'],
  CRO:  ['systematic-debugging', 'verification-before-completion', 'bloomberg', 'hubspot', 'stripe', 'writing-plans', 'codex:quality-security'],
  CIO:  ['google-sheets', 'supabase', 'perplexity', 'google', 'bbc', 'arxiv', 'dispatching-parallel-agents', 'codex:data-ai', 'codex:research-analysis'],
  CPO:  ['brainstorming', 'writing-plans', 'notion-api', 'github', 'google-docs', 'verification-before-completion', 'codex:business-product', 'codex:devex'],
  CHRO: ['linkedin', 'notion-api', 'google-docs', 'slack', 'gmail', 'writing-plans', 'codex:business-product'],
  CLO:  ['google', 'arxiv', 'notion-api', 'google-docs', 'gmail', 'verification-before-completion', 'codex:business-product', 'codex:quality-security'],
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

  return `
AVAILABLE TOOLS & SKILLS (shared pool — use any that help):
Primary skills for your role:
${primaryList}

When given a task: scan the full skill pool for relevant tools before responding. Use brainstorming to generate options, writing-plans to structure your approach, and the most relevant data/platform skills to produce a high-quality output. You have access to all 55+ OpenCLI-rs platforms, all API integrations, and all Superpowers workflow techniques.${codexNote}`;
}

async function sendTelegram(chatId, text) {
  if (!process.env.TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
      chat_id: chatId, text,
    }, { timeout: 10000 });
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
HONESTY: Never claim capabilities you lack. Never invent details. If you don't know, say so.
Company: ${state.company} | Owner: ${state.owner}
${profile ? profile.slice(0, 500) : ''}
${skillContext}`;
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
        const reply = await callAI(msgs, systemPrompt);
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
  res.json({
    telegram:   !!process.env.TG_TOKEN,
    discord:    !!process.env.DISCORD_TOKEN,
    slack:      !!process.env.SLACK_BOT_TOKEN,
    gmail:      !!(process.env.GMAIL_ADDRESS && process.env.GMAIL_APP_PASSWORD),
    google_suite: !!(process.env.GOOGLE_CLIENT_ID && fs.existsSync(GOOGLE_TOKEN_PATH)),
    google_oauth_ready: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    notion:     !!process.env.NOTION_TOKEN,
    hubspot:    !!process.env.HUBSPOT_API_KEY,
    stripe:     !!process.env.STRIPE_API_KEY,
    firecrawl:  !!process.env.FIRECRAWL_API_KEY,
    perplexity: !!process.env.PERPLEXITY_API_KEY,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    supabase:   !!process.env.SUPABASE_URL,
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

  // Check for updates (non-blocking, fires 5s after startup)
  setTimeout(checkForUpdate, 5000);
  console.log('');
});
