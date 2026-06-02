#!/usr/bin/env bash
# Idempotent splice of WS-friendly transport block into the dash.swaylab.ai
# reverse_proxy on /etc/caddy/Caddyfile, then validate + reload Caddy.
#
# Run on the VPS (45.89.234.110) as a user with sudo (e.g. ubuntu). Sudo will
# prompt for password the first time; subsequent sudo calls reuse the timestamp.
#
# Re-running this script after success is a no-op (the splice helper checks).
set -euo pipefail

CADDYFILE=/etc/caddy/Caddyfile
TS=$(date +%s)

if [[ ! -r "$CADDYFILE" ]]; then
  echo "error: $CADDYFILE not readable" >&2
  exit 1
fi

# Backup first (idempotent — keeps one backup per invocation timestamp).
echo "→ backing up to ${CADDYFILE}.bak.${TS}"
sudo cp -a "$CADDYFILE" "${CADDYFILE}.bak.${TS}"

# Splice via python — heredoc is exact-match, no regex brittleness.
sudo python3 <<'PY'
import sys, pathlib

p = pathlib.Path('/etc/caddy/Caddyfile')
src = p.read_text()

OLD = """  reverse_proxy localhost:4101 {
    header_up Host {host}
  }"""

NEW = """  reverse_proxy localhost:4101 {
    header_up Host {host}
    # WebSocket-friendly: never time out the upstream conn. The browser
    # terminal (/api/term/<sid>) and gateway control channel (/api/gateway/ws)
    # are both long-lived. Heartbeats every 15-20s keep traffic flowing both
    # ways; explicit 0 disables any default timeout regardless of Caddy
    # version. flush_interval -1 also bypasses response buffering, important
    # for SSE on /api/chat/stream.
    flush_interval -1
    transport http {
      read_timeout 0
      write_timeout 0
      dial_timeout 10s
    }
  }"""

if 'flush_interval -1' in src and 'read_timeout 0' in src:
    print('→ already patched, skipping splice')
    sys.exit(0)

if OLD not in src:
    print('error: expected block not found in Caddyfile; refusing to edit', file=sys.stderr)
    sys.exit(2)

p.write_text(src.replace(OLD, NEW, 1))
print('→ spliced WS-friendly transport block')
PY

echo "→ caddy validate"
sudo caddy validate --config "$CADDYFILE"

echo "→ systemctl reload caddy"
sudo systemctl reload caddy

echo "✓ done"
