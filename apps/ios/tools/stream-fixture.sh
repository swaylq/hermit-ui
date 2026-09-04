#!/usr/bin/env bash
# Drive HermitStream.swift against a fake dashboard that really pushes SSE. No
# simulator, no key, no network — about 15 seconds, and it prints BOTH sides:
# every event the Swift produced, and the exact request line the server received.
#
#   apps/ios/tools/stream-fixture.sh
#
# The sibling api-fixture.sh does the same for the tRPC side. They are separate
# because this server has to be threaded (an SSE handler owns its thread for the
# life of the connection) and stateful per scene, and because the interesting
# output here is a SEQUENCE over real time rather than a list of replies.
#
# Compiled for macOS, which works because HermitStream imports Foundation and
# nothing else. Not part of any target; `swiftc -typecheck Hermit/*.swift` does
# not see tools/, so if this stops compiling you only find out by running it.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4712}"
BUILD="$(mktemp -d)"
# `|| true` on the wait is load-bearing: `set -e` holds inside the trap too, and
# waiting on a job we just SIGTERMed exits 143 — without it a completely
# successful run reports failure.
trap 'kill "${SRV:-}" 2>/dev/null || true; wait "${SRV:-}" 2>/dev/null || true; rm -rf "$BUILD"' EXIT

swiftc -o "$BUILD/drive" Hermit/HermitAPI.swift Hermit/HermitStream.swift tools/stream-fixture/main.swift

python3 tools/stream-fixture/server.py "$PORT" "$BUILD/requests.jsonl" &
SRV=$!
for _ in $(seq 1 60); do nc -z 127.0.0.1 "$PORT" 2>/dev/null && break; done

"$BUILD/drive" "$PORT"

echo
echo "── what the server actually received ────────────────────────"
python3 - "$BUILD/requests.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line)
    print(f"#{r['connect']}  {r['path']}")
    print(f"      x-asst-key={r['key']!r} accept={r['accept']!r} cookie={r['cookie']!r}")
PY
