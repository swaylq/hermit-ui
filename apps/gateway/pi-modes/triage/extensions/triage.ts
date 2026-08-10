// triage — a harness that becomes the right harness.
//
// Every other mode in this repo is a fixed recipe someone picks. This one boots
// with the union of the cheap harnesses' tools, reads the first prompt, routes
// it, and then narrows itself to the winner: tool set via setActiveTools(), the
// winner's SYSTEM.md appended to the system prompt.
//
// Why that works, measured 2026-08-10 (docs/pi-harness-design.md):
//   boot --tools read,bash,edit,write, narrow to [read] in before_agent_start
//   → 3,963 tokens, byte-identical to booting with --tools read.
// The narrowing lands on the CURRENT turn, so carrying the union costs nothing
// once triage has decided.
//
// The two omp-only harnesses cannot be reached this way — an extension can
// change tools, not engines. They are served by `delegate`, which runs one as a
// subprocess at its own price rather than making every session pay omp's 8,101
// floor.
//
// Zero gateway changes: this is an ordinary mode directory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

/** hermit's own tools, unioned into --tools by buildModeArgs. Never narrowed away. */
const HERMIT_TOOLS = [
  'set_session_title', 'log_status', 'attach_file', 'attach_image', 'describe_image', 'ask',
];

/** Tool set per harness, in pi's vocabulary. Mirrors each harness's mode.json. */
const PI_TOOLS: Record<string, string[]> = {
  answer: ['read'],
  shell: ['bash', 'read'],
  scout: ['read', 'grep', 'find', 'ls'],
  patch: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'],
};

/**
 * Harnesses this one cannot become, only delegate to — they need the omp engine.
 *
 * `local` is what triage narrows ITSELF to when the router picks one of these.
 *
 * `web` drops bash deliberately. Measured: left with bash, the model answered a
 * "搜一下最新版本号" task with two curl calls and never touched `delegate` — a
 * shell is simply an easier path than a tool it has to reason about, so it will
 * always win when both are present. Without bash, the internet is reachable
 * only through the harness that is actually disciplined about it.
 *
 * `omp` keeps everything: those are mixed UI-plus-code tasks where the local
 * half is real work, and the browser half is what gets delegated.
 */
const DELEGATE_ONLY: Record<string, { tools: string[]; local: string[]; why: string }> = {
  web: {
    tools: ['web_search', 'read'],
    local: ['read', 'grep', 'find', 'ls'],
    why: 'needs web_search, which only omp has',
  },
  omp: {
    tools: [],
    local: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'],
    why: 'needs the full omp surface — browser, lsp, ast_edit',
  },
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Sibling mode directories: <root>/triage/extensions/ → <root>/ */
const MODE_ROOT = path.resolve(HERE, '..', '..');

const DASHBOARD_URL = process.env.HERMIT_DASHBOARD_URL ?? '';
const HERMIT_KEY = process.env.HERMIT_KEY ?? '';
const SESSION_ID = process.env.HERMIT_SESSION_ID ?? '';

/**
 * Default ceiling for one delegated run.
 *
 * 180s, not 300: a delegated lookup that has not landed in three minutes is not
 * about to, and the caller is a chat. omp winds itself down at --max-time and
 * still reports what it verified, so the ceiling truncates research rather than
 * losing it; the SIGTERM below is only a backstop for a wedged child.
 */
const DELEGATE_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;
/** How often the live progress row is rewritten. Every event would be a POST per token. */
const PROGRESS_INTERVAL_MS = 2_000;

function systemMdFor(harness: string): string {
  const p = path.join(MODE_ROOT, harness, 'SYSTEM.md');
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

/**
 * Which model a delegated run uses.
 *
 * This exists because the first version passed `--model` only when
 * `HERMIT_PI_MODEL` was set — and the gateway never sets that name. It sets
 * `HERMIT_PI_MODELS` (plural, the catalogue). So every delegated run went out
 * with no pin at all and omp resolved its own default, which on this fleet is
 * **claude-opus-5**: opus reading half a dozen pages is what a four-minute
 * spinner looks like.
 *
 * A delegated run is a bounded lookup, not the conversation, so it takes the
 * fastest model the machine publishes and only falls back up the ladder.
 */
export function delegateModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.HERMIT_DELEGATE_MODEL?.trim();
  if (explicit) return explicit;
  const models = (env.HERMIT_PI_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (!models.length) return null;
  const pick =
    models.find((m) => /haiku|flash|mini|small|lite/i.test(m)) ??
    models.find((m) => /sonnet/i.test(m)) ??
    null;
  if (!pick) return null;
  const provider = env.HERMIT_PI_PROVIDER?.trim();
  return provider ? `${provider}/${pick}` : pick;
}

/**
 * Rewrite the delegate's live progress row in the chat.
 *
 * A stable externalId is the whole trick: /api/sync/chat-message is unique on
 * (sessionId, externalId) and a conflict is an UPDATE that deliberately does
 * not bump lastMessageAt. So reposting the same id edits one row in place
 * instead of appending — a live status line that costs no unread badge and no
 * transcript spam.
 *
 * Best-effort throughout. A delegated answer must never be lost because the
 * dashboard was briefly unreachable.
 */
async function postProgress(externalId: string, text: string): Promise<void> {
  if (!DASHBOARD_URL || !HERMIT_KEY || !SESSION_ID) return;
  try {
    await fetch(`${DASHBOARD_URL}/api/sync/chat-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-asst-key': HERMIT_KEY },
      body: JSON.stringify({
        items: [{
          sessionId: SESSION_ID,
          role: 'system',
          content: [{ type: 'text', text }],
          externalId,
          claudeSessionId: null,
        }],
      }),
    });
  } catch {
    // progress is decoration; the tool result is the product
  }
}

type Step = { tool: string; detail: string };

/** One line per event worth showing. Truncated hard — this is read on a phone. */
function describeStep(name: string, args: unknown): Step {
  const a = (args ?? {}) as Record<string, unknown>;
  const first =
    (typeof a.query === 'string' && a.query) ||
    (typeof a.url === 'string' && a.url) ||
    (typeof a.path === 'string' && a.path) ||
    (typeof a.command === 'string' && a.command) ||
    '';
  return { tool: name, detail: String(first).slice(0, 72) };
}

type OmpRun = { answer: string; steps: Step[]; code: number | null; timedOut: boolean; stderr: string };

/**
 * Run omp and read its event stream as it goes.
 *
 * `--mode json` rather than plain print mode: the delegated run's answer has to
 * be reconstructed from `message_end` anyway, and the same stream is what makes
 * the progress row possible. Plain stdout would be one opaque blob arriving at
 * the end, which is exactly the complaint this replaces.
 */
function runOmp(
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal; onStep: (steps: Step[]) => void },
): Promise<OmpRun> {
  return new Promise((resolve) => {
    const child = spawn('omp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const steps: Step[] = [];
    let answer = '';
    let stderr = '';
    let buf = '';
    let timedOut = false;
    let settled = false;

    const kill = (why: 'timeout' | 'abort') => {
      if (settled) return;
      if (why === 'timeout') timedOut = true;
      child.kill('SIGTERM');
      // omp flushes on SIGTERM; SIGKILL only if it does not.
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
    };

    const timer = setTimeout(() => kill('timeout'), opts.timeoutMs);
    const onAbort = () => kill('abort');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      let changed = false;
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let ev: any;
        try { ev = JSON.parse(t); } catch { continue; }
        if (ev?.type !== 'message_end') continue;
        const m = ev.message ?? {};
        if (m.role !== 'assistant') continue;
        for (const part of m.content ?? []) {
          if (part?.type === 'toolCall') {
            steps.push(describeStep(String(part.name ?? '?'), part.arguments));
            changed = true;
          }
          // The last assistant message carrying prose is the answer; earlier
          // ones are the tool-calling turns on the way there.
          if (part?.type === 'text' && String(part.text ?? '').trim()) {
            answer = String(part.text);
          }
        }
      }
      if (changed) opts.onStep(steps);
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ answer, steps, code, timedOut, stderr });
    };
    child.on('error', (e) => { stderr += String(e); finish(null); });
    child.on('close', (code) => finish(code));
  });
}

/**
 * The router module, from wherever this copy of the mode is running.
 *
 * Deployed, `route.mjs` sits beside this file so the mode directory is
 * self-contained and never reaches back into a dev checkout at runtime. In a
 * source tree that copy may be absent, so fall back to the one upstream — a
 * bench run straight out of the project directory otherwise fails the spawn
 * with "Cannot find module route.mjs".
 */
async function loadRouter(): Promise<any> {
  const candidates = [
    path.join(HERE, 'route.mjs'),
    path.resolve(HERE, '..', '..', '..', 'router', 'route.mjs'),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`router not found (looked in ${candidates.join(', ')})`);
  return import(new URL(`file://${hit}`).href);
}

export default async function triage(pi: any): Promise<void> {
  // The same module the CLI and the eval use, so a route seen in a chat can be
  // reproduced with `node router/route.mjs --explain "<the same text>"`.
  const { route } = await loadRouter();

  /** Decided once. A mode is a persona; swapping it mid-conversation gives one context two. */
  let decided: string | null = null;

  pi.registerTool({
    name: 'delegate',
    description:
      'Run one bounded task on a harness this session cannot become: `web` (web_search — searching, reading a URL, current facts) or `omp` (a real browser — screenshots, UI behaviour, layout). Returns that run\'s final answer. Use it instead of guessing when the work needs a capability you do not have. One shot, no memory of this conversation, so put everything it needs in the task text — and keep the task narrow, because it runs on a clock.',
    parameters: {
      type: 'object',
      properties: {
        harness: { type: 'string', enum: ['web', 'omp'], description: 'Which harness to run it on.' },
        task: { type: 'string', description: 'Self-contained instruction, including any context it needs.' },
        timeoutSeconds: { type: 'number', description: 'Default 180, max 600.' },
      },
      required: ['harness', 'task'],
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (u: unknown) => void,
    ) {
      const harness = String(params.harness ?? '');
      const task = String(params.task ?? '').trim();
      const spec = DELEGATE_ONLY[harness];
      if (!spec) throw new Error(`delegate takes web or omp, not "${harness}"`);
      if (!task) throw new Error('task required');

      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(15_000, Number(params.timeoutSeconds ?? 0) * 1000 || DELEGATE_TIMEOUT_MS),
      );

      const args = ['-p', '--mode', 'json', '--no-session'];
      // omp's --tools covers built-ins ONLY and hard-errors on anything else, so
      // hermit's tools are deliberately not unioned in here — unlike the pi side.
      if (spec.tools.length) args.push('--tools', spec.tools.join(','));
      const model = delegateModel();
      if (model) args.push('--model', model);
      // Let omp wind itself down before the hard kill, so a run that runs long
      // still reports what it found instead of dying mid-sentence.
      args.push('--max-time', `${Math.floor(timeoutMs / 1000)}`);

      const brief = systemMdFor(harness);
      const budget =
        'You are a delegated sub-agent: one shot, on a clock, and your reply is pasted into '
        + 'another agent\'s context. Prefer two to four searches and the two or three most '
        + 'authoritative pages. Answer compactly — findings and sources, no preamble. If the '
        + 'clock beats you, report what you verified and name what you did not.';
      args.push('--append-system-prompt', brief ? `${brief}\n\n---\n\n${budget}` : budget);
      args.push(task);

      const started = Date.now();
      const rowId = `${SESSION_ID}:delegate-${toolCallId}`;
      let lastPost = 0;

      const render = (steps: Step[], done: boolean, note = ''): string => {
        const secs = Math.round((Date.now() - started) / 1000);
        const counts = steps.reduce<Record<string, number>>((acc, s) => {
          acc[s.tool] = (acc[s.tool] ?? 0) + 1;
          return acc;
        }, {});
        const tally = Object.entries(counts).map(([k, v]) => `${v}× ${k}`).join(' · ') || 'starting…';
        const last = steps[steps.length - 1];
        const head = `[delegate → ${harness}${model ? ` · ${model.split('/').pop()}` : ''} · ${secs}s${done ? ' · done' : ''}]`;
        return [head, tally, last?.detail ? `↳ ${last.detail}` : '', note].filter(Boolean).join('\n');
      };

      const publish = (steps: Step[], done: boolean, note = '') => {
        const now = Date.now();
        if (!done && now - lastPost < PROGRESS_INTERVAL_MS) return;
        lastPost = now;
        const text = render(steps, done, note);
        // onUpdate feeds pi's own surfaces; postProgress feeds the dashboard,
        // which never sees tool_execution_update (translatePiEvent drops it).
        onUpdate?.({ content: [{ type: 'text', text }] });
        void postProgress(rowId, text);
      };

      publish([], false);
      const r = await runOmp(args, { timeoutMs, signal, onStep: (steps) => publish(steps, false) });

      const elapsed = Date.now() - started;
      const secs = Math.round(elapsed / 1000);
      const failed = r.code !== 0 && !r.answer;
      // omp's own --max-time exits 0, so the exit code cannot tell a finished run
      // from a guillotined one. Measured with --max-time 45: it stopped mid-stride
      // and its last assistant text was "Verified OpenAI Presence (official). Now
      // verifying other claims against primary sources." — a progress sentence,
      // 88 characters, which the parent would otherwise have read as the finding.
      // Anything that ran to the edge of its budget is treated as partial.
      const hitBudget = r.timedOut || elapsed >= timeoutMs * 0.9;
      publish(r.steps, true, hitBudget ? '(hit the time budget — partial)' : '');

      if (failed) {
        throw new Error(
          `${harness} harness failed after ${secs}s (exit ${r.code ?? 'killed'})`
          + `${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 500)}` : ''}`,
        );
      }

      const tally = r.steps.length ? ` after ${r.steps.length} step(s)` : '';
      const header = hitBudget
        ? `[${harness} harness · TRUNCATED at ${secs}s${tally} — it was still working when the clock ran out. `
          + `Treat the text below as PARTIAL: what it names as verified is verified, everything else is unfinished. `
          + `Re-delegate a narrower task if you need the rest.]`
        : `[${harness} harness · ${secs}s${tally}]`;
      return {
        content: [{ type: 'text', text: `${header}\n${r.answer.trim() || '(no answer produced)'}` }],
        details: { harness, model, seconds: secs, steps: r.steps, truncated: hitBudget },
      };
    },
  });

  pi.on('before_agent_start', async (event: any, _ctx: any) => {
    if (decided) return undefined;

    const prompt = String(event?.prompt ?? '').trim();
    if (!prompt) return undefined;

    // smol needs a key; without one route() runs the free rules and escalates on
    // abstain. Escalation here means "stay wide", which is the safe direction.
    const smol = Boolean(process.env.HERMIT_PI_API_KEY || process.env.HARNESS_ROUTER_KEY);
    let pick: { harness: string; via: string; confidence: number; why: string };
    try {
      pick = await route(prompt, { smol, apiKey: process.env.HERMIT_PI_API_KEY });
    } catch (e) {
      // A router that throws must not take the turn with it. Staying wide is
      // exactly the behaviour of every mode that existed before triage.
      console.warn('[triage] routing failed, staying wide:', (e as Error).message);
      return undefined;
    }

    decided = pick.harness;
    const note = `${pick.harness} · ${pick.via} ${pick.confidence.toFixed(2)} — ${pick.why}`;

    const remote = DELEGATE_ONLY[pick.harness];
    // Hermit's six always survive: they are the dashboard's ask / attach / title
    // plumbing, and a harness without them is mute.
    const keep = remote ? remote.local : PI_TOOLS[pick.harness];
    if (keep) pi.setActiveTools([...new Set([...keep, ...HERMIT_TOOLS, 'delegate'])]);

    const brief = systemMdFor(pick.harness);
    const extra = remote
      ? `${brief}\n\n**This session cannot run ${pick.harness} directly** — ${remote.why}. `
        + `Use the \`delegate\` tool with harness="${pick.harness}" for that part, and do the rest yourself. `
        + `Do not substitute curl, fetch, or a shell command for it: you would be guessing at content `
        + `the ${pick.harness} harness is built to read properly. Give it a NARROW task — it runs on a `
        + `clock, and a sprawling brief is what makes it slow.`
      : brief;

    return {
      systemPrompt: extra ? `${event.systemPrompt}\n\n---\n\n${extra}` : event.systemPrompt,
      // Visible in the transcript, so a bad route is diagnosable from the chat
      // rather than only from the gateway log.
      message: {
        customType: 'triage',
        content: `[triage → ${note}]`,
        display: true,
      },
    };
  });
}
