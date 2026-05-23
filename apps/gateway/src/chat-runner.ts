// Direct chat runner with token-level streaming.
//
// Spawns `claude --print --output-format stream-json --verbose
// --include-partial-messages`, parses each `stream_event` to build assistant
// messages incrementally, and POSTs the in-progress snapshot upstream every
// ~200ms keyed by the message id. The dashboard's /api/sync/chat-message
// upserts by (sessionId, externalId), so the row grows in place and the
// browser sees a live typing effect on the next listMessages refetch (1.5s).
//
// Tool calls and tool_result rows are streamed too: tool_use input JSON
// arrives as `input_json_delta` chunks; we accumulate the raw JSON string
// and `JSON.parse` on `content_block_stop`. Tool results come as separate
// `user` events with tool_result blocks — we forward those immediately.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS_ROOT, DASHBOARD_URL, ASST_KEY } from './config';
import { api } from './api';

const CLAUDE_BIN = '/Users/mac/.local/bin/claude';
const TURN_TIMEOUT_MS = 30 * 60_000;
const FLUSH_INTERVAL_MS = 200;

// Our MCP stub. claude spawns this once per turn via --mcp-config; it talks
// JSON-RPC over stdio and proxies tool calls back to the dashboard API.
const MCP_STUB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-stub.cjs');

const inflight = new Set<string>();

// Registered "kill this session's child" callbacks, keyed by sessionId. The
// cancelTick poller resolves stop-requests by invoking these. processTurn
// sets the entry before spawn, deletes on exit.
const killRegistry = new Map<string, () => void>();
// Session ids the user has asked to stop. processTurn checks this on exit to
// distinguish "claude crashed" from "user clicked stop" when writing the
// terminal system row.
const cancelledIds = new Set<string>();

type PendingMsg = { id: string; sessionId: string; role: string; content: any; createdAt: string };
type PendingSession = { id: string; agentName: string; claudeSessionId: string | null };

// Polled from index.ts every ~1.5s. For each cancel-requested session that is
// currently inflight in this gateway, run its kill fn; ack all of them so the
// dashboard clears the flag (even sessions that weren't inflight — those are
// no-ops, the user clicked stop on a turn that already finished).
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
    const kill = killRegistry.get(row.id);
    if (kill) {
      cancelledIds.add(row.id);
      try { kill(); } catch (e) { console.error('[chat-cancel] kill failed:', e); }
      console.log(`[chat-cancel] killed session=${row.id.slice(0, 8)}`);
    }
    // Always ack so the DB flag is cleared regardless of whether we had an
    // inflight match — keeps the dashboard from re-firing on every poll.
    ackIds.push(row.id);
  }
  try { await api.ackChatCancel(ackIds); } catch (e) { console.error('[chat-cancel] ack failed:', e); }
}

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
    if (inflight.has(sessionId)) continue;
    const session = payload.sessions.find((s) => s.id === sessionId);
    if (!session) continue;
    inflight.add(sessionId);
    processTurn(session, msgs).finally(() => inflight.delete(sessionId));
  }
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any; _jsonBuffer?: string }
  | { type: 'tool_result'; tool_use_id: string; content: any; is_error?: boolean }
  | { type: 'thinking'; thinking: string };

type AssistantState = {
  messageId: string;
  blocks: Block[];
  dirty: boolean;
};

async function processTurn(session: PendingSession, msgs: PendingMsg[]) {
  const promptText = msgs
    .map((m) => extractText(m.content))
    .filter(Boolean)
    .join('\n\n');
  if (!promptText) {
    await api.ackChatDelivered(msgs.map((m) => m.id)).catch(() => {});
    return;
  }

  const cwd = path.join(AGENTS_ROOT, session.agentName);
  console.log(`[chat] turn → ${session.agentName} session=${session.id.slice(0, 8)} (${promptText.length}c)`);

  const mcpConfig = {
    mcpServers: {
      asst: {
        command: 'node',
        args: [MCP_STUB_PATH],
        env: {
          ASST_SESSION_ID: session.id,
          ASST_DASHBOARD_URL: DASHBOARD_URL,
          ASST_KEY: ASST_KEY,
        },
      },
    },
  };

  const args = [
    '--dangerously-skip-permissions',
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config', JSON.stringify(mcpConfig),
  ];
  if (session.claudeSessionId) {
    args.push('--resume', session.claudeSessionId);
  }
  await api.ackChatDelivered(msgs.map((m) => m.id)).catch(() => {});

  let capturedSessionId: string | null = null;
  // Active assistant message under construction.
  let active: AssistantState | null = null;
  // queue for non-streaming items (tool_result rows etc).
  const otherQueue: Parameters<typeof api.syncChatMessages>[0] = [];

  let flushTimer: NodeJS.Timeout | null = null;
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush(false);
    }, FLUSH_INTERVAL_MS);
  };

  let flushInFlight: Promise<void> = Promise.resolve();
  async function flush(final: boolean) {
    const items: Parameters<typeof api.syncChatMessages>[0] = [];
    if (otherQueue.length > 0) items.push(...otherQueue.splice(0, otherQueue.length));
    if (active && active.dirty) {
      items.push({
        sessionId: session.id,
        role: 'assistant',
        content: blockSnapshot(active.blocks),
        externalId: active.messageId,
        claudeSessionId: !session.claudeSessionId ? capturedSessionId : null,
      });
      active.dirty = false;
    }
    if (items.length === 0) return;
    flushInFlight = flushInFlight
      .then(() => api.syncChatMessages(items))
      .catch((e) => console.error('[chat] post-back failed:', e));
    if (final) await flushInFlight;
  }

  function startAssistant(messageId: string) {
    // If a previous message hadn't been finalized, flush it first.
    active = { messageId, blocks: [], dirty: false };
  }
  function ensureBlock(index: number, type: Block['type']): Block {
    if (!active) return { type: 'text', text: '' } as Block;
    while (active.blocks.length <= index) {
      active.blocks.push({ type: 'text', text: '' });
    }
    if (active.blocks[index].type !== type) {
      // Reset slot if event says different type for this index.
      if (type === 'text') active.blocks[index] = { type: 'text', text: '' };
      else if (type === 'tool_use') active.blocks[index] = { type: 'tool_use', id: '', name: '', input: {}, _jsonBuffer: '' };
      else if (type === 'thinking') active.blocks[index] = { type: 'thinking', thinking: '' };
    }
    return active.blocks[index];
  }

  function handleStreamEvent(ev: any) {
    const e = ev.event;
    if (!e || !active) return;
    if (e.type === 'content_block_start') {
      const cb = e.content_block;
      if (cb?.type === 'text') {
        ensureBlock(e.index, 'text');
        (active.blocks[e.index] as any).text = cb.text || '';
      } else if (cb?.type === 'tool_use') {
        ensureBlock(e.index, 'tool_use');
        const b = active.blocks[e.index] as Block & { _jsonBuffer?: string };
        if (b.type === 'tool_use') {
          b.id = cb.id ?? '';
          b.name = cb.name ?? '';
          b.input = cb.input ?? {};
          b._jsonBuffer = '';
        }
      } else if (cb?.type === 'thinking') {
        ensureBlock(e.index, 'thinking');
        (active.blocks[e.index] as any).thinking = cb.thinking || '';
      }
      active.dirty = true;
    } else if (e.type === 'content_block_delta') {
      const d = e.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') {
        const b = ensureBlock(e.index, 'text');
        (b as any).text += d.text;
        active.dirty = true;
      } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const b = ensureBlock(e.index, 'tool_use') as Block & { _jsonBuffer?: string };
        if (b.type === 'tool_use') {
          b._jsonBuffer = (b._jsonBuffer || '') + d.partial_json;
          // Try to parse incrementally; OK if it fails until block_stop.
          try {
            b.input = JSON.parse(b._jsonBuffer || '{}');
            active.dirty = true;
          } catch {}
        }
      } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
        const b = ensureBlock(e.index, 'thinking');
        (b as any).thinking += d.thinking;
        active.dirty = true;
      }
    } else if (e.type === 'content_block_stop') {
      const b = active.blocks[e.index];
      if (b?.type === 'tool_use' && '_jsonBuffer' in b && b._jsonBuffer) {
        try {
          b.input = JSON.parse(b._jsonBuffer);
        } catch {
          // leave whatever we last parsed
        }
        delete (b as any)._jsonBuffer;
        active.dirty = true;
      }
    } else if (e.type === 'message_stop') {
      // Force a final flush of this assistant message in the next tick.
      if (active) active.dirty = true;
    }
  }

  let buf = '';
  let stderr = '';
  let timedOut = false;
  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: any;
    try { ev = JSON.parse(trimmed); } catch { return; }

    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      capturedSessionId = ev.session_id;
    } else if (ev.type === 'stream_event') {
      const e = ev.event;
      if (e?.type === 'message_start') {
        startAssistant(e.message?.id ?? `msg-${Date.now()}`);
      } else if (active) {
        handleStreamEvent(ev);
      }
      scheduleFlush();
    } else if (ev.type === 'assistant') {
      // Consolidated message — we should already have it from stream_events,
      // but ensure final state matches in case stream events were skipped.
      if (ev.message?.id && (!active || active.messageId !== ev.message.id)) {
        startAssistant(ev.message.id);
        if (Array.isArray(ev.message.content)) {
          for (let i = 0; i < ev.message.content.length; i++) {
            active!.blocks[i] = ev.message.content[i];
          }
          active!.dirty = true;
        }
      }
      scheduleFlush();
    } else if (ev.type === 'user' && ev.message?.content) {
      const content = Array.isArray(ev.message.content) ? ev.message.content : [];
      const hasToolResult = content.some((b: any) => b?.type === 'tool_result');
      if (hasToolResult) {
        otherQueue.push({
          sessionId: session.id,
          role: 'user',
          content,
          externalId: ev.uuid ?? null,
          claudeSessionId: null,
        });
        scheduleFlush();
      }
    }
  };

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(promptText);
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5_000);
    }, TURN_TIMEOUT_MS);
    // Register a stop callback the cancelTick poller can invoke. SIGTERM
    // first (gives claude a chance to flush its current line); SIGKILL after
    // 3s if the process is still around.
    killRegistry.set(session.id, () => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3_000);
    });
    child.stdout.on('data', (b) => {
      buf += b.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('exit', (code) => {
      clearTimeout(killer);
      killRegistry.delete(session.id);
      if (buf.trim()) handleLine(buf);
      buf = '';
      resolve(code ?? -1);
    });
    child.on('error', () => {
      killRegistry.delete(session.id);
      resolve(-1);
    });
  });

  if (flushTimer) clearTimeout(flushTimer);
  await flush(true);

  const wasCancelled = cancelledIds.delete(session.id);
  if (wasCancelled) {
    // Whatever partial output the assistant produced is already persisted
    // via the streaming flush above. Append a friendly system row so the
    // user sees acknowledgement that the stop landed (vs. a confusing
    // "claude exited 143" error row).
    await api
      .syncChatMessages([
        {
          sessionId: session.id,
          role: 'system',
          content: [{ type: 'text', text: '[stopped by user]' }],
          externalId: null,
          claudeSessionId: capturedSessionId,
        },
      ])
      .catch(() => {});
  } else if (exitCode !== 0 || timedOut) {
    await api
      .syncChatMessages([
        {
          sessionId: session.id,
          role: 'system',
          content: [
            {
              type: 'text',
              text: `[gateway] claude exited ${exitCode}${timedOut ? ' (timeout)' : ''}\n\n${(stderr || '').slice(-1500)}`,
            },
          ],
          externalId: null,
          claudeSessionId: capturedSessionId,
        },
      ])
      .catch(() => {});
  }
  console.log(`[chat] done → ${session.agentName} session=${session.id.slice(0, 8)} exit=${exitCode}${wasCancelled ? ' (cancelled)' : ''}`);
}

function blockSnapshot(blocks: Block[]) {
  // Strip transient _jsonBuffer field before sending.
  return blocks.map((b) => {
    if (b.type === 'tool_use') {
      const { _jsonBuffer, ...rest } = b as any;
      return rest;
    }
    return b;
  });
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}
