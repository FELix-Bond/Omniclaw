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
      read -rp "  Obsidian Vault Path: " VP
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
if ! command -v cargo >/dev/null 2>&1; then
  echo -e "  ${YELLOW}⚠ Rust not found — installing (needed for OpenCLI-rs)...${NC}"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --quiet
  source "$HOME/.cargo/env" 2>/dev/null || true
  echo -e "  ${GREEN}✓ Rust installed${NC}"
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

# =============================================================================
# [2/7] DIRECTORY STRUCTURE
# =============================================================================
echo -e "\n${BLUE}[2/7] Creating directory structure...${NC}"
for dir in configs agents/csuite memory skills logs dashboard; do
  mkdir -p "$dir"
  echo -e "  ✓ /$dir"
done

# =============================================================================
# [3/7] C-SUITE AGENTS
# =============================================================================
echo -e "\n${BLUE}[3/7] Provisioning C-Suite agents...${NC}"
chmod +x agents/create-csuite.sh
bash agents/create-csuite.sh

# =============================================================================
# [4/7] SKILLS INSTALLATION
# =============================================================================
echo -e "\n${BLUE}[4/7] Installing skills & dependencies...${NC}"

# Superpowers
if [ ! -d "skills/superpowers" ]; then
  git clone https://github.com/obra/superpowers.git skills/superpowers --depth=1 --quiet && \
  echo -e "  ${GREEN}✓ Superpowers${NC}" || echo -e "  ${YELLOW}⚠ Superpowers clone failed${NC}"
else
  echo -e "  ✓ Superpowers (cached)"
fi

# OpenCLI-rs (Rust)
if command -v cargo >/dev/null 2>&1; then
  if [ ! -d "skills/opencli-rs" ]; then
    git clone https://github.com/nashsu/opencli-rs-skill.git skills/opencli-rs --depth=1 --quiet
    cd skills/opencli-rs && cargo build --release --quiet && cd ../..
    echo -e "  ${GREEN}✓ OpenCLI-rs compiled${NC}"
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
echo -e "\n${BLUE}[5/7] Installing dashboard...${NC}"
cd dashboard && npm install --silent && cd ..
echo -e "  ${GREEN}✓ Dashboard ready${NC}"

# =============================================================================
# [6/7] INITIALISE MEMORY
# =============================================================================
echo -e "\n${BLUE}[6/7] Initialising agent memory...${NC}"

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

echo "" > logs/SESSIONS.log
echo "  ${GREEN}✓ SESSIONS.log created${NC}"

# =============================================================================
# [7/7] LAUNCH
# =============================================================================
echo -e "\n${BLUE}[7/7] Launching...${NC}"

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
