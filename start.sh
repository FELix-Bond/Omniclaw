#!/bin/bash
# =============================================================================
# OmniClaw + Paperclip — Unified Startup
# Starts OmniClaw (AI engine :3001) and Paperclip dashboard (:3100)
# =============================================================================
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

# Load env
[ -f "$ROOT/.env" ] && export $(grep -v '^#' "$ROOT/.env" | grep -v '^$' | xargs) 2>/dev/null || true

mkdir -p "$ROOT/logs"

echo ""
echo "🦾 OmniClaw + Paperclip"
echo ""

# ── Stop any existing processes ───────────────────────────────────────────────
pkill -f 'node.*server\.js' 2>/dev/null || true
pkill -f 'tsx.*index\.ts' 2>/dev/null || true
sleep 1

# ── Start OmniClaw (AI engine + OpenClaw gateway) ────────────────────────────
echo "Starting OmniClaw engine (port ${DASHBOARD_PORT:-3001})..."
nohup node "$ROOT/dashboard/server.js" >> "$ROOT/logs/omniclaw.log" 2>&1 &
OMNICLAW_PID=$!
echo "   PID: $OMNICLAW_PID"

# Wait for OmniClaw to be ready
for i in $(seq 1 15); do
  sleep 1
  if curl -sf "http://localhost:${DASHBOARD_PORT:-3001}/api/health" >/dev/null 2>&1; then
    echo -e "   ${GREEN}✅ OmniClaw ready${NC}"
    break
  fi
done

# ── Start Paperclip dashboard ─────────────────────────────────────────────────
echo "Starting Paperclip dashboard (port 3100)..."
PAPERCLIP_DIR="$ROOT/paperclip-dashboard"
export PAPERCLIP_HOME="$PAPERCLIP_DIR/.paperclip"
export PAPERCLIP_INSTANCE_ID=omniclaw
export PAPERCLIP_MIGRATION_AUTO_APPLY=true
export PAPERCLIP_MIGRATION_PROMPT=never

nohup pnpm --prefix "$PAPERCLIP_DIR" --filter "@paperclipai/server" dev \
  >> "$ROOT/logs/paperclip.log" 2>&1 &
PAPERCLIP_PID=$!
echo "   PID: $PAPERCLIP_PID"

# Wait for Paperclip
for i in $(seq 1 20); do
  sleep 1
  if curl -sf "http://localhost:3100/api/health" >/dev/null 2>&1; then
    echo -e "   ${GREEN}✅ Paperclip dashboard ready${NC}"
    break
  fi
done

echo ""
echo -e "${GREEN}Both services running:${NC}"
echo "   OmniClaw engine:     http://localhost:${DASHBOARD_PORT:-3001}"
echo "   Paperclip dashboard: http://localhost:3100"
echo "   OpenClaw gateway:    ws://localhost:${DASHBOARD_PORT:-3001}/openclaw-gateway"
echo ""
echo "Logs: logs/omniclaw.log  |  logs/paperclip.log"
echo ""

# Open Paperclip dashboard
open http://localhost:3100 2>/dev/null || true
