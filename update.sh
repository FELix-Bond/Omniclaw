#!/bin/bash
# =============================================================================
# OmniClaw Updater — safely pulls the latest stable release from GitHub
# Run: chmod +x update.sh && ./update.sh
# Your .env, memory/, agents/csuite/, and logs/ are always preserved.
# =============================================================================

set -e

REPO_URL="https://github.com/FELix-Bond/Omniclaw.git"
CURRENT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION_FILE="$CURRENT_DIR/VERSION"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

echo ""
echo "🦾 OmniClaw Updater"
echo "   Location: $CURRENT_DIR"
echo ""

# --- Check current version ---
CURRENT_VERSION="unknown"
[ -f "$VERSION_FILE" ] && CURRENT_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')

# --- Fetch latest version from GitHub (via API — bypasses CDN cache) ---
echo "Checking for updates..."
LATEST_VERSION=$(curl -sf -H "Cache-Control: no-cache" \
  "https://api.github.com/repos/FELix-Bond/Omniclaw/contents/VERSION" \
  | python3 -c "import sys,json,base64; d=json.load(sys.stdin); print(base64.b64decode(d['content']).decode().strip())" 2>/dev/null || \
  curl -sf "https://raw.githubusercontent.com/FELix-Bond/Omniclaw/main/VERSION?$(date +%s)" | tr -d '[:space:]' 2>/dev/null || echo "")

if [ -z "$LATEST_VERSION" ]; then
  echo -e "${RED}Could not reach GitHub. Check your internet connection.${NC}"
  exit 1
fi

echo "   Current version: $CURRENT_VERSION"
echo "   Latest version:  $LATEST_VERSION"
echo ""

# --- Ensure .env exists — load from Keychain if possible, else write defaults ---
if [ ! -f "$CURRENT_DIR/.env" ]; then
  # Try loading from Keychain first (populated by configure.html or keys.sh save)
  if [ -f "$CURRENT_DIR/keys.sh" ] && command -v security &>/dev/null; then
    echo "Loading API keys from macOS Keychain → .env ..."
    bash "$CURRENT_DIR/keys.sh" load 2>/dev/null && \
      echo -e "${GREEN}✅ Keys loaded from Keychain into .env${NC}" || \
      echo -e "${YELLOW}   Keychain load failed — writing defaults${NC}"
  fi
  # If still no .env, write minimal defaults
  if [ ! -f "$CURRENT_DIR/.env" ]; then
    echo "Writing default .env (no API keys — add via Settings or ./keys.sh set)..."
    cat > "$CURRENT_DIR/.env" <<'ENVEOF'
# OmniClaw Configuration — add your API keys via Settings or: ./keys.sh set
DASHBOARD_PORT=3001
COMPANY_NAME=OmniClaw
OWNER_NAME=Owner
AUTO_OPEN_DASHBOARD=true
METACLAW_ENABLED=true
DECISION_MODE=full
ENVEOF
    echo -e "${GREEN}✅ .env created${NC}"
  fi
fi
# Ensure DASHBOARD_PORT is set in any existing .env
if ! grep -q "^DASHBOARD_PORT=" "$CURRENT_DIR/.env"; then
  echo "DASHBOARD_PORT=3001" >> "$CURRENT_DIR/.env"
  echo "   Added DASHBOARD_PORT=3001 to .env"
fi

# --- MetaClaw: start if already installed, otherwise schedule background install ---
METACLAW_PORT=30000
METACLAW_VENV="$CURRENT_DIR/memory/metaclaw-venv"
METACLAW_BIN="$METACLAW_VENV/bin/metaclaw"

if curl -sf --max-time 3 "http://localhost:$METACLAW_PORT/v1/models" >/dev/null 2>&1; then
  echo -e "${GREEN}✅ MetaClaw already running on port $METACLAW_PORT.${NC}"
elif [ -x "$METACLAW_BIN" ]; then
  # Already installed — just start it
  mkdir -p "$CURRENT_DIR/memory/metaclaw" "$CURRENT_DIR/logs"
  nohup "$METACLAW_BIN" start --host 0.0.0.0 --port "$METACLAW_PORT" --mode skills_only \
    --skills-path "$CURRENT_DIR/memory/metaclaw" >> "$CURRENT_DIR/logs/metaclaw.log" 2>&1 &
  echo -e "${GREEN}✅ MetaClaw started (PID $!).${NC}"
else
  # Not installed — run install in the background so it never blocks the update
  echo "MetaClaw not installed — installing in background (logs/metaclaw-install.log)..."
  (
    PY=""
    for candidate in python3.13 python3.12 python3.11 python3.10; do
      command -v "$candidate" &>/dev/null && PY="$candidate" && break
    done
    if [ -z "$PY" ]; then
      [ -f /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
      command -v brew &>/dev/null && brew install python@3.11 -q 2>/dev/null || true
      PY=$(command -v python3.11 2>/dev/null || echo "")
    fi
    [ -z "$PY" ] && echo "Python 3.10+ not found — MetaClaw skipped" && exit 0
    SRC=$(mktemp -d)
    git clone --depth=1 --quiet https://github.com/aiming-lab/MetaClaw "$SRC/mc" 2>/dev/null || { echo "git clone failed"; exit 1; }
    "$PY" -m venv "$METACLAW_VENV" && \
      "$METACLAW_VENV/bin/pip" install --quiet -e "$SRC/mc" || { echo "pip install failed"; exit 1; }
    mkdir -p "$CURRENT_DIR/memory/metaclaw" "$CURRENT_DIR/logs"
    nohup "$METACLAW_BIN" start --host 0.0.0.0 --port "$METACLAW_PORT" --mode skills_only \
      --skills-path "$CURRENT_DIR/memory/metaclaw" >> "$CURRENT_DIR/logs/metaclaw.log" 2>&1 &
    echo "MetaClaw installed and started (PID $!)."
  ) >> "$CURRENT_DIR/logs/metaclaw-install.log" 2>&1 &
  echo "   Install running in background. Check logs/metaclaw-install.log for progress."
fi

if [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
  echo -e "${GREEN}You're already on the latest version ($CURRENT_VERSION).${NC}"
  # Still restore MODEL_CHAIN values from Keychain into .env in case they went missing
  if command -v security &>/dev/null; then
    for key in MODEL_CHAIN_1 MODEL_CHAIN_2 MODEL_CHAIN_3; do
      val=$(security find-generic-password -a omniclaw -s "$key" -w 2>/dev/null || echo "")
      if [ -n "$val" ]; then
        if grep -q "^${key}=" "$CURRENT_DIR/.env" 2>/dev/null; then
          sed -i.bak "s|^${key}=.*|${key}=\"${val}\"|" "$CURRENT_DIR/.env" && rm -f "$CURRENT_DIR/.env.bak"
        else
          echo "${key}=\"${val}\"" >> "$CURRENT_DIR/.env"
        fi
        echo "   Restored $key from Keychain"
      fi
    done
  fi
  exit 0
fi

echo -e "${YELLOW}Update available: $CURRENT_VERSION → $LATEST_VERSION${NC}"
echo ""
echo "What gets updated:"
echo "  ✅ dashboard/server.js     (core engine)"
echo "  ✅ dashboard/public/       (UI)"
echo "  ✅ setup.sh                (installer)"
echo "  ✅ configure.html          (configurator)"
echo "  ✅ agents/create-csuite.sh (agent provisioner)"
echo ""
echo "What is NEVER touched:"
echo "  🔒 .env                    (your API keys & config)"
echo "  🔒 memory/                 (agent memory & heartbeats)"
echo "  🔒 agents/csuite/          (your custom agent personas)"
echo "  🔒 logs/                   (session logs)"
echo ""
read -p "Apply update? (y/N) " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Update cancelled."
  exit 0
fi

# --- Back up user data ---
BACKUP_DIR="$CURRENT_DIR/.omniclaw-backup-$(date +%Y%m%d-%H%M%S)"
echo ""
echo "Backing up your data to $BACKUP_DIR ..."
mkdir -p "$BACKUP_DIR"
[ -f "$CURRENT_DIR/.env" ]          && cp "$CURRENT_DIR/.env" "$BACKUP_DIR/.env"
[ -d "$CURRENT_DIR/memory" ]        && cp -r "$CURRENT_DIR/memory" "$BACKUP_DIR/memory"
[ -d "$CURRENT_DIR/agents/csuite" ] && cp -r "$CURRENT_DIR/agents/csuite" "$BACKUP_DIR/csuite"
[ -d "$CURRENT_DIR/logs" ]          && cp -r "$CURRENT_DIR/logs" "$BACKUP_DIR/logs"
echo -e "${GREEN}Backup complete.${NC}"

# --- Pull latest from GitHub ---
echo ""
echo "Pulling updates from GitHub..."

TEMP_DIR=$(mktemp -d)
git clone --depth=1 "$REPO_URL" "$TEMP_DIR" 2>/dev/null

# Copy platform files (never touch user data)
PRESERVE=(".env" "memory" "agents/csuite" "logs" ".omniclaw-backup*")

rsync -a --exclude='.env' \
         --exclude='memory/' \
         --exclude='agents/csuite/' \
         --exclude='logs/' \
         --exclude='.omniclaw-backup*' \
         "$TEMP_DIR/" "$CURRENT_DIR/"

rm -rf "$TEMP_DIR"

# --- Fix permissions on all scripts (rsync doesn't always preserve +x) ---
find "$CURRENT_DIR" -maxdepth 2 -name "*.sh" -exec chmod +x {} \;
chmod +x "$CURRENT_DIR/update.sh" 2>/dev/null || true

# --- Restore user data from backup (safety net) ---
[ -f "$BACKUP_DIR/.env" ]          && cp "$BACKUP_DIR/.env" "$CURRENT_DIR/.env"
[ -d "$BACKUP_DIR/memory" ]        && cp -r "$BACKUP_DIR/memory/." "$CURRENT_DIR/memory/"
[ -d "$BACKUP_DIR/csuite" ]        && cp -r "$BACKUP_DIR/csuite/." "$CURRENT_DIR/agents/csuite/"

# Load .env so restart uses correct PORT
set -o allexport
# shellcheck disable=SC1090
source "$CURRENT_DIR/.env" 2>/dev/null || true
set +o allexport

# --- Re-install dashboard dependencies ---
echo ""
echo "Updating dashboard dependencies..."
cd "$CURRENT_DIR/dashboard" && npm install --silent

echo ""
echo -e "${GREEN}✅ OmniClaw updated to v$LATEST_VERSION${NC}"
echo ""

# --- Restart dashboard ---
cd "$CURRENT_DIR"
DASH_PORT="${DASHBOARD_PORT:-3001}"

# Docker Compose — use if docker-compose.yml present and docker is available
if (command -v docker-compose &>/dev/null || command -v docker &>/dev/null) && [ -f "$CURRENT_DIR/docker-compose.yml" ]; then
  echo "Docker available — restarting OmniClaw stack..."
  if command -v docker-compose &>/dev/null; then
    docker-compose -f "$CURRENT_DIR/docker-compose.yml" up -d --build 2>/dev/null || true
  else
    docker compose -f "$CURRENT_DIR/docker-compose.yml" up -d --build 2>/dev/null || true
  fi
  echo -e "${GREEN}✅ Docker stack restarted.${NC}"
  echo "   Dashboard: http://localhost:$DASH_PORT"
  echo "   MetaClaw:  http://localhost:30000"
else
  # Plain Node
  echo "Restarting dashboard (port $DASH_PORT)..."
  pkill -f 'node.*server.js' 2>/dev/null || true
  sleep 1
  mkdir -p "$CURRENT_DIR/logs"
  nohup node "$CURRENT_DIR/dashboard/server.js" >> "$CURRENT_DIR/logs/dashboard.log" 2>&1 &
  DASH_PID=$!
  sleep 2
  if kill -0 "$DASH_PID" 2>/dev/null; then
    echo -e "${GREEN}✅ Dashboard started (PID $DASH_PID).${NC}"
    echo "   Open: http://localhost:$DASH_PORT"
  else
    echo -e "${RED}Dashboard failed to start. Check logs/dashboard.log for errors.${NC}"
  fi
fi

echo ""
echo "Your backup is at: $BACKUP_DIR (safe to delete after confirming everything works)"
echo ""
