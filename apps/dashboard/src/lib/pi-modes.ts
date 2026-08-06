// How a pi mode is named in the UI.
//
// A mode is the recipe a pi child is spawned with — system prompt, tool
// allowlist, skills, extensions. The recipes themselves live on the gateway's
// disk (apps/gateway/pi-modes/<name>/); this file is only what the picker shows.
//
// Static rather than fetched: built-in modes ship in the same deploy as this
// dashboard, so the two are never out of step in practice, and a picker that
// blocks on a machine round-trip to render three options is not worth the
// column plus the push path it would cost.
//
// **Keep in step with apps/gateway/pi-modes/.** If they do drift, the failure is
// soft and one-directional: the gateway's resolveMode() falls back to the
// default mode and logs the unknown name, so an option listed here that the
// machine lacks degrades to plain pi rather than failing the spawn. A mode
// present on disk but missing here is simply not offered.
//
// See docs/pi-modes-design.md.

export const PI_MODES = ['coding', 'ops'] as const;
export type PiMode = (typeof PI_MODES)[number];

export const DEFAULT_PI_MODE: PiMode = 'coding';

export function isPiMode(v: string | null | undefined): v is PiMode {
  return PI_MODES.includes(v as PiMode);
}

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
};

export function piModeLabel(v: string | null | undefined): string {
  return isPiMode(v) ? PI_MODE_META[v].label : (v || PI_MODE_META[DEFAULT_PI_MODE].label);
}
