// Unit tests for resolveResumedUuid — the post-`--resume` "which transcript is
// mine?" sniff. All of an agent's chat sessions share ONE project dir, so this
// resolver is the seam where a long resume can collide with a sibling session
// spawning fresh (observed 2026-07-25: a 186MB resume took 3m23s, a sibling chat
// started mid-wait, and the resuming session adopted the SIBLING's uuid — two
// dashboard sessions then pointed at one transcript, cross-posting each other's
// replies and wedging the delivery gate on the wrong file).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.ts exits the process without a key; nothing here talks to the dashboard.
process.env.ASST_KEY ||= 'test-key-unused';
const { resolveResumedUuid } = await import('./chat-runner');

const CWD = '/Users/test/agent';
const RECORDED = '11111111-1111-4111-8111-111111111111';
const SIBLING = '22222222-2222-4222-8222-222222222222';

let home: string;
let projectDir: string;
const realHome = process.env.HOME;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-resume-'));
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

function jsonl(uuid: string, lines: number): void {
  fs.writeFileSync(
    path.join(projectDir, `${uuid}.jsonl`),
    Array.from({ length: lines }, (_, i) => JSON.stringify({ uuid: `${uuid}-${i}` })).join('\n') + '\n',
  );
}
function append(uuid: string, text: string): void {
  fs.appendFileSync(path.join(projectDir, `${uuid}.jsonl`), JSON.stringify({ uuid: text }) + '\n');
}
function size(uuid: string): number {
  return fs.statSync(path.join(projectDir, `${uuid}.jsonl`)).size;
}
function clean(): void {
  for (const f of fs.readdirSync(projectDir)) fs.rmSync(path.join(projectDir, f));
}

describe('resolveResumedUuid', () => {
  it('never adopts a sibling session live transcript that appears mid-resume', async () => {
    clean();
    jsonl(RECORDED, 3);
    const baselineSize = size(RECORDED);
    const started = resolveResumedUuid({
      cwd: CWD,
      preExistingUuids: new Set([RECORDED]),
      recordedUuid: RECORDED,
      baselineSize,
      timeoutMs: 4000,
      exclude: () => new Set([SIBLING]), // owned by a live/starting sibling session
    });
    // A sibling chat spawns fresh in the same project dir while we're still waiting.
    setTimeout(() => jsonl(SIBLING, 2), 150);
    // Our own resumed claude finally writes its first line.
    setTimeout(() => append(RECORDED, 'resumed-turn'), 600);
    assert.equal(await started, RECORDED);
  });

  it('still adopts an unclaimed brand-new transcript (older claude forked a new uuid)', async () => {
    clean();
    jsonl(RECORDED, 3);
    const baselineSize = size(RECORDED);
    const started = resolveResumedUuid({
      cwd: CWD,
      preExistingUuids: new Set([RECORDED]),
      recordedUuid: RECORDED,
      baselineSize,
      timeoutMs: 4000,
      exclude: () => new Set(), // nobody owns it → it must be ours
    });
    setTimeout(() => jsonl(SIBLING, 2), 150);
    assert.equal(await started, SIBLING);
  });

  it('prefers the recorded transcript growing over any new file', async () => {
    clean();
    jsonl(RECORDED, 3);
    const baselineSize = size(RECORDED);
    // Both signals land before the first poll: growth must win, since current
    // claude appends in place and a new file can only be someone else's.
    append(RECORDED, 'resumed-turn');
    jsonl(SIBLING, 2);
    const uuid = await resolveResumedUuid({
      cwd: CWD,
      preExistingUuids: new Set([RECORDED]),
      recordedUuid: RECORDED,
      baselineSize,
      timeoutMs: 4000,
      exclude: () => new Set(),
    });
    assert.equal(uuid, RECORDED);
  });

  it('times out when only excluded transcripts appear', async () => {
    clean();
    jsonl(RECORDED, 3);
    jsonl(SIBLING, 2);
    await assert.rejects(
      resolveResumedUuid({
        cwd: CWD,
        preExistingUuids: new Set([RECORDED]),
        recordedUuid: RECORDED,
        baselineSize: size(RECORDED),
        timeoutMs: 600,
        exclude: () => new Set([SIBLING]),
      }),
      /Timed out waiting for resumed claude transcript/,
    );
  });
});
