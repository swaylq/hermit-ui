# Unanswered-message alert

## The gap

On 2026-07-31 at 21:57 the human typed `查看为什么线上挂了` into a live
`finance-agent` session. The session accepted the message — it was delivered, the
pane was up — and then said nothing. The next row in that conversation is an
assistant `thinking` block at **01:05:36 the next morning, 188 minutes later**, and
only because the Mac had rebooted at 01:00:36 and the session came back with it. A
production site was down for three hours. Nothing alerted; the thing that eventually
noticed was a once-a-day reflection task.

The failure is not that a session wedged. Sessions wedge. The failure is that
**every signal this platform collects reports liveness, not obligation.**
`alive: true, state: "idle"` is what a healthy session between tasks looks like AND
what "a human asked something three hours ago and nobody answered" looks like — the
same row, the same pixels. Crons have real monitoring. "Someone asked and no one
replied" had none.

The same blind spot has a second face: a 21 KB paste exceeded tmux's 16 KiB literal
limit, the send was rejected whole, and the session sat at `starting` forever. Both
cases share a signature — **the evidence is an absence**, and an absence fires
nothing.

## The criterion

> In a session, the newest message is one the **human** typed, and it is older than
> **T**.

That's it. Not "the session is idle", not "the pane looks stuck" — those are the
signals that lied. The last speaker being the human is a statement about the
conversation, and the conversation is the thing with the obligation in it.

"Human message" reuses the four-clause definition already load-bearing in
`server/user-profile.ts` (the USER-PROFILE corpus), because getting it wrong in the
other direction — counting the Brain's own takeover messages or a synced-back
`tool_result` as the human — is the same class of mistake:

```
role = 'user'  AND  authoredBy IS NULL  AND  externalId IS NULL   (message)
session.origin IS NULL                                            (not a Brain dispatch)
```

Session set: `closedAt IS NULL` (archiving is an explicit "I'm done here"). Hidden and
hibernated sessions are **in** — hiding is a sidebar preference, and a hibernated
session that swallowed a question is exactly the failure being looked for.

## The threshold, measured

Guessing here is how you get a bell that always rings. So the number comes from the
history: every human message in the DB, and how long until the next row that is *not*
another human message — which is precisely how long a detector would have seen "the
human spoke last".

61 days, 2026-06-01 → 2026-08-01, 4 233 completed windows across 3 machines:

| p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|
| 51 s | 153 s | 206 s | 317 s | 22.9 min | 4.4 h |

Firings the criterion would have produced at each candidate T:

| T | firings / 61 d | one every |
|---|---|---|
| 5 min | 57 | 1.1 days |
| 10 min | 12 | 5.1 days |
| 15 min | 11 | 5.6 days |
| 20 min | 7 | 8.7 days |
| 25 min | 4 | 15 days |
| **30 min** | **3** | **20 days** |
| 45 min | 3 | 20 days |
| 60 min | 3 | 20 days |

The curve goes flat at 30 minutes and stays flat out to an hour: everything a longer
threshold would remove is already gone, and everything below it is an agent legitimately
taking its time. **T = 30 minutes**, sweep every 5 minutes, so detection lands at
30–35 min.

All three firings at T=30 were real:

| when (Shanghai) | agent | what happened |
|---|---|---|
| 06-16 09:25 | hermit-ui-asst | `hi` after a session restart, no reply for 264 min — the cold-start lost-first-message bug later fixed in `28441af` |
| 06-30 15:39 | ceo | `年薪改成40-60w` — **never answered, at all**, still the last word 33 days later |
| 07-31 21:57 | finance-agent | the incident above, 188 min |

Three signals in two months, three of three true. That is the off state: **a normal
day fires zero times**, and a firing has never yet been noise.

Three minutes is not reachable. At 5 minutes the alert fires about once a day for
agents that are simply thinking, which is the failure mode of the checks that trigger
on 100 % of runs. Three hours → thirty minutes is what the data supports.

## What it deliberately does not use

- **`state` / `alive` / pane text.** Gating on "and the session looks idle" would make
  it quieter and would have suppressed the paste-wedge case, which looks busy forever.
  Those signals are the ones that failed; the whole point is to stop asking them.
  They're carried in the alert body for triage, never in the predicate.
- **`deliveredAt IS NULL` ("the gateway never picked it up") as an early, sharper
  trip.** Measured and rejected: pickup latency is p50 1.4 s but p99 12.8 min, because
  a message sent while the agent is mid-turn legitimately queues. Every human message
  in 61 days was eventually delivered. An "undelivered > 10 min" rule would fire ~45
  times per 61 days for a queue working correctly.
- **A per-session timer armed at send time.** Loses every pending check on a deploy,
  and the state it would protect is already in the DB.

## Where it runs

`apps/dashboard`, started from `src/instrumentation.ts`, one interval in the single
pm2 fork.

Not the gateway: a dead or wedged gateway is one of the *causes* of an unanswered
message, so a check living there is off exactly when it's needed. Not an agent cron
either — that's what already existed (the daily dream), and it found the incident
three hours late. The dashboard is the DB leader, it owns the push pipeline, and it
is up whenever anything can be delivered at all.

## Cost

The sweep is read-only unless something fires (~once per 20 days), and prefilters on
`(machineId, lastMessageAt)` before touching messages: only sessions whose last message
is already older than T-5min get a `LATERAL … ORDER BY createdAt DESC LIMIT 1` probe on
the `(sessionId, createdAt)` index. ~190 index probes every 5 minutes, against a
notifications inbox that scans 300 sessions every 5 seconds per open tab.

The dashboard's own hot paths never recompute it: `notifications.feed` / `counts` read
the persisted `unansweredMsgId` flag through a partial index, so the browser poll stays
a sparse lookup that normally returns zero rows.

## State

Two columns on `ChatSession`, mirroring `HostStat.redAlertAt` / `alertReadAt`:

- `unansweredMsgId` — the human message id the session was flagged on. Set when the
  alert fires, cleared when a non-human row lands. Edge-triggered: the alert is a
  transition, not a state, so a session sitting stalled for hours pushes **once**. A
  *new* human message has a new id, so a follow-up re-arms the clock and can alert
  again.
- `unansweredAckedMsgId` — what "mark all read" acknowledged, so the inbox item can be
  dismissed without the sweep instantly re-raising it.

## Fail-closed

A monitor that returns "nothing wrong" when it can't see is worse than no monitor,
so silence is never the failure mode:

1. Any throw in the sweep is caught, logged, and pushed as its own alert
   (`Unanswered-check is failing`), rate-limited to one per hour.
2. **An empty world is an error, not an all-clear.** The sweep counts open sessions
   first; zero open sessions machine-wide means the query is looking at nothing —
   wrong database, migration mid-flight, bad filter — and takes the failure path
   instead of reporting a clean sweep.
3. The interval is never torn down by a failed tick; failures are counted and the
   count rides in the health record.

## Delivery

`enqueuePush` with a new `stall` kind. It joins `blocked` in the set that ignores
quiet hours: it can only fire 30 minutes after the human themself typed something, so
it cannot wake anyone who wasn't just awake, and "you asked and nothing came back" is
the same urgency class as "an agent is stopped waiting on you".

The "you're already looking at it" suppression (`lastReadAt` within 60 s) applies and
is safe here: the chat pane stamps `lastReadAt` on an effect keyed to the message
count, and a stalled session's message count is by definition frozen — so it stamps
once when you open it and never again. It can't hold its own alert down.

⚠️ **The push transport is currently dark.** `APNS_KEY_ID` / `APNS_TEAM_ID` /
`APNS_TOPIC` / `APNS_PRIVATE_KEY` are unset on the VPS and `PushDevice` has zero
rows, so `enqueuePush` no-ops for *every* kind — `blocked`, `chat`, `cron` and `host`
included. This feature is wired into that pipeline and lights up the moment it is
configured; until then its live surface is the notifications inbox (bell badge +
`/notifications`), which works today.

## Verified

**Backtest** (`scripts/unanswered-backtest.ts`, run against production, 2026-08-02):
4 234 windows over 61.1 days replayed through `isUnanswered()` itself. The 2026-07-31
incident is caught — it would have alerted at 22:27 Shanghai, **158 minutes before
anything else noticed**. Three firings total at T=30, listed above, all real.

**Live** (deployed `6084181`, first sweep 18:01:52 UTC):

- Across 203 sessions on three machines the first sweep raised exactly **one** —
  `ceo` on sway003-macmini, `年薪改成40-60w` from 06-30, unanswered for 46 703
  minutes and still the last word. Its pane is long gone (`alive=false`).
- The next sweep raised **0** — edge-triggering holds, a standing stall doesn't
  re-push every five minutes.
- The clear path was exercised by planting the 07-31 flag on the incident session
  (which has since been answered): the following sweep reported `1 cleared` and the
  flag was gone.
- The inbox row renders: `ceo · UNANSWERED · ⚠ no reply · 32d ago · No reply to:
  年薪改成40-60w`, and `notifications.counts` folds it into the bell badge.
- Nothing in `logs/err.log`.

13 unit tests on the predicate (168 in the suite), `tsc --noEmit` and `build:check`
clean. Dashboard-only — no gateway change, so there is no per-machine rollout.
