// Unit tests for the pure decisions a cron fire makes about its OWN OUTPUT: which
// transcript is mine (adoptDriftTranscript), what the run asked the SCHEDULE to do
// (parseRunMarkers), and how much of the result survives the trip to the dashboard
// (capOutput). The first two have shipped a wrong report to a real reader.
//
// adoptDriftTranscript — the "my pinned transcript never showed up, which file is
// actually mine?" pick.
//
// An agent's crons and its dashboard chats write into ONE ~/.claude/projects/<cwd> dir.
// The exclusion set used to hold only sibling CRON uuids, and a chat that is mid-turn is
// by construction the newest file in that dir — so a fire whose pinned transcript was
// late adopted the live CHAT and reported the chat's last assistant message as the
// cron's result (observed 2026-08-09: two daily-report crons, 03:04 and 09:00, both
// adopted the same chat session; the reports themselves had run fine and were sitting in
// the pinned transcripts, which appeared about a second past the 30s wait).
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.ts exits the process without a key; nothing here talks to the dashboard.
process.env.ASST_KEY ||= 'test-key-unused';
const { adoptDriftTranscript, capOutput, cronPaneEnv, parseRunMarkers } = await import('./cron-runner');

const CWD = '/Users/test/agent';
const PINNED = '11111111-1111-4111-8111-111111111111';       // this fire's own uuid
const SIBLING_CRON = '22222222-2222-4222-8222-222222222222'; // another fire, in flight
const LIVE_CHAT = '33333333-3333-4333-8333-333333333333';    // a dashboard chat, typing
const DRIFTED = '44444444-4444-4444-8444-444444444444';      // what real drift looks like

// The fire's clock. resolveLiveTranscript only consults Date.now() for maxAgeMs, which
// this path doesn't set, so fixing the start makes every case deterministic.
const FIRE_START = 1_770_000_000_000;
const MIN_MTIME = FIRE_START - 2_000; // the same lower bound cron-runner passes

let home: string;
let projectDir: string;
const realHome = process.env.HOME;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cron-drift-'));
  // encodedProjectDir() resolves ~/.claude/projects/<cwd with / → ->; os.homedir()
  // honors $HOME on POSIX, so pointing HOME at a tmp dir keeps the test hermetic.
  process.env.HOME = home;
  projectDir = path.join(home, '.claude', 'projects', CWD.replace(/\//g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
});
after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of fs.readdirSync(projectDir)) fs.rmSync(path.join(projectDir, f));
});

// A non-empty transcript with an explicit mtime — mtime is the only ordering signal the
// picker has, and the whole bug lives in which file sorts newest.
function transcript(uuid: string, mtimeMs: number): void {
  const p = path.join(projectDir, `${uuid}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({ uuid }) + '\n');
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

function adopt(chatOwned: string[] = [LIVE_CHAT]) {
  return adoptDriftTranscript(CWD, {
    pinned: new Set([PINNED, SIBLING_CRON]),
    chatOwned: new Set(chatOwned),
    minMtimeMs: MIN_MTIME,
  });
}

describe('adoptDriftTranscript', () => {
  it('never adopts a live chat transcript, however fresh it is', () => {
    transcript(LIVE_CHAT, FIRE_START + 30_000); // the chat is mid-turn: newest by far
    assert.equal(adopt(), null);
  });

  it('still adopts a genuinely drifted transcript sitting under a newer chat', () => {
    transcript(DRIFTED, FIRE_START + 1_000);
    transcript(LIVE_CHAT, FIRE_START + 30_000); // newer, but owned — must be skipped
    assert.equal(adopt()?.uuid, DRIFTED);
  });

  it('never adopts a sibling fire pinned transcript', () => {
    transcript(SIBLING_CRON, FIRE_START + 5_000);
    assert.equal(adopt(), null);
  });

  it('ignores transcripts written before this fire started', () => {
    transcript(DRIFTED, FIRE_START - 60_000); // yesterday's run, same project dir
    assert.equal(adopt(), null);
  });

  it('adopts the newest of several unowned drift candidates', () => {
    transcript(DRIFTED, FIRE_START + 1_000);
    const newer = '55555555-5555-4555-8555-555555555555';
    transcript(newer, FIRE_START + 2_000);
    assert.equal(adopt()?.uuid, newer);
  });

  it('with no chat sessions live, behaves exactly as before', () => {
    transcript(DRIFTED, FIRE_START + 1_000);
    assert.equal(adopt([])?.uuid, DRIFTED);
  });
});

// capOutput — the cap on what a run ships to the dashboard. The old cut kept the LAST
// 4096 chars and said nothing about it, so a long daily report was delivered starting
// mid-sentence with its headline gone, and read as a cron that never wrote one.
describe('capOutput', () => {
  it('leaves anything within the cap completely untouched', () => {
    assert.equal(capOutput('short report', 4096), 'short report');
    const exact = 'x'.repeat(100);
    assert.equal(capOutput(exact, 100), exact);
  });

  it('keeps the HEAD — a report leads with its outcome', () => {
    const report = 'THE HEADLINE\n' + 'body '.repeat(1000);
    const out = capOutput(report, 200);
    assert.ok(out.startsWith('THE HEADLINE'), 'the lead must survive the cut');
  });

  it('never truncates silently — the notice states what was dropped', () => {
    const out = capOutput('y'.repeat(14_101), 4_096);
    assert.match(out, /output truncated/);
    assert.match(out, /4,096/);  // kept
    assert.match(out, /14,101/); // original length
    assert.match(out, /10,005/); // dropped
  });

  it('names the transcript that still holds the full text', () => {
    const out = capOutput('z'.repeat(500), 100, '/tmp/projects/run.jsonl');
    assert.match(out, /Full text: \/tmp\/projects\/run\.jsonl/);
    // …and stays sane when the run never resolved one.
    assert.doesNotMatch(capOutput('z'.repeat(500), 100), /Full text/);
  });

  it('lets the notice exceed the cap rather than cutting itself off', () => {
    const out = capOutput('w'.repeat(500), 100);
    assert.ok(out.length > 100, 'the marker is appended past the cap on purpose');
    assert.equal(out.slice(0, 100), 'w'.repeat(100));
  });

  it('a 14k report at the new 32K cap is delivered whole', () => {
    const report = 'r'.repeat(14_101);
    assert.equal(capOutput(report, 32_768), report);
  });
});

// parseRunMarkers — the run's own say over the SCHEDULE. A cron that iterates toward a
// goal ends itself with a lone `CRON_DONE` last line; one that picks its own cadence
// says `CRON_NEXT <minutes>`. Both are read from the FULL output (before capOutput,
// which keeps the head) and stripped from the report the human reads.
describe('parseRunMarkers', () => {
  const REPORT = [
    '# Nightly sweep',
    '',
    'Checked 41 repos, 3 needed a rebase, all 3 rebased cleanly.',
    'Nothing needs a human.',
  ].join('\n');

  it('leaves a report with no markers exactly as it was', () => {
    const r = parseRunMarkers(REPORT);
    assert.equal(r.output, REPORT);
    assert.equal(r.done, false);
    assert.equal(r.nextIntervalSec, null);
  });

  it('CRON_DONE as the last line ends the cron and leaves the chat', () => {
    const r = parseRunMarkers(REPORT + '\n\nCRON_DONE');
    assert.equal(r.done, true);
    assert.equal(r.output, REPORT, 'the report text survives intact, minus the marker');
    assert.doesNotMatch(r.output, /CRON_DONE/);
  });

  it('a marker QUOTED mid-report never ends the cron', () => {
    // The case this window exists for: an agent asked "how do I stop a cron?"
    // explains the protocol, and its explanation must not execute it.
    const explainer = [
      'To stop a cron from inside a run, end the reply with a line reading only',
      'CRON_DONE',
      'and the gateway does the rest.',
      ...Array.from({ length: 40 }, (_, i) => `detail line ${i}`),
      'That is all for today.',
    ].join('\n');
    const r = parseRunMarkers(explainer);
    assert.equal(r.done, false);
    assert.equal(r.output, explainer, 'nothing outside the window is touched');
  });

  it('CRON_NEXT 45 re-paces to 2700 seconds', () => {
    const r = parseRunMarkers(REPORT + '\nCRON_NEXT 45');
    assert.equal(r.nextIntervalSec, 2700);
    assert.equal(r.done, false);
    assert.equal(r.output, REPORT);
  });

  it('accepts the ends of the allowed range (1 minute … 7 days)', () => {
    assert.equal(parseRunMarkers('x\nCRON_NEXT 1').nextIntervalSec, 60);
    assert.equal(parseRunMarkers('x\nCRON_NEXT 10080').nextIntervalSec, 604_800);
  });

  it('refuses an out-of-range interval rather than clamping it', () => {
    // 0 would mean "fire continuously" and 99999 minutes is ~69 days: both are a
    // typo, and falling back to the cron's stored interval beats acting on one.
    const zero = parseRunMarkers(REPORT + '\nCRON_NEXT 0');
    assert.equal(zero.nextIntervalSec, null);
    const huge = parseRunMarkers(REPORT + '\nCRON_NEXT 99999');
    assert.equal(huge.nextIntervalSec, null);
    // …but it was still a marker line, so it does not leak into the report.
    assert.equal(zero.output, REPORT);
    assert.equal(huge.output, REPORT);
  });

  it('ignores a CRON_NEXT it cannot parse, and leaves that line alone', () => {
    for (const bad of ['CRON_NEXT', 'CRON_NEXT abc', 'CRON_NEXT 45 minutes', 'CRON_NEXT 123456', 'CRON_NEXTt 5']) {
      const r = parseRunMarkers(`${REPORT}\n${bad}`);
      assert.equal(r.nextIntervalSec, null, bad);
      assert.equal(r.output, `${REPORT}\n${bad}`, `${bad} is not a marker, so it stays put`);
    }
  });

  it('handles both markers together', () => {
    const r = parseRunMarkers(`${REPORT}\nCRON_NEXT 30\nCRON_DONE`);
    assert.equal(r.done, true);
    assert.equal(r.nextIntervalSec, 1800);
    assert.equal(r.output, REPORT);
  });

  it('still sees a marker followed by blank lines', () => {
    // A pane-captured final message routinely ends with trailing newlines.
    const r = parseRunMarkers(`${REPORT}\nCRON_DONE\n\n   \n`);
    assert.equal(r.done, true);
    assert.equal(r.output, REPORT);
  });

  it('tolerates surrounding whitespace on the marker line itself', () => {
    assert.equal(parseRunMarkers('x\n   CRON_DONE  ').done, true);
    assert.equal(parseRunMarkers('x\n\tCRON_NEXT 15\t').nextIntervalSec, 900);
  });

  it('takes the LAST CRON_NEXT when a run emits more than one', () => {
    const r = parseRunMarkers(`${REPORT}\nCRON_NEXT 10\nCRON_NEXT 20`);
    assert.equal(r.nextIntervalSec, 1200);
    assert.equal(r.output, REPORT);
  });

  it('is not fooled by a marker with anything else on its line', () => {
    const line = 'Done for now — CRON_DONE';
    const r = parseRunMarkers(`${REPORT}\n${line}`);
    assert.equal(r.done, false);
    assert.equal(r.output, `${REPORT}\n${line}`);
  });

  it('a marker-only reply reduces to an empty report', () => {
    const r = parseRunMarkers('CRON_DONE');
    assert.equal(r.done, true);
    assert.equal(r.output, '');
  });

  it('is pure — the same input twice gives the same answer', () => {
    const input = `${REPORT}\nCRON_NEXT 45`;
    assert.deepEqual(parseRunMarkers(input), parseRunMarkers(input));
    assert.equal(input, `${REPORT}\nCRON_NEXT 45`, 'the argument is not mutated');
  });
});

describe('cronPaneEnv', () => {
  it('keeps the machine credential out of an ordinary headless cron', () => {
    const env = cronPaneEnv(false, 'ordinary-run');
    assert.equal(Object.hasOwn(env, 'HERMIT_KEY'), false);
    assert.equal(Object.hasOwn(env, 'HERMIT_DASHBOARD_URL'), false);
    assert.equal(Object.hasOwn(env, 'HERMIT_SESSION_ID'), false);
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  });

  it('supplies hermit variables only to an orchestrator cron with its MCP', () => {
    const env = cronPaneEnv(true, 'brain-run');
    assert.equal(Object.hasOwn(env, 'HERMIT_KEY'), true);
    assert.equal(Object.hasOwn(env, 'HERMIT_DASHBOARD_URL'), true);
    assert.equal(env.HERMIT_SESSION_ID, 'brain-run');
  });
});
