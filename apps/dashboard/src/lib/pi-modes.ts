// How a pi mode is named in the UI.
//
// A mode is the recipe a pi child is spawned with — system prompt, tool
// allowlist, skills, extensions. The recipes themselves live on the gateway's
// disk (apps/gateway/pi-modes/<name>/); this file is only what the picker shows.
//
// Static rather than fetched: built-in modes ship in the same deploy as this
// dashboard, so the two are never out of step in practice, and a picker that
// blocks on a machine round-trip to render a handful of options is not worth the
// column plus the push path it would cost.
//
// **Keep in step with apps/gateway/pi-modes/.** If they do drift, the failure is
// soft and one-directional: the gateway's resolveMode() falls back to the
// default mode and logs the unknown name, so an option listed here that the
// machine lacks degrades to plain pi rather than failing the spawn. A mode
// present on disk but missing here is simply not offered.
//
// See docs/pi-modes-design.md.

export const PI_MODES = [
  'coding', 'ops', 'omp', 'frontend', 'consultant', 'writer',
  // Task-shaped harnesses: split by which tools the work needs rather than by
  // role, which is what makes them routable. See apps/gateway/pi-modes/.
  'answer', 'scout', 'patch', 'shell', 'web',
  // The router. Offered as a card on the backend picker, not as a row below —
  // see PI_MODE_CHOICES.
  'triage',
] as const;
export type PiMode = (typeof PI_MODES)[number];

// The fleet default pi mode (stored as NULL on agent/session rows). omp
// (oh-my-pi) is the full-tool engine — sway's preferred default.
export const DEFAULT_PI_MODE: PiMode = 'omp';

export function isPiMode(v: string | null | undefined): v is PiMode {
  return PI_MODES.includes(v as PiMode);
}

/**
 * What a Mode dropdown offers — every mode except `triage`.
 *
 * triage is picked as a BACKEND card (runtime-labels.ts), and the new-chat
 * screen shows both controls at once: the same choice appearing as a card and
 * as a row on one screen reads as two different settings. It stays in PI_MODES
 * so `piModeLabel('triage')` still renders "Triage" wherever a session reports
 * running it.
 */
export const PI_MODE_CHOICES = PI_MODES.filter((m) => m !== 'triage');

/** Full name plus what the mode actually is, shown under the picker. */
export const PI_MODE_META: Record<PiMode, { label: string; blurb: string }> = {
  coding: {
    label: 'Coding',
    blurb: 'Read, write, run. The default working mode for changing a codebase.',
  },
  ops: {
    label: 'Ops',
    blurb: 'Live machines and services. Investigation discipline, read-before-write, ssh_run.',
  },
  omp: {
    label: 'omp (oh-my-pi)',
    blurb: '31 built-in tools: LSP, ast-edit, debug, browser, computer, github, memory.',
  },
  frontend: {
    label: 'Frontend',
    blurb: 'UI work in a real browser. Screenshot → fix → re-verify, breakpoints, DOM.',
  },
  consultant: {
    label: 'Consultant',
    blurb: 'Research-backed advice. Web search, read sources, cited structured replies.',
  },
  writer: {
    label: 'Writer',
    blurb: 'Long-form prose and copy. Voice, structure, editing passes.',
  },
  answer: {
    label: 'Answer',
    blurb: 'Think and reply. No repo, no web, no shell — the fastest harness there is.',
  },
  scout: {
    label: 'Scout',
    blurb: 'Read-only investigation. Where is it, how does it work, what calls it.',
  },
  patch: {
    label: 'Patch',
    blurb: 'Bounded code change. Read, edit, run the check, report the diff.',
  },
  shell: {
    label: 'Shell',
    blurb: 'Run and inspect things on this machine. Status, logs, processes.',
  },
  web: {
    label: 'Web',
    blurb: 'Anything that needs the internet. Search, read the page, cite it.',
  },
  triage: {
    label: 'Triage',
    blurb: 'Reads the task, then becomes the leanest harness that can finish it.',
  },
};
export function piModeLabel(v: string | null | undefined): string {
  return isPiMode(v) ? PI_MODE_META[v].label : (v || PI_MODE_META[DEFAULT_PI_MODE].label);
}
