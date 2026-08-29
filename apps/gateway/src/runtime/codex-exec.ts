// codex backend: OpenAI's Codex CLI driven through @openai/codex-sdk.
//
// Unlike pi and omp there is no long-lived child to keep alive. The SDK runs
// one `codex exec` per turn and the conversation lives in codex's own thread
// store (`~/.codex/sessions/**/rollout-*-<threadId>.jsonl`), so "the session"
// here is a thread id plus whatever we remember about the last turn. That makes
// hibernate and restart nearly free — there is no process to drain — and it
// makes a gateway restart survivable without a pointer file: the thread id
// round-trips through the DB as the session's `claudeSessionId`, which is
// exactly what RuntimeSession.externalSessionId is for.
//
// Auth is codex's own (`codex login`, ~/.codex/auth.json), shared with the
// terminal CLI — so a session here draws on the same ChatGPT plan a human
// `codex` invocation does. Nothing about credentials is configured from the
// dashboard, which is why this backend has no equivalent of Settings → Pi
// Runtime.
//
// See docs/codex-runtime-design.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codex, type CodexOptions, type Thread, type ThreadOptions, type Usage } from '@openai/codex-sdk';
import type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
import { translateCodexEvent, emitNoticeOnce } from './codex-events';
import { installJsonlRepair } from './codex-jsonl-repair';
import { DASHBOARD_URL, ASST_KEY } from '../config';

/** Cumulative token counters, as codex reports them. */
type Totals = { input: number; output: number };

type CodexHandle = RuntimeHandle & {
  thread: Thread;
  /**
   * The thread id as the DB knows it.
   *
   * Separate from the readonly `externalSessionId` because it is learned, not
   * given: a brand-new session has none until codex reports one on the first
   * turn, and this is what says whether that has been stamped back yet.
   */
  stampedThreadId: string | null;
  /**
   * The RESOLVED model this thread object was built for (never null now that a
   * fleet default exists); a change rebuilds it.
   */
  model: string;
  emit: (item: SyncItem) => void;
  /** Set for the duration of a turn; the message queue's gate. */
  working: boolean;
  /** Aborts the in-flight turn. Null between turns. */
  abort: AbortController | null;
  /**
   * Codex's cumulative usage for the whole thread. This is only for the
   * session-total statistic; it must never drive the context bar.
   */
  totals: Totals | null;
  /** Latest model call from the rollout file — what the context bar wants. */
  lastTurn: { contextTokens: number; outputTokens: number } | null;
  /** Cached after the first lookup; a resumed thread keeps appending here. */
  rolloutFile: string | null;
  /** Monotonic per-session turn counter, for turn keys. */
  turnSeq: number;
  /**
   * Non-fatal error notices already shown in the chat. Codex re-emits some of
   * them on every turn (a long thread's heads-up landed 20 times in one
   * session); the set lives on the handle so each distinct text is shown once
   * per gateway process. See emitNoticeOnce in codex-events.ts.
   */
  seenNotices: Set<string>;
};

const live = new Map<string, CodexHandle>();
/** Rollout paths for persisted threads that have no in-memory handle. */
const storedRolloutFiles = new Map<string, string>();

function handleOf(h: RuntimeHandle): CodexHandle | null {
  return live.get(h.sessionId) ?? null;
}

function systemItem(sessionId: string, externalId: string, text: string): SyncItem {
  return { sessionId, role: 'system', content: [{ type: 'text', text }], externalId, claudeSessionId: null };
}

/** Where codex keeps its threads. `CODEX_HOME` relocates the whole directory. */
function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/**
 * How a thread is run. Two of these are load-bearing:
 *
 * - `skipGitRepoCheck`, because `codex exec` refuses to start outside a git
 *   repo and most agent workspaces are not one. Without it every session on a
 *   plain directory dies at the first turn.
 * - the sandbox/approval pair, because there is nobody to answer an approval
 *   prompt. A dashboard session has no TTY: codex would block waiting for an
 *   answer that can never arrive and the turn would hang until it timed out.
 *   `never` + `danger-full-access` is the same posture the claude path takes
 *   with `--dangerously-skip-permissions` (chat-runner.ts) — these are trusted
 *   agents running on the user's own machine, and the fleet's protection is
 *   the workspace boundary, not the model's own restraint.
 *
 * Both sandbox and approval are overridable by env for a machine that wants a
 * tighter posture; the values are passed through untouched so codex validates
 * them rather than this file keeping a copy of its enum.
 */
/**
 * The model a session runs on when it pins none.
 *
 * codex's own default is whatever its config says, which on a fresh machine is
 * the newest model at its default effort — but "whatever the CLI felt like" is
 * not a fleet decision, and a machine with a stale ~/.codex/config.toml would
 * quietly run an older model than the one this was tuned for.
 *
 * gpt-5.6-sol is codex's own priority-1 entry, described in its model catalog
 * as "Latest frontier agentic coding model."
 */
const DEFAULT_MODEL = 'gpt-5.6-sol';

/** codex's reasoning ladder, weakest first. */
const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
type Effort = (typeof EFFORT_LADDER)[number];

/**
 * Reasoning effort when the machine names none.
 *
 * The model's OWN default is `low` — the bottom of that ladder — so a session
 * left alone was running as cheaply as codex offers. `ultra` is the top:
 * "maximum reasoning with automatic task delegation".
 *
 * Neither `max` nor `ultra` is in the SDK's ModelReasoningEffort union, which
 * stops at 'xhigh' — the published types lag the server's catalog. Verified
 * against codex-cli 0.147.0: a turn spawned with 'ultra' is accepted, its
 * rollout records `"effort": "ultra"`, and it emits only item types the
 * translator already understands (agent_message, command_execution,
 * file_change) despite the delegation — so nothing is silently dropped from the
 * chat. The cast where this is applied is therefore load-bearing, not cosmetic.
 */
const DEFAULT_EFFORT: Effort = 'ultra';

/**
 * The highest effort each model actually accepts — longest prefix wins.
 *
 * This is not defensive padding. An unsupported pair is a HARD failure, not a
 * downgrade: `gpt-5.4` with `ultra` dies with "Codex Exec exited with code 1"
 * before the model sees the prompt (measured). Since a session can pin its own
 * `runtimeModel` from the dashboard, a blanket ultra would mean every turn on
 * gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark or gpt-5.6-luna failing —
 * a setting made in one place breaking a session configured in another.
 *
 * Values from codex's own catalog (~/.codex/models_cache.json,
 * supported_reasoning_levels).
 */
const TOP_EFFORT: ReadonlyArray<{ prefix: string; top: Effort }> = [
  // Longest first: 'gpt-5.6-luna' must be found before the 'gpt-5.6' family
  // entry, or the one 5.6 model without ultra would be handed it.
  { prefix: 'gpt-5.3-codex-spark', top: 'xhigh' },
  { prefix: 'gpt-5.6-luna', top: 'max' },
  { prefix: 'gpt-5.6', top: 'ultra' },
  { prefix: 'gpt-5.5', top: 'xhigh' },
  { prefix: 'gpt-5.4', top: 'xhigh' },
  { prefix: 'gpt-5.3', top: 'xhigh' },
];

/** Warned-about pairs, so a clamp is reported once and not every turn. */
const clampWarned = new Set<string>();

/**
 * The requested effort, lowered to what this model supports.
 *
 * A model the table has never heard of is passed through UNCLAMPED. A new
 * frontier model is more likely to support more than less, and guessing low
 * would silently cap it forever; if the guess is wrong the turn fails loudly
 * with codex's own message, which the runtime already surfaces into the chat.
 */
export function clampEffort(effort: string, model: string): string {
  const wanted = EFFORT_LADDER.indexOf(effort as Effort);
  if (wanted < 0) return effort; // not one of ours — let codex judge it
  const id = model.trim().toLowerCase();
  const entry = TOP_EFFORT.find((m) => id.startsWith(m.prefix));
  if (!entry) return effort;
  const cap = EFFORT_LADDER.indexOf(entry.top);
  if (wanted <= cap) return effort;
  const key = `${id}:${effort}`;
  if (!clampWarned.has(key)) {
    clampWarned.add(key);
    console.warn(
      `[codex] ${model} does not support effort "${effort}" (its ceiling is `
      + `"${entry.top}"); using "${entry.top}". An unsupported pair is a hard `
      + 'failure, not a downgrade, so this is lowered rather than attempted.',
    );
  }
  return entry.top;
}

/**
 * Session first (the dashboard's per-session model), then the machine's env,
 * then the fleet default.
 *
 * Shared with ensure(), which compares it against the model a live thread was
 * built for — resolving it in two places could disagree and either rebuild a
 * thread every tick or never rebuild one at all.
 */
export function resolveCodexModel(session: RuntimeSession): string {
  return session.model?.trim() || process.env.HERMIT_CODEX_MODEL?.trim() || DEFAULT_MODEL;
}

function threadOptions(session: RuntimeSession): ThreadOptions {
  const model = resolveCodexModel(session);
  // Clamped even when the env named it explicitly: the alternative to lowering
  // an impossible pair is not "the user gets what they asked for", it is every
  // turn on that session dying before the model reads the prompt.
  const effort = clampEffort(process.env.HERMIT_CODEX_EFFORT?.trim() || DEFAULT_EFFORT, model);
  return {
    workingDirectory: session.agentDirectory,
    skipGitRepoCheck: true,
    sandboxMode: (process.env.HERMIT_CODEX_SANDBOX?.trim() || 'danger-full-access') as ThreadOptions['sandboxMode'],
    approvalPolicy: (process.env.HERMIT_CODEX_APPROVAL?.trim() || 'never') as ThreadOptions['approvalPolicy'],
    model,
    modelReasoningEffort: effort as ThreadOptions['modelReasoningEffort'],
  };
}

/**
 * The hermit MCP stub — the same stdio server the claude path wires in with
 * `--mcp-config`. Resolved here rather than imported from chat-runner, which
 * imports this module transitively (runtime/index) and would make a cycle.
 */
const MCP_STUB_PATH = fileURLToPath(new URL('../mcp-stub.cjs', import.meta.url));

/**
 * Give a codex session hermit's own tools: attach_file, attach_image, ask,
 * set_session_title, log_status, the cron family.
 *
 * Without this a codex session has ONLY the shell and apply_patch, and the
 * failure is not "the tool is missing" — it is the model doing its best without
 * one. Observed on a real session: asked to send a file back, the agent grepped
 * the repo for `attach_file`, read mcp-stub.cjs, checked whether HERMIT_* were
 * in its environment, tried to hand-drive the stub over raw JSON-RPC on stdin,
 * and then told the user "已发你 yubai-preview.html". Nothing was ever sent. A
 * capability the surrounding product assumes, missing from one backend, gets
 * reported to the user as done.
 *
 * codex reads MCP servers from config, so this rides `-c mcp_servers.…` rather
 * than needing anything codex-specific in the stub — verified against
 * codex-cli 0.147.0: the tool shows up as `hermit/attach_file` and its result
 * (including its errors) comes back through the normal item stream, which
 * codex-events already renders as `mcp__hermit__attach_file`.
 */
export function hermitMcpConfigFor(session: RuntimeSession): NonNullable<CodexOptions['config']> {
  return {
    mcp_servers: {
      hermit: {
        command: 'node',
        args: [MCP_STUB_PATH],
        // Codex copies only these named variables from its own process into the
        // MCP child. Names are safe in `--config`; values stay out of argv.
        env_vars: ['HERMIT_SESSION_ID', 'HERMIT_DASHBOARD_URL', 'HERMIT_KEY'],
        // Seconds. `ask` blocks until a human clicks a button in the dashboard,
        // for up to the stub's own 4h ceiling — a default tool timeout would
        // kill it long before, and the user's answer would land on a call that
        // no longer exists. Sits just above that ceiling, same reasoning as the
        // claude path's 14,700,000ms.
        tool_timeout_sec: 14_700,
        startup_timeout_sec: 30,
      },
    },
  };
}

/** Environment for the Codex CLI child. The SDK replaces, rather than merges,
 * process.env when this option is present, so preserve every defined entry. */
export function codexChildEnv(session: RuntimeSession): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[name] = value;
  }
  // The gateway's source credential is never needed by Codex. The MCP receives
  // only the HERMIT_KEY alias below, which its env_vars entry explicitly copies.
  delete env.ASST_KEY;
  env.HERMIT_SESSION_ID = session.id;
  env.HERMIT_DASHBOARD_URL = DASHBOARD_URL;
  env.HERMIT_KEY = ASST_KEY;
  return env;
}

/** Keep the MCP-only key out of ordinary shell tool processes. `exclude` alone
 * is bypassed by a login shell re-reading the user's profile, so both controls
 * are required. env_vars still explicitly copies HERMIT_KEY into the MCP child. */
export function codexShellIsolationConfig(): NonNullable<CodexOptions['config']> {
  return {
    allow_login_shell: false,
    shell_environment_policy: { exclude: ['HERMIT_KEY'] },
  };
}

/**
 * The version of the codex CLI the SDK vendors, for the provider's `version`
 * header below. Read from the SDK's package.json (same release train as the
 * bundled binary); a machine that points HERMIT_CODEX_BIN elsewhere may drift
 * from this, which is tolerable — the header is client identity, not protocol.
 */
function codexSdkVersion(): string | null {
  // Not require.resolve: the SDK's exports map carries only an `import`
  // condition, so a CJS resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED. Walking
  // up to the hoisted node_modules is the boring way that works everywhere.
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const candidate = path.join(dir, 'node_modules', '@openai', 'codex-sdk', 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
        return pkg.version?.trim() || null;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Force the Responses API onto HTTPS/SSE instead of codex's preferred
 * WebSockets transport.
 *
 * The gpt-5.6 model presets ship `prefer_websockets: true` baked into the
 * binary, and upstream offers no plain off switch: the `responses_websockets`
 * feature flag is removed, and overriding the built-in `openai` provider is
 * rejected outright ("Built-in providers cannot be overridden"). On a network
 * where a long-lived wss to chatgpt.com dies mid-turn — macmini003 and
 * dgx-spark, per the dashboard's `[codex stream error]` rows — codex burns 5
 * reconnect attempts before falling back to HTTPS, stalling the turn for
 * minutes. And because this runtime is one `codex exec` per turn, the fallback
 * is never remembered: every turn pays again (measured: 8 turns in one
 * afternoon session, ~6–10 min each).
 *
 * So: a custom provider identical to the built-in ChatGPT one except
 * `supports_websockets = false`. HTTPS/SSE succeeded on every observed
 * fallback, on every machine. Verified against codex-cli 0.147.0:
 * - no websocket is attempted (RUST_LOG=codex_api=debug shows no connect),
 * - ChatGPT auth still applies (auth_mode stays Chatgpt, same plan),
 * - a thread created under the built-in provider resumes cleanly here — the
 *   provider id is per-invocation config, not thread state,
 * - `supports_standalone_web_search` must be restated: a custom provider
 *   defaults it to false, and these sessions lean on WebSearch.
 *
 * A machine whose network handles wss fine can take the default transport
 * back with HERMIT_CODEX_WEBSOCKETS=1.
 */
export function httpsTransportConfig(): NonNullable<CodexOptions['config']> {
  if (process.env.HERMIT_CODEX_WEBSOCKETS?.trim() === '1') return {};
  const version = codexSdkVersion();
  return {
    model_provider: 'openai_https',
    model_providers: {
      openai_https: {
        name: 'OpenAI (HTTPS only)',
        base_url: 'https://chatgpt.com/backend-api/codex',
        wire_api: 'responses',
        requires_openai_auth: true,
        supports_websockets: false,
        supports_standalone_web_search: true,
        // The built-in provider stamps the CLI version header; keep parity so
        // the backend sees the same client identity on either transport.
        ...(version ? { http_headers: { version } } : {}),
      },
    },
  };
}

/** Exported for the test that proves the JSONL repair is actually installed. */
export function client(session: RuntimeSession): Codex {
  const override = process.env.HERMIT_CODEX_BIN?.trim();
  const codex = new Codex({
    ...(override ? { codexPathOverride: override } : {}),
    config: {
      ...hermitMcpConfigFor(session),
      ...httpsTransportConfig(),
      ...codexShellIsolationConfig(),
    },
    env: codexChildEnv(session),
  });
  // The SDK reads codex's JSONL with `readline`, which also breaks on U+2028
  // and U+2029 — legal raw inside a JSON string, and emitted raw by codex. One
  // of them anywhere in a turn's payload used to kill the whole turn with
  // `Failed to parse item:`. See codex-jsonl-repair.ts. The repair drops what it
  // cannot rejoin, so its warnings carry the session — a bare line in a gateway
  // log multiplexing every agent names nobody.
  const tag = `[codex] session=${session.id.slice(0, 8)}`;
  if (!installJsonlRepair(codex, (m) => console.warn(`${tag}: ${m}`))) {
    // Only reachable if a future SDK reshapes the field this reaches into. Say
    // so: the alternative is turns quietly dying on a separator again, with the
    // dependency bump that caused it weeks in the past.
    console.warn(`${tag}: the codex SDK no longer exposes exec.run — a U+2028 in any payload will kill the turn`);
  }
  return codex;
}

/**
 * The rollout file codex is writing for a thread, or null.
 *
 * Codex names it `rollout-<ISO timestamp>-<threadId>.jsonl` under
 * `<CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/`, and a RESUMED thread appends to
 * the original file rather than starting a new one (measured: three turns
 * across two processes, one file). So the search is newest-day-first and stops
 * at the first hit — a thread resumed weeks later is found by walking back, and
 * the common case (today or yesterday) costs two readdirs.
 */
export function findRolloutFile(threadId: string, home = codexHome()): string | null {
  const root = path.join(home, 'sessions');
  const desc = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  for (const y of desc(root)) {
    for (const m of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        let names: string[];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        const hit = names.find((n) => n.includes(threadId) && n.endsWith('.jsonl'));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}

/** How much of a rollout file to read when looking for its last token_count. */
const ROLLOUT_TAIL_BYTES = 256 * 1024;

/**
 * The last token accounting codex wrote for a thread.
 *
 * Read on every session-snapshot tick for a live handle, and as durable fallback
 * after a gateway restart. The SDK's turn usage is cumulative spend across all
 * model calls; only this file exposes the latest call's actual window occupancy.
 *
 * The file is a JSONL and only its tail is read: a long conversation's rollout
 * runs to megabytes and this is on the session-snapshot tick.
 */
export function readRolloutTokens(
  file: string,
): { total: Totals; lastTurn: { contextTokens: number; outputTokens: number } | null } | null {
  let buf: Buffer;
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(Math.min(size, ROLLOUT_TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = buf.toString('utf8').split('\n');
  // Backwards: the last token_count is the current state of the thread.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes('"token_count"')) continue;
    let info: {
      total_token_usage?: Record<string, number>;
      last_token_usage?: Record<string, number>;
    } | undefined;
    try {
      info = (JSON.parse(line) as { payload?: { info?: typeof info } })?.payload?.info;
    } catch {
      continue; // a truncated first line from the tail cut, or a shape we do not know
    }
    const total = info?.total_token_usage;
    const last = info?.last_token_usage;
    if (!total) continue;
    const parsedTotal = {
      input: Number(total.input_tokens ?? 0),
      output: Number(total.output_tokens ?? 0),
    };
    // Older rollout formats may only have the cumulative total. That is still
    // useful for session statistics, but it cannot truthfully answer how full
    // the window is; null is safer than turning cumulative spend into context.
    if (!last) return { total: parsedTotal, lastTurn: null };
    const lastInput = Number(last?.input_tokens ?? 0);
    const lastOutput = Number(last?.output_tokens ?? 0);
    const lastTotal = Number(last?.total_tokens ?? 0);
    return {
      total: parsedTotal,
      lastTurn: {
        // During automatic compaction codex briefly records input/output as 0
        // while total_tokens carries the compacted context size. Preserve that
        // useful reading instead of flashing the dashboard down to zero.
        contextTokens: lastInput > 0 ? lastInput : Math.max(0, lastTotal - lastOutput),
        outputTokens: lastOutput,
      },
    };
  }
  return null;
}

/** Read a persisted thread without constructing a live SDK handle. */
function readStoredRollout(threadId: string) {
  const cacheKey = `${codexHome()}\0${threadId}`;
  let file = storedRolloutFiles.get(cacheKey) ?? null;
  let current = file ? readRolloutTokens(file) : null;
  if (!current) {
    file = findRolloutFile(threadId);
    if (!file) return null;
    storedRolloutFiles.set(cacheKey, file);
    current = readRolloutTokens(file);
  }
  return current;
}

/** Cumulative thread totals reported by the SDK at turn completion. */
function totalsFromTurn(usage: Usage | null | undefined): Totals | null {
  if (!usage) return null;
  return {
    input: Number(usage.input_tokens ?? 0),
    output: Number(usage.output_tokens ?? 0),
  };
}

/**
 * Refresh the current-window reading from codex's own rollout.
 *
 * One dashboard "turn" can contain dozens of model calls around tools. The
 * SDK's turn-completed input delta is the SUM of all those calls (803,673 in a
 * measured turn whose final prompt was 26,630), so it is spend, not context
 * occupancy. `last_token_usage` is the authoritative latest model call and is
 * also available while the turn is still running.
 */
function refreshRolloutUsage(h: CodexHandle): boolean {
  const threadId = h.stampedThreadId?.trim() || h.externalSessionId.trim();
  if (!threadId) return false;
  if (!h.rolloutFile) h.rolloutFile = findRolloutFile(threadId);
  const current = h.rolloutFile ? readRolloutTokens(h.rolloutFile) : null;
  if (!current) return false;
  // Both sources are cumulative, but the rollout append and SDK completion
  // event are observed on different clocks. Never let a slightly older file
  // tail move the session total backwards for one snapshot.
  h.totals = {
    input: Math.max(h.totals?.input ?? 0, current.total.input),
    output: Math.max(h.totals?.output ?? 0, current.total.output),
  };
  h.lastTurn = current.lastTurn;
  return true;
}

export class CodexExecRuntime implements AgentRuntime {
  readonly kind = 'codex-exec' as const;

  async ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle> {
    const existing = live.get(session.id);
    const model = resolveCodexModel(session);
    if (existing) {
      // The model is baked into the Thread's options, so a switch needs a new
      // Thread object — but NOT a new conversation: it is rebuilt below with
      // resumeThread on the same id, so the history carries over. Never done
      // mid-turn; the running turn belongs to the old model and finishes on it.
      if (existing.model === model || existing.working) return existing;
      live.delete(session.id);
    }

    const codex = client(session);
    const opts = threadOptions(session);

    // `externalSessionId` (the DB's `claudeSessionId`) is ONE slot shared by
    // every backend, so a session switched here from claude or pi arrives still
    // holding THAT backend's id. Handing it to resumeThread makes codex answer
    // `thread/resume: no rollout found` — and because a foreign id never
    // becomes valid, every retry fails identically and the session is bricked
    // (measured: a claude uuid survived the switch and the chat went dead).
    // The rollout lookup was already happening two lines down to seed the token
    // counters; doing it FIRST makes it the resume guard too, at no extra cost.
    // No rollout means no thread to resume — start a fresh one, the same
    // self-healing the tmux path does when a recorded transcript is gone.
    const recordedId = session.externalSessionId?.trim() || null;
    const rolloutFile = recordedId ? findRolloutFile(recordedId) : null;
    const threadId = rolloutFile ? recordedId : null;
    if (recordedId && !threadId) {
      // Loud, because the other way to get here is a codex thread whose rollout
      // was deleted — same recovery, but real history was just dropped.
      console.warn(
        `[codex] session=${session.id.slice(0, 8)}: no rollout for recorded thread ` +
        `${recordedId.slice(0, 8)} — starting a fresh thread`,
      );
    }
    const thread = threadId ? codex.resumeThread(threadId, opts) : codex.startThread(opts);

    // Seed both cumulative statistics and current-window occupancy from codex's
    // own file so a gateway restart does not blank or inflate the context bar.
    let totals: Totals | null = null;
    let lastTurn: { contextTokens: number; outputTokens: number } | null = null;
    if (rolloutFile) {
      const seeded = readRolloutTokens(rolloutFile);
      if (seeded) {
        totals = seeded.total;
        lastTurn = seeded.lastTurn;
      }
    }

    const handle: CodexHandle = {
      sessionId: session.id,
      externalSessionId: threadId ?? '',
      thread,
      stampedThreadId: threadId,
      model,
      emit,
      working: false,
      abort: null,
      totals,
      lastTurn,
      rolloutFile,
      turnSeq: 0,
      seenNotices: new Set(),
    };
    live.set(session.id, handle);
    return handle;
  }

  async submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    if (h.working) return false; // chat-runner gates on isWorking, but a racing tick must not double-submit

    const input = images.length > 0
      ? [
          { type: 'text' as const, text },
          ...images.map((i) => ({ type: 'local_image' as const, path: i.path })),
        ]
      : text;

    // Unique per turn and stable for its duration — the ids codex hands out are
    // per-turn ordinals, see codex-events.ts. The random suffix matters because
    // turnSeq restarts at 0 when the gateway does, and a resumed session's
    // "turn 0" would otherwise collide with the rows of the original turn 0.
    const turnKey = `${h.sessionId}:${h.turnSeq}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    h.turnSeq += 1;

    const abort = new AbortController();
    h.abort = abort;
    h.working = true;

    let stream: Awaited<ReturnType<Thread['runStreamed']>>;
    try {
      stream = await h.thread.runStreamed(input, { signal: abort.signal });
    } catch (e) {
      // Failed before the turn began — codex missing, not logged in, a thread
      // id it will not resume. Report it and leave the row un-acked so the next
      // tick retries rather than losing the user's message.
      h.working = false;
      h.abort = null;
      this.report(h, turnKey, e);
      return false;
    }

    // Consume in the background: chat-runner's tick must not block for the
    // length of a turn, and it already polls isWorking() to know when this ends.
    void (async () => {
      try {
        for await (const ev of stream.events) {
          if (ev.type === 'thread.started' && ev.thread_id) {
            // Stamp the thread id onto the session row so a gateway restart can
            // resume it. Emitted on EVERY turn, not just the first (measured),
            // and the sync route only writes when it differs — so this is
            // idempotent and also self-heals a session whose id drifted.
            if (ev.thread_id !== h.stampedThreadId) {
              h.stampedThreadId = ev.thread_id;
              h.rolloutFile = null;
              h.totals = null;
              h.lastTurn = null;
              h.emit({
                sessionId: h.sessionId,
                role: 'system',
                content: [{ type: 'text', text: `[codex thread ${ev.thread_id.slice(0, 8)}]` }],
                externalId: `${turnKey}:thread`,
                claudeSessionId: ev.thread_id,
              });
            }
            continue;
          }
          if (ev.type === 'turn.completed') {
            // The SDK value is cumulative spend. Keep it for totalTokens, then
            // replace it with the rollout's authoritative latest-call reading.
            h.totals = totalsFromTurn(ev.usage) ?? h.totals;
            refreshRolloutUsage(h);
            continue;
          }
          for (const item of translateCodexEvent(ev, turnKey)) {
            if (!emitNoticeOnce(h.seenNotices, item)) {
              // Say WHICH notice was swallowed — a bare "suppressed" line N
              // times over is impossible to forensically distinguish.
              const text = (item.content as Array<{ text?: unknown }>)[0]?.text;
              console.log(
                `[codex] session=${h.sessionId.slice(0, 8)} repeated notice suppressed: ${
                  String(text ?? '').split('\n')[1]?.slice(0, 80) ?? ''
                }`,
              );
              continue;
            }
            h.emit({ ...item, sessionId: h.sessionId, claudeSessionId: null });
          }
        }
      } catch (e) {
        // An abort lands here as a rejection; it is a user action, not a fault.
        if (abort.signal.aborted) {
          h.emit(systemItem(h.sessionId, `${turnKey}:interrupted`, '[turn interrupted]'));
        } else {
          this.report(h, turnKey, e);
        }
      } finally {
        h.working = false;
        if (h.abort === abort) h.abort = null;
      }
    })();

    return true;
  }

  /** Put a failure in the chat. Silence here reads as the agent ignoring you. */
  private report(h: CodexHandle, turnKey: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[codex] session=${h.sessionId.slice(0, 8)} turn failed:`, message);
    h.emit(systemItem(
      h.sessionId,
      `${turnKey}:error`,
      `[codex could not run this turn]\n${message.slice(0, 800)}`,
    ));
  }

  async isWorking(handle: RuntimeHandle): Promise<boolean> {
    return handleOf(handle)?.working ?? false;
  }

  /** A live child for this session — true before any rollout exists, unlike usage(). */
  async isLive(handle: RuntimeHandle): Promise<boolean> {
    return handleOf(handle) !== null;
  }

  async interrupt(handle: RuntimeHandle): Promise<void> {
    const h = handleOf(handle);
    if (!h?.abort) return;
    h.abort.abort();
  }

  async compact(handle: RuntimeHandle, instructions?: string): Promise<void> {
    void instructions;
    const h = handleOf(handle);
    if (!h) return;
    // Codex compacts its own thread when the window fills and exposes no way to
    // ask for one. Saying so is better than a silent no-op: /compact appearing
    // to do nothing is indistinguishable, from the chat, from a wedged session.
    h.emit(systemItem(
      h.sessionId,
      `${h.sessionId}:compact-${Date.now()}`,
      '[codex manages its own context window — there is nothing to compact by hand]',
    ));
  }

  async usage(handle: RuntimeHandle): Promise<RuntimeUsage | null> {
    const h = handleOf(handle);
    if (!h) return null;
    // Session snapshots call this every 8s, including while a tool-heavy turn
    // is running. Reading the bounded tail keeps the context bar live instead
    // of showing the previous completed turn until this one finishes.
    refreshRolloutUsage(h);
    if (!h.totals && !h.lastTurn) return null;
    return {
      contextTokens: h.lastTurn?.contextTokens ?? null,
      outputTokens: h.lastTurn?.outputTokens ?? null,
      totalTokens: (h.totals?.input ?? 0) + (h.totals?.output ?? 0),
      // No per-token price to apply: these turns bill against the ChatGPT plan
      // behind `codex login`, and reporting a computed dollar figure would put
      // a number in the cost column that nobody is charged.
      costUsd: null,
    };
  }

  async storedUsage(handle: RuntimeHandle): Promise<RuntimeUsage | null> {
    const threadId = handle.externalSessionId.trim();
    if (!threadId) return null;
    const stored = readStoredRollout(threadId);
    if (!stored) return null;
    return {
      contextTokens: stored.lastTurn?.contextTokens ?? null,
      outputTokens: stored.lastTurn?.outputTokens ?? null,
      totalTokens: stored.total.input + stored.total.output,
      costUsd: null,
    };
  }

  async stop(handle: RuntimeHandle, mode: 'hibernate' | 'kill'): Promise<void> {
    const h = live.get(handle.sessionId);
    if (!h) return;
    live.delete(handle.sessionId);
    h.abort?.abort();
    // Both modes keep the thread: the conversation lives in codex's own store
    // and the id is on the session row, so the next message resumes it. `kill`
    // is chat-runner's restart button — "unwedge this", not "forget this".
    void mode;
  }
}

/**
 * Run ONE self-contained codex turn and return its final text — the cron path.
 *
 * Why this lives here and not in cron-runner: `threadOptions()` and `client()`
 * are where model / effort / sandbox / approval / the hermit MCP wiring get
 * decided. Rebuilding that in the caller would work today and drift the first
 * time any of it changes, and the drift would be invisible — a cron quietly
 * running under different settings than the chat sessions it reports into.
 *
 * Always a FRESH thread: a cron fire is a scheduled task, not a conversation. It
 * must not inherit — or grow — the report session's history.
 *
 * Returns the last `agent_message` seen. Empty string means the turn produced no
 * final text, which the caller reports as `no_output` exactly like the claude
 * path. Throws on transport/quota failure so the caller can mark `error` and
 * surface the real message — a codex usage-limit rejection MUST NOT be flattened
 * into "timeout", which is precisely what hid a 6-hour outage on 2026-08-15.
 */
export async function runCodexCronTurn(
  opts: { agentName: string; cwd: string; prompt: string; signal?: AbortSignal },
): Promise<string> {
  const session: RuntimeSession = {
    id: `cron:${opts.agentName}`,
    agentName: opts.agentName,
    agentDirectory: opts.cwd,
    externalSessionId: null,
  };
  const codex = client(session);
  const thread = codex.startThread(threadOptions(session));
  const stream = await thread.runStreamed(opts.prompt, opts.signal ? { signal: opts.signal } : undefined);

  let lastText = '';
  // `.events` — a StreamedTurn is not itself async-iterable (the chat path at
  // line ~550 iterates the same way).
  for await (const ev of stream.events) {
    const anyEv = ev as { type?: string; item?: { type?: string; text?: string }; error?: { message?: string } };
    // codex reports a refused turn (quota, auth) as a completed turn carrying an
    // error rather than by throwing — surface it instead of returning "".
    if (anyEv.error?.message) throw new Error(anyEv.error.message);
    if (anyEv.item?.type === 'agent_message' && typeof anyEv.item.text === 'string') {
      lastText = anyEv.item.text;
    }
  }
  return lastText.trim();
}
