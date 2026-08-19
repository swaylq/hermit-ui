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
const { resolveResumedUuid, robustSubmit } = await import('./chat-runner');
type SubmitDeps = Parameters<typeof robustSubmit>[4];

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

// robustSubmit — the "did this message actually run?" gate.
//
// 2026-08-14: ten sessions on one machine were each sitting on a message that had
// been typed into the pane and then vanished — no turn, no reply, and no warning,
// because the warm path called a cleared composer proof of submission. The proof is
// the transcript growing; these tests are the two halves of that rule — a send that
// grew nothing is retried and then reported, and growth from ANY source (including a
// turn our message merely queued behind) stops us re-typing into a duplicate.
describe('robustSubmit', () => {
  const SID = 'cmtestsession0001';
  const UUID = '33333333-3333-4333-8333-333333333333';
  const jsonlPath = () => path.join(projectDir, `${UUID}.jsonl`);

  // A pane that takes the keys, clears its composer, and runs nothing — the drop.
  function deps(over: Partial<SubmitDeps> = {}): SubmitDeps & { sends: string[] } {
    const sends: string[] = [];
    return {
      sends,
      sendKeys: (_id: string, text: string) => { sends.push(text); },
      confirmSubmitted: async () => true,          // composer cleared
      readComposer: () => 'clear' as const,
      waitForReplReady: async () => true,
      dismissFocusStealer: async () => 'none' as const, // composer has focus
      diagnoseFailedSubmit: async () => 'deaf-pane' as const,
      nap: async () => {},                          // no real waiting in tests
      ...over,
    };
  }
  const session = { id: SID };

  it('a cleared composer is not proof: no transcript growth → re-send once, then unsent', async () => {
    clean();
    jsonl(UUID, 2);
    const d = deps();
    assert.equal(await robustSubmit(session, { jsonlPath: jsonlPath() }, 'hello', false, d), 'unsent');
    assert.deepEqual(d.sends, ['hello', 'hello']); // dropped text is safe to re-type
  });

  it('growth right after the send is delivered, with exactly one send', async () => {
    clean();
    jsonl(UUID, 2);
    const d = deps();
    d.sendKeys = (_id: string, text: string) => { d.sends.push(text); append(UUID, 'turn-started'); };
    assert.equal(await robustSubmit(session, { jsonlPath: jsonlPath() }, 'hi', false, d), 'delivered');
    assert.deepEqual(d.sends, ['hi']);
  });

  it('a first send that drops and a second that lands is delivered', async () => {
    clean();
    jsonl(UUID, 2);
    const d = deps();
    let n = 0;
    d.sendKeys = (_id: string, text: string) => { d.sends.push(text); if (++n === 2) append(UUID, 'turn-started'); };
    assert.equal(await robustSubmit(session, { jsonlPath: jsonlPath() }, 'hi', false, d), 'delivered');
    assert.equal(d.sends.length, 2);
  });

  it('never re-types into a turn already in flight — growth is growth', async () => {
    clean();
    jsonl(UUID, 2);
    // The transcript is moving because a turn we queued behind is writing to it.
    const d = deps({ nap: async () => { append(UUID, 'someone-elses-line'); } });
    assert.equal(await robustSubmit(session, { jsonlPath: jsonlPath() }, 'hi', false, d), 'delivered');
    assert.equal(d.sends.length, 1);
  });

  it('text still buffered is hammered with Enter, never re-typed, then diagnosed', async () => {
    clean();
    jsonl(UUID, 2);
    let enters = 0;
    const d = deps({
      confirmSubmitted: async () => { enters++; return false; },
      readComposer: () => 'text' as const,
    });
    assert.equal(await robustSubmit(session, { jsonlPath: jsonlPath() }, 'hi', false, d), 'deaf-pane');
    assert.equal(d.sends.length, 1);  // re-typing on top of buffered text would duplicate
    assert.equal(enters, 2);          // the send's own confirm, then the hammer round
  });

  // 2026-08-19: a /compact left Claude Code's artifact chip holding focus, so the pane
  // was not slow — it was pointed somewhere else, and every character typed at it was
  // swallowed. Focus has to be taken back BEFORE the keystrokes, on the retry too: a
  // send into a stolen-focus pane loses the message outright.
  it('hands focus back to the composer before typing, on every send', async () => {
    clean();
    jsonl(UUID, 2);
    const order: string[] = [];
    const d = deps({
      dismissFocusStealer: async () => { order.push('dismiss'); return 'dismissed' as const; },
      sendKeys: (_id: string, text: string) => { order.push(`send:${text}`); },
    });
    assert.equal(await robustSubmit(session, { jsonlPath: jsonlPath() }, 'hi', false, d), 'unsent');
    assert.deepEqual(order, ['dismiss', 'send:hi', 'dismiss', 'send:hi']);
  });

  it('a cold start waits for the REPL before typing', async () => {
    clean();
    jsonl(UUID, 2);
    const order: string[] = [];
    const d = deps({
      waitForReplReady: async () => { order.push('wait'); return true; },
      sendKeys: (_id: string, text: string) => { order.push(`send:${text}`); append(UUID, 'turn-started'); },
    });
    assert.equal(await robustSubmit(session, { jsonlPath: jsonlPath() }, 'hi', true, d), 'delivered');
    assert.deepEqual(order, ['wait', 'send:hi']);
  });
});
