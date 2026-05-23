#!/usr/bin/env node
// MCP stub spawned by `claude --mcp-config` for each chat turn.
//
// Reads ASST_SESSION_ID + ASST_DASHBOARD_URL + ASST_KEY from env.
// Exposes tools the agent can call mid-turn that route back to the dashboard:
//   - set_session_title(title)  — rename this chat session
//   - log_status(text)          — drop a system note into the chat timeline
//
// Talks JSON-RPC 2.0 over stdio per MCP spec, no SDK required (the SDK pulls
// in too many deps for what is a 100-line transport).

'use strict';

const readline = require('node:readline');

const SESSION_ID = process.env.ASST_SESSION_ID || '';
const DASHBOARD_URL = process.env.ASST_DASHBOARD_URL || 'https://dash.swaylab.ai';
const KEY = process.env.ASST_KEY || '';

function sendJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id, result) {
  sendJson({ jsonrpc: '2.0', id, result });
}
function sendError(id, code, message) {
  sendJson({ jsonrpc: '2.0', id, error: { code, message } });
}

async function trpcMutate(procedure, input) {
  const url = `${DASHBOARD_URL}/api/trpc/${procedure}?batch=1`;
  const body = { 0: { json: input } };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${procedure} → ${r.status}`);
  return r.json();
}

async function postChatMessage(items) {
  const r = await fetch(`${DASHBOARD_URL}/api/sync/chat-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-asst-key': KEY },
    body: JSON.stringify({ items }),
  });
  if (!r.ok) throw new Error(`sync/chat-message → ${r.status}`);
  return r.json();
}

const TOOLS = [
  {
    name: 'set_session_title',
    description:
      'Rename the current chat session shown in the dashboard sidebar. Use when the conversation has settled on a clear topic. Keep titles short (≤60 chars).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'New session title (will be truncated to 120 chars).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'log_status',
    description:
      'Drop a short, italic system note into the chat timeline — useful for "starting long task X" / "checkpoint Y reached" updates that the user benefits from seeing in-line.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The status line (markdown supported).' },
      },
      required: ['text'],
    },
  },
];

async function dispatchTool(name, args) {
  if (!SESSION_ID) throw new Error('ASST_SESSION_ID missing');
  if (name === 'set_session_title') {
    if (typeof args?.title !== 'string') throw new Error('title required');
    await trpcMutate('chat.setTitle', { id: SESSION_ID, title: args.title.slice(0, 120) });
    return `ok — title set to "${args.title.slice(0, 120)}"`;
  }
  if (name === 'log_status') {
    if (typeof args?.text !== 'string') throw new Error('text required');
    await postChatMessage([
      {
        sessionId: SESSION_ID,
        role: 'system',
        content: [{ type: 'text', text: args.text }],
        externalId: `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    ]);
    return 'ok — logged';
  }
  throw new Error(`unknown tool: ${name}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      sendResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'asst-mcp', version: '0.1.0' },
      });
      return;
    }
    if (method === 'notifications/initialized') {
      // no-op
      return;
    }
    if (method === 'tools/list') {
      sendResult(id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      try {
        const text = await dispatchTool(name, args || {});
        sendResult(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        sendResult(id, {
          isError: true,
          content: [{ type: 'text', text: String(e?.message || e) }],
        });
      }
      return;
    }
    if (method === 'resources/list') {
      sendResult(id, { resources: [] });
      return;
    }
    if (method === 'prompts/list') {
      sendResult(id, { prompts: [] });
      return;
    }
    // Unknown method
    if (id !== undefined) sendError(id, -32601, `method not found: ${method}`);
  } catch (e) {
    if (id !== undefined) sendError(id, -32603, String(e?.message || e));
  }
});

// Keep process alive until stdin closes.
process.stdin.on('end', () => process.exit(0));
