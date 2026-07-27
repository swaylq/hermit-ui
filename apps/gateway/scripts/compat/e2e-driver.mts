// e2e-driver.mts — end-to-end exercise of the REAL @hermit-ui/tmux-driver +
// gateway pane.ts against a fake `claude`, so the whole pane lifecycle can be
// verified on a host without Claude Code auth. Run from apps/gateway with tsx:
//   FAKE_CLAUDE=/tmp/fake-claude-e2e.sh npx tsx e2e-driver.mts
//
// Touches nothing production: its own scratch cwd, its own tmux session name,
// no dashboard/API imports.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ensureSession, tmuxSessionExists, tmuxPaneName, paneClaudeSessionId,
  awaitTranscript, listTranscripts, waitForReplReady, readComposer,
  sendKeys, confirmSubmitted, sendInterrupt, watchTranscript, kill as killPane,
  encodedProjectDir, listSessions,
} from '@hermit-ui/tmux-driver';
import { sessionActivity, WORK_MARKER_RE } from '../../src/pane.ts';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FAKE = process.env.FAKE_CLAUDE ?? path.join(HERE, 'fake-claude-e2e.sh');
const results: Array<{ step: string; ok: boolean; note: string }> = [];
function check(step: string, ok: boolean, note = '') {
  results.push({ step, ok, note });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step.padEnd(34)} ${note}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SESSION_ID = `e2eprobe${process.pid}`;
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-e2e-'));
const UUID = randomUUID();
const JSONL = path.join(encodedProjectDir(CWD), `${UUID}.jsonl`);

console.log(`\n=== tmux-driver E2E on ${process.platform} (${os.release()}) ===`);
console.log(`cwd:      ${CWD}`);
console.log(`pane:     ${tmuxPaneName(SESSION_ID)}`);
console.log(`transcript: ${JSONL}\n`);

let stopWatch: (() => void) | null = null;
try {
  // ── 1. spawn ───────────────────────────────────────────────────────────────
  const es = ensureSession({
    sessionId: SESSION_ID,
    cwd: CWD,
    claudeBin: FAKE,
    claudeSessionUuid: UUID,
    claudeArgs: ['--dangerously-skip-permissions'],
    env: { HERMIT_E2E: 'yes' },
    width: 200,
    height: 50,
  });
  check('ensureSession created pane', es.created === true, `name=${es.name}`);
  await sleep(800);
  check('tmuxSessionExists', tmuxSessionExists(SESSION_ID) === true);
  check('listSessions sees pane', listSessions('hermit-').includes(tmuxPaneName(SESSION_ID)));

  // ── 2. argv-based uuid recovery (ps -ww) ──────────────────────────────────
  const argvUuid = paneClaudeSessionId(SESSION_ID);
  check('paneClaudeSessionId from argv', argvUuid === UUID, `got=${argvUuid}`);

  // ── 3. transcript discovery (encodedProjectDir + stat) ────────────────────
  let transcriptOk = true;
  try { await awaitTranscript(JSONL, 10_000, 100); } catch (e) { transcriptOk = false; }
  check('awaitTranscript', transcriptOk, transcriptOk ? `${fs.statSync(JSONL).size}B` : 'timed out');
  const listed = listTranscripts(CWD);
  check('listTranscripts finds uuid', listed.some((t) => t.uuid === UUID), `${listed.length} transcript(s)`);

  // ── 4. composer detection (capture-pane + ❯) ──────────────────────────────
  const ready = await waitForReplReady(SESSION_ID, 10_000, 300);
  check('waitForReplReady (❯ visible)', ready === true);
  check('readComposer == clear', readComposer(SESSION_ID) === 'clear', `got=${readComposer(SESSION_ID)}`);

  // ── 5. live transcript watcher (tail -F) ──────────────────────────────────
  const seen: string[] = [];
  stopWatch = watchTranscript(JSONL, (ev) => { if (ev.uuid) seen.push(String(ev.uuid)); });
  await sleep(600);
  check('watchTranscript replays history', seen.some((u) => u.startsWith('u-1-')), `${seen.length} event(s)`);

  // ── 6. send a multi-line CJK message (send-keys -l -- + M-Enter + Enter) ──
  sendKeys(SESSION_ID, '你好 hermit EMIT\n第二行 ✓');
  const submitted = await confirmSubmitted(SESSION_ID, 8, 300);
  check('confirmSubmitted', submitted === true);
  await sleep(600);
  const recvPath = path.join(CWD, 'received.txt');
  const recv = fs.existsSync(recvPath) ? fs.readFileSync(recvPath, 'utf8') : '';
  check('pane received CJK line 1', recv.includes('你好 hermit'), JSON.stringify(recv.split('\n')[0] ?? ''));
  check('pane received CJK line 2', recv.includes('第二行 ✓'), JSON.stringify(recv.split('\n')[1] ?? ''));
  check('watcher saw live append', seen.some((u) => u.startsWith('a-1-')), `${seen.length} event(s)`);

  // ── 7. activity verdict: idle → work-marker ──────────────────────────────
  check('WORK_MARKER_RE matches CC line', WORK_MARKER_RE.test('✶ Considering… (6m 44s · thinking)'));
  console.log('       (waiting 11s for transcript freshness to expire…)');
  await sleep(11_000);
  const idle = await sessionActivity(SESSION_ID, { transcriptPath: JSONL });
  check('sessionActivity → idle', idle.working === false, `reason=${idle.reason}`);
  sendKeys(SESSION_ID, 'WORKMARKER');
  await sleep(1200);
  const busy = await sessionActivity(SESSION_ID, { transcriptPath: JSONL });
  check('sessionActivity → working', busy.working === true, `reason=${busy.reason}`);

  // ── 8. interrupt + teardown ──────────────────────────────────────────────
  sendInterrupt(SESSION_ID);
  check('sendInterrupt no-throw', true);
  stopWatch?.(); stopWatch = null;
  await killPane(SESSION_ID, 1500);
  check('kill removed pane', tmuxSessionExists(SESSION_ID) === false);
} catch (e) {
  check('UNEXPECTED THROW', false, e instanceof Error ? `${e.message}` : String(e));
} finally {
  try { stopWatch?.(); } catch {}
  try { await killPane(SESSION_ID, 500); } catch {}
  try { fs.rmSync(encodedProjectDir(CWD), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== E2E SUMMARY (${process.platform}): ${results.length - failed.length}/${results.length} passed ===`);
for (const f of failed) console.log(`  FAIL ${f.step} — ${f.note}`);
process.exit(failed.length ? 1 : 0);
