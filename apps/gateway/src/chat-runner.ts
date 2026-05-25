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
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ensureSession,
  sendKeys,
  sendInterrupt,
  kill as killTmuxSession,
  getClaudeSessionUuid,
  awaitTranscript,
  watchTranscript,
  encodedProjectDir,
  tmuxSessionExists,
} from '@hermit-ui/tmux-driver';

import { AGENTS_ROOT, DASHBOARD_URL, ASST_KEY } from './config';
import { api } from './api';
import { relayImages } from './image-relay';

// MCP stub gives the in-pane claude three tools: set_session_title, log_status,
// attach_image. Spawned as a stdio child of `claude --mcp-config <json>`.
const MCP_STUB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-stub.cjs');

function buildMcpConfigArg(chatSessionId: string): string {
  const config = {
    mcpServers: {
      hermit: {
        command: 'node',
        args: [MCP_STUB_PATH],
        env: {
          HERMIT_SESSION_ID: chatSessionId,
          HERMIT_DASHBOARD_URL: DASHBOARD_URL,
          HERMIT_KEY: ASST_KEY,
        },
      },
    },
  };
  return JSON.stringify(config);
}

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

// Per-session restart: poll for `restartRequestedAt` rows, kill each pane,
// ack. The next user message into that session will respawn claude with
// --resume <claudeSessionId> (history preserved). Used when a single session
// is wedged but other sessions on the same agent are fine.
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
    try {
      // Tear down in-memory state first so the next deliverMessages call
      // hits setupSession fresh (which will see paneAlive=false and respawn
      // with --resume).
      const state = sessionStates.get(row.id);
      if (state) {
        try { state.stopWatcher(); } catch {}
        sessionStates.delete(row.id);
      }
      await killTmuxSession(row.id, 2_000);
      console.log(`[chat-restart] killed session=${row.id.slice(0, 8)}`);
    } catch (e) {
      console.error('[chat-restart] kill failed:', e);
    }
    ackIds.push(row.id);
  }
  try {
    await api.ackSessionRestart(ackIds);
  } catch (e) {
    console.error('[chat-restart] ack failed:', e);
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
  const textPart = msgs
    .map((m) => extractText(m.content))
    .filter(Boolean)
    .join('\n\n');

  // Relay any attached images: download each from the dashboard into the local
  // gateway cache so the tmux-driven claude can Read them. Failed downloads
  // surface as a system row in the dashboard — they're not fatal to the turn.
  const relay = await relayImages(msgs.map((m) => m.content));
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
  for (const p of relay.paths) promptParts.push(`Read ${p}`);
  const promptText = promptParts.join('\n\n');

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
      `claude=${state.claudeUuid.slice(0, 8)} ` +
      `(${textPart.length}c text + ${relay.paths.length} image${relay.paths.length === 1 ? '' : 's'})`,
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

  // Pre-generate the claude session uuid for fresh spawns so we never race on
  // "which new jsonl is mine?" when two sessions start against the same agent
  // cwd at the same time. For resume, claude generates its own new uuid that
  // includes the resumed history — we sniff via getClaudeSessionUuid.
  const claudeArgs: string[] = [];
  let claudeUuid: string;
  let waitForResumeUuid = false;

  if (paneAlive && session.claudeSessionId) {
    // Already running — trust the DB.
    claudeUuid = session.claudeSessionId;
  } else if (session.claudeSessionId && !paneAlive) {
    // Resume: claude --resume forks into a brand-new JSONL with full prior
    // history (per happy's findings). Sniff the new uuid after spawn.
    claudeArgs.push('--resume', session.claudeSessionId);
    waitForResumeUuid = true;
    claudeUuid = ''; // filled in after spawn
  } else {
    // Fresh: pre-assign uuid via --session-id (added by ensureSession).
    claudeUuid = randomUUID();
  }

  // Wire the hermit-ui MCP stub on every spawn (fresh OR --resume). claude
  // picks up the in-pane config and exposes mcp__hermit__{set_session_title,
  // log_status, attach_image} to the agent. Reattach path skips this — the
  // already-running claude inherited its mcp-config at original spawn.
  if (!paneAlive) {
    claudeArgs.push('--mcp-config', buildMcpConfigArg(session.id));
  }

  const { created, preExistingUuids } = ensureSession({
    sessionId: session.id,
    cwd,
    claudeArgs,
    claudeSessionUuid: waitForResumeUuid ? undefined : claudeUuid || undefined,
  });

  if (waitForResumeUuid) {
    claudeUuid = await getClaudeSessionUuid({ cwd, preExistingUuids });
  } else if (created) {
    // Pre-assigned uuid; just wait for claude to materialize the file.
    await awaitTranscript(path.join(encodedProjectDir(cwd), `${claudeUuid}.jsonl`)).catch((e) => {
      // Non-fatal — the watcher will keep retrying as the file appears.
      console.warn(`[chat] ${session.id.slice(0, 8)}: ${e.message}`);
    });
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
