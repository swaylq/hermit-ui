#!/usr/bin/env bash
# Drive the web -> native request channel against a real page, with no dashboard,
# no machine key and no network:
#
#   apps/ios/tools/bridge-fixture.sh
#
# Serves tools/bridge-fixture/ over loopback, points the shell at it, and runs
# the one UI test that uses it. Simulator processes run natively on this Mac, so
# 127.0.0.1 inside the simulator is this Mac's loopback — no port forwarding.
#
# Knobs: HERMIT_SIM_DEVICE  HERMIT_SHOT_DIR  HERMIT_FIXTURE_PORT
#        HERMIT_DERIVED_DATA (also stops the cleanup from deleting it)
set -euo pipefail

cd "$(dirname "$0")/.."

DEVICE="${HERMIT_SIM_DEVICE:-iPhone 17}"
SHOT_DIR="${HERMIT_SHOT_DIR:-$PWD/shots}"
DERIVED="${HERMIT_DERIVED_DATA:-${TMPDIR:-/tmp}/hermit-ios-dd}"
OWNS_DERIVED=$([ -n "${HERMIT_DERIVED_DATA:-}" ] && echo 0 || echo 1)
LOG="${TMPDIR:-/tmp}/hermit-fixture-$$.log"
# NOT 49517: that is the dead address the fixture asks the shell to move to, and
# a server answering on it would turn the offline screen this test waits for into
# a page that loads.
PORT="${HERMIT_FIXTURE_PORT:-49518}"

command -v xcodegen >/dev/null || { echo "need xcodegen: brew install xcodegen" >&2; exit 1; }

DEVICE_INFO=$(xcrun simctl list devices available -j | DEVICE="$DEVICE" python3 -c '
import json, os, sys
name = os.environ["DEVICE"]
for runtime, devices in sorted(json.load(sys.stdin)["devices"].items(), reverse=True):
    for d in devices:
        if d.get("name") == name and d.get("isAvailable"):
            print(d["udid"], d.get("state", ""))
            raise SystemExit
')
[ -n "$DEVICE_INFO" ] || { echo "no available simulator named '$DEVICE'" >&2; exit 1; }
UDID=${DEVICE_INFO%% *}
STATE=${DEVICE_INFO#* }
WE_BOOTED=0
[ "$STATE" = "Booted" ] || WE_BOOTED=1

FIXTURE_PID=""
cleanup() {
  pkill -TERM -P $$ 2>/dev/null || true
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true
  xcrun simctl uninstall "$UDID" ai.swaylab.hermit 2>/dev/null || true
  # A booted simulator costs ~3GB of resident memory on this 16GB machine and
  # spills swap files onto the system disk, so it does not get to outlive the
  # run — see the same trap in smoke.sh. Only a device this script booted.
  if [ "$WE_BOOTED" = "1" ]; then
    xcrun simctl shutdown "$UDID" 2>/dev/null || true
    xcrun simctl erase "$UDID" 2>/dev/null || true
  fi
  [ "$OWNS_DERIVED" = "1" ] && rm -rf "$DERIVED"
  rm -f "$LOG"
  return 0
}
trap cleanup EXIT
trap 'exit 143' INT TERM HUP

mkdir -p "$SHOT_DIR"
xcodegen generate >/dev/null

echo "==> serving tools/bridge-fixture on 127.0.0.1:$PORT"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory tools/bridge-fixture >/dev/null 2>&1 &
FIXTURE_PID=$!
# Fail here rather than 30 seconds into a UI test that reports "the fixture page
# never loaded" and cannot say why.
for _ in $(seq 1 20); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break   # -S only on the last try below
  sleep 0.25
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" || { echo "the fixture server never came up on $PORT" >&2; exit 1; }

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl uninstall "$UDID" ai.swaylab.hermit 2>/dev/null || true

common_args=(
  -project Hermit.xcodeproj
  -scheme Hermit
  -sdk iphonesimulator
  -destination "platform=iOS Simulator,id=$UDID"
  -derivedDataPath "$DERIVED"
  CODE_SIGNING_ALLOWED=NO
)

echo "==> building for '$DEVICE' ($UDID)"
set +e
# Backgrounded and waited on: bash defers a trap until a FOREGROUND child exits,
# so a Ctrl-C during the build would otherwise leave the simulator booted.
xcodebuild build-for-testing "${common_args[@]}" > "$LOG" 2>&1 &
wait $!
status=$?
set -e
if [ "$status" -ne 0 ]; then
  echo "==> BUILD FAILED (exit $status)"
  grep -E "error:" "$LOG" | head -20 || true
  exit "$status"
fi

echo "==> running testThePageCanProposeAnotherServer"
export TEST_RUNNER_HERMIT_BRIDGE_ORIGIN="http://127.0.0.1:$PORT"
export TEST_RUNNER_HERMIT_SHOT_DIR="$SHOT_DIR"
set +e
xcodebuild test-without-building "${common_args[@]}" \
  -only-testing:HermitUITests/SmokeTests/testThePageCanProposeAnotherServer >> "$LOG" 2>&1 &
wait $!
status=$?
set -e
tail -20 "$LOG"
if [ "$status" -ne 0 ]; then
  echo "==> TESTS FAILED (exit $status)"
  echo "--- failures ---"
  grep -E "error:|XCTAssert|Assertion Failure|failed - " "$LOG" | head -20 || true
  exit "$status"
fi
echo "==> screenshots in $SHOT_DIR"
