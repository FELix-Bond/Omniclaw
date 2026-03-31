#!/bin/bash
# =============================================================================
# OmniClaw Key Manager — Keychain Integration
# Securely store, retrieve, view and rotate all API keys
#
# Usage:
#   ./keys.sh save       — save all keys from .env into Keychain
#   ./keys.sh load       — load all keys from Keychain into .env
#   ./keys.sh view       — show all key statuses (masked)
#   ./keys.sh reveal     — show actual key values (prompts for confirmation)
#   ./keys.sh set KEY    — set/update a single key interactively
#   ./keys.sh remove KEY — delete a single key from Keychain
#   ./keys.sh clear      — remove ALL OmniClaw keys from Keychain
#   ./keys.sh check      — check which keys are present/missing
# =============================================================================

set -e
GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; MUTED='\033[0;90m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="omniclaw"

# Detect OS
OS="unknown"
[[ "$OSTYPE" == "darwin"* ]] && OS="macos"
[[ "$OSTYPE" == "linux-gnu"* ]] && OS="linux"
grep -qi microsoft /proc/version 2>/dev/null && OS="wsl"

# All keys managed by OmniClaw
declare -A KEY_META
KEY_META["ANTHROPIC_API_KEY"]="Anthropic (Claude)|https://console.anthropic.com/settings/keys|paid"
KEY_META["GOOGLE_AI_API_KEY"]="Google AI (Gemini)|https://aistudio.google.com/app/apikey|free"
KEY_META["OPENAI_API_KEY"]="OpenAI (GPT)|https://platform.openai.com/api-keys|paid"
KEY_META["GROQ_API_KEY"]="Groq (Llama)|https://console.groq.com/keys|free"
KEY_META["OPENROUTER_API_KEY"]="OpenRouter|https://openrouter.ai/keys|free"
KEY_META["MINIMAX_API_KEY"]="MiniMax|https://www.minimaxi.com/user-center/basic-information/interface-key|free"
KEY_META["MISTRAL_API_KEY"]="Mistral|https://console.mistral.ai/api-keys/|paid"
KEY_META["FIRECRAWL_API_KEY"]="Firecrawl (web intel)|https://www.firecrawl.dev/app/api-keys|paid"
KEY_META["SKILLSMP_API_KEY"]="SkillsMP|https://skillsmp.com/settings|free"
KEY_META["TG_TOKEN"]="Telegram Bot|https://t.me/BotFather|free"
KEY_META["DISCORD_TOKEN"]="Discord Bot|https://discord.com/developers/applications|free"
KEY_META["VOICEBOX_API_KEY"]="Voicebox.io|https://voicebox.io/dashboard|paid"
KEY_META["SUPABASE_URL"]="Supabase URL|https://supabase.com/dashboard|free"
KEY_META["SUPABASE_KEY"]="Supabase Anon Key|https://supabase.com/dashboard|free"
KEY_META["GITHUB_TOKEN"]="GitHub Token|https://github.com/settings/tokens/new?scopes=repo,workflow|free"

ALL_KEYS=(ANTHROPIC_API_KEY GOOGLE_AI_API_KEY OPENAI_API_KEY GROQ_API_KEY OPENROUTER_API_KEY MINIMAX_API_KEY MISTRAL_API_KEY FIRECRAWL_API_KEY SKILLSMP_API_KEY TG_TOKEN DISCORD_TOKEN VOICEBOX_API_KEY SUPABASE_URL SUPABASE_KEY GITHUB_TOKEN)

# =============================================================================
# KEYCHAIN PRIMITIVES
# =============================================================================
kc_set() {
  local key="$1" val="$2"
  [ -z "$val" ] && return 0
  case "$OS" in
    macos)
      security add-generic-password -U -a "$SERVICE" -s "$key" -w "$val" 2>/dev/null
      ;;
    linux|wsl)
      if command -v secret-tool >/dev/null 2>&1; then
        echo "$val" | secret-tool store --label="omniclaw:$key" service "$SERVICE" username "$key" 2>/dev/null
      else
        # Fallback: encrypted file store
        _file_store_set "$key" "$val"
      fi
      ;;
  esac
}

kc_get() {
  local key="$1"
  case "$OS" in
    macos)
      security find-generic-password -a "$SERVICE" -s "$key" -w 2>/dev/null || echo ""
      ;;
    linux|wsl)
      if command -v secret-tool >/dev/null 2>&1; then
        secret-tool lookup service "$SERVICE" username "$key" 2>/dev/null || echo ""
      else
        _file_store_get "$key"
      fi
      ;;
  esac
}

kc_delete() {
  local key="$1"
  case "$OS" in
    macos)
      security delete-generic-password -a "$SERVICE" -s "$key" 2>/dev/null || true
      ;;
    linux|wsl)
      if command -v secret-tool >/dev/null 2>&1; then
        secret-tool clear service "$SERVICE" username "$key" 2>/dev/null || true
      else
        _file_store_delete "$key"
      fi
      ;;
  esac
}

# Linux fallback — encrypted key file using openssl
_KEY_FILE="$SCRIPT_DIR/.keys.enc"
_key_pass() { echo "omniclaw-$(hostname)-$(id -u)"; }
_file_store_set() {
  local key="$1" val="$2"
  local tmp=$(mktemp)
  [ -f "$_KEY_FILE" ] && openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:"$(_key_pass)" -in "$_KEY_FILE" 2>/dev/null > "$tmp" || true
  grep -v "^${key}=" "$tmp" > "${tmp}.new" 2>/dev/null || true
  echo "${key}=${val}" >> "${tmp}.new"
  openssl enc -aes-256-cbc -pbkdf2 -pass pass:"$(_key_pass)" -in "${tmp}.new" -out "$_KEY_FILE"
  rm -f "$tmp" "${tmp}.new"
  chmod 600 "$_KEY_FILE"
}
_file_store_get() {
  local key="$1"
  [ -f "$_KEY_FILE" ] || { echo ""; return; }
  openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:"$(_key_pass)" -in "$_KEY_FILE" 2>/dev/null | grep "^${key}=" | cut -d'=' -f2-
}
_file_store_delete() {
  local key="$1"
  [ -f "$_KEY_FILE" ] || return
  local tmp=$(mktemp)
  openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:"$(_key_pass)" -in "$_KEY_FILE" 2>/dev/null | grep -v "^${key}=" > "$tmp" || true
  openssl enc -aes-256-cbc -pbkdf2 -pass pass:"$(_key_pass)" -in "$tmp" -out "$_KEY_FILE"
  rm -f "$tmp"
}

# =============================================================================
# MASK KEY VALUE
# =============================================================================
mask_key() {
  local val="$1"
  [ -z "$val" ] && echo "" && return
  local len=${#val}
  if [ "$len" -le 8 ]; then
    echo "••••••••"
  else
    local show=4
    local prefix="${val:0:$show}"
    local suffix="${val: -4}"
    local mid=$(printf '•%.0s' $(seq 1 $((len - show * 2))))
    echo "${prefix}${mid}${suffix}"
  fi
}

# =============================================================================
# BANNER
# =============================================================================
banner() {
  echo -e "${BLUE}"
  echo "  🔑  OmniClaw Key Manager"
  echo -e "${NC}  Keychain: ${YELLOW}${OS} / ${SERVICE}${NC}"
  echo ""
}

# =============================================================================
# COMMANDS
# =============================================================================

cmd_save() {
  banner
  echo -e "${BLUE}Saving keys from .env → Keychain...${NC}\n"
  [ ! -f "$SCRIPT_DIR/.env" ] && { echo -e "${RED}✗ No .env file found${NC}"; exit 1; }
  source "$SCRIPT_DIR/.env"
  saved=0; skipped=0
  for key in "${ALL_KEYS[@]}"; do
    val="${!key}"
    if [ -n "$val" ]; then
      # Save to Keychain
      kc_set "$key" "$val"
      # Write to .env
      if grep -q "^${key}=" "$SCRIPT_DIR/.env" 2>/dev/null; then
        sed -i.bak "s|^${key}=.*|${key}=\"${val}\"|" "$SCRIPT_DIR/.env"
        rm -f "$SCRIPT_DIR/.env.bak"
      else
        echo "${key}=\"${val}\"" >> "$SCRIPT_DIR/.env"
      fi
      echo -e "  ${GREEN}✓ Keychain + .env: ${key}${NC} $(mask_key "$val")"
      ((saved++))
    else
      echo -e "  ${MUTED}– Skipped: ${key} (not set)${NC}"
      ((skipped++))
    fi
  done
  echo -e "\n  ${GREEN}Done — ${saved} saved to Keychain + .env, ${skipped} skipped${NC}"
}

cmd_load() {
  banner
  echo -e "${BLUE}Loading keys from Keychain → .env...${NC}\n"
  [ ! -f "$SCRIPT_DIR/.env" ] && cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  loaded=0; missing=0
  for key in "${ALL_KEYS[@]}"; do
    val=$(kc_get "$key")
    if [ -n "$val" ]; then
      # Update or append to .env
      if grep -q "^${key}=" "$SCRIPT_DIR/.env" 2>/dev/null; then
        sed -i.bak "s|^${key}=.*|${key}=\"${val}\"|" "$SCRIPT_DIR/.env"
        rm -f "$SCRIPT_DIR/.env.bak"
      else
        echo "${key}=\"${val}\"" >> "$SCRIPT_DIR/.env"
      fi
      echo -e "  ${GREEN}✓ Loaded: ${key}${NC}"
      ((loaded++))
    else
      echo -e "  ${MUTED}– Not in keychain: ${key}${NC}"
      ((missing++))
    fi
  done
  echo -e "\n  ${GREEN}Done — ${loaded} loaded, ${missing} not found${NC}"
}

cmd_view() {
  banner
  echo -e "${BLUE}Key Status — all values masked${NC}\n"
  printf "  %-30s %-12s %-20s %s\n" "KEY" "STATUS" "VALUE" "PROVIDER"
  printf "  %-30s %-12s %-20s %s\n" "---" "------" "-----" "--------"
  for key in "${ALL_KEYS[@]}"; do
    val=$(kc_get "$key")
    IFS='|' read -r provider url tier <<< "${KEY_META[$key]:-Unknown||}"
    if [ -n "$val" ]; then
      tier_badge=$( [ "$tier" = "free" ] && echo "🟢 free" || echo "💛 paid" )
      printf "  ${GREEN}%-30s${NC} %-12s ${MUTED}%-20s${NC} %s %s\n" \
        "$key" "✓ present" "$(mask_key "$val")" "$tier_badge" "$provider"
    else
      printf "  ${RED}%-30s${NC} %-12s %-20s %s\n" \
        "$key" "✗ missing" "—" "$provider"
    fi
  done
  echo ""
}

cmd_reveal() {
  banner
  echo -e "${YELLOW}⚠ This will display your actual API keys in plain text.${NC}"
  read -rp "  Are you sure? [y/N]: " confirm
  [[ "$confirm" != "y" && "$confirm" != "Y" ]] && { echo "Cancelled."; exit 0; }
  echo ""
  echo -e "${BLUE}Key Values — SENSITIVE${NC}\n"
  for key in "${ALL_KEYS[@]}"; do
    val=$(kc_get "$key")
    IFS='|' read -r provider url tier <<< "${KEY_META[$key]:-Unknown||}"
    if [ -n "$val" ]; then
      echo -e "  ${GREEN}${key}${NC}"
      echo -e "    Provider: $provider"
      echo -e "    Value:    ${YELLOW}${val}${NC}"
      echo -e "    Get key:  $url"
      echo ""
    fi
  done
}

cmd_set() {
  local key="$1"
  banner
  if [ -z "$key" ]; then
    echo -e "${BLUE}Which key do you want to set?${NC}\n"
    for i in "${!ALL_KEYS[@]}"; do
      k="${ALL_KEYS[$i]}"
      val=$(kc_get "$k")
      status=$( [ -n "$val" ] && echo "${GREEN}✓${NC}" || echo "${RED}✗${NC}" )
      IFS='|' read -r provider url tier <<< "${KEY_META[$k]:-Unknown||}"
      echo -e "  $(printf '%2d' $((i+1))). $status ${k} ${MUTED}(${provider})${NC}"
    done
    echo ""
    read -rp "  Enter number or key name: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]]; then
      key="${ALL_KEYS[$((choice-1))]}"
    else
      key="$choice"
    fi
  fi

  [ -z "$key" ] && { echo -e "${RED}No key selected${NC}"; exit 1; }
  IFS='|' read -r provider url tier <<< "${KEY_META[$key]:-Unknown||}"
  existing=$(kc_get "$key")
  echo -e "\n  ${BOLD}${key}${NC} — ${provider}"
  [ -n "$url" ] && echo -e "  Get key: ${BLUE}${url}${NC}"
  [ -n "$existing" ] && echo -e "  Current: $(mask_key "$existing")"
  echo ""
  read -rsp "  Enter new value (input hidden): " newval
  echo ""
  if [ -n "$newval" ]; then
    kc_set "$key" "$newval"
    # Also update .env if it exists
    if [ -f "$SCRIPT_DIR/.env" ]; then
      if grep -q "^${key}=" "$SCRIPT_DIR/.env" 2>/dev/null; then
        sed -i.bak "s|^${key}=.*|${key}=\"${newval}\"|" "$SCRIPT_DIR/.env"
        rm -f "$SCRIPT_DIR/.env.bak"
      else
        echo "${key}=\"${newval}\"" >> "$SCRIPT_DIR/.env"
      fi
    fi
    echo -e "  ${GREEN}✓ ${key} saved to Keychain${NC}"
    [ -f "$SCRIPT_DIR/.env" ] && echo -e "  ${GREEN}✓ .env updated${NC}"
  else
    echo -e "  ${YELLOW}No value entered — unchanged${NC}"
  fi
}

cmd_remove() {
  local key="$1"
  [ -z "$key" ] && { echo -e "${RED}Usage: ./keys.sh remove KEY_NAME${NC}"; exit 1; }
  banner
  kc_delete "$key"
  echo -e "  ${GREEN}✓ ${key} removed from Keychain${NC}"
}

cmd_clear() {
  banner
  echo -e "${RED}⚠ This will remove ALL OmniClaw keys from Keychain.${NC}"
  read -rp "  Are you sure? [y/N]: " confirm
  [[ "$confirm" != "y" && "$confirm" != "Y" ]] && { echo "Cancelled."; exit 0; }
  for key in "${ALL_KEYS[@]}"; do
    kc_delete "$key"
    echo -e "  ${GREEN}✓ Removed: ${key}${NC}"
  done
  echo -e "\n  ${GREEN}All keys cleared${NC}"
}

cmd_check() {
  banner
  echo -e "${BLUE}Key Health Check${NC}\n"
  present=0; missing=0
  for key in "${ALL_KEYS[@]}"; do
    val=$(kc_get "$key")
    IFS='|' read -r provider url tier <<< "${KEY_META[$key]:-Unknown||}"
    if [ -n "$val" ]; then
      echo -e "  ${GREEN}✓ ${key}${NC} — ${provider}"
      ((present++))
    else
      tier_note=$( [ "$tier" = "free" ] && echo "(free tier available → $url)" || echo "" )
      echo -e "  ${RED}✗ ${key}${NC} — ${provider} ${MUTED}${tier_note}${NC}"
      ((missing++))
    fi
  done
  echo -e "\n  ${GREEN}${present} present${NC} · ${RED}${missing} missing${NC}"
  [ "$missing" -gt 0 ] && echo -e "  Run ${BOLD}./keys.sh set${NC} to add missing keys"
}

# =============================================================================
# DISPATCH
# =============================================================================
case "${1:-view}" in
  save)    cmd_save ;;
  load)    cmd_load ;;
  view)    cmd_view ;;
  reveal)  cmd_reveal ;;
  set)     cmd_set "$2" ;;
  remove)  cmd_remove "$2" ;;
  clear)   cmd_clear ;;
  check)   cmd_check ;;
  *)
    echo -e "Usage: ./keys.sh [save|load|view|reveal|set|remove|clear|check]"
    echo -e "  save    — .env → Keychain"
    echo -e "  load    — Keychain → .env"
    echo -e "  view    — show all keys (masked)"
    echo -e "  reveal  — show actual values"
    echo -e "  set     — add/update a key interactively"
    echo -e "  remove  — delete one key"
    echo -e "  clear   — delete all keys"
    echo -e "  check   — health check — which keys are present/missing"
    ;;
esac
