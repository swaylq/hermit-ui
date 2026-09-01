#!/bin/bash
# gateway-watch — keep hermit-ui-gateway both ALIVE and UNWEDGED, and make every
# one of its findings a dashboard MachineAlert (banner + push), not a local JSON
# file nobody reads.
#
# THREE failures are covered here, and they look nothing alike from the outside.
#
#   1. GONE (2026-08-23). The gateway left pm2's process table for 5h33m and
#      nothing noticed. `pm2 delete` (or a `pm2 stop` whose follow-up never ran)
#      removes the entry, and autorestart only applies to entries that still
#      exist. Detected by: pm2 has no online entry. Fix: `pm2 start`.
#      → memory/notes/incident_gateway_self_decapitation_pm2_delete.md
#
#   2. WEDGED (2026-08-26). dgx-spark sat `online` for 3 days while every single
#      dashboard HTTP call timed out. Nothing outside the box could tell:
#        - pm2 saw a healthy process with a healthy pid;
#        - the dashboard showed the machine as FRESH, because `lastSeen` is
#          bumped by ANY caller presenting the machine key — including an open
#          browser tab (dashboard/src/server/auth.ts:62). It is a "someone
#          authenticated" signal, NOT a gateway-liveness signal. Do not use it;
#        - the circuit breaker in dashboard-http.ts was present in that build and
#          never recovered it.
#      Only a restart clears it. Detected + fixed below (3 confirmations +
#      cooldown before `pm2 restart`).
#
#   3. STARVED / SILENT (2026-08-26, macmini002). A runaway batch script leaked
#      391 headless browsers (load 237, swap full); the gateway's event loop
#      slowed to 130–220s a tick and chat stopped delivering for ~6h. Case 2's
#      counter misses this shape on two axes: failures were ~15-in-a-row (under
#      the 100 bar), and a fully wedged loop writes NO log at all — case 2 reads
#      counters from that very log and refuses to judge a stale one. Covered by
#      two cheap probes in the online branch: load1 over a hard ceiling, and the
#      gateway log going silent (a healthy gateway writes several lines a minute;
#      the [ticks] rollup alone lands every ~5min). Alert only — never restart
#      on suspicion of starvation.
#
# Case 2 is why the fleet-wide `cron_restart: '0 3 * * *'` was REMOVED on
# 2026-08-26 (it had been added 2026-08-24, commit 0049cfa). Restarting on a
# clock paid the full cost every single night whether or not anything was wrong:
# shutdown() exits without draining, so every claude-sdk session on the machine
# loses its in-flight turn, and --resume drops the [1m] variant so the next day's
# first turn re-pays the whole prompt cache write. This pays that cost only when
# the gateway is genuinely wedged.
#
# WHY A WATCHER OUTSIDE THE GATEWAY: a hermit cron cannot do this job — hermit
# crons are fired by the gateway's own cron-runner, which is dead or wedged
# exactly when it is needed. A watcher must live outside the thing it watches.
# sway approved the launchd exception on 2026-08-23 and chose the 1h interval.
#
# SAFETY RULES BAKED IN
#   * Never `pm2 delete` / `pm2 stop`. Only `pm2 start` (case 1) and
#     `pm2 restart` (case 2). Both are RPCs into the pm2 daemon, so they finish
#     even if this script is killed mid-call — whereas `delete` treekills the
#     caller, which is how the 5h33m blackout happened. A watchdog that can kill
#     is a watchdog that can cause the outage it exists to prevent.
#   * `pm2 restart` is issued WITHOUT `--update-env` on purpose. This script runs
#     from launchd/systemd with a near-empty environment; --update-env would
#     overwrite the app's stored env with that, stripping e.g. the https_proxy
#     that dgx-spark's gateway needs to reach Anthropic/OpenAI at all.
#   * A wedge restart requires THREE independent confirmations (below). A false
#     positive costs every live session on the machine, so the bar is high.
#   * Cooldown: at most one wedge restart per GW_COOLDOWN_SEC. If restarting did
#     not fix it, stop restarting and leave the evidence intact for a human.
#   * Off switch: `touch <OFF_FILE>` makes this a no-op. Deliberate maintenance
#     must not be fought by a robot. Every alarm needs an off state.
#   * Single-flight lock, so a slow run cannot overlap the next tick.
#   * The machine key is read from the gateway's .env into a shell variable and
#     used only as a curl header. It is never echoed, logged, or exported.
#
# Env overrides exist for testing against a throwaway pm2 app:
#   GW_APP, GW_ECOSYSTEM, GW_REPO, GW_LOG, GW_OFF_FILE, GW_ALERT, GW_GWLOG,
#   GW_WEDGE_FAILS, GW_CONFIRM_SEC, GW_COOLDOWN_SEC, GW_DASH_URL, GW_STALE_MIN,
#   GW_STATE_DIR, GW_ENV_FILE, GW_LOAD_MAX, GW_SILENT_SEC
set -u

# Values set from Settings → Watchdogs arrive via this file (the machine's
# gateway mirrors Machine.watchdogConfig into it). Sourced BEFORE the defaults
# below so an unset key still lands on the built-in. Missing file = defaults.
[ -f "$HOME/.hermit/gateway-watch/config.env" ] && . "$HOME/.hermit/gateway-watch/config.env"

APP="${GW_APP:-hermit-ui-gateway}"
# mac-local keeps its state in the agent workspace (that is where the existing
# off-switch lives, and moving it would silently disarm it). Every other machine
# in the fleet has no such workspace, so fall back to ~/.hermit/gateway-watch.
if [ -n "${GW_STATE_DIR:-}" ]; then
  STATE_DIR="$GW_STATE_DIR"
elif [ -d "$HOME/claudeclaw/asst/logs" ]; then
  STATE_DIR="$HOME/claudeclaw/asst/logs"
else
  STATE_DIR="$HOME/.hermit/gateway-watch"
fi
LOG="${GW_LOG:-$STATE_DIR/gateway-watch.log}"
OFF_FILE="${GW_OFF_FILE:-$STATE_DIR/gateway-watch.off}"
ALERT="${GW_ALERT:-$STATE_DIR/gateway-watch-alert.json}"
COOLDOWN="${GW_COOLDOWN_FILE:-$STATE_DIR/gateway-watch-lastrestart}"
ECOSYSTEM="${GW_ECOSYSTEM:-apps/gateway/ecosystem.config.cjs}"
# This script ships INSIDE the repo it watches (<repo>/scripts/gateway-watch.sh),
# so its own location is a repo path that is always available and never depends on
# the thing being repaired. See gw_repo below for why that matters.
SELF_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
LOCK="/tmp/gateway-watch-${APP}.lock"

# Wedge thresholds. WEDGE_FAILS is "worst tick's consecutive-failure count in the
# newest 5-minute rollup". The fastest tick runs every 2s, so 100 means roughly
# 3+ minutes of unbroken failure at minimum; dgx-spark reached 6424.
WEDGE_FAILS="${GW_WEDGE_FAILS:-100}"
CONFIRM_SEC="${GW_CONFIRM_SEC:-90}"
COOLDOWN_SEC="${GW_COOLDOWN_SEC:-10800}"   # 3h
STALE_MIN="${GW_STALE_MIN:-20}"
DASH_URL="${GW_DASH_URL:-https://dash.swaylab.ai/}"
# Case-3 probes (alert only): load ceiling, and gateway-log silence in seconds.
LOAD_MAX="${GW_LOAD_MAX:-60}"
SILENT_SEC="${GW_SILENT_SEC:-600}"

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH}"

mkdir -p "$(dirname "$LOG")" 2>/dev/null
# keep the log from growing forever; 512KB is ~2 years of hourly OK lines
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 524288 ]; then
  tail -c 262144 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi
say() { echo "$(date '+%F %T') $*" >>"$LOG"; }

[ -f "$OFF_FILE" ] && { say "[off] $OFF_FILE present — skipping"; exit 0; }

# mkdir is atomic; a stale lock older than 30min is broken open
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    say "[lock] breaking stale lock $LOCK"; rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# status: prints "<status> <pid>", or "absent 0" when pm2 has no such entry
gw_status() {
  pm2 jlist 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("unreadable 0"); sys.exit()
g=[p for p in d if p.get("name")==sys.argv[1]]
if not g: print("absent 0")
else: print(g[0]["pm2_env"].get("status","?"), g[0].get("pid") or 0)
' "$APP" 2>/dev/null || echo "unreadable 0"
}

# Where pm2 actually writes this app's stdout. NEVER assume the repo path: on
# sway003 the gateway is a bare pm2 app and logs to ~/.pm2/logs instead.
gw_logpath() {
  pm2 jlist 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit()
for p in d:
    if p.get("name")==sys.argv[1]:
        print(p.get("pm2_env",{}).get("pm_out_log_path","") or ""); break
' "$APP" 2>/dev/null
}

# Does this directory actually hold the ecosystem file we would start from?
# The one property every caller of gw_repo needs, so checking it turns a guess
# into a verified answer. GW_ECOSYSTEM may be absolute, in which case the
# candidate directory is irrelevant to whether it exists.
gw_has_eco() {
  case "$ECOSYSTEM" in
    /*) [ -f "$ECOSYSTEM" ] ;;
    *)  [ -f "$1/$ECOSYSTEM" ] ;;
  esac
}

# The repo path pm2 believes $APP runs from. Correct WHILE the app is registered,
# and empty precisely when it is not — see gw_repo.
gw_pm2_cwd() {
  pm2 jlist 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit()
for p in d:
    if p.get("name")==sys.argv[1]:
        cwd=p.get("pm2_env",{}).get("pm_cwd","") or ""
        print(cwd[:-len("/apps/gateway")] if cwd.endswith("/apps/gateway") else cwd); break
' "$APP" 2>/dev/null
}

# Where the repo lives. Candidates in order; a candidate wins only if the
# ecosystem file is really there.
#
# THE ORDER IS THE FIX (2026-09-01). gw_pm2_cwd used to be the only source, and
# it reads pm2's entry for $APP — but case 1 below is *defined* as "$APP has no
# entry in pm2's table", so on the single path that needs a repo path there was
# nothing to read and this returned empty. That broke two things at once, and the
# second hid the first:
#   * the recovery `cd` fell through to /nonexistent, logged
#     `[fail] no checkout at '?'` and exited before `pm2 start` ever ran;
#   * ENV_FILE below is derived from this too, so ASST_KEY never resolved and
#     EVERY post_alert degraded to log-only — including `start-failed`, whose
#     entire job is to say the gateway is down and could not be started.
# Net effect on mac-local: the gateway stayed down 3h57m across four hourly
# ticks, each of which logged that it had looked. The only trace was a JSON file
# on the stricken machine's own disk.
#
# Deriving from the app was meant to keep one file working on every machine.
# $SELF_REPO keeps that property — the script lives in the repo — without
# depending on the process it exists to resurrect.
gw_repo() {
  local c
  for c in "${GW_REPO:-}" "${SELF_REPO:-}" "$(gw_pm2_cwd)"; do
    [ -n "$c" ] || continue
    gw_has_eco "$c" || continue
    printf '%s\n' "$c"
    return 0
  done
  return 1
}

# "<worst-failing-in-a-row> <log-age-sec> <log-size-bytes>"; -1 for "cannot tell".
#
# tick-log.ts keeps LabelStats.fail per tick label. The 5-minute rollup resets
# ok/maxMs but NEVER fail — only an actual success clears it. So the newest
# `[ticks] ... N failing in a row` clause is a true monotonic outage counter, and
# a healthy gateway prints no such clause at all.
gw_wedge_stats() {
  python3 -c '
import os,re,sys,time
p=sys.argv[1]
try: st=os.stat(p)
except Exception: print("-1 -1 -1"); sys.exit()
age=int(time.time()-st.st_mtime); size=st.st_size
try:
    with open(p,"rb") as f:
        f.seek(max(0,size-400000)); tail=f.read().decode("utf-8","replace")
except Exception: print("-1 %d %d"%(age,size)); sys.exit()
rolls=[l for l in tail.splitlines() if "[ticks]" in l]
if not rolls: print("-1 %d %d"%(age,size)); sys.exit()
n=[int(m) for m in re.findall(r"(\d+) failing in a row", rolls[-1])]
print("%d %d %d"%(max(n) if n else 0, age, size))
' "$1" 2>/dev/null || echo "-1 -1 -1"
}

# Did the gateway log a dashboard success after byte offset $2?
# dashboard-http.ts prints "[dashboard-http] recovered" on the FIRST success
# following any failure, so this is an exact "it is talking again" test.
gw_recovered_since() {
  python3 -c '
import sys
p,off=sys.argv[1],int(sys.argv[2])
try:
    with open(p,"rb") as f:
        f.seek(0,2); end=f.tell()
        if end < off: off = 0          # rotated or truncated under us
        f.seek(off); new=f.read().decode("utf-8","replace")
except Exception: print("no"); sys.exit()
print("yes" if "[dashboard-http] recovered" in new else "no")
' "$1" "$2" 2>/dev/null || echo "no"
}

# Can THIS MACHINE reach the dashboard right now? Any HTTP status means the
# connection succeeded; only 000/empty means it did not. --noproxy matters: the
# gateway talks to the dashboard directly, so the proxy must not mask a failure.
gw_can_reach_dashboard() {
  local code
  code="$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 15 "$DASH_URL" 2>/dev/null)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# ── dashboard MachineAlert posting ──────────────────────────────────────────
# Key + URL come out of the gateway's .env (grep into variables, never printed).
# If they cannot be resolved, alerts degrade to the local log + JSON file and
# nothing else changes — the watcher's real job must never fail over an alert.
ASST_KEY=""
ALERT_POST_URL="${DASH_URL%/}/api/sync/machine-alert"
# Deliberately NOT `$(gw_repo)/apps/gateway/.env`. Being able to TELL someone
# must not depend on being able to FIX — and it did: gw_repo only answers when a
# usable ecosystem file exists, so on 2026-09-01, the one morning the gateway was
# really gone, ASST_KEY never resolved and every post_alert degraded to log-only.
# The alert that matters most is the one raised when nothing else worked, so this
# walks the same candidates for the one property it actually needs: a readable .env.
gw_env_file() {
  local c
  for c in "${GW_REPO:-}" "${SELF_REPO:-}" "$(gw_pm2_cwd)"; do
    [ -n "$c" ] || continue
    [ -f "$c/apps/gateway/.env" ] || continue
    printf '%s\n' "$c/apps/gateway/.env"
    return 0
  done
  return 1
}
ENV_FILE="${GW_ENV_FILE:-}"
[ -z "$ENV_FILE" ] && ENV_FILE="$(gw_env_file)"
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  ASST_KEY="$(grep -m1 '^ASST_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')"
  D="$(grep -m1 '^DASHBOARD_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')"
  [ -n "$D" ] && ALERT_POST_URL="${D%/}/api/sync/machine-alert"
fi

# post_alert <kind> <message> [ttlMinutes] — best-effort; never fails the run.
# The dashboard dedups per (machine, kind) and throttles re-pushes to 30min, so
# hourly re-reports while a condition holds are one banner, not a stack.
post_alert() {
  local kind="$1" msg="$2" ttl="${3:-130}"
  if [ -z "$ASST_KEY" ]; then
    say "[alert-dropped] $kind: $msg (no ASST_KEY resolvable — log-only)"
    return 0
  fi
  # messages are authored in this script (single-line, no backslashes); strip
  # double quotes so they cannot break the JSON envelope
  local safe_msg="${msg//\"/}"
  local code
  code="$(curl -sS --noproxy '*' -m 20 -o /dev/null -w '%{http_code}' -X POST "$ALERT_POST_URL" \
    -H "content-type: application/json" -H "x-asst-key: $ASST_KEY" \
    --data "$(printf '{"kind":"%s","message":"%s","ttlMinutes":%s}' "$kind" "$safe_msg" "$ttl")" 2>&1)"
  if [ "$code" = "200" ]; then
    say "[alert-sent] $kind: $msg"
  else
    say "[alert-failed] $kind: $msg (http/curl: $code)"
  fi
}

alert() {  # $1=event  $2=detail — local JSON (kept for forensics) + dashboard
  printf '{"at":"%s","event":"%s","app":"%s","detail":"%s"}\n' \
    "$(date '+%F %T')" "$1" "$APP" "$2" >"$ALERT"
  case "$1" in
    resurrected)           post_alert "gateway-resurrected" "网关掉出 pm2 进程表，watchdog 已拉起（$2）" ;;
    start-failed)          post_alert "gateway-start-failed" "网关不在 pm2 里且 watchdog 拉起失败（$2）" ;;
    wedge-restarted)       post_alert "gateway-wedged" "网关持续连不上 dashboard，watchdog 确认后已重启（$2）" ;;
    wedge-restart-failed)  post_alert "gateway-start-failed" "网关卡死且 watchdog 重启失败（$2）" ;;
    wedged-cooldown)       post_alert "gateway-wedged" "网关疑似卡死，但冷却期内已重启过一次，留待人工（$2）" ;;
    # no-checkout was in the silent bucket below until 2026-09-01, on the theory
    # that it is a local-side problem whose alert would not get out anyway. It is
    # not: the dashboard was reachable all through that morning's 3h57m outage,
    # and this is the one event meaning "the gateway is gone and I cannot start
    # it" — exactly what a human needs pushed.
    no-checkout)           post_alert "gateway-start-failed" "网关不在 pm2 里，watchdog 找不到可用的仓库检出，没能拉起（$2）" ;;
    # link-down genuinely stays local: it means THIS MACHINE cannot reach the
    # dashboard, so posting there is the one thing guaranteed not to work.
    *)                     : ;;
  esac
}

read -r ST PID <<<"$(gw_status)"

# "unreadable" means pm2 itself did not answer — do not act on a blind guess
if [ "$ST" = "unreadable" ]; then
  say "[warn] pm2 jlist unreadable (daemon down or pm2 missing?) — no action"
  exit 0
fi

# ---------------------------------------------------------------- case 1: GONE
if [ "$ST" != "online" ] || [ "$PID" = "0" ] || ! kill -0 "$PID" 2>/dev/null; then
  REPO="$(gw_repo)"
  say "[down] $APP status=$ST pid=$PID — starting from $ECOSYSTEM"
  cd "${REPO:-/nonexistent}" 2>/dev/null || { say "[fail] no checkout at '${REPO:-?}'"; alert "no-checkout" "${REPO:-unknown}"; exit 1; }
  OUT="$(pm2 start "$ECOSYSTEM" --only "$APP" 2>&1 | tail -3)"
  sleep 12
  read -r ST2 PID2 <<<"$(gw_status)"
  if [ "$ST2" = "online" ] && [ "$PID2" != "0" ]; then
    pm2 save >/dev/null 2>&1 && say "[fixed] $APP back online pid=$PID2 (was $ST); pm2 save ok" \
                             || say "[fixed] $APP back online pid=$PID2 (was $ST); pm2 save FAILED"
    alert "resurrected" "was=$ST pid=$PID2"
  else
    say "[fail] $APP still $ST2 after start; pm2 said: $OUT"
    alert "start-failed" "status=$ST2"
  fi
  exit 0
fi

# ------------------------------------------------- case 3 probes: STARVED/SILENT
# (alert only — a false positive here costs a push, not every live session)

# load1 over the ceiling (portable: /proc on Linux, sysctl on macOS)
LOAD1="$(python3 -c '
import os
try:
    print(open("/proc/loadavg").read().split()[0])
except Exception:
    try:
        import subprocess
        out = subprocess.run(["sysctl","-n","vm.loadavg"],capture_output=True,text=True).stdout.split()
        print(out[1] if len(out)>=2 else "")
    except Exception:
        print("")
' 2>/dev/null)"
if [ -n "$LOAD1" ]; then
  OVER="$(python3 -c "print(1 if float('$LOAD1') > float('$LOAD_MAX') else 0)" 2>/dev/null)"
  if [ "$OVER" = "1" ]; then
    say "[high-load] load1=$LOAD1 > $LOAD_MAX"
    post_alert "high-load" "load1=$LOAD1（阈值 $LOAD_MAX），机器正被拖垮，网关可能跟着饿死"
  fi
fi

# -------------------------------------------------------------- case 2: WEDGED
LOGP="${GW_GWLOG:-$(gw_logpath)}"
if [ -z "$LOGP" ] || [ ! -f "$LOGP" ]; then
  say "[ok] $APP online pid=$PID (no readable gateway log at '${LOGP:-?}' — wedge check skipped)"
  exit 0
fi

read -r MF AGE SZ <<<"$(gw_wedge_stats "$LOGP")"

if [ "$MF" -lt 0 ]; then
  say "[ok] $APP online pid=$PID (no [ticks] rollup in log tail — wedge check inconclusive)"
  exit 0
fi
if [ "$AGE" -gt "$SILENT_SEC" ]; then
  # A healthy gateway writes several lines a minute (the [ticks] rollup alone
  # lands every ~5min). Total silence is the event-loop-deadlock shape that
  # case 2's counters cannot see (they are read from this very log).
  say "[silent] $APP online pid=$PID but its log has not been written for ${AGE}s — event loop suspected dead"
  post_alert "gateway-wedged" "网关 ${AGE} 秒没写任何日志（事件循环疑似卡死），pid=$PID，消息投不下去"
  exit 0
fi
if [ "$AGE" -gt $((STALE_MIN * 60)) ]; then
  say "[warn] $APP online pid=$PID but its log has not been written for ${AGE}s — not judging"
  exit 0
fi
if [ "$MF" -lt "$WEDGE_FAILS" ]; then
  say "[ok] $APP online pid=$PID (worst tick $MF failing in a row, under $WEDGE_FAILS)"
  exit 0
fi

# Confirmation 1 of 3: sustained failure, from the gateway's own counters.
say "[suspect] $APP online pid=$PID but worst tick has $MF failing in a row — confirming"

NOW="$(date +%s)"
if [ -f "$COOLDOWN" ]; then
  LAST="$(cat "$COOLDOWN" 2>/dev/null || echo 0)"
  case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
  if [ $((NOW - LAST)) -lt "$COOLDOWN_SEC" ]; then
    say "[hold] wedge restart already done $((NOW - LAST))s ago (cooldown ${COOLDOWN_SEC}s) — restarting again would not help; leaving it for a human"
    alert "wedged-cooldown" "failing=$MF since=$((NOW - LAST))s"
    exit 0
  fi
fi

# Confirmation 2 of 3: the link itself is fine, so this is the gateway's fault.
if ! gw_can_reach_dashboard; then
  say "[skip] this machine cannot reach $DASH_URL either — the link is down, not a wedge; no restart"
  alert "link-down" "failing=$MF"
  exit 0
fi

# Confirmation 3 of 3: give it CONFIRM_SEC to prove it can still talk. Ticks
# retry every 2s, so a usable path would have logged "recovered" well inside it.
sleep "$CONFIRM_SEC"
if [ "$(gw_recovered_since "$LOGP" "$SZ")" = "yes" ]; then
  say "[skip] $APP logged [dashboard-http] recovered during the ${CONFIRM_SEC}s confirm window — it healed itself; no restart"
  exit 0
fi

say "[wedged] restarting $APP: worst tick $MF failing in a row, dashboard reachable from this machine, no recovery in ${CONFIRM_SEC}s"
echo "$NOW" >"$COOLDOWN"
pm2 restart "$APP" >/dev/null 2>&1
sleep 20
read -r ST3 PID3 <<<"$(gw_status)"
if [ "$ST3" = "online" ] && [ "$PID3" != "0" ] && [ "$PID3" != "$PID" ]; then
  say "[fixed] $APP restarted pid=$PID -> $PID3"
  alert "wedge-restarted" "failing=$MF oldpid=$PID newpid=$PID3"
else
  say "[fail] $APP is $ST3 pid=$PID3 after wedge restart"
  alert "wedge-restart-failed" "status=$ST3"
fi
