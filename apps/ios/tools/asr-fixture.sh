#!/usr/bin/env bash
# Drive AsrSocket.swift against a real WebSocket. No simulator, no key, no
# network, no microphone — about 10 seconds, and it prints BOTH sides: what the
# Swift saw, and what the server received.
#
#   apps/ios/tools/asr-fixture.sh
#
# The no-microphone part is the point. This Mac has no audio input device, so a
# dictation run cannot be driven on the simulator here at all; the socket is the
# half of the feature a machine without a microphone can still be honest about.
#
# What it checks:
#   · the URL is ws://<root>/api/asr/<sessionId>
#   · the key rides as the `hermit-key.<token>` SUBPROTOCOL and NOT as a header
#     (the server authenticates the subprotocol, because the browser half has no
#     other channel — a shell that "helpfully" sent the header would 401 with the
#     key sitting in the request)
#   · audio queued before the handshake finished is flushed, not dropped
#   · corrections that come back OUT OF ORDER land on the right sentence
#   · stop() gets a `done` and the tail is final
#
# Compiled for macOS: AsrSocket and DictationCore import Foundation and nothing
# else. Not part of any target, so `swiftc -typecheck Hermit/*.swift` does not
# see this file — if it stops compiling you only find out by running it.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4712}"
BUILD="$(mktemp -d)"
# `|| true` on the wait is load-bearing: `set -e` holds inside the trap too, and
# waiting on a job we just SIGTERMed exits 143 — without it a completely
# successful run reports failure.
trap 'kill "${SRV:-}" 2>/dev/null || true; wait "${SRV:-}" 2>/dev/null || true; rm -rf "$BUILD"' EXIT

swiftc -o "$BUILD/drive" Hermit/AsrSocket.swift Hermit/DictationCore.swift tools/asr-fixture/main.swift

python3 tools/asr-fixture/server.py "$PORT" "$BUILD/asr.jsonl" &
SRV=$!
for _ in $(seq 1 60); do nc -z 127.0.0.1 "$PORT" 2>/dev/null && break; done

echo "── what AsrSocket saw ───────────────────────────────────────"
"$BUILD/drive" "$PORT" | tee "$BUILD/saw.txt"

echo
echo "── what the server actually received ────────────────────────"
python3 - "$BUILD/asr.jsonl" <<'PY' | tee "$BUILD/got.txt"
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line)
    if r["event"] == "open":
        print(f"GET {r['path']}")
        print(f"    sec-websocket-protocol={r['protocol']!r}")
        print(f"    x-asst-key={r['asstKey']!r}   (must be None: the server reads the subprotocol)")
    elif r["event"] == "control":
        print(f"    control {r['frame']}  after {r['audioBytes']} bytes of audio")
    else:
        print(f"    closed after {r['audioBytes']} bytes of audio")
PY

# ── and what all of that has to say ─────────────────────────────────────────
#
# Spelled out rather than eyeballed. A fixture that only prints cannot go red,
# and every line below has been made to go red on purpose — see the round-9 entry
# in docs/ios-native-progress.md for which mutation broke which.
echo
fail=0
want() {
  if grep -qF "$2" "$1"; then
    echo "  ✓ $3"
  else
    echo "  ✗ $3"
    fail=1
  fi
}
want "$BUILD/got.txt" "GET /api/asr/s_fixture" "the URL is /api/asr/<sessionId>"
want "$BUILD/got.txt" "sec-websocket-protocol='hermit-key.K-FIXTURE'" "the key rides as the subprotocol"
want "$BUILD/got.txt" "x-asst-key=None" "…and NOT as a header"
# 6 blocks × 3200 bytes. Three of them were queued before the handshake could
# have finished; 9600 here means the pre-open buffer dropped them.
want "$BUILD/got.txt" "after 19200 bytes of audio" "audio queued before the socket opened still arrived"
want "$BUILD/saw.txt" "ready:      true" "the ready frame reached the caller"
want "$BUILD/saw.txt" "sentences:  2" "two sentences closed"
want "$BUILD/saw.txt" 'tail="把隧道重启一下然后看看日志。"' "the out-of-order correction landed on segment 9 alone (ids are 4 and 9, not 0 and 1)"
want "$BUILD/saw.txt" 'done:       Optional("把隧道重启一下。然后看看日志。")' "the final tail is both corrections, joined"
want "$BUILD/saw.txt" "failure:    nil" "and nothing failed"
[ "$fail" = 0 ] || { echo; echo "asr fixture: DISAGREES with the server"; exit 1; }
echo
echo "asr fixture: 9 checks, all agree"
