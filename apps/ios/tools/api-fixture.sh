#!/usr/bin/env bash
# Drive HermitAPI.swift against a fake dashboard. No simulator, no key, no
# network — about 8 seconds, and it prints BOTH sides: what the Swift decoded,
# and the exact request line the server received.
#
#   apps/ios/tools/api-fixture.sh
#
# Compiled for macOS, which works because HermitAPI imports Foundation and
# nothing else. Not part of any target; `swiftc -typecheck Hermit/*.swift` does
# not see tools/, so if this stops compiling you only find out by running it.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4711}"
BUILD="$(mktemp -d)"
# `|| true` on the wait is load-bearing: `set -e` holds inside the trap too, and
# waiting on a job we just SIGTERMed exits 143 — without it a completely
# successful run reports failure.
trap 'kill "${SRV:-}" 2>/dev/null || true; wait "${SRV:-}" 2>/dev/null || true; rm -rf "$BUILD"' EXIT

swiftc -o "$BUILD/drive" Hermit/HermitAPI.swift Hermit/SessionListItem.swift \
  Hermit/SessionStatus.swift Shared/WebContract.swift tools/api-fixture/main.swift

python3 tools/api-fixture/server.py "$PORT" "$BUILD/requests.jsonl" &
SRV=$!
for _ in $(seq 1 60); do nc -z 127.0.0.1 "$PORT" 2>/dev/null && break; done

echo "── what HermitAPI decoded ───────────────────────────────────"
"$BUILD/drive" "$PORT"

echo
echo "── what the server actually received ────────────────────────"
python3 - "$BUILD/requests.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line)
    print(f"{r['method']} {r['path']}")
    print(f"    x-asst-key={r['key']!r} accept={r['accept']!r} "
          f"content-type={r['ctype']!r} cookie={r['cookie']!r}")
    if r["body"] is not None:
        print(f"    body={r['body']}")
PY
