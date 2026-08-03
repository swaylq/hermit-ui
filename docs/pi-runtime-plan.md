# pi runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a hermit agent on pi instead of Claude Code, selected per agent, with its conversation appearing in the dashboard exactly like a claude agent's.

**Architecture:** pi runs as one `pi --mode rpc` child process per chat session, driven through pi's typed `RpcClient` over LF-framed JSONL stdio. A new `AgentRuntime` interface sits between `chat-runner` and the backend; pi's typed session events are translated into the Anthropic-native content blocks the dashboard already renders and handed to `chat-runner`'s existing sync coalescing. Claude Code's tmux path is untouched in this plan.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent` (RpcClient), Node built-in test runner via `tsx --test`, pnpm workspaces, Prisma/PostgreSQL.

**Scope:** Tasks 1–7 deliver a working pi agent in chat. Terminal shell pane, cron on pi, and lifting the claude path behind the interface are a follow-up plan (`docs/pi-runtime-plan-2.md`), deliberately excluded so this plan lands working software.

**Reference:** `docs/pi-runtime-design.md`

---

### Task 1: Runtime interface and shared types

**Files:**
- Create: `apps/gateway/src/runtime/types.ts`

- [ ] **Step 1: Create the interface module**

```ts
// The contract between chat-runner and an agent backend.
//
// A runtime owns a live session and reports what the conversation produced.
// It never decides how that is persisted — `emit` hands items to chat-runner's
// existing sync coalescing, which exists because a gateway restart otherwise
// re-POSTs every transcript one request at a time.

/** One outbound chat-message sync — the shape /api/sync/chat-message accepts. */
export type SyncItem = {
  sessionId: string;
  role: string;
  content: unknown;
  externalId: string;
  claudeSessionId: string | null;
};

export type RuntimeKind = 'claude-tmux' | 'pi-rpc';

export type RuntimeSession = {
  id: string;
  agentName: string;
  agentDirectory: string;
  /** The backend's own session id, if we have resumed one before. */
  externalSessionId: string | null;
  provider?: string | null;
  model?: string | null;
};

export type RuntimeImage = { path: string; mediaType: string };

export type RuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
};

export interface RuntimeHandle {
  readonly sessionId: string;
  readonly externalSessionId: string;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle>;
  submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean>;
  isWorking(handle: RuntimeHandle): Promise<boolean>;
  interrupt(handle: RuntimeHandle): Promise<void>;
  compact(handle: RuntimeHandle, instructions?: string): Promise<void>;
  usage(handle: RuntimeHandle): Promise<RuntimeUsage | null>;
  stop(handle: RuntimeHandle, mode: 'hibernate' | 'kill'): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/gateway && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/runtime/types.ts
git commit -m "feat(gateway): define the AgentRuntime contract"
```

---

### Task 2: Translate pi events into dashboard content blocks

This is the highest-risk part of the whole design — if the translation is wrong,
pi sessions render worse than claude ones. It is a pure function so it can be
tested without spawning anything.

pi emits `AgentSessionEvent`s. The dashboard renders Anthropic-native blocks:
`{type:'text'}`, `{type:'thinking'}`, `{type:'tool_use'}`, `{type:'tool_result'}`.

**Files:**
- Create: `apps/gateway/src/runtime/pi-events.ts`
- Test: `apps/gateway/src/runtime/pi-events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translatePiEvent } from './pi-events';

test('assistant message_end becomes text blocks', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  } as any, 'entry-1');
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.deepEqual(out[0].content, [{ type: 'text', text: 'hi' }]);
  assert.equal(out[0].externalId, 'entry-1');
});

test('thinking blocks are preserved', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }] },
  } as any, 'e2');
  assert.deepEqual(out[0].content, [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'ok' },
  ]);
});

test('tool calls become tool_use blocks', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
    },
  } as any, 'e3');
  assert.deepEqual(out[0].content, [
    { type: 'tool_use', id: 'tc1', name: 'bash', input: { command: 'ls' } },
  ]);
});

test('tool results become a user-role tool_result block', () => {
  const out = translatePiEvent({
    type: 'tool_execution_end',
    toolCallId: 'tc1',
    toolName: 'bash',
    isError: false,
    result: { content: [{ type: 'text', text: 'file.txt' }] },
  } as any, 'e4');
  assert.equal(out[0].role, 'user');
  assert.deepEqual(out[0].content, [
    { type: 'tool_result', tool_use_id: 'tc1', content: 'file.txt', is_error: false },
  ]);
});

test('events with no renderable content produce nothing', () => {
  assert.deepEqual(translatePiEvent({ type: 'agent_settled' } as any, 'e5'), []);
  assert.deepEqual(
    translatePiEvent({ type: 'message_end', message: { role: 'assistant', content: [] } } as any, 'e6'),
    [],
  );
});

test('user messages are dropped — the dashboard already wrote that row', () => {
  const out = translatePiEvent({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  } as any, 'e7');
  assert.deepEqual(out, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/gateway && npx tsx --test src/runtime/pi-events.test.ts`
Expected: FAIL — cannot find module `./pi-events`.

- [ ] **Step 3: Implement the translator**

```ts
import type { SyncItem } from './types';

type Block = Record<string, unknown>;

/** Extract plain text from a pi tool result payload. */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && Array.isArray((result as any).content)) {
    return (result as any).content
      .filter((p: any) => p?.type === 'text')
      .map((p: any) => String(p.text ?? ''))
      .join('');
  }
  return '';
}

/** pi assistant content part -> Anthropic-native block, or null if not renderable. */
function toBlock(part: any): Block | null {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') {
    return String(part.text ?? '') ? { type: 'text', text: String(part.text) } : null;
  }
  if (part.type === 'thinking') {
    return { type: 'thinking', thinking: String(part.thinking ?? '') };
  }
  if (part.type === 'toolCall') {
    return {
      type: 'tool_use',
      id: String(part.id ?? ''),
      name: String(part.name ?? ''),
      input: part.arguments ?? {},
    };
  }
  return null;
}

/**
 * Translate one pi session event into zero or more dashboard sync items.
 *
 * `externalId` must be stable for the event — chat-runner dedupes on it, and pi
 * replays durable session entries after a reconnect.
 */
export function translatePiEvent(ev: any, externalId: string): Omit<SyncItem, 'sessionId' | 'claudeSessionId'>[] {
  if (!ev || typeof ev !== 'object') return [];

  if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
    const content = (Array.isArray(ev.message.content) ? ev.message.content : [])
      .map(toBlock)
      .filter((b: Block | null): b is Block => b !== null);
    if (content.length === 0) return [];
    return [{ role: 'assistant', content, externalId }];
  }

  if (ev.type === 'tool_execution_end') {
    return [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: String(ev.toolCallId ?? ''),
        content: toolResultText(ev.result),
        is_error: Boolean(ev.isError),
      }],
      externalId,
    }];
  }

  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/gateway && npx tsx --test src/runtime/pi-events.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/pi-events.ts apps/gateway/src/runtime/pi-events.test.ts
git commit -m "feat(gateway): translate pi session events into dashboard blocks"
```

---

### Task 3: Add pi as a gateway dependency

**Files:**
- Modify: `apps/gateway/package.json`

- [ ] **Step 1: Install**

```bash
cd /Users/mac/claudeclaw/asst/hermit-ui
npm install @earendil-works/pi-coding-agent@0.83.0 -w @hermit-ui/gateway
```

- [ ] **Step 2: Verify the import surface at runtime**

```bash
cd apps/gateway && npx tsx -e "
import('@earendil-works/pi-coding-agent').then(m => {
  if (typeof m.RpcClient !== 'function') throw new Error('RpcClient missing');
  console.log('RpcClient ok');
});"
```

Expected: `RpcClient ok`

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/package.json package-lock.json
git commit -m "chore(gateway): add pi coding agent"
```

---

### Task 4: PiRpcRuntime — session lifecycle

**Files:**
- Create: `apps/gateway/src/runtime/pi-rpc.ts`

- [ ] **Step 1: Implement ensure/stop**

```ts
import { randomUUID } from 'node:crypto';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
import { translatePiEvent } from './pi-events';

type PiHandle = RuntimeHandle & { client: RpcClient };

const live = new Map<string, PiHandle>();

export class PiRpcRuntime implements AgentRuntime {
  readonly kind = 'pi-rpc' as const;

  async ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle> {
    const existing = live.get(session.id);
    if (existing) return existing;

    const client = new RpcClient({
      cwd: session.agentDirectory,
      provider: session.provider ?? undefined,
      model: session.model ?? undefined,
    });
    await client.start();

    // Dedupe before emitting: pi replays durable entries on reconnect, and
    // chat-runner's dedupe is downstream of us.
    const seen = new Set<string>();
    let ordinal = 0;
    client.onEvent((ev: any) => {
      const externalId = `${session.id}:${ev?.entryId ?? `ord-${ordinal++}`}`;
      if (seen.has(externalId)) return;
      const items = translatePiEvent(ev, externalId);
      if (items.length === 0) return;
      seen.add(externalId);
      for (const item of items) {
        emit({ ...item, sessionId: session.id, claudeSessionId: handle.externalSessionId });
      }
    });

    const state: any = await client.getState().catch(() => null);
    const handle: PiHandle = {
      sessionId: session.id,
      externalSessionId: state?.sessionId ?? session.externalSessionId ?? randomUUID(),
      client,
    };
    live.set(session.id, handle);
    return handle;
  }

  async stop(handle: RuntimeHandle, _mode: 'hibernate' | 'kill'): Promise<void> {
    const h = live.get(handle.sessionId);
    if (!h) return;
    live.delete(handle.sessionId);
    await h.client.stop().catch(() => undefined);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/gateway && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/runtime/pi-rpc.ts
git commit -m "feat(gateway): pi runtime session lifecycle"
```

---

### Task 5: PiRpcRuntime — turn delivery and control

**Files:**
- Modify: `apps/gateway/src/runtime/pi-rpc.ts`

- [ ] **Step 1: Add the remaining interface methods**

Add these methods to `PiRpcRuntime`, and this helper above the class:

```ts
function handleOf(handle: RuntimeHandle): PiHandle | null {
  return live.get(handle.sessionId) ?? null;
}
```

```ts
  async submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    const payload = images.map((img) => ({ path: img.path, mediaType: img.mediaType })) as any;
    // steer() lands mid-turn; prompt() starts one. Matches the tmux path's
    // "queue into a busy pane" behaviour without send-keys.
    const working = await this.isWorking(handle);
    if (working) await h.client.steer(text, payload);
    else await h.client.prompt(text, payload);
    return true;
  }

  async isWorking(handle: RuntimeHandle): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    const state: any = await h.client.getState().catch(() => null);
    return Boolean(state?.isStreaming ?? state?.busy ?? false);
  }

  async interrupt(handle: RuntimeHandle): Promise<void> {
    await handleOf(handle)?.client.abort().catch(() => undefined);
  }

  async compact(handle: RuntimeHandle, instructions?: string): Promise<void> {
    await handleOf(handle)?.client.compact(instructions).catch(() => undefined);
  }

  async usage(handle: RuntimeHandle): Promise<RuntimeUsage | null> {
    const h = handleOf(handle);
    if (!h) return null;
    const stats: any = await h.client.getSessionStats().catch(() => null);
    if (!stats) return null;
    const input = Number(stats.inputTokens ?? stats.usage?.input ?? 0);
    const output = Number(stats.outputTokens ?? stats.usage?.output ?? 0);
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: Number(stats.totalTokens ?? input + output),
      costUsd: typeof stats.cost === 'number' ? stats.cost : null,
    };
  }
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/gateway && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/runtime/pi-rpc.ts
git commit -m "feat(gateway): pi runtime turn delivery and control"
```

---

### Task 6: Per-agent runtime selection in the database

**Files:**
- Modify: `apps/dashboard/prisma/schema.prisma`

- [ ] **Step 1: Add the columns to `model Agent`**

```prisma
  // Which backend runs this agent. 'claude-tmux' is the default and keeps the
  // existing interactive-claude-in-a-pane path; 'pi-rpc' runs pi as an RPC
  // child process. See docs/pi-runtime-design.md.
  runtime         String  @default("claude-tmux")
  runtimeProvider String?
  runtimeModel    String?
```

- [ ] **Step 2: Create and apply the migration**

```bash
cd apps/dashboard
npx prisma migrate dev --name agent_runtime_selection
```

Expected: migration created and applied; every existing row defaults to `claude-tmux`.

- [ ] **Step 3: Verify no existing agent changed behaviour**

```bash
cd apps/dashboard && npx prisma studio --browser none &
# or:
psql "$DATABASE_URL" -c "select runtime, count(*) from \"Agent\" group by runtime"
```

Expected: all rows `claude-tmux`.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/prisma/schema.prisma apps/dashboard/prisma/migrations
git commit -m "feat(db): per-agent runtime selection"
```

---

### Task 7: Route sessions to the right runtime

**Files:**
- Create: `apps/gateway/src/runtime/index.ts`
- Modify: `apps/gateway/src/chat-runner.ts`

- [ ] **Step 1: Create the selector**

```ts
import type { AgentRuntime, RuntimeKind } from './types';
import { PiRpcRuntime } from './pi-rpc';

const piRuntime = new PiRpcRuntime();

/**
 * Pick the backend for an agent. Only 'pi-rpc' is served here; 'claude-tmux'
 * returns null and the caller keeps its existing inline tmux path, which this
 * change deliberately does not touch.
 */
export function runtimeFor(kind: RuntimeKind | string | null | undefined): AgentRuntime | null {
  return kind === 'pi-rpc' ? piRuntime : null;
}

export type { AgentRuntime, RuntimeSession, RuntimeHandle, SyncItem } from './types';
```

- [ ] **Step 2: Extend the session row the poller selects**

In `chat-runner.ts`, extend `PendingSession` (line ~80) so the runtime choice
travels with the session:

```ts
type PendingSession = {
  id: string; agentName: string; claudeSessionId: string | null;
  agentDirectory: string | null; isOrchestrator?: boolean;
  runtime?: string | null; runtimeProvider?: string | null; runtimeModel?: string | null;
};
```

- [ ] **Step 3: Branch in `deliverMessages`**

At the top of `deliverMessages`, before any tmux work:

```ts
  const runtime = runtimeFor(session.runtime);
  if (runtime) {
    const handle = await runtime.ensure({
      id: session.id,
      agentName: session.agentName,
      agentDirectory: session.agentDirectory ?? AGENTS_ROOT,
      externalSessionId: session.claudeSessionId,
      provider: session.runtimeProvider,
      model: session.runtimeModel,
    }, (item) => queueSync(piState(session.id), item));
    for (const m of msgs) {
      const text = typeof m.content === 'string' ? m.content : extractText(m.content);
      await runtime.submit(handle, text, []);
    }
    return;
  }
```

- [ ] **Step 4: Add the sync-state holder for pi sessions**

pi sessions need the same `syncBuf`/`syncTimer` coalescing the tmux path uses,
without the tmux-specific fields. Add near `queueSync`:

```ts
const piStates = new Map<string, SessionState>();

function piState(sessionId: string): SessionState {
  let s = piStates.get(sessionId);
  if (!s) {
    s = {
      claudeUuid: '', jsonlPath: '', stopWatcher: () => {},
      seenUuids: new Set(), uuidStamped: true,
      syncBuf: [], syncTimer: null,
    };
    piStates.set(sessionId, s);
  }
  return s;
}
```

- [ ] **Step 5: Import the selector**

```ts
import { runtimeFor } from './runtime';
```

- [ ] **Step 6: Run the gateway test suite — the claude path must be unchanged**

Run: `cd apps/gateway && npm test`
Expected: all existing tests pass. This is the regression gate.

- [ ] **Step 7: Typecheck the workspace**

Run: `npm run typecheck -w @hermit-ui/gateway`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/runtime/index.ts apps/gateway/src/chat-runner.ts
git commit -m "feat(gateway): route pi-rpc agents to the pi runtime"
```

---

## Self-review notes

- **Spec coverage.** Tasks 1–7 cover the interface, the pi backend, the
  translation, DB selection and routing. Explicitly deferred to plan 2 and
  called out in **Scope** above: terminal shell pane, cron on pi, hermit native
  tools, permission gating via `beforeToolCall`, and lifting the claude path
  behind the interface. Until the tools land, a pi agent has pi's built-in
  bash/read/write/edit/ls/grep tools but none of hermit's (`ask`,
  `attach_*`, `set_session_title`, `log_status`) — acceptable for a pilot,
  not for a production agent.
- **Type consistency.** `SyncItem`, `RuntimeSession`, `RuntimeHandle` and
  `RuntimeUsage` are defined once in Task 1 and used unchanged after.
  `translatePiEvent` returns items without `sessionId`/`claudeSessionId`;
  Task 4 supplies both when emitting.
- **Known softness.** pi's `getState()` shape and `getSessionStats()` field
  names are read defensively (`??` chains) because they are not pinned by a
  published type we have verified at runtime. Task 4 and 5 must be checked
  against a live `pi --mode rpc` process during execution, and tightened once
  the real shapes are observed.
