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
// INIT & START
// =============================================================================
loadOrgChart();
loadDecisions();

server.listen(PORT, () => {
  console.log(`\n🦾 OmniClaw Dashboard`);
  console.log(`   Company: ${state.company}`);
  console.log(`   Port:    http://localhost:${PORT}`);
  console.log(`   Agents:  ${Object.keys(state.agents).length} active`);
  console.log(`   Heartbeat: ${state.heartbeat}\n`);
});
