# 🦾 OmniClaw — Zero-Human Company

### Autonomous Agentic Stack | Paperclip + NemoClaw + OpenClaw + Superpowers + C-Suite AI

**OmniClaw** is a complete, self-deploying "Company-in-a-Box." A full AI executive team — 10 C-Suite agents — runs autonomously, makes decisions through a formal decision engine, and reports back to you via Telegram, Discord, or the built-in dashboard.

---

## The Stack

| Layer | Component | Role |
|---|---|---|
| **Orchestrator** | Paperclip AI | CEO dashboard & heartbeat scheduler |
| **Runtime** | NVIDIA NemoClaw | Secure sandboxed agent execution |
| **Workers** | OpenClaw | Research, task execution, deep analysis |
| **Brain** | Google TurboQuant INT4 | Local inference (fast + cheap) |
| **Skills** | Superpowers + SkillsMP | 400+ agent capabilities |
| **Limbs** | OpenCLI-rs | Chrome, Discord, WhatsApp, Telegram |
| **Memory** | Obsidian Vault | Long-term agent memory |
| **Voice** | Voicebox.io | Hands-free briefings |

---

## Quick Start — 3 Steps

### Step 1: Configure (One Time, All Info)

Open `configure.html` in your browser. Fill in your details once — company name, API keys, vault path, agents — and click **Generate Deploy Package**. This downloads a pre-configured `deploy-omniclaw.sh`.

> Nothing is sent to any server. All processing happens in your browser.

### Step 2: Deploy

Copy `deploy-omniclaw.sh` to your target machine and run:

```bash
chmod +x deploy-omniclaw.sh && ./deploy-omniclaw.sh
```

### Step 3: Open Dashboard

```
http://localhost:3000
```

---

## The C-Suite

10 AI executive agents, each with a defined persona, authority level, and domain:

| Agent | Title | Persona | Authority |
|---|---|---|---|
| CEO | Chief Executive Officer | The Operator | Final Authority |
| CFO | Chief Financial Officer | The Capital Allocator | **Veto** |
| COO | Chief Operating Officer | The Executor | Domain |
| CTO | Chief Technology Officer | The Architect | Domain |
| CSO | Chief Strategy Officer | The Strategist | Domain |
| CRO | Chief Risk Officer | The Protector | **Veto** |
| CIO | Chief Information Officer | The Intelligence Layer | Domain |
| CPO | Chief Product Officer | The Builder | Domain |
| CHRO | Chief HR Officer | The Culture Builder | Domain |
| CLO | Chief Legal Officer | The Guardian | **Veto** |

### Decision Flow

1. CEO defines the decision
2. Each agent evaluates through their domain lens
3. CRO/CFO/CLO can issue hard vetoes
4. CEO synthesises into a single directive
5. COO converts to an execution plan

---

## Repository Structure

```
omniclaw-bootstrap/
├── configure.html              # ONE-PAGER: fill in once, generate everything
├── setup.sh                    # Master init script (for manual/CI use)
├── docker-compose.yml          # Docker deployment
├── .env.example                # Environment template
├── configs/
│   └── init-company.yaml       # Company manifest (populated from .env)
├── agents/
│   ├── create-csuite.sh        # Auto-provisions all 10 C-Suite .md files
│   └── csuite/                 # CEO.md, CFO.md, COO.md ... CLO.md
├── dashboard/
│   ├── server.js               # Express + Socket.IO real-time dashboard
│   ├── public/index.html       # Paperclip-style UI
│   └── package.json
├── memory/
│   ├── SOUL.md                 # Agent identity & values core
│   └── HEARTBEATS.md           # Wake cycle log
├── skills/
│   └── SKILLS_TO_INSTALL.txt   # Curated SkillsMP fast-track list
└── .github/workflows/
    └── deploy.yml              # CI/CD: validate, build, test
```

---

## Manual Setup (Alternative to configure.html)

```bash
# 1. Clone
git clone https://github.com/YOUR_USER/omniclaw-bootstrap.git
cd omniclaw-bootstrap

# 2. Configure
cp .env.example .env
nano .env   # Fill in your paths and API keys

# 3. Run
chmod +x setup.sh && ./setup.sh

# Or with Docker:
./setup.sh --docker
```

---

## Creating the GitHub Repository

After running `configure.html`:

```bash
cd omniclaw-bootstrap
git init
git add -A
git commit -m "Initial OmniClaw deployment"
git remote add origin https://github.com/YOUR_USER/omniclaw-bootstrap.git
git push -u origin main
```

Or use the **GitHub** panel in the dashboard to push directly.

---

## Safety Guardrails (NemoClaw Redlines)

- Agents **cannot delete** files outside `/memory`
- Agents **cannot spend** beyond the defined `BUDGET_LIMIT`
- All web actions via OpenCLI-rs are logged in `logs/SESSIONS.log`
- CRO, CFO, and CLO have **hard veto power** — any fatal risk, financial collapse scenario, or legal breach auto-rejects the decision

---

## Prerequisites

- **Node.js 18+** and **npm** (required)
- **Git** (required)
- **Rust / Cargo** (optional — for OpenCLI-rs)
- **Docker** (optional — for containerised deployment)
- **NVIDIA GPU** (optional — for TurboQuant acceleration)
- **Obsidian** with an existing vault (recommended)
- **Chrome** logged into Gmail, Discord, WhatsApp Web (for OpenCLI-rs bridges)

---

## Contributing

New OpenCLI-rs skills or Superpowers workflows? Submit a PR. New C-Suite persona definitions? Open an issue.

---

*Built on: Paperclip · NemoClaw · OpenClaw · Superpowers · SkillsMP · Obsidian · Firecrawl · Voicebox.io*
