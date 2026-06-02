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
import { fileURLToPath } from 'node:url';
import {
  ensureSession,
  sendKeys,
  confirmSubmitted,
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

// MCP stub gives the in-pane claude these tools: set_session_title, log_status,
// attach_image, attach_file. Spawned as a stdio child of `claude --mcp-config <json>`.
const MCP_STUB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-stub.cjs');

function buildMcpConfigArg(chatSessionId: string): string {
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
        },
      },
    },
  };
  return JSON.stringify(config);
}

type PendingMsg = { id: string; sessionId: string; role: string; content: any; createdAt: string };
type PendingSession = { id: string; agentName: string; claudeSessionId: string | null; agentDirectory: string | null };

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
// Concurrency guard for chatRestartTick: the kill can take up to 2s but the
// tick re-fires every 2s (setInterval doesn't await), so overlapping ticks
// would re-process the same not-yet-acked row. Skip rows already in flight.
const restartingSessions = new Set<string>();

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
    // The kill below can take up to 2s, but this tick re-fires every 2s and
    // setInterval doesn't await — so overlapping ticks would each re-process
    // the same not-yet-acked row. Skip rows already in flight here.
    if (restartingSessions.has(row.id)) continue;
    restartingSessions.add(row.id);
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

      // Post a system row so the chat UI stops thinking it's mid-turn. If
      // the user clicked restart while waiting on a reply, the DB's last
      // message is still role=user → the page would show "assistant is
      // working…" forever. The system row breaks that, AND it doubles as
      // an "OK, ready for the next prompt" affordance.
      //
      // externalId is STABLE per restart request (sessionId + requestedAt), so
      // any overlapping tick or retry collapses to a single banner via the
      // sync route's (sessionId, externalId) upsert — instead of spamming a
      // fresh row every tick (the old Date.now()+random id never deduped).
      await api
        .syncChatMessages([
          {
            sessionId: row.id,
            role: 'system',
            content: [{ type: 'text', text: '[session restarted — send a message to continue]' }],
            externalId: `restart-${row.id}-${new Date(row.restartRequestedAt).getTime()}`,
          },
        ])
        .catch((e) => console.error('[chat-restart] post system row failed:', e));
    } catch (e) {
      console.error('[chat-restart] kill failed:', e);
    } finally {
      restartingSessions.delete(row.id);
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
  const havePending = new Set(payload.messages.map((m) => m.sessionId));
  for (const s of payload.sessions) {
    if (havePending.has(s.id)) continue;
    if (sessionStates.has(s.id) || settingUp.has(s.id)) continue;
    // Don't reattach a session that's mid-restart: chatRestartTick is about to
    // (or is currently) killing its pane. Reattaching here would re-populate
    // sessionStates with a state pointing at the doomed pane (the stale-state
    // race that left dead panes un-respawned). The next user message respawns it.
    if (restartingSessions.has(s.id)) continue;
    if (!s.claudeSessionId) continue; // no transcript to tail yet (fresh, pre-uuid)
    if (!tmuxSessionExists(s.id)) continue; // pane not running — nothing to watch
    settingUp.add(s.id);
    setupSession(s)
      .then((st) => { sessionStates.set(s.id, st); })
      .catch((e) => console.error(`[chat] watcher reattach failed for ${s.id.slice(0, 8)}:`, e))
      .finally(() => settingUp.delete(s.id));
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
  // claude's "turn in flight" footer ("esc to interrupt"). /compact shows this
  // while it reads + summarises; its DISAPPEARANCE is how we know the command
  // truly finished — far more reliable than "text stopped changing", which a
  // live spinner/percentage never satisfies (the old 30s cap then truncated the
  // panel mid-progress, e.g. a frozen "Compacting… 80%" that never hit 100%).
  const WORK_RE = /\besc(?:ape)?\s+to\s+(?:interrupt|cancel|stop)\b/i;
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
    state = undefined;
  }
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
  // Archives are binary — Read'ing them is gibberish. Detect by extension and
  // tell claude to extract via Bash instead, so an uploaded .zip/.tar/.gz is
  // actually usable. Everything else flows through the normal `Read <path>`.
  const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', '7z', 'rar', 'zst']);
  const isArchive = (p: string) => ARCHIVE_EXTS.has((p.split('.').pop() || '').toLowerCase());
  for (const p of relay.paths) {
    if (isArchive(p)) {
      promptParts.push(
        `An uploaded archive is at ${p} — it is binary, so do NOT Read it directly. ` +
          `Run \`file ${p}\` to confirm the type, then extract it into a fresh temp directory ` +
          `(unzip / tar -xf / gunzip / 7z as appropriate) and inspect the extracted files.`,
      );
    } else {
      promptParts.push(`Read ${p}`);
    }
  }
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
    // Slash commands print to claude's TUI panel but never touch the JSONL
    // we tail — so the dashboard would have no idea what `/status` etc.
    // produced. Stream the pane back via `streamSlashOutput`: repeated
    // `capture-pane` + upsert (same externalId) so the user watches the
    // output land live and sees a "done" marker when it settles.
    const trimmed = textPart.trim();
    if (trimmed.startsWith('/')) {
      const cmd = trimmed.split(/\s+/)[0];
      // Pane name matches tmux-driver's `paneName()`: last-12 of the session
      // id (cuids are 25 chars; the entropic suffix is what we keep).
      const paneN = `hermit-${session.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-12)}`;
      void streamSlashOutput({ sessionId: session.id, cmd, paneN });
    } else {
      // Make sure the message actually submitted. claude's TUI sometimes drops
      // the submit Enter on a multi-line paste (esp. text + a `Read <image>`
      // line) — the text lands in the composer but never sends until a manual
      // Enter. confirmSubmitted re-sends Enter while the composer still holds
      // buffered text. Slash commands skip this — streamSlashOutput drives the
      // pane (incl. Escape to dismiss modals) and a stray Enter could interfere.
      await confirmSubmitted(session.id);
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
  // log_status, attach_image, attach_file} to the agent. Reattach path skips this — the
  // already-running claude inherited its mcp-config at original spawn.
  if (!paneAlive) {
    // Full-autonomy (2026-06-02): dashboard-chat sessions run gate-free, matching
    // the agents' own (already-bypass) main sessions. The web-permission hook
    // self-defers in bypassPermissions mode, so nothing routes to the web and no
    // invisible TUI prompt can hang the chat. Revert this flag to restore gating.
    claudeArgs.push('--dangerously-skip-permissions');
    claudeArgs.push('--mcp-config', buildMcpConfigArg(session.id));
  }

  const { created, preExistingUuids } = ensureSession({
    sessionId: session.id,
    cwd,
    claudeArgs,
    claudeSessionUuid: waitForResumeUuid ? undefined : claudeUuid || undefined,
    // Pane env inherited by claude's PreToolUse permission hook so it can reach
    // the dashboard (URL + key) and resolve this session — never on argv.
    env: {
      HERMIT_DASHBOARD_URL: DASHBOARD_URL,
      HERMIT_KEY: ASST_KEY,
      HERMIT_SESSION_ID: session.id,
    },
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
