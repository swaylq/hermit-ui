// The shared cron-uuid registry — the thing that lets the CHAT runner know a
// transcript in the project dir belongs to a cron fire.
//
// An agent's crons and its chats share one ~/.claude/projects/<cwd> dir, so each
// side's "which transcript is mine?" heuristic has to see what the other holds.
// Only one direction existed until 2026-08-13: cron excluded chat-owned uuids
// (since 2026-08-09), chat excluded nothing of cron's. A `ceo` chat on macmini002
// spent ~10 minutes resuming 27.2 MB, a 2h cron fired inside that window, and the
// resume sniff took the cron's brand-new transcript for the one claude had
// resumed into — the user got "SKIP 非凌晨" as the answer to a business briefing.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ASST_KEY ||= 'test-key-unused';
const { holdCronUuid, releaseCronUuid, cronOwnedUuids } = await import('./cron-uuids');

const PINNED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADOPTED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('cron uuid registry', () => {
  beforeEach(() => {
    for (const u of [...cronOwnedUuids()]) releaseCronUuid(u);
  });

  it('reports a uuid a fire is holding', () => {
    assert.equal(cronOwnedUuids().has(PINNED), false);
    holdCronUuid(PINNED);
    assert.equal(cronOwnedUuids().has(PINNED), true);
  });

  it('holds the pinned AND the drift-adopted uuid at once', () => {
    // A fire that drifted owns two transcripts as far as everyone else is
    // concerned: the one it asked for and the one it actually tails.
    holdCronUuid(PINNED);
    holdCronUuid(ADOPTED);
    assert.deepEqual([...cronOwnedUuids()].sort(), [PINNED, ADOPTED].sort());
  });

  it('releases each independently, so a finished fire leaves nothing behind', () => {
    holdCronUuid(PINNED);
    holdCronUuid(ADOPTED);
    releaseCronUuid(PINNED);
    assert.deepEqual([...cronOwnedUuids()], [ADOPTED]);
    releaseCronUuid(ADOPTED);
    assert.equal(cronOwnedUuids().size, 0);
  });

  it('releasing a uuid nobody holds is a no-op, not a throw', () => {
    // fireInner's `finally` releases both slots unconditionally.
    releaseCronUuid(PINNED);
    assert.equal(cronOwnedUuids().size, 0);
  });

  it('concurrent fires each keep their own slot', () => {
    holdCronUuid(PINNED);
    holdCronUuid(ADOPTED);
    releaseCronUuid(PINNED); // first fire finishes
    assert.equal(cronOwnedUuids().has(ADOPTED), true, 'the second fire still owns its uuid');
  });
});
