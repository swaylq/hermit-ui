// Moving a live session from one backend to another.
//
// Two questions, both answerable without touching the DB, which is why they
// live here rather than inline in the router:
//
//   1. Is the switch safe right now?
//   2. Does the currently-running process have to be torn down?
//
// (2) is not the same as "did the columns change". pi bakes its provider, model
// and mode into the child process at spawn time, so re-pointing a pi session at
// a different model — or a different mode, whose whole expression is spawn
// arguments — needs a fresh child; Claude Code takes its model from the
// machine's settings.json and ignores those columns entirely, so writing them
// on a claude session changes nothing that is running.
//
// See docs/pi-runtime-design.md and docs/backends-and-models-design.md.

import type { RuntimeChoice } from './runtime-resolve';

// One definition, shared with the UI: the sheet has to WARN about losing the
// running context exactly when this returns false, and the two drifting apart
// would either scare a user off a lossless move or promise one that is not.
import { sharesConversation } from '@/lib/runtime-labels';

export type SwitchPlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      restart: boolean;
      /**
       * Whether `claudeSessionId` must be dropped on the way through.
       *
       * That column is ONE slot holding whichever backend last ran the session
       * — a claude transcript uuid, a codex thread id, a pi session id — and
       * the incoming backend cannot resume the outgoing one's. Deliberately
       * NOT the same condition as `restart`: see below.
       */
      resetExternalId: boolean;
    };

/**
 * @param session   the row's live state (only `state` is consulted)
 * @param before    the backend resolved for the session as it stands
 * @param after     the backend the caller is asking for
 */
export function planRuntimeSwitch(
  session: { state?: string | null },
  before: RuntimeChoice,
  after: RuntimeChoice,
): SwitchPlan {
  // A turn in flight belongs to the OLD backend: its process is mid-stream and
  // holds the only copy of that turn's context. Switching now strands it —
  // whatever comes back is written against a session that has already moved on.
  // Cheap to avoid: the turn finishes in seconds, or the user stops it.
  if (session.state === 'working') {
    return { ok: false, reason: 'This session is mid-turn. Wait for it to finish, or stop the turn, then switch.' };
  }

  // A real backend change is the one case that invalidates the external id. Note
  // this is NOT interchangeable with `restart`: pi restarts on a bare model or
  // mode change, and clearing the id there would silently discard the very
  // conversation the restart is meant to carry over.
  //
  // Compared on backendId rather than harness: two backends can run the SAME
  // harness against different credentials ("pi + hyqubit" and "pi + Kimi"), and
  // moving between them is every bit as much a backend change — different
  // endpoint, different model catalog, and a session id the other side's
  // provider never issued.
  //
  // …with one exception, and it is the whole point of shipping two Claude Code
  // drivers: 'claude-sdk' and 'claude-tmux' are the same binary writing the same
  // `~/.claude/projects/<cwd>/<uuid>.jsonl`, so the id is not foreign across
  // that pair — it IS the conversation. Clearing it would answer "change how
  // this chat is driven" by starting the user a brand-new chat, which is the
  // opposite of the intent and unrecoverable from the UI. The restart still
  // happens: the outgoing driver has to let go of the transcript before the
  // incoming one resumes it.
  if (before.backendId !== after.backendId) {
    return {
      ok: true,
      restart: true,
      resetExternalId: !sharesConversation(before.runtime, after.runtime),
    };
  }

  // codex and dsh read the model off these columns like pi does, but neither
  // has a long-lived process to tear down — each turn is its own subprocess,
  // and the gateway resolves the model at spawn time (codex rebuilds its thread
  // object; dsh passes it per run, resuming the same session id either way).
  // Restarting would hibernate a session to achieve something the next turn
  // does anyway.
  if (after.runtime === 'codex-exec' || after.runtime === 'dsh-exec') {
    return { ok: true, restart: false, resetExternalId: false };
  }

  // Same backend. Only the RPC harnesses bake provider/model/mode into the
  // child at spawn; claude takes its model from the machine's settings.json.
  if (after.runtime === 'pi-rpc' || after.runtime === 'prime-rpc') {
    const moved =
      (before.runtimeProvider ?? null) !== (after.runtimeProvider ?? null) ||
      (before.runtimeModel ?? null) !== (after.runtimeModel ?? null) ||
      (before.runtimeMode ?? null) !== (after.runtimeMode ?? null) ||
      (before.runtimeCredentialId ?? null) !== (after.runtimeCredentialId ?? null);
    return { ok: true, restart: moved, resetExternalId: false };
  }

  return { ok: true, restart: false, resetExternalId: false };
}
