// hermit's dsh runner — the plugin hermit.patch.yml mounts in place of the
// stock headless-runner. One process = one gateway turn:
//
//   1. create a fresh persisted Agent, or resume the one HERMIT_DSH_RESUME
//      names (dsh keeps its sessions under ~/.dsh/sessions, so resume across
//      gateway restarts is free);
//   2. submit the task read from HERMIT_DSH_TASK_FILE as an ordinary user
//      message and wait for quiescence;
//   3. report the session's live events as JSONL while it runs, flush the
//      session, and exit through the launcher's ctx.appExit.
//
// Written against the same core services the stock runner uses (ctx.agents,
// ctx.agentDefaultModel, ctx.sessions) and NOTHING imported from dsh packages:
// this file is loaded by dsh's own Cordis loader from an absolute path outside
// any node_modules, where bare specifiers like @deepseek-ai/dsh-llm may not
// resolve. The three helpers the stock runner imports are inlined instead —
// SessionId() is an identity cast, createUserMessage() is a frozen literal
// with a uuid, and installModelSelection() is transcribed below (its two event
// hooks are what make {{model}} render and the request pin the selection).
// Mirror of @deepseek-ai/dsh-headless@0.1.0-rc.6; revisit on a dsh upgrade.
//
// ── The reporting protocol ──────────────────────────────────────────────────
// JSON lines on the fd HERMIT_DSH_EVENTS_FD names (the gateway passes 3, so a
// stray console.log from any dsh plugin cannot corrupt the stream; run by hand
// without it, the lines land on stdout). Every line is one object:
//
//   {"hermit":"hello","sessionId":"session-…","resumed":false,"totals":{…}}
//   {"hermit":"event","seq":12,"type":"tool/call","data":{…}}   // verbatim
//   {"hermit":"done","reason":{"kind":"completed"},"totals":{…}}
//
// `totals` is the cumulative TokenUsage sum over every assistant/message in
// the session log — hello's covers what history already cost (how the gateway
// re-seeds counters after its own restart), done's covers it including this
// turn.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';

export const name = 'hermit-runner';
export const inject = ['agents', 'agentDefaultModel', 'sessions'];

/** Event types the gateway renders; everything else stays in dsh's own log. */
const REPORTED = new Set([
  'assistant/message', 'tool/call', 'tool/result', 'todo/write', 'turn/start', 'turn/end',
]);

function makeReporter() {
  const fd = Number(process.env.HERMIT_DSH_EVENTS_FD || '1');
  return (obj) => {
    // One writeSync per line: pipe writes at this size are atomic, so lines
    // cannot interleave even with dsh's own stdout traffic.
    try {
      writeSync(fd, `${JSON.stringify(obj)}\n`);
    } catch {
      // A closed pipe means the gateway is gone; nothing useful left to do.
    }
  };
}

/** Cumulative token usage across every assistant/message in `events`. */
function sumUsage(events) {
  const totals = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };
  let last = null;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const u = event.data?.usage;
    if (!u) continue;
    totals.inputTokens += u.inputTokens ?? 0;
    totals.outputTokens += u.outputTokens ?? 0;
    totals.cacheReadTokens += u.cacheReadTokens ?? 0;
    totals.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    last = u;
  }
  return { ...totals, last };
}

/**
 * Transcription of dsh-agent's installModelSelection for a fixed selection:
 * one hook exposes {{provider}}/{{model}} to prompt assembly, the other pins
 * the request to the selection (dropping any inherited reasoning effort).
 */
function pinModelSelection(agentCtx, selection) {
  agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selection.provider,
        model: selection.model,
      },
    };
  });
  agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    const { reasoningEffort: _inherited, ...rest } = resolved;
    return {
      ...rest,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    };
  });
}

async function run(ctx, io) {
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const defaultModel = ctx.get('agentDefaultModel');
  const sessions = ctx.get('sessions');
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    throw new Error('hermit-runner: agents/agentDefaultModel/sessions services missing');
  }

  const taskFile = process.env.HERMIT_DSH_TASK_FILE?.trim();
  if (!taskFile) throw new Error('hermit-runner: HERMIT_DSH_TASK_FILE is required');
  const task = readFileSync(taskFile, 'utf8');
  if (task.trim() === '') throw new Error('hermit-runner: the task file is empty');

  // A session pin from the dashboard beats the profile's configured default.
  const configured = defaultModel.currentSelection();
  const provider = process.env.HERMIT_DSH_PROVIDER?.trim() || configured.provider;
  const model = process.env.HERMIT_DSH_MODEL?.trim() || configured.model;
  const selection = { ...configured, provider, model };

  const resumeId = process.env.HERMIT_DSH_RESUME?.trim() || null;
  const options = {
    agentOptions: { provider, model },
    setup: (agentCtx) => {
      pinModelSelection(agentCtx, selection);
    },
  };
  const create = () => agents.create({
    ...options,
    sessionId: `session-${randomUUID()}`,
    meta: { cwd: process.cwd() },
  });
  let handle;
  let resumed = false;
  if (resumeId) {
    try {
      handle = await agents.resume({ ...options, resumeSessionId: resumeId });
      resumed = true;
    } catch (error) {
      // A recorded session whose files are gone (pruned, another machine's id)
      // would otherwise fail identically on every retry and brick the chat.
      // Real history is being dropped, so be loud about it.
      process.stderr.write(`hermit-runner: cannot resume ${resumeId} (${error?.message ?? error}) — starting a fresh session\n`);
      handle = await create();
    }
  } else {
    handle = await create();
  }
  const { agent } = handle;

  await agent.whenIdle();
  io.report({
    hermit: 'hello',
    sessionId: String(agent.session.id),
    resumed,
    totals: sumUsage(agent.session.events),
  });

  // The live firehose only — constructor seeds do not emit, so a resumed
  // session's history is not replayed at the gateway (it already has it).
  const firstSeq = agent.session.seq;
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return;
    if (!REPORTED.has(event.type)) return;
    io.report({ hermit: 'event', seq: event.seq, type: event.type, data: event.data });
  });

  // What createUserMessage(...) builds, inlined (frozen literal + uuid id).
  agent.followup(Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
  await sessions.flush(agent.session);

  let reason;
  for (const event of agent.session.events) {
    if (event.seq >= firstSeq && event.type === 'turn/end') reason = event.data.reason;
  }
  io.report({
    hermit: 'done',
    reason: reason ?? null,
    totals: sumUsage(agent.session.events),
  });
  io.exit(reason?.kind === 'completed' ? 0 : 1);
}

export function apply(ctx) {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('hermit-runner: the launcher must provide ctx.appExit before the tree mounts');
  const io = { report: makeReporter(), exit };
  run(ctx, io).catch((error) => {
    process.stderr.write(`hermit-runner: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    io.report({ hermit: 'done', reason: { kind: 'error', error: { code: 'RUNNER', message: String(error?.message ?? error) } }, totals: null });
    io.exit(1);
  });
}
