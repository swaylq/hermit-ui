import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerMachineProvider } from './hermit-pi-extension';

// The machine's endpoint is declared to the child with pi.registerProvider, and
// the key is handed over as an ENVIRONMENT REFERENCE so it never lands in a
// config object. The spelling of that reference is not portable across the
// pi family, and getting it wrong fails in the worst way available: the
// harness passes the unresolved string through as the credential, so the
// endpoint 401s with the reference itself in the error
// ("Received=$HERMIT_PI_API_KEY, expected to start with 'sk-'").
//
//   pi 0.83    resolve-config-value.ts parses a template — "$NAME" and
//              "${NAME}" interpolate, a bare word stays a literal.
//   prime 0.8  forked before that landed. resolveEnvOrLiteral does
//              process.env[config] — the BARE name — and returns the input
//              unchanged when the lookup misses.
//   omp        resolves models.yml `apiKey` as a bare name too, which is why
//              it is excluded from registration entirely (see below).
//
// Each one's correct value is another's silent 401, so these lock the spelling
// per runtime.

type Registered = { id: string; config: { apiKey?: string; baseUrl?: string; api?: string } };

function capture(env: Record<string, string | undefined>): Registered[] {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  // Delete rather than set-to-undefined: assigning undefined stringifies to
  // "undefined", which every trim()/truthiness check below would then pass.
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];

  const out: Registered[] = [];
  try {
    registerMachineProvider({ registerProvider: (id: string, config: Registered['config']) => out.push({ id, config }) });
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  return out;
}

const MACHINE = {
  HERMIT_PI_PROVIDER: 'hyqubit',
  HERMIT_PI_BASE_URL: 'https://litellm.hyqubit.com',
  HERMIT_PI_API: 'anthropic-messages',
  HERMIT_PI_MODELS: 'claude-opus-5',
};

test('pi gets the "$VAR" reference it interpolates', () => {
  const [reg] = capture({ ...MACHINE, HERMIT_RUNTIME: 'pi-rpc' });
  assert.equal(reg?.config.apiKey, '$HERMIT_PI_API_KEY');
});

// The regression this file exists for. prime looks the value up as
// process.env[apiKey], so a leading "$" makes the lookup miss and the literal
// reach the endpoint.
test('prime gets the BARE env var name, because it looks up process.env[apiKey]', () => {
  const [reg] = capture({ ...MACHINE, HERMIT_RUNTIME: 'prime-rpc' });
  assert.equal(reg?.config.apiKey, 'HERMIT_PI_API_KEY');
  assert.doesNotMatch(reg!.config.apiKey!, /^\$/, 'a "$" prefix is exactly what 401s on prime');
});

// An unset HERMIT_RUNTIME is the pi path, not an unknown one — the var was
// added after the pi backend shipped and a child spawned without it must keep
// working rather than silently lose its credential.
test('an unset runtime keeps pi\'s spelling', () => {
  const [reg] = capture({ ...MACHINE, HERMIT_RUNTIME: undefined });
  assert.equal(reg?.config.apiKey, '$HERMIT_PI_API_KEY');
});

// omp declares its providers in models.yml instead; registering here would
// overwrite that entry with a spelling omp passes through literally.
test('omp is not registered at all', () => {
  assert.deepEqual(capture({ ...MACHINE, HERMIT_RUNTIME: 'omp-rpc' }), []);
});

// Guards the branch against being reduced to "prime vs everything else": the
// endpoint still has to be declared for the registration to happen at all.
test('no endpoint means no registration, on either runtime', () => {
  for (const runtime of ['pi-rpc', 'prime-rpc']) {
    assert.deepEqual(
      capture({ ...MACHINE, HERMIT_PI_BASE_URL: undefined, HERMIT_RUNTIME: runtime }), [],
      `${runtime} should not register a provider with no baseUrl`,
    );
  }
});
