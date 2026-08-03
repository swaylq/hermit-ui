# pi runtime — a second agent backend for hermit

Status: design, 2026-08-03

## Goal

Let an agent run on something other than Claude Code, chosen per agent, permanently.

Not a migration. Claude Code stays the default and keeps its current tmux path
untouched. Some agents — cheap recurring work, cron reports, monitoring — run on
a different model instead, and the rest of hermit (chat, sessions, transcripts,
cron, unread, notifications, usage) must not notice which one it is.

The motivation is **provider independence**: an Anthropic outage, quota change,
price change or Claude Code release that alters permission behaviour should not
be able to stop the whole fleet.

## Non-goals

- Replacing Claude Code. See "Why claude stays on tmux" below — there is a
  billing reason, not just inertia.
- Reducing per-agent memory. Not a stated motivation, and the isolation we would
  trade away is worth more than the RAM.
- A durable control plane (TaskRun records, completion gates, operation
  receipts). tagent-core's model is interesting but solves a problem hermit does
  not have.

## Why the seam is an RPC subprocess

pi ships three modes: `interactive`, `print`, and `rpc`. RPC is documented as
"headless operation with JSON stdin/stdout protocol, used for embedding the
agent in other applications" and exports a typed `RpcClient`. Its framing is
strict LF-only JSONL — deliberately not Node readline, because readline splits
on U+2028/U+2029 which are legal inside JSON strings.

Three options were considered.

**pi inside a tmux pane.** Rejected. hermit's pane heuristics are tuned to
Claude Code's TUI specifically — `WORK_MARKER_RE` matching `esc to interrupt`,
`❯` composer detection, capture-pane width handling. pi is a different program,
so all of it would need re-deriving, and we would keep the send-keys/uuid-drift
bug class while doubling the number of TUIs it applies to.

**pi in-process in the gateway.** Rejected for now. The gateway also runs the
collectors, the control WebSocket, the file manager and the image relay. Hosting
N long-running model loops there means one bad agent can take all of it down,
and a gateway restart kills every session at once. tagent-core can do this
because it *is* the whole product; hermit's gateway is shared infrastructure.
May be worth revisiting for one-shot dispatch agents, where isolation matters
less.

**pi as an RPC subprocess.** Chosen. One child process per session, same
isolation boundary hermit already has, and no terminal scraping at all on the pi
side. The typed API maps onto what `chat-runner` currently does by hand:

| chat-runner today | RpcClient |
| --- | --- |
| `sendKeys` + `robustSubmit` retry-if-dropped | `prompt(text, images)` |
| queue into a busy pane | `steer()` / `followUp()` + `setSteeringMode` |
| `paneIsWorking` / `WORK_MARKER_RE` | `waitForIdle()`, event stream |
| tail JSONL + uuid-drift recovery | `onEvent()` → typed `AgentSessionEvent` |
| `/compact` via send-keys | `compact(instructions)` |
| `sendInterrupt` | `abort()` |
| per-machine `settings.json` model | `setModel(provider, id)` per session, at runtime |
| JSONL usage collector | `getSessionStats()` |

## Why claude stays on tmux

`chat-runner.ts`'s header records that interactive `claude` bills against Claude
Max's *Interactive* bucket, while the Agent SDK path bills against a much
smaller *Agent SDK* bucket at full API rates (evolution/lessons.md → L1).
Driving Claude Code programmatically would move every existing agent onto the
expensive meter. So the tmux path is not legacy to be cleaned up — it is load-
bearing, and this design leaves it alone.

pi agents are unaffected: they authenticate to their own provider with their own
key, so there is no Max bucket in play.

## The seam

Everything a runtime produces reaches the dashboard as one shape, already:

```ts
type SyncItem = {
  sessionId: string;
  role: string;
  content: unknown;      // Anthropic-native blocks: text | thinking | tool_use | tool_result
  externalId: string;    // stable dedup id
  claudeSessionId: string | null;
};
```

POSTed to `/api/sync/chat-message`. That is the contract. A runtime's only job is
to own a session and emit `SyncItem`s.

```ts
export interface AgentRuntime {
  readonly kind: 'claude-tmux' | 'pi-rpc';

  /**
   * Start or re-attach the session. Idempotent.
   *
   * `emit` is how the runtime reports everything the conversation produced —
   * assistant turns, tool calls, tool results. The runtime decides *what* is a
   * turn; it never decides how that is persisted. Implementations must dedupe
   * on `externalId` before emitting, because both of them replay: the tmux path
   * re-reads the transcript from line 1 after a gateway restart, and the pi path
   * re-reads durable session entries after a reconnect.
   */
  ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle>;

  /** Deliver a user turn. Returns false if it could not be submitted. */
  submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean>;

  /** Is a turn currently in flight? Gates the message queue. */
  isWorking(handle: RuntimeHandle): Promise<boolean>;

  interrupt(handle: RuntimeHandle): Promise<void>;
  compact(handle: RuntimeHandle, instructions?: string): Promise<void>;

  /** Token/cost for the collectors. */
  usage(handle: RuntimeHandle): Promise<RuntimeUsage | null>;

  /** Stop the session; `hibernate` keeps durable state for later resume. */
  stop(handle: RuntimeHandle, mode: 'hibernate' | 'kill'): Promise<void>;
}
```

`RuntimeHandle` is opaque per implementation: a tmux pane name for
`ClaudeTmuxRuntime`, an `RpcClient` + child pid for `PiRpcRuntime`.

Persistence stays outside the interface. `emit` hands the item to
`chat-runner`'s existing `queueSync`/`flushSync` coalescing, which exists
because a gateway restart otherwise re-POSTs every transcript one request at a
time and saturates the dashboard's event loop. Runtimes do not talk to the
dashboard directly.

### Refactor shape

`chat-runner.ts` is 1251 lines and mixes four concerns: DB polling, session
lifecycle, tmux mechanics, and outbound sync. Only the tmux mechanics move.

- `runtime/types.ts` — the interface above
- `runtime/claude-tmux.ts` — existing tmux calls, lifted verbatim behind it
- `runtime/pi-rpc.ts` — new
- `runtime/index.ts` — `runtimeFor(agent)` picks by `Agent.runtime`
- `chat-runner.ts` — keeps polling, queueing, sync coalescing, title/unread

The claude path must come out behaviourally identical. Its existing tests
(`chat-runner.test.ts`, `pane.test.ts`, `tmux-driver.test.ts`) are the guard.

## Data model

```prisma
model Agent {
  runtime         String  @default("claude-tmux")  // 'claude-tmux' | 'pi-rpc'
  runtimeProvider String?                          // pi only, e.g. 'deepseek'
  runtimeModel    String?                          // pi only, e.g. 'deepseek-v4-pro'
}
```

Default keeps every existing agent on Claude Code with no migration behaviour
change. `claudeSessionId` on `ChatSession` is reused verbatim for pi's session
id — it is already "the runtime's own session identifier", and renaming it would
touch far more than this change is worth.

## Tool parity

pi has **no MCP**. hermit's five tools live in `mcp-stub.cjs` today
(`ask`, `attach_image`, `attach_file`, `set_session_title`, `log_status`) and
become native pi tools instead — pi takes `customTools` directly, the way
tagent-core registers `ls`/`read`/`write`.

This is a simplification, not a loss: no MCP subprocess per agent, no stdio
config plumbing, and it sidesteps the known bug where any `claude mcp`
subcommand corrupts a live session's MCP handles.

The tool bodies are shared. `mcp-stub.cjs` already just POSTs to the dashboard;
that logic moves to a common module both the stub and the pi tools call.

Skills need no port at all. pi discovers `SKILL.md` with `{name, description}`
frontmatter and treats any directory containing one as a skill root — the same
convention Claude Code uses. `cron`, `loop`, `kb-*` and the rest load unchanged.

## Permissions

Claude Code path is unchanged (PreToolUse hook → web permission card).

pi exposes in-process `beforeToolCall` / `afterToolCall`. `PiRpcRuntime` gates
there and reuses the existing `Interaction` table and inline permission cards.
This is strictly better than the shell hook: it is typed, in-process, and cannot
be bypassed by a tool the hook's matcher failed to cover.

## Terminal

`/chat/terminal` is xterm over `tmux attach`. A pi agent is a plain child
process with no pane, so there is nothing to attach to.

Decision: **pi agents get a plain shell pane in the agent's directory**, created
lazily on first terminal open and reaped when idle. No agent runs in it.

This keeps what the terminal is actually used for — inspecting files, running
git, poking at state — without coupling the terminal to the runtime. Watching
the agent think is better served by the chat view, which for pi agents receives
typed events rather than scraped ANSI.

## Cron

Mixed-fleet's main use case is cheap agents doing recurring work, so cron must
work on pi. `cron-runner.ts` spawns `claude` directly today; it moves onto the
same `AgentRuntime.ensure`/`submit` path so a cron fire is just a submitted turn
on a short-lived session.

The `--dangerously-skip-permissions` flag that cron-runner passes has no pi
equivalent; pi's gate is `beforeToolCall`, so the pi path passes a policy that
auto-approves instead of prompting. This preserves the fix for the 2026-06-26
fleet-wide cron hang (cron sessions must never block on a permission prompt).

## Rollout

1. Land the refactor with `ClaudeTmuxRuntime` only. No behaviour change; tests green.
2. Add `PiRpcRuntime` behind `Agent.runtime`, defaulting off.
3. Create one new pi agent on a cheap provider and run it as a pilot.
4. Only after the pilot is stable: expose runtime selection in the agent UI.

Gateway changes require a per-machine restart, so Mac first, then the two
macminis — the usual lag applies.

## Risks

- **Transcript fidelity.** pi's events must translate to Anthropic-native blocks
  faithfully, or the dashboard renders pi sessions worse than claude ones. This
  is the main thing the pilot is testing.
- **`chat-runner` regression.** The refactor touches the fleet's critical path.
  Mitigated by lifting tmux calls verbatim and leaning on existing tests.
- **Skill assumptions.** Some hermit skills shell out to `claude` (restart) or
  assume Claude Code layout. They need auditing per agent, not assuming.
- **Two runtimes to maintain.** Accepted deliberately: it is the point.

## Testing

- Existing gateway tests must pass unchanged after step 1 — that is the
  regression gate for the claude path.
- New unit tests for the pi event → `SyncItem` translation, fed recorded pi
  events, asserting the block shapes the dashboard renders.
- End-to-end: create a pi agent, send a message from the dashboard, confirm the
  reply and tool calls appear in chat with correct blocks, and that usage lands.
