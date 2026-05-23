#!/bin/bash
# PreToolUse hook for Read — mechanical first-line defense against the
# "image dimension-limit wedges the session" failure mode.
#
# Flow: parse tool input → only act on Read of image paths → sips dims →
# long edge > DIM_LIMIT → create sidecar via safe-image.sh → exit 2 with
# stderr instructing model to Read the sidecar instead.
#
# Fail-closed: if dims can't be read, block. A wedged session is worse than
# a blocked Read.
#
# Exit codes: 0 allow, 2 block (stderr → model).

set -u
export PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH

DIM_LIMIT=2000

input=$(cat)

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$tool_name" = "Read" ] || exit 0

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$file_path" ] && exit 0

shopt -s nocasematch
case "$file_path" in
  *.png|*.jpg|*.jpeg|*.gif|*.webp|*.bmp|*.tiff|*.tif) ;;
  *) exit 0 ;;
esac
shopt -u nocasematch

[ -f "$file_path" ] || exit 0

W=$(sips -g pixelWidth  "$file_path" 2>/dev/null | awk '/pixelWidth/ {print $2}')
H=$(sips -g pixelHeight "$file_path" 2>/dev/null | awk '/pixelHeight/ {print $2}')

if [ -z "$W" ] || [ -z "$H" ] || [ "$W" = "<nil>" ] || [ "$H" = "<nil>" ] \
   || ! [[ "$W" =~ ^[0-9]+$ ]] || ! [[ "$H" =~ ^[0-9]+$ ]]; then
  cat >&2 <<EOF
BLOCKED by pre-read-image hook: cannot read dimensions of
  $file_path
sips returned W='$W' H='$H'. Reading an unparseable image wedges the session
(400 "Could not process image" on every subsequent API call until /compact).
Skip this file or investigate (corrupt? zero bytes? unsupported format?).
EOF
  exit 2
fi

LONG=$(( W > H ? W : H ))
[ "$LONG" -le "$DIM_LIMIT" ] && exit 0

SCRIPT_DIR=""
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -x "${CLAUDE_PROJECT_DIR}/scripts/safe-image.sh" ]; then
  SCRIPT_DIR="${CLAUDE_PROJECT_DIR}/scripts"
fi
if [ -z "$SCRIPT_DIR" ]; then
  HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CAND="$(cd "$HOOK_DIR/../.." && pwd)"
  [ -x "$CAND/scripts/safe-image.sh" ] && SCRIPT_DIR="$CAND/scripts"
fi
if [ -z "$SCRIPT_DIR" ]; then
  cat >&2 <<EOF
BLOCKED by pre-read-image hook: $file_path is ${W}x${H} (long edge $LONG > ${DIM_LIMIT}px).
Reading it will crash the session. safe-image.sh not found locally; don't Read the
original. Run it manually or install scripts/safe-image.sh in this workspace.
EOF
  exit 2
fi

SAFE_PATH=$("$SCRIPT_DIR/safe-image.sh" "$file_path" 2>/dev/null || true)
if [ -z "$SAFE_PATH" ] || [ ! -f "$SAFE_PATH" ]; then
  cat >&2 <<EOF
BLOCKED by pre-read-image hook: $file_path is ${W}x${H} (long edge $LONG > ${DIM_LIMIT}px).
safe-image.sh at $SCRIPT_DIR failed to produce a sidecar. Don't Read the original
— it will wedge the session. Investigate.
EOF
  exit 2
fi

cat >&2 <<EOF
BLOCKED by pre-read-image hook: $file_path is ${W}x${H} (long edge $LONG > ${DIM_LIMIT}px).
Oversized images wedge the session. A safe sidecar has been generated — Read this
path instead:

  $SAFE_PATH
EOF
exit 2
