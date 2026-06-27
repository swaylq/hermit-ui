# Host Resource Governance — Design Spec

**Status:** approved 2026-06-28 · **Scope:** observability (A) + session lifecycle/reaping (B)

## Background

macmini1 (16GB) suffered a memory avalanche: 43 idle `hermit-*` dashboard sessions
(each a ~500MB `claude` process) accumulated over 11 days with no reaping, a sub-agent
fan-out tipped it over, swap hit 96% (34GB), load 110 — a **gray failure** where every
process stayed alive but thrashed to timeout (gateway, SSH, Screen Sharing all unreachable).
No crash, no OOM-kill, no alert, no auto-recovery. Root cause: hermit-ui never reaps
sessions and surfaces zero host-resource signal.

## Scope

**In:** per-host RAM/swap/load + per-session memory observability; idle-TTL reaping of
dashboard sessions with transparent `--resume` wake; a Host-health panel + in-place
session memory/idle/💤 UI; one minimal "host critical" notification.

**Out (later / not hermit-ui):** memory-pressure-driven auto-shedding + admission control
+ `max_agents` (phase C); sub-agent fan-out throttling (Task forks happen inside the pane,
gateway can't intercept — process-tree RSS reflects them passively only); control-plane
isolation / reserved memory for sshd·screensharingd (deployment/OS, not software).

## Architecture

Everything rides the existing gateway tick/collector backbone and the proven
restart/`--resume` machinery. No new processes. Two sub-systems:

- **A. Observability** — gateway samples host metrics + per-session process-tree RSS,
  pushes latest snapshot to the DB; dashboard renders a Host-health panel + in-place
  session memory/idle.
- **B. Lifecycle** — a gateway reaper tick hibernates idle `hermit-*` sessions (kill pane,
  keep DB row + claude transcript); the next message transparently respawns with
  `--resume`. Manual hibernate from the session context menu; bulk reap from the panel.

## Data model (Prisma, additive hand-written migration)

```prisma
model HostStat {            // one row per machine, upserted each metrics tick
  machineId   String   @id
  ramTotalMb  Int?
  ramFreeMb   Int?         // macOS: (free+inactive)·pagesize; linux: MemAvailable
  swapUsedMb  Int?
  swapTotalMb Int?
  loadAvg1    Float?
  cpuCount    Int?
  sampledAt   DateTime?    // staleness; dashboard greys out if old
  machine     Machine  @relation(fields: [machineId], references: [id], onDelete: Cascade)
}
```

`ChatSession` adds:
- `rssMb Int?` — process-tree RSS of this session's pane (latest snapshot).
- `hibernatedAt DateTime?` — set on reap/hibernate, cleared on wake. Distinct from `closedAt`
  (user-ended). A session with `hibernatedAt` + dead pane = "sleeping, wakes on send".

`Machine` adds:
- `idleReapHours Int?` — reaper TTL for this host. `null` = auto-reap disabled. Default seed 72.
- `hibernateRequestedAt`? — NO; manual hibernate reuses a poll/ack flow (below), but lives on
  ChatSession, not Machine. See B2.

`ChatSession` also adds `hibernateRequestedAt DateTime?` — manual-hibernate request flag,
mirrors the existing `restartRequestedAt` poll/ack shape.

## A. Observability

### A1. Host-metrics collector (gateway, ~30s tick)

New `collect/host-stat.ts`. Cross-platform sample:
- **macOS:** `sysctl -n hw.memsize hw.logicalcpu vm.loadavg`, `vm_stat` (page size + Pages
  free/inactive/speculative), `sysctl vm.swapusage` (used/total). `ramFreeMb` =
  (free+inactive+speculative)·pagesize. **Do NOT derive health from swap-used** (macOS lazily
  reclaims swapfiles → stale; see incident §3). Health keys on free-RAM + load.
- **Linux:** `/proc/meminfo` (MemTotal, MemAvailable, SwapTotal, SwapFree), `/proc/loadavg`,
  `os.cpus().length`.
- Use Node `os.freemem()/totalmem()/loadavg()/cpus()` as the portable fallback; shell only
  for the richer macOS swap/inactive numbers.

Push via a new `api.pushHostStat({...})` → dashboard upserts `HostStat`. On command failure:
skip the tick, keep the last row, let `sampledAt` go stale (dashboard greys it).

### A2. Per-session RSS (gateway, folded into the 8s session-snapshot collector)

In `collect/session-snapshot.ts`, once per tick:
1. `tmux list-panes -a -F '#{session_name} #{pane_pid}'` → map every `hermit-*` session → pane pid.
2. `ps -axo pid=,ppid=,rss=` → build a pid→children tree in-process.
3. Per session: sum RSS over the pane-pid subtree (claude + node mcp-stub + any Task children).
   Emit `rssMb` alongside the existing working/idle snapshot fields.

Two commands total regardless of session count. ChatSession.rssMb upserted in the existing
snapshot push (extend its payload + the `sessionSnapshot` mutation).

### A3. Dashboard — Host-health panel + in-place session memory

- **tRPC:** `hosts.stat` (machineProcedure → HostStat for the auth machine + cpuCount/load);
  reuse `chat.listSessions` for per-session rssMb (add `rssMb`, `hibernatedAt` to its select).
- **Health chip** in the sidebar header: a colour dot + `free GB · load`. Colour from raw
  numbers (NOT swap-used): green = free-RAM healthy & load < cpuCount; amber = free-RAM low
  OR load > cpuCount; red = free-RAM critical (<1GB) OR load > 2·cpuCount.
- **Host-health panel** (click the chip → bare-portal popover, per overlay-quirks): the host's
  RAM (free/total bar) · swap · load(vs cpuCount); a **Top-memory sessions** list (this host's
  `hermit-*` sessions sorted by rssMb, each with idle time + a reap button) + a **"Reap idle > N h"**
  bulk action. Multi-machine: list all machines' HostStat.
- **Sidebar rows:** show `rssMb` + idle (from lastMessageAt) compactly; dim + 💤 for
  `hibernatedAt` rows.

### A4. Minimal alert

When a host crosses into **red**, post one Notification (reuse the inbox) — e.g.
`⚠️ macmini1 critical · free 0.0GB · load 110`. Debounced (one per machine per
red-episode; reset when it returns to ≤amber). This is the only alerting in this phase.

## B. Lifecycle / reaping

### B1. Reaper tick (gateway, ~10min)

New `reaper.ts`. Read this machine's `idleReapHours` (null → skip entirely). For each
`hermit-*` ChatSession, hibernate **only if ALL hold**:
- name starts `hermit-` (never the resident `claude-<name>` agents),
- `hibernatedAt` is null and `closedAt` is null,
- snapshot `state !== 'working'`,
- no running loop (`loopState.loops[]` none `status:'running'`),
- no undelivered queue message (deliveredAt-null user rows),
- `now - (lastMessageAt ?? startedAt) > idleReapHours`.

Hibernate = `kill(sessionId)` (tmux-driver) + set `hibernatedAt = now`, `alive = false`.
**Keep `claudeSessionId` + the transcript JSONL.** Log each reap with freed estimate.

### B2. Manual hibernate (context menu)

Right-click menu (the one already shipped) gains **Hibernate** for alive sessions →
`chat.requestHibernate` sets `ChatSession.hibernateRequestedAt`. Gateway `hibernateTick`
(poll/ack, mirrors `pollSessionRestarts`/`ackSessionRestart`): kill pane + set
`hibernatedAt` + clear `hibernateRequestedAt`.

### B3. Wake (on-send only)

No manual wake / pre-warm flow. A hibernated session:
- **Open** in the dashboard → pure DB history (no respawn); shows 💤 + "wakes on send" hint.
- **Send** → existing `deliverMessages → setupSession` sees dead pane + `claudeSessionId` →
  respawns with `--resume <claudeSessionId>` → full context restored. On successful respawn
  of a row whose `hibernatedAt` was set, the gateway clears `hibernatedAt` (un-hibernate).

The reattach loop already skips dead panes (`chat-runner.ts:250`), so a hibernated session
never auto-revives — it stays asleep until the user sends. Verified.

### B4. Lifecycle UI

- Context menu: **Hibernate** (alive) — no "Wake" entry (send wakes).
- Sidebar: 💤 dim for hibernated; reuse the existing delete/compact/restart entries.
- Host-health panel: per-session reap button + "Reap idle > N h" bulk (→ `requestHibernate`
  for each matching session).

## Guardrails & edge cases

- Resident `claude-<name>`, `working`, looping, or queued sessions are NEVER reaped.
- Missing/corrupt transcript on wake → `--resume` degrades (claude starts fresh; DB history
  still renders); clear `hibernatedAt` anyway, log it.
- Metrics command failure → keep last row, mark stale via `sampledAt`.
- macOS swap lazy-reclaim → health colour ignores swap-used (free-RAM + load only).
- Multi-machine → each gateway reports its own host; dashboard is per-machine.
- Waking a very long session reloads full context via `--resume` (slow/large) — mitigated by
  the existing compact; not a blocker.

## Verification (no unit-test harness in repo)

typecheck + `next build`; gateway tick logs; a read-only probe confirming HostStat + rssMb
populate; **manual: hibernate a throwaway session → reopen (history shows) → send → confirm
`--resume` wakes it with context + `hibernatedAt` cleared**; confirm a resident `claude-*`
agent is never selected by the reaper. Deploy = `git push` → `vps-deploy.sh` (prisma migrate
deploy + build + restart); gateway changes need `pm2 restart hermit-ui-gateway` per machine.

## Implementation phases

1. **Data model** — schema + hand-written additive migration (HostStat, ChatSession.rssMb/
   hibernatedAt/hibernateRequestedAt, Machine.idleReapHours default 72). Deploy.
2. **Gateway collectors** — A1 host-stat tick + `pushHostStat` mutation; A2 per-session RSS in
   session-snapshot + payload/mutation extension. Restart gateway; probe-verify.
3. **Observability UI** — A3 `hosts.stat` tRPC + health chip + panel + sidebar rss/idle; A4
   red-crossing notification. Deploy.
4. **Lifecycle backend** — B1 reaper tick; B2 requestHibernate + hibernateTick poll/ack; B3
   hibernatedAt-clear-on-resume. Restart gateway.
5. **Lifecycle UI** — B4 context-menu Hibernate, 💤 dim, per-session + bulk reap in the panel.
   Deploy. Manual wake-cycle verification.

Each phase is independently deployable and leaves the system working.
