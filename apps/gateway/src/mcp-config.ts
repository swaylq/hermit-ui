// The hermit MCP stub's spawn config, shared by every backend that runs a real
// Claude Code session.
//
// Lifted out of chat-runner so the claude-sdk runtime can build the same config
// without importing chat-runner — which imports `./runtime`, which imports the
// runtime, which would close the cycle. Three callers now (chat tmux, chat sdk,
// cron), one definition: the tool surface an agent sees must not depend on which
// backend happens to be driving it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_URL } from './config';

// MCP stub gives the session's claude these tools: set_session_title, log_status,
// attach_image, attach_file, ask. Spawned as a stdio child of the claude process.
export const MCP_STUB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-stub.cjs');

/**
 * The stub's stdio server entry, as an object.
 *
 * `--mcp-config` takes this JSON-stringified; the Agent SDK's `mcpServers`
 * option takes the object itself. Building the object once and serialising at
 * the edge keeps the two spawn paths from drifting.
 */
export function buildMcpServers(
  chatSessionId: string,
  isBrain = false,
  // Pure chat carries its agent directory rather than being a bare boolean: the
  // mode's one write tool (memory_write) is useless without it, and bundling
  // them makes "flag set, directory forgotten" unrepresentable instead of a
  // runtime error a long way from here.
  chatOnly: { agentDirectory: string } | null = null,
) {
  return {
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
        // Claude Code expands ${VAR} in stdio MCP env entries from its own
        // environment. Keeping only the variable name in the config prevents the
        // machine key from being serialized into `--mcp-config` argv.
        HERMIT_KEY: '${HERMIT_KEY}',
        // The orchestrator ("义脑") session gets HERMIT_BRAIN=1 — the stub then
        // registers the brain-only cross-agent tools (roster/dispatch/...).
        ...(isBrain ? { HERMIT_BRAIN: '1' } : {}),
        // Pure chat: the stub drops the three cron tools that would schedule
        // full-tool work later, and gains memory_write — the session's only
        // route to disk. See mcp-stub.cjs CHAT_ONLY_DENIED / CHAT_ONLY_TOOLS.
        ...(chatOnly ? { HERMIT_CHAT_ONLY: '1', HERMIT_AGENT_DIR: chatOnly.agentDirectory } : {}),
      },
    },
  };
}

export function buildMcpConfigArg(
  chatSessionId: string,
  isBrain = false,
  chatOnly: { agentDirectory: string } | null = null,
): string {
  return JSON.stringify({ mcpServers: buildMcpServers(chatSessionId, isBrain, chatOnly) });
}
