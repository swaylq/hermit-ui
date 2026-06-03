# Message Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user send messages while a chat session is working; hold them as a visible, bounded (≤5) queue that the gateway drains one-per-turn after each prior turn completes.

**Architecture:** The queue IS the set of `ChatMessage` rows with `role='user'` and `deliveredAt=null` (no migration). The gateway gates dispatch on `paneIsWorking()` and sends only the oldest pending message per idle window (sequential drain). The dashboard enforces the cap in `send`, exposes a dedicated `chat.queue` query + `dequeue`/`clearQueue`, and the composer un-gates while working + renders a QueueBar strip.

**Tech Stack:** TypeScript monorepo (pnpm workspaces). Dashboard = Next.js (custom `tsx server.ts`) + tRPC + Prisma/Postgres. Gateway = plain Node (`tsx`), drives Claude Code via tmux. **No test runner** in this repo — verification is `tsc --noEmit` typecheck, `next build`, and live manual checks against the running gateway + dashboard. Plan steps reflect that (no fabricated unit tests).

**Conventions confirmed against the repo:**
- Per-app typecheck: `pnpm --filter @hermit-ui/gateway typecheck` / `pnpm --filter @hermit-ui/dashboard typecheck`.
- Dashboard build: `pnpm --filter @hermit-ui/dashboard build`.
- Gateway runs locally under pm2 from the working tree; reload = `pm2 delete hermit-ui-gateway && pm2 start apps/gateway/ecosystem.config.cjs --only hermit-ui-gateway && pm2 save`.
- Server router imports are **relative** (`../trpc`, `../db`); client uses the `@/` alias. Match each file's existing style.
- One commit per task (clean history); **no push/deploy until Task 7, which is explicitly gated on the user's go-ahead.**

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/dashboard/src/lib/chat-queue.ts` (new) | `QUEUE_LIMIT` constant, shared by router + page |
| `apps/gateway/src/pane.ts` (new) | the single `paneIsWorking(sessionId)` helper |
| `apps/gateway/src/collect/session-snapshot.ts` | import `paneIsWorking` from `../pane` (drop local copy) |
| `apps/gateway/src/chat-runner.ts` | idle-gate + send oldest-one-per-turn |
| `apps/gateway/src/cron-runner.ts` | import `paneIsWorking` from `./pane` (drop local `paneWorking`) |
| `apps/dashboard/src/server/routers/chat.ts` | `send` cap; new `queue` / `dequeue` / `clearQueue` |
| `apps/dashboard/src/app/chat/page.tsx` | un-gate composer; QueueBar strip; queue-full state |

Task order respects dependencies: 1 (const) → 4,5; 2 (pane) → 3,6; 4 (router) → 5 (UI).

---

### Task 1: Shared `QUEUE_LIMIT` constant

**Files:**
- Create: `apps/dashboard/src/lib/chat-queue.ts`

- [ ] **Step 1: Create the constant module**

```ts
// Shared chat-queue constants. Plain module (no server-only imports) so BOTH the
// tRPC router (server/routers/chat.ts — enforcement) and the chat page
// (app/chat/page.tsx — pre-disable + label) import the same number.
//
// QUEUE_LIMIT is the max number of WAITING messages per session (messages the
// gateway hasn't picked up yet, i.e. deliveredAt=null). The in-flight turn's
// message is already delivered and does NOT count → "1 running + up to 5 queued".
export const QUEUE_LIMIT = 5;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @hermit-ui/dashboard typecheck`
Expected: PASS (no new errors; the module is unused so far but must compile).

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/lib/chat-queue.ts
git commit -m "feat(chat-queue): add shared QUEUE_LIMIT constant"
```

---

### Task 2: Extract `paneIsWorking` into a shared `pane.ts`

**Files:**
- Create: `apps/gateway/src/pane.ts`
- Modify: `apps/gateway/src/collect/session-snapshot.ts:80-86` (remove local copy, import instead)

- [ ] **Step 1: Create `apps/gateway/src/pane.ts`**

This is `cron-runner.ts`'s proven `paneWorking` (self-contained, spawn-based), renamed and promoted to the shared home.

```ts
// pane.ts — the single source of truth for "is this session's claude actively
// working?". Claude Code's TUI shows "esc to interrupt" in its bottom mode line
// ONLY while a turn is in flight (thinking, running a tool, streaming) and drops
// it the instant it goes idle. capture-pane + scanning the last few rows for that
// marker is the ground truth — it matches exactly what the user sees and, unlike
// a "last JSONL line < Ns ago" heuristic, doesn't go stale during a long silent
// think. Used by the session-snapshot collector, the chat dispatch gate, and the
// cron-runner. spawn is async so it never blocks the event loop.
import { spawn } from 'node:child_process';
import { tmuxPaneName } from '@hermit-ui/tmux-driver';

// Scan only the last few rows (the mode line sits at the bottom) so a chat
// message that happens to contain the words can't trigger a false "working".
const WORK_MARKER_RE = /\besc(?:ape)?\s+to\s+(?:interrupt|cancel|stop)\b/i;

export function paneIsWorking(sessionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('tmux', ['capture-pane', '-t', tmuxPaneName(sessionId), '-p'], { timeout: 2_000 });
    } catch {
      resolve(false);
      return;
    }
    let out = '';
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', () => {
      const lines = out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => l.trim());
      resolve(WORK_MARKER_RE.test(lines.slice(-6).join('\n')));
    });
  });
}
```

- [ ] **Step 2: Rewire `session-snapshot.ts` to import it**

In `apps/gateway/src/collect/session-snapshot.ts`, **delete** the local marker + helper (currently lines 80-86):

```ts
const WORK_MARKER_RE = /\besc(?:ape)?\s+to\s+(?:interrupt|cancel|stop)\b/i;
async function paneIsWorking(sessionId: string): Promise<boolean> {
  const out = await run('tmux', ['capture-pane', '-t', tmuxPaneName(sessionId), '-p'], TMUX_TIMEOUT_MS);
  if (out == null) return false;
  const lines = out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => l.trim());
  return WORK_MARKER_RE.test(lines.slice(-6).join('\n'));
}
```

Keep the explanatory comment block above it (lines 72-79) — it documents the `state = working ? …` logic that stays. Add this import alongside the file's other imports near the top (the `// Claude Code's TUI shows…` comment block at 72-79 now documents the imported helper's behavior):

```ts
import { paneIsWorking } from '../pane';
```

`run`, `TMUX_TIMEOUT_MS`, and `tmuxPaneName` remain — they're still used by `paneAlive` / `tmuxPanePid` in this file. The call site `working = await paneIsWorking(...)` (≈line 175) is unchanged.

- [ ] **Step 3: Typecheck the gateway**

Run: `pnpm --filter @hermit-ui/gateway typecheck`
Expected: PASS. (If it flags `tmuxPaneName` as unused in session-snapshot.ts, confirm `paneAlive`/`tmuxPanePid` still reference it — they do — so it stays imported.)

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/pane.ts apps/gateway/src/collect/session-snapshot.ts
git commit -m "refactor(gateway): extract paneIsWorking into shared pane.ts"
```

---

### Task 3: Gateway — idle-gated, one-message-per-turn dispatch

**Files:**
- Modify: `apps/gateway/src/chat-runner.ts` (import + `deliverMessages` body, ≈391-490)

- [ ] **Step 1: Import the shared helper**

Add to the imports near the top of `chat-runner.ts`:

```ts
import { paneIsWorking } from './pane';
```

- [ ] **Step 2: Add the idle gate at the top of `deliverMessages`**

Immediately after the function signature `async function deliverMessages(session: PendingSession, msgs: PendingMsg[]) {` (≈line 391) and BEFORE `// Ensure tmux pane + watcher are up.`, insert:

```ts
  // ── Idle gate (message queue) ──────────────────────────────────────────────
  // If claude is mid-turn, hold the ENTIRE pending batch: leave every row
  // deliveredAt=null and bail. The queue drains one message per turn — the next
  // chatTick (~2s) re-evaluates, and once the pane goes idle we dispatch the
  // single oldest message below. Only gate a pane that actually EXISTS; a brand-
  // new session (no pane yet) must fall through to setupSession. (capture-pane on
  // a missing pane returns false anyway; the explicit exists-check just avoids a
  // pointless 2s spawn against never-started sessions.)
  if (tmuxSessionExists(session.id) && (await paneIsWorking(session.id))) return;
```

(`tmuxSessionExists` is already imported — it's used in the stale-state guard below.)

- [ ] **Step 3: Dispatch only the oldest pending message (sequential drain)**

`msgs` arrives oldest-first (`pollPending` orders `createdAt asc`). Replace the **coalesce** block (currently lines 421-428):

```ts
  // Merge multiple queued user messages into a single submission. The
  // dashboard already has each as its own ChatMessage row, so we only need to
  // feed claude. Use double-newline as a soft separator — when the user fires
  // off several messages quickly, they all reach claude as one turn.
  const textPart = msgs
    .map((m) => extractText(m.content))
    .filter(Boolean)
    .join('\n\n');
```

with single-message handling:

```ts
  // Sequential drain: dispatch ONLY the oldest pending message this turn. The
  // rest stay deliveredAt=null and are re-evaluated on the next chatTick (~2s);
  // once this message's turn ends and the pane goes idle, the next-oldest goes.
  // (The old behaviour coalesced all-pending into one '\n\n'-joined turn.)
  const msg = msgs[0];
  if (!msg) return;
  const textPart = extractText(msg.content);
```

- [ ] **Step 4: Scope image relay + acks to the single message**

Change the relay (currently line 433) from the whole batch to the single message:

```ts
  const relay = await relayImages([msg.content]);
```

Change BOTH `ackChatDelivered` calls from the batch to `[msg.id]`:
- the empty-prompt early-return (currently line 477): `await api.ackChatDelivered([msg.id]).catch(() => {});`
- the pre-send ack (currently line 484): `await api.ackChatDelivered([msg.id]).catch(() => {});`

The relay-error system message, the prompt assembly (`promptParts`), the log line, and the `sendKeys` / slash-stream path below all already read `textPart` / `relay` / `session` — leave them as-is.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @hermit-ui/gateway typecheck`
Expected: PASS. (Watch for an "unused variable" on any leftover `msgs.map` you missed — there should be none after Steps 3-4.)

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/chat-runner.ts
git commit -m "feat(gateway): idle-gate chat dispatch, drain one message per turn"
```

---

### Task 4: Dashboard router — cap, queue query, dequeue, clearQueue

**Files:**
- Modify: `apps/dashboard/src/server/routers/chat.ts` (import; `send` ≈213; new procedures after `cancelTurn` ≈268; new `queue` after `listMessages` ≈173)

- [ ] **Step 1: Import the constant**

At the top of `chat.ts`, alongside `import { prisma } from '../db';`, add (relative path — match the server convention, do NOT use `@/`):

```ts
import { QUEUE_LIMIT } from '../../lib/chat-queue';
```

- [ ] **Step 2: Enforce the cap in `send`**

In the `send` mutation, immediately AFTER the empty-message guard
`if (!text && images.length === 0 && files.length === 0) throw new Error('empty message');`
(currently line 213) and BEFORE the content-block assembly, insert:

```ts
      // Queue cap: count this session's not-yet-delivered user messages (the
      // WAITING queue — the in-flight turn's message is already delivered and so
      // excluded). The composer also pre-disables at QUEUE_LIMIT; this is the
      // server backstop for races.
      const waiting = await prisma.chatMessage.count({
        where: { sessionId: input.sessionId, role: 'user', deliveredAt: null },
      });
      if (waiting >= QUEUE_LIMIT) throw new Error('queue_full');
```

- [ ] **Step 3: Add the `queue` query (right after `listMessages`)**

After the `listMessages` procedure's closing `}),` (currently line 173), insert:

```ts
  // The pending dispatch queue for a session: user messages the gateway hasn't
  // picked up yet (deliveredAt=null), oldest first. Small by construction (capped
  // at QUEUE_LIMIT by `send`). Kept SEPARATE from listMessages so that hot,
  // perf-tuned query keeps skipping deliveredAt. Drives the composer's QueueBar.
  queue: machineProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      return prisma.chatMessage.findMany({
        where: {
          sessionId: input.sessionId,
          session: { machineId: ctx.machine.id },
          role: 'user',
          deliveredAt: null,
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, content: true, createdAt: true },
      });
    }),
```

- [ ] **Step 4: Add `dequeue` + `clearQueue` (after `cancelTurn`)**

After the `cancelTurn` mutation's closing `}),` (currently line 268), insert:

```ts
  // Pull a single still-queued message out before the gateway sends it. Only an
  // UNDELIVERED user row can go (a delivered one is already in claude's hands —
  // can't un-send). Ownership checked via its session, matching send/cancelTurn.
  dequeue: machineProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const m = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { id: true, role: true, deliveredAt: true, session: { select: { machineId: true } } },
      });
      if (!m || m.session.machineId !== ctx.machine.id) throw new Error('not found');
      if (m.role !== 'user' || m.deliveredAt) return { removed: false };
      await prisma.chatMessage.delete({ where: { id: input.messageId } });
      return { removed: true };
    }),

  // Empty the whole waiting queue for a session (undelivered user rows only).
  clearQueue: machineProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const s = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
      if (!s || s.machineId !== ctx.machine.id) throw new Error('not found');
      const r = await prisma.chatMessage.deleteMany({
        where: { sessionId: input.sessionId, role: 'user', deliveredAt: null },
      });
      return { removed: r.count };
    }),
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @hermit-ui/dashboard typecheck`
Expected: PASS. (Confirms the new procedures compile and `QUEUE_LIMIT` resolves.)

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/server/routers/chat.ts
git commit -m "feat(chat): enforce queue cap; add queue/dequeue/clearQueue procedures"
```

---

### Task 5: Dashboard composer — un-gate while working + QueueBar

**Files:**
- Modify: `apps/dashboard/src/app/chat/page.tsx` (import; `ChatView` query+mutations+invalidate; new `QueueBar`; `ComposeBar` props + submit/canSend/textarea/buttons/placeholder)

- [ ] **Step 1: Import `QUEUE_LIMIT`**

With the other `@/…` imports at the top of `page.tsx` (the file already imports `@/components/ui/select`), add:

```ts
import { QUEUE_LIMIT } from '@/lib/chat-queue';
```

- [ ] **Step 2: Add the `queue` query in `ChatView`**

Immediately AFTER the `isInFlight` definition (currently line 914 `const isInFlight = isWaitingAssistant || !!streamingTailId;`), insert:

```ts
  // The waiting dispatch queue (undelivered user rows). Refetch only while it
  // matters: the gateway drains as turns end (so poll while in-flight) and the
  // user can cancel (so poll while non-empty); idle + empty → off. Mutations
  // invalidate for instant feedback.
  const queue = trpc.chat.queue.useQuery(
    { sessionId },
    { refetchInterval: (q) => (isInFlight || (q.state.data?.length ?? 0) > 0 ? 2_000 : false) },
  );
  const queueLen = queue.data?.length ?? 0;
```

- [ ] **Step 3: Add `dequeue` + `clearQueue` mutations + invalidate queue on send**

Near the other mutations (after `restartSession`, ≈line 644), add:

```ts
  const dequeue = trpc.chat.dequeue.useMutation({
    onSuccess: () => {
      utils.chat.queue.invalidate({ sessionId });
      utils.chat.listMessages.invalidate({ sessionId }); // the cancelled bubble leaves the timeline too
    },
  });
  const clearQueue = trpc.chat.clearQueue.useMutation({
    onSuccess: () => {
      utils.chat.queue.invalidate({ sessionId });
      utils.chat.listMessages.invalidate({ sessionId });
    },
  });
```

And in the existing `send` mutation's `onSuccess` (currently lines 622-625), add a line after `utils.chat.listSessions.invalidate();`:

```ts
      utils.chat.queue.invalidate({ sessionId });
```

- [ ] **Step 4: Add the `QueueBar` component**

Define it near `ComposeBar` (module scope, e.g. just above `function ComposeBar({` at line 1610). It reuses the module-scope `msgText` helper already in this file.

```tsx
function QueueBar({
  items,
  onCancel,
  onClear,
  clearing,
}: {
  items: Array<{ id: string; content: unknown; createdAt: string }>;
  onCancel: (id: string) => void;
  onClear: () => void;
  clearing: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-3xl px-3">
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
        <div className="mb-1 flex items-center justify-between text-muted-foreground">
          <span>{items.length} 条排队中 · 等当前任务完成后依次执行</span>
          <button
            type="button"
            onClick={onClear}
            disabled={clearing}
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 cursor-pointer"
          >
            清空队列
          </button>
        </div>
        <ul className="flex flex-col gap-1">
          {items.map((it, i) => (
            <li key={it.id} className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 tabular-nums text-muted-foreground/60">{i + 1}.</span>
              <span className="min-w-0 flex-1 truncate text-foreground/80">{msgText(it.content) || '（附件）'}</span>
              <button
                type="button"
                onClick={() => onCancel(it.id)}
                aria-label="cancel queued message"
                title="移出队列"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

Ensure `X` is imported from `lucide-react` at the top of the file (the import list already pulls many lucide icons; add `X` if absent).

- [ ] **Step 5: Render `QueueBar` between `LoopBar` and `ComposeBar`**

In `ChatView`'s JSX, between the `<LoopBar … />` (closes at line 1200) and `<ComposeBar` (line 1204), insert:

```tsx
          <QueueBar
            items={queue.data ?? []}
            onCancel={(id) => dequeue.mutate({ messageId: id })}
            onClear={() => clearQueue.mutate({ sessionId })}
            clearing={clearQueue.isPending}
          />
```

- [ ] **Step 6: Pass `queueFull` into `ComposeBar`**

On the `<ComposeBar … />` element, add the prop (e.g. right after `inFlight={isInFlight}` at line 1209):

```tsx
            queueFull={queueLen >= QUEUE_LIMIT}
```

- [ ] **Step 7: Accept `queueFull` in `ComposeBar`'s props**

In the destructure (after `inFlight,` at line 1615) add `queueFull,`; in the prop type (after `inFlight: boolean;` at line 1629) add `queueFull: boolean;`.

- [ ] **Step 8: Un-gate `submit` and `canSend`**

Replace `submit`'s guard (line 1764):

```ts
    if (sending || disabled || inFlight) return;
```

with (sending while working is now allowed — only the cap and closed-session block it):

```ts
    if (sending || disabled || queueFull) return;
```

Replace `canSend` (line 1807):

```ts
  const canSend = !sending && !disabled && !inFlight && !awaitingInput && (draft.trim().length > 0 || readyAttachments.length > 0);
```

with:

```ts
  const canSend = !sending && !disabled && !awaitingInput && !queueFull && (draft.trim().length > 0 || readyAttachments.length > 0);
```

(`showStop` at line 1806 stays `inFlight && !disabled`.)

- [ ] **Step 9: Let the user type/attach while working**

Remove `showStop` from the attach button's `disabled` (line 1864) and the textarea's `disabled` (line 1912) — both become:

```tsx
            disabled={disabled || awaitingInput}
```

- [ ] **Step 10: Update the placeholder for the queueing states**

Replace the `showStop` placeholder branch (lines 1906-1907):

```tsx
                : showStop
                ? 'assistant is working… (esc to stop)'
```

with (queue-full first — it can only happen while working):

```tsx
                : queueFull
                ? `queue full (${QUEUE_LIMIT}) · waiting for current turn`
                : showStop
                ? 'working… ↵ to queue next'
```

- [ ] **Step 11: Show Stop AND a queue-send button while working**

Replace the button block (lines 1917-1943, the `{showStop ? (Stop) : (Send)}` ternary) so Stop shows while in-flight and the send/queue button shows whenever `canSend` (now true while working too):

```tsx
          {showStop && (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full cursor-pointer bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-wait transition-colors"
              aria-label={stopping ? 'stopping' : 'stop assistant turn'}
              title={stopping ? 'stopping…' : 'stop assistant turn'}
            >
              <span className="h-3 w-3 rounded-[3px] bg-current" aria-hidden="true" />
            </button>
          )}
          {(!showStop || canSend) && (
            <button
              type="submit"
              disabled={!canSend}
              className={cn(
                'h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full transition-all',
                canSend
                  ? 'bg-foreground text-background hover:bg-foreground/90 cursor-pointer shadow-sm'
                  : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
              )}
              aria-label={inFlight ? 'queue message' : 'send'}
              title={inFlight ? 'queue (↵)' : canSend ? 'send (↵)' : 'type a message'}
            >
              {sending ? <span className="text-sm">…</span> : <ArrowUp className="h-5 w-5" />}
            </button>
          )}
```

(Idle: only Send. Working + draft under cap: Stop + Send. Working + empty draft, or queue full: only Stop.)

- [ ] **Step 12: Typecheck + build**

Run: `pnpm --filter @hermit-ui/dashboard typecheck`
Expected: PASS.
Run: `pnpm --filter @hermit-ui/dashboard build`
Expected: build succeeds (Next compiles the route).

- [ ] **Step 13: Commit**

```bash
git add apps/dashboard/src/app/chat/page.tsx
git commit -m "feat(chat): composer queues while working + QueueBar (cancel/clear/cap)"
```

---

### Task 6: Cron-runner — drop the duplicate `paneWorking`

**Files:**
- Modify: `apps/gateway/src/cron-runner.ts` (imports ≈13-24, 61; remove local `paneWorking` ≈61-85; call site ≈207)

- [ ] **Step 1: Import the shared helper, drop the now-unused imports**

Add `import { paneIsWorking } from './pane';`. Then remove `import { spawn } from 'node:child_process';` (line 14) — it was only used by the local `paneWorking`. In the `@hermit-ui/tmux-driver` import (lines 16-24), remove `tmuxPaneName` from the list — it too was only used by the local copy. (Verify with a quick grep that neither `spawn(` nor `tmuxPaneName(` appears elsewhere in the file before deleting — see Step 3.)

- [ ] **Step 2: Delete the local `WORK_MARKER_RE` + `paneWorking`**

Remove the block currently at lines 61-85 (the `const WORK_MARKER_RE …` and the entire `function paneWorking(sessionId) { … }` with its doc comment), and update the one call site (line 207) from `paneWorking(runSessionId)` to `paneIsWorking(runSessionId)`:

```ts
      if (toolsOut > toolsBack || (await paneIsWorking(runSessionId))) lastEventAt = Date.now();
```

- [ ] **Step 3: Verify no orphaned references, then typecheck**

Run: `grep -n "spawn(\|tmuxPaneName(\|paneWorking" apps/gateway/src/cron-runner.ts`
Expected: no matches (all three are gone). If `spawn(`/`tmuxPaneName(` still appear elsewhere, keep that import.
Run: `pnpm --filter @hermit-ui/gateway typecheck`
Expected: PASS (no unused-import errors).

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/cron-runner.ts
git commit -m "refactor(gateway): cron-runner reuses shared paneIsWorking"
```

---

### Task 7: Integration verification + deploy

**This task touches the live system. Do NOT push/deploy until the user gives the go-ahead.** Steps 1-3 are local (Mac gateway); Step 4 (push + VPS dashboard deploy) is the gated part.

**Files:** none (verification + deploy).

- [ ] **Step 1: Reload the local gateway with the new code**

```bash
cd /Users/mac/claudeclaw/asst/hermit-ui
pm2 delete hermit-ui-gateway
pm2 start apps/gateway/ecosystem.config.cjs --only hermit-ui-gateway
pm2 save
```
Expected: gateway comes up `online`; `pm2 logs hermit-ui-gateway --lines 20` shows a clean boot (no import/throw).

- [ ] **Step 2: Run the dashboard locally against the new build (or wait for deploy)**

The composer/QueueBar changes are dashboard-side. To verify before deploying, run the dashboard build locally (Step 12 of Task 5 already confirmed it compiles). Functional UI checks happen against whichever dashboard the gateway's machine key points at; if testing pre-deploy is impractical, do the functional checks (Step 3) right after the gated deploy in Step 4.

- [ ] **Step 3: Functional checks (against a live agent session)**

Verify each acceptance criterion from the spec:
1. Start a long turn in a session. While it's working, type and send 2-3 messages → they appear as queued (QueueBar shows "N 条排队中"); the gateway log shows NO dispatch while the work marker is up.
2. When the turn ends, exactly the OLDEST queued message is dispatched; the next is sent only after that one's turn ends (one-per-turn, in order).
3. Queue 5; confirm the composer disables with `queue full (5)` and the 6th can't be sent.
4. Click ✕ on a queued item → it's removed and never dispatched; 清空队列 empties the rest.
5. Stop mid-turn → current turn ends, the queue remains and keeps draining.
6. Reload the page / confirm the queue survives (DB-resident).

Record the outcomes honestly; on any failure, fix and re-verify before deploying.

- [ ] **Step 4: Deploy (GATED — only on the user's go-ahead)**

Gateway change is already live locally (Step 1). Dashboard change deploys via the standard git flow:

```bash
git push origin main
ssh ubuntu@45.89.234.110 '~/hermit-ui/scripts/vps-deploy.sh'
```
Expected: VPS pulls, `npm install` (if deps changed — none here), `next build`, restarts `hermit-ui-dashboard`, healthcheck passes. Then re-run the Step 3 checks against dash.swaylab.ai.

---

## Self-Review

**Spec coverage:**
- Sequential drain → Task 3 (idle gate + send `msgs[0]`). ✓
- Limit = 5 waiting → Task 1 (const) + Task 4 Step 2 (`send` cap) + Task 5 (`queueFull` pre-disable). ✓
- Cancel queued → Task 4 (`dequeue`/`clearQueue`) + Task 5 (QueueBar ✕ / 清空队列). ✓
- Stop preserves queue → unchanged `cancelTurn`; queue is separate undelivered rows (no code couples them). ✓ (verified in Task 7 Step 3.5)
- Visible queue → Task 4 (`queue` query) + Task 5 (QueueBar). ✓
- Zero migration → uses existing `deliveredAt` + index. ✓
- paneIsWorking dedup → Task 2 + Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code; commands are real and runnable. ✓

**Type/name consistency:** `paneIsWorking` (not `paneWorking`) used uniformly in pane.ts/session-snapshot/chat-runner/cron-runner. `QUEUE_LIMIT` imported relative in the router, `@/`-aliased in the page. `queue`/`dequeue`/`clearQueue` procedure names match between router (Task 4) and client hooks (Task 5). `queueFull`/`queueLen` consistent across Steps 2/6/7/8. ✓

**Known v1 limitations (documented non-goals):** slash-command Enter stays gated on `!inFlight` (slash commands don't queue in v1); a `queue_full` race throw surfaces only as a silent draft-restore (no toast) — acceptable since the composer pre-disables at the cap.
