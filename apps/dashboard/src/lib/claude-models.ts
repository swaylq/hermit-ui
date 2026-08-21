// The Claude Code model catalogue — what the CLI on a machine says it can run.
//
// Deliberately not a list we maintain. `supportedModels()` is a control request
// the Agent SDK answers out of the CLI binary itself, so the picker offers
// exactly what THAT machine's claude would accept from `setModel()` — including
// the aliases (`opus[1m]`, `sonnet`) whose MEANING moves when Anthropic ships a
// new model. A catalogue hardcoded in the dashboard would be right until the day
// it silently was not, and the failure would look like a model switch that did
// nothing rather than like a stale list.
//
// The gateway pushes it (POST /api/sync/claude-models) when a claude-sdk session
// boots and whenever the answer changes; it lands on Machine.claudeModels.
// FALLBACK_CLAUDE_MODELS covers the machine that has never started one — a
// picker with nothing in it is worse than a picker one release behind.

export type ClaudeModel = {
  /** What `setModel()` takes — an alias (`sonnet`) or a full id. */
  value: string;
  displayName: string;
  description?: string;
};

/**
 * The catalogue row that means "whatever this CLI defaults to".
 *
 * Stored as NULL on the session, never as the string: the column means "no pin"
 * everywhere else in the resolver, and the SDK's own way of spelling it is
 * `setModel(undefined)`. Keeping one spelling of "unset" is what lets clearing
 * the pin restore the default without a respawn.
 */
export const DEFAULT_MODEL_VALUE = 'default';

/** The pin to store for a catalogue row: the default row pins nothing. */
export function modelPinOf(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return !v || v === DEFAULT_MODEL_VALUE ? null : v;
}

/**
 * What a machine offers before its gateway has ever reported.
 *
 * Copied verbatim from `supportedModels()` on claude 2.1.238, 2026-08-21 — the
 * version this fleet installs everywhere. It is a fallback, not a source of
 * truth: the moment one claude-sdk session takes a turn, that machine's own
 * answer replaces it. A row a given CLI does not know is refused by `setModel`
 * and logged, which is the failure this list can produce and the reason it is
 * copied from a real answer rather than composed by hand.
 */
export const FALLBACK_CLAUDE_MODELS: ClaudeModel[] = [
  { value: 'default', displayName: 'Default (recommended)', description: "The CLI's own default on this machine" },
  { value: 'opus[1m]', displayName: 'Opus (1M context)', description: 'Best for everyday, complex tasks' },
  { value: 'claude-fable-5[1m]', displayName: 'Fable', description: 'Most capable, for the hardest and longest-running tasks' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient for routine tasks' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers' },
];

/** Machine.claudeModels → a list a picker can render. Unreadable → fallback. */
export function claudeModelsOf(row: { claudeModels?: unknown } | null | undefined): ClaudeModel[] {
  const raw = row?.claudeModels;
  if (!Array.isArray(raw)) return FALLBACK_CLAUDE_MODELS;
  const models: ClaudeModel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const value = typeof r.value === 'string' ? r.value.trim() : '';
    if (!value) continue;
    const displayName = typeof r.displayName === 'string' && r.displayName.trim() ? r.displayName.trim() : value;
    const description = typeof r.description === 'string' && r.description.trim() ? r.description.trim() : undefined;
    models.push({ value, displayName, ...(description ? { description } : {}) });
  }
  return models.length > 0 ? models : FALLBACK_CLAUDE_MODELS;
}

/**
 * Chip-sized name: "Opus (1M context)" → "Opus".
 *
 * The parenthetical is what distinguishes two rows for the same family in the
 * MENU, where there is room for it. On a chip beside the backend name there is
 * not, and "Opus" is the part a human reads anyway.
 */
export function shortModelLabel(displayName: string): string {
  return displayName.replace(/\s*[([].*$/, '').trim() || displayName;
}

/**
 * What to write on the chip for a stored pin.
 *
 * A pin with no catalogue row still renders — as itself. That is the case where
 * the machine's claude no longer offers a model some session was pinned to, and
 * showing the raw id is the only answer that does not claim it is running
 * something else.
 */
export function modelChipLabel(pin: string | null | undefined, models: ClaudeModel[]): string {
  const v = (pin ?? '').trim();
  if (!v) {
    const row = models.find((m) => m.value === DEFAULT_MODEL_VALUE);
    return row ? shortModelLabel(row.displayName) : 'Default';
  }
  const row = models.find((m) => m.value === v);
  return row ? shortModelLabel(row.displayName) : v;
}
