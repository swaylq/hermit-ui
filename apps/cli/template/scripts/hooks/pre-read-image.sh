#!/bin/bash
# PreToolUse hook for Read — mechanical first-line defense against the
# "image dimension-limit wedges the session" failure mode.
#
# Flow: parse tool input → only act on Read of image paths → measure dims →
# long edge > DIM_LIMIT → create sidecar via safe-image.sh → exit 2 with
# stderr instructing model to Read the sidecar instead.
#
# Fail-closed: if dims can't be read, block. A wedged session is worse than
# a blocked Read. That principle is why the two lookups below use the _or_die
# forms: on a box with neither jq nor an image backend this hook used to parse
# an empty tool_name and exit 0, which removed the guard entirely while looking
# exactly like a hook that had run and approved.
#
# Exit codes: 0 allow, 2 block (stderr → model).

set -u

HOOK_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" 2>/dev/null && pwd)"
if [ -n "$HOOK_LIB" ] && [ -f "$HOOK_LIB/image.sh" ]; then
  # shellcheck source=../lib/image.sh
  . "$HOOK_LIB/image.sh"
  # shellcheck source=../lib/json.sh
  . "$HOOK_LIB/json.sh"
else
  echo "BLOCKED by pre-read-image hook: scripts/lib is missing from this workspace." >&2
  echo "Cannot verify image size, so the Read is refused (an oversized image wedges the session)." >&2
  exit 2
fi

# Checked HERE, in the parent shell, and not inside the substitutions below:
# `exit` from within `$(…)` ends only the subshell, so a guard down there would
# print its complaint and then let the hook exit 0 — the silent pass this is
# meant to prevent. See the note in lib/json.sh.
if ! have_json_parser; then
  echo "BLOCKED by pre-read-image hook: no JSON parser on this machine (need jq or node)," >&2
  echo "so the tool input cannot be read and image size cannot be verified." >&2
  echo "  install one with: $(install_hint jq)" >&2
  exit 2
fi

DIM_LIMIT=2000

input=$(cat)

tool_name=$(json_get '.tool_name' "$input")
[ "$tool_name" = "Read" ] || exit 0

file_path=$(json_get '.tool_input.file_path' "$input")
[ -z "$file_path" ] && exit 0

shopt -s nocasematch
case "$file_path" in
  *.png|*.jpg|*.jpeg|*.gif|*.webp|*.bmp|*.tiff|*.tif) ;;
  *) exit 0 ;;
esac
shopt -u nocasematch

[ -f "$file_path" ] || exit 0

# No backend at all is its own message: "this machine cannot measure images" is
# a different problem from "this image is broken", and the fix is a package
# install rather than an investigation.
if [ "$(image_backend)" = "none" ]; then
  cat >&2 <<EOF
BLOCKED by pre-read-image hook: this machine has no image backend, so the size
of $file_path cannot be verified. Reading an oversized image wedges the session.
Install one:  $(image_backend_hint)
EOF
  exit 2
fi

if ! DIMS=$(image_dims "$file_path"); then
  cat >&2 <<EOF
BLOCKED by pre-read-image hook: cannot read dimensions of
  $file_path
The $(image_backend) backend could not measure it. Reading an unparseable image
wedges the session (400 "Could not process image" on every subsequent API call
until /compact). Skip this file or investigate (corrupt? zero bytes? unsupported
format?).
EOF
  exit 2
fi
W=${DIMS% *}
H=${DIMS#* }

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
