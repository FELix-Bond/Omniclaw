#!/bin/bash
# =============================================================================
# OmniClaw — Setup / Upgrade Script  v2.0
# Idempotent: safe to run on a fresh install OR over an existing one.
# Never fails on pre-existing files, clones, or node_modules.
# =============================================================================
# Usage:
#   ./setup.sh               — standard (fresh or upgrade)
#   ./setup.sh --docker      — Docker Compose mode
#   ./setup.sh --dry-run     — validate config without installing
# =============================================================================

# NO set -e — every command handles its own errors so nothing kills the install.
GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }
log()  { echo -e "\n${BLUE}$*${NC}"; }

MODE="standard"
DRY_RUN=false
[[ "$*" == *"--docker"*  ]] && MODE="docker"
[[ "$*" == *"--dry-run"* ]] && DRY_RUN=true

# Detect fresh install vs upgrade
IS_UPGRADE=false
{ [ -f ".dashboard.pid" ] || [ -d "dashboard/node_modules" ] || [ -f "memory/decisions.json" ]; } && IS_UPGRADE=true

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
if [ "$IS_UPGRADE" = true ]; then
  echo -e "${BOLD}  Upgrade / Re-install detected — preserving your data${NC}"
else
  echo -e "${BOLD}  Zero-Human Company Initialization${NC}"
fi
echo -e "  Mode: ${YELLOW}${MODE}${NC} | Dry-run: ${YELLOW}${DRY_RUN}${NC}\n"

# =============================================================================
# [0] STOP ANY RUNNING INSTANCE
# =============================================================================
log "[0] Stopping any running OmniClaw instance..."
if [ -f ".dashboard.pid" ]; then
  OLD_PID=$(cat .dashboard.pid 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
    ok "Stopped previous dashboard (PID $OLD_PID)"
  fi
  rm -f .dashboard.pid
fi
# Also clear anything holding the port
DASHBOARD_PORT_TMP="${DASHBOARD_PORT:-3000}"
lsof -ti ":${DASHBOARD_PORT_TMP}" 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "node.*server\.js" 2>/dev/null || true
ok "Port ${DASHBOARD_PORT_TMP} cleared"

# =============================================================================
# [1] LOAD & MERGE .env
# =============================================================================
log "[1/7] Loading configuration..."

# Helper: safely source a file into current shell
safe_source() { set -a; source "$1" 2>/dev/null || true; set +a; }

if [ -f ".env" ]; then
  safe_source ".env"
  ok "Loaded .env"

  # If .env.example exists, check for any keys present in the example but MISSING
  # from the live .env — and append them (with their example values, not overwriting).
  # This handles upgrades where new features add new env vars.
  if [ -f ".env.example" ]; then
    ADDED=0
    while IFS= read -r line; do
      [[ "$line" =~ ^#.*$ || -z "${line// }" ]] && continue
      key="${line%%=*}"
      [[ -z "$key" || "$key" == "$line" ]] && continue
      if ! grep -q "^${key}=" ".env" 2>/dev/null; then
        echo "$line" >> ".env"
        ADDED=$((ADDED+1))
      fi
    done < ".env.example"
    [ $ADDED -gt 0 ] && ok "Added $ADDED new config keys from template (upgrade)" || ok ".env is up to date"
    safe_source ".env"
  fi

elif [ -f ".env.example" ]; then
  cp ".env.example" ".env"
  safe_source ".env"
  warn ".env not found — created from template."
  warn "Edit .env with your API keys before running agents."

else
  # No .env at all — interactive minimal setup
  echo -e "${YELLOW}No .env found. Let's create a minimal one now.${NC}\n"

  read -rp "  Company Name [OmniGen_Systems]: " CN; CN="${CN:-OmniGen_Systems}"
  read -rp "  Your Name [Owner]: " OWN; OWN="${OWN:-Owner}"

  # Auto-scan for Obsidian vaults
  echo -e "\n  ${BLUE}Scanning for Obsidian vaults...${NC}"
  FOUND_VAULTS=()
  for candidate in \
    "$HOME/Documents"/*/.obsidian \
    "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents"/*/.obsidian \
    "$HOME/Obsidian"/*/.obsidian \
    "$HOME/vault"/.obsidian \
    "$HOME/Vault"/.obsidian; do
    [ -d "$candidate" ] && FOUND_VAULTS+=("${candidate%/.obsidian}")
  done
  VP=""
  if [ ${#FOUND_VAULTS[@]} -gt 0 ]; then
    echo -e "  Found vaults:"
    for i in "${!FOUND_VAULTS[@]}"; do echo -e "    $((i+1)). ${FOUND_VAULTS[$i]}"; done
    read -rp "  Select vault [1] or press Enter to type path: " vnum
    if [[ "$vnum" =~ ^[0-9]+$ ]] && [ "$vnum" -ge 1 ] && [ "$vnum" -le "${#FOUND_VAULTS[@]}" ]; then
      VP="${FOUND_VAULTS[$((vnum-1))]}"
    else
      read -rp "  Vault path: " VP
    fi
  else
    read -rp "  Obsidian Vault Path (e.g. ~/Documents/MyVault): " VP
    VP=$(eval echo "$VP")  # expand ~ if present
  fi

  read -rp "  Anthropic API Key (or press Enter to skip): " ANT
  read -rp "  Groq API Key (or press Enter to skip): " GROQK
  read -rp "  Telegram Bot Token (or press Enter to skip): " TGT
  read -rp "  Supabase URL (or press Enter to skip): " SURL
  read -rp "  Supabase Anon Key (or press Enter to skip): " SKEY

  cat > ".env" <<EOF
# OmniClaw Environment — generated by setup.sh
COMPANY_NAME="${CN}"
OWNER_NAME="${OWN}"
VAULT_PATH="${VP}"
DASHBOARD_PORT=3000
HEARTBEAT_INTERVAL=15m
BUDGET_LIMIT=\$50
TIMEZONE=Australia/Sydney
AUTO_OPEN_DASHBOARD=true

# AI Keys
ANTHROPIC_API_KEY="${ANT}"
GROQ_API_KEY="${GROQK}"

# Telegram
TG_TOKEN="${TGT}"
TG_CHAT_ID=""

# Supabase
SUPABASE_URL="${SURL}"
SUPABASE_KEY="${SKEY}"

# Add more keys here or re-run configure.html and replace this file
EOF
  safe_source ".env"
  ok ".env created"
fi

# Defaults for any missing vars
COMPANY_NAME="${COMPANY_NAME:-OmniGen_Systems}"
OWNER_NAME="${OWNER_NAME:-Owner}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"

if [ "$DRY_RUN" = true ]; then
  echo -e "\n${BLUE}[DRY RUN] Configuration summary:${NC}"
  echo -e "  Company:    $COMPANY_NAME"
  echo -e "  Owner:      $OWNER_NAME"
  echo -e "  Port:       $DASHBOARD_PORT"
  echo -e "  Vault:      ${VAULT_PATH:-not set}"
  echo -e "  Supabase:   ${SUPABASE_URL:-not set}"
  [ -n "$ANTHROPIC_API_KEY" ] && echo -e "  Anthropic:  ${GREEN}✓${NC}" || echo -e "  Anthropic:  not set"
  [ -n "$GROQ_API_KEY"      ] && echo -e "  Groq:       ${GREEN}✓${NC}" || echo -e "  Groq:       not set"
  echo -e "\n${GREEN}Dry run complete. No changes made.${NC}"
  exit 0
fi

# =============================================================================
# [2] SYSTEM TOOLS
# =============================================================================
log "[2/7] Checking system tools..."

# Homebrew path (macOS Apple Silicon + Intel)
[ -f /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
[ -f /usr/local/bin/brew    ] && eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true

OS="unknown"
[[ "$OSTYPE" == "darwin"*   ]] && OS="macos"
[[ "$OSTYPE" == "linux-gnu"* ]] && OS="linux"
grep -qi microsoft /proc/version 2>/dev/null && OS="wsl"
ok "OS: $OS"

# Node.js
if command -v node >/dev/null 2>&1; then
  ok "Node.js $(node --version)"
else
  warn "Node.js not found — installing..."
  case "$OS" in
    macos) brew install node 2>/dev/null && ok "Node.js installed" || fail "Node.js install failed — install from nodejs.org" ;;
    linux|wsl)
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
      sudo apt-get install -y nodejs 2>/dev/null && ok "Node.js installed" || fail "Node.js install failed"
      ;;
  esac
fi

# npm
command -v npm >/dev/null 2>&1 && ok "npm $(npm --version)" || warn "npm not found"

# Git
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || warn "git not found — skills installation will be skipped"

# Rust / Cargo (optional — for OpenCLI-rs)
export PATH="$HOME/.cargo/bin:$PATH"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env" 2>/dev/null || true
if command -v cargo >/dev/null 2>&1; then
  ok "Rust $(rustc --version | awk '{print $2}')"
else
  warn "Rust not found — OpenCLI-rs will be skipped (non-fatal)"
  warn "  Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi

# GitHub CLI
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    GH_USER=$(gh api user --jq .login 2>/dev/null || echo "unknown")
    ok "GitHub CLI authenticated as: $GH_USER"
    [ -z "$GITHUB_TOKEN" ] && export GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
    git config --global credential.helper "$(which gh) auth git-credential" 2>/dev/null || true
  else
    warn "GitHub CLI not authenticated — run: gh auth login"
  fi
else
  warn "GitHub CLI not installed — git operations use HTTPS"
fi
export GIT_TERMINAL_PROMPT=0

# =============================================================================
# [3] DIRECTORY STRUCTURE
# =============================================================================
log "[3/7] Ensuring directory structure..."
for dir in configs agents/csuite agents/temp memory skills logs \
            dashboard/public nemoclaw/guardrails nemoclaw/sandbox; do
  mkdir -p "$SCRIPT_DIR/$dir" 2>/dev/null
done
touch "$SCRIPT_DIR/logs/.gitkeep" 2>/dev/null || true
ok "Directories ready"

# =============================================================================
# [4] SKILLS INSTALLATION — git pull if exists, clone if not (never fails)
# =============================================================================
log "[4/7] Installing / updating skills..."

# Core function: idempotent clone-or-pull. Never exits on failure.
clone_or_pull() {
  local url="$1" dest="$2" name="$3"
  if [ -d "$dest/.git" ]; then
    # Already a git repo — just pull latest
    git -C "$dest" pull --ff-only --quiet 2>/dev/null \
      && ok "$name — updated" \
      || ok "$name — already current (no changes pulled)"
  elif [ -d "$dest" ] && [ "$(ls -A "$dest" 2>/dev/null)" ]; then
    # Dir exists but not a git repo (e.g. manually placed files)
    warn "$name — directory exists but not a git repo, skipping update"
  else
    # Fresh clone
    git clone --depth=1 --quiet \
      --config http.connectTimeout=20 \
      --config http.lowSpeedTime=30 \
      "$url" "$dest" 2>/dev/null \
      && ok "$name — installed" \
      || warn "$name — unavailable (no internet or repo moved), skipping"
  fi
}

if command -v git >/dev/null 2>&1; then
  clone_or_pull "https://github.com/obra/superpowers.git" \
                "$SCRIPT_DIR/skills/superpowers" "Superpowers"

  clone_or_pull "https://github.com/VoltAgent/awesome-codex-subagents.git" \
                "$SCRIPT_DIR/skills/codex-subagents" "Codex Subagents (136+)"

  if command -v cargo >/dev/null 2>&1; then
    clone_or_pull "https://github.com/nashsu/opencli-rs-skill.git" \
                  "$SCRIPT_DIR/skills/opencli-rs" "OpenCLI-rs"
    # Compile if binary doesn't exist yet
    OC_BIN="$SCRIPT_DIR/skills/opencli-rs/target/release/opencli"
    if [ -d "$SCRIPT_DIR/skills/opencli-rs" ] && [ ! -f "$OC_BIN" ]; then
      echo -e "  Compiling OpenCLI-rs (this takes ~2 minutes the first time)..."
      cd "$SCRIPT_DIR/skills/opencli-rs"
      cargo build --release --quiet 2>/dev/null \
        && ok "OpenCLI-rs compiled" \
        || warn "OpenCLI-rs compile failed — non-fatal, skipping"
      cd "$SCRIPT_DIR"
    elif [ -f "$OC_BIN" ]; then
      ok "OpenCLI-rs — binary ready"
    fi
  else
    warn "OpenCLI-rs skipped (Rust not installed)"
  fi
else
  warn "git not found — skills cloning skipped"
fi

# SkillsMP CLI (non-fatal)
npm install -g @skillsmp/cli --silent 2>/dev/null \
  && ok "SkillsMP CLI" \
  || warn "SkillsMP CLI unavailable — skipping"

# =============================================================================
# [4b] C-SUITE AGENT PROFILES
# =============================================================================
CSUITE_SCRIPT="$SCRIPT_DIR/agents/create-csuite.sh"
if [ -f "$CSUITE_SCRIPT" ]; then
  chmod +x "$CSUITE_SCRIPT"
  bash "$CSUITE_SCRIPT" 2>/dev/null \
    && ok "C-Suite agent profiles ready" \
    || warn "C-Suite script had warnings — profiles may need manual review"
else
  warn "agents/create-csuite.sh not found — profiles will auto-generate on first run"
fi

# =============================================================================
# [5] NEMOCLAW SECURITY SANDBOX (non-fatal if Python unavailable)
# =============================================================================
log "[5/7] NemoClaw security sandbox..."

if command -v python3 >/dev/null 2>&1; then
  NEMO_VENV="$SCRIPT_DIR/nemoclaw/.venv"
  if [ ! -d "$NEMO_VENV" ]; then
    python3 -m venv "$NEMO_VENV" 2>/dev/null && ok "NemoClaw venv created" || warn "venv creation failed"
  else
    ok "NemoClaw venv exists"
  fi
  "$NEMO_VENV/bin/pip" install --quiet --upgrade pip 2>/dev/null || true
  "$NEMO_VENV/bin/pip" install --quiet nemoguardrails 2>/dev/null \
    && ok "NeMo Guardrails installed" \
    || warn "NeMo Guardrails unavailable — using lightweight fallback"
else
  warn "Python 3 not found — NemoClaw sandbox using lightweight fallback mode"
fi

# Always write guardrail config (safe to overwrite — it's generated config)
mkdir -p "$SCRIPT_DIR/nemoclaw/guardrails"
cat > "$SCRIPT_DIR/nemoclaw/guardrails/config.yml" <<GUARDRAILS_EOF
# NemoClaw Guardrails — OmniClaw Redlines
models:
  - type: main
    engine: openai
    model: gpt-3.5-turbo
instructions:
  - type: general
    content: |
      Security guardrail for OmniClaw. Enforce:
      1. No deletion of files outside /memory
      2. No spend beyond budget limit
      3. No system commands affecting files outside project root
      4. All web actions logged before execution
      5. Irreversible decisions require Full Committee approval
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
ok "Guardrails config written"

# =============================================================================
# [6] MEMORY INITIALISATION (never overwrites user data)
# =============================================================================
log "[6/7] Initializing agent memory..."

# decisions.json — only create if missing (NEVER overwrite)
[ -f "memory/decisions.json" ] \
  || echo '[]' > "memory/decisions.json" \
  && ok "decisions.json ready"

# HEARTBEATS.md — only create if missing
[ -f "memory/HEARTBEATS.md" ] \
  || echo "# HEARTBEATS" > "memory/HEARTBEATS.md" \
  && ok "HEARTBEATS.md ready"

# SOUL.md — substitute env vars if file exists (keeps existing content, just fills placeholders)
if [ -f "memory/SOUL.md" ]; then
  sed -i.bak \
    -e "s|\${COMPANY_NAME}|${COMPANY_NAME}|g" \
    -e "s|\${OWNER_NAME}|${OWNER_NAME}|g" \
    -e "s|\${MISSION}|${MISSION:-Not set}|g" \
    -e "s|\${VAULT_PATH}|${VAULT_PATH:-~/vault}|g" \
    -e "s|\[SET BY SETUP SCRIPT\]|$(date -u +%Y-%m-%dT%H:%M:%SZ)|g" \
    "memory/SOUL.md" 2>/dev/null || true
  rm -f "memory/SOUL.md.bak"
  ok "SOUL.md initialised"
fi

# init-company.yaml
if [ -f "configs/init-company.yaml" ] && command -v envsubst >/dev/null 2>&1; then
  envsubst < "configs/init-company.yaml" > "configs/init-company.resolved.yaml" 2>/dev/null || true
  ok "init-company.resolved.yaml generated"
fi

# Obsidian vault verification
echo ""
if [ -n "$VAULT_PATH" ] && [ -d "$VAULT_PATH" ]; then
  NOTE_COUNT=$(find "$VAULT_PATH" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  VAULT_NAME=$(basename "$VAULT_PATH")
  ok "Obsidian vault: ${BOLD}${VAULT_NAME}${NC} (${NOTE_COUNT} notes at ${VAULT_PATH})"
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
  } > "memory/VAULT_INDEX.md"
  ok "VAULT_INDEX.md written to memory/"
elif [ -n "$VAULT_PATH" ]; then
  warn "Vault path set but NOT found: ${VAULT_PATH}"
  warn "The path may be wrong, or the drive may not be mounted."
  warn "Fix: edit VAULT_PATH in .env then run ./setup.sh again"
  # Auto-scan for alternatives
  ALT_VAULTS=()
  for candidate in \
    "$HOME/Documents"/*/.obsidian \
    "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents"/*/.obsidian \
    "$HOME/Obsidian"/*/.obsidian; do
    [ -d "$candidate" ] && ALT_VAULTS+=("${candidate%/.obsidian}")
  done
  if [ ${#ALT_VAULTS[@]} -gt 0 ]; then
    echo -e "  Found these vaults on this machine:"
    for v in "${ALT_VAULTS[@]}"; do echo -e "    • $v"; done
    echo -e "  Update VAULT_PATH in .env to one of the above."
  fi
else
  warn "VAULT_PATH not set — Obsidian integration disabled."
  warn "Set VAULT_PATH in .env and run ./setup.sh again to enable."
fi

# Supabase check
if [ -n "$SUPABASE_URL" ]; then
  ok "Supabase: ${SUPABASE_URL}"
else
  warn "SUPABASE_URL not set — Supabase integration disabled. Add to .env to enable."
fi

# =============================================================================
# [7] DASHBOARD — always reinstall / update dependencies
# =============================================================================
log "[7/7] Installing dashboard..."

# Ensure critical files exist — fetch from GitHub only if truly missing from the ZIP
RAW_BASE="https://raw.githubusercontent.com/FELix-Bond/Omniclaw/main"
for f in "dashboard/server.js" "dashboard/package.json" "dashboard/public/index.html"; do
  if [ ! -f "$SCRIPT_DIR/$f" ]; then
    warn "$f missing — fetching from GitHub..."
    mkdir -p "$(dirname "$SCRIPT_DIR/$f")"
    curl -fsSL --connect-timeout 15 "$RAW_BASE/$f" -o "$SCRIPT_DIR/$f" 2>/dev/null \
      && ok "$f fetched" \
      || fail "$f could not be fetched — dashboard may not start"
  fi
done

# npm install — always run (idempotent, handles upgrades of package.json)
if [ -f "dashboard/package.json" ]; then
  cd "$SCRIPT_DIR/dashboard"
  # Try with legacy peer deps first (handles most version conflicts)
  npm install --silent --legacy-peer-deps 2>/dev/null \
    || npm install --silent 2>/dev/null \
    || warn "npm install had warnings — dashboard may still work"
  cd "$SCRIPT_DIR"
  ok "Dashboard dependencies installed"
else
  fail "dashboard/package.json missing — cannot install dependencies"
fi

# Make all shell scripts executable
find "$SCRIPT_DIR" -maxdepth 4 -name "*.sh" -exec chmod +x {} \; 2>/dev/null || true

# =============================================================================
# KEYCHAIN SYNC (macOS) — save current .env keys to Keychain and restore any missing
# =============================================================================
ALL_API_KEYS=(
  ANTHROPIC_API_KEY GOOGLE_AI_API_KEY OPENAI_API_KEY GROQ_API_KEY
  OPENROUTER_API_KEY MINIMAX_API_KEY MISTRAL_API_KEY FIRECRAWL_API_KEY
  SKILLSMP_API_KEY TG_TOKEN TG_CHAT_ID DISCORD_TOKEN DISCORD_CHANNEL_ID
  SLACK_BOT_TOKEN SLACK_CHANNEL_ID GMAIL_ADDRESS GMAIL_APP_PASSWORD
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
  HUBSPOT_API_KEY STRIPE_API_KEY PERPLEXITY_API_KEY NEWSAPI_KEY
  ELEVENLABS_API_KEY NOTION_TOKEN
  SUPABASE_URL SUPABASE_KEY GITHUB_TOKEN
)

kc_get() { security find-generic-password -a "omniclaw" -s "$1" -w 2>/dev/null || echo ""; }
kc_set() { [ -z "$2" ] && return; security add-generic-password -U -a "omniclaw" -s "$1" -w "$2" 2>/dev/null || true; }

env_set() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$SCRIPT_DIR/.env" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=\"${val}\"|" "$SCRIPT_DIR/.env"
    rm -f "$SCRIPT_DIR/.env.bak"
  else
    echo "${key}=\"${val}\"" >> "$SCRIPT_DIR/.env"
  fi
}

if [[ "$OSTYPE" == "darwin"* ]]; then
  echo -e "\n${BLUE}Syncing API keys with macOS Keychain...${NC}"
  kc_saved=0; kc_loaded=0
  for key in "${ALL_API_KEYS[@]}"; do
    env_val="${!key}"
    if [ -n "$env_val" ]; then
      kc_set "$key" "$env_val"
      kc_saved=$((kc_saved+1))
    else
      kc_val=$(kc_get "$key")
      if [ -n "$kc_val" ]; then
        export "$key"="$kc_val"
        env_set "$key" "$kc_val"
        kc_loaded=$((kc_loaded+1))
      fi
    fi
  done
  ok "${kc_saved} keys saved to Keychain | ${kc_loaded} restored from Keychain → .env"
fi

# =============================================================================
# LAUNCH
# =============================================================================
log "[Launch] Starting OmniClaw dashboard..."

if [ "$MODE" = "docker" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker-compose up -d dashboard 2>/dev/null \
      && ok "Docker containers started" \
      || { fail "Docker start failed — falling back to node"; MODE="standard"; }
  else
    warn "Docker not available — falling back to node mode"
    MODE="standard"
  fi
fi

if [ "$MODE" = "standard" ]; then
  if [ ! -f "dashboard/server.js" ]; then
    fail "dashboard/server.js not found — cannot start dashboard"
    echo -e "  Ensure the OmniClaw files are in this directory and try again."
    exit 1
  fi
  node dashboard/server.js &
  DASH_PID=$!
  echo "$DASH_PID" > .dashboard.pid
  sleep 2
  if kill -0 "$DASH_PID" 2>/dev/null; then
    ok "Dashboard started (PID $DASH_PID)"
  else
    fail "Dashboard failed to start"
    echo -e "  Debugging: cd dashboard && node server.js"
    echo -e "  Check that all npm packages are installed and .env is valid."
  fi
fi

# =============================================================================
# SUMMARY
# =============================================================================
echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}${BOLD}  ✅  ${COMPANY_NAME} — OmniClaw online${NC}"
echo -e "${GREEN}================================================================${NC}"
echo -e "  Dashboard:   ${BOLD}http://localhost:${DASHBOARD_PORT}${NC}"
echo -e "  Owner:       ${OWNER_NAME}"
if [ -n "$VAULT_PATH" ] && [ -d "$VAULT_PATH" ]; then
  echo -e "  Obsidian:    ${GREEN}✓${NC} $(basename "$VAULT_PATH")"
else
  echo -e "  Obsidian:    ${YELLOW}not configured${NC} — set VAULT_PATH in .env"
fi
if [ -n "$SUPABASE_URL" ]; then
  echo -e "  Supabase:    ${GREEN}✓${NC} configured"
else
  echo -e "  Supabase:    ${YELLOW}not configured${NC} — set SUPABASE_URL + SUPABASE_KEY in .env"
fi
[ -n "$TG_TOKEN"          ] && echo -e "  Telegram:    ${GREEN}✓${NC}" || echo -e "  Telegram:    ${YELLOW}not configured${NC}"
[ -n "$GMAIL_ADDRESS"     ] && echo -e "  Gmail:       ${GREEN}✓${NC}" || echo -e "  Gmail:       ${YELLOW}not configured${NC}"
[ -n "$ANTHROPIC_API_KEY" ] && echo -e "  Anthropic:   ${GREEN}✓${NC}" || true
[ -n "$GROQ_API_KEY"      ] && echo -e "  Groq:        ${GREEN}✓${NC}" || true
echo -e "  Budget:      ${BUDGET_LIMIT:-\$50}/mo"
echo ""
echo -e "  Stop:        kill \$(cat .dashboard.pid)"
echo -e "  Restart:     ./setup.sh"
echo -e "  Upgrade:     ./update.sh"
echo -e "${GREEN}================================================================${NC}"
echo ""

# Auto-open browser
if [ "${AUTO_OPEN_DASHBOARD:-true}" = "true" ]; then
  sleep 1
  command -v open    >/dev/null && open    "http://localhost:${DASHBOARD_PORT}" 2>/dev/null || \
  command -v xdg-open>/dev/null && xdg-open "http://localhost:${DASHBOARD_PORT}" 2>/dev/null || true
fi
