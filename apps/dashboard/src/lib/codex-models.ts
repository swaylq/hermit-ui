// The codex model catalogue — what the CLI on a machine says it can run, plus
// the model that machine falls back to.
//
// Same shape and same reasoning as lib/claude-models.ts: the list is the
// machine's own answer, not one the dashboard curates. codex keeps its catalogue
// in `<CODEX_HOME>/models_cache.json`, refreshed from the server on each run, and
// the gateway pushes the visible rows (POST /api/sync/codex-models) onto
// Machine.codexModels.
//
// One thing differs, and it is the reason this file exists rather than a second
// call into claude-models. A claude session with no pin shows "Default", because
// which model the CLI defaults to is genuinely unknown here. For codex the
// gateway DOES know — it resolves session pin → HERMIT_CODEX_MODEL → its own
// constant — so it reports that answer alongside the catalogue and the chip can
// name the model an unpinned session is actually running. "Is this session on
// Astra?" is a question you should not have to read a rollout file to answer.

import { DEFAULT_MODEL_VALUE, shortModelLabel } from './claude-models';

export type CodexModel = {
  /** codex's own slug — what `--model` and ThreadOptions.model take. */
  value: string;
  displayName: string;
  description?: string;
};

export type CodexCatalogue = {
  /** What an unpinned session on this machine runs. Never empty. */
  default: string;
  models: CodexModel[];
  /**
   * Whether that default came from the machine or from the guess below.
   *
   * Load-bearing, because the chip's whole point is naming the model a session
   * is really on. A gateway one restart behind still runs the PREVIOUS fleet
   * default — every box in this fleet was on gpt-5.6-sol until 2026-09-05 — so
   * writing "6-Astra" on a machine that has never reported would be a confident
   * lie in exactly the case the reader cannot check. Unreported machines get
   * "Default", the same thing claude says, until their gateway speaks up.
   */
  reported: boolean;
};

/**
 * The fleet default, as a last resort.
 *
 * The authority is `DEFAULT_MODEL` in apps/gateway/src/runtime/codex-exec.ts,
 * and the gateway reports it the first time any codex session takes a turn.
 * This copy only covers the machine that has never run one; if the two ever
 * disagree, the gateway is right and this is stale. Which is why an unreported
 * machine marks itself `reported: false` and the chip declines to name it —
 * this value picks the menu's highlighted row, it does not get to claim what a
 * session is running.
 */
export const FALLBACK_CODEX_DEFAULT = 'gpt-6-astra';

/**
 * What a machine offers before its gateway has reported.
 *
 * Copied from a real `models_cache.json` on 2026-09-05 (codex 0.153.4), the
 * rows with `visibility: "list"`, in codex's own priority order. A fallback,
 * not a source of truth: one codex turn on a machine replaces it with that
 * machine's own catalogue.
 */
export const FALLBACK_CODEX_MODELS: CodexModel[] = [
  { value: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Our most capable model for complex, demanding work.' },
  { value: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'Reliable agentic workhorse for everyday tasks.' },
  { value: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: 'Balanced agentic coding model for everyday work.' },
  { value: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', description: 'Fast and affordable agentic coding model.' },
  { value: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Proven previous-generation model for coding and general work.' },
  { value: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini', description: 'Small, fast, and cost-efficient model for simpler coding tasks.' },
  { value: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3-Codex-Spark', description: 'Ultra-fast coding model.' },
];

/** Machine.codexModels → a catalogue a picker can render. Unreadable → fallback. */
export function codexCatalogueOf(row: { codexModels?: unknown } | null | undefined): CodexCatalogue {
  const raw = row?.codexModels;
  // A bare array is accepted so the column can hold either shape — a gateway
  // one release behind pushes the models without a default, and answering that
  // with the fallback list would throw away a catalogue we were just handed.
  const obj = Array.isArray(raw) ? { models: raw } : (raw && typeof raw === 'object' ? raw as Record<string, unknown> : null);
  const list = Array.isArray(obj?.models) ? obj.models : [];
  const models: CodexModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const value = typeof r.value === 'string' ? r.value.trim() : '';
    if (!value) continue;
    const displayName = typeof r.displayName === 'string' && r.displayName.trim() ? r.displayName.trim() : value;
    const description = typeof r.description === 'string' && r.description.trim() ? r.description.trim() : undefined;
    models.push({ value, displayName, ...(description ? { description } : {}) });
  }
  const reported = typeof obj?.default === 'string' ? obj.default.trim() : '';
  if (models.length === 0) {
    return { default: reported || FALLBACK_CODEX_DEFAULT, models: FALLBACK_CODEX_MODELS, reported: !!reported };
  }
  // A catalogue with no default is a gateway one release behind: it knows the
  // machine's models, not which one an unpinned session lands on. Best guess is
  // codex's own priority order, and it is still a guess.
  return { default: reported || models[0].value, models, reported: !!reported };
}

/**
 * Chip-sized name for a codex slug: `gpt-6-astra` → `6-Astra`.
 *
 * The header meta line has ~30px to spare at 390px — the width the whole row was
 * tuned at — and "GPT-6-Astra" spends all of it on three characters every row in
 * the menu also starts with. What is left still carries the generation, which is
 * the part that distinguishes `5.6-Sol` from `5.5`. The full name is in the
 * tooltip and in the menu, where there is room.
 */
export function codexShortLabel(model: string, models: CodexModel[]): string {
  const id = model.trim();
  if (!id) return '';
  const row = models.find((m) => m.value === id);
  const name = shortModelLabel(row?.displayName ?? id);
  return name.replace(/^gpt-/i, '') || name;
}

/**
 * What to write on the chip: the model this session actually runs.
 *
 * A pin the catalogue has never heard of still renders — as itself — for the
 * same reason claude's does: showing something else would claim the session is
 * running a model it is not.
 */
export function codexChipLabel(pin: string | null | undefined, cat: CodexCatalogue): string {
  const v = (pin ?? '').trim();
  if (v) return codexShortLabel(v, cat.models);
  return cat.reported ? codexShortLabel(cat.default, cat.models) : 'Default';
}

/**
 * The menu rows: "Default" on top, then the catalogue.
 *
 * The default row pins nothing (it stores NULL, like claude's), so a session
 * left on it follows the machine forward when the fleet default moves — which
 * is the whole point of having a fleet default. It names today's answer in its
 * description rather than its label, because what it MEANS is "follow the
 * machine", not "run Astra".
 */
export function codexMenuModels(cat: CodexCatalogue): CodexModel[] {
  const current = cat.models.find((m) => m.value === cat.default);
  return [
    {
      value: DEFAULT_MODEL_VALUE,
      displayName: 'Default',
      description: cat.reported
        ? `Follows this machine — currently ${current?.displayName ?? cat.default}`
        : 'Follows this machine',
    },
    ...cat.models,
  ];
}
