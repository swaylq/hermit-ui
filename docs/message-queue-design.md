# Message Queue — Design

Status: approved design, pre-implementation
Date: 2026-06-03

## Goal

Let the user send messages **while a chat session is actively working**. Those
messages form a **visible, bounded queue** and are dispatched to the agent
**one at a time, each after the previous turn completes** — instead of today's
behaviour where the composer is simply blocked until the session goes idle.

## Background — how queueing works today

**Claude Code (native TUI):** has an implicit FIFO queue. Pressing Enter while a
turn runs (the "esc to interrupt" marker showing) silently enqueues the message;
it does *not* interrupt. Multiple messages can stack, drained one-per-turn, with
**no visibility and no management** (can't see / remove / reorder). The community
is asking for queue management (claude-code issues #36326, #36817).

**hermit-ui (current):**

- The composer **blocks** sending while the session is working: `submit()`
  early-returns on `inFlight` (`apps/dashboard/src/app/chat/page.tsx:1764`) and
  `canSend` requires `!inFlight` (`:1807`). The send button swaps to Stop.
- Under the hood a half-queue already exists: a sent user message is a
  `ChatMessage` row with `deliveredAt = null` (pending). The gateway polls
  `chat.pollPending` every 2s (`apps/dashboard/src/server/routers/chat.ts:272`,
  `apps/gateway/src/index.ts:153`).
- But `deliverMessages` **coalesces** all messages pending at one poll tick into a
  single `\n\n`-joined prompt (`apps/gateway/src/chat-runner.ts:421-428`) and
  `sendKeys` **immediately, without checking working/idle**
  (`chat-runner.ts:493`). So whatever leaks through races straight into claude's
  TUI, which native-queues it — invisible and unbounded.

Net: there is no user-facing queue today, and the path that exists is
fire-immediately + coalesce.

## Confirmed decisions

1. **Sequential drain** — one queued message = one turn. The next queued message
   is sent only after the previous turn finishes (matches Claude Code; matches
   "等上个工作完成再做").
2. **Limit = 5 waiting** messages (the in-flight turn's message is already
   delivered and does not count → "1 running + up to 5 queued").
3. **Cancel queued messages** is in scope for v1 (remove a not-yet-dispatched
   message). Already-dispatched messages can't be un-sent.
4. **Stop** cancels only the in-flight turn; the queue is **preserved** and keeps
   draining. A separate explicit **Clear queue** action empties it.

## Data model — no migration

The queue is exactly: `ChatMessage` rows where `role = 'user'` and
`deliveredAt IS NULL`, ordered by `createdAt ASC`. Both the field
(`schema.prisma:181`) and the index (`@@index([sessionId, deliveredAt])`,
`schema.prisma:192`) already exist. **No new tables or columns.**

The in-flight message is the one already delivered (`deliveredAt` set); the
queue is everything still null after it.

## Components

### A. Gateway — idle-gated, one-at-a-time dispatch (the core change)

`apps/gateway/src/chat-runner.ts`, `deliverMessages` (currently `:391`):

- Before dispatching, check `paneIsWorking(session.id)`. If **working → return**,
  leaving every pending row untouched (re-evaluated on the next 2s `chatTick`).
- If **idle → dispatch only the oldest pending message** (`msgs[0]`), not the
  coalesced batch: ack + `sendKeys` that single message. The pane immediately
  goes working, so the next `chatTick` holds the rest; when it goes idle again,
  the next-oldest is sent. Sequential drain falls out naturally from
  idle-gate + send-one.
- Image/file relay and the slash-command streaming path are unchanged — they just
  operate on the single message being dispatched.

`paneIsWorking` already exists at
`apps/gateway/src/collect/session-snapshot.ts:81` (capture-pane → scan the last 6
mode-line rows for the "esc to interrupt" marker) but is module-private, and
`cron-runner.ts` keeps a **duplicate** copy (`paneWorking`, `cron-runner.ts:68`).
**Extract one helper to a new `apps/gateway/src/pane.ts`** and import it in all
three callers (session-snapshot, chat-runner, cron-runner) — single source of
truth, removes the divergence risk. (A new shared module beats exporting from a
collector, which would couple chat/cron dispatch to a collector file.)

Dispatch latency after a turn ends ≈ one `chatTick` (~2s), same as today.

### B. Dashboard — enforce the limit in `send`

`apps/dashboard/src/server/routers/chat.ts`, `send` mutation (`:175`):

- Before `chatMessage.create`, count the session's waiting queue:
  `chatMessage.count({ where: { sessionId, role: 'user', deliveredAt: null } })`.
- If `count >= QUEUE_LIMIT`, throw a typed `queue_full` error (the UI maps it to a
  toast / inline state; it does not crash the composer).
- `QUEUE_LIMIT = 5` lives in a small shared dashboard module so both the router
  (enforcement) and the page (pre-disable + label) read the same number.

Semantics: the count is the **waiting** queue only. An idle send sees count 0,
gets delivered within ~2s, and never lingers — so normal one-shot sends are
unaffected.

### C. Dashboard — `dequeue` (cancel a queued message)

New mutation in `chat.ts`:

- `dequeue({ messageId })`: delete the `ChatMessage` **iff** it belongs to the
  caller's machine, `role = 'user'`, and `deliveredAt IS NULL`. A delivered or
  non-existent row is a no-op (can't un-send). Returns `{ removed: boolean }`.
- `clearQueue({ sessionId })`: bulk-delete all undelivered user rows for the
  session (powers the "Clear queue" action).

### D. Dashboard — composer accepts queue-adds while working

`apps/dashboard/src/app/chat/page.tsx`, `ComposeBar`:

- Drop the `inFlight` guard from `submit()` (`:1764`) and from `canSend`
  (`:1807`); enable the textarea while working (it's currently disabled via
  `showStop` at `:1912`). The same `send.mutate` path is reused — "queue" vs
  "send" is purely presentational; the only new admission rule is the limit.
- While working, **Enter enqueues** (matching Claude Code). The prominent button
  stays **Stop**; a small secondary "排队 ⤵" affordance is shown next to it so
  touch users (no Enter-to-send on mobile) can enqueue too.
- When the queue is at `QUEUE_LIMIT`, block further adds and show "队列已满 5/5".
- The optimistic `pending` overlay already in place is reused for instant
  feedback (see the existing `pending` state).

### E. Dashboard — render the queue + per-item cancel

The timeline query `chat.listMessages` **deliberately omits `deliveredAt`** (perf;
it must match the SSE row shape — `chat.ts:166-171`), so the client can't tell
queued from delivered rows there. Rather than reintroduce that field into the hot
query, add a dedicated tiny query **`chat.queue({ sessionId })`** returning just the
undelivered user rows (`id, content, createdAt`, oldest-first; small by
construction — capped at `QUEUE_LIMIT` by `send`).

It feeds a small **QueueBar** strip rendered between the `LoopBar` and the
`ComposeBar`: "N 条排队中 · 等当前任务完成后依次执行", each item (truncated) with a
**✕** (`dequeue`), and a **清空队列** control (`clearQueue`). Queued messages still
appear as normal user bubbles in the timeline (they're part of the conversation);
the strip is the waiting-dispatch control surface. The composer reads the same
query's length to pre-disable at the limit. This keeps the hot `listMessages` / SSE
path untouched.

## End-to-end flow (sequential drain)

1. Session working. User sends **M1**, then **M2**. Composer allows both (under
   limit); two rows with `deliveredAt = null`.
2. `chatTick`: `paneIsWorking = true` → hold both.
3. Current turn ends → `paneIsWorking = false`. `chatTick` dispatches **M1 only**
   (oldest), acks it, `sendKeys`. Pane goes working.
4. `chatTick`: working → hold **M2**.
5. M1's turn ends → dispatch **M2**.

## Edge cases

- **Normal idle send:** count 0, delivered ~2s — unchanged UX.
- **Rapid idle double-send:** first delivers, pane busy, second waits → two turns
  (today these coalesce into one). Slightly different, arguably more correct;
  acceptable.
- **Images / files queued:** relayed at dispatch time via the existing path,
  per single message.
- **Gateway restart mid-queue:** the queue is DB-resident → resumes cleanly.
- **Stop with non-empty queue:** in-flight turn cancelled (`cancelTurn`
  unchanged); queue keeps draining next tick.
- **Slash command queued:** dispatched one-at-a-time like any message; the
  slash-output streaming path is untouched.
- **Gateway offline:** even the "active" message stays `deliveredAt = null`, so
  after 5 the queue blocks with "队列已满" — reasonable (nothing is draining
  anyway).

## Files touched

| File | Change |
|---|---|
| `apps/gateway/src/pane.ts` (new) | single `paneIsWorking` helper (capture-pane work-marker) |
| `apps/gateway/src/chat-runner.ts` | idle-gate dispatch; send oldest-one not coalesced batch |
| `apps/gateway/src/collect/session-snapshot.ts` | import `paneIsWorking` from `pane.ts` (drop local copy) |
| `apps/gateway/src/cron-runner.ts` | import `paneIsWorking` from `pane.ts` (drop local `paneWorking` dup) |
| `apps/dashboard/src/server/routers/chat.ts` | limit check in `send`; new `queue` query + `dequeue` + `clearQueue` |
| `apps/dashboard/src/app/chat/page.tsx` | un-gate composer; QueueBar strip (✕ + count + clear); queue-full state |
| `apps/dashboard/src/lib/chat-queue.ts` (new) | `QUEUE_LIMIT = 5` — plain const, import-safe for both router and page |

## Non-goals (YAGNI)

- Reordering or editing queued messages.
- Per-agent / per-session configurable limit (ship the constant; revisit later).
- "Interrupt current turn with this message" (promote-to-front).
- A coalesce mode (decided: sequential only).

## Verification

Manual, end-to-end against a live session:

1. Start a long turn; queue 2–3 messages from the web — confirm they drain
   **one per turn, in order**, only after each prior turn finishes.
2. Queue up to 5; confirm the 6th is blocked with "队列已满".
3. ✕ a queued message — confirm it's removed and never dispatched; "清空队列"
   empties the rest.
4. Stop mid-turn — confirm the current turn ends and the queue **continues**
   draining.
5. Gateway log shows idle-gated dispatch (no send while the work marker is up).
