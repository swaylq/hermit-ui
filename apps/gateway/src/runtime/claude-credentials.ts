// Pointing Claude Code at somebody else's endpoint.
//
// Claude Code reads its endpoint and its key from the environment, so the same
// binary that runs on this machine's subscription also runs Kimi K3, GLM or any
// other Anthropic-Messages endpoint — with its own tools, skills, hooks and
// CLAUDE.md intact. That is what makes `claude-sdk` composable with a
// credential from Settings → Models (lib/backends.ts) rather than a
// subscription-only backend like the pane and codex.
//
// Nothing here fires for the BUILT-IN Claude Code backend: it carries no
// credential, this returns an empty env, and the child inherits the gateway's
// own — i.e. the machine's login, exactly as before.
//
// Verified against Kimi Code before it shipped: `ANTHROPIC_BASE_URL=
// https://api.kimi.com/coding` + `ANTHROPIC_AUTH_TOKEN` + `--model k3[1m]`
// answers, streams, and reports a 1,000,000-token window.

import { getCredential, credentialDefaultModel, type ModelCredential } from '../pi-config';
import { readSecret } from './pi-credentials';

/**
 * Every model slot Claude Code resolves on its own.
 *
 * A turn is not one model call. The CLI reaches for a small model to name a
 * conversation, summarise a Bash command and run its own background chores, and
 * for a subagent it reaches for whichever family the Task asked for — by
 * ANTHROPIC name (`claude-haiku-…`), which exists at no third-party endpoint.
 *
 * Kimi's own Claude Code guide pins all of them to the one model for exactly
 * this reason, and it matters more than it looks: api.kimi.com does NOT reject
 * an unknown model id, it answers on something of its choosing. So leaving a
 * slot unset does not fail loudly — it quietly bills a different model than the
 * chat header claims to be running.
 */
export const CLAUDE_MODEL_SLOTS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

/**
 * The variable that must NOT survive into the child.
 *
 * `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are two spellings of the same
 * slot and the CLI warns when both are present. A gateway whose own environment
 * carries one would hand every composed session an ambiguous auth state, so the
 * child's copy is deleted rather than overwritten — see applyCredentialEnv.
 */
export const CONFLICTING_AUTH_VARS = ['ANTHROPIC_API_KEY'] as const;

/** Is this credential something Claude Code can actually be pointed at? */
export function isClaudeCompatible(c: ModelCredential | null | undefined): boolean {
  if (!c?.baseUrl?.trim()) return false;
  // The CLI speaks one protocol. An OpenAI-shaped endpoint (OpenRouter, a
  // vLLM box) is a real credential that pi and prime use happily, and pairing
  // it with this harness would 404 at the first message with nothing on screen
  // to say why — so it is refused here, where the log can say so.
  return (c.api?.trim() || 'anthropic-messages') === 'anthropic-messages';
}

/**
 * The env that points one Claude Code child at one credential.
 *
 * Pure, so the mapping is testable without a secret store or a database. Empty
 * when there is nothing to point at, which is the built-in backend's answer and
 * means "inherit the gateway's own environment".
 */
export function claudeCredentialEnv(
  credential: ModelCredential | null | undefined,
  apiKey: string | null,
  model: string | null | undefined,
): Record<string, string> {
  if (!isClaudeCompatible(credential) || !apiKey) return {};
  const c = credential!;
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: c.baseUrl.trim(),
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };

  const id = model?.trim() || credentialDefaultModel(c) || '';
  if (id) for (const slot of CLAUDE_MODEL_SLOTS) env[slot] = id;

  // Reason as hard as the model allows — the same setting the built-in backend
  // already runs (`effort: 'max'` in the query options, matching the pane's
  // `--effort max`). Stated as an environment variable as well because that is
  // the knob a third-party endpoint reads: Kimi's own Claude Code guide sets
  // CLAUDE_CODE_EFFORT_LEVEL, and K3 in particular cannot turn thinking off, so
  // the only question is how much of it we ask for.
  env.CLAUDE_CODE_EFFORT_LEVEL = 'max';

  // A window the CLI cannot infer from the model name. `k3[1m]` carries its own
  // (the bracketed suffix is a Claude Code alias it parses), so this is only
  // for the ids that do not — set `modelLimits` on the credential and the
  // session compacts at the right point instead of at the CLI's 200k guess.
  const window = c.modelLimits?.[id]?.contextWindow;
  if (window && Number.isFinite(window) && window > 0) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(Math.floor(window));
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.floor(window));
  }
  return env;
}

/**
 * Resolve a session's credential into a child env. `{}` for the built-in.
 *
 * The key is read from the machine's encrypted store at spawn and lives only in
 * the child's environment — never on a command line, never in a config file,
 * never in a log.
 */
export async function claudeSdkEnv(
  credentialId: string | null | undefined,
  model: string | null | undefined,
): Promise<Record<string, string>> {
  if (!credentialId) return {};
  const credential = await getCredential(credentialId);
  if (!credential) {
    console.warn(`[claude-sdk] credential ${credentialId} is not on this machine — falling back to its own login`);
    return {};
  }
  if (!isClaudeCompatible(credential)) {
    console.warn(
      `[claude-sdk] credential ${credentialId} is ${credential.api || 'openai-shaped'} with baseUrl ` +
      `"${credential.baseUrl}" — Claude Code speaks anthropic-messages only, so it cannot be pointed at it`,
    );
    return {};
  }
  const secretName = credential.secretKey?.trim();
  const key = secretName ? await readSecret(secretName) : null;
  if (!key) {
    console.warn(`[claude-sdk] credential ${credentialId} names secret "${secretName ?? '(none)'}", which this machine's store does not hold`);
    return {};
  }
  return claudeCredentialEnv(credential, key, model);
}

/**
 * Fold a credential env into a child's, removing what would conflict with it.
 *
 * Mutates and returns `env` — the caller has already built `{...process.env}`,
 * and the deletion has to happen on that copy: an inherited ANTHROPIC_API_KEY
 * cannot be overridden, only removed.
 */
export function applyCredentialEnv(
  env: Record<string, string | undefined>,
  credentialEnv: Record<string, string>,
): Record<string, string | undefined> {
  if (Object.keys(credentialEnv).length === 0) return env;
  for (const name of CONFLICTING_AUTH_VARS) delete env[name];
  Object.assign(env, credentialEnv);
  return env;
}
