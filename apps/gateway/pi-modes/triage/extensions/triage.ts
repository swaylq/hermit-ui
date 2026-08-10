// triage — a harness that becomes the right harness.
//
// Every other mode in this repo is a fixed recipe someone picks. This one boots
// with the union of the cheap harnesses' tools, reads the first prompt, routes
// it, and then narrows itself to the winner: tool set via setActiveTools(), the
// winner's SYSTEM.md appended to the system prompt.
//
// Why that works, measured 2026-08-10 (docs/01-measurements.md):
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
import { execFile } from 'node:child_process';

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

function systemMdFor(harness: string): string {
  const p = path.join(MODE_ROOT, harness, 'SYSTEM.md');
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

/** Run a shell command, capped, never throwing. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string }) | null;
      const text = String(stdout ?? '') || String(stderr ?? '');
      resolve({ out: text, code: typeof e?.code === 'number' ? e.code : e ? null : 0 });
    });
    child.stdin?.end();
  });
}

/**
 * The router module, from wherever this copy of the mode is running.
 *
 * Deployed, `deploy.sh` has copied it in beside this file so the mode directory
 * is self-contained and never reaches back into the project tree at runtime. In
 * the source tree that copy does not exist, so fall back to the one source of
 * truth — otherwise benching straight out of `harnesses/` fails the spawn with
 * "Cannot find module route.mjs".
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
      'Run one bounded task on a harness this session cannot become: `web` (web_search — searching, reading a URL, current facts) or `omp` (a real browser — screenshots, UI behaviour, layout). Returns that run\'s final answer. Use it instead of guessing when the work needs a capability you do not have. One shot, no memory of this conversation, so put everything it needs in the task text.',
    parameters: {
      type: 'object',
      properties: {
        harness: { type: 'string', enum: ['web', 'omp'], description: 'Which harness to run it on.' },
        task: { type: 'string', description: 'Self-contained instruction, including any context it needs.' },
        timeoutSeconds: { type: 'number', description: 'Default 180, max 600.' },
      },
      required: ['harness', 'task'],
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const harness = String(params.harness ?? '');
      const task = String(params.task ?? '').trim();
      const spec = DELEGATE_ONLY[harness];
      if (!spec) throw new Error(`delegate takes web or omp, not "${harness}"`);
      if (!task) throw new Error('task required');

      const timeoutMs = Math.min(600_000, Math.max(10_000, Number(params.timeoutSeconds ?? 0) * 1000 || 180_000));
      const args = ['-p', '--no-session'];
      // omp's --tools covers built-ins ONLY and hard-errors on anything else, so
      // hermit's tools are deliberately not unioned in here — unlike the pi side.
      if (spec.tools.length) args.push('--tools', spec.tools.join(','));
      const sys = systemMdFor(harness);
      if (sys) args.push('--append-system-prompt', sys);
      if (process.env.HERMIT_PI_MODEL) args.push('--model', process.env.HERMIT_PI_MODEL);
      args.push(task);

      const { out, code } = await run('omp', args, timeoutMs);
      const body = out.trim() || '(no output)';
      return {
        content: [{
          type: 'text',
          text: code === 0
            ? `[${harness} harness]\n${body}`
            : `[${harness} harness failed, exit ${code ?? 'timeout'}]\n${body.slice(0, 2000)}`,
        }],
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
        + `the ${pick.harness} harness is built to read properly.`
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
