// kimi-code backend: Moonshot's Kimi Code CLI driven one subprocess per turn.
//
// Codex's and dsh's shape, not pi's: there is no long-lived child. Each turn
// spawns `kimi -p <text> --output-format stream-json`, which runs to completion
// and exits. The conversation lives in kimi's own store
// (`$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl`),
// so "the session" here is a kimi session id plus what we remember about the
// last turn — and the id rides the DB's `claudeSessionId` column, which is
// exactly what RuntimeSession.externalSessionId is for.
//
// ── auth, and why nothing lands on disk ─────────────────────────────────────
//
// The CLI does NOT read `KIMI_API_KEY` from the shell; its own docs say so
// three times. Credentials normally live in `~/.kimi-code/config.toml`, either
// as a plaintext `api_key` or as an OAuth token the device-code login writes —
// and writing the fleet's key into a config file is exactly what every other
// backend here avoids.
//
// There is one documented exception and this backend is built on it. Setting
// `KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY` synthesises an in-memory provider
// (`__kimi_env__`) and model alias (`__kimi_env_model__`), sets `defaultModel`
// to that alias, and writes NOTHING back: the overlay is applied to the
// effective config only, and stripped from every write path. Measured against
// 0.38.0 with a fresh empty KIMI_CODE_HOME — the run answers and no
// `config.toml` is created at all.
//
// Two consequences of that mechanism, both load-bearing:
//   · Do NOT pass `--model`. The env overlay already pinned `defaultModel`, and
//     `-m` takes an exact key from the `[models]` table — which is empty here,
//     so any `-m` value fails with `Model "…" is not configured in config.toml`.
//     The model is chosen by KIMI_MODEL_NAME instead.
//   · A model change between turns needs no restart: the next child is spawned
//     with a different KIMI_MODEL_NAME and resumes the same session id.
//
// ── permissions ─────────────────────────────────────────────────────────────
//
// `-p` cannot be combined with `--yolo`, `--auto` or `--plan`; the CLI rejects
// the combination at startup. It does not need them: print mode installs an
// approval handler that returns `approved` and a question handler that returns
// null, so a headless run can never block on a prompt. Static `[[permission]]`
// deny rules in a config.toml still apply — there is no config.toml here, so
// there are none.
//
// See docs/kimi-code-runtime-design.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
import { KimiEventTranslator, parseKimiLine, resumeHintId } from './kimi-code-events';
import { readLfLines } from './lf-lines';
import { chatOnlyPreamble } from './chat-only';
import { readSecret } from './pi-credentials';
import { getCredential, credentialDefaultModel, type ModelCredential } from '../pi-config';
import { modelLimitsFor } from '../pi-model-limits';
import { MCP_STUB_PATH } from '../mcp-config';
import { ASST_KEY, DASHBOARD_URL } from '../config';

/** Cumulative token counters, on the same basis as codex's and dsh's. */
export type KimiTotals = {
  /** Billed input across the session: uncached + cache reads + cache creation. */
  input: number;
  output: number;
  /** Live window occupancy — the latest `token_counting.measured`. */
  contextTokens: number | null;
  /** The latest model call's output, same basis as contextTokens. */
  lastOutput: number | null;
};

type KimiHandle = RuntimeHandle & {
  /** The kimi session id as the DB knows it; learned from the resume hint. */
  stampedSessionId: string | null;
  emit: (item: SyncItem) => void;
  /**
   * Where and what to spawn — refreshed on every ensure(), which chat-runner
   * calls just before each submit, so a model pin changed from the dashboard
   * lands on the very next turn with nothing to rebuild.
   */
  agentDirectory: string;
  modelPin: string | null;
  credentialId: string | null;
  /** Pure-chat: bind a read-only agent profile on the first turn. */
  chatOnly: boolean;
  /** Mount the hermit MCP tool surface (false on a cron fire). */
  hermitTools: boolean;
  /** Orchestrator session: the stub's brain-only tools come along. */
  isOrchestrator: boolean;
  /** Set for the duration of a turn; the message queue's gate. */
  working: boolean;
  /** The in-flight turn's child. Null between turns. */
  child: ChildProcess | null;
  /** True once interrupt() fired for the current turn. */
  interrupted: boolean;
  totals: KimiTotals | null;
  /** Bytes of wire.jsonl already accounted for — see refreshUsage(). */
  wireOffset: number;
  /**
   * Which session's log `wireOffset` and `totals` describe.
   *
   * Not the same as `stampedSessionId`, and that is the point: resuming an id
   * kimi no longer has starts a NEW session, and its log is a different file
   * whose bytes this offset means nothing about. Without this the first turn of
   * the new session would be scanned from the old one's offset — its opening
   * records skipped for good, the old session's totals carried on top, and the
   * number wrong from then on with nothing to show for it.
   */
  wireSessionId: string | null;
};

const live = new Map<string, KimiHandle>();

/**
 * What storedUsage() has already read, per kimi session id.
 *
 * Keyed on kimi's id rather than the chat session's, because that is what
 * identifies the log. Entries are dropped when a session is stopped; one that
 * outlives its chat costs four numbers and a path.
 */
const storedScans = new Map<string, { file: string; offset: number; totals: KimiTotals }>();

/** Test seam. */
export function resetKimiStoredScans(): void {
  storedScans.clear();
}

function handleOf(h: RuntimeHandle): KimiHandle | null {
  return live.get(h.sessionId) ?? null;
}

function systemItem(sessionId: string, externalId: string, text: string): SyncItem {
  return { sessionId, role: 'system', content: [{ type: 'text', text }], externalId, claudeSessionId: null };
}

/** kimi's own id shape, `session_<uuid>` — see ensure() on why this is checked. */
const KIMI_SESSION_ID = /^session_[0-9a-f]{8}-[0-9a-f-]{20,}$/i;

/**
 * A turn that shows no sign of life for this long is wedged.
 *
 * The model call inside kimi has its own retry machinery (it reports each
 * attempt as `turn.step.retrying`), so silence this long means the process is
 * stuck rather than thinking. Same value and same reasoning as dsh's — but
 * "silence" is stdout AND the session's log tree: an AgentSwarm turn is
 * legitimately mute on stdout for its whole run (see wireQuietMs), so the
 * watchdog only kills when both have been quiet this long.
 */
const TURN_SILENCE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Above this, the prompt travels by file instead of on argv.
 *
 * The CLI takes its prompt as a FLAG argument and reads nothing from stdin, so
 * argv is the only channel — and argv is both size-limited (ARG_MAX is 1 MiB on
 * macOS, and the environment shares that budget) and visible in `ps` to the
 * user running the gateway. A pasted document is an ordinary chat message here,
 * so anything large is written to a 0600 temp file and the model is pointed at
 * it. Well under ARG_MAX so the env has room.
 */
const ARGV_PROMPT_LIMIT = 96 * 1024;

// ── configuration ───────────────────────────────────────────────────────────

/**
 * Where kimi keeps its sessions. `KIMI_CODE_HOME` relocates the whole tree.
 *
 * Shared with the human's own `kimi` runs by default, exactly as codex shares
 * `~/.codex` — one machine, one store, one `kimi -r <id>` that works from a
 * terminal too. `HERMIT_KIMI_HOME` splits them for a machine that wants that.
 */
export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERMIT_KIMI_HOME?.trim()
    || env.KIMI_CODE_HOME?.trim()
    || path.join(os.homedir(), '.kimi-code');
}

/**
 * The `kimi` binary.
 *
 * PATH is searched rather than assumed: the official installer
 * (`code.kimi.com/kimi-code/install.sh`) drops a self-contained binary in
 * `~/.local/bin`, while `npm i -g` puts a shim wherever that npm prefix is —
 * `/opt/homebrew/bin` on this fleet. A gateway started by launchd has neither
 * on its PATH, so the well-known locations are checked too.
 */
export function kimiFallbackPaths(home: string = os.homedir()): string[] {
  return [path.join(home, '.local', 'bin', 'kimi'), '/opt/homebrew/bin/kimi', '/usr/local/bin/kimi'];
}

export function resolveKimiCommand(
  env: NodeJS.ProcessEnv = process.env,
  // A parameter so a test can ask what an unequipped machine answers; the
  // production callers never pass it.
  fallbacks: string[] = kimiFallbackPaths(),
): string | null {
  const override = env.HERMIT_KIMI_BIN?.trim();
  if (override) return override;

  const candidates = [
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'kimi')),
    ...fallbacks,
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * The credential's wire protocol, in kimi's vocabulary.
 *
 * kimi's own `type: "kimi"` is deliberately NOT produced. It speaks OpenAI
 * chat-completions and appends `/chat/completions` to the base URL, so the
 * fleet's stored `https://api.kimi.com/coding` 404s under it (measured) while
 * the same URL answers under `anthropic`. Mapping from the credential's `api`
 * instead keeps ONE credential serving claude-sdk and this backend identically
 * — which is the whole point of Settings → Models.
 */
export function kimiProviderType(api: string | null | undefined): string {
  switch ((api ?? '').trim() || 'anthropic-messages') {
    case 'openai-completions': return 'openai';
    case 'openai-responses': return 'openai_responses';
    default: return 'anthropic';
  }
}

/**
 * Variables that must NOT survive into the child.
 *
 * With no `KIMI_MODEL_BASE_URL` set, the CLI resolves the endpoint through the
 * provider definition's env names — so a stray `ANTHROPIC_BASE_URL` in the
 * gateway's own environment would silently redirect a Kimi session somewhere
 * else. The keys are deleted for the same reason claude-credentials deletes
 * ANTHROPIC_API_KEY: two spellings of one slot is an ambiguity nobody can see.
 */
export const CONFLICTING_KIMI_VARS = [
  'KIMI_API_KEY', 'KIMI_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
] as const;

/**
 * Variables stripped for a reason that has nothing to do with Kimi.
 *
 * `ASST_KEY` is the gateway's own dashboard credential, and the gateway's
 * environment is the child's by default — so without this, `echo $ASST_KEY`
 * inside the agent's Bash tool prints the machine's key. On a session with the
 * hermit tool surface the same value rides HERMIT_KEY instead (the stub reads
 * that name), matching the exposure the claude-sdk path has always had; the
 * ASST_KEY spelling stays deleted so nothing depends on which name leaked.
 * codex deletes the same variable for the same reason (codex-exec.ts →
 * codexChildEnv).
 */
export const GATEWAY_ONLY_VARS = ['ASST_KEY'] as const;

/**
 * The env that points one kimi child at one credential and one model.
 *
 * Pure, so the mapping is testable without a secret store or a database.
 * Returns `{}` when there is nothing usable to point at — the caller reports
 * that rather than spawning a child that fails at its own auth gate.
 *
 * A base URL is REQUIRED, unlike for dsh, where a blank one legitimately means
 * "the harness supplies its own catalog". Blank here does not mean nothing: the
 * CLI would resolve the endpoint from the provider definition's default, which
 * for the anthropic protocol is api.anthropic.com — i.e. a blank field would
 * quietly post a Moonshot key to Anthropic.
 */
export function kimiSpawnEnv(
  credential: ModelCredential | null | undefined,
  apiKey: string | null,
  model: string | null | undefined,
): Record<string, string> {
  const id = model?.trim() || credentialDefaultModel(credential) || '';
  const baseUrl = credential?.baseUrl?.trim() || '';
  if (!apiKey || !id || !baseUrl) return {};

  const env: Record<string, string> = {
    KIMI_MODEL_BASE_URL: baseUrl,
    KIMI_MODEL_NAME: id,
    KIMI_MODEL_API_KEY: apiKey,
    KIMI_MODEL_PROVIDER_TYPE: kimiProviderType(credential?.api),
    // Reason as hard as the model allows, matching what the claude-sdk backend
    // asks of the same endpoint. K3 cannot turn thinking off, so the only
    // question is how much of it we ask for.
    KIMI_MODEL_THINKING_EFFORT: 'max',
    // Telemetry is on by default and this session is not the human's.
    KIMI_DISABLE_TELEMETRY: '1',
  };

  // Without this the CLI assumes 262144 for every env-configured model, and a
  // k3 session would compact at a quarter of its real window. The credential's
  // own modelLimits win; the shared family table is the fallback.
  const limits = modelLimitsFor(id, credential?.modelLimits);
  if (limits.contextWindow) env.KIMI_MODEL_MAX_CONTEXT_SIZE = String(limits.contextWindow);
  // maxOutputSize is read on the anthropic protocol only; setting it elsewhere
  // is ignored, which is worse than not setting it because it reads as applied.
  if (limits.maxTokens && env.KIMI_MODEL_PROVIDER_TYPE === 'anthropic') {
    env.KIMI_MODEL_MAX_OUTPUT_SIZE = String(limits.maxTokens);
  }

  return env;
}

/**
 * Did this turn FAIL, given how the child exited?
 *
 * How the child exited is the only honest signal, and it comes in two halves.
 * Node reports a normal exit as `(code, null)` and a signal death as
 * `(null, 'SIGKILL')` — so a function that looks only at `code` calls every
 * signal death a success. That is not hypothetical here: the silence watchdog
 * kills a wedged turn with SIGKILL, and reading only `code` would end that turn
 * with no note at all, the session flipping from working to idle with nothing
 * to explain it.
 *
 * An earlier version asked "did we see any output" instead, which was wrong for
 * a third reason: the CLI writes `{"role":"meta","type":"system.version"}`
 * before it does anything else, so a run that then dies on `provider … has no
 * credential configured` HAS produced output, and the failure would have
 * reached the user as an empty reply. Measured, not theorised.
 *
 * `/goal` is the one non-zero exit that is not a failure: goal mode reports its
 * terminal state through the code (3 = blocked, 6 = paused, 0 = complete), and
 * a user can type `/goal …` into an ordinary chat.
 */
export function turnFailed(
  code: number | null,
  signal: NodeJS.Signals | null,
  interrupted: boolean,
  goalTurn: boolean,
): boolean {
  // interrupt() already puts its own note in the chat; a second one would give
  // one stop button two contradictory answers.
  if (interrupted) return false;
  if (signal) return true;
  if (code === 0 || code === null) return false;
  return !(goalTurn && (code === 3 || code === 6));
}

/** Does this prompt put the CLI into goal mode? Mirrors its own GOAL_PREFIX. */
export function isGoalPrompt(text: string): boolean {
  return /^\s*\/goal(\s|$)/.test(text);
}

/**
 * The argv for one turn. `--model` is deliberately absent — see the header.
 *
 * `addDirs` widens the workspace. Only the oversized-prompt path uses it, and
 * it has to: the agent's tools are scoped to its workspace, so a prompt parked
 * in a temp file would be refused by the Read that was told to fetch it.
 */
export function kimiArgs(
  prompt: string,
  resumeId: string | null,
  addDirs: string[] = [],
  agentFile: string | null = null,
): string[] {
  return [
    ...(resumeId ? ['-r', resumeId] : []),
    // `--agent-file` binds a tool profile AT SESSION CREATION and kimi restores
    // it automatically on every later resume — which is why it may only be
    // passed when there is no `-r`: the CLI rejects the combination outright
    // (OptionConflictError). One-shot flag, permanent effect.
    ...(!resumeId && agentFile ? ['--agent-file', agentFile] : []),
    ...addDirs.flatMap((d) => ['--add-dir', d]),
    '--output-format', 'stream-json',
    '-p', prompt,
  ];
}

/**
 * The pure-chat agent profile, written into KIMI_CODE_HOME on demand.
 *
 * kimi is the one backend whose tool surface is 100% its own — the gateway
 * injects no MCP server and no extension — so the only way in is kimi's own
 * agent-profile format. Tool names were read out of the installed CLI rather
 * than guessed: Read / Write / Edit / Bash / Glob / Grep / Task / WebFetch /
 * WebSearch.
 *
 * Belt AND braces on purpose: `tools` is the allowlist that should do the work,
 * `disallowedTools` repeats the denial. If the allowlist key were ever renamed
 * upstream, an unknown key is ignored silently and the session would come back
 * fully armed — the denylist means such a drift costs a tool, not the mode.
 *
 * The body carries the same preamble every other backend appends to its system
 * prompt — kimi has no --append-system-prompt, and this profile is the only
 * place a pure-chat kimi session can be told who it is. Without it the child
 * falls back to reading its operating files one at a time, which is a round
 * trip per file and, with no Bash, the only route it has left.
 *
 * The content therefore varies per agent (their CHAT.md differs), so the file
 * is keyed by the agent directory rather than shared: one home serves every
 * agent on the machine.
 */
export function chatOnlyAgentFile(agentDirectory: string, home: string = kimiHome()): string {
  const key = createHash('sha1').update(agentDirectory).digest('hex').slice(0, 10);
  const file = path.join(home, `hermit-chat-only-${key}.md`);
  const body = [
    '---',
    'name: hermit-chat-only',
    'description: Pure-chat session — look and discuss, never modify.',
    // The allowlist gates MCP tools by their qualified names too, so the
    // read-only half of the hermit surface (everything but the cron mutations,
    // which the stub itself drops under HERMIT_CHAT_ONLY) stays reachable —
    // memory_write included, the mode's only route to disk. Binds at session
    // creation: a pure-chat session created before this list existed keeps the
    // profile it was created with.
    'tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "mcp__hermit__set_session_title", "mcp__hermit__log_status", "mcp__hermit__attach_image", "mcp__hermit__attach_file", "mcp__hermit__ask", "mcp__hermit__cron_list", "mcp__hermit__memory_write"]',
    'disallowedTools: ["Write", "Edit", "Bash", "Task", "mcp__hermit__cron_create", "mcp__hermit__cron_update", "mcp__hermit__cron_delete"]',
    '---',
    '',
    chatOnlyPreamble(agentDirectory),
    '',
  ].join('\n');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

// ── the hermit tool surface, mounted through kimi's own MCP ────────────────

/**
 * The hermit server entry in kimi's user-global mcp.json.
 *
 * No `env` block ON PURPOSE: kimi spawns a stdio MCP server with its own whole
 * environment plus the config's overlay (mergeStdioEnv — measured, not assumed),
 * so the HERMIT_SESSION_ID / HERMIT_KEY / HERMIT_DASHBOARD_URL the gateway sets
 * on the kimi child reach the stub untouched. Writing the machine key into this
 * file would put it at rest in plaintext; inheriting keeps it in memory only.
 * The corollary: the human's own interactive `kimi` loads this entry too, gets
 * a stub with no HERMIT_SESSION_ID, and that stub serves zero tools — connected
 * and invisible, never an error.
 *
 * toolTimeoutMs sits just ABOVE the stub's 4h ask ceiling (the same 4h5m the
 * claude path uses) so a question left unanswered for hours returns the stub's
 * clean "timed out" answer instead of kimi force-killing the tool call.
 */
const HERMIT_MCP_ENTRY = {
  transport: 'stdio',
  command: 'node',
  args: [MCP_STUB_PATH],
  toolTimeoutMs: 14_700_000,
} as const;

/**
 * Declare the hermit server in `<home>/mcp.json`, preserving everything else.
 *
 * kimi has no `--mcp-config` flag and no config env var; the user-global file
 * is the one location that loads without a workspace-trust gate (project-local
 * files wait for a trust prompt that a headless turn can never answer —
 * measured 2026-09-01). The write is atomic and skipped when the entry is
 * already current, so the per-turn cost is one read. A file that does not
 * parse is the human's own: warn and run WITHOUT the tool surface rather than
 * clobber it.
 */
export function ensureHermitMcpConfig(home: string = kimiHome()): void {
  const file = path.join(home, 'mcp.json');
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('top level is not an object');
    data = parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[kimi] ${file} exists but does not parse (${(e as Error).message}) — leaving it alone; no hermit tools this turn`,
      );
      return;
    }
  }
  const servers = (data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
    ? data.mcpServers
    : {}) as Record<string, unknown>;
  if (JSON.stringify(servers.hermit) === JSON.stringify(HERMIT_MCP_ENTRY)) return;
  const next = { ...data, mcpServers: { ...servers, hermit: HERMIT_MCP_ENTRY } };
  // Atomic: a concurrent turn reading a half-written file would fail its MCP
  // load — and a failed MCP load must never be what a turn dies of.
  fs.mkdirSync(home, { recursive: true });
  const tmp = path.join(home, `.mcp.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// ── usage, read back out of kimi's own session log ──────────────────────────

/**
 * Where a session's event log lives.
 *
 * Found through `session_index.jsonl` rather than by rebuilding the directory
 * name: that name is `wd_<slug>_<first 12 of sha256 of the work dir>`, and
 * reproducing a hash the CLI computes is the kind of coupling that breaks
 * silently on the day they change the slug rule. The index is one line per
 * session and the CLI maintains it.
 */
export function wireFileFor(home: string, sessionId: string): string | null {
  const dir = sessionDirFor(home, sessionId);
  return dir ? path.join(dir, 'agents', 'main', 'wire.jsonl') : null;
}

/** The session's directory, looked up the same way. */
export function sessionDirFor(home: string, sessionId: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8');
  } catch {
    return null;
  }
  // Last match wins: a forked or re-created id appends rather than rewrites.
  let dir: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.includes(sessionId)) continue;
    try {
      const row = JSON.parse(line) as { sessionId?: string; sessionDir?: string };
      if (row.sessionId === sessionId && row.sessionDir) dir = row.sessionDir;
    } catch {
      // a truncated tail line; the next full one wins
    }
  }
  return dir;
}

/**
 * How long the session's log tree has been quiet, in ms — or null when there
 * is no tree to ask (no id learned yet, index missing, dir unreadable).
 *
 * This is the watchdog's second opinion. Stdout goes silent for the whole
 * length of an AgentSwarm call: subagents log to their own
 * `agents/agent-N/wire.jsonl`, and the main agent's step only flushes to
 * stdout when the tool returns. On 2026-08-28 a swarm that was still writing
 * files got SIGKILLed ten seconds after its last log write, because stdout
 * silence was read as a wedge. The logs are where kimi's liveness actually
 * shows; a process making no syscalls writes none of them.
 */
/**
 * What the chat is told when a turn dies, and — the part that cost a whole
 * forensic afternoon on 2026-08-28 — WHO killed it.
 *
 * A watchdog kill used to be reported as `kimi exited SIGKILL`, which reads as
 * "kimi crashed" when the truth is "the gateway shot a working turn". Worse, it
 * carried 800 characters of stderr tail: the CLI puts TOOL output on stderr, so
 * the reader got a slab of unrelated `ls` output pasted under the error, and
 * the next turn got it back as context. When we did the killing we already know
 * the reason, so the tail explains nothing and is dropped; on a real crash it
 * IS the CLI's own reason, and stays — labelled, because it is still as likely
 * to be the tail of a `grep` as a stack trace.
 */
export function turnFailureMessage(a: {
  code: number | null;
  signal: string | null;
  sawContent: boolean;
  silenceKill: { stdoutQuietMs: number; wireQuietMs: number | null; cpuAdvanced: boolean | null } | null;
  stderrTail: string;
}): string {
  const min = (ms: number) => `${Math.round(ms / 60_000)}min`;
  if (a.silenceKill) {
    const log = a.silenceKill.wireQuietMs === null
      ? 'it has no session log on disk to check against'
      : `its session log had been quiet for ${min(a.silenceKill.wireQuietMs)} too`;
    // null = ps could not say; the kill verdict then rests on the two silences
    // alone, and the message claims nothing it does not know.
    const cpu = a.silenceKill.cpuAdvanced === false ? ', and its process had burned no CPU' : '';
    return `the gateway stopped this turn: kimi printed nothing for ${min(a.silenceKill.stdoutQuietMs)}, ${log}${cpu} — `
      + 'wedged, not thinking. Send another message and kimi picks the conversation up where it left off.';
  }
  const what = a.sawContent ? 'the turn ended part-way through' : 'the turn produced nothing';
  const tail = a.stderrTail.trim().slice(-400);
  return `kimi exited ${a.signal ?? a.code} — ${what}`
    + (tail ? `\n\nkimi's last stderr (this is where its tool output goes, so it may not be the reason):\n${tail}` : '');
}

export function wireQuietMs(home: string, sessionId: string | null, now = Date.now()): number | null {
  if (!sessionId) return null;
  const dir = sessionDirFor(home, sessionId);
  if (!dir) return null;
  let names: string[];
  try {
    names = fs.readdirSync(path.join(dir, 'agents'));
  } catch {
    return null;
  }
  let latest = -Infinity;
  for (const name of names) {
    try {
      const { mtimeMs } = fs.statSync(path.join(dir, 'agents', name, 'wire.jsonl'));
      if (mtimeMs > latest) latest = mtimeMs;
    } catch {
      // a subagent dir without a wire.jsonl yet; the others speak for the session
    }
  }
  if (latest === -Infinity) return null;
  return Math.max(0, now - latest);
}

/**
 * CPU time a process has burned, in ms — or null when ps cannot say (the
 * process already exited, or a platform without `ps -o time=`).
 *
 * The watchdog's third opinion, after stdout and the session's log tree. Both
 * of those go silent for the WHOLE length of one long model response — kimi
 * flushes its wire log at step boundaries, and a single k3 response at max
 * thinking effort has been measured past six minutes, with nothing saying it
 * stays under fifteen (2026-08-29, a 401s single response). A process
 * mid-response is parsing a stream and burns CPU; one deadlocked on a read
 * does not. It is the only signal left that separates "thinking" from
 * "wedged", and kimi's subagents run in-process, so one pid covers a swarm.
 */
export function childCpuMs(pid: number): number | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
  // `time` prints [[dd-]hh:]mm:ss[.frac] — macOS omits the days/hours it can.
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(out);
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3]);
  const secs = Number(m[4]);
  return Math.round((((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000);
}

// ── finding the session a live turn is writing to ───────────────────────────

/**
 * How far ahead of a session's creation the spawn may sit and the dir still be
 * credited to this turn. The CLI creates the dir within milliseconds of exec;
 * the slack absorbs clock disagreement between the log's clock and Date.now,
 * nothing more. Anything older is a PREVIOUS session — including one that
 * received this exact prompt text the last time the user sent it.
 */
const DISCOVER_SPAWN_SLACK_MS = 10_000;

/**
 * How much of a wire.jsonl to read when fingerprinting it. The `metadata` and
 * `turn.prompt` records open the file, but `profile.bind` (the inlined system
 * prompt) and `llm.tools_snapshot` sit between them and run to tens of KB, so
 * a small head would cut the prompt record off.
 */
const DISCOVER_HEAD_BYTES = 512 * 1024;

/** First bytes of a file, or null when it cannot be read. */
function readHead(file: string, bytes: number): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** created_at from a wire.jsonl head's first line, or null. */
function wireCreatedAtMs(head: string): number | null {
  const nl = head.indexOf('\n');
  try {
    const row = JSON.parse(nl < 0 ? head : head.slice(0, nl)) as { type?: string; created_at?: number };
    return row.type === 'metadata' && typeof row.created_at === 'number' ? row.created_at : null;
  } catch {
    return null;
  }
}

/** Does a wire.jsonl head hold a turn.prompt carrying exactly this text? */
function headHasPrompt(head: string, promptPrefix: string): boolean {
  for (const line of head.split('\n')) {
    if (!line.includes('turn.prompt')) continue;
    try {
      const row = JSON.parse(line) as { type?: string; input?: Array<{ type?: string; text?: string }> };
      if (row.type !== 'turn.prompt' || !Array.isArray(row.input)) continue;
      for (const part of row.input) {
        if (part?.type === 'text' && typeof part.text === 'string'
          && part.text.slice(0, promptPrefix.length) === promptPrefix) return true;
      }
    } catch {
      // a tail line cut mid-record by the head cap; the next candidate speaks
    }
  }
  return false;
}

/**
 * The session this turn is writing to, found on disk — for the window in which
 * the gateway knows no id. The resume hint prints as a turn ENDS, so a first
 * turn has no id while it runs, and a turn that dies mid-run never prints one.
 * (2026-08-29, session cmte4wr4: a first turn's swarm was still writing its log
 * six minutes before the watchdog fired, but with no id the reprieve check had
 * nothing to ask — "no session log on disk" — and killed a working turn.)
 *
 * The prompt is the fingerprint: a fresh session's `agents/main/wire.jsonl`
 * opens with a `turn.prompt` record whose text is byte-for-byte what we passed
 * to `-p`. The creation time is the floor underneath it: only a dir the child
 * we spawned could have created qualifies, so a genuinely wedged RESUMED
 * session — whose dir is old — correctly finds nothing, and a re-sent identical
 * message cannot resurrect a previous session's dir. The weak path (a fresh dir
 * whose prompt record was cut off by the head cap) applies only when exactly
 * ONE dir qualifies — two fresh dirs and no fingerprint means the answer would
 * be a guess, and a wrong stamp resumes somebody else's conversation. That is
 * worse than the kill this function exists to prevent.
 *
 * workDir is matched against the index verbatim (trailing slashes aside): a
 * symlinked or differently-spelled agent dir just yields null, which is the
 * same answer the watchdog gets today — never a wrong session.
 */
export function discoverTurnSession(
  home: string,
  workDir: string,
  spawnedAt: number,
  prompt: string,
): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8');
  } catch {
    return null;
  }
  const wantDir = workDir.replace(/\/+$/, '');
  const promptPrefix = prompt.slice(0, 200);
  let strong: { id: string; createdAt: number } | null = null;
  let weak: { id: string; createdAt: number }[] = [];
  for (const line of raw.split('\n')) {
    if (!line.includes(wantDir)) continue;
    let row: { sessionId?: string; sessionDir?: string; workDir?: string };
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a truncated tail line
    }
    if (!row.sessionId || !row.sessionDir || !row.workDir) continue;
    if (row.workDir.replace(/\/+$/, '') !== wantDir) continue;
    const head = readHead(path.join(row.sessionDir, 'agents', 'main', 'wire.jsonl'), DISCOVER_HEAD_BYTES);
    if (!head) continue;
    const createdAt = wireCreatedAtMs(head);
    if (createdAt === null || createdAt < spawnedAt - DISCOVER_SPAWN_SLACK_MS) continue;
    if (headHasPrompt(head, promptPrefix)) {
      if (!strong || createdAt > strong.createdAt) strong = { id: row.sessionId, createdAt };
    } else {
      weak.push({ id: row.sessionId, createdAt });
    }
  }
  if (strong) return strong.id;
  // No fingerprint: only an unambiguous answer is worth anything — see above.
  return weak.length === 1 ? weak[0].id : null;
}

/**
 * Token counters from a slice of one session's wire log.
 *
 * The stream-json protocol carries NO usage at all — it is messages only. The
 * numbers exist one level down, in the session log the CLI writes for its own
 * replay: `usage.record` per model call (disjoint counters, like dsh's) and
 * `token_counting.measured` for live window occupancy.
 *
 * Reading from `fromOffset` rather than from the top is what keeps this cheap
 * enough to run after every turn: a long session's log is megabytes, and only
 * the bytes this turn appended are new.
 */
export function scanWire(
  file: string,
  fromOffset: number,
  base: KimiTotals | null,
): { totals: KimiTotals; offset: number } | null {
  let fd: number;
  let size: number;
  try {
    size = fs.statSync(file).size;
    // Truncated or replaced under us (a session reset): start over rather than
    // read from a stale offset into the middle of a line.
    const start = fromOffset > size ? 0 : fromOffset;
    if (start === size) return base ? { totals: base, offset: size } : null;
    fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }

    // Stop at the last COMPLETE line, and leave the offset there. A partial tail
    // is then genuinely re-read next time rather than skipped and stepped over —
    // which is what "the next scan picks it up whole" has to mean for it to be
    // true. Rare (the scan runs after the child has exited) but the alternative
    // is a record lost silently, which is the failure mode with no symptom.
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak < 0) return base ? { totals: base, offset: start } : null;
    const complete = text.slice(0, lastBreak + 1);

    return {
      totals: accumulate(complete, start === 0 ? null : base),
      offset: start + Buffer.byteLength(complete, 'utf8'),
    };
  } catch {
    return null;
  }
}

function accumulate(text: string, base: KimiTotals | null): KimiTotals {
  const totals: KimiTotals = {
    input: base?.input ?? 0,
    output: base?.output ?? 0,
    contextTokens: base?.contextTokens ?? null,
    lastOutput: base?.lastOutput ?? null,
  };
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row: { type?: string; usage?: Record<string, number>; tokens?: number };
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a half-written tail line; the next scan picks it up whole
    }
    if (row.type === 'usage.record' && row.usage) {
      const u = row.usage;
      // Disjoint counters, exactly like dsh's: billed input is the sum.
      totals.input += (u.inputOther ?? 0) + (u.inputCacheRead ?? 0) + (u.inputCacheCreation ?? 0);
      totals.output += u.output ?? 0;
      totals.lastOutput = u.output ?? totals.lastOutput;
    } else if (row.type === 'token_counting.measured' && typeof row.tokens === 'number') {
      totals.contextTokens = row.tokens;
    }
  }
  return totals;
}

/** Secrets, cached briefly per name — this sits on the message-delivery path. */
const secretCache = new Map<string, { at: number; value: string | null }>();
async function cachedSecret(name: string): Promise<string | null> {
  const hit = secretCache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = await readSecret(name);
  secretCache.set(name, { at: Date.now(), value });
  return value;
}

/** Test seam. */
export function resetKimiSecretCache(): void {
  secretCache.clear();
}

// ── the runtime ─────────────────────────────────────────────────────────────

export class KimiCodeRuntime implements AgentRuntime {
  readonly kind = 'kimi-code' as const;

  async ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle> {
    const existing = live.get(session.id);
    if (existing) {
      // The spawn env is derived from the handle per turn, so a change here is
      // live on the next submit — there is nothing to rebuild.
      existing.emit = emit;
      existing.agentDirectory = session.agentDirectory;
      existing.modelPin = session.model?.trim() || null;
      existing.credentialId = session.credentialId ?? null;
      existing.hermitTools = session.hermitTools !== false;
      existing.isOrchestrator = session.isOrchestrator ?? false;
      // A handle that never learned its id — its only turn died before the
      // resume hint printed — adopts one the DB gained out of band (an
      // operator's recovery stamp carries exactly the id the hint would have).
      // Without this the next turn spawns FRESH and the CLI's new session
      // overwrites that stamp, stranding the conversation it points to. Only a
      // null slot is filled: within a turn the hint is authoritative, never
      // the DB's older value.
      if (!existing.stampedSessionId) {
        const recorded = session.externalSessionId?.trim() || null;
        if (recorded && KIMI_SESSION_ID.test(recorded)) {
          existing.stampedSessionId = recorded;
          console.warn(
            `[kimi] session=${session.id.slice(0, 8)}: adopted ${recorded.slice(0, 20)}… from the session row`,
          );
        }
      }
      return existing;
    }

    // `externalSessionId` (the DB's `claudeSessionId`) is ONE slot shared by
    // every backend. The switch path clears it on a real backend change, but a
    // row that dodged that — a crash between writes, a hand-edited DB — would
    // hand kimi a claude uuid or a codex thread id. kimi ids are
    // self-describing (`session_<uuid>`), so anything else starts fresh
    // instead of failing identically on every retry.
    const recorded = session.externalSessionId?.trim() || null;
    const kimiId = recorded && KIMI_SESSION_ID.test(recorded) ? recorded : null;
    if (recorded && !kimiId) {
      console.warn(
        `[kimi] session=${session.id.slice(0, 8)}: recorded id ${recorded.slice(0, 12)}… is not a kimi session — starting fresh`,
      );
    }

    const handle: KimiHandle = {
      sessionId: session.id,
      externalSessionId: kimiId ?? '',
      stampedSessionId: kimiId,
      emit,
      agentDirectory: session.agentDirectory,
      modelPin: session.model?.trim() || null,
      credentialId: session.credentialId ?? null,
      chatOnly: session.chatOnly ?? false,
      hermitTools: session.hermitTools !== false,
      isOrchestrator: session.isOrchestrator ?? false,
      working: false,
      child: null,
      interrupted: false,
      totals: null,
      // A resumed session's log already holds every earlier turn. Reading it
      // from 0 on the first turn back is what makes the session total survive
      // a gateway restart, so the offset starts at 0 rather than at its size.
      wireOffset: 0,
      wireSessionId: null,
    };
    live.set(session.id, handle);
    return handle;
  }

  async submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean> {
    void images; // chat-runner folds images into `text` for child backends
    const h = handleOf(handle);
    if (!h) return false;
    if (h.working) return false; // a racing tick must not double-submit

    const bin = resolveKimiCommand();
    if (!bin) {
      h.emit(systemItem(
        h.sessionId,
        `kimi:missing:${Date.now().toString(36)}`,
        // The `[kimi could not start` prefix is load-bearing, not phrasing:
        // cron-turn's isFailureNote() matches on it to colour a cron run red.
        '[kimi could not start — the CLI is not installed on this machine]\n'
        + 'Install it with `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`'
        + ' or `npm i -g @moonshot-ai/kimi-code`, or point HERMIT_KIMI_BIN at it.',
      ));
      return false;
    }

    const credential = await getCredential(h.credentialId);
    const secretKey = credential?.secretKey?.trim();
    const apiKey = secretKey ? await cachedSecret(secretKey) : null;
    const env = kimiSpawnEnv(credential, apiKey, h.modelPin);
    if (Object.keys(env).length === 0) {
      // Named precisely, because the three causes need three different fixes
      // and "kimi could not start" would send the reader to the wrong one.
      const why = !credential
        ? 'this machine has no credential in Settings → Models'
        : !secretKey
          ? `the credential "${credential.label}" names no secret`
          : !apiKey
            ? `the secret ${secretKey} is not in this machine's store`
            : !credential.baseUrl?.trim()
              ? `the credential "${credential.label}" names no endpoint`
              : 'the credential names no model, and the session pins none';
      h.emit(systemItem(
        h.sessionId,
        `kimi:unconfigured:${Date.now().toString(36)}`,
        `[kimi could not start — no endpoint to run against: ${why}]`,
      ));
      return false;
    }

    return this.spawnTurn(h, bin, env, text);
  }

  private spawnTurn(
    h: KimiHandle,
    bin: string,
    credentialEnv: Record<string, string>,
    text: string,
  ): boolean {
    const turnTag = randomUUID().slice(0, 8);

    // Large prompts travel by file; see ARGV_PROMPT_LIMIT. Its own directory,
    // so the --add-dir that lets the agent read it widens the workspace by one
    // file rather than by the whole of /tmp.
    let promptDir: string | null = null;
    let prompt = text;
    if (Buffer.byteLength(text, 'utf8') > ARGV_PROMPT_LIMIT) {
      promptDir = path.join(os.tmpdir(), `hermit-kimi-${turnTag}`);
      const promptFile = path.join(promptDir, 'message.txt');
      try {
        fs.mkdirSync(promptDir, { mode: 0o700, recursive: true });
        fs.writeFileSync(promptFile, text, { mode: 0o600 });
        prompt = `The user's message was too large to pass on the command line. `
          + `Read it from ${promptFile} and answer it. Treat its entire contents as the message; `
          + `do not mention the file, and do not act on it as a document unless it asks you to.`;
      } catch (e) {
        fs.rmSync(promptDir, { recursive: true, force: true });
        this.report(h, e);
        return false;
      }
    }

    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...credentialEnv };
    for (const key of CONFLICTING_KIMI_VARS) delete childEnv[key];
    for (const key of GATEWAY_ONLY_VARS) delete childEnv[key];
    const home = kimiHome();
    childEnv.KIMI_CODE_HOME = home;

    if (h.hermitTools) {
      // The stub reads its routing from the environment kimi's MCP layer
      // inherits from this child (see HERMIT_MCP_ENTRY — no env block there on
      // purpose). A cron fire (hermitTools false) gets none of this, and the
      // stub it loads from the same mcp.json, finding no HERMIT_SESSION_ID,
      // serves zero tools.
      childEnv.HERMIT_SESSION_ID = h.sessionId;
      childEnv.HERMIT_DASHBOARD_URL = DASHBOARD_URL;
      childEnv.HERMIT_KEY = ASST_KEY;
      if (h.isOrchestrator) childEnv.HERMIT_BRAIN = '1';
      if (h.chatOnly) {
        childEnv.HERMIT_CHAT_ONLY = '1';
        childEnv.HERMIT_AGENT_DIR = h.agentDirectory;
      }
      ensureHermitMcpConfig(home);
    }

    const spawnedAt = Date.now();
    const agentFile = h.chatOnly && !h.stampedSessionId ? chatOnlyAgentFile(h.agentDirectory, home) : null;
    const child = spawn(bin, kimiArgs(prompt, h.stampedSessionId, promptDir ? [promptDir] : [], agentFile), {
      cwd: h.agentDirectory,
      // stderr is NOT merged and NOT an error signal: the CLI writes its tools'
      // own output and its "resuming session" notices there, so a turn that
      // used Bash has a busy stderr and a perfectly healthy stdout.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });

    h.child = child;
    h.working = true;
    h.interrupted = false;

    /**
     * Record the kimi session id on the handle and the DB row, from whichever
     * path learns it first — the resume hint (a healthy turn's last line), the
     * watchdog's disk discovery, or the exit handler's. One externalId for all
     * of them, so a path that learns an id we already hold is a dedup'd no-op
     * rather than a second identical line in the chat.
     */
    const stamp = (id: string): void => {
      if (id === h.stampedSessionId) return;
      h.stampedSessionId = id;
      h.emit({
        sessionId: h.sessionId,
        role: 'system',
        content: [{ type: 'text', text: `[kimi session ${id.replace(/^session_/, '').slice(0, 8)}]` }],
        externalId: `kimi:${id}:hello`,
        claudeSessionId: id,
      });
    };

    const translator = new KimiEventTranslator(turnTag);
    const goalTurn = isGoalPrompt(text);
    let sawContent = false;
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });

    // `exited` gates the watchdog. The line reader keeps delivering buffered
    // lines AFTER the exit event — which is why the exit handler waits a tick before
    // judging — and each of those would otherwise re-arm a fresh 15-minute
    // timer that nothing ever clears. Every completed turn would leave one
    // behind, to fire later and log the wedge warning for a turn that ended
    // cleanly: noise shaped exactly like the failure an operator is hunting.
    // `.unref()` so a stray one can never hold the process open either.
    //
    // Stdout silence alone is not a verdict, though. An AgentSwarm turn prints
    // nothing for the whole tool call — the main agent's step flushes when the
    // tool returns, and the subagents never touch stdout — so before killing,
    // the timer asks the session's log tree (wireQuietMs) whether anything is
    // still being written. Alive on disk → re-arm for the remainder of a
    // 15-minute quiet budget measured from the last log write; the reprieve is
    // logged so a runaway shows up in the gateway log, not just its kill.
    // `h.stampedSessionId` is read at fire time, not capture time: the first
    // turn of a fresh session learns its id mid-turn (stdout hint, or the
    // disk discovery above it when the hint has not printed yet).
    let exited = false;
    // Set by the watchdog just before it fires, read by the exit handler: the
    // difference between "kimi died" and "we killed a turn that was working".
    let silenceKill: { stdoutQuietMs: number; wireQuietMs: number | null; cpuAdvanced: boolean | null } | null = null;
    let lastStdoutAt = Date.now();
    // CPU baseline for the wedge-or-thinking verdict (childCpuMs). Sampled at
    // arm time so the fire-time sample has something to compare against;
    // throttled so a burst of step-boundary lines does not spawn ps per line.
    let cpuSample: { at: number; ms: number } | null = null;
    const sampleCpu = (force = false): void => {
      if (child.pid === undefined) return;
      if (!force && cpuSample && Date.now() - cpuSample.at < 5_000) return;
      const ms = childCpuMs(child.pid);
      if (ms !== null) cpuSample = { at: Date.now(), ms };
    };
    sampleCpu(true);
    const silence = (delayMs: number): NodeJS.Timeout => setTimeout(() => {
      let quietMs = wireQuietMs(kimiHome(), h.stampedSessionId);
      if (quietMs === null || quietMs >= TURN_SILENCE_TIMEOUT_MS) {
        // The id can be missing or stale while the turn is fine: the resume
        // hint prints as a turn ENDS (a first turn has no id while it runs),
        // and `-r` on an id kimi no longer has opens a NEW session under a new
        // id. Find the session this child is actually writing to — its log
        // identifies itself by the prompt it received — before believing the
        // silence. A genuinely wedged turn finds nothing and dies as before.
        const found = discoverTurnSession(kimiHome(), h.agentDirectory, spawnedAt, prompt);
        if (found && found !== h.stampedSessionId) {
          stamp(found);
          quietMs = wireQuietMs(kimiHome(), found);
          console.warn(
            `[kimi] session=${h.sessionId.slice(0, 8)}: no id from the CLI yet, but the session log on disk `
            + `names this turn ${found.slice(0, 20)}… — liveness read from there`,
          );
        }
      }
      if (quietMs !== null && quietMs < TURN_SILENCE_TIMEOUT_MS) {
        const remainder = Math.max(1000, TURN_SILENCE_TIMEOUT_MS - quietMs);
        console.warn(
          `[kimi] session=${h.sessionId.slice(0, 8)}: stdout quiet, but the session log was written `
          + `${Math.round(quietMs / 1000)}s ago (a swarm works in silence) — letting the turn run`,
        );
        sampleCpu(true);
        watchdog = silence(remainder);
        return;
      }
      // stdout silent AND the log tree silent — one question left: is the
      // process burning CPU? A single long model response looks exactly like
      // this (no stdout, no log writes until the step ends) and killing it was
      // the 2026-08-29 bug's surviving blind spot. ps unanswerable (null) does
      // NOT save a turn: missing data falls back to the old verdict, because a
      // watchdog that cannot fire at all is worse than one with a blind spot.
      const cpuBefore = cpuSample;
      sampleCpu(true);
      const cpuAdvanced = cpuBefore && cpuSample
        ? cpuSample.ms > cpuBefore.ms && cpuSample.at - cpuBefore.at > 30_000
        : null;
      if (cpuAdvanced) {
        console.warn(
          `[kimi] session=${h.sessionId.slice(0, 8)}: stdout and log quiet, but the process burned `
          + `${cpuSample!.ms - cpuBefore!.ms}ms of CPU — a long model call, not a wedge — letting the turn run`,
        );
        watchdog = silence(TURN_SILENCE_TIMEOUT_MS);
        return;
      }
      silenceKill = { stdoutQuietMs: Date.now() - lastStdoutAt, wireQuietMs: quietMs, cpuAdvanced };
      console.warn(
        `[kimi] session=${h.sessionId.slice(0, 8)}: no output for ${TURN_SILENCE_TIMEOUT_MS / 60000}min `
        + `(session log ${quietMs === null ? 'not found' : `quiet ${Math.round(quietMs / 1000)}s`}`
        + `${cpuAdvanced === false ? ', no CPU burned' : ''}) — killing the turn`,
      );
      child.kill('SIGKILL');
    }, delayMs).unref();
    let watchdog = silence(TURN_SILENCE_TIMEOUT_MS);

    if (child.stdout) {
      readLfLines(child.stdout, (line) => {
        if (!exited) {
          lastStdoutAt = Date.now();
          clearTimeout(watchdog);
          watchdog = silence(TURN_SILENCE_TIMEOUT_MS);
        }

        const msg = parseKimiLine(line);
        if (!msg) return;

        const learned = resumeHintId(msg);
        if (learned) stamp(learned);

        for (const item of translator.translate(msg)) {
          sawContent = true;
          h.emit({ ...item, sessionId: h.sessionId, claudeSessionId: null });
        }
      }, {
        // The reader caps a single line where readline did not. Say so when it
        // fires: a dropped record can be the one carrying the resume hint or the
        // whole assistant message, and the turn would otherwise just look empty.
        onOversize: (chars) => console.warn(
          `[kimi] session=${h.sessionId.slice(0, 8)}: dropping a ${chars}-char line, past the frame ceiling`,
        ),
      });
    }

    const cleanup = () => {
      exited = true;
      clearTimeout(watchdog);
      if (promptDir) fs.rmSync(promptDir, { recursive: true, force: true });
    };

    child.on('error', (e) => {
      cleanup();
      h.working = false;
      h.child = null;
      this.report(h, e);
    });

    child.on('exit', (code, signal) => {
      cleanup();
      // Give the line reader a beat to flush its last lines before judging.
      setImmediate(() => {
        // A turn that dies mid-run never prints the resume hint — it rides the
        // LAST line — so the id the turn wrote under would be lost, and the
        // failure note's "send another message and kimi picks up where it left
        // off" would be a lie: the next message would open a FRESH session.
        // The prompt in the session log identifies it; stamp what we find so
        // resume (and the usage read below) work for killed and crashed turns.
        if (!h.stampedSessionId) {
          const found = discoverTurnSession(kimiHome(), h.agentDirectory, spawnedAt, prompt);
          if (found) stamp(found);
        }
        h.working = false;
        h.child = null;
        this.refreshUsage(h);
        if (h.interrupted) {
          h.emit(systemItem(h.sessionId, `kimi:${Date.now().toString(36)}:interrupted`, '[turn interrupted]'));
        } else if (turnFailed(code, signal, h.interrupted, goalTurn)) {
          // A missing dependency, a rejected key, a quota refusal, a crash.
          // Reported whether or not rows arrived first — a turn that answered
          // halfway and then died is still a turn the reader must be told about,
          // and the CLI puts its reason on stderr, which nothing else surfaces.
          this.report(h, new Error(turnFailureMessage({ code, signal, sawContent, silenceKill, stderrTail })));
        }
      });
    });

    return true;
  }

  /** Fold whatever this turn appended to kimi's session log into the totals. */
  private refreshUsage(h: KimiHandle): void {
    if (!h.stampedSessionId) return;
    if (h.wireSessionId !== h.stampedSessionId) {
      // A different log than the one the offset counts. See wireSessionId.
      h.wireOffset = 0;
      h.totals = null;
      h.wireSessionId = h.stampedSessionId;
    }
    const file = wireFileFor(kimiHome(), h.stampedSessionId);
    if (!file) return;
    const scanned = scanWire(file, h.wireOffset, h.totals);
    if (!scanned) return;
    h.totals = scanned.totals;
    h.wireOffset = scanned.offset;
  }

  /** Put a failure in the chat. Silence here reads as the agent ignoring you. */
  private report(h: KimiHandle, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[kimi] session=${h.sessionId.slice(0, 8)} turn failed:`, message);
    h.emit(systemItem(
      h.sessionId,
      `kimi:${Date.now().toString(36)}:error`,
      `[kimi could not run this turn]\n${message.slice(0, 1000)}`,
    ));
  }

  async isWorking(handle: RuntimeHandle): Promise<boolean> {
    return handleOf(handle)?.working ?? false;
  }

  /** A handle for this session — true before any totals exist, unlike usage(). */
  async isLive(handle: RuntimeHandle): Promise<boolean> {
    return handleOf(handle) !== null;
  }

  async interrupt(handle: RuntimeHandle): Promise<void> {
    const h = handleOf(handle);
    if (!h?.child) return;
    h.interrupted = true;
    // The CLI turns SIGINT into an orderly shutdown (exit 130) that flushes the
    // session log; only a process that ignores that gets the hard kill.
    const child = h.child;
    child.kill('SIGINT');
    setTimeout(() => {
      if (h.child === child) child.kill('SIGKILL');
    }, 5_000).unref();
  }

  async compact(handle: RuntimeHandle, instructions?: string): Promise<void> {
    void instructions;
    const h = handleOf(handle);
    if (!h) return;
    // kimi compacts its own context (`[loop_control] reserved_context_size`),
    // and its `/compact` is a TUI command print mode has no way to invoke — a
    // slash command in `-p` is sent to the model as literal text. Saying so
    // beats a silent no-op, which is indistinguishable from a wedged session.
    h.emit(systemItem(
      h.sessionId,
      `kimi:${Date.now().toString(36)}:compact`,
      '[kimi manages its own context window — there is nothing to compact by hand]',
    ));
  }

  async usage(handle: RuntimeHandle): Promise<RuntimeUsage | null> {
    const h = handleOf(handle);
    if (!h) return null;
    // Refreshed here, not only at the end of a turn. Session snapshots call
    // this every 8s including mid-turn, and kimi writes its usage records as it
    // goes — so reading them here is what keeps the context bar moving instead
    // of showing the previous completed turn (or nothing at all, for a
    // session's first) until the child exits. Costs only the bytes appended
    // since the last call. Same reasoning as codex's refreshRolloutUsage.
    this.refreshUsage(h);
    return h.totals ? toRuntimeUsage(h.totals) : null;
  }

  /**
   * Usage for a session with no live handle — after a gateway restart, or for a
   * hibernated one.
   *
   * The first call for a session reads its whole log, because a cumulative
   * total cannot be had any other way. Every call after that reads only what
   * was appended since, which for a session with no live child is normally
   * nothing at all — scanWire returns on the stat without opening the file.
   *
   * That cache is not an optimisation, it is the difference between working and
   * not. This is called from the session-snapshot tick for EVERY open session
   * that has no handle, every 8 seconds, forever — so after a gateway restart
   * with ten open kimi sessions, the uncached version would re-read ten
   * multi-megabyte logs on the event loop six hundred times an hour. codex
   * solves the same problem by bounding its read to a tail; this keeps the
   * whole-file answer and pays for it once.
   */
  async storedUsage(handle: RuntimeHandle): Promise<RuntimeUsage | null> {
    const id = handle.externalSessionId?.trim();
    if (!id || !KIMI_SESSION_ID.test(id)) return null;

    const cached = storedScans.get(id);
    const file = cached?.file ?? wireFileFor(kimiHome(), id);
    if (!file) return null;

    const scanned = scanWire(file, cached?.offset ?? 0, cached?.totals ?? null);
    if (!scanned) return null;
    storedScans.set(id, { file, offset: scanned.offset, totals: scanned.totals });
    return toRuntimeUsage(scanned.totals);
  }

  /**
   * Session ids this backend is holding right now.
   *
   * The shutdown drain needs an inventory, and there is nowhere else to get one:
   * every backend keeps its live children in a module-private map, and the
   * teardown sites that already act on `allRuntimes()` are handed a session id
   * from the DB. Without this, a graceful shutdown would have to guess who is
   * running — which is how six of the seven backends came to have their `stop()`
   * skipped entirely on SIGTERM.
   */
  liveSessionIds(): string[] {
    return [...live.keys()];
  }

  async stop(handle: RuntimeHandle, mode: 'hibernate' | 'kill'): Promise<void> {
    const h = live.get(handle.sessionId);
    if (!h) return;
    live.delete(handle.sessionId);
    if (h.stampedSessionId) storedScans.delete(h.stampedSessionId);
    if (h.child) {
      h.interrupted = true;
      const child = h.child;
      child.kill('SIGINT');
      // Escalate, exactly as interrupt() does. `kill` is chat-runner's restart
      // button — "unwedge this" — and the one thing a wedged child does is
      // ignore SIGINT. Without this the handle is gone from `live` (so isLive
      // and isWorking both answer false, and the purge path reads the session
      // as free) while the child keeps running and keeps emitting into a chat
      // that was just restarted.
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }
    // Both modes keep the session: the conversation lives in kimi's own store
    // and the id is on the session row, so the next message resumes it. `kill`
    // is chat-runner's restart button — "unwedge this", not "forget this".
    void mode;
  }
}

function toRuntimeUsage(t: KimiTotals): RuntimeUsage {
  return {
    contextTokens: t.contextTokens,
    outputTokens: t.lastOutput,
    totalTokens: t.input + t.output,
    // Kimi Code bills against a subscription window, not per token — see
    // /usage, which reads the real quota from api.kimi.com. A number computed
    // from a price list here would be fiction in the cost column.
    costUsd: null,
  };
}
