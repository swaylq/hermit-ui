#!/usr/bin/env bash
# Build the shell, install it on a simulated iPhone, sign in, screenshot.
#
# The one command that answers "does this app actually work". Everything it needs
# is a machine key in the environment — pass it without ever putting it in argv:
#
#   secret exec MAC001_KEY -- apps/ios/smoke.sh
#
# Set HERMIT_ORIGIN to drive a dashboard build running on this Mac instead of the
# deployed one — that is how a change to apps/dashboard gets verified inside the
# shell before it ships:
#
#   cd apps/dashboard && npx next build && PORT=4102 npx tsx server.ts &
#   secret exec MAC001_KEY -- env HERMIT_ORIGIN=http://localhost:4102 apps/ios/smoke.sh
#
# Without a key it still builds, launches and shoots the sign-in screen, then
# stops. Screenshots land in $HERMIT_SHOT_DIR (default: ./shots).
#
# Knobs: HERMIT_SIM_DEVICE  HERMIT_SHOT_DIR  HERMIT_ORIGIN
#        HERMIT_DERIVED_DATA (also stops the cleanup from deleting it)
#        HERMIT_KEEP_LOG=1   keep the xcodebuild log instead of scrubbing it
set -euo pipefail

cd "$(dirname "$0")"

DEVICE="${HERMIT_SIM_DEVICE:-iPhone 17}"
SHOT_DIR="${HERMIT_SHOT_DIR:-$PWD/shots}"
# Build products, ~170MB, removed on the way out — but ONLY when this script chose
# the path. A caller who points this at their own DerivedData is asking to reuse a
# cache, not to have it deleted.
#
# Note that the default is NOT somewhere else: on macOS `$TMPDIR` is
# /private/var/folders/... and /tmp is /private/tmp, both on the system disk.
# Pointing HERMIT_DERIVED_DATA at another path only helps if that path is on
# another VOLUME.
DERIVED="${HERMIT_DERIVED_DATA:-${TMPDIR:-/tmp}/hermit-ios-dd}"
OWNS_DERIVED=$([ -n "${HERMIT_DERIVED_DATA:-}" ] && echo 0 || echo 1)
# Both scrubbed by the trap. The result bundle records the test runner's launch
# ENVIRONMENT and the log is that run's stdout — either can carry the machine key,
# so neither may outlive the run, on the success path or the failure one.
RESULTS="${TMPDIR:-/tmp}/hermit-smoke-$$.xcresult"
LOG="${TMPDIR:-/tmp}/hermit-smoke-$$.log"
# `secret exec MAC001_KEY` injects MAC001_KEY; accept either name.
KEY="${HERMIT_TEST_KEY:-${MAC001_KEY:-}}"
# Where the shell points. Empty = the shipping URL baked into AppConfig.
ORIGIN="${HERMIT_ORIGIN:-}"

command -v xcodegen >/dev/null || { echo "need xcodegen: brew install xcodegen" >&2; exit 1; }

# Resolve the device to a UDID once. Every simctl call below uses it: a name can
# be ambiguous across runtimes, and both `boot` and `shutdown` swallow their
# errors — so a name that resolved to nothing would skip the shutdown silently,
# which is the one thing the cleanup exists to guarantee.
DEVICE_INFO=$(xcrun simctl list devices available -j | DEVICE="$DEVICE" python3 -c '
import json, os, sys
name = os.environ["DEVICE"]
for runtime, devices in sorted(json.load(sys.stdin)["devices"].items(), reverse=True):
    for d in devices:
        if d.get("name") == name and d.get("isAvailable"):
            print(d["udid"], d.get("state", ""))
            raise SystemExit
')
[ -n "$DEVICE_INFO" ] || { echo "no available simulator named '$DEVICE' (xcrun simctl list devices available)" >&2; exit 1; }
UDID=${DEVICE_INFO%% *}
STATE=${DEVICE_INFO#* }

# A booted device makes the run faster and lets `simctl` talk to it afterwards;
# xcodebuild would boot one itself otherwise.
#
# It also has to be shut down again, and `xcodebuild test` does NOT do that: the
# runtime processes are reparented to launchd and idle forever. On a 16GB machine
# that is not a tidiness point — a booted simulator pushes macOS into memory
# pressure, macOS writes 1GB swap files to the SYSTEM disk, and this box has
# already lost its gateway once to a full disk (2026-09-01, 3h57m of downtime).
# Measured then: shutting one down returned 3.1GB without deleting a single file.
# Only ours gets shut down — a device someone else had booted first is left alone.
WE_BOOTED=0
[ "$STATE" = "Booted" ] || WE_BOOTED=1

cleanup() {
  # Children first. `xcodebuild` does not die with its parent, and shutting the
  # simulator down and deleting DerivedData out from under a live build is worse
  # than either one alone.
  pkill -TERM -P $$ 2>/dev/null || true
  # The app's web storage holds the machine key (that is the point of the
  # persistent data store), so it does not get to outlive the run either.
  xcrun simctl uninstall "$UDID" ai.swaylab.hermit 2>/dev/null || true
  if [ "$WE_BOOTED" = "1" ]; then
    xcrun simctl shutdown "$UDID" 2>/dev/null || true
    # And erase it. The device's own container — the installed app, its web
    # storage, the snapshots — is neither DerivedData nor a result bundle, so
    # nothing else here touches it: six runs took ~/Library/Developer/
    # CoreSimulator from 192MB to 2.1GB. Only a device this run booted, so a
    # device someone else was using keeps its state.
    xcrun simctl erase "$UDID" 2>/dev/null || true
  fi
  [ "$OWNS_DERIVED" = "1" ] && rm -rf "$DERIVED"
  rm -rf "$RESULTS"
  [ "${HERMIT_KEEP_LOG:-0}" = "1" ] || rm -f "$LOG"
  return 0
}
trap cleanup EXIT
# An uncaught SIGTERM kills bash without running the EXIT trap, and a script
# started in the background has SIGINT set to ignore — so both have to be caught
# explicitly and turned into a normal exit.
#
# One case this cannot cover: a signal sent to a WRAPPER shell rather than to this
# script. The script is simply reparented and keeps running, never learning that
# anything happened, so nothing here fires. If you have to stop a run that way,
# finish the job by hand:
#
#   pkill -f 'bash .*smoke.sh'; pkill -f xcodebuild; xcrun simctl shutdown all
trap 'exit 143' INT TERM HUP

mkdir -p "$SHOT_DIR"
xcodegen generate >/dev/null

# What this run costs the system disk. Not `df`: on a box with a dozen sessions
# writing at once, the disk's net change is everyone's, while the swap growth is
# this simulator's own memory overflowing. Four measured runs so far came out
# 10.7G / 4.2G / 0.3G / ~1G against near-identical starting conditions, so there is
# no threshold worth encoding yet — just record the number and let it accumulate.
swap_used() { sysctl -n vm.swapusage 2>/dev/null | sed 's/.*used = \([0-9.]*\)M.*/\1/'; }
SWAP_BEFORE=$(swap_used)
if [ "$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 1)" != "1" ]; then
  echo "note: this machine is already under memory pressure; a simulator on top of that spills to swap files on the system disk"
fi

xcrun simctl boot "$UDID" 2>/dev/null || true
# A genuine first launch: no keyring, no privacy answers. The timing of the
# notification prompt is one of the things being checked, and iOS only asks once
# per install.
xcrun simctl uninstall "$UDID" ai.swaylab.hermit 2>/dev/null || true

common_args=(
  -project Hermit.xcodeproj
  -scheme Hermit
  -sdk iphonesimulator
  -destination "platform=iOS Simulator,id=$UDID"
  -derivedDataPath "$DERIVED"
  # Ad-hoc, not unsigned: an unsigned simulator build has no entitlements and so
  # no keychain access group, and every SecItem call returns -34018. The keyring
  # lives in the keychain now (Hermit/Keychain.swift), so an unsigned run would
  # exercise a fallback path instead of the real one. `-` needs no team.
  CODE_SIGN_IDENTITY=-
  CODE_SIGN_STYLE=Manual
  PROVISIONING_PROFILE_SPECIFIER=
  DEVELOPMENT_TEAM=
)

# Build and test are separate steps on purpose. The warning count is only
# meaningful on the build, and a build that fails must not have already deleted
# the previous run's screenshots.
# Backgrounded and waited on, rather than run in the foreground, because bash
# DEFERS a trap until the foreground child finishes — so during the two minutes
# xcodebuild owns the terminal, a SIGTERM to this script did nothing at all and
# the cleanup only ran (if ever) after the build completed on its own. `wait` is
# interruptible; the trap fires immediately and `pkill -P $$` takes the build with
# it. Output goes to the log and the tail is printed afterwards; `tail -f $LOG`
# from another shell if you want to watch it live.
echo "==> building for '$DEVICE' ($UDID)"
set +e
xcodebuild build-for-testing "${common_args[@]}" > "$LOG" 2>&1 &
wait $!
status=$?
set -e
tail -10 "$LOG"
if [ "$status" -ne 0 ]; then
  echo "==> BUILD FAILED (exit $status)"
  grep -E "error:" "$LOG" | head -20 || true
  exit "$status"
fi
# `appintentsmetadataprocessor` logs one line per target saying it found no
# AppIntents framework — it is not a compiler warning and it is always there, so
# counting it would make "zero warnings" unreachable and the check meaningless.
WARNINGS=$(grep 'warning:' "$LOG" | grep -vc 'appintentsmetadataprocessor' || true)
echo "==> compiler warnings: $WARNINGS"

# Only now that there is something to run: clear the previous run's evidence.
rm -f "$SHOT_DIR"/*.png

echo "==> running the tests"
# Exported, not `env VAR=… xcodebuild`: an assignment in argv is visible in `ps`
# for the length of the fork/exec, and the whole point is that the key is not.
export TEST_RUNNER_HERMIT_TEST_KEY="$KEY"
export TEST_RUNNER_HERMIT_ORIGIN="$ORIGIN"
export TEST_RUNNER_HERMIT_SHOT_DIR="$SHOT_DIR"
set +e
xcodebuild test-without-building "${common_args[@]}" -resultBundlePath "$RESULTS" \
  >> "$LOG" 2>&1 &
wait $!
status=$?
set -e
tail -20 "$LOG"

SWAP_AFTER=$(swap_used)
echo "==> swap used: ${SWAP_BEFORE}M -> ${SWAP_AFTER}M"

if [ "$status" -ne 0 ]; then
  echo "==> TESTS FAILED (exit $status)"
  # xcodebuild buries the assertion a long way above the summary — surface it.
  echo "--- failures ---"
  grep -E "error:|XCTAssert|Assertion Failure|failed - " "$LOG" | head -20 || true
  exit "$status"
fi

echo "==> screenshots in $SHOT_DIR"
ls -1 "$SHOT_DIR"
[ -z "$KEY" ] && echo "==> note: no key in the environment, so this stopped at the sign-in screen"
exit 0
