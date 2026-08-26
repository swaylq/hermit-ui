#!/bin/bash
# gateway-watch — resurrect hermit-ui-gateway if pm2 has lost it, and raise a
# MachineAlert when the gateway is alive but not functioning.
#
# WHY THIS EXISTS (2026-08-23): the gateway was out of pm2's process table for
# 5h33m and nothing noticed. pm2 cannot self-heal that case: `pm2 delete` (or a
# `pm2 stop` whose follow-up never ran) removes the entry, and autorestart only
# applies to entries that still exist. So the watcher has to live OUTSIDE the
# thing it watches. It cannot be a hermit cron either — those are fired by the
# gateway's own cron-runner, which is dead exactly when you need it. Hence
# launchd. Full chain: memory/notes/incident_gateway_self_decapitation_pm2_delete.md
#
# WHAT IT CHECKS (2026-08-26, second incident shape added):
#   1. pm2 has an online entry for the gateway (original). If not → pm2 start.
#   2. The gateway's own log file is FRESH. On 2026-08-26 the process sat online
#      in pm2 for ~6h while a runaway browser leak (load 237, swap full) starved
#      its event loop to 130–220s a tick — chat stopped delivering fleet-wide and
#      check #1 saw nothing. A wedged loop writes no log lines; a healthy gateway
#      writes several a minute (tick summaries alone land every ~5min), so
#      10 silent minutes = wedged. Alert only — never restart on suspicion.
#   3. load1 below a hard ceiling (default 60). The same leak's other fingerprint.
#   4. Every resurrection / failure / wedge posts to the dashboard
#      (/api/sync/machine-alert) so it becomes a banner + a push — the 2026-08-23
#      version wrote a local JSON file that nobody ever read.
#
# SAFETY RULES BAKED IN
#   * Never `pm2 delete` / `pm2 stop` / `pm2 restart`. Only `pm2 start`. A
#     watchdog that can kill is a watchdog that can cause the outage it is meant
#     to prevent.
#   * Off switch: `touch <OFF_FILE>` and this becomes a no-op (deliberate
#     maintenance must not be fought by a robot). Every alarm needs an off state.
#   * Single-flight lock, so a slow run cannot overlap the next tick.
#   * The machine key is read from the gateway's .env into a shell variable and
#     used only as a curl header. It is never echoed, logged, or exported.
#
# Per-machine differences live in the launchd plist's EnvironmentVariables (the
# plist is the install record; this script is identical on every machine):
#   GW_APP        pm2 app name                     (default hermit-ui-gateway)
#   GW_ECOSYSTEM  ecosystem file, relative to repo (default apps/gateway/ecosystem.config.cjs)
#   GW_REPO       repo checkout                    (default: derived from this script's location)
#   GW_LOG        watchdog's own log               (default ~/logs/gateway-watch.log)
#   GW_OFF_FILE   off switch                       (default ~/logs/gateway-watch.off)
#   GW_ENV_FILE   gateway .env with ASST_KEY + DASHBOARD_URL (default <repo>/apps/gateway/.env)
#   GW_STALE_SEC  log-silence threshold            (default 600)
#   GW_LOAD_MAX   load1 alert ceiling              (default 60)
set -u

APP="${GW_APP:-hermit-ui-gateway}"
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
REPO="${GW_REPO:-$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)}"
ECOSYSTEM="${GW_ECOSYSTEM:-apps/gateway/ecosystem.config.cjs}"
LOG="${GW_LOG:-$HOME/logs/gateway-watch.log}"
OFF_FILE="${GW_OFF_FILE:-$HOME/logs/gateway-watch.off}"
ENV_FILE="${GW_ENV_FILE:-$REPO/apps/gateway/.env}"
STALE_SEC="${GW_STALE_SEC:-600}"
LOAD_MAX="${GW_LOAD_MAX:-60}"
LOCK="/tmp/gateway-watch-${APP}.lock"

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH}"

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

# ── dashboard alerting ───────────────────────────────────────────────────────
# Key + URL come out of the gateway's .env (grep into variables, never printed).
# If they cannot be resolved, alerts degrade to local log lines and nothing else
# changes — the watcher's real job (pm2 start) must never fail over an alert.
ALERT_URL=""
ASST_KEY=""
if [ -f "$ENV_FILE" ]; then
  ASST_KEY="$(grep -m1 '^ASST_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')"
  DASH="$(grep -m1 '^DASHBOARD_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')"
  [ -n "$DASH" ] && ALERT_URL="${DASH%/}/api/sync/machine-alert"
fi
[ -z "$ALERT_URL" ] && ALERT_URL="https://dash.swaylab.ai/api/sync/machine-alert"

# send_alert <kind> <message> [ttlMinutes] — best-effort; never fails the run.
send_alert() {
  local kind="$1" msg="$2" ttl="${3:-130}"
  if [ -z "$ASST_KEY" ]; then
    say "[alert-dropped] $kind: $msg (no ASST_KEY in $ENV_FILE — log-only)"
    return 0
  fi
  local code
  # messages are authored in this script (single-line, no backslashes); strip
  # double quotes so they cannot break the JSON envelope
  local safe_msg="${msg//\"/}"
  code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST "$ALERT_URL" \
    -H "content-type: application/json" -H "x-asst-key: $ASST_KEY" \
    --data "$(printf '{"kind":"%s","message":"%s","ttlMinutes":%s}' "$kind" "$safe_msg" "$ttl")" 2>&1)"
  if [ "$code" = "200" ]; then
    say "[alert-sent] $kind: $msg"
  else
    say "[alert-failed] $kind: $msg (http/curl: $code)"
  fi
}

# ── pm2 presence check (the original job) ────────────────────────────────────
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

# The gateway's own out-log path, from pm2 (NOT the default ~/.pm2/logs guess —
# the ecosystem file points it into the repo, and a stale guessed path is a
# wedge detector that cries wolf every run).
gw_out_log() {
  pm2 jlist 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit()
g=[p for p in d if p.get("name")==sys.argv[1]]
if g: print(g[0]["pm2_env"].get("pm_out_log_path") or "")
' "$APP" 2>/dev/null
}

read -r ST PID <<<"$(gw_status)"

# "unreadable" means pm2 itself did not answer — do not act on a blind guess
if [ "$ST" = "unreadable" ]; then
  say "[warn] pm2 jlist unreadable (daemon down or pm2 missing?) — no action"
  exit 0
fi

if [ "$ST" = "online" ] && [ "$PID" != "0" ] && kill -0 "$PID" 2>/dev/null; then
  say "[ok] $APP online pid=$PID"

  # ── functional checks: alive is not the same as working ──────────────────

  # (a) log freshness: a healthy gateway writes several lines a minute; a wedged
  #     event loop writes none. Stat failures (rotated away mid-read) are not
  #     evidence of anything — skip silently.
  OUT_LOG="$(gw_out_log)"
  if [ -n "$OUT_LOG" ] && [ -f "$OUT_LOG" ]; then
    MTIME="$(stat -f %m "$OUT_LOG" 2>/dev/null || echo 0)"
    NOW="$(date +%s)"
    AGE="$((NOW - MTIME))"
    if [ "$MTIME" != "0" ] && [ "$AGE" -gt "$STALE_SEC" ]; then
      say "[wedged] $APP wrote no log for ${AGE}s (>${STALE_SEC}s) — event loop suspected wedged, pid=$PID"
      send_alert "gateway-wedged" "网关 ${AGE} 秒没写日志（事件循环疑似卡死），pid=$PID，消息可能投不下去"
    fi
  fi

  # (b) load: past the ceiling the gateway starves even while "online"
  LOAD1="$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"
  if [ -n "$LOAD1" ]; then
    OVER="$(awk -v l="$LOAD1" -v m="$LOAD_MAX" 'BEGIN{print (l>m)?1:0}')"
    if [ "$OVER" = "1" ]; then
      say "[high-load] load1=$LOAD1 > $LOAD_MAX"
      send_alert "high-load" "load1=$LOAD1（阈值 $LOAD_MAX），机器可能被拖死"
    fi
  fi

  exit 0
fi

say "[down] $APP status=$ST pid=$PID — starting from $ECOSYSTEM"
cd "$REPO" 2>/dev/null || { say "[fail] no checkout at $REPO"; exit 1; }
OUT="$(pm2 start "$ECOSYSTEM" --only "$APP" 2>&1 | tail -3)"
sleep 12
read -r ST2 PID2 <<<"$(gw_status)"

if [ "$ST2" = "online" ] && [ "$PID2" != "0" ]; then
  pm2 save >/dev/null 2>&1 && say "[fixed] $APP back online pid=$PID2 (was $ST); pm2 save ok" \
                           || say "[fixed] $APP back online pid=$PID2 (was $ST); pm2 save FAILED"
  send_alert "gateway-resurrected" "网关掉出 pm2 进程表，watchdog 已拉起（原状态 $ST）"
else
  say "[fail] $APP still $ST2 after start; pm2 said: $OUT"
  send_alert "gateway-start-failed" "网关不在 pm2 里且 watchdog 拉起失败（状态 $ST2）"
fi
