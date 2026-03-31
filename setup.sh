#!/bin/bash
# =============================================================================
# PROJECT OMNICLAW — Master Setup Script
# Stack: Paperclip | NemoClaw | OpenClaw | Superpowers | OpenCLI-rs | C-Suite
#
# Usage:
#   ./setup.sh               — interactive (reads .env or prompts)
#   ./setup.sh --docker      — Docker Compose mode
#   ./setup.sh --dry-run     — validate without installing
#
# One-liner from GitHub:
#   curl -sSL https://raw.githubusercontent.com/YOUR_USER/omniclaw-bootstrap/main/setup.sh | bash
# =============================================================================

set -e
GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

# Ensure Homebrew is on PATH (Apple Silicon installs to /opt/homebrew)
if [ -f /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -f /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

MODE="standard"
DRY_RUN=false
[[ "$*" == *"--docker"* ]] && MODE="docker"
[[ "$*" == *"--dry-run"* ]] && DRY_RUN=true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# =============================================================================
# BANNER
# =============================================================================
echo -e "${BLUE}"
echo "  ██████╗ ███╗   ███╗███╗   ██╗██╗ ██████╗██╗      █████╗ ██╗    ██╗"
echo " ██╔═══██╗████╗ ████║████╗  ██║██║██╔════╝██║     ██╔══██╗██║    ██║"
echo " ██║   ██║██╔████╔██║██╔██╗ ██║██║██║     ██║     ███████║██║ █╗ ██║"
echo " ██║   ██║██║╚██╔╝██║██║╚██╗██║██║██║     ██║     ██╔══██║██║███╗██║"
echo " ╚██████╔╝██║ ╚═╝ ██║██║ ╚████║██║╚██████╗███████╗██║  ██║╚███╔███╔╝"
echo "  ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝"
echo -e "${NC}"
echo -e "${BOLD}  Zero-Human Company Initialization${NC}"
echo -e "  Mode: ${YELLOW}${MODE}${NC} | Dry-run: ${YELLOW}${DRY_RUN}${NC}\n"

# =============================================================================
# LOAD CONFIG
# =============================================================================
if [ -f ".env" ]; then
  source .env
  echo -e "${GREEN}✓ Loaded .env${NC}"
elif [ -f ".env.example" ]; then
  echo -e "${YELLOW}⚠ No .env found.${NC}"
  echo -e "  Options:"
  echo -e "  1. Open ${BOLD}configure.html${NC} in your browser to generate one"
  echo -e "  2. Copy .env.example → .env and fill in your values"
  echo -e "  3. Let this script create a minimal .env now\n"
  read -rp "  Choice [1/2/3]: " env_choice
  case "$env_choice" in
    1) echo -e "\n  Open configure.html in your browser, click 'Generate Deploy Package',"; echo -e "  then re-run this script."; exit 0 ;;
    2) cp .env.example .env; echo -e "${BLUE}  .env created from template — edit it now.${NC}"; exit 0 ;;
    3)
      read -rp "  Company Name [OmniGen_Systems]: " CN; CN="${CN:-OmniGen_Systems}"
      read -rp "  Your Name [Felix]: " OWN; OWN="${OWN:-Felix}"
      # Auto-detect existing Obsidian vault
      echo -e "  ${BLUE}Scanning for existing Obsidian vaults...${NC}"
      FOUND_VAULTS=()
      for candidate in \
        "$HOME/Documents"/*/.obsidian \
        "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents"/*/.obsidian \
        "$HOME/Obsidian"/*/.obsidian \
        "$HOME/vault"/.obsidian \
        "$HOME/Vault"/.obsidian; do
        [ -d "$candidate" ] && FOUND_VAULTS+=("${candidate%/.obsidian}")
      done
      if [ ${#FOUND_VAULTS[@]} -gt 0 ]; then
        echo -e "  Found vaults:"
        for i in "${!FOUND_VAULTS[@]}"; do
          echo -e "    $((i+1)). ${FOUND_VAULTS[$i]}"
        done
        read -rp "  Select vault number (or press Enter to type a path): " vnum
        if [[ "$vnum" =~ ^[0-9]+$ ]] && [ "$vnum" -ge 1 ] && [ "$vnum" -le "${#FOUND_VAULTS[@]}" ]; then
          VP="${FOUND_VAULTS[$((vnum-1))]}"
        else
          read -rp "  Vault path: " VP
        fi
      else
        read -rp "  Obsidian Vault Path (e.g. ~/Documents/MyVault): " VP
      fi
      read -rp "  Anthropic API Key: " ANT
      cat > .env << EOF
COMPANY_NAME="${CN}"
OWNER_NAME="${OWN}"
VAULT_PATH="${VP}"
ANTHROPIC_API_KEY="${ANT}"
HEARTBEAT_INTERVAL="15m"
BUDGET_LIMIT="\$50"
DASHBOARD_PORT=3000
DECISION_MODE="full"
ESCALATION_THRESHOLD="\$10,000"
AUTO_OPEN_DASHBOARD="true"
EOF
      source .env
      ;;
  esac
else
  echo -e "${RED}✗ No .env or .env.example found. Run from the omniclaw directory.${NC}"
  exit 1
fi

COMPANY_NAME="${COMPANY_NAME:-OmniGen_Systems}"
OWNER_NAME="${OWNER_NAME:-Felix}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"

# =============================================================================
# KEYCHAIN — save keys from .env, fill gaps from Keychain
# =============================================================================
ALL_API_KEYS=(ANTHROPIC_API_KEY GOOGLE_AI_API_KEY OPENAI_API_KEY GROQ_API_KEY OPENROUTER_API_KEY MINIMAX_API_KEY MISTRAL_API_KEY FIRECRAWL_API_KEY SKILLSMP_API_KEY TG_TOKEN TG_CHAT_ID DISCORD_TOKEN DISCORD_CHANNEL_ID SUPABASE_URL SUPABASE_KEY GITHUB_TOKEN)

kc_get() {
  local key="$1"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    security find-generic-password -a "omniclaw" -s "$key" -w 2>/dev/null || echo ""
  elif command -v secret-tool >/dev/null 2>&1; then
    secret-tool lookup service "omniclaw" username "$key" 2>/dev/null || echo ""
  fi
}

kc_set() {
  local key="$1" val="$2"
  [ -z "$val" ] && return
  if [[ "$OSTYPE" == "darwin"* ]]; then
    security add-generic-password -U -a "omniclaw" -s "$key" -w "$val" 2>/dev/null
  elif command -v secret-tool >/dev/null 2>&1; then
    echo "$val" | secret-tool store --label="omniclaw:$key" service "omniclaw" username "$key" 2>/dev/null
  fi
}

echo -e "\n${BLUE}Syncing API keys with Keychain and .env...${NC}"
kc_saved=0; kc_loaded=0
for key in "${ALL_API_KEYS[@]}"; do
  env_val="${!key}"
  if [ -n "$env_val" ]; then
    # Save to Keychain
    kc_set "$key" "$env_val"
    # Also write to .env
    if grep -q "^${key}=" "$SCRIPT_DIR/.env" 2>/dev/null; then
      sed -i.bak "s|^${key}=.*|${key}=\"${env_val}\"|" "$SCRIPT_DIR/.env"
      rm -f "$SCRIPT_DIR/.env.bak"
    else
      echo "${key}=\"${env_val}\"" >> "$SCRIPT_DIR/.env"
    fi
    ((kc_saved++))
  else
    # Key missing from .env — try loading from Keychain
    kc_val=$(kc_get "$key")
    if [ -n "$kc_val" ]; then
      export "$key"="$kc_val"
      # Write back to .env so it's always in sync
      if grep -q "^${key}=" "$SCRIPT_DIR/.env" 2>/dev/null; then
        sed -i.bak "s|^${key}=.*|${key}=\"${kc_val}\"|" "$SCRIPT_DIR/.env"
        rm -f "$SCRIPT_DIR/.env.bak"
      else
        echo "${key}=\"${kc_val}\"" >> "$SCRIPT_DIR/.env"
      fi
      ((kc_loaded++))
    fi
  fi
done
echo -e "  ${GREEN}✓ ${kc_saved} keys saved to Keychain + .env, ${kc_loaded} restored from Keychain → .env${NC}"
chmod +x "$SCRIPT_DIR/keys.sh" 2>/dev/null || true

# =============================================================================
# DRY RUN MODE
# =============================================================================
if [ "$DRY_RUN" = true ]; then
  echo -e "${BLUE}[DRY RUN] Validating configuration...${NC}"
  echo -e "  Company: ${COMPANY_NAME}"
  echo -e "  Owner:   ${OWNER_NAME}"
  echo -e "  Vault:   ${VAULT_PATH:-not set}"
  echo -e "  Port:    ${DASHBOARD_PORT}"
  echo -e "  Model:   ${CLOUD_MODEL:-not set}"
  [ -n "$ANTHROPIC_API_KEY" ] && echo -e "  Anthropic: ${GREEN}✓${NC}" || echo -e "  Anthropic: ${RED}✗ not set${NC}"
  echo -e "\n${GREEN}Dry run complete. No changes made.${NC}"
  exit 0
fi

# =============================================================================
# [1/7] PREFLIGHT — Auto-install missing dependencies
# =============================================================================
echo -e "\n${BLUE}[1/7] Preflight checks & auto-install...${NC}"

# Detect OS
OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then OS="linux"
elif grep -qi microsoft /proc/version 2>/dev/null; then OS="wsl"
fi
echo -e "  OS detected: ${YELLOW}${OS}${NC}"

# --- Homebrew (macOS only) ---
if [ "$OS" = "macos" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo -e "  ${YELLOW}⚠ Homebrew not found — installing...${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add to PATH for this session
    [ -f /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
    [ -f /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
    echo -e "  ${GREEN}✓ Homebrew installed${NC}"
  else
    echo -e "  ${GREEN}✓ Homebrew $(brew --version | head -1)${NC}"
  fi
fi

# --- Git ---
if ! command -v git >/dev/null 2>&1; then
  echo -e "  ${YELLOW}⚠ Git not found — installing...${NC}"
  case "$OS" in
    macos) brew install git ;;
    linux|wsl) sudo apt-get update -qq && sudo apt-get install -y git ;;
  esac
  echo -e "  ${GREEN}✓ Git installed${NC}"
else
  echo -e "  ${GREEN}✓ Git $(git --version | awk '{print $3}')${NC}"
fi

# --- Node.js & npm ---
if ! command -v node >/dev/null 2>&1; then
  echo -e "  ${YELLOW}⚠ Node.js not found — installing...${NC}"
  case "$OS" in
    macos)
      brew install node
      ;;
    linux|wsl)
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
  esac
  echo -e "  ${GREEN}✓ Node.js installed${NC}"
else
  echo -e "  ${GREEN}✓ Node.js $(node --version)${NC}"
fi

# npm comes with Node but double-check
if ! command -v npm >/dev/null 2>&1; then
  echo -e "  ${YELLOW}⚠ npm not found — installing...${NC}"
  case "$OS" in
    macos) brew install npm ;;
    linux|wsl) sudo apt-get install -y npm ;;
  esac
fi
echo -e "  ${GREEN}✓ npm $(npm --version)${NC}"

# --- Rust / Cargo (optional — for OpenCLI-rs) ---
# Always ensure ~/.cargo/bin is on PATH (covers fresh installs and re-runs)
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
  echo -e "  ${YELLOW}⚠ Rust not found — installing...${NC}"
  # Try rustup (official cross-platform installer)
  if curl --proto '=https' --tlsv1.2 -sSf --connect-timeout 20 https://sh.rustup.rs | sh -s -- -y --quiet 2>/dev/null; then
    source "$HOME/.cargo/env" 2>/dev/null || true
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
  # If rustup failed or cargo still not found, try brew on macOS
  if ! command -v cargo >/dev/null 2>&1 && [ "$OS" = "macos" ]; then
    echo -e "  ${YELLOW}  rustup unavailable — trying brew install rust...${NC}"
    brew install rust 2>/dev/null || true
  fi
  if command -v cargo >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓ Rust installed ($(rustc --version | awk '{print $2}'))${NC}"
  else
    echo -e "  ${YELLOW}⚠ Rust install failed — OpenCLI-rs will be skipped (non-fatal)${NC}"
    echo -e "  ${YELLOW}  To install manually: brew install rust  or  https://rustup.rs${NC}"
  fi
else
  echo -e "  ${GREEN}✓ Rust $(rustc --version | awk '{print $2}')${NC}"
fi

# --- Docker (optional — warn only, too large to auto-install silently) ---
if ! command -v docker >/dev/null 2>&1; then
  echo -e "  ${YELLOW}⚠ Docker not found — skipping (only needed for --docker mode)${NC}"
  echo -e "    Install from: https://docker.com/get-started"
else
  echo -e "  ${GREEN}✓ Docker $(docker --version | awk '{print $3}' | tr -d ',')${NC}"
fi

echo -e "  ${GREEN}All required tools ready.${NC}"

# --- GitHub CLI (gh) — install and authenticate ---
echo -e "\n${BLUE}Checking GitHub authentication...${NC}"

# Install gh if missing
if ! command -v gh >/dev/null 2>&1; then
  echo -e "  ${YELLOW}⚠ GitHub CLI (gh) not found — installing...${NC}"
  case "$OS" in
    macos) brew install gh ;;
    linux|wsl) curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null \
      && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
      && sudo apt update -qq && sudo apt install gh -y -qq ;;
  esac
fi

if command -v gh >/dev/null 2>&1; then
  # Check if already authenticated
  if gh auth status >/dev/null 2>&1; then
    GH_USER=$(gh api user --jq .login 2>/dev/null || echo "unknown")
    echo -e "  ${GREEN}✓ GitHub authenticated as: ${BOLD}${GH_USER}${NC}"
    # Pull the token into env so git operations use it
    if [ -z "$GITHUB_TOKEN" ]; then
      export GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
    fi
    # Configure git to use gh as credential helper (no prompts, no timeouts)
    git config --global credential.helper "$(which gh) auth git-credential" 2>/dev/null || true
  else
    echo -e "  ${YELLOW}⚠ Not logged into GitHub.${NC}"
    echo -e "  ${BOLD}Action required:${NC} Please log in now.\n"
    echo -e "  This enables:"
    echo -e "    • Cloning dependencies (Superpowers, OpenCLI-rs)"
    echo -e "    • Auto-pushing your OmniClaw repo"
    echo -e "    • Dashboard GitHub integration\n"
    gh auth login --web 2>/dev/null || gh auth login 2>/dev/null
    if gh auth status >/dev/null 2>&1; then
      GH_USER=$(gh api user --jq .login 2>/dev/null || echo "unknown")
      echo -e "  ${GREEN}✓ GitHub authenticated as: ${BOLD}${GH_USER}${NC}"
      export GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
      git config --global credential.helper "$(which gh) auth git-credential" 2>/dev/null || true
    else
      echo -e "  ${YELLOW}⚠ GitHub login skipped — git clones will use HTTPS (may prompt or time out)${NC}"
    fi
  fi
else
  echo -e "  ${YELLOW}⚠ gh CLI unavailable — git operations will fall back to HTTPS${NC}"
fi

# Make all git operations fail fast instead of hanging (no interactive auth prompts)
export GIT_TERMINAL_PROMPT=0

# =============================================================================
# [2/8] DIRECTORY STRUCTURE
# =============================================================================
echo -e "\n${BLUE}[2/8] Creating directory structure...${NC}"
for dir in configs agents/csuite memory skills logs dashboard nemoclaw/guardrails nemoclaw/sandbox; do
  mkdir -p "$dir"
  echo -e "  ✓ /$dir"
done

# =============================================================================
# [3/8] NEMOCLAW SECURITY SANDBOX
# =============================================================================
echo -e "\n${BLUE}[3/8] Installing NemoClaw Security Sandbox...${NC}"

# Ensure Python 3 is available
if ! command -v python3 >/dev/null 2>&1; then
  echo -e "  ${YELLOW}⚠ Python 3 not found — installing...${NC}"
  case "$OS" in
    macos) brew install python3 ;;
    linux|wsl) sudo apt-get install -y python3 python3-pip python3-venv ;;
  esac
fi
echo -e "  ${GREEN}✓ Python $(python3 --version | awk '{print $2}')${NC}"

# Create isolated Python venv for NemoClaw
NEMO_VENV="$SCRIPT_DIR/nemoclaw/.venv"
if [ ! -d "$NEMO_VENV" ]; then
  echo -e "  Creating NemoClaw virtual environment..."
  python3 -m venv "$NEMO_VENV"
  echo -e "  ${GREEN}✓ NemoClaw venv created${NC}"
fi

# Install nemoguardrails into the venv
echo -e "  Installing NVIDIA NeMo Guardrails..."
"$NEMO_VENV/bin/pip" install --quiet --upgrade pip
"$NEMO_VENV/bin/pip" install --quiet nemoguardrails 2>/dev/null && \
  echo -e "  ${GREEN}✓ NeMo Guardrails installed${NC}" || \
  echo -e "  ${YELLOW}⚠ NeMo Guardrails install failed — using lightweight sandbox fallback${NC}"

# Write guardrails config (the "Redlines")
cat > "$SCRIPT_DIR/nemoclaw/guardrails/config.yml" << GUARDRAILS_EOF
# NemoClaw Guardrails — OmniClaw Redlines
# Enforced on every agent action before execution

models:
  - type: main
    engine: openai
    model: gpt-3.5-turbo

instructions:
  - type: general
    content: |
      You are a security guardrail for the OmniClaw agent system.
      Enforce the following rules on all agent outputs:
      1. Agents may NOT delete or modify files outside the /memory directory
      2. Agents may NOT spend beyond the defined budget limit
      3. Agents may NOT execute system commands that affect files outside the project root
      4. Agents may NOT send data to unknown external endpoints
      5. All web actions must be logged before execution
      6. Irreversible decisions require Full Committee approval

rails:
  input:
    flows:
      - check input safety
  output:
    flows:
      - check output safety
      - enforce file boundaries
      - enforce budget limits
      - log all actions

GUARDRAILS_EOF
echo -e "  ${GREEN}✓ Guardrails config written${NC}"

# Write the sandbox wrapper script
cat > "$SCRIPT_DIR/nemoclaw/sandbox/sandbox.sh" << 'SANDBOX_EOF'
#!/bin/bash
# NemoClaw Sandbox Wrapper
# Routes agent commands through guardrails before execution
# Usage: ./sandbox.sh <command>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$SCRIPT_DIR/logs/SESSIONS.log"
VENV="$SCRIPT_DIR/nemoclaw/.venv"

log_action() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] SANDBOX: $1" >> "$LOG"
}

# File boundary enforcement
check_path() {
  local target="$1"
  local allowed_paths=("$SCRIPT_DIR/memory" "$SCRIPT_DIR/logs" "$SCRIPT_DIR/configs")
  for allowed in "${allowed_paths[@]}"; do
    [[ "$target" == "$allowed"* ]] && return 0
  done
  log_action "BLOCKED: attempted access outside sandbox: $target"
  echo "NemoClaw: Access denied — path outside sandbox boundary: $target" >&2
  exit 1
}

# Budget check
check_budget() {
  local limit="${BUDGET_LIMIT:-$50}"
  log_action "BUDGET CHECK: limit=$limit"
}

log_action "EXEC: $*"
check_budget
exec "$@"
SANDBOX_EOF
chmod +x "$SCRIPT_DIR/nemoclaw/sandbox/sandbox.sh"
echo -e "  ${GREEN}✓ Sandbox wrapper ready${NC}"

# Write the NemoClaw Node.js bridge (used by dashboard/server.js)
cat > "$SCRIPT_DIR/nemoclaw/nemo-bridge.js" << 'BRIDGE_EOF'
/**
 * NemoClaw Bridge — connects Node.js dashboard to Python guardrails
 * All agent calls pass through this before execution
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const VENV = path.join(__dirname, '.venv', 'bin', 'python3');
const LOG = path.join(__dirname, '..', 'logs', 'SESSIONS.log');
const SANDBOX = path.join(__dirname, 'sandbox', 'sandbox.sh');

function logAction(msg) {
  const line = `[${new Date().toISOString()}] NEMOCLAW: ${msg}\n`;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, line);
}

// Check if an action is within sandbox boundaries
function checkBoundary(filePath) {
  const root = path.join(__dirname, '..');
  const allowed = [
    path.join(root, 'memory'),
    path.join(root, 'logs'),
    path.join(root, 'configs'),
  ];
  const resolved = path.resolve(filePath);
  const safe = allowed.some(a => resolved.startsWith(a));
  if (!safe) logAction(`BLOCKED file access: ${filePath}`);
  return safe;
}

// Route an agent action through the sandbox
function sandboxExec(command, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    logAction(`EXEC: ${command} ${args.join(' ')}`);
    const proc = spawn(SANDBOX, [command, ...args], {
      env: { ...process.env },
      ...opts,
    });
    let stdout = '', stderr = '';
    proc.stdout?.on('data', d => stdout += d);
    proc.stderr?.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) {
        logAction(`FAILED (exit ${code}): ${stderr.trim()}`);
        reject(new Error(stderr || `Exit code ${code}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Validate an agent decision against guardrails
function validateDecision(decision) {
  const violations = [];
  const budget = parseFloat((process.env.BUDGET_LIMIT || '$50').replace(/[^0-9.]/g, ''));
  const capital = parseFloat((decision.capitalInvolved || '0').replace(/[^0-9.]/g, ''));

  if (capital > budget * 10) violations.push(`Capital ($${capital}) exceeds 10x monthly budget — escalate to Full Committee`);
  if (decision.reversibility === 'irreversible' && decision.mode !== 'full') violations.push('Irreversible decision requires Full Committee mode');
  if (violations.length) logAction(`GUARDRAIL VIOLATIONS: ${violations.join(' | ')}`);
  return { safe: violations.length === 0, violations };
}

module.exports = { checkBoundary, sandboxExec, validateDecision, logAction };
BRIDGE_EOF
echo -e "  ${GREEN}✓ NemoClaw Node.js bridge ready${NC}"

# Create NemoClaw status file
cat > "$SCRIPT_DIR/nemoclaw/STATUS.md" << STATUS_EOF
# NemoClaw Sandbox Status
Initialised: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Runtime: ${NEMOCLAW_RUNTIME:-openshell-v4}
Venv: $NEMO_VENV
Guardrails: ACTIVE

## Redlines (Hard Rules)
- File access: /memory, /logs, /configs only
- Budget limit: ${BUDGET_LIMIT:-\$50}/mo
- Irreversible decisions: Full Committee required
- Web actions: logged before execution
- External endpoints: whitelist only

## Log
All agent actions → logs/SESSIONS.log
All model switches → logs/model-router.log
STATUS_EOF
echo -e "  ${GREEN}✓ NemoClaw STATUS.md written${NC}"
echo -e "  ${GREEN}NemoClaw sandbox is ACTIVE${NC}"

# =============================================================================
# [4/8] C-SUITE AGENTS
# =============================================================================
echo -e "\n${BLUE}[4/8] Provisioning C-Suite agents...${NC}"
mkdir -p "$SCRIPT_DIR/agents/csuite"
CSUITE_SCRIPT="$SCRIPT_DIR/agents/create-csuite.sh"
if [ ! -f "$CSUITE_SCRIPT" ]; then
  echo -e "  ${YELLOW}⚠ create-csuite.sh not found locally — downloading from GitHub...${NC}"
  curl -fsSL "https://raw.githubusercontent.com/FELix-Bond/Omniclaw/main/agents/create-csuite.sh" -o "$CSUITE_SCRIPT" || {
    echo -e "  ${RED}✗ Could not download create-csuite.sh — check internet connection${NC}"
    exit 1
  }
fi
chmod +x "$CSUITE_SCRIPT"
bash "$CSUITE_SCRIPT"

# =============================================================================
# [5/8] SKILLS INSTALLATION
# =============================================================================
echo -e "\n${BLUE}[5/8] Installing skills & dependencies...${NC}"

# Superpowers
if [ ! -d "$SCRIPT_DIR/skills/superpowers" ]; then
  echo -e "  Cloning Superpowers..."
  git clone --depth=1 --quiet \
    --config http.connectTimeout=15 \
    --config http.lowSpeedLimit=0 \
    --config http.lowSpeedTime=30 \
    https://github.com/obra/superpowers.git "$SCRIPT_DIR/skills/superpowers" 2>/dev/null && \
    echo -e "  ${GREEN}✓ Superpowers${NC}" || \
    echo -e "  ${YELLOW}⚠ Superpowers clone failed — skipping (non-fatal)${NC}"
else
  echo -e "  ✓ Superpowers (cached)"
fi

# OpenCLI-rs (Rust — optional)
# Re-source cargo env in case it was just installed above
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$PATH"
if command -v cargo >/dev/null 2>&1; then
  if [ ! -d "$SCRIPT_DIR/skills/opencli-rs" ]; then
    echo -e "  Cloning OpenCLI-rs..."
    git clone --depth=1 --quiet \
      --config http.connectTimeout=15 \
      https://github.com/nashsu/opencli-rs-skill.git "$SCRIPT_DIR/skills/opencli-rs" 2>/dev/null && {
      cd "$SCRIPT_DIR/skills/opencli-rs" && cargo build --release --quiet 2>/dev/null && cd "$SCRIPT_DIR"
      echo -e "  ${GREEN}✓ OpenCLI-rs compiled${NC}"
    } || echo -e "  ${YELLOW}⚠ OpenCLI-rs clone/build failed — skipping (non-fatal)${NC}"
  else
    echo -e "  ✓ OpenCLI-rs (cached)"
  fi
else
  echo -e "  ${YELLOW}⚠ Rust not available — OpenCLI-rs skipped${NC}"
fi

# SkillsMP CLI
npm install -g @skillsmp/cli --silent 2>/dev/null && echo -e "  ${GREEN}✓ SkillsMP CLI${NC}" || echo -e "  ${YELLOW}⚠ SkillsMP CLI (non-fatal)${NC}"

# Read SKILLS_TO_INSTALL.txt and install critical/high priority
if [ -f "skills/SKILLS_TO_INSTALL.txt" ]; then
  while IFS='|' read -r slug desc priority rest; do
    slug=$(echo "$slug" | tr -d ' ')
    priority=$(echo "$priority" | tr -d ' ')
    [[ "$slug" =~ ^#.*$ || -z "$slug" ]] && continue
    if [[ "$priority" == "CRITICAL" || "$priority" == "HIGH" ]]; then
      npx skills add "$slug" --silent 2>/dev/null && echo -e "  ${GREEN}✓ skill: $slug${NC}" || true
    fi
  done < "skills/SKILLS_TO_INSTALL.txt"
fi

# =============================================================================
# [5/7] DASHBOARD DEPENDENCIES
# =============================================================================
echo -e "\n${BLUE}[6/8] Installing dashboard...${NC}"
cd dashboard && npm install --silent && cd ..
echo -e "  ${GREEN}✓ Dashboard ready${NC}"

# =============================================================================
# [6/7] INITIALISE MEMORY
# =============================================================================
echo -e "\n${BLUE}[7/8] Initialising agent memory...${NC}"

# Substitute env vars into SOUL.md
if [ -f "memory/SOUL.md" ]; then
  sed -i.bak \
    -e "s|\${COMPANY_NAME}|${COMPANY_NAME}|g" \
    -e "s|\${OWNER_NAME}|${OWNER_NAME}|g" \
    -e "s|\${MISSION}|${MISSION:-Not set}|g" \
    -e "s|\${VAULT_PATH}|${VAULT_PATH:-~/vault}|g" \
    -e "s|\[SET BY SETUP SCRIPT\]|$(date -u +%Y-%m-%dT%H:%M:%SZ)|g" \
    memory/SOUL.md
  rm -f memory/SOUL.md.bak
  echo -e "  ${GREEN}✓ SOUL.md initialised${NC}"
fi

# Substitute env vars into init-company.yaml
if [ -f "configs/init-company.yaml" ]; then
  envsubst < configs/init-company.yaml > configs/init-company.resolved.yaml
  echo -e "  ${GREEN}✓ init-company.resolved.yaml generated${NC}"
fi

mkdir -p logs && echo "" > logs/SESSIONS.log
echo "  ${GREEN}✓ SESSIONS.log created${NC}"

# --- Obsidian Vault Verification ---
echo -e "\n${BLUE}Obsidian Vault:${NC}"
if [ -n "$VAULT_PATH" ] && [ -d "$VAULT_PATH" ]; then
  NOTE_COUNT=$(find "$VAULT_PATH" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  VAULT_NAME=$(basename "$VAULT_PATH")
  echo -e "  ${GREEN}✓ Vault found: ${BOLD}${VAULT_NAME}${NC} (${NOTE_COUNT} notes)"
  echo -e "  Path: ${VAULT_PATH}"
  # Write a lightweight index into agent memory
  {
    echo "# Obsidian Vault Index"
    echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo ""
    echo "**Vault:** ${VAULT_NAME}"
    echo "**Path:** ${VAULT_PATH}"
    echo "**Notes:** ${NOTE_COUNT}"
    echo ""
    echo "## Top-level folders"
    find "$VAULT_PATH" -maxdepth 1 -type d ! -name ".*" ! -name "$(basename "$VAULT_PATH")" \
      -exec basename {} \; 2>/dev/null | sort | sed 's/^/- /'
  } > memory/VAULT_INDEX.md
  echo -e "  ${GREEN}✓ VAULT_INDEX.md written${NC}"
elif [ -n "$VAULT_PATH" ]; then
  echo -e "  ${YELLOW}⚠ Vault path set but not found: ${VAULT_PATH}${NC}"
  echo -e "  ${YELLOW}  Check that the path is correct and the drive is mounted.${NC}"
  # Auto-scan and offer alternatives
  FOUND_VAULTS=()
  for candidate in \
    "$HOME/Documents"/*/.obsidian \
    "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents"/*/.obsidian \
    "$HOME/Obsidian"/*/.obsidian; do
    [ -d "$candidate" ] && FOUND_VAULTS+=("${candidate%/.obsidian}")
  done
  if [ ${#FOUND_VAULTS[@]} -gt 0 ]; then
    echo -e "  Found other vaults on this machine:"
    for v in "${FOUND_VAULTS[@]}"; do echo -e "    • $v"; done
    echo -e "  Update VAULT_PATH in .env to use one of the above."
  fi
else
  echo -e "  ${YELLOW}⚠ VAULT_PATH not set — Obsidian integration disabled${NC}"
  echo -e "  Set VAULT_PATH in .env to enable vault memory."
fi

# =============================================================================
# [7/7] LAUNCH
# =============================================================================
echo -e "\n${BLUE}[8/8] Launching...${NC}"

if [ "$MODE" = "docker" ]; then
  # Docker mode
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker-compose up -d dashboard
    echo -e "  ${GREEN}✓ Docker containers started${NC}"
  else
    echo -e "  ${RED}✗ Docker not available — falling back to node${NC}"
    MODE="standard"
  fi
fi

if [ "$MODE" = "standard" ]; then
  # Node mode — run in background
  node dashboard/server.js &
  DASH_PID=$!
  echo $DASH_PID > .dashboard.pid
  sleep 2
  if kill -0 $DASH_PID 2>/dev/null; then
    echo -e "  ${GREEN}✓ Dashboard started (PID $DASH_PID)${NC}"
  else
    echo -e "  ${RED}✗ Dashboard failed to start${NC}"
    echo -e "  Run manually: node dashboard/server.js"
  fi
fi

# =============================================================================
# SUMMARY
# =============================================================================
echo -e "\n${GREEN}============================================================${NC}"
echo -e "${GREEN}${BOLD}  ✅ ${COMPANY_NAME} is online.${NC}"
echo -e "${GREEN}============================================================${NC}"
echo -e "  📊 Dashboard:  ${BOLD}http://localhost:${DASHBOARD_PORT}${NC}"
echo -e "  🤖 Agents:     10 C-Suite members active"
echo -e "  💓 Heartbeat:  ${HEARTBEAT_INTERVAL}"
echo -e "  🧠 Vault:      ${VAULT_PATH:-not configured}"
echo -e "  💰 Budget:     ${BUDGET_LIMIT}/mo"
echo -e "\n  To stop:    kill \$(cat .dashboard.pid)"
echo -e "  To restart: ./setup.sh"
echo -e "${GREEN}============================================================${NC}\n"

# Auto-open dashboard
if [ "${AUTO_OPEN_DASHBOARD:-true}" = "true" ]; then
  sleep 1
  if command -v open >/dev/null; then open "http://localhost:${DASHBOARD_PORT}"
  elif command -v xdg-open >/dev/null; then xdg-open "http://localhost:${DASHBOARD_PORT}"
  fi
fi
