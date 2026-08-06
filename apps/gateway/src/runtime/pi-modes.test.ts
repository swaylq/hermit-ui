import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildModeArgs, HERMIT_TOOL_NAMES, listModeNames, loadMode, type LoadedMode } from './pi-modes';

function mode(over: Partial<LoadedMode> = {}): LoadedMode {
  return { name: 'test', label: 'Test', dir: '/nonexistent', systemPrompt: '', ...over };
}

test('no mode means no extra arguments — pi spawns exactly as it did before modes', () => {
  assert.deepEqual(buildModeArgs(null, { agentDirectory: '/tmp' }), []);
});

// The whole reason buildModeArgs owns the union: `--tools` allowlists extension
// tools too, so a mode listing only built-ins would silently drop the
// dashboard's ask / attach / describe_image plumbing. Verified against the real
// CLI: `--tools read,grep,find,ls` reported exactly those four and none of ours.
test("a mode's tool allowlist always includes hermit's own tools", () => {
  const args = buildModeArgs(mode({ tools: ['read', 'bash'] }), { agentDirectory: '/tmp' });
  const tools = args[args.indexOf('--tools') + 1].split(',');
  for (const t of HERMIT_TOOL_NAMES) assert.ok(tools.includes(t), `missing ${t}`);
  assert.ok(tools.includes('read'));
  assert.ok(tools.includes('bash'));
});

test('a mode that already lists a hermit tool does not duplicate it', () => {
  const args = buildModeArgs(mode({ tools: ['read', 'ask'] }), { agentDirectory: '/tmp' });
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.equal(tools.filter((t) => t === 'ask').length, 1);
});

test('omitting tools omits --tools entirely, leaving pi its default active set', () => {
  assert.ok(!buildModeArgs(mode({}), { agentDirectory: '/tmp' }).includes('--tools'));
  assert.ok(!buildModeArgs(mode({ tools: [] }), { agentDirectory: '/tmp' }).includes('--tools'));
});

test('the system prompt is passed as TEXT, not a path', () => {
  // --append-system-prompt takes the prompt itself; handing it a filename would
  // put the literal string "SYSTEM.md" into the model's context.
  const args = buildModeArgs(mode({ systemPrompt: 'Be terse.' }), { agentDirectory: '/tmp' });
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'Be terse.');
});

test('an empty system prompt adds no flag', () => {
  assert.ok(!buildModeArgs(mode({ systemPrompt: '' }), { agentDirectory: '/tmp' })
    .includes('--append-system-prompt'));
});

test('a missing extension file is skipped, not passed to pi as a broken path', () => {
  // pi exits if --extension points at nothing, which would take out the whole
  // session for one bad entry in a mode.json.
  const args = buildModeArgs(mode({ extensions: ['./nope.ts'] }), { agentDirectory: '/tmp' });
  assert.deepEqual(args, []);
});

test('an extension that exists is passed as an absolute path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mode-'));
  fs.mkdirSync(path.join(dir, 'extensions'));
  const ext = path.join(dir, 'extensions', 'x.ts');
  fs.writeFileSync(ext, 'export default () => {};');
  const args = buildModeArgs(mode({ dir, extensions: ['./extensions/x.ts'] }), { agentDirectory: '/tmp' });
  assert.deepEqual(args, ['--extension', ext]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a skill is resolved from the agent's own skills dir", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-'));
  const skill = path.join(agentDir, '.claude', 'skills', 'japan-dev-ops');
  fs.mkdirSync(skill, { recursive: true });
  const args = buildModeArgs(mode({ skills: ['japan-dev-ops'] }), { agentDirectory: agentDir });
  assert.deepEqual(args, ['--skill', skill]);
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test("a mode-local skill wins over the agent's of the same name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mode-'));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-'));
  const local = path.join(dir, 'skills', 'dup');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(path.join(agentDir, '.claude', 'skills', 'dup'), { recursive: true });
  const args = buildModeArgs(mode({ dir, skills: ['dup'] }), { agentDirectory: agentDir });
  assert.deepEqual(args, ['--skill', local]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test('a skill that exists nowhere is skipped rather than failing the spawn', () => {
  const args = buildModeArgs(mode({ skills: ['ghost'] }), { agentDirectory: '/tmp' });
  assert.deepEqual(args, []);
});

// ── omp ─────────────────────────────────────────────────────────────────────
// omp's --tools rejects any name that is not one of its built-ins and hard-
// errors the spawn, while leaving extension tools available regardless. So the
// hermit union that pi needs is both wrong and pointless here.

test('omp never gets the hermit-tools union', () => {
  const args = buildModeArgs(
    mode({ engine: 'omp', tools: ['read', 'bash'] }),
    { agentDirectory: '/tmp' },
  );
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.deepEqual(tools, ['read', 'bash']);
  for (const t of HERMIT_TOOL_NAMES) assert.ok(!tools.includes(t), `${t} would fail the spawn`);
});

test('the same mode shape produces different args per engine', () => {
  // The one list, read twice. On pi it gains hermit's tools; on omp it must not.
  const shape = { tools: ['read', 'bash'] };
  const onPi = buildModeArgs(mode(shape), { agentDirectory: '/tmp' });
  const onOmp = buildModeArgs(mode({ ...shape, engine: 'omp' }), { agentDirectory: '/tmp' });
  assert.ok(onPi[onPi.indexOf('--tools') + 1].includes('ask'));
  assert.ok(!onOmp[onOmp.indexOf('--tools') + 1].includes('ask'));
});

test('omp with no tools keeps its full built-in surface', () => {
  assert.deepEqual(buildModeArgs(mode({ engine: 'omp' }), { agentDirectory: '/tmp' }), []);
});

test('omp gets no --skill flags', () => {
  // pi's --skill ADDS a path; omp's --skills FILTERS discovery, so passing a
  // mode's list there would hide every other skill the agent has. omp
  // discovers .claude/skills natively and needs no flag.
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-'));
  fs.mkdirSync(path.join(agentDir, '.claude', 'skills', 'japan-dev-ops'), { recursive: true });
  const args = buildModeArgs(
    mode({ engine: 'omp', skills: ['japan-dev-ops'] }),
    { agentDirectory: agentDir },
  );
  assert.ok(!args.includes('--skill'));
  assert.ok(!args.includes('--skills'));
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test('omp still gets extensions and the system prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mode-'));
  fs.mkdirSync(path.join(dir, 'extensions'));
  const ext = path.join(dir, 'extensions', 'x.ts');
  fs.writeFileSync(ext, 'export default () => {};');
  const args = buildModeArgs(
    mode({ engine: 'omp', dir, extensions: ['./extensions/x.ts'], systemPrompt: 'Be terse.' }),
    { agentDirectory: '/tmp' },
  );
  assert.deepEqual(args, ['--extension', ext, '--append-system-prompt', 'Be terse.']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a mode with no engine is pi, so existing modes are unchanged', () => {
  const args = buildModeArgs(mode({ tools: ['read'] }), { agentDirectory: '/tmp' });
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(tools.includes('ask'));
});

test('argument order: extensions, then tools, then skills, then the prompt', () => {
  const args = buildModeArgs(
    mode({ tools: ['read'], systemPrompt: 'x' }),
    { agentDirectory: '/tmp' },
  );
  assert.ok(args.indexOf('--tools') < args.indexOf('--append-system-prompt'));
});

// ── shipped modes (on-disk recipes) ─────────────────────────────────────────
// These read the real pi-modes/ directory, so they are the guard that a mode
// shipped in the repo actually loads and expands the way its mode.json claims.

test('every shipped mode is discoverable on disk', () => {
  const names = listModeNames();
  for (const n of ['coding', 'ops', 'omp', 'frontend', 'consultant', 'writer']) {
    assert.ok(names.includes(n), `${n} missing from [${names.join(', ')}]`);
  }
});

test('frontend mode runs on omp with a resident discipline prompt', () => {
  const m = loadMode('frontend');
  assert.ok(m, 'frontend mode should load');
  assert.equal(m.engine, 'omp');
  assert.ok(m.systemPrompt.length > 0, 'frontend needs a SYSTEM.md');
  // omp, no tools listed → full built-in surface; only the prompt is added.
  assert.deepEqual(buildModeArgs(m, { agentDirectory: '/tmp' }), [
    '--append-system-prompt',
    m.systemPrompt,
  ]);
});

test('consultant mode runs on omp with a resident discipline prompt', () => {
  const m = loadMode('consultant');
  assert.ok(m, 'consultant mode should load');
  assert.equal(m.engine, 'omp');
  assert.ok(m.systemPrompt.length > 0, 'consultant needs a SYSTEM.md');
  assert.deepEqual(buildModeArgs(m, { agentDirectory: '/tmp' }), [
    '--append-system-prompt',
    m.systemPrompt,
  ]);
});

test('writer mode stays on pi and unions hermit tools', () => {
  const m = loadMode('writer');
  assert.ok(m, 'writer mode should load');
  assert.equal(m.engine, 'pi');
  const args = buildModeArgs(m, { agentDirectory: '/tmp' });
  const toolsIdx = args.indexOf('--tools');
  assert.ok(toolsIdx >= 0, 'writer pins a tool allowlist');
  const tools = args[toolsIdx + 1].split(',');
  for (const h of HERMIT_TOOL_NAMES) {
    assert.ok(tools.includes(h), `writer must keep hermit tool ${h}`);
  }
  assert.ok(args.includes('--append-system-prompt'), 'writer keeps its SYSTEM.md');
  assert.ok(toolsIdx < args.indexOf('--append-system-prompt'));
});
