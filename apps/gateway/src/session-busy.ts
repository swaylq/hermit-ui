// session-busy.ts — "is a turn in flight on this session?", asked of whatever
// actually runs the session.
//
// ./pane answers that question by scraping a tmux pane, and for a session that
// HAS a pane it is the authoritative answer. The trap is what it does for a
// session that has none: `tmux capture-pane` against a missing session exits 1
// with empty stdout, so capturePaneMarker resolves `{marker:false}` rather than
// null, and every claude-sdk session reads back as IDLE — permanently, with
// nothing thrown and nothing logged.
//
// That is the failure shape this workspace has already paid for twice: a verdict
// bound to the shell a session used to run in rather than to a backend-independent
// fact (see evolution/lessons.md, "a verdict bound to the shell fails silently").
// Here it cost turns: the machine-level "restart all sessions" op skips sessions
// that are mid-turn, and on claude-sdk nothing ever read busy, so it skipped
// nothing and every in-flight turn on the machine was thrown away.
//
// So the verdict routes the way delivery, restart and hibernate already route:
// ask runtimeFor() who owns the session and let the owner answer. Only what
// runtimeFor() declines — claude-tmux, and anything unrecognised — falls through
// to the pane. Adding a backend therefore cannot reintroduce this bug: a new
// runtime is asked automatically, and there is no `kind === ...` list to forget.
import { paneIsWorking, sessionTranscriptPath } from './pane';
import { runtimeFor, type AgentRuntime } from './runtime';

/** Exactly the fields every caller already has from `api.pollChatPending()`. */
export type BusySession = {
  id: string;
  runtime?: string | null;
  runtimeMode?: string | null;
  claudeSessionId?: string | null;
  agentDirectory?: string | null;
};

/** Seams, for tests only. Production calls pass nothing. */
export type BusyProbes = {
  lookup?: (kind: string | null | undefined, mode: string | null | undefined) => AgentRuntime | null;
  pane?: typeof paneIsWorking;
};

/**
 * Is this session mid-turn right now?
 *
 * `runtimeMode` is not optional in spirit: it is what picks the engine behind
 * the pi backend, and a lookup given only the kind hands an omp session pi's
 * runtime — a different live-handle map, so the session reads idle while its
 * child works. Callers pass the row through whole rather than picking fields.
 *
 * A probe that throws reads IDLE, matching what every call site did before this
 * function existed. The bias is deliberate and narrow: `isWorking` on every
 * runtime is an in-memory map lookup that cannot realistically throw, whereas
 * biasing a throw toward BUSY would let one systematic failure turn a
 * user-initiated op into a silent no-op — the exact class of bug this file is
 * here to remove.
 */
export async function sessionIsBusy(s: BusySession, probes: BusyProbes = {}): Promise<boolean> {
  const lookup = probes.lookup ?? runtimeFor;
  const pane = probes.pane ?? paneIsWorking;
  const runtime = lookup(s.runtime, s.runtimeMode);
  try {
    if (runtime) {
      return await runtime.isWorking({
        sessionId: s.id,
        externalSessionId: s.claudeSessionId ?? '',
      });
    }
    // The pane path — handed the context that makes its answer right. Transcript
    // freshness and the narrow-pane hook fallback are both INERT when a caller
    // passes only a session id, which is how the restart-all gate used to read:
    // a tmux session in a long quiet think, or on a pane too narrow to render
    // the mode line, answered idle there too.
    return await pane(
      s.id,
      sessionTranscriptPath(s.claudeSessionId, s.agentDirectory),
      s.agentDirectory,
      s.claudeSessionId,
    );
  } catch {
    return false;
  }
}
