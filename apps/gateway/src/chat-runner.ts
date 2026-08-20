// Tmux-driven chat runner.
//
// Each ChatSession owns a long-lived tmux pane running interactive `claude`.
// User messages get pushed in via `tmux send-keys`; the gateway tails the
// claude transcript JSONL and forwards new assistant/tool_result rows to
// the dashboard via /api/sync/chat-message.
//
// Why interactive instead of `claude --print -p`:
//   - Interactive sessions bill against Claude Max's "Interactive" bucket
//     (large, normal usage), not the "Agent SDK" bucket (small, full API
//     rates after 2026-06-15). See evolution/lessons.md → L1.
//   - Slash commands, sub-agents, /compact, plan mode — all work natively.
//   - Conversation context lives in the pane; no per-turn `--resume` dance.
//
// JSONL is the structured-output source of truth. Tmux capture-pane returns
// ANSI/box-drawing TUI output which is unparseable; the JSONL transcript at
// `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` is Anthropic-native.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ensureSession,
  sendKeys,
  confirmSubmitted,
  sendInterrupt,
  kill as killTmuxSession,
  acceptResumePromptAsFull,
  watchTranscript,
  encodedProjectDir,
  tmuxSessionExists,
  readComposer,
  readComposerText,
  dismissFocusStealer,
  probeInputPath,
  hardKill,
  waitForReplReady,
  listTranscripts,
  pickLiveTranscript,
  paneClaudeSessionId,
  tmuxPaneName,
} from '@hermit-ui/tmux-driver';
import { paneIsWorking, WORK_MARKER_RE, sessionTranscriptPath } from './pane';
import { extractText, hasToolResult, CcEvent } from './claude-code';

import { runtimeFor, allRuntimes } from './runtime';
import { AGENTS_ROOT, DASHBOARD_URL, ASST_KEY } from './config';
import { api } from './api';
import { relayImages } from './image-relay';
import { describeImage, formatVision } from './vision';
import { tryAcquire, release, isLocked } from './op-locks';
import { cronOwnedUuids } from './cron-uuids';

// MCP stub gives the in-pane claude these tools: set_session_title, log_status,
// attach_image, attach_file. Spawned as a stdio child of `claude --mcp-config <json>`.
const MCP_STUB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-stub.cjs');

export function buildMcpConfigArg(chatSessionId: string, isBrain = false): string {
  const config = {
    mcpServers: {
      hermit: {
        command: 'node',
        args: [MCP_STUB_PATH],
        // 4h5m: the `ask` tool blocks until the user clicks a button in the
        // dashboard; this per-server ceiling sits just ABOVE the stub's own 4h
        // ASK_MAX_MS so the stub returns a clean "timed out" result before
        // claude force-kills the tool call (which would error the turn).
        timeout: 14_700_000,
        env: {
          HERMIT_SESSION_ID: chatSessionId,
          HERMIT_DASHBOARD_URL: DASHBOARD_URL,
          HERMIT_KEY: ASST_KEY,
          // The orchestrator ("义脑") session gets HERMIT_BRAIN=1 — the stub then
          // registers the brain-only cross-agent tools (roster/dispatch/...).
          ...(isBrain ? { HERMIT_BRAIN: '1' } : {}),
        },
      },
    },
  };
  return JSON.stringify(config);
}

type PendingMsg = { id: string; sessionId: string; role: string; content: any; createdAt: string };
type PendingSession = {
  id: string; agentName: string; claudeSessionId: string | null;
  agentDirectory: string | null; isOrchestrator?: boolean;
  // Which backend runs this session. Absent means claude-tmux (the path this
  // whole file implements); 'pi-rpc' is handed off in deliverMessages.
  runtime?: string | null; runtimeProvider?: string | null; runtimeModel?: string | null;
  runtimeCredentialId?: string | null;
  // pi only: which mode recipe the child is spawned with. Already resolved
  // against the agent's default by the dashboard.
  runtimeMode?: string | null;
};

// One outbound chat-message sync (the shape /api/sync/chat-message accepts).
type SyncItem = {
  sessionId: string;
  role: string;
  content: unknown;
  externalId: string;
  claudeSessionId: string | null;
};

interface SessionState {
  claudeUuid: string;
  jsonlPath: string;
  stopWatcher: () => void;
  seenUuids: Set<string>;
  // Has the gateway already pushed claudeSessionId back to the DB for this row?
  // The dashboard's /api/sync/chat-message stamps it on first non-null arrival.
  uuidStamped: boolean;
  // Outbound sync coalescing (see queueSync/flushSync): transcript events buffer
  // here and flush in batches instead of one POST per event. Critical on a gateway
  // restart — watchTranscript replays the WHOLE transcript from line 1 and
  // seenUuids starts empty, so every session would otherwise re-POST its entire
  // history one request at a time and saturate the dashboard's event loop.
  syncBuf: SyncItem[];
  syncTimer: ReturnType<typeof setTimeout> | null;
}

// Per-session runtime state. Cleared on gateway restart; rebuilt lazily on
// next chatTick. The tmux pane survives gateway restarts so re-attach is cheap.
const sessionStates = new Map<string, SessionState>();
// Claude uuids handed to a spawn whose setup hasn't RESOLVED yet. sessionStates only
// learns a session's uuid at the end of setupSession, but an agent's chat sessions all
// share one project dir — so a sibling still inside a slow setup is invisible to the
// "is this transcript someone else's?" checks, and a concurrent `--resume` sniff could
// steal the file it just started writing (2026-07-25: a 186MB resume waited 3m23s, a
// fresh sibling spawned mid-wait, and both dashboard sessions ended up on ONE
// transcript — cross-posted replies + a delivery gate reading the wrong file).
// Reserving the uuid the instant we mint it closes that window.
const reservedUuids = new Map<string, string>();
// The per-session re-entrancy guards (setup / restart / hibernate) live in the
// shared op-locks owner (./op-locks): the kill/spawn can take up to ~2s while ticks
// re-fire every ~2s (setInterval doesn't await), so an overlapping tick must skip a
// session already in flight rather than double-process it.

// claudeSessionId as RECORDED IN THE DB, refreshed from every chatTick poll. The
// in-memory maps only know sessions this gateway process has already set up, so a
// session that hasn't been touched since the last restart is invisible to them —
// yet its uuid is just as owned. Cheap (one map rebuild per ~2s tick) and it makes
// the ownership check authoritative rather than best-effort.
let recordedUuids = new Map<string, string>();

// One in-flight delivery per session. See the guard in chatTick: a slow pi
// image delivery must not let concurrent ticks start a second one against the
// same un-acked row.
const inFlightDeliveries = new Map<string, Promise<void>>();

// Every claude uuid currently spoken for by ANOTHER CHAT session — live
// (sessionStates), still starting (reservedUuids), or recorded in the DB
// (recordedUuids), so two chats can never land on one transcript. `sessionId = null`
// ⇒ no session counts as self, so the result is every chat-owned uuid — see
// chatOwnedUuids. Chats are only half of what shares the project dir; the
// transcript-picking paths (resume sniff, drift adoption, orphan recovery) go
// through uuidsUnavailableTo, which adds the crons.
function uuidsOwnedByOtherSessions(sessionId: string | null): Set<string> {
  const owned = new Set<string>();
  for (const [sid, st] of sessionStates) if (sid !== sessionId) owned.add(st.claudeUuid);
  for (const [sid, uuid] of reservedUuids) if (sid !== sessionId) owned.add(uuid);
  for (const [sid, uuid] of recordedUuids) if (sid !== sessionId) owned.add(uuid);
  return owned;
}

// The same ownership set seen from OUTSIDE the chat runner: every uuid any chat session
// holds. A cron owns no chat session, so every chat transcript in the project dir it
// shares with the agent's chats is someone else's — cron-runner's drift-adopt excludes
// these (2026-08-09: two daily-report crons whose pinned transcript was ~1s late adopted
// the agent's live CHAT instead and reported the chat's last assistant message as the
// cron's result; the reports themselves had run fine).
export function chatOwnedUuids(): Set<string> {
  return uuidsOwnedByOtherSessions(null);
}

// Everything this session must NOT adopt: the uuids other chats hold, plus every
// uuid a cron fire is holding. Crons spawn into the same cwd, so their throwaway
// transcripts sit in the same project dir and look exactly like "a transcript
// that just appeared" to the resume sniff below.
//
// 2026-08-12, agent `ceo` on macmini002: a 27.2 MB `--resume` took ~10 minutes,
// a 2h cron fired inside that window, and resolveResumedUuid took the cron's
// brand-new transcript for the one claude had resumed into. The session bound
// itself to a throwaway pane — the user's message came back answered with the
// cron's "SKIP 非凌晨", and their real answer, written into the transcript this
// session had just stopped owning, surfaced two hours later as that cron's
// result. cron-runner has excluded chat-owned uuids since 2026-08-09; this is
// the other half of that.
function uuidsUnavailableTo(sessionId: string): Set<string> {
  const owned = uuidsOwnedByOtherSessions(sessionId);
  for (const uuid of cronOwnedUuids()) owned.add(uuid);
  return owned;
}

// ── Cancellation tick ────────────────────────────────────────────────────────

// Restart a single session: tear down in-memory state, kill the pane, post the
// "[session restarted]" system row. The next deliverMessages call sees
// paneAlive=false and respawns claude with --resume <claudeSessionId> (history
// preserved). Shared by chatRestartTick (the per-session restart button) and the
// machine-level "restart all sessions" op. Returns false if the session was
// already mid-restart (in-flight guard), so callers can skip acking it.
export async function restartOneSession(sessionId: string, stampMs: number): Promise<boolean> {
  // The kill can take up to 2s and ticks don't await each other — guard so
  // overlapping ticks don't re-process the same session.
  if (!tryAcquire('restart', sessionId)) return false;
  try {
    // Tear down in-memory state first so the next deliverMessages call hits
    // setupSession fresh (paneAlive=false → respawn with --resume).
    const state = sessionStates.get(sessionId);
    if (state) {
      try { state.stopWatcher(); } catch {}
      sessionStates.delete(sessionId);
    }
    reservedUuids.delete(sessionId);
    // Restart is what a user reaches for when a session is wedged, so it has to
    // free the thing that is actually running. For a pi session that is the RPC
    // child, not a pane: this used to kill a pane that never existed, post the
    // banner below, and leave the same child serving the same session — a
    // restart that restarted nothing. Same unconditional call as hibernate (we
    // cannot tell the backend from here; both are no-ops on the wrong one).
    await Promise.all(allRuntimes().map((r) =>
      r.stop({ sessionId, externalSessionId: '' }, 'kill').catch(() => undefined)));
    piStates.delete(sessionId);
    await killTmuxSession(sessionId, 2_000);
    console.log(`[chat-restart] killed session=${sessionId.slice(0, 8)}`);

    // Post a system row so the chat UI stops thinking it's mid-turn. externalId
    // is STABLE per restart (sessionId + stamp), so any overlapping tick or retry
    // collapses to a single banner via the sync route's (sessionId, externalId)
    // upsert — instead of spamming a fresh row every tick.
    await api
      .syncChatMessages([
        {
          sessionId,
          role: 'system',
          content: [{ type: 'text', text: '[session restarted — send a message to continue]' }],
          externalId: `restart-${sessionId}-${stampMs}`,
        },
      ])
      .catch((e) => console.error('[chat-restart] post system row failed:', e));
  } catch (e) {
    console.error('[chat-restart] kill failed:', e);
  } finally {
    release('restart', sessionId);
  }
  return true;
}

// Per-session restart: poll for `restartRequestedAt` rows, restart each, ack.
// Used when a single session is wedged but others on the same agent are fine.
export async function chatRestartTick() {
  let rows: Awaited<ReturnType<typeof api.pollSessionRestarts>>;
  try {
    rows = await api.pollSessionRestarts();
  } catch (e) {
    console.error('[chat-restart] poll failed:', e);
    return;
  }
  if (rows.length === 0) return;

  const ackIds: string[] = [];
  for (const row of rows) {
    const did = await restartOneSession(row.id, new Date(row.restartRequestedAt).getTime());
    if (did) ackIds.push(row.id);
  }
  try {
    await api.ackSessionRestart(ackIds);
  } catch (e) {
    console.error('[chat-restart] ack failed:', e);
  }
}

// ── Hibernation (resource governance) ─────────────────────────────────────────

// Hibernate one session: tear down in-memory state + kill the pane to free its
// ~500MB claude process. No "[restarted]" banner — the session is idle (reaper
// guards / user intent) and the 💤 badge explains it. claudeSessionId + transcript
// survive, so the next message respawns via --resume (the reattach loop skips the
// dead pane, so it stays asleep until the user sends). Returns false if already
// mid-hibernate so the caller skips acking it.
export async function hibernateOneSession(sessionId: string): Promise<boolean> {
  if (!tryAcquire('hibernate', sessionId)) return false;
  try {
    const state = sessionStates.get(sessionId);
    if (state) {
      try { state.stopWatcher(); } catch {}
      sessionStates.delete(sessionId);
    }
    reservedUuids.delete(sessionId);
    // A non-tmux backend has no pane; its child process is the thing to free.
    // Called unconditionally because we cannot tell from here which backend was
    // running: a session whose backend was just SWITCHED already reads as the
    // new one in the DB. stop() is a no-op when this session has no live child,
    // and killTmuxSession is a no-op when there is no pane, so both directions
    // land correctly and a plain hibernate now frees a pi session too (it used
    // to kill a pane that never existed and leave the child running).
    await Promise.all(allRuntimes().map((r) =>
      r.stop({ sessionId, externalSessionId: '' }, 'hibernate').catch(() => undefined)));
    piStates.delete(sessionId);
    await killTmuxSession(sessionId, 2_000);
    console.log(`[hibernate] killed session=${sessionId.slice(0, 8)}`);
    return true;
  } finally {
    release('hibernate', sessionId);
  }
}

// Manual hibernate requests (context-menu Hibernate). Mirrors chatRestartTick.
export async function chatHibernateTick() {
  let rows: Awaited<ReturnType<typeof api.pollHibernations>>;
  try {
    rows = await api.pollHibernations();
  } catch (e) {
    console.error('[hibernate] poll failed:', e);
    return;
  }
  if (rows.length === 0) return;
  const ackIds: string[] = [];
  for (const row of rows) {
    const did = await hibernateOneSession(row.id);
    if (did) ackIds.push(row.id);
  }
  try {
    await api.ackHibernated(ackIds);
  } catch (e) {
    console.error('[hibernate] ack failed:', e);
  }
}

export async function chatCancelTick() {
  let rows: Awaited<ReturnType<typeof api.pollChatCancellations>>;
  try {
    rows = await api.pollChatCancellations();
  } catch (e) {
    console.error('[chat-cancel] poll failed:', e);
    return;
  }
  if (rows.length === 0) return;

  const ackIds: string[] = [];
  for (const row of rows) {
    if (sessionStates.has(row.id)) {
      try {
        sendInterrupt(row.id);
        console.log(`[chat-cancel] sent Escape to session=${row.id.slice(0, 8)}`);
      } catch (e) {
        console.error('[chat-cancel] sendInterrupt failed:', e);
      }
    }
    // A pi session has no pane and no entry in sessionStates, so Escape was
    // never sent anywhere for it — Stop looked like it worked (the flag cleared)
    // while the turn ran on untouched. Its runtime owns the abort. Called
    // unconditionally for the same reason hibernate does: from here we cannot
    // tell which backend a session is on, and this is a no-op when it has no
    // live pi child.
    await Promise.all(allRuntimes().map((r) =>
      r.interrupt({ sessionId: row.id, externalSessionId: '' })
        .catch((e) => console.error(`[chat-cancel] ${r.kind} abort failed:`, e))));
    // Ack regardless — even if we didn't have an active state, the DB flag
    // needs clearing so the dashboard stops re-firing on every poll.
    ackIds.push(row.id);
  }
  try {
    await api.ackChatCancel(ackIds);
  } catch (e) {
    console.error('[chat-cancel] ack failed:', e);
  }
}

// ── Main tick ────────────────────────────────────────────────────────────────

export async function chatTick() {
  let payload: Awaited<ReturnType<typeof api.pollChatPending>>;
  try {
    payload = await api.pollChatPending();
  } catch (e) {
    console.error('[chat] poll failed:', e);
    return;
  }
  // Reattach JSONL watchers for alive sessions that lost theirs. sessionStates
  // is in-memory and wiped on every gateway restart; otherwise it's only rebuilt
  // when a user message arrives (deliverMessages → setupSession). A session
  // running an autonomous loop (cron / `/loop`) sends no user messages, so after
  // a gateway restart its cron-fired turns land in the JSONL with nothing tailing
  // it — the dashboard then shows only the iterations that ran before the restart
  // (the exact "loop reported once, then nothing" symptom). Proactively
  // reattaching here keeps autonomous turns flowing and backfills any missed
  // while the watcher was down (watchTranscript replays from line 1; the
  // dashboard upserts by externalId so re-forwarding is idempotent).
  //
  // setupSession reattaches without spawning a second claude when the pane is
  // alive (ensureSession no-ops on an existing pane) and never sends keys, so
  // this only attaches the tail. Sessions with a pending user message are left
  // to deliverMessages below, which sets the watcher up on the same path.
  recordedUuids = new Map(
    payload.sessions.filter((s) => s.claudeSessionId).map((s) => [s.id, s.claudeSessionId!]),
  );
  const havePending = new Set(payload.messages.map((m) => m.sessionId));
  for (const s of payload.sessions) {
    if (havePending.has(s.id)) continue;
    if (sessionStates.has(s.id) || isLocked('setup', s.id)) continue;
    // Don't reattach a session that's mid-restart: chatRestartTick is about to
    // (or is currently) killing its pane. Reattaching here would re-populate
    // sessionStates with a state pointing at the doomed pane (the stale-state
    // race that left dead panes un-respawned). The next user message respawns it.
    if (isLocked('restart', s.id)) continue;
    // NOTE: a missing claudeSessionId is NOT a skip. It used to be ("nothing to
    // tail yet"), which permanently stranded any pane whose uuid stamp never
    // reached the DB — the stamp rides the first sync batch, so a dashboard
    // timeout or a gateway restart in the seconds after the spawn loses it, and
    // the pane then ran untracked forever ("starting" on the dashboard while
    // tmux showed it working). setupSession recovers the uuid from the pane's
    // own argv; the pane check below is the real guard.
    if (!tmuxSessionExists(s.id)) continue; // pane not running — nothing to watch
    if (!tryAcquire('setup', s.id)) continue; // another path is already setting it up
    setupSession(s)
      .then((st) => { sessionStates.set(s.id, st); })
      .catch((e) => console.error(`[chat] watcher reattach failed for ${s.id.slice(0, 8)}:`, e))
      .finally(() => release('setup', s.id));
  }

  if (payload.messages.length === 0) return;

  const grouped = new Map<string, PendingMsg[]>();
  for (const m of payload.messages) {
    const arr = grouped.get(m.sessionId) ?? [];
    arr.push(m);
    grouped.set(m.sessionId, arr);
  }

  for (const [sessionId, msgs] of grouped) {
    if (isLocked('setup', sessionId)) continue;
    // Don't deliver into a session mid-restart: chatRestartTick is killing its
    // pane (up to a 2s grace after /exit). Sending now types the message into the
    // dying pane and loses it on exit — the same reason the reattach loop above
    // skips sessions mid-restart. Leave it queued (deliveredAt=null); once the
    // restart completes, the next chatTick respawns via --resume and delivers it
    // to the fresh pane. Reachable now that queued messages can sit pending across
    // a user-triggered restart (the message-queue feature).
    if (isLocked('restart', sessionId)) continue;
    // Never run two deliveries for one session at once. deliverMessages is
    // fire-and-forget and chatTick fires every ~2s, so a slow delivery — the pi
    // path relays + describes each attached image (~17s/layout pass) before it
    // submits — leaves the row un-acked long enough for the next ticks to read
    // it again and start MORE concurrent deliveries. Each one submits the same
    // message, which pi records as repeated user messages (measured: 17 copies
    // of one image message in the session file) and the agent answers each,
    // which reads as "the same message delivered over and over". The lock makes
    // the second-and-later deliveries wait: they re-check the queue on the next
    // tick, by which time the first has acked the row.
    if (inFlightDeliveries.has(sessionId)) continue;
    const session = payload.sessions.find((s) => s.id === sessionId);
    if (!session) continue;

    const p = deliverMessages(session, msgs).finally(() => inFlightDeliveries.delete(sessionId));
    inFlightDeliveries.set(sessionId, p);
    p.catch((e) => {
      console.error(`[chat] delivery failed for ${sessionId.slice(0, 8)}:`, e);
    });
  }
}

// Stream a slash-command's TUI panel back to the dashboard chat by polling
// `tmux capture-pane` and upserting a single system row (same externalId).
// The repeated upserts feed the SSE stream, so the user watches the panel
// grow live instead of seeing a single stale snapshot. Completion is read from
// claude's own footer: a long op like /compact shows "esc to interrupt" while
// it works, so we finish when that footer has cleared (the pane settled back to
// idle); a quick command that never shows it finishes when the panel stops
// changing. A 3-min hard cap backstops either path. If the pane advertises an
// "Esc to cancel/exit" hint, we send Escape once to dismiss the modal and keep
// capturing for the post-dismiss state.
async function streamSlashOutput({
  sessionId,
  cmd,
  paneN,
}: {
  sessionId: string;
  cmd: string;
  paneN: string;
}): Promise<void> {
  const POLL_FAST_MS = 700;           // ~1.4Hz — responsive for quick commands
  const POLL_SLOW_MS = 2_000;         // ease off once a long op (e.g. /compact) is clearly running
  const BACKOFF_AFTER_MS = 8_000;     // switch to slow polling past this point
  const STABLE_TICKS_DONE = 3;        // 3 quiet ticks ≈ done for instant/modal commands
  const SETTLE_TICKS_DONE = 2;        // 2 ticks with the work footer gone = a long op finished
  const MAX_DURATION_MS = 180_000;    // 3-min backstop — /compact on a big transcript is slow
  const ESC_HINT_RE = /\besc(?:ape)?\s+to\s+(?:cancel|exit|close|dismiss|return|back|quit|leave)\b/i;
  // claude's "turn in flight" spinner footer ("(12s · thinking)", and pre-2.x
  // "esc to interrupt"). /compact shows this while it reads + summarises; its
  // DISAPPEARANCE is how we know the command truly finished — far more reliable
  // than "text stopped changing", which a live spinner/percentage never satisfies
  // (the old 30s cap then truncated the panel mid-progress). Shared with pane.ts
  // so the Claude Code 2.x marker change is fixed in one place.
  const WORK_RE = WORK_MARKER_RE;
  const externalId = `slash-out-${sessionId}-${Date.now()}`;

  const start = Date.now();
  let lastText = '';
  let stableTicks = 0;
  let settledTicks = 0;
  let sawWorking = false;
  let escSent = false;

  // Small head-start so the first capture sees whatever claude printed when
  // the keys actually landed (`tmux capture-pane` is sync — no built-in wait).
  await new Promise((r) => setTimeout(r, 400));

  while (Date.now() - start < MAX_DURATION_MS) {
    let text = '';
    try {
      const r = spawnSync(
        'tmux',
        ['capture-pane', '-t', paneN, '-p', '-J', '-S', '-80'],
        { encoding: 'utf8', timeout: 4_000 },
      );
      if (r.status !== 0) break;
      const raw = (r.stdout || '').replace(/\s+$/g, '');
      if (raw) {
        const lines = raw.split('\n');
        let s = 0;
        while (s < lines.length && lines[s].trim() === '') s++;
        const tail = lines.slice(Math.max(s, lines.length - 40));
        text = tail.join('\n').trim();
      }
    } catch {
      break;
    }

    if (text && text !== lastText) {
      lastText = text;
      stableTicks = 0;
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      void api
        .syncChatMessages([
          {
            sessionId,
            role: 'system',
            content: [
              { type: 'text', text: `↳ \`${cmd}\` output (${elapsed}s):\n\n\`\`\`\n${text}\n\`\`\`` },
            ],
            externalId,
          },
        ])
        .catch(() => {});
    } else if (text) {
      stableTicks++;
    }

    // Track claude's work footer so we can tell "still compacting" from "done".
    const working = WORK_RE.test(text);
    if (working) sawWorking = true;

    // Auto-dismiss a TUI modal once. Keep capturing afterwards so the
    // post-Esc redraw lands in the same row.
    if (!escSent && ESC_HINT_RE.test(text)) {
      escSent = true;
      try {
        spawnSync('tmux', ['send-keys', '-t', paneN, 'Escape'], { timeout: 4_000 });
      } catch { /* best effort */ }
    }

    // Completion, two regimes:
    //  • Long op (we saw the work footer): done once it's been GONE for
    //    SETTLE_TICKS_DONE consecutive ticks — the pane settled back to idle.
    //    This is what lets /compact stream through to its real "Compacted"
    //    result instead of freezing at the old 30s cap mid-percentage.
    //  • Instant / modal command (footer never appeared): an unchanging panel
    //    for STABLE_TICKS_DONE ticks means it finished.
    if (sawWorking) {
      settledTicks = working ? 0 : settledTicks + 1;
      if (settledTicks >= SETTLE_TICKS_DONE) break;
    } else if (stableTicks >= STABLE_TICKS_DONE) {
      break;
    }

    // Poll fast at first (snappy for quick commands), then ease off once a long
    // op is clearly in flight — keeps a 60s compact from hammering capture-pane.
    const slow = sawWorking && Date.now() - start > BACKOFF_AFTER_MS;
    await new Promise((r) => setTimeout(r, slow ? POLL_SLOW_MS : POLL_FAST_MS));
  }

  // Final update with a "done" marker + total elapsed. If we never captured
  // anything (rare — `capture-pane` almost always succeeds on a live pane),
  // write a short note so the user isn't left with just the client-side
  // "↳ sent /X" stub and silence.
  const total = ((Date.now() - start) / 1000).toFixed(1);
  const finalText = lastText
    ? `↳ \`${cmd}\` output (${total}s · done):\n\n\`\`\`\n${lastText}\n\`\`\``
    : `↳ \`${cmd}\` produced no captured output (${total}s)`;
  await api
    .syncChatMessages([
      {
        sessionId,
        role: 'system',
        content: [{ type: 'text', text: finalText }],
        externalId,
      },
    ])
    .catch(() => {});
}

async function deliverMessages(session: PendingSession, msgs: PendingMsg[]) {
  // ── Non-tmux backends ──────────────────────────────────────────────────────
  // Everything below this block is Claude-Code-in-a-pane. A session on another
  // runtime hands off here, before any tmux work, and reuses only the outbound
  // sync coalescing. See docs/pi-runtime-design.md.
  const runtime = runtimeFor(session.runtime, session.runtimeMode);
  if (runtime) {
    const state = piState(session.id);
    try {
      const handle = await runtime.ensure(
        {
          id: session.id,
          agentName: session.agentName,
          agentDirectory: session.agentDirectory ?? path.join(AGENTS_ROOT, session.agentName),
          externalSessionId: session.claudeSessionId,
          provider: session.runtimeProvider,
          model: session.runtimeModel,
          mode: session.runtimeMode,
          credentialId: session.runtimeCredentialId,
        },
        (item) => queueSync(state, item),
      );

      // Same one-per-turn drain as the tmux path: if a turn is in flight, hold
      // the whole batch and let the next chatTick re-evaluate.
      if (await runtime.isWorking(handle)) return;

      const oldest = msgs[0];
      if (!oldest) return;
      let text = typeof oldest.content === 'string' ? oldest.content : extractText(oldest.content);

      // Relay + recognise attached images. tmux send-keys can't carry binaries,
      const relay = await relayImages([oldest.content]);
      if (relay.errors.length > 0) {
        console.warn(`[chat] pi image relay errors for ${session.id.slice(0, 8)}:`, relay.errors);
      }
      if (relay.paths.length > 0) {
        // Recognise every attachment concurrently — a layout pass runs ~17s, and
        // three screenshots in one message should not cost a minute of delivery
        // latency one after another.
        const described = await Promise.all(
          relay.paths.map(async (p) => {
            const desc = await describeImage(p);
            if (desc.ocr || desc.description) return formatVision(desc, p);
            return (
              `[上传的截图已缓存于 ${p}，但图片识别不可用（${desc.error || '未启用图片识别'}）。` +
              `如需查看内容，请用 describe_image 工具（参数 filePath=${p}）。]`
            );
          }),
        );
        text = [text, ...described].join('\n\n');
      }
      if (!text.trim()) return;

      const ok = await runtime.submit(handle, text, []);
      if (ok) await api.ackChatDelivered([oldest.id]).catch(() => {});
    } catch (e) {
      console.error(`[chat] ${runtime.kind} delivery failed for ${session.agentName}:`, e);
    }
    return;
  }

  // ── Idle gate (message queue) ──────────────────────────────────────────────
  // If claude is mid-turn, hold the ENTIRE pending batch: leave every row
  // deliveredAt=null and bail. The queue drains one message per turn — the next
  // chatTick (~2s) re-evaluates, and once the pane goes idle we dispatch the
  // single oldest message below. Only gate a pane that actually EXISTS; a brand-
  // new session (no pane yet) must fall through to setupSession. (capture-pane on
  // a missing pane returns false anyway; the explicit exists-check just avoids a
  // pointless 2s spawn against never-started sessions.)
  //
  // Debounce the gate against a single mis-read: a pane that's *settling* (the
  // previous turn's spinner still painted for a frame, or a transient capture
  // glitch) can read "working" once and then immediately go idle. Only hold the
  // batch if two reads ~400ms apart BOTH say working; a settling pane fails the
  // second read and we deliver. deliverMessages is fire-and-forget, so the extra
  // 400ms on the hold path costs no user-visible latency — the batch would stay
  // queued either way. (This kills the "sent to an idle agent, briefly queued"
  // case that survives the tightened WORK_MARKER_RE in pane.ts.)
  // Pass the transcript so a mid-tool-call turn on a narrow pane (truncated
  // "esc to interrupt") is still seen as working — otherwise we'd deliver the
  // queued batch INTO a running turn (tmux-inject mid-flight). Erring toward
  // "busy" here just holds the batch for the next ~2s chatTick; safe.
  const agentDir = session.agentDirectory ?? path.join(AGENTS_ROOT, session.agentName);
  const tp = sessionTranscriptPath(session.claudeSessionId, agentDir);
  if (tmuxSessionExists(session.id) && (await paneIsWorking(session.id, tp, agentDir, session.claudeSessionId))) {
    await new Promise((r) => setTimeout(r, 400));
    if (tmuxSessionExists(session.id) && (await paneIsWorking(session.id, tp, agentDir, session.claudeSessionId))) return;
  }

  // Ensure tmux pane + watcher are up.
  let state = sessionStates.get(session.id);
  // A restart (or any external tmux kill) can leave a STALE state pointing at a
  // dead pane: chatRestartTick deletes the state and THEN awaits killTmuxSession
  // (~2s), and a concurrent chatTick reattach can re-populate sessionStates during
  // that kill window (pane still briefly alive → tmuxSessionExists true). The
  // stale state then survives the kill, so the next deliver sends keys into a pane
  // that no longer exists ("tmux session not found") and never respawns. Guard:
  // if we have a cached state but the pane is gone, drop it so setupSession
  // respawns with --resume below.
  if (state && !tmuxSessionExists(session.id)) {
    try { state.stopWatcher(); } catch {}
    sessionStates.delete(session.id);
    reservedUuids.delete(session.id);
    state = undefined;
  }
  // Track a cold start (fresh spawn / --resume) so the submit-confirm below can
  // wait longer. A just-spawned claude — especially --resume reloading full
  // history, or one spawn in a post-gateway-restart herd — can take far longer
  // than the default 12s confirm window to become interactively ready, and the
  // user's first message sits typed-but-unsent in the composer until then.
  // (Logged incident 2026-06-04: a slow zhinan-gitlab spawn took >30s to write
  // its transcript; confirmSubmitted gave up at 12s → "composer still holds text
  // — message may be unsent", and the stranded text risks the next message
  // mashing into the same composer.)
  let freshSpawn = false;
  if (!state) {
    if (!tryAcquire('setup', session.id)) return;
    try {
      // Big-resume heads-up: a cold start that resumes a large recorded
      // transcript makes the user's first message sit at "排队中" for minutes
      // while claude reloads history (observed: an 8.5MB / 336k-token session
      // took >4min to boot before the first transcript write). Post a system
      // row NOW so the dashboard shows "正在恢复历史…" instead of a silently
      // stuck message. externalId is stable per session, so overlapping ticks
      // collapse to one row via the sync route's (sessionId, externalId) upsert.
      if (session.claudeSessionId && !tmuxSessionExists(session.id)) {
        const cwd = session.agentDirectory ?? path.join(AGENTS_ROOT, session.agentName);
        const tp = sessionTranscriptPath(session.claudeSessionId, cwd);
        if (!tp) {
          // claudeSessionId/cwd are both non-null here, so tp is only null if the
          // project-dir encoding failed — let setupSession resolve it fresh.
        } else {
          try {
            const mb = statSync(tp).size / (1024 * 1024);
            if (mb >= 1) {
              const estMin = Math.min(10, Math.max(1, Math.round(mb / 2)));
              await api
                .syncChatMessages([
                  {
                    sessionId: session.id,
                    role: 'system',
                    content: [
                      {
                        type: 'text',
                        text: `[gateway] ⏳ 正在恢复历史会话（约 ${mb.toFixed(1)} MB），预计 ${estMin} 分钟内完成，新消息将先排队…`,
                      },
                    ],
                    externalId: `resume-waking-${session.id}`,
                  },
                ])
                .catch(() => {});
            }
          } catch { /* transcript gone from disk — setupSession will spawn fresh */ }
        }
      }
      state = await setupSession(session);
      sessionStates.set(session.id, state);
      freshSpawn = true;
    } catch (e) {
      console.error(`[chat] setup failed for ${session.id.slice(0, 8)}:`, e);
      return;
    } finally {
      release('setup', session.id);
    }
  }

  // Sequential drain: dispatch ONLY the oldest pending message this turn. The
  // rest stay deliveredAt=null and are re-evaluated on the next chatTick (~2s);
  // once this message's turn ends and the pane goes idle, the next-oldest goes.
  // (The old behaviour coalesced all-pending into one '\n\n'-joined turn.)
  const msg = msgs[0];
  if (!msg) return;
  const textPart = extractText(msg.content);

  // Relay any attached images: download each from the dashboard into the local
  // gateway cache so the tmux-driven claude can Read them. Failed downloads
  // surface as a system row in the dashboard — they're not fatal to the turn.
  const relay = await relayImages([msg.content]);
  if (relay.errors.length > 0) {
    console.warn(`[chat] image relay errors for ${session.id.slice(0, 8)}:`, relay.errors);
    await api
      .syncChatMessages([
        {
          sessionId: session.id,
          role: 'system',
          content: [
            {
              type: 'text',
              text: `[gateway] failed to relay ${relay.errors.length} image(s): ${relay.errors.map((e) => e.url).join(', ')}`,
            },
          ],
          externalId: null,
        },
      ])
      .catch(() => {});
  }

  // Assemble the prompt: user text first, then explicit Read lines for each
  // cached image so claude consumes them via its Read tool (which is what
  // pipes the bytes into the context). tmux send-keys can't carry binaries.
  const promptParts: string[] = [];
  if (textPart) promptParts.push(textPart);
  // Archives are binary — Read'ing them is gibberish. Detect by extension and
  // tell claude to extract via Bash instead, so an uploaded .zip/.tar/.gz is
  // actually usable. Everything else flows through the normal `Read <path>`.
  const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', '7z', 'rar', 'zst']);
  const isArchive = (p: string) => ARCHIVE_EXTS.has((p.split('.').pop() || '').toLowerCase());
  // Audio is binary too — Read'ing it is gibberish. Tell claude to transcribe /
  // inspect it via Bash (whisper for speech, ffmpeg to inspect/convert) instead.
  const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac']);
  const isAudio = (p: string) => AUDIO_EXTS.has((p.split('.').pop() || '').toLowerCase());
  // Video is binary too, and Claude can't ingest it natively — Read'ing it is
  // gibberish. Tell claude to inspect with ffprobe, extract frames → Read them as
  // images, and/or transcribe the audio track via Bash. ffmpeg/ffprobe are on the
  // macOS agent host.
  const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpeg', 'mpg', '3gp', 'wmv']);
  const isVideo = (p: string) => VIDEO_EXTS.has((p.split('.').pop() || '').toLowerCase());
  // Office docs are binary too (zip+XML for the modern formats) — Read'ing them
  // is gibberish. Hand claude a per-type "convert via Bash" instruction so an
  // uploaded .docx/.xlsx/.pptx is actually usable. Tools confirmed on the macOS
  // agent host: textutil (Word, native) · python3 + pandas/openpyxl (Excel) · unzip.
  const officeHint = (p: string): string | null => {
    const e = (p.split('.').pop() || '').toLowerCase();
    if (e === 'doc' || e === 'docx' || e === 'odt') {
      return (
        `An uploaded Word document is at ${p} — it is binary, so do NOT Read it directly. ` +
        `Get its plain text with \`textutil -convert txt -stdout ${p}\` (macOS built-in).`
      );
    }
    if (e === 'xls' || e === 'xlsx' || e === 'ods') {
      return (
        `An uploaded spreadsheet is at ${p} — it is binary, so do NOT Read it directly. ` +
        `Convert it in Python (pandas + openpyxl are installed): ` +
        `\`pd.read_excel('${p}', sheet_name=None)\` returns {sheet: DataFrame}; print or write each sheet's \`.to_csv()\`. ` +
        `Fallback: it is a zip — \`unzip -o ${p} -d /tmp/xlsx\` then read xl/worksheets/*.xml + xl/sharedStrings.xml.`
      );
    }
    if (e === 'ppt' || e === 'pptx' || e === 'odp') {
      return (
        `An uploaded presentation is at ${p} — it is binary, so do NOT Read it directly. ` +
        `Pull the slide text with \`unzip -p ${p} 'ppt/slides/slide*.xml' | sed -E 's/<[^>]+>/ /g'\` ` +
        `(text lives in <a:t> elements), or use python-pptx if available.`
      );
    }
    return null;
  };
  for (const p of relay.paths) {
    const office = officeHint(p);
    if (isArchive(p)) {
      promptParts.push(
        `An uploaded archive is at ${p} — it is binary, so do NOT Read it directly. ` +
          `Run \`file ${p}\` to confirm the type, then extract it into a fresh temp directory ` +
          `(unzip / tar -xf / gunzip / 7z as appropriate) and inspect the extracted files.`,
      );
    } else if (isAudio(p)) {
      promptParts.push(
        `An uploaded audio file is at ${p} — it is binary, so do NOT Read it directly. ` +
          `Inspect it with \`ffmpeg -i ${p}\` (format / duration). For speech, transcribe via Bash ` +
          `with whisper / whisper-cpp if installed (\`command -v whisper whisper-cpp ffmpeg\` first); ` +
          `if no transcriber is available, tell the user what to install.`,
      );
    } else if (isVideo(p)) {
      promptParts.push(
        `An uploaded video file is at ${p} — it is binary, so do NOT Read it directly. ` +
          `First inspect it with \`ffprobe -hide_banner ${p}\` (duration / resolution / streams). ` +
          `To see the visuals, extract frames into a temp dir and Read those images — e.g. ` +
          `\`mkdir -p /tmp/vframes && ffmpeg -i ${p} -vf "fps=1,scale=-2:720" /tmp/vframes/f_%03d.jpg\` ` +
          `(1 fps, 720p — lower the fps for long clips so Read doesn't wedge on too many frames). ` +
          `For speech, extract the audio (\`ffmpeg -i ${p} -vn -ac 1 /tmp/vaudio.wav\`) and transcribe with ` +
          `whisper / whisper-cpp if installed (\`command -v ffmpeg ffprobe whisper whisper-cpp\` first); ` +
          `if no transcriber is available, tell the user what to install.`,
      );
    } else if (office) {
      promptParts.push(office);
    } else {
      promptParts.push(`Read ${p}`);
    }
  }
  const promptText = promptParts.join('\n\n');

  if (!promptText) {
    await api.ackChatDelivered([msg.id]).catch(() => {});
    return;
  }

  // Ack BEFORE sending so a sendKeys failure doesn't cause an infinite redeliver.
  // If sendKeys throws, we log; the watcher won't see the user prompt land in
  // the JSONL — the user can retry from the dashboard.
  await api.ackChatDelivered([msg.id]).catch(() => {});

  console.log(
    `[chat] → ${session.agentName} session=${session.id.slice(0, 8)} ` +
      `claude=${state.claudeUuid.slice(0, 8)} ` +
      `(${textPart.length}c text + ${relay.paths.length} image${relay.paths.length === 1 ? '' : 's'})`,
  );

  try {
    const trimmed = textPart.trim();
    if (trimmed.startsWith('/')) {
      // Slash commands print to claude's TUI panel but never touch the JSONL we
      // tail, so the dashboard wouldn't see `/status` etc. output. Send the command,
      // then stream the pane back via `streamSlashOutput` (repeated `capture-pane` +
      // upsert on the same externalId) so the user watches the output land live.
      sendKeys(session.id, promptText);
      const cmd = trimmed.split(/\s+/)[0];
      const paneN = tmuxPaneName(session.id);
      void streamSlashOutput({ sessionId: session.id, cmd, paneN });
    } else {
      // robustSubmit OWNS the keystrokes for normal messages: it waits for the `❯`
      // composer on a cold start, sends, confirms a turn actually started (the
      // transcript grew), and re-types once if a not-yet-ready TUI dropped the first
      // prompt (issue #2 — otherwise a dropped first message strands the chat on
      // "starting" forever). So we do NOT sendKeys here. It returns a non-'delivered'
      // outcome only if no turn ever started after all retries.
      let outcome = await robustSubmit(session, state, promptText, freshSpawn);

      // 'deaf-pane' = the pane is not reading stdin (see diagnoseFailedSubmit). No
      // number of retries fixes that, and leaving it alone is what turned one wedged
      // claude into 24h of a silently-swallowing session and one message lost for good
      // (2026-08-10). Replace the pane and re-send onto the replacement — we still hold
      // the text, which is the only reason it can be saved at all: it was never
      // submitted, so it is in no transcript, and it was acked, so it is not re-queued.
      if (outcome === 'deaf-pane') {
        await api
          .syncChatMessages([
            {
              sessionId: session.id,
              role: 'system',
              content: [{ type: 'text', text: '[gateway] ⚠️ 这个会话的 claude 进程输入通路已死（界面正常但收不到键盘输入）。正在杀掉并用 --resume 重启，然后自动重发你刚才那条消息，历史不会丢。' }],
              externalId: null,
            },
          ])
          .catch(() => {});
        if (await healDeafPane(session, state, promptText)) outcome = 'delivered';
      }

      if (outcome !== 'delivered') {
        console.warn(`[chat] ${session.id.slice(0, 8)}: message never started a turn after retries — likely unsent`);
        // Quote the message back. A never-submitted message is written to no transcript
        // and was acked out of the queue, so this row is the ONLY place it still exists
        // that the user can actually see — on 2026-08-10 the equivalent text was
        // reconstructed from a tmux pane by hand, and it would have been unrecoverable
        // had the pane been killed first. Truncated so a huge paste can't wreck the view.
        const echo = promptText.length > 600 ? `${promptText.slice(0, 600)}…（已截断）` : promptText;
        await api
          .syncChatMessages([
            {
              sessionId: session.id,
              role: 'system',
              content: [{
                type: 'text',
                text: '[gateway] ⚠️ 这条消息没能提交给 agent，需要你重发。原文：\n\n' +
                  `> ${echo.split('\n').join('\n> ')}`,
              }],
              externalId: null,
            },
          ])
          .catch(() => {});
      }
    }
  } catch (e) {
    console.error(`[chat] sendKeys failed for ${session.id.slice(0, 8)}:`, e);
    await api
      .syncChatMessages([
        {
          sessionId: session.id,
          role: 'system',
          content: [{ type: 'text', text: `[gateway] tmux send-keys failed: ${(e as Error).message}` }],
          externalId: null,
        },
      ])
      .catch(() => {});
  }
}

// ── Session setup (spawn or reattach) ────────────────────────────────────────

// claude `--resume <uuid>` used to fork a brand-new JSONL, but current versions APPEND to
// the resumed session's OWN <uuid>.jsonl (observed: the recorded transcript grows in
// place, no new file). Resolve the post-resume uuid by accepting EITHER a new
// (non-preexisting) uuid transcript, OR the recorded uuid's transcript growing past its
// captured pre-spawn size. getClaudeSessionUuid alone only matches a NEW uuid, so it hung
// 90s on the reuse case → setupSession threw → the resumed pane ran untracked.
export async function resolveResumedUuid(opts: {
  cwd: string;
  preExistingUuids: Set<string>;
  recordedUuid: string;
  baselineSize: number;
  timeoutMs: number;
  // Uuids owned by other sessions (live or still starting). A brand-new transcript in
  // this SHARED project dir is only ours if nobody else claims it — see (b). Re-read on
  // every poll, NOT captured once: on a big resume this loop runs for minutes, and the
  // sibling to exclude is usually one that spawns partway through the wait.
  exclude?: () => Set<string>;
}): Promise<string> {
  const projectDir = encodedProjectDir(opts.cwd);
  const recordedPath = path.join(projectDir, `${opts.recordedUuid}.jsonl`);
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const exclude = opts.exclude?.() ?? new Set<string>();
    // (a) current behavior FIRST — claude resumed into the recorded uuid's own
    // transcript. Checked before (b) because appending in place is what current
    // claude does, while a NEW file in this shared dir is just as likely to be a
    // sibling chat's fresh spawn; preferring growth keeps the ambiguous case ours.
    try {
      if (statSync(recordedPath).size > opts.baselineSize) return opts.recordedUuid;
    } catch { /* recorded transcript not present */ }
    // (b) older behavior — a brand-new uuid transcript materialized. Skip uuids owned
    // by another session: an agent's chats share this project dir, so during a long
    // resume a sibling's fresh spawn shows up here as a "new" transcript, and adopting
    // it cross-wires the two sessions onto one file (2026-07-25 incident).
    try {
      for (const f of readdirSync(projectDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const uuid = f.slice(0, -6);
        if (opts.preExistingUuids.has(uuid)) continue;
        if (exclude.has(uuid)) continue;
        if (statSync(path.join(projectDir, f)).size > 0) return uuid;
      }
    } catch { /* project dir not ready yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for resumed claude transcript in ${projectDir}`);
}

async function setupSession(session: PendingSession): Promise<SessionState> {
  // DB-leader: the agent's actual on-disk path lives on Agent.directory and the
  // dashboard joins it onto pollPending. Fall back to the old AGENTS_ROOT-based
  // guess only if the dashboard didn't supply one (older dashboard or a brand-
  // new create where the scaffold ack hasn't filled in `directory` yet — that
  // case will resolve to the same AGENTS_ROOT/<name> path the scaffold uses).
  const cwd = session.agentDirectory ?? path.join(AGENTS_ROOT, session.agentName);

  // If the gateway restarted but the tmux pane is still alive, just reattach
  // the watcher — don't spawn a second claude in the same pane.
  const paneAlive = tmuxSessionExists(session.id);

  // Pre-generate the claude session uuid for fresh spawns so we never race on
  // "which new jsonl is mine?" when two sessions start against the same agent
  // cwd at the same time. For resume, claude generates its own new uuid that
  // includes the resumed history — we sniff via getClaudeSessionUuid.
  const claudeArgs: string[] = [];
  let claudeUuid: string;
  let waitForResumeUuid = false;
  let resumeBaselineSize = 0;

  if (paneAlive && session.claudeSessionId) {
    // Already running — trust the DB's recorded claude uuid…
    claudeUuid = session.claudeSessionId;
    // …but guard against uuid DRIFT (issue #3): if a pane's claude was respawned
    // WITHOUT `--session-id` (an idle-reap / external restart), it minted its own
    // uuid while the DB still points at the recorded one — so the watcher tails a
    // `<recorded>.jsonl` that never appears and replies silently stop, with no
    // self-heal. If the recorded uuid has no transcript on disk but the pane is
    // writing a different one, adopt that live transcript. Exclude uuids owned by
    // OTHER live sessions (an agent's chat sessions all share one project dir) so we
    // never cross-wire two chats onto the same transcript. onTranscriptEvent then
    // re-stamps claudeSessionId once we tail the right file → self-healing + durable.
    const transcripts = listTranscripts(cwd);
    const recorded = transcripts.find((t) => t.uuid === claudeUuid);
    if (!recorded || recorded.size === 0) {
      // Exclude the recorded uuid itself + uuids owned by OTHER sessions, live or still
      // starting (an agent's chat sessions all share one project dir) so we never
      // cross-wire two chats onto the same transcript.
      const exclude = uuidsUnavailableTo(session.id);
      exclude.add(claudeUuid);
      // Require a RECENTLY-written transcript — the live pane's claude is actively
      // writing, whereas a stale OLD session's transcript is not. This also stops us
      // adopting an old transcript if a just-spawned session is reattached before its
      // own first write (recorded size 0 but not actually drift).
      //
      // …but that freshness bound applies ONLY to the size-0 case (recorded file exists,
      // just hasn't been written yet). When the recorded transcript is MISSING ENTIRELY —
      // pruned by Claude Code's retention, or the uuid stamp was lost so the DB points at a
      // uuid that never got a file — there is no size-0 ambiguity: the newest unclaimed
      // transcript IS the live pane's, at ANY age. So we pass NO upper age bound
      // (maxAgeMs undefined) there instead of the 5-min FRESH_MS; applying the bound
      // stranded sessions on "starting" forever when the recorded uuid was pruned AND the
      // live pane had gone idle >5 min before the reattach — the drift never healed, so
      // replies never synced (observed 2026-07-13: zhinan-dingding pinned to a pruned uuid,
      // its real transcript last written ~10 min earlier → excluded by FRESH_MS → stuck).
      const FRESH_MS = 5 * 60_000;
      const live = pickLiveTranscript(
        transcripts,
        { exclude, maxAgeMs: recorded ? FRESH_MS : undefined },
        Date.now(),
      );
      if (live) {
        console.warn(
          `[chat] ${session.id.slice(0, 8)}: claude-session uuid drift — recorded ${claudeUuid.slice(0, 8)} ` +
            `has no transcript; adopting live ${live.uuid.slice(0, 8)}`,
        );
        claudeUuid = live.uuid;
      }
    }
  } else if (paneAlive && !session.claudeSessionId) {
    // ORPHANED PANE: claude is running but the DB never learned its uuid. The stamp
    // rides the first sync batch, so a dashboard timeout or a gateway restart within
    // seconds of the spawn drops it — and the old code then minted a RANDOM uuid here,
    // tailing a transcript that would never exist. The pane worked away with nobody
    // listening: no replies synced, state stuck on "starting" (2026-07-25,
    // finance-agent). We spawned this claude ourselves with `--session-id`, so its
    // argv is ground truth — take the uuid from there, and let the next sync stamp it
    // back to the DB (uuidStamped stays false below).
    const fromPane = paneClaudeSessionId(session.id);
    if (fromPane && uuidsUnavailableTo(session.id).has(fromPane)) {
      // Another session already owns it — adopting would cross-wire two chats onto one
      // transcript. Better to stay unstamped and let the next respawn sort it out.
      console.warn(
        `[chat] ${session.id.slice(0, 8)}: pane uuid ${fromPane.slice(0, 8)} is owned by another ` +
          `session — refusing to adopt`,
      );
      claudeUuid = randomUUID();
    } else if (fromPane) {
      console.warn(
        `[chat] ${session.id.slice(0, 8)}: no claude uuid on record but the pane is alive — ` +
          `recovered ${fromPane.slice(0, 8)} from its argv`,
      );
      claudeUuid = fromPane;
    } else {
      claudeUuid = randomUUID();
    }
  } else if (session.claudeSessionId && !paneAlive && existsSync(path.join(encodedProjectDir(cwd), `${session.claudeSessionId}.jsonl`))) {
    // Resume: older claude forked a brand-new JSONL, but current versions APPEND to the
    // resumed session's OWN uuid transcript. Record its pre-spawn size so we can detect
    // the resume either way (resolveResumedUuid). Sniff the uuid after spawn.
    // (Guarded on the transcript still EXISTING — see the fresh fallback below.)
    claudeArgs.push('--resume', session.claudeSessionId);
    waitForResumeUuid = true;
    claudeUuid = ''; // filled in after spawn
    try {
      resumeBaselineSize = statSync(path.join(encodedProjectDir(cwd), `${session.claudeSessionId}.jsonl`)).size;
    } catch { resumeBaselineSize = 0; }
  } else {
    // Fresh: pre-assign uuid via --session-id (added by ensureSession). This is ALSO the
    // fallback when a recorded claudeSessionId's transcript is GONE from disk: Claude Code
    // prunes old transcripts (~cleanupPeriodDays, default 30d), so a long-idle session's
    // <uuid>.jsonl ages out. `claude --resume <that-uuid>` then errors "No conversation
    // found" and exits instantly → resolveResumedUuid waits the full 4-min timeout for a
    // transcript that never comes → setup fails → the wake retries every tick FOREVER and
    // the queued message never lands (observed: a 5-week-old zhinan-dingding session).
    // Detecting the missing file here and spawning fresh unwedges it — claude's in-memory
    // history is already unrecoverable (gone from disk), but the pane comes up, the new
    // uuid is stamped back to the DB, and the pending message is delivered.
    if (session.claudeSessionId && !paneAlive) {
      console.warn(
        `[chat] ${session.id.slice(0, 8)}: recorded claude uuid ${session.claudeSessionId.slice(0, 8)} has no ` +
          `transcript on disk (pruned) — cannot --resume; starting a FRESH claude session`,
      );
    }
    claudeUuid = randomUUID();
  }

  // Claim the uuid before the spawn: from here until sessionStates learns it, a
  // sibling session's `--resume` sniff would otherwise see our brand-new transcript
  // as an unclaimed "new uuid" and adopt it. (Resume spawns claim theirs after
  // resolveResumedUuid picks it, below — until then they own nothing.)
  if (claudeUuid) reservedUuids.set(session.id, claudeUuid);

  // Wire the hermit-ui MCP stub on every spawn (fresh OR --resume). claude
  // picks up the in-pane config and exposes mcp__hermit__{set_session_title,
  // log_status, attach_image, attach_file} to the agent. Reattach path skips this — the
  // already-running claude inherited its mcp-config at original spawn.
  if (!paneAlive) {
    // Full-autonomy (2026-06-02): dashboard-chat sessions run gate-free, matching
    // the agents' own (already-bypass) main sessions. The web-permission hook
    // self-defers in bypassPermissions mode, so nothing routes to the web and no
    // invisible TUI prompt can hang the chat. Revert this flag to restore gating.
    claudeArgs.push('--dangerously-skip-permissions');
    claudeArgs.push('--mcp-config', buildMcpConfigArg(session.id, session.isOrchestrator ?? false));
    // Default dashboard chat sessions to the highest reasoning effort. settings.json's
    // `effortLevel` only accepts low/medium/high, so `max` (top of low/medium/high/xhigh/
    // max) must come from the launch flag. Applies to fresh AND --resume spawns; an
    // already-running pane keeps its effort until it respawns. An unknown value would
    // just warn + fall back to default, so this can never break the launch.
    claudeArgs.push('--effort', 'max');
  }

  const { created, preExistingUuids } = ensureSession({
    sessionId: session.id,
    cwd,
    claudeArgs,
    claudeSessionUuid: waitForResumeUuid ? undefined : claudeUuid || undefined,
    // Pane env inherited by claude's PreToolUse permission hook so it can reach
    // the dashboard (URL + key) and resolve this session — never on argv.
    // CLAUDE_CODE_DISABLE_AUTO_MEMORY=1: unify memory behavior with the pi
    // backend — no automatic index injection / auto-extract in cc either; both
    // backends read memory on demand via the workspace <agent>/memory/auto/ link.
    env: {
      HERMIT_DASHBOARD_URL: DASHBOARD_URL,
      HERMIT_KEY: ASST_KEY,
      HERMIT_SESSION_ID: session.id,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    },
  });

  if (waitForResumeUuid) {
    // `claude --resume` on a big session blocks on an in-pane "resume from
    // summary / full / don't ask" prompt the web can't answer — auto-accept
    // "full session" (keep history) in the background so the await below isn't
    // waiting on a hung pane. Longer timeout: answering the prompt + loading the
    // full history can exceed the 30s default.
    void acceptResumePromptAsFull(session.id).catch((e) =>
      console.error(`[resume-prompt] ${session.id.slice(0, 8)}:`, e),
    );
    // Accept a brand-new uuid (older claude) OR the recorded uuid's transcript growing
    // past its pre-spawn size (current claude appends to it). Waiting only for a NEW uuid
    // hung on the reuse case → setup threw → the resumed pane ran untracked (replies never
    // synced, queued messages stuck at "排队中").
    //
    // Timeout scales with the transcript being loaded — loading multi-MB history
    // before the first transcript write is the dominant cost, and a fixed 240s
    // window kept getting blown by genuinely large sessions (observed: an 8.5MB /
    // 336k-token resume took >4min and timed out at 240s, only self-healing
    // because the next 2s tick re-delivered). Floor stays 240s (a zhinan-gitlab
    // 2.1M session took ~90s and blew the old 90s window by a hair); +60s per MB
    // covers the giants (8.5MB → 12min). Only THIS session's setup waits; other
    // sessions' ticks are unaffected.
    const resumeTimeoutMs = 240_000 + Math.ceil(resumeBaselineSize / (1024 * 1024)) * 60_000;
    claudeUuid = await resolveResumedUuid({
      cwd,
      preExistingUuids,
      recordedUuid: session.claudeSessionId!,
      baselineSize: resumeBaselineSize,
      timeoutMs: resumeTimeoutMs,
      // Sampled per poll, not once up front: this wait can run for MINUTES on a big
      // resume, and the sibling that must be excluded is typically one that spawns
      // partway through it.
      exclude: () => uuidsUnavailableTo(session.id),
    });
    reservedUuids.set(session.id, claudeUuid);
  }
  // A fresh spawn does NOT wait for its transcript. Claude Code creates
  // <uuid>.jsonl only when the FIRST prompt is submitted — never at startup — so
  // waiting for it here is a deadlock against the very message we are holding, and
  // it always ran to the full timeout: measured on a real agent dir, the REPL is
  // ready at 1.3s and the file still does not exist at 75s. That put a flat ~30s
  // on the first message of EVERY new chat (mac-local: one `awaitTranscript`
  // timeout per fresh spawn, 7-9 a day, each matching a 30-32s delivery lag).
  // Nothing downstream needs the file to exist yet: watchTranscript tails it with
  // `tail -n +1 -F`, which waits for a missing path and replays from line 1 when it
  // appears, and sendPrompt's cold-start path does its own waitForReplReady before
  // typing. (The --resume branch above is different and still waits: there the
  // transcript is what tells us WHICH uuid claude resumed into.)

  const jsonlPath = path.join(encodedProjectDir(cwd), `${claudeUuid}.jsonl`);

  const state: SessionState = {
    claudeUuid,
    jsonlPath,
    stopWatcher: () => {},
    seenUuids: new Set<string>(),
    uuidStamped: !!session.claudeSessionId && session.claudeSessionId === claudeUuid,
    syncBuf: [],
    syncTimer: null,
  };
  state.stopWatcher = watchTranscript(jsonlPath, (ev) => onTranscriptEvent(session.id, ev, state));

  console.log(
    `[chat] setup session=${session.id.slice(0, 8)} agent=${session.agentName} ` +
      `claude=${claudeUuid.slice(0, 8)} (created=${created}, paneAlive=${paneAlive})`,
  );

  return state;
}

// ── Transcript event → ChatMessage row ───────────────────────────────────────

// Coalesce outbound syncs so a full-transcript replay drains in a few batch POSTs
// instead of one per event. Flush when the buffer hits SYNC_BATCH_MAX (a replay
// burst fills synchronously within one tail chunk) or SYNC_DEBOUNCE_MS after the
// first buffered event (a live turn trickles one block at a time, so this stays
// prompt). The pending timer's closure keeps `state` alive until it fires, so a
// torn-down session's tail still flushes; anything lost to a hard process kill is
// re-synced by the next attach's replay (upserts are idempotent).
const SYNC_BATCH_MAX = 25;
const SYNC_DEBOUNCE_MS = 120;

function flushSync(state: SessionState, attempt = 0) {
  if (state.syncTimer) {
    clearTimeout(state.syncTimer);
    state.syncTimer = null;
  }
  if (state.syncBuf.length === 0) return;
  const batch = state.syncBuf;
  state.syncBuf = [];
  const stamping = batch.some((b) => b.claudeSessionId != null);
  api
    .syncChatMessages(batch)
    .then(() => {
      if (stamping) state.uuidStamped = true;
    })
    .catch((e) => {
      console.error('[chat] sync batch failed:', e);
      // DON'T drop the batch. A transient failure — the dashboard 502-ing under a
      // post-restart reattach-replay storm, a network blip — would otherwise strand
      // these rows until the next full reattach replay, which `seenUuids` then dedupes
      // away, so the content (and any claudeSessionId stamp riding it) is lost for good.
      // That is the shared root of two observed wedges: a fresh-spawn uuid stamp eaten
      // by a timeout (DB left pointing at a dead uuid → session unwakeable), and a full
      // replay eaten by the restart storm (replies never surfaced → session stuck
      // "starting"). Re-queue at the FRONT and retry with backoff — syncChatMessages
      // upserts by externalId, so re-sending is idempotent; the backoff also spreads a
      // reattach storm out over time instead of hammering the dashboard in lockstep.
      if (attempt < 5) {
        state.syncBuf = batch.concat(state.syncBuf);
        if (state.syncTimer) clearTimeout(state.syncTimer);
        state.syncTimer = setTimeout(() => flushSync(state, attempt + 1), Math.min(2000, 200 * 2 ** attempt));
      } else {
        console.error(`[chat] sync batch DROPPED after ${attempt} retries (${batch.length} rows) — re-syncs only on a fresh reattach`);
      }
    });
}

// Sync-coalescing state for pi sessions.
//
// pi sessions need the same batching/retry as tmux ones — a gateway restart
// replays their durable entries the same way — but none of the tmux fields.
// `uuidStamped` starts true because the pi runtime stamps its own session id
// on every item it emits rather than on a first-arrival basis.
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

function queueSync(state: SessionState, item: SyncItem) {
  state.syncBuf.push(item);
  if (state.syncBuf.length >= SYNC_BATCH_MAX) {
    flushSync(state);
  } else if (!state.syncTimer) {
    state.syncTimer = setTimeout(() => flushSync(state), SYNC_DEBOUNCE_MS);
  }
}

function onTranscriptEvent(chatSessionId: string, ev: any, state: SessionState) {
  if (!ev || typeof ev !== 'object') return;
  if (!ev.uuid) return; // skip events without a stable id (queue-ops, etc.)
  if (state.seenUuids.has(ev.uuid)) return;
  state.seenUuids.add(ev.uuid);

  const stampUuid = !state.uuidStamped ? state.claudeUuid : null;

  if (ev.type === CcEvent.assistant && ev.message?.content) {
    // Assistant turn — text, tool_use, thinking blocks.
    const content = normalizeContent(ev.message.content);
    if (content.length === 0) return;
    queueSync(state, {
      sessionId: chatSessionId,
      role: 'assistant',
      content,
      externalId: ev.uuid,
      claudeSessionId: stampUuid,
    });
    return;
  }

  if (ev.type === CcEvent.user && ev.message?.content && Array.isArray(ev.message.content)) {
    // Only forward user events with tool_result blocks (claude's reply to a
    // tool_use). Skip plain user prompts — the dashboard already wrote those
    // rows when it sent them, and re-syncing would create a duplicate-text
    // row with the wrong externalId.
    const blocks = ev.message.content;
    if (!hasToolResult(blocks)) return;
    queueSync(state, {
      sessionId: chatSessionId,
      role: 'user',
      content: blocks,
      externalId: ev.uuid,
      claudeSessionId: stampUuid,
    });
    return;
  }

  // Other event types (attachment, permission-mode, file-history-snapshot,
  // queue-operation, system errors) are internal — don't forward.
}

// ── Utilities ────────────────────────────────────────────────────────────────

// Current byte size of a transcript file (0 if it doesn't exist yet). GROWTH is
// the ground-truth signal that a sent message actually reached claude and a turn
// started — distinguishing a real submit from a DROPPED message, which leaves the
// composer just as empty as a submitted one does.
function transcriptSize(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}

/**
 * Robust delivery. The Ink TUI can swallow a prompt AND its submit Enter, leaving
 * the composer EMPTY — which is indistinguishable, by looking at the composer, from
 * a message that submitted cleanly. So the composer is never the proof; the proof is
 * that a turn actually STARTED, i.e. the transcript grew. Four defenses:
 *   1. on a cold start, wait for the `❯` composer to render before the first
 *      keystroke (+ a short settle — Ink can still drop the very first keys right
 *      after `❯` appears);
 *   2. before EVERY send, make sure the composer — and not some widget painted under
 *      it — actually has focus (see dismissFocusStealer);
 *   3. confirm a turn started before trusting the send, on EVERY path;
 *   4. if no turn started and the composer is empty, the text was dropped → re-send
 *      once. If the composer still HOLDS text, only re-press Enter (never re-type →
 *      never a duplicate turn).
 * Happy path is unchanged: a clean send grows the transcript within a second and it
 * returns 'delivered' immediately.
 *
 * Defense 3 used to be cold-start-only, and that hole is what 2026-08-14 found: TEN
 * sessions on one machine were each holding a message that had been typed into the
 * pane and then vanished — no turn, no reply, no warning. The warm path sent, saw a
 * cleared composer, and returned 'delivered'; the drop it cannot see happens exactly
 * where these sessions live — a big, long-running chat still rendering the previous
 * turn's output reads as idle to the deliver gate and eats the keystrokes anyway. The
 * user was told nothing, because 'delivered' is what suppresses the warning, and the
 * text existed nowhere but a pane's placeholder — recoverable only by hand, days later.
 * A warm pane is not a safer pane; it is the same pane one turn later.
 *
 * Re-typing cannot duplicate a turn: growth from ANY source — including a turn already
 * in flight that our message merely queued behind — counts as started and returns
 * before the re-send. The only way to reach the second send is a transcript that did
 * not move at all, and a transcript that did not move ran nothing to duplicate.
 *
 * On failure it says WHICH failure, because the two need opposite responses:
 *   'deaf-pane' — the pane is not reading stdin at all (see diagnoseFailedSubmit).
 *                 Retrying is pointless; the pane has to be replaced.
 *   'unsent'    — the message did not start a turn, but the pane still responds.
 *                 Tell the user; a retry may well work.
 */
type SubmitOutcome = 'delivered' | 'deaf-pane' | 'unsent';

// Everything robustSubmit does to the world outside the transcript file, injectable
// so the unit test can drive the sequence without a tmux pane (and without its naps).
export type SubmitDeps = {
  sendKeys: (sessionId: string, text: string) => void;
  confirmSubmitted: (sessionId: string, tries?: number) => Promise<boolean>;
  readComposer: (sessionId: string) => 'text' | 'clear' | 'unknown';
  waitForReplReady: (sessionId: string, timeoutMs: number) => Promise<unknown>;
  dismissFocusStealer: (sessionId: string) => Promise<'none' | 'dismissed' | 'stuck'>;
  diagnoseFailedSubmit: (sessionId: string, text: string, started: () => boolean) => Promise<SubmitOutcome>;
  nap: (ms: number) => Promise<void>;
};

const REAL_SUBMIT_DEPS: SubmitDeps = {
  sendKeys,
  confirmSubmitted,
  readComposer,
  waitForReplReady,
  dismissFocusStealer,
  diagnoseFailedSubmit,
  nap: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
};

export async function robustSubmit(
  session: Pick<PendingSession, 'id'>,
  state: Pick<SessionState, 'jsonlPath'>,
  promptText: string,
  freshSpawn: boolean,
  deps: SubmitDeps = REAL_SUBMIT_DEPS,
): Promise<SubmitOutcome> {
  const { sendKeys, confirmSubmitted, readComposer, waitForReplReady, dismissFocusStealer, diagnoseFailedSubmit, nap } = deps;
  const short = session.id.slice(0, 8);

  // Growth is proof a turn ran, and its absence is the corroboration
  // diagnoseFailedSubmit needs before it is allowed to condemn a pane.
  const base = transcriptSize(state.jsonlPath);
  const started = () => transcriptSize(state.jsonlPath) > base;
  const awaitTurn = async (ticks: number) => {
    for (let i = 0; i < ticks && !started(); i++) await nap(500);
    return started();
  };

  if (freshSpawn) {
    // The Ink TUI may not be up yet at all.
    await waitForReplReady(session.id, 45_000);
    await nap(800); // settle: Ink can drop the very first keys right after `❯` renders
  }
  // A cold pane gets the longer budgets: a --resume reloading full history can take
  // minutes to become interactive, while a warm one either moves in a second or is
  // not going to. Both are ceilings on a failing send, not on a working one.
  const enterTries = freshSpawn ? 120 : 40; // re-press Enter until the composer clears
  const turnTicks = freshSpawn ? 30 : 20;   // ≤15s / ≤10s for the turn's first line

  for (let send = 0; send < 2; send++) {
    // Never type into a pane whose focus is somewhere else — an artifact chip holding
    // it swallows the whole burst, and the message is gone rather than late.
    const focus = await dismissFocusStealer(session.id);
    if (focus !== 'none') {
      console.warn(
        `[chat] ${short}: an overlay had focus, not the composer — pressed x to dismiss it (${focus})`,
      );
    }
    sendKeys(session.id, promptText);            // type + submit
    await confirmSubmitted(session.id, enterTries);
    if (await awaitTurn(turnTicks)) return 'delivered';
    // No turn ran. If text is still buffered it only needs more Enter (hammer it,
    // never re-type → no duplicate). If the composer is empty, it was dropped → re-send.
    if (readComposer(session.id) === 'text') {
      await confirmSubmitted(session.id, 120);
      if (await awaitTurn(turnTicks)) return 'delivered';
      return diagnoseFailedSubmit(session.id, promptText, started);
    }
    // composer empty + nothing started → dropped → loop re-sends once
  }
  return started() ? 'delivered' : 'unsent';
}

/**
 * We typed a message, pressed Enter dozens of times over ≥20s, and no turn started.
 * Ask the pane the one question that separates "busy or unlucky" from "dead": is
 * anything reading its stdin?
 *
 * This is the check the codebase was missing on 2026-08-10. Every gate here — the
 * idle gate, the deliver gate, the reattach path — asks whether the PANE EXISTS, and
 * a claude with a wedged stdin loop passes all of them while silently swallowing
 * every message sent to it. Ours sat "healthy" for 24h: process up, 0% CPU, TUI
 * painting normally, and one user message lost for good because it never got
 * submitted and so was never written to any transcript.
 *
 * The verdict kills a process, so it is deliberately hard to reach. It reproduces the
 * criteria chain the 2026-08-10 diagnosis was built on, and every link must hold:
 *
 *   ① the composer is still holding OUR message  — probeInputPath's expectText guard,
 *      which is what keeps a pane merely BLOCKED (permission prompt, resume picker —
 *      both paint a `❯`) from being mistaken for a dead one;
 *   ② the transcript never grew — no turn started by any route. Growth means something
 *      in there is alive, and that alone vetoes the whole verdict;
 *   ③ a typed character produced no reaction — twice, seconds apart. One round is not
 *      enough: this box runs a dozen claudes and can stall a healthy TUI, and a stall
 *      resolves given a moment while a corpse looks identical on every retry.
 *
 * Anything short of all three returns 'unsent' — we tell the user and leave the pane
 * alone. Being wrong in that direction costs a re-send; being wrong the other way kills
 * someone's working session.
 */
async function diagnoseFailedSubmit(
  sessionId: string,
  promptText: string,
  started: () => boolean,
): Promise<SubmitOutcome> {
  const short = sessionId.slice(0, 8);
  if (started()) return 'unsent'; // ② something ran — whatever went wrong, the pane is not deaf

  if (await probeInputPath(sessionId, { expectText: promptText }) !== 'deaf') return 'unsent';

  // Second opinion after a pause, for the "healthy but wedged for a few seconds" case.
  console.warn(`[chat] ${short}: pane ignored a keystroke — re-checking before condemning it`);
  await new Promise((r) => setTimeout(r, 5_000));
  if (started()) return 'unsent';
  if (await probeInputPath(sessionId, { expectText: promptText }) !== 'deaf') return 'unsent';

  console.error(
    `[chat] ${short}: pane INPUT PATH IS DEAD — composer held our text through every Enter, ` +
      `no transcript growth, and two keystroke probes 5s apart got no reaction. The claude ` +
      `process is alive and painting but is not reading stdin; replacing it.`,
  );
  return 'deaf-pane';
}

/**
 * Replace a pane whose input path is dead, and re-deliver the message onto its
 * replacement.
 *
 * The re-delivery is the point. `deliverMessage` acks the row BEFORE sending (so a
 * throw can't cause an infinite redeliver loop), which means by the time we get here
 * the message exists nowhere but this dead pane's composer — never submitted, so never
 * in a transcript, and already acked, so never re-queued. Killing without re-sending
 * would destroy it exactly the way the 2026-08-10 incident did. So we carry
 * `promptText` across the respawn ourselves.
 *
 * The conversation survives the kill: setupSession re-spawns with `--resume <uuid>`
 * against the on-disk transcript, so only the wedged process is lost.
 *
 * Returns true if the message landed on the new pane.
 */
async function healDeafPane(session: PendingSession, state: SessionState, promptText: string): Promise<boolean> {
  const short = session.id.slice(0, 8);
  // Hold the SAME lock the spawn path takes, for the whole kill→respawn→resend. The
  // heal drops sessionStates before the pane is gone, which is precisely the window in
  // which a concurrent chatTick would see "no state" and spawn its own claude for this
  // session. If another setup is already in flight, do nothing and let it finish —
  // never fight it.
  if (!tryAcquire('setup', session.id)) {
    console.warn(`[chat] ${short}: deaf-pane heal skipped — another setup holds the lock`);
    return false;
  }
  try {
    // Read the composer BEFORE the kill: this is the last moment the stranded text
    // exists anywhere on the machine.
    const stranded = readComposerText(session.id);

    try { state.stopWatcher(); } catch { /* watcher already down */ }
    sessionStates.delete(session.id);
    reservedUuids.delete(session.id);

    const gone = await hardKill(session.id);
    console.warn(`[chat] ${short}: killed deaf pane (removed=${gone}); respawning with --resume and re-sending`);
    if (!gone) return false; // tmux wouldn't let go — leave it for the next tick rather than double-spawning

    let fresh: SessionState;
    try {
      fresh = await setupSession(session);
    } catch (e) {
      console.error(`[chat] ${short}: respawn after deaf-pane kill failed:`, e);
      return false;
    }
    sessionStates.set(session.id, fresh);

    const outcome = await robustSubmit(session, fresh, promptText, true);
    if (outcome === 'delivered') {
      console.log(`[chat] ${short}: re-delivered onto the fresh pane after a deaf-pane heal`);
      return true;
    }
    // Second failure — do NOT kill again. Two dead panes in a row is not a wedged
    // process, it's something we don't understand, and a kill loop would burn the
    // session. Report and stop; `stranded` is quoted back so the text is at least
    // recoverable by hand.
    console.error(
      `[chat] ${short}: message still undeliverable after respawn (outcome=${outcome})` +
        (stranded ? ` — stranded text was: ${JSON.stringify(stranded.slice(0, 200))}` : ''),
    );
    return false;
  } finally {
    release('setup', session.id);
  }
}

// extractText now lives in ./claude-code (shared transcript vocabulary).

/**
 * Coerce whatever shape the JSONL gave us into an array of content blocks the
 * dashboard's `ChatMessage.content` JSON expects (Anthropic-format).
 */
function normalizeContent(raw: unknown): any[] {
  if (typeof raw === 'string') return [{ type: 'text', text: raw }];
  if (Array.isArray(raw)) return raw;
  return [];
}

// ── Cleanup hook ─────────────────────────────────────────────────────────────
//
// On process exit, stop watcher subprocesses cleanly. The tmux panes survive —
// user can re-attach via `tmux attach -t hermit-<sid>` to interact directly,
// or the next gateway start will reattach the watcher.

export function shutdownChatRunner() {
  for (const state of sessionStates.values()) {
    try { state.stopWatcher(); } catch {}
  }
  sessionStates.clear();
  reservedUuids.clear();
}
