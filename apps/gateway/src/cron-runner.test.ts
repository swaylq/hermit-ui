// Unit tests for adoptDriftTranscript — the "my pinned transcript never showed up,
// which file is actually mine?" pick a cron fire makes.
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
const { adoptDriftTranscript } = await import('./cron-runner');

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
