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
import {
  ensureSession,
  sendKeys,
  sendInterrupt,
  getClaudeSessionUuid,
  watchTranscript,
  encodedProjectDir,
  tmuxSessionExists,
} from '@hermit-ui/tmux-driver';

import { AGENTS_ROOT } from './config';
import { api } from './api';

type PendingMsg = { id: string; sessionId: string; role: string; content: any; createdAt: string };
type PendingSession = { id: string; agentName: string; claudeSessionId: string | null };

interface SessionState {
  claudeUuid: string;
  jsonlPath: string;
  stopWatcher: () => void;
  seenUuids: Set<string>;
  // Has the gateway already pushed claudeSessionId back to the DB for this row?
  // The dashboard's /api/sync/chat-message stamps it on first non-null arrival.
  uuidStamped: boolean;
}

// Per-session runtime state. Cleared on gateway restart; rebuilt lazily on
// next chatTick. The tmux pane survives gateway restarts so re-attach is cheap.
const sessionStates = new Map<string, SessionState>();
// Concurrency guard: don't run setup twice for the same session.
const settingUp = new Set<string>();

// ── Cancellation tick ────────────────────────────────────────────────────────

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
  if (payload.messages.length === 0) return;

  const grouped = new Map<string, PendingMsg[]>();
  for (const m of payload.messages) {
    const arr = grouped.get(m.sessionId) ?? [];
    arr.push(m);
    grouped.set(m.sessionId, arr);
  }

  for (const [sessionId, msgs] of grouped) {
    if (settingUp.has(sessionId)) continue;
    const session = payload.sessions.find((s) => s.id === sessionId);
    if (!session) continue;

    deliverMessages(session, msgs).catch((e) => {
      console.error(`[chat] delivery failed for ${sessionId.slice(0, 8)}:`, e);
    });
  }
}

async function deliverMessages(session: PendingSession, msgs: PendingMsg[]) {
  // Ensure tmux pane + watcher are up.
  let state = sessionStates.get(session.id);
  if (!state) {
    if (settingUp.has(session.id)) return;
    settingUp.add(session.id);
    try {
      state = await setupSession(session);
      sessionStates.set(session.id, state);
    } catch (e) {
      console.error(`[chat] setup failed for ${session.id.slice(0, 8)}:`, e);
      return;
    } finally {
      settingUp.delete(session.id);
    }
  }

  // Merge multiple queued user messages into a single submission. The
  // dashboard already has each as its own ChatMessage row, so we only need to
  // feed claude. Use double-newline as a soft separator — when the user fires
  // off several messages quickly, they all reach claude as one turn.
  const promptText = msgs
    .map((m) => extractText(m.content))
    .filter(Boolean)
    .join('\n\n');

  if (!promptText) {
    await api.ackChatDelivered(msgs.map((m) => m.id)).catch(() => {});
    return;
  }

  // Ack BEFORE sending so a sendKeys failure doesn't cause an infinite redeliver.
  // If sendKeys throws, we log; the watcher won't see the user prompt land in
  // the JSONL — the user can retry from the dashboard.
  await api.ackChatDelivered(msgs.map((m) => m.id)).catch(() => {});

  console.log(
    `[chat] → ${session.agentName} session=${session.id.slice(0, 8)} ` +
      `claude=${state.claudeUuid.slice(0, 8)} (${promptText.length}c)`,
  );

  try {
    sendKeys(session.id, promptText);
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

async function setupSession(session: PendingSession): Promise<SessionState> {
  const cwd = path.join(AGENTS_ROOT, session.agentName);

  // If the gateway restarted but the tmux pane is still alive, just reattach
  // the watcher — don't spawn a second claude in the same pane.
  const paneAlive = tmuxSessionExists(session.id);

  // Resume semantics: when respawning a previously-known session (DB has the
  // claude uuid AND the pane is gone), pass --resume to inherit conversation.
  const claudeArgs: string[] = [];
  if (session.claudeSessionId && !paneAlive) {
    claudeArgs.push('--resume', session.claudeSessionId);
  }

  const { created, preExistingUuids } = ensureSession({
    sessionId: session.id,
    cwd,
    claudeArgs,
  });

  // Figure out which JSONL we're tailing.
  let claudeUuid: string;
  if (paneAlive && session.claudeSessionId) {
    // Reattach to existing transcript.
    claudeUuid = session.claudeSessionId;
  } else if (session.claudeSessionId && claudeArgs.includes('--resume')) {
    // claude --resume forks into a brand-new JSONL with full prior history
    // (see happy's findings re: --resume rewriting session ids). Wait for it.
    claudeUuid = await getClaudeSessionUuid({ cwd, preExistingUuids });
  } else if (created) {
    // Fresh session.
    claudeUuid = await getClaudeSessionUuid({ cwd, preExistingUuids });
  } else {
    // Pane exists but DB had no uuid — pick the most-recently-modified jsonl.
    // This only happens if we lost DB state somehow; log loudly.
    console.warn(`[chat] session ${session.id.slice(0, 8)}: pane alive but no claudeSessionId in DB, falling back to newest jsonl`);
    claudeUuid = await getClaudeSessionUuid({ cwd, preExistingUuids: new Set() });
  }

  const jsonlPath = path.join(encodedProjectDir(cwd), `${claudeUuid}.jsonl`);

  const state: SessionState = {
    claudeUuid,
    jsonlPath,
    stopWatcher: () => {},
    seenUuids: new Set<string>(),
    uuidStamped: !!session.claudeSessionId && session.claudeSessionId === claudeUuid,
  };
  state.stopWatcher = watchTranscript(jsonlPath, (ev) => onTranscriptEvent(session.id, ev, state));

  console.log(
    `[chat] setup session=${session.id.slice(0, 8)} agent=${session.agentName} ` +
      `claude=${claudeUuid.slice(0, 8)} (created=${created}, paneAlive=${paneAlive})`,
  );

  return state;
}

// ── Transcript event → ChatMessage row ───────────────────────────────────────

function onTranscriptEvent(chatSessionId: string, ev: any, state: SessionState) {
  if (!ev || typeof ev !== 'object') return;
  if (!ev.uuid) return; // skip events without a stable id (queue-ops, etc.)
  if (state.seenUuids.has(ev.uuid)) return;
  state.seenUuids.add(ev.uuid);

  const stampUuid = !state.uuidStamped ? state.claudeUuid : null;

  if (ev.type === 'assistant' && ev.message?.content) {
    // Assistant turn — text, tool_use, thinking blocks.
    const content = normalizeContent(ev.message.content);
    if (content.length === 0) return;
    api
      .syncChatMessages([
        {
          sessionId: chatSessionId,
          role: 'assistant',
          content,
          externalId: ev.uuid,
          claudeSessionId: stampUuid,
        },
      ])
      .then(() => {
        if (stampUuid) state.uuidStamped = true;
      })
      .catch((e) => console.error('[chat] sync assistant failed:', e));
    return;
  }

  if (ev.type === 'user' && ev.message?.content && Array.isArray(ev.message.content)) {
    // Only forward user events with tool_result blocks (claude's reply to a
    // tool_use). Skip plain user prompts — the dashboard already wrote those
    // rows when it sent them, and re-syncing would create a duplicate-text
    // row with the wrong externalId.
    const blocks = ev.message.content;
    const hasToolResult = blocks.some((b: any) => b?.type === 'tool_result');
    if (!hasToolResult) return;
    api
      .syncChatMessages([
        {
          sessionId: chatSessionId,
          role: 'user',
          content: blocks,
          externalId: ev.uuid,
          claudeSessionId: stampUuid,
        },
      ])
      .then(() => {
        if (stampUuid) state.uuidStamped = true;
      })
      .catch((e) => console.error('[chat] sync tool_result failed:', e));
    return;
  }

  // Other event types (attachment, permission-mode, file-history-snapshot,
  // queue-operation, system errors) are internal — don't forward.
}

// ── Utilities ────────────────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

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
}
