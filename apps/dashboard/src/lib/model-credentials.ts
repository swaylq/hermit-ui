// The machine's model credentials — Settings → Models.
//
// A credential is an endpoint plus the NAME of the secret that authenticates to
// it, plus the models it serves. It belongs to no harness in particular: pi,
// prime and dsh all want the same thing, and before this they each grew their
// own way of asking for it (piConfig for pi, dshSource for dsh, nothing at all
// for a third).
//
// It never holds a key VALUE. The gateway resolves `secretKey` through the
// machine's own secret store at spawn time, which is the only place the value
// exists.
//
// There is deliberately NO subscription credential here. Claude Code and Codex
// authenticate as themselves, on the machine, and are exposed as the two
// built-in backends instead (see lib/backends.ts) — a subscription is not
// something you can point a third-party harness at without consequences, and
// the fleet has decided not to.
//
// See docs/backends-and-models-design.md.

/** Per-model window overrides for a model the gateway's table has not heard of. */
export type ModelLimits = { contextWindow?: number; maxTokens?: number };

export type ModelCredential = {
  /** Stable slug. Backends store this, so renaming `label` never breaks one. */
  id: string;
  label: string;
  /** The harness-facing provider name, e.g. "hyqubit", "openrouter", "zai". */
  provider: string;
  api: string;
  baseUrl: string;
  models: string[];
  /** Used when neither the session nor its agent pins one. Blank = models[0]. */
  defaultModel?: string;
  /** Name in the machine's secret store — never the value. */
  secretKey?: string | null;
  modelLimits?: Record<string, ModelLimits>;
};

export const DEFAULT_API = 'anthropic-messages';

/** What the API-type select offers, and what each one means on the wire. */
export const API_CHOICES: { value: string; label: string }[] = [
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
];

/**
 * Slugify a label into a credential id.
 *
 * Ids are referenced by backends, so they must be stable and URL-ish. Collisions
 * are resolved by the caller appending a counter rather than here, because only
 * the caller knows the existing set.
 */
export function credentialSlug(label: string): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base.slice(0, 40) || 'endpoint';
}

/** A slug not already taken in `existing`. */
export function uniqueCredentialId(label: string, existing: readonly string[]): string {
  const base = credentialSlug(label);
  if (!existing.includes(base)) return base;
  for (let n = 2; n < 200; n++) {
    const cand = `${base}-${n}`;
    if (!existing.includes(cand)) return cand;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Read the catalog off a Machine row's JSON column.
 *
 * Tolerates any shape and drops entries it cannot read, rather than throwing:
 * nothing validates what an older release wrote, and a single bad row must not
 * take the whole Models page (and every backend that reads it) down with it.
 */
export function modelCredentialsOf(
  row: { modelProviders?: unknown } | null | undefined,
): ModelCredential[] {
  const raw = row?.modelProviders;
  if (!Array.isArray(raw)) return [];
  const out: ModelCredential[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || !c.id) continue;
    if (typeof c.provider !== 'string' || !c.provider) continue;
    out.push({
      id: c.id,
      label: typeof c.label === 'string' && c.label ? c.label : c.id,
      provider: c.provider,
      api: typeof c.api === 'string' && c.api ? c.api : DEFAULT_API,
      baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : '',
      models: Array.isArray(c.models) ? c.models.filter((m): m is string => typeof m === 'string') : [],
      ...(typeof c.defaultModel === 'string' ? { defaultModel: c.defaultModel } : {}),
      ...(typeof c.secretKey === 'string' || c.secretKey === null ? { secretKey: c.secretKey as string | null } : {}),
      ...(c.modelLimits && typeof c.modelLimits === 'object' && !Array.isArray(c.modelLimits)
        ? { modelLimits: c.modelLimits as Record<string, ModelLimits> }
        : {}),
    });
  }
  return out;
}

export function credentialById(
  credentials: readonly ModelCredential[],
  id: string | null | undefined,
): ModelCredential | null {
  if (!id) return null;
  return credentials.find((c) => c.id === id) ?? null;
}

/** The model a new session on this credential gets when nothing pins one. */
export function defaultModelOf(c: ModelCredential | null | undefined): string | null {
  if (!c) return null;
  const explicit = c.defaultModel?.trim();
  if (explicit) return explicit;
  return c.models[0]?.trim() || null;
}

/** What the add-credential dialog holds, before it becomes a credential. */
export type CredentialForm = {
  label: string;
  provider: string;
  api: string;
  baseUrl: string;
  /** Comma-separated, as typed. */
  models: string;
  defaultModel: string;
  secretKey: string;
};

export const EMPTY_CREDENTIAL_FORM: CredentialForm = {
  label: '', provider: '', api: DEFAULT_API, baseUrl: '', models: '', defaultModel: '', secretKey: '',
};

/** A preset as form state, so the dialog and its test agree on what a preset is. */
export function formFromPreset(key: string): CredentialForm {
  const p = CREDENTIAL_PRESETS.find((x) => x.key === key) ?? CREDENTIAL_PRESETS[0];
  return {
    ...EMPTY_CREDENTIAL_FORM,
    label: p.fill.label ?? '',
    provider: p.fill.provider ?? '',
    api: p.fill.api ?? DEFAULT_API,
    baseUrl: p.fill.baseUrl ?? '',
    models: (p.fill.models ?? []).join(', '),
    secretKey: p.fill.secretKey ?? '',
  };
}

/**
 * What the dialog is about to append, from what the form holds.
 *
 * The rules that can actually be wrong, in one testable place:
 *
 *  - a blank label falls back to the provider id, so a preset needs no typing;
 *  - the id is derived from the label and made unique against what is already
 *    there — backends reference it, so two credentials sharing one would point
 *    a backend at the wrong endpoint;
 *  - the model list is split on commas and trimmed, dropping the empties a
 *    trailing comma leaves behind;
 *  - a blank defaultModel is OMITTED rather than stored as '', because
 *    defaultModelOf falls through to models[0] only when it is absent.
 */
export function credentialFrom(form: CredentialForm, existingIds: readonly string[]): ModelCredential {
  const label = form.label.trim() || form.provider.trim();
  const models = form.models.split(',').map((m) => m.trim()).filter(Boolean);
  const defaultModel = form.defaultModel.trim();
  return {
    id: uniqueCredentialId(label, existingIds),
    label,
    provider: form.provider.trim(),
    api: form.api.trim() || DEFAULT_API,
    baseUrl: form.baseUrl.trim(),
    models,
    ...(defaultModel ? { defaultModel } : {}),
    secretKey: form.secretKey.trim() || null,
  };
}

/**
 * One-click endpoint presets.
 *
 * Only fills the form; nothing is saved until the user does. `secretKey` names
 * the conventional secret for that vendor so the field is not blank on a fresh
 * entry — it is still just a name, and the store still has to hold it.
 */
export const CREDENTIAL_PRESETS: {
  key: string;
  label: string;
  fill: Partial<ModelCredential>;
  hint: string;
}[] = [
  {
    key: 'hyqubit',
    label: 'hyqubit (LiteLLM)',
    hint: 'The fleet endpoint. Anthropic Messages, claude-* model names.',
    fill: {
      label: 'hyqubit', provider: 'hyqubit', api: 'anthropic-messages',
      baseUrl: 'https://litellm.hyqubit.com', models: ['claude-opus-5', 'claude-sonnet-5'],
      secretKey: 'LITELLM_HYQUBIT_TOKEN',
    },
  },
  {
    key: 'kimi-code',
    label: 'Kimi Code (订阅)',
    hint: 'The Kimi membership endpoint. K3 at 1M context; its model ids are short (k3), not the platform’s kimi-k3.',
    fill: {
      label: 'Kimi Code', provider: 'kimi-coding', api: 'anthropic-messages',
      baseUrl: 'https://api.kimi.com/coding',
      models: ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
      secretKey: 'KIMI_API_KEY',
    },
  },
  {
    key: 'kimi',
    label: 'Kimi (Moonshot 开放平台)',
    hint: 'Pay-as-you-go, a different key and a different id namespace from Kimi Code.',
    fill: {
      label: 'Kimi', provider: 'moonshotai-cn', api: 'anthropic-messages',
      baseUrl: 'https://api.moonshot.cn/anthropic', models: ['kimi-k3'],
      secretKey: 'MOONSHOT_API_KEY',
    },
  },
  {
    key: 'glm',
    label: 'GLM (z.ai)',
    hint: 'Zhipu GLM through z.ai’s Anthropic-compatible endpoint.',
    fill: {
      label: 'GLM', provider: 'zai', api: 'anthropic-messages',
      baseUrl: 'https://api.z.ai/api/anthropic', models: ['glm-5.3'],
      secretKey: 'GLM_API_KEY',
    },
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    hint: 'Many vendors behind one key. OpenAI-shaped.',
    fill: {
      label: 'OpenRouter', provider: 'openrouter', api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1', models: [],
      secretKey: 'OPENROUTER_API_KEY',
    },
  },
  {
    key: 'custom',
    label: 'Custom…',
    hint: 'Any other endpoint. Fill the fields yourself.',
    fill: { api: 'anthropic-messages' },
  },
];
