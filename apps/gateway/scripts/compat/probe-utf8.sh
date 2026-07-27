#!/usr/bin/env bash
# probe-utf8.sh — does the gateway's tmux round-trip survive UTF-8 when the
# daemon env has NO locale (pm2/launchd/systemd strip LANG)?
#
# Why it matters: the gateway detects claude's composer by the '❯' glyph
# (U+276F, bytes E2 9D AF) from `capture-pane`, and sway types Chinese into
# `send-keys -l --`. A tmux server started in a non-UTF-8 locale can mangle
# both. Runs on an ISOLATED tmux socket (-L) so no production pane is touched.
set -u
SOCK_A=hermitprobe-nolang
SOCK_B=hermitprobe-utf8
OUT=/tmp/hermit-utf8-out.$$
NEEDLE=$(printf '\342\235\257')          # ❯  — locale-independent octal bytes
CJK=$(printf '\344\275\240\345\245\275')  # 你好
EXPECT_HEX_NEEDLE="e29daf"
EXPECT_HEX_CJK="e4bda0e5a5bd"

hexof() { od -An -tx1 "$1" 2>/dev/null | tr -d ' \n'; }

run_case() {
  local label="$1" sock="$2"; shift 2
  local envcmd=(env -i PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" HOME="$HOME" "$@")
  rm -f "$OUT.$sock"
  "${envcmd[@]}" tmux -L "$sock" kill-server 2>/dev/null
  # A pane that just echoes what it is fed, and stores the raw bytes it received.
  "${envcmd[@]}" tmux -L "$sock" new-session -d -s p -x 80 -y 24 \
    "cat > $OUT.$sock; sleep 5" 2>&1
  sleep 0.7
  # 1) send-keys path (what a user's Chinese message goes through)
  "${envcmd[@]}" tmux -L "$sock" send-keys -t p.0 -l -- "$CJK$NEEDLE" 2>&1
  "${envcmd[@]}" tmux -L "$sock" send-keys -t p.0 Enter 2>&1
  sleep 0.7
  # 2) capture-pane path (what the composer/marker detector reads)
  local cap
  cap=$("${envcmd[@]}" tmux -L "$sock" capture-pane -t p.0 -p 2>/dev/null)
  local cap_hex
  cap_hex=$(printf '%s' "$cap" | od -An -tx1 | tr -d ' \n')
  local recv_hex
  recv_hex=$(hexof "$OUT.$sock")
  "${envcmd[@]}" tmux -L "$sock" kill-server 2>/dev/null

  echo "--- $label ---"
  case "$recv_hex" in
    *"$EXPECT_HEX_CJK"*) echo "  send-keys → pane stdin : CJK bytes INTACT" ;;
    "") echo "  send-keys → pane stdin : (no bytes captured)" ;;
    *) echo "  send-keys → pane stdin : CJK bytes MANGLED  got=${recv_hex:0:60}" ;;
  esac
  case "$recv_hex" in
    *"$EXPECT_HEX_NEEDLE"*) echo "  send-keys → pane stdin : U+276F INTACT" ;;
    *) echo "  send-keys → pane stdin : U+276F MANGLED" ;;
  esac
  case "$cap_hex" in
    *"$EXPECT_HEX_NEEDLE"*) echo "  capture-pane           : U+276F INTACT (composer detect works)" ;;
    *) echo "  capture-pane           : U+276F LOST → composerStatus()/❯ detection BREAKS  cap=${cap_hex:0:60}" ;;
  esac
  case "$cap_hex" in
    *"$EXPECT_HEX_CJK"*) echo "  capture-pane           : CJK INTACT" ;;
    *) echo "  capture-pane           : CJK LOST/mangled" ;;
  esac
  rm -f "$OUT.$sock"
}

echo "host: $(uname -s) $(uname -r)   tmux: $(tmux -V)"
echo "interactive locale: LANG=${LANG:-unset} LC_ALL=${LC_ALL:-unset} LC_CTYPE=${LC_CTYPE:-unset}"
run_case "daemon env, NO locale vars (pm2/launchd/systemd default)" "$SOCK_A"
run_case "daemon env + LANG=C.UTF-8" "$SOCK_B" LANG=C.UTF-8
