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

# --- Fetch latest version from GitHub ---
echo "Checking for updates..."
LATEST_VERSION=$(curl -sf "https://raw.githubusercontent.com/FELix-Bond/Omniclaw/main/VERSION" | tr -d '[:space:]' 2>/dev/null || echo "")

if [ -z "$LATEST_VERSION" ]; then
  echo -e "${RED}Could not reach GitHub. Check your internet connection.${NC}"
  exit 1
fi

echo "   Current version: $CURRENT_VERSION"
echo "   Latest version:  $LATEST_VERSION"
echo ""

if [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
  echo -e "${GREEN}You're already on the latest version ($CURRENT_VERSION). Nothing to do.${NC}"
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

# --- Restore user data from backup (safety net) ---
[ -f "$BACKUP_DIR/.env" ]          && cp "$BACKUP_DIR/.env" "$CURRENT_DIR/.env"
[ -d "$BACKUP_DIR/memory" ]        && cp -r "$BACKUP_DIR/memory/." "$CURRENT_DIR/memory/"
[ -d "$BACKUP_DIR/csuite" ]        && cp -r "$BACKUP_DIR/csuite/." "$CURRENT_DIR/agents/csuite/"

# --- Re-install dashboard dependencies ---
echo ""
echo "Updating dashboard dependencies..."
cd "$CURRENT_DIR/dashboard" && npm install --silent

echo ""
echo -e "${GREEN}✅ OmniClaw updated to v$LATEST_VERSION${NC}"
echo ""
echo "Restart your dashboard to use the new version:"
echo "  pkill -f 'node server.js'; node dashboard/server.js"
echo ""
echo "Your backup is at: $BACKUP_DIR (safe to delete after confirming everything works)"
echo ""
