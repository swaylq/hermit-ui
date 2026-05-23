#!/bin/bash
# playwright-mcp-launcher.sh — Start playwright-mcp connected to this agent's Chrome.
#
# Used as the MCP server command in .claude/settings.json (mcpServers.playwright-browser).
# Ensures Chrome is running before attaching.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CHROME_JSON="$AGENT_DIR/browser/chrome.json"
STEALTH_JS="$AGENT_DIR/scripts/browser/utils/stealth-init.js"

# Ensure Chrome is running
if [ -f "$CHROME_JSON" ]; then
  CDP_PORT=$(python3 -c "import json; print(json.load(open('$CHROME_JSON')).get('cdp_port', ''))" 2>/dev/null || true)
  PID=$(python3 -c "import json; print(json.load(open('$CHROME_JSON')).get('pid', ''))" 2>/dev/null || true)
fi

if [ -z "${CDP_PORT:-}" ] || [ -z "${PID:-}" ] || ! kill -0 "$PID" 2>/dev/null; then
  "$SCRIPT_DIR/chrome-launcher.sh" start >&2
  if [ -f "$CHROME_JSON" ]; then
    CDP_PORT=$(python3 -c "import json; print(json.load(open('$CHROME_JSON')).get('cdp_port', ''))" 2>/dev/null || true)
  fi
fi

if [ -z "${CDP_PORT:-}" ]; then
  echo "ERROR: Cannot determine CDP port" >&2
  exit 1
fi

CDP_ENDPOINT="http://127.0.0.1:${CDP_PORT}"

LOCAL_BIN="$AGENT_DIR/node_modules/.bin/playwright-mcp"

ARGS=(
  "--cdp-endpoint" "$CDP_ENDPOINT"
  "--viewport-size" "1280x800"
)

if [ -f "$STEALTH_JS" ]; then
  ARGS+=("--init-script" "$STEALTH_JS")
fi

if [ -x "$LOCAL_BIN" ]; then
  exec "$LOCAL_BIN" "${ARGS[@]}"
else
  exec npx @playwright/mcp@latest "${ARGS[@]}"
fi
