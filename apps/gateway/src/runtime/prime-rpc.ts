// Prime Agent backend: one `prime-agent --mode rpc` child process per session.
//
// Prime Agent (PrimeIntellect, MIT) is a fork of pi — literally: its workspace
// packages are @earendil-works/pi-coding-agent on their own version line, with
// a piConfig block renaming the product and its config dir to ~/.prime/agent.
// So the RPC protocol, the event vocabulary and the extension API are pi's, and
// translatePiEvent and hermit-pi-extension.ts are reused unchanged rather than
// forked.
//
// What is NOT pi:
//   - one built-in model tool, `ipython`, a persistent kernel that holds Python
//     state across turns and compaction. Files, shell, skills and subagents all
//     happen as code inside it.
//   - a daemon. `--mode rpc` opens a CLIENT-OWNED session on it, so the child we
//     hold is still the thing whose lifetime we control, but the session file is
//     leased: a second client opening the same file gets `session_already_active`
//     rather than silently becoming a second writer. That is the failure the pi
//     path had to fix by hand (see PiHandle.bootId).
//   - `--resume <path|id>`, where pi takes `--session <path>`. Different flag,
//     different config dir, different session store; nothing is shareable, which
//     is why this is its own backend and not a third engine under pi.
//
// The wire is JsonlTransport (see there for the LF-only framing this must not
// get wrong). See docs/prime-runtime-design.md.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type {
  AgentRuntime, RuntimeHandle, RuntimeImage, RuntimeSession, RuntimeUsage, SyncItem,
} from './types';
import { translatePiEvent } from './pi-events';
import { globalMemoryPrompt } from './context-files';
import { singleFlight } from './pi-rpc';
import {
  providerEnv, visionEnv, machineProviderEnv,
  fingerprintAuthEnv, currentAuthFingerprint,
} from './pi-credentials';
import { readPiSession, rememberPiSession, resumablePiSession } from './pi-sessions';
import { getCredential, credentialDefaultModel } from '../pi-config';
import { JsonlTransport, type RpcEvent } from './jsonl-transport';
import { DASHBOARD_URL, ASST_KEY } from '../config';
import { HERMIT_TOOL_NAMES } from './pi-modes';

/** The hermit tools extension, loaded into every child with --extension. */
function hermitExtensionPath(): string {
  return new URL('./hermit-pi-extension.ts', import.meta.url).pathname;
}

/**
 * Where prime-agent lives.
 *
 * Installed globally with npm by its own installer, so it is not resolvable
 * from this package's node_modules — and deliberately not a dependency. It also
 * needs a Python kernel (uv + python ≥3.11 bootstrapped into
 * ~/.prime/agent/kernel-venv), which is not a thing to pull into every
 * machine's install for a backend most will not use.
 */
function resolvePrimeCli(): string {
  const explicit = process.env.HERMIT_PRIME_CLI?.trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    '/opt/homebrew/bin/prime-agent',
    '/usr/local/bin/prime-agent',
    path.join(os.homedir(), '.local', 'bin', 'prime-agent'),
    path.join(os.homedir(), '.npm-global', 'bin', 'prime-agent'),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Error(
      'Prime Agent is not installed on this machine. Install it with '
      + '`curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh`, '
      + 'or set HERMIT_PRIME_CLI to the prime-agent binary.',
    );
  }
  return hit;
}

/** Where prime keeps its Python kernel, and the one-liner that repairs it. */
function kernelHint(): string {
  const venv = path.join(os.homedir(), '.prime', 'agent', 'kernel-venv');
  return fs.existsSync(venv)
    ? ''
    : `\n\nIts Python kernel is not set up either (${venv} is missing). `
      + 'Run `prime-agent doctor --fix` on this machine; it needs uv and Python 3.11+.';
}

type PrimeHandle = RuntimeHandle & {
  transport: JsonlTransport;
  seen: Set<string>;
  ordinal: number;
  /**
   * Scopes the ordinal to the child that produced it.
   *
   * Prime's events carry no durable entry id, so the external id falls back to
   * a counter — and a counter that resets to 0 in every child, against a dedup
   * key of (sessionId, externalId) whose conflict handler is an UPDATE, does not
   * append the first turn after a restart: it rewrites the session's first
   * message in place. That happened on the pi path; this exists so it cannot
   * happen here.
   */
  bootId: string;
  /**
   * Fingerprint of the credentials this child booted with.
   *
   * A child reads its auth from the environment once, at startup, and an env is
   * fixed for the life of a process — so a child outlives its own credential.
   * Comparing this against the current fingerprint turns a rotated key into a
   * recycle nobody sees, instead of every turn 401ing until someone restarts it.
   */
  authFingerprint: string | null;
  /** Which credential it booted against; a change means a new child. */
  credentialId: string | null;
  emit: (item: SyncItem) => void;
  lastTurn: { contextTokens: number; outputTokens: number } | null;
};

const live = new Map<string, PrimeHandle>();
const starting = new Map<string, Promise<PrimeHandle>>();
const bootFailedUntil = new Map<string, { until: number; error: Error }>();
const BOOT_BACKOFF_MS = 15_000;
/** How long a retiring child gets to drain before it is killed outright. */
const DRAIN_TIMEOUT_MS = 5_000;

function systemItem(sessionId: string, externalId: string, text: string): SyncItem {
  return { sessionId, role: 'system', content: [{ type: 'text', text }], externalId, claudeSessionId: null };
}

function handleOf(h: RuntimeHandle): PrimeHandle | null {
  return live.get(h.sessionId) ?? null;
}

/** Same basis as the claude path's contextTokens: what was sent for this turn. */
function contextTokensFrom(u: Record<string, number> | undefined): number | null {
  if (!u) return null;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const total = n(u.input) + n(u.cacheRead) + n(u.cacheWrite);
  return total > 0 ? total : null;
}

/** Tell the chat a child is gone, and whether its conversation survived it. */
function announceExit(h: PrimeHandle, sessionId: string, reason: string): void {
  console.warn(`[prime] evicted session=${sessionId.slice(0, 8)}: ${reason}`);
  const next = resumablePiSession(sessionId, undefined, { engine: 'prime' })
    ? 'The next message restarts Prime Agent on this conversation and carries on.'
    : "The next message starts a fresh Prime Agent session, which will not carry this conversation's context.";
  h.emit(systemItem(sessionId, `${sessionId}:${h.bootId}-exit`, `[Prime Agent session ended — ${reason}]\n${next}`));
}

/** Drop a child that is already dead, or that we are giving up on. */
function evict(sessionId: string, reason: string): void {
  const h = live.get(sessionId);
  if (!h) return;
  live.delete(sessionId);
  h.transport.kill();
  announceExit(h, sessionId, reason);
}

/**
 * Close stdin and wait for the child to actually be gone.
 *
 * Awaiting matters because every caller boots a replacement straight after,
 * pointed at the same session file. The file is written as the child drains, so
 * returning early would leave two children holding one lease — and prime's own
 * answer to that is `session_already_active`, i.e. the replacement refuses to
 * start at all. The deadline bounds it: a child that will not drain is still
 * gone in 5s.
 */
async function drain(transport: JsonlTransport, label: string): Promise<void> {
  transport.end();
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (transport.isAlive && Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 50); });
  }
  if (transport.isAlive) {
    console.warn(`[prime] ${label} did not drain in ${DRAIN_TIMEOUT_MS}ms; killing`);
    transport.kill();
  }
}

/**
 * Retire a child that is still healthy, and wait for it to be gone.
 *
 * Not `evict`: a SIGKILLed child writes no session file, so killing a healthy
 * one would take the conversation with it — the very thing --resume exists to
 * keep.
 */
async function retire(sessionId: string, reason: string): Promise<void> {
  const h = live.get(sessionId);
  if (!h) return;
  live.delete(sessionId);
  await drain(h.transport, `session=${sessionId.slice(0, 8)}`);
  announceExit(h, sessionId, reason);
}

/**
 * Has this child's credential moved since it booted?
 *
 * False when either side is unknown: a machine with no configured credential
 * (children inherit whatever the gateway's own env carries) must not be told
 * its sessions rotate every minute.
 */
async function staleAuth(h: PrimeHandle): Promise<boolean> {
  if (!h.authFingerprint) return false;
  const now = await currentAuthFingerprint(h.credentialId);
  return now !== null && now !== h.authFingerprint;
}

export class PrimeRpcRuntime implements AgentRuntime {
  readonly kind = 'prime-rpc' as const;

  async ensure(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<RuntimeHandle> {
    const existing = live.get(session.id);
    if (existing) {
      if (!existing.transport.isAlive) {
        evict(session.id, 'child is gone');
      } else if ((session.credentialId ?? null) !== existing.credentialId) {
        // A different credential is a different endpoint and a different model
        // catalog. Prime bakes both into the child at spawn, so this is a new
        // child, not a setting to push.
        await retire(session.id, 'credential changed');
      } else if (await staleAuth(existing)) {
        // Retired while idle only. Evicting mid-turn would abandon a reply that
        // is still streaming, and this is never urgent: the credential the
        // running turn already sent with is the one it will finish on, and the
        // next tick catches the child once it is quiet.
        if (await this.isWorking(existing)) return existing;
        await retire(session.id, 'auth credential rotated');
      } else {
        return existing;
      }
    }

    const cooling = bootFailedUntil.get(session.id);
    if (cooling && Date.now() < cooling.until) throw cooling.error;

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
            console.error(`[prime] boot failed for session=${session.id.slice(0, 8)}:`, error.message);
            emit(systemItem(
              session.id,
              `${session.id}:boot-failed-${Date.now()}`,
              `[Prime Agent could not start]\n${error.message.slice(0, 800)}`,
            ));
          }
          bootFailedUntil.set(session.id, { until: Date.now() + BOOT_BACKOFF_MS, error });
          throw error;
        }),
    );
  }

  private async boot(session: RuntimeSession, emit: (item: SyncItem) => void): Promise<PrimeHandle> {
    const credential = await getCredential(session.credentialId);
    const model = session.model ?? credentialDefaultModel(credential);
    const provider = session.provider ?? credential?.provider;
    const modelArg = model && provider && !model.includes('/') ? `${provider}/${model}` : model;

    // The conversation this session was already having, if it had one. Same
    // shape as the pi path: `pointer` without `resume` means we had a thread and
    // lost the file, which is the one case worth telling the user about. Prime
    // resumes by PATH (`--resume <path|id>`), where pi takes `--session <path>`
    // and omp takes its own session id.
    const pointer = readPiSession(session.id);
    // The hermit tools and the machine key that authenticates them travel
    // together: a child given one without the other has tools that 401 rather
    // than tools that are absent. `hermitTools: false` — an ordinary cron fire,
    // whose session id has no ChatSession row for these tools to act on — drops
    // both. See RuntimeSession.hermitTools.
    const hermitTools = session.hermitTools !== false;
    const resume = resumablePiSession(session.id, undefined, { engine: 'prime' });
    // Prime, like pi, finds the agent's own AGENTS.md/CLAUDE.md by walking CWD's
    // ancestors — but the machine's global memory lives in ~/.claude/, off that
    // path, so it must be appended here exactly as pi-rpc does. Before this,
    // prime was the one pi-family engine with no global memory at all.
    const globalMemoryArg = globalMemoryPrompt();

    const args = [
      ...(hermitTools ? ['--extension', hermitExtensionPath()] : []),
      ...(modelArg ? ['--model', modelArg] : []),
      ...(provider ? ['--provider', provider] : []),
      ...(globalMemoryArg ? ['--append-system-prompt', globalMemoryArg] : []),
      ...(resume?.file ? ['--resume', resume.file] : []),
      // No update check on every session boot. A gateway spawning children all
      // day should not be probing a release manifest to do it.
      '--offline',
    ];
    // Deliberately no `--tools`: prime has exactly one built-in tool and we want
    // it. An allowlist here could only subtract.
    //
    // Which is exactly what a pure-chat session asks for, and why prime is the
    // one backend that cannot serve the mode usefully. That single tool,
    // `ipython`, is where reading, writing, running commands and spawning
    // sub-agents ALL happen, so there is no read-only subset to keep: the list
    // below is hermit's extension tools and nothing else. Such a session can
    // talk and hand things to the user; it cannot even read a file. sway chose
    // this over pretending the backend supports the mode (2026-09-01), and the
    // new-chat UI says so before you pick the combination.
    if (session.chatOnly) args.push('--tools', HERMIT_TOOL_NAMES.join(','));

    // Resolved into a local first so the child's credential and the fingerprint
    // recorded for it come from ONE read — two reads could straddle a rotation
    // and record a fingerprint the child never had, which reads as "already
    // stale" on the very next tick.
    const machineEnv = await machineProviderEnv(session.credentialId);

    const transport = new JsonlTransport({
      cliPath: resolvePrimeCli(),
      baseArgs: ['--mode', 'rpc'],
      cwd: session.agentDirectory,
      args,
      label: 'prime',
      env: {
        ...process.env,
        ...(await providerEnv(provider)),
        ...machineEnv,
        ...(await visionEnv()),
        ...(hermitTools ? {
          HERMIT_DASHBOARD_URL: DASHBOARD_URL,
          HERMIT_KEY: ASST_KEY,
          HERMIT_SESSION_ID: session.id,
        } : {}),
        // Tells the shared hermit extension which backend it is inside. Prime
        // takes pi.registerProvider, so unlike omp this one WANTS the
        // registration — but it resolves `apiKey` as a BARE env var name, not
        // pi's "$VAR" reference, so the extension has to spell the key
        // differently here. See registerMachineProvider.
        HERMIT_RUNTIME: 'prime-rpc',
        PI_SKIP_VERSION_CHECK: '1',
      } as Record<string, string>,
      onEvent: (ev) => this.onEvent(session.id, ev),
      onExit: ({ code, signal }) => {
        // Only report a death we did not ask for. stop() removes the handle
        // first, so a hibernate lands here with nothing to evict.
        if (live.has(session.id)) {
          evict(session.id, `child exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
        }
      },
    });

    try {
      await transport.start();
      // Prime's RPC mode announces nothing on start, so liveness is proven by a
      // real request rather than by a frame that may never come. get_state is
      // also what we need next, so this costs nothing.
      var state = await transport.send<{ sessionId?: string; sessionFile?: string }>({ type: 'get_state' });
    } catch (e) {
      transport.kill();
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(msg + kernelHint());
    }

    // Loud, because the alternative is a session that quietly answers with none
    // of its own history: we asked to reattach and did not land on it.
    if (resume && state?.sessionId && resume.piSessionId && state.sessionId !== resume.piSessionId) {
      console.warn(
        `[prime] session=${session.id.slice(0, 8)} asked to resume ${resume.piSessionId}`
        + ` but landed on ${state.sessionId}`,
      );
    }

    // Write the pointer down before the first turn, not after: a child that dies
    // mid-answer has still created the session, and the file it left is exactly
    // what the next boot should pick back up.
    if (state?.sessionId) {
      rememberPiSession(session.id, {
        file: state.sessionFile ?? resume?.file ?? '',
        piSessionId: state.sessionId,
        cwd: session.agentDirectory,
        engine: 'prime',
      });
    } else if (pointer) {
      console.warn(`[prime] session=${session.id.slice(0, 8)} booted without a session id; pointer left as-is`);
    }

    const handle: PrimeHandle = {
      sessionId: session.id,
      externalSessionId: state?.sessionId ?? session.externalSessionId ?? '',
      transport,
      seen: new Set<string>(),
      ordinal: 0,
      bootId: `${state?.sessionId ?? 'prime'}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      authFingerprint: fingerprintAuthEnv(machineEnv),
      credentialId: session.credentialId ?? null,
      emit,
      lastTurn: null,
    };
    live.set(session.id, handle);
    return handle;
  }

  /** Translate one child frame into chat rows. */
  private onEvent(sessionId: string, ev: RpcEvent): void {
    const h = live.get(sessionId);
    if (!h) return;
    const raw = ev as { type?: string; message?: { role?: string; usage?: Record<string, number> } };

    if (raw.type === 'message_end' && raw.message?.role === 'assistant' && raw.message.usage) {
      const u = raw.message.usage;
      h.lastTurn = {
        contextTokens: contextTokensFrom(u) ?? 0,
        outputTokens: Number(u.output ?? 0),
      };
    }

    // An extension that throws is reported into the chat rather than swallowed:
    // hermit's own tools live in one, and a silently dead `ask` looks to the
    // user like the agent simply ignoring a question.
    if (raw.type === 'extension_error') {
      const e = ev as { extensionPath?: string; error?: string };
      h.emit(systemItem(
        sessionId,
        `${sessionId}:${h.bootId}-extension-error-${h.ordinal++}`,
        `[Prime Agent extension error]\n${String(e.extensionPath ?? '')}: ${String(e.error ?? '')}`.slice(0, 800),
      ));
      return;
    }

    const externalId = `${sessionId}:${h.bootId}-ord-${h.ordinal}`;
    const items = translatePiEvent(ev, externalId);
    if (items.length === 0) return;
    h.ordinal += 1;
    if (h.seen.has(externalId)) return;
    h.seen.add(externalId);
    for (const item of items) {
      h.emit({ ...item, sessionId, claudeSessionId: null });
    }
  }

  async submit(handle: RuntimeHandle, text: string, images: RuntimeImage[]): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    // Prime takes images natively on `prompt`, but the gateway already relays
    // uploads to local paths and injects recognised text before this point, so
    // nothing is passed here yet. Wiring it is the obvious next improvement.
    void images;
    const working = await this.isWorking(handle);
    try {
      // A prompt during a stream is rejected outright unless it says how to
      // queue, so `steer` is the explicit form of what the queue already means:
      // deliver after the current turn's tool calls, before the next model call.
      await h.transport.send(
        working
          ? { type: 'prompt', message: text, streamingBehavior: 'steer' }
          : { type: 'prompt', message: text },
      );
    } catch (e) {
      if (!h.transport.isAlive) {
        evict(h.sessionId, 'child died while submitting');
        return false; // leaves the row un-acked; the next tick respawns and redelivers
      }
      throw e;
    }
    return true;
  }

  async isWorking(handle: RuntimeHandle): Promise<boolean> {
    const h = handleOf(handle);
    if (!h) return false;
    try {
      const st = await h.transport.send<{ isStreaming?: boolean; isCompacting?: boolean }>({ type: 'get_state' });
      return Boolean(st?.isStreaming) || Boolean(st?.isCompacting);
    } catch {
      // Not idle: gone. The transport's exit hook has already evicted.
      return false;
    }
  }

  /** A live RPC child for this session, turn or no turn. */
  async isLive(handle: RuntimeHandle): Promise<boolean> {
    return handleOf(handle) !== null;
  }

  async interrupt(handle: RuntimeHandle): Promise<void> {
    await handleOf(handle)?.transport.send({ type: 'abort' }).catch(() => undefined);
  }

  async compact(handle: RuntimeHandle, instructions?: string): Promise<void> {
    await handleOf(handle)?.transport
      .send({ type: 'compact', ...(instructions ? { customInstructions: instructions } : {}) })
      .catch(() => undefined);
  }

  async usage(handle: RuntimeHandle): Promise<RuntimeUsage | null> {
    const h = handleOf(handle);
    if (!h) return null;
    const stats = await h.transport
      .send<{
        tokens?: { input?: number; output?: number; total?: number };
        cost?: number;
        contextUsage?: { tokens?: number | null };
      }>({ type: 'get_session_stats' })
      .catch(() => null);
    if (!stats?.tokens) return null;
    const input = Number(stats.tokens.input ?? 0);
    const output = Number(stats.tokens.output ?? 0);
    return {
      // Prime reports the number it uses for compaction and its own footer,
      // which is exactly what contextTokens is documented to mean — "how full is
      // the window right now". Preferred over the per-turn reconstruction, which
      // stays as the fallback for the window right after a compaction, where
      // prime returns null until a fresh assistant response lands.
      contextTokens: stats.contextUsage?.tokens ?? h.lastTurn?.contextTokens ?? null,
      outputTokens: h.lastTurn?.outputTokens ?? null,
      // Child (rlm) usage is folded into the parent turn by prime itself and
      // persisted as a child_usage_attributed entry, so this total already
      // includes subagents without us doing anything.
      totalTokens: Number(stats.tokens.total ?? input + output),
      costUsd: typeof stats.cost === 'number' ? stats.cost : null,
    };
  }

  async stop(handle: RuntimeHandle, mode: 'hibernate' | 'kill'): Promise<void> {
    const h = live.get(handle.sessionId);
    if (!h) return;
    // Remove first so the exit hook does not report this as an unexpected death.
    live.delete(handle.sessionId);
    // Closing stdin lets prime drain and write its session file; SIGKILL does
    // not. Both modes take that path, and the pointer is kept for both on
    // purpose: `kill` here is chat-runner's restart button, not "throw the
    // conversation away", and a restart that also wiped the context would be a
    // worse tool than the wedged session it was reached for.
    void mode;
    await drain(h.transport, `session=${handle.sessionId.slice(0, 8)}`);
  }
}
