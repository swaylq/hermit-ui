import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRuntimeSwitch } from './runtime-switch';

const claude = {
  backendId: 'claude-tmux', runtime: 'claude-tmux', runtimeCredentialId: null,
  runtimeProvider: null, runtimeModel: null, runtimeMode: null,
};
const pi = (
  provider: string | null = null,
  model: string | null = null,
  mode: string | null = 'coding',
  backendId = 'pi-hyqubit',
  runtimeCredentialId: string | null = 'hyqubit',
) => ({
  backendId,
  runtimeCredentialId,
  runtime: 'pi-rpc', runtimeProvider: provider, runtimeModel: model, runtimeMode: mode,
});

test('a mid-turn session refuses the switch', () => {
  const plan = planRuntimeSwitch({ state: 'working' }, claude, pi());
  assert.equal(plan.ok, false);
  assert.match(plan.ok === false ? plan.reason : '', /mid-turn/);
});

test('an idle session switches backends and needs the old process torn down', () => {
  assert.deepEqual(
    planRuntimeSwitch({ state: 'idle' }, claude, pi()),
    { ok: true, restart: true, resetExternalId: true },
  );
  assert.deepEqual(
    planRuntimeSwitch({ state: null }, pi(), claude),
    { ok: true, restart: true, resetExternalId: true },
  );
});

// claudeSessionId is one slot per session, whatever backend last held it. A
// claude uuid handed to codex is not merely useless — codex fails the turn with
// `thread/resume: no rollout found`, forever, and the chat goes silent. It has
// to be cleared on the way across.
test('crossing to another backend clears the external session id', () => {
  const codex = {
    backendId: 'codex-exec', runtime: 'codex-exec', runtimeCredentialId: null,
    runtimeProvider: null, runtimeModel: null, runtimeMode: null,
  };
  assert.deepEqual(
    planRuntimeSwitch({ state: 'idle' }, claude, codex),
    { ok: true, restart: true, resetExternalId: true },
  );
  assert.deepEqual(
    planRuntimeSwitch({ state: 'idle' }, codex, claude),
    { ok: true, restart: true, resetExternalId: true },
  );
});

// The trap this guards: `restart` and `resetExternalId` look interchangeable and
// are not. pi restarts to adopt a new model, and the whole point of that restart
// is that the SAME conversation continues on it.
test('restarting pi for a new model keeps its session id', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    pi('hyqubit', 'claude-opus-5'),
    pi('hyqubit', 'claude-sonnet-5'),
  );
  assert.deepEqual(plan, { ok: true, restart: true, resetExternalId: false });
});

// pi passes provider+model to RpcClient when it spawns the child, so a session
// already talking to one model cannot be re-pointed without a fresh child.
test('re-pointing a pi session at a different model restarts it', () => {
  const plan = planRuntimeSwitch({ state: 'idle' }, pi('hyqubit', 'claude-opus-5'), pi('hyqubit', 'claude-sonnet-5'));
  assert.deepEqual(plan, { ok: true, restart: true, resetExternalId: false });
});

test('a different pi provider restarts it too', () => {
  const plan = planRuntimeSwitch({ state: 'idle' }, pi('openrouter', 'x'), pi('hyqubit', 'x'));
  assert.deepEqual(plan, { ok: true, restart: true, resetExternalId: false });
});

test('re-saving a pi session unchanged does not restart it', () => {
  const plan = planRuntimeSwitch({ state: 'idle' }, pi('hyqubit', 'claude-opus-5'), pi('hyqubit', 'claude-opus-5'));
  assert.deepEqual(plan, { ok: true, restart: false, resetExternalId: false });
});

// Claude Code reads its model from the machine's ~/.claude/settings.json; these
// columns describe pi. Writing them on a claude session must not kill its pane.
test('provider/model churn on a claude session is inert', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    { ...claude, runtimeProvider: 'anthropic', runtimeModel: 'opus' },
    claude,
  );
  assert.deepEqual(plan, { ok: true, restart: false, resetExternalId: false });
});

test('null and undefined provider/model are the same absence', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    pi(null, null, null),
    {
      backendId: 'pi-hyqubit',
      runtimeCredentialId: 'hyqubit',
      runtime: 'pi-rpc',
      runtimeProvider: undefined as unknown as null,
      runtimeModel: undefined as unknown as null,
      runtimeMode: undefined as unknown as null,
    },
  );
  assert.deepEqual(plan, { ok: true, restart: false, resetExternalId: false });
});

// A mode is nothing but spawn arguments — system prompt, tool allowlist, skills,
// extensions. A running child cannot adopt a new one, so changing it must tear
// the child down exactly like changing the model does.
test('changing the pi mode restarts the child', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    pi('hyqubit', 'claude-opus-5', 'coding'),
    pi('hyqubit', 'claude-opus-5', 'ops'),
  );
  assert.deepEqual(plan, { ok: true, restart: true, resetExternalId: false });
});

test('same mode does not restart', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    pi('hyqubit', 'claude-opus-5', 'ops'),
    pi('hyqubit', 'claude-opus-5', 'ops'),
  );
  assert.deepEqual(plan, { ok: true, restart: false, resetExternalId: false });
});

test('mode churn on a claude session is inert', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    { ...claude, runtimeMode: 'ops' },
    { ...claude, runtimeMode: 'coding' },
  );
  assert.deepEqual(plan, { ok: true, restart: false, resetExternalId: false });
});

// Two backends can run the SAME harness against different credentials, and
// moving between them is every bit as much a backend change — different
// endpoint, different model catalog, and a session id the other side's provider
// never issued. Compared on backendId for exactly this case.
test('moving between two pi backends is a backend change, not a model change', () => {
  const plan = planRuntimeSwitch(
    { state: 'idle' },
    pi('hyqubit', 'claude-opus-5', 'coding', 'pi-hyqubit', 'hyqubit'),
    pi('moonshotai-cn', 'kimi-k3', 'coding', 'pi-kimi', 'kimi'),
  );
  assert.deepEqual(plan, { ok: true, restart: true, resetExternalId: true });
});

// Prime bakes provider, model and credential into the child at spawn, exactly
// as pi does — so it restarts on the same conditions and keeps its session id
// across them.
test('a prime session restarts for a new model and keeps its session id', () => {
  const prime = (model: string) => ({
    backendId: 'prime-kimi', runtime: 'prime-rpc', runtimeCredentialId: 'kimi',
    runtimeProvider: 'moonshotai-cn', runtimeModel: model, runtimeMode: null,
  });
  assert.deepEqual(
    planRuntimeSwitch({ state: 'idle' }, prime('kimi-k3'), prime('kimi-k2')),
    { ok: true, restart: true, resetExternalId: false },
  );
  assert.deepEqual(
    planRuntimeSwitch({ state: 'idle' }, prime('kimi-k3'), prime('kimi-k3')),
    { ok: true, restart: false, resetExternalId: false },
  );
});

// ── moving between the two Claude Code drivers ──────────────────────────────
//
// 'claude-sdk' and 'claude-tmux' are the same binary writing the same
// `~/.claude/projects/<cwd>/<uuid>.jsonl`. That makes them the one pair where
// the shared external-id column is NOT foreign across a switch — it is the
// conversation itself.

const cc = (harness: string) => ({
  backendId: harness, runtime: harness, runtimeCredentialId: null,
  runtimeProvider: null, runtimeModel: null, runtimeMode: null,
});

test('switching between the two claude drivers KEEPS the conversation', () => {
  // Clearing the id here would answer "change how this chat is driven" by
  // starting the user a brand-new chat — unrecoverable from the UI, and the
  // exact opposite of the intent.
  assert.deepEqual(
    planRuntimeSwitch({ state: 'idle' }, cc('claude-tmux'), cc('claude-sdk')),
    { ok: true, restart: true, resetExternalId: false },
  );
  // …and back, so the move is reversible rather than a one-way door.
  assert.deepEqual(
    planRuntimeSwitch({ state: 'idle' }, cc('claude-sdk'), cc('claude-tmux')),
    { ok: true, restart: true, resetExternalId: false },
  );
});

// The restart is still required: the outgoing driver has to let go of the
// transcript before the incoming one resumes it, or two Claude Codes end up
// appending to one file.
test('the claude↔claude switch still tears the old driver down', () => {
  const plan = planRuntimeSwitch({ state: 'idle' }, cc('claude-tmux'), cc('claude-sdk'));
  assert.equal(plan.ok && plan.restart, true);
});

test('leaving claude for another harness still drops the id', () => {
  for (const other of ['pi-rpc', 'prime-rpc', 'codex-exec', 'dsh-exec']) {
    for (const mine of ['claude-sdk', 'claude-tmux']) {
      const out = planRuntimeSwitch({ state: 'idle' }, cc(mine), cc(other));
      assert.equal(out.ok && out.resetExternalId, true, `${mine} → ${other}`);
      const back = planRuntimeSwitch({ state: 'idle' }, cc(other), cc(mine));
      assert.equal(back.ok && back.resetExternalId, true, `${other} → ${mine}`);
    }
  }
});

test('a mid-turn session refuses the switch on either claude driver', () => {
  assert.equal(
    planRuntimeSwitch({ state: 'working' }, cc('claude-tmux'), cc('claude-sdk')).ok,
    false,
  );
});
