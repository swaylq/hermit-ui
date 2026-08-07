// pi backend: one `pi --mode rpc` child process per chat session.
//
// pi ships RPC mode explicitly for embedding ("headless operation with JSON
// stdin/stdout protocol"), so unlike the claude path there is no terminal to
// scrape — events arrive typed over LF-framed JSONL.
//
// See docs/pi-runtime-design.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
import { translatePiEvent } from './pi-events';
import {
  providerEnv, machineProviderEnv, visionEnv,
  fingerprintAuthEnv, currentAuthFingerprint,
} from './pi-credentials';
import { resolveMode, buildModeArgs } from './pi-modes';
import { readPiSession, rememberPiSession, resumablePiSession } from './pi-sessions';
import { globalMemoryPrompt } from './context-files';
import { getPiConfig, resolveDefaultModel } from '../pi-config';
import { DASHBOARD_URL, ASST_KEY } from '../config';

// RpcClient's default cliPath search is cwd-relative, so it looks for
// `<agentDir>/dist/cli.js` and dies. The package's `exports` map only defines
// the `import` condition, so require.resolve() cannot see it either — resolve
// through ESM and derive the sibling CLI entry.
//
// Resolved lazily, NOT at module load. chat-runner imports this file for every
// session including claude ones, so a resolution failure at import time would
// crash the gateway and take the whole claude fleet down with it. Failing here
// instead confines the damage to the pi session that asked for it.
let piCliPath: string | null = null;

/** The hermit tools extension, loaded into every pi child with --extension. */
function hermitExtensionPath(): string {
  return fileURLToPath(new URL('./hermit-pi-extension.ts', import.meta.url));
}

function resolvePiCli(): string {
  if (piCliPath) return piCliPath;
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  piCliPath = path.join(path.dirname(entry), 'cli.js');
  return piCliPath;
}

type PiHandle = RuntimeHandle & {
  client: RpcClient;
  /** externalIds already emitted — pi replays durable entries on reconnect. */
  seen: Set<string>;
  ordinal: number;
  /**
   * Unique per spawned child. Scopes the ordinal fallback in externalIds.
   *
   * pi's session events carry no durable entry id — `message_end` is
   * `{type, message}` and nothing else (docs/pi-runtime-design.md), so the
   * counter below is not a last resort, it is the live path. It restarts at 0
   * for every child, and the dashboard upserts by (sessionId, externalId) with
   * `update: {role, content}` on conflict. So an unscoped `ord-N` meant the
   * first turn after a gateway restart REWROTE the session's first message in
   * place: the new reply appeared at the top of the chat as mutated history,
   * the actual answer never appeared at the bottom, and `lastMessageAt` did not
   * advance so the session was not even marked unread. Scoping the counter to
   * the child that produced it keeps every turn a distinct row.
   */
  bootId: string;
  /**
   * The mode this child was spawned with, as resolved at boot.
   *
   * A mode exists only as spawn arguments, so a running child cannot adopt a
   * new one. Recording it lets ensure() notice a session whose mode moved
   * underneath it and replace the child instead of silently serving the old
   * recipe. The dashboard's own switch already hibernates the session; this
   * catches the other routes in (the agent default changing, a direct DB edit).
   */
  mode: string | null;
  /**
   * Fingerprint of the credentials this child was booted with.
   *
   * pi reads its auth from the environment at startup and an env is fixed for
   * the life of a process, so a long-lived child outlives its own credential.
   * Under the Claude subscription that is routine rather than rare: Claude Code
   * rotates its OAuth access token roughly every 8h and the rotation REVOKES
   * the previous one. See PiHandle's omp counterpart for the incident this came
   * from — the fault is in this file too, and the pi-engine modes (coding, ops,
   * writer) sit on exactly the same one.
   */
  authFingerprint: string | null;
  /**
   * Where this session's items go. Kept on the handle so a child that dies
   * between turns can still report itself into the chat.
   */
  emit: (item: SyncItem) => void;
  /**
   * Usage of the most recent assistant turn.
   *
   * getSessionStats() only reports session totals, but the dashboard's context
   * bar wants current occupancy, so the per-message usage is captured off the
   * event stream as it goes past.
   */
  lastTurn: { contextTokens: number; outputTokens: number } | null;
  /**
   * Set on a child that was reattached to an existing session file; cleared by
   * the first submit.
   *
   * A reattached child holds a conversation the dashboard has already stored.
   * If pi were to replay those entries through the event stream, they would
   * arrive with fresh ordinals (no session event carries a durable id — see
   * eventKeyFor), so every one of them would insert a SECOND copy of a message
   * already in the chat. The measured behaviour is that pi replays nothing, but
   * "measured once" is not a guarantee to hang a duplicated transcript on:
   * events before our own first turn are dropped, since after a restart there
   * is by definition no in-flight turn of ours for them to belong to.
   */
  replayGuard: boolean;
  /** How many events the guard has dropped — logged once, to notice if pi ever does replay. */
  replaySuppressed: number;
  /** The session file pi says this child is writing, if it said. */
  sessionFile: string | null;
  /** Whether this child has already recorded that its file made it to disk. */
  flushMarked: boolean;
};

const live = new Map<string, PiHandle>();

// In-flight starts, keyed by session.
//
// ensure() is called from chatTick (~2s) and awaits client.start() between
// checking `live` and populating it. Without this guard several ticks all pass
// the check, each spawns its own pi child and registers its own event listener,
// and every event is emitted once per listener with an independent ordinal —
// which surfaced as the same turn appearing three times in the dashboard.
//
// (This map and that paragraph shipped in the fix commit; ensure() was never
// changed to read it, so the bug it describes stayed live and the regression
// test asserted against a local copy of the guard instead of this module.)
const starting = new Map<string, Promise<PiHandle>>();

// Cool-down after a boot that threw, keyed by session.
//
// A child that dies on every spawn — bad provider key, unreachable endpoint,
// a cliPath that no longer resolves — otherwise gets respawned at chatTick's
// ~2s cadence for as long as the message stays queued, silently: the failure
// only ever reached the gateway console.
const bootFailedUntil = new Map<string, { until: number; error: Error }>();
const BOOT_BACKOFF_MS = 15_000;

/**
 * Run `factory` at most once per key while a previous call is still in flight.
 *
 * Exported so the guard itself is what the regression test exercises; a test
 * that re-implements it locally passes while the real ensure() is unguarded,
 * which is exactly what happened here.
 */
export function singleFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  // .finally, not .then: a boot that threw must clear the slot too, or one bad
  // spawn would pin the session to a rejected promise for the gateway's life.
  const p = factory().finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

/**
 * The dedup / upsert key for one pi event, consuming an ordinal when the event
 * carries no durable id of its own (which today is every event).
 *
 * Mutates `h.ordinal` — the counter has to advance exactly once per keyed
 * event, and doing it here keeps the boot scoping and the increment together.
 */
export function eventKeyFor(
  h: { bootId: string; ordinal: number },
  raw: { entryId?: string; id?: string } | null | undefined,
): string {
  const durable = raw?.entryId ?? raw?.id;
  if (durable) return durable;
  return `${h.bootId}-ord-${h.ordinal++}`;
}

/**
 * Did pi end up on a different provider than the one we asked for?
 *
 * pi resolves a bare model id against its own built-in catalogue, so asking for
 * a machine model id without naming the machine's provider silently lands on
 * whichever public provider happens to publish that id. The turn then produces
 * no reply, no error event and no stderr — the chat simply waits forever. This
 * is the cheap check that turns that into something a person can see.
 *
 * Only a genuine disagreement counts: pi not reporting a provider at all, or us
 * not having asked for one, is not evidence of anything.
 */
export function providerMismatch(
  wanted: string | undefined,
  resolved: { model?: { provider?: string; baseUrl?: string } } | null,
): { wanted: string; got: string; baseUrl?: string } | null {
  const got = resolved?.model?.provider;
  if (!wanted || !got || got === wanted) return null;
  return { wanted, got, baseUrl: resolved?.model?.baseUrl };
}

/** A chat row from the runtime itself, not from the model. */
function systemItem(sessionId: string, externalId: string, text: string): SyncItem {
  return {
    sessionId,
    role: 'system',
    content: [{ type: 'text', text }],
    externalId,
    claudeSessionId: null,
  };
}

/**
 * Did this call fail because the child is gone, rather than being slow?
 *
 * RpcClient reports process death only in the Error message — it rejects every
 * pending and subsequent call once the child exits, and exposes no exit hook to
 * subscribe to. The distinction matters: a request that hit RpcClient's 30s
 * timeout reads "Timeout waiting for response to …" and must NOT count as
 * death, or a slow-but-healthy turn would be evicted and answered twice.
 */
function isDeadClientError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /Agent process (exited|error|stdin)|Client not started/.test(msg);
}

/**
 * Drop a dead child so the next ensure() spawns a fresh one, and say so.
 *
 * Without this the handle stayed in `live` after the child died: every later
 * submit() threw into chat-runner's catch, the message was never acked, and the
 * session retried the same dead client forever while the dashboard showed a
 * perfectly normal-looking chat that had simply stopped answering.
 */
function evict(sessionId: string, reason: string): void {
  const h = live.get(sessionId);
  if (!h) return;
  live.delete(sessionId);
  h.client.stop().catch(() => undefined);
  console.warn(`[pi] evicted dead session=${sessionId.slice(0, 8)}: ${reason}`);
  // What happens next depends on whether the session file survived the child,
  // which is the ordinary case — pi appends to it as the conversation goes, so
  // a crashed or killed child leaves the thread on disk to be picked back up.
  const next = resumablePiSession(sessionId)
    ? 'The next message restarts pi on this conversation and carries on.'
    : "The next message starts a fresh pi session, which will not carry this conversation's context.";
  h.emit(systemItem(sessionId, `${sessionId}:${h.bootId}-exit`, `[pi session ended — ${reason}]\n${next}`));
}

/**
 * Window occupancy for one turn, from pi's per-message Usage.
 *
 * Mirrors the claude path's contextTokens exactly:
 *   input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * so the dashboard's context bar means the same thing on both backends.
 */
export function contextTokensFrom(usage: Record<string, unknown> | null | undefined): number | null {
  if (!usage) return null;
  const n = (k: string) => Number(usage[k] ?? 0) || 0;
  return n('input') + n('cacheRead') + n('cacheWrite');
}

function handleOf(handle: RuntimeHandle): PiHandle | null {
  return live.get(handle.sessionId) ?? null;
}

/**
 * The sync items for one pi event.
 *
 * `claudeSessionId` is deliberately null. That column is Claude Code's
 * `--resume` handle: the sync route stamps whatever arrives onto the session,
 * and the tmux path later spawns `claude --resume <it>`. pi used to write its
 * OWN session id there, which was harmless only while a session stayed on one
 * backend forever — the moment a session can be moved between backends, one pi
 * turn destroys the claude transcript handle and switching back silently
 * starts a fresh claude. pi has nothing to gain from it either: pi resume is
 * not implemented (it would replay entries and duplicate every message —
 * docs/pi-runtime-design.md), so nothing ever reads the value back.
 */
export function emitItemsFor(sessionId: string, externalId: string, ev: unknown): SyncItem[] {
  return translatePiEvent(ev, externalId).map((item) => ({
    ...item,
    sessionId,
    claudeSessionId: null,
  }));
}

/**
 * Has the machine's credential moved since this child booted?
 *
 * False when either side is unknown: a machine with no configured credential
 * (children inherit whatever the gateway's own env carries) must not be told
 * its sessions rotate every minute.
 */
async function staleAuth(h: PiHandle): Promise<boolean> {
  if (!h.authFingerprint) return false;
  const now = await currentAuthFingerprint();
  return now !== null && now !== h.authFingerprint;
}

export class PiRpcRuntime implements AgentRuntime {
  readonly kind = 'pi-rpc' as const;

  async ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle> {
    const existing = live.get(session.id);
    if (existing) {
      // Same session, different recipe: the child in hand cannot become the mode
      // being asked for, so retire it and fall through to a fresh boot.
      const wanted = resolveMode(session.mode)?.name ?? null;
      if (wanted !== existing.mode) {
        evict(session.id, `mode changed ${existing.mode ?? 'none'} → ${wanted ?? 'none'}`);
      } else if (await staleAuth(existing)) {
        // Idle only — evicting mid-turn would abandon a reply that is still
        // streaming, and the next tick catches the child once it is quiet.
        if (await this.isWorking(existing)) return existing;
        evict(session.id, 'auth credential rotated');
      } else {
        return existing;
      }
    }

    // A child that cannot start at all is reported once, then left alone for a
    // while, instead of being respawned on every tick.
    const cooling = bootFailedUntil.get(session.id);
    if (cooling && Date.now() < cooling.until) throw cooling.error;

    // Serialise concurrent boots. deliverMessages is fire-and-forget and
    // chatTick fires every ~2s, so while the first call is inside
    // client.start() the next ticks reach here too — each spawning its own
    // child, each registering its own listener over its own ordinal counter.
    // Two live children then answered the same session with neither holding the
    // other's turns, which is what a session losing its thread looks like from
    // the chat.
    return singleFlight(starting, session.id, () =>
      this.boot(session, emit)
        .then((handle) => {
          live.set(session.id, handle);
          bootFailedUntil.delete(session.id);
          return handle;
        })
        .catch((e: unknown) => {
          const error = e instanceof Error ? e : new Error(String(e));
          if (!cooling) {
            console.error(`[pi] boot failed for session=${session.id.slice(0, 8)}:`, error.message);
            emit(systemItem(
              session.id,
              `${session.id}:boot-failed-${Date.now()}`,
              `[pi could not start]\n${error.message.slice(0, 800)}`,
            ));
          }
          bootFailedUntil.set(session.id, { until: Date.now() + BOOT_BACKOFF_MS, error });
          throw error;
        }));
  }

  /** Spawn one pi child and wire its event stream. Only called via ensure(). */
  private async boot(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<PiHandle> {
    // The mode is the session's spawn recipe: extra extensions, a tool
    // allowlist, skills, and text appended to pi's system prompt. Read at spawn
    // because that is the only moment pi can be told any of it — which is also
    // why changing a session's mode has to restart its child (planRuntimeSwitch).
    const mode = resolveMode(session.mode);
    const modeArgs = buildModeArgs(mode, { agentDirectory: session.agentDirectory });
    const globalMemoryArg = globalMemoryPrompt();
    // The machine's default model, for sessions that pin none. Set on Settings →
    // Pi Runtime so a new chat does not have to name a model to get a good one.
    const piConfig = await getPiConfig();
    const machineDefaultModel = resolveDefaultModel(piConfig);
    // ...and the provider that serves it. A model id alone is NOT enough: pi
    // resolves a bare id against its own built-in catalogue, so `claude-opus-5`
    // with no provider came back as {provider: 'anthropic', baseUrl:
    // api.anthropic.com} — a provider this machine has no key for. The turn then
    // produced NOTHING: no reply, no error event, no stderr, just a child
    // sitting idle while the chat waited forever. Every pi session that pinned
    // no provider was dead from the moment the machine default model shipped.
    const machineProvider = piConfig.provider?.trim() || undefined;

    // The conversation this session was already having, if it had one. `pi
    // --session <path>` opens that file instead of creating a session, which is
    // what makes a gateway restart survivable: the child is new, the thread is
    // not. `pointer` without `resume` means we had a thread and lost the file —
    // the one case worth telling the user about, below.
    const pointer = readPiSession(session.id);
    const resume = resumablePiSession(session.id, undefined, { engine: 'pi' });

    // One read, shared by the child's env and the fingerprint recorded for it —
    // two reads could straddle a rotation and record a fingerprint the child
    // never had, which reads as "already stale" on the very next tick.
    const machineEnv = await machineProviderEnv();

    // The child inherits the gateway's env plus the provider key, resolved from
    // the encrypted store at start time so it never lands in a config file.
    const client = new RpcClient({
      cwd: session.agentDirectory,
      cliPath: resolvePiCli(),
      // Provider and model are resolved with the same precedence, and the
      // provider falls back to the machine's rather than to pi's built-in
      // catalogue — the models offered on the settings page are the machine
      // endpoint's, so an id from that list means nothing anywhere else.
      provider: session.provider ?? machineProvider,
      // Precedence: the session's own pin, then a mode that genuinely requires
      // a particular model (a browser mode needs an endpoint that accepts image
      // blocks), then the machine's configured default.
      model: session.model ?? mode?.model ?? machineDefaultModel,
      // --extension gives the child hermit's own tools (pi has no MCP), and
      // --no-approve keeps it from trusting project-local extension/skill files
      // it happens to find in the workspace — only ours is loaded on purpose.
      // hermit's extension goes FIRST so a mode extension can see its tools.
      // --session last: an absolute path, so it is independent of cwd and of
      // every mode argument before it.
      args: [
        '--extension', hermitExtensionPath(),
        ...modeArgs,
        // pi finds the agent's own AGENTS.md/CLAUDE.md by walking CWD's
        // ancestors, but the machine's global memory lives in ~/.claude/, which
        // is not on that path — so it is the one thing pi can never reach for
        // itself, in either auth mode. Appended (not --system-prompt) so pi's
        // own core prompt and the mode's text both survive.
        ...(globalMemoryArg ? ['--append-system-prompt', globalMemoryArg] : []),
        ...(resume ? ['--session', resume.file] : []),
      ],
      env: {
        ...process.env,
        // Provider key for whatever provider the child will actually use. The
        // session's own pin wins; a session without one falls back to the
        // machine's configured provider — which is how a built-in provider
        // like moonshotai-cn (pi reads MOONSHOT_API_KEY from env) gets its
        // key when no session has pinned it. Injecting only the session pin
        // left machine-provider sessions keyless.
        ...(await providerEnv(session.provider ?? machineProvider)),
        ...machineEnv,
        ...(await visionEnv()),
        HERMIT_DASHBOARD_URL: DASHBOARD_URL,
        HERMIT_KEY: ASST_KEY,
        HERMIT_SESSION_ID: session.id,
      } as Record<string, string>,
    });
    await client.start();

    const state = (await client.getState().catch(() => null)) as
      { sessionId?: string; sessionFile?: string; model?: { provider?: string; baseUrl?: string } } | null;

    // Loud, because the alternative is a session that answers nothing at all
    // and never says why.
    const wrongProvider = providerMismatch(session.provider ?? machineProvider, state);
    if (wrongProvider) {
      console.error(
        `[pi] session=${session.id.slice(0, 8)} resolved to provider "${wrongProvider.got}" ` +
        `(${wrongProvider.baseUrl ?? 'no base url'}) but this machine configured "${wrongProvider.wanted}"`,
      );
      emit(systemItem(
        session.id,
        `${session.id}:provider-mismatch-${state?.sessionId ?? 'unknown'}`,
        `[pi is on the wrong provider]\nAsked for "${wrongProvider.wanted}", pi resolved "${wrongProvider.got}"`
        + `${wrongProvider.baseUrl ? ` (${wrongProvider.baseUrl})` : ''}. Turns will not be answered until this is fixed.`,
      ));
    }

    // Did the reattach take? pi reports the session it actually opened, so this
    // is checked rather than assumed: a `--session` that pi declined (a file it
    // could not parse, a build without the flag) would otherwise be reported to
    // the user as continuity while the model started from nothing.
    const reattached = Boolean(resume && state?.sessionId && state.sessionId === resume.piSessionId);

    // Write the pointer on every boot, reattach or not — this is the only place
    // that knows which file the child ended up with, and refreshing it on a
    // reattach is also what keeps the store's LRU cap meaningful.
    if (state?.sessionId && state.sessionFile) {
      rememberPiSession(session.id, {
        file: state.sessionFile,
        piSessionId: state.sessionId,
        cwd: session.agentDirectory,
        engine: 'pi',
        // Carried forward, not recomputed. A reattach is itself proof the file
        // is on disk with a conversation in it, and a pointer that already
        // earned the flag must not lose it here — the flush-mark in onEvent
        // only fires for a child that has not been marked, so a downgrade would
        // be permanent and would silence the one notice that matters.
        flushed: reattached || pointer?.flushed || undefined,
      });
    } else {
      // Not fatal, but this session will amnesia on the next restart, so it is
      // said out loud rather than discovered later in a confused conversation.
      console.warn(
        `[pi] session=${session.id.slice(0, 8)}: pi reported no session file; ` +
        'this session will not survive a gateway restart',
      );
    }

    const handle: PiHandle = {
      sessionId: session.id,
      externalSessionId: state?.sessionId ?? session.externalSessionId ?? '',
      client,
      seen: new Set<string>(),
      ordinal: 0,
      // pi's own session id makes an externalId traceable back to a session file
      // on disk, but it is NOT unique on its own now that resume has landed:
      // `--session <path>` reattaches to the same pi session id with the ordinal
      // counter back at 0, so a per-spawn suffix carries the uniqueness. Without
      // it, the first turn after a restart would upsert onto the row the first
      // turn of the previous child wrote.
      bootId: `${state?.sessionId ?? 'pi'}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      mode: mode?.name ?? null,
      authFingerprint: fingerprintAuthEnv(machineEnv),
      emit,
      lastTurn: null,
      replayGuard: reattached,
      replaySuppressed: 0,
      sessionFile: state?.sessionFile ?? null,
      // A reattached child is by definition writing a file that already exists.
      flushMarked: reattached,
    };

    client.onEvent((ev: unknown) => {
      const raw = ev as {
        entryId?: string; id?: string; type?: string;
        message?: { role?: string; usage?: Record<string, number> };
      } | null;

      // Anything a reattached child says before we have asked it anything is
      // history the dashboard already holds — see PiHandle.replayGuard.
      if (handle.replayGuard) {
        handle.replaySuppressed += 1;
        if (handle.replaySuppressed === 1) {
          console.log(
            `[pi] session=${session.id.slice(0, 8)} reattached: dropping events replayed before the first turn`,
          );
        }
        return;
      }

      // Same basis as the claude path's contextTokens: what the provider was
      // sent for this turn, cache included.
      if (raw?.type === 'message_end' && raw.message?.role === 'assistant' && raw.message.usage) {
        const u = raw.message.usage;
        handle.lastTurn = {
          contextTokens: contextTokensFrom(u) ?? 0,
          outputTokens: Number(u.output ?? 0),
        };
      }

      // A completed assistant turn is the point at which pi has actually
      // written the session to disk, so it is the point at which the pointer
      // can promise there is a conversation behind it — see
      // PiSessionPointer.flushed. Guarded: a failure to record this must not
      // take down the event stream carrying the reply.
      if (raw?.type === 'message_end' && !handle.flushMarked && handle.sessionFile) {
        try {
          if (fs.existsSync(handle.sessionFile)) {
            handle.flushMarked = true;
            rememberPiSession(session.id, {
              file: handle.sessionFile,
              piSessionId: handle.externalSessionId,
              cwd: session.agentDirectory,
              engine: 'pi',
              flushed: true,
            });
          }
        } catch (e) {
          console.warn(`[pi] session=${session.id.slice(0, 8)}: could not record session pointer:`, (e as Error).message);
        }
      }

      // Prefer pi's durable entry id so a reconnect that replays the session
      // dedupes instead of duplicating. No session event carries one today, so
      // the ordinal fallback is the path every message actually takes — hence
      // the bootId scope (see PiHandle.bootId), without which a restart's first
      // turn silently overwrote the session's first message.
      const externalId = `${session.id}:${eventKeyFor(handle, raw)}`;
      if (handle.seen.has(externalId)) return;

      const items = emitItemsFor(session.id, externalId, ev);
      if (items.length === 0) return;

      handle.seen.add(externalId);
      for (const item of items) emit(item);
    });

    // Three ways this can end, and only one of them is worth interrupting the
    // conversation over. Saying nothing at all is what made the original bug
    // expensive — the dashboard shows the full transcript either way, so an
    // amnesiac child looks exactly like a healthy one until it answers a
    // question it should already have known. But crying loss over a session
    // that never had a turn in it would be its own kind of noise.
    const short = session.id.slice(0, 8);
    if (reattached) {
      console.log(`[pi] session=${short} reattached to ${path.basename(resume!.file)}`);
    } else if (resume || pointer?.flushed) {
      const why = resume
        ? `pi opened ${state?.sessionId ?? 'another session'} instead of ${resume.piSessionId}`
        : `its session file is gone (${pointer!.file})`;
      console.warn(`[pi] session=${short} could not reattach: ${why}`);
      emit(systemItem(
        session.id,
        `${session.id}:${handle.bootId}-fresh`,
        `[pi started a fresh session — ${why}]\nThe turns above are not in this session's context.`,
      ));
    } else if (pointer) {
      // Pointer, no file, no turn ever completed under it: nothing was lost.
      console.log(`[pi] session=${short}: previous child left no session file, starting fresh`);
    }

    return handle;
  }

  async submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    const payload = images.map((img) => ({ path: img.path, mediaType: img.mediaType })) as never;
    // steer() lands mid-turn, prompt() starts one — the same distinction the
    // tmux path makes between "queue into a busy pane" and a fresh submit.
    const working = await this.isWorking(handle);
    // From here on the events belong to a turn we asked for, so they are ours to
    // emit. Cleared BEFORE the send, not after: the reply can start arriving
    // while prompt() is still resolving.
    h.replayGuard = false;
    try {
      if (working) await h.client.steer(text, payload);
      else await h.client.prompt(text, payload);
    } catch (e) {
      // Returning false leaves the row un-acked, so chat-runner redelivers it on
      // the next tick — by which time the evicted session has been respawned and
      // the message lands on a live child instead of being lost to a dead one.
      if (isDeadClientError(e)) {
        evict(h.sessionId, (e as Error).message.split('.')[0]);
        return false;
      }
      throw e;
    }
    return true;
  }

  async isWorking(handle: RuntimeHandle): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    let state: { isStreaming?: boolean; isCompacting?: boolean } | null = null;
    try {
      state = (await h.client.getState()) as { isStreaming?: boolean; isCompacting?: boolean };
    } catch (e) {
      // Not "idle": gone. isWorking() runs on every chatTick and on every
      // snapshot probe, so this is where a child that died between turns is
      // noticed at all.
      if (isDeadClientError(e)) evict(h.sessionId, (e as Error).message.split('.')[0]);
      return false;
    }
    if (!state) return false;
    // Compaction is not a model turn but the session cannot accept one either,
    // so for queue-gating purposes it counts as busy.
    return Boolean(state.isStreaming) || Boolean(state.isCompacting);
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
    const stats = (await h.client.getSessionStats().catch(() => null)) as {
      tokens?: { input?: number; output?: number; total?: number };
      cost?: number;
    } | null;
    if (!stats?.tokens) return null;
    const input = Number(stats.tokens.input ?? 0);
    const output = Number(stats.tokens.output ?? 0);
    return {
      contextTokens: h.lastTurn?.contextTokens ?? null,
      outputTokens: h.lastTurn?.outputTokens ?? null,
      totalTokens: Number(stats.tokens.total ?? input + output),
      costUsd: typeof stats.cost === 'number' ? stats.cost : null,
    };
  }

  async stop(handle: RuntimeHandle, _mode: 'hibernate' | 'kill'): Promise<void> {
    const h = live.get(handle.sessionId);
    if (!h) return;
    // pi persists the session to ~/.pi/agent/sessions/<encoded-cwd>/ either way,
    // and the pointer is kept for BOTH modes on purpose. `kill` here is not
    // "throw the conversation away" — it is chat-runner's restart button, whose
    // claude-side equivalent respawns with `--resume` and keeps every turn. A
    // restart that also wiped the context would be a worse tool than the wedged
    // session it was reached for.
    live.delete(handle.sessionId);
    await h.client.stop().catch(() => undefined);
  }
}
