// What cleanup is allowed to touch.
//
// The tier assignment is the easy half and mostly self-evident. The half worth
// locking down is the BLOCKER table, for a reason specific to this feature: when
// a blocker stops matching, nothing throws and nothing logs. The sweep just
// quietly starts proposing conversations that something still depends on, and the
// only symptom is a cron that went silent, or a question nobody ever answered
// because the session holding it went in the bin.
//
// So every blocker gets a test that would fail if it were dropped, and the two
// asymmetries the design leans on get one each:
//
//   - the irreversible tier requires MORE evidence than the reversible ones,
//   - a dispatch is the one case where "the context is redundant" is provable
//     rather than a judgement call, which is why it can skip the age gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySession,
  DEFAULT_ARCHIVE_IDLE_DAYS,
  DEFAULT_TRASH_IDLE_DAYS,
  type SessionFacts,
  type SessionRefs,
} from './session-cleanup';

const NOW = new Date('2026-08-09T12:00:00Z').getTime();
const DAY = 86_400_000;
const T = { archiveDays: DEFAULT_ARCHIVE_IDLE_DAYS, trashDays: DEFAULT_TRASH_IDLE_DAYS };
const ago = (days: number) => new Date(NOW - days * DAY);

function refs(over: Partial<SessionRefs> = {}): SessionRefs {
  return {
    hasCron: new Set(),
    hasInteraction: new Set(),
    hasQueued: new Set(),
    // Default to a normal conversation: it has messages and it got answered.
    hasAssistant: new Set(['s1']),
    trashedAgentNames: new Set(),
    isPokeTarget: new Set(),
    anyMessage: new Set(['s1']),
    ...over,
  };
}

// The baseline is a perfectly ordinary session: read, answered, unnamed, quiet.
// `lastReadAt` follows `lastMessageAt` unless a test sets it, because a fixed
// default would silently make every "idle for N days" case ALSO an unread one —
// and unread is a blocker, so every tier test would pass for the wrong reason.
function session(over: Partial<SessionFacts> = {}): SessionFacts {
  const lastMessageAt = 'lastMessageAt' in over ? over.lastMessageAt ?? null : ago(40);
  return {
    id: 's1',
    agentName: 'finance-agent',
    title: '四个 0002 原因排查',
    titleAuto: true,
    preview: null,
    origin: null,
    startedAt: ago(60),
    lastMessageAt,
    lastReadAt: lastMessageAt,
    closedAt: null,
    groupId: null,
    state: 'idle',
    alive: false,
    loopState: null,
    rssMb: null,
    contextTokens: 186_996,
    keepAt: null,
    unansweredMsgId: null,
    dispatchedBySessionId: null,
    takeoverBySessionId: null,
    ...over,
  };
}

const verdict = (s: Partial<SessionFacts>, r: Partial<SessionRefs> = {}) =>
  classifySession(session(s), refs(r), T, NOW);

// ── The blocker table. One test per inbound reference. ───────────────────────

test('a cron reporting into it is never a candidate', () => {
  const v = verdict({}, { hasCron: new Set(['s1']) });
  assert.equal(v?.tier, 'keep');
  assert.equal(v?.blockedBy, 'cron');
});

test('a pending interaction blocks — it looks idle precisely because it is stuck', () => {
  assert.equal(verdict({}, { hasInteraction: new Set(['s1']) })?.blockedBy, 'interaction');
});

test('an undelivered queued message blocks', () => {
  assert.equal(verdict({}, { hasQueued: new Set(['s1']) })?.blockedBy, 'queued');
});

test('a flagged unanswered question blocks', () => {
  assert.equal(verdict({ unansweredMsgId: 'msg1' })?.blockedBy, 'unanswered');
});

test('an unread last message blocks — never delete something never seen', () => {
  assert.equal(verdict({ lastMessageAt: ago(40), lastReadAt: ago(50) })?.blockedBy, 'unread');
  assert.equal(verdict({ lastMessageAt: ago(40), lastReadAt: null })?.blockedBy, 'unread');
});

test('a running loop blocks', () => {
  assert.equal(verdict({ loopState: { loops: [{ status: 'running' }] } })?.blockedBy, 'loop');
  // A finished loop is not a reason to keep anything.
  assert.notEqual(verdict({ loopState: { loops: [{ status: 'stopped' }] } })?.blockedBy, 'loop');
});

test('a working session blocks', () => {
  assert.equal(verdict({ state: 'working' })?.blockedBy, 'working');
});

test('Brain dispatch/takeover wiring blocks in both directions', () => {
  // An IN-FLIGHT dispatch (open) — the watcher still owes a report.
  assert.equal(verdict({ dispatchedBySessionId: 'brain1' })?.blockedBy, 'dispatch');
  // takeoverBySessionId is cleared when a takeover ends, so non-null = live.
  assert.equal(verdict({ takeoverBySessionId: 'brain1' })?.blockedBy, 'dispatch');
  // …including being the poke TARGET of someone else's live dispatch.
  assert.equal(verdict({}, { isPokeTarget: new Set(['s1']) })?.blockedBy, 'dispatch');
});

test('a FINISHED dispatch is not pinned by its own routing field', () => {
  // Regression: `dispatchedBySessionId` is set on every dispatch child for the
  // life of the row — it is how the watcher finds the Brain. Treating it as a
  // blocker unconditionally made the `dispatch-done` rule below unreachable, so
  // the single most valuable disposable category silently never fired. An
  // end-to-end run against a real DB is what caught it; this keeps it caught.
  const finished = { origin: 'dispatch', dispatchedBySessionId: 'brain1', closedAt: ago(2), lastMessageAt: ago(2) };
  const v = verdict(finished);
  assert.notEqual(v?.blockedBy, 'dispatch');
  assert.equal(v?.reason, 'dispatch-done');
});

test('deliberate human organisation blocks: a group, a hand-typed title, an explicit Keep', () => {
  assert.equal(verdict({ groupId: 'g1' })?.blockedBy, 'grouped');
  assert.equal(verdict({ title: 'Q3 planning', titleAuto: false })?.blockedBy, 'named');
  assert.equal(verdict({ keepAt: ago(1) })?.blockedBy, 'kept');
});

test('an auto-generated title is NOT organisation — it blocks nothing', () => {
  assert.notEqual(verdict({ title: 'auto label', titleAuto: true })?.blockedBy, 'named');
});

test('a title a MACHINE opened the session with is not organisation either', () => {
  // titleAuto defaults to false and chat.createSession never stamps it, so a
  // dispatch/takeover/cron session carrying a machine-written title used to read
  // as "the human named this" and was spared forever. `origin` is what tells the
  // two apart: only the rename dialog means a person typed it, and that always
  // leaves origin null.
  assert.notEqual(verdict({ title: 'Brain → finance-agent', titleAuto: false, origin: 'dispatch' })?.blockedBy, 'named');
  assert.notEqual(verdict({ title: 'daily report', titleAuto: false, origin: 'cron' })?.blockedBy, 'named');
  // A human-typed title on a human-opened session still blocks.
  assert.equal(verdict({ title: 'monitor 迁移', titleAuto: false, origin: null })?.blockedBy, 'named');
});

test('a blocked session that is not old enough is not surfaced at all', () => {
  // Spared rows exist to make the guardrails visible on the sheet, not to list
  // every session on the machine.
  assert.equal(verdict({ lastMessageAt: ago(2), groupId: 'g1' }), null);
});

// ── Tiers. ───────────────────────────────────────────────────────────────────

test('idle past the archive threshold and still open → archive', () => {
  const v = verdict({ lastMessageAt: ago(20), closedAt: null });
  assert.equal(v?.tier, 'archive');
});

test('the irreversible tier needs MORE evidence than the reversible one', () => {
  // Same 40-day silence. Open → archive; archived 35 days ago and still untouched
  // → bin. The extra month AFTER archiving is what promotes it.
  assert.equal(verdict({ lastMessageAt: ago(40), closedAt: null })?.tier, 'archive');
  assert.equal(verdict({ lastMessageAt: ago(40), closedAt: ago(35) })?.tier, 'trash');
  // …and an archived session inside the trash threshold stays put.
  assert.equal(verdict({ lastMessageAt: ago(20), closedAt: ago(20) }), null);
});

test('archiving something already ancient does NOT make it bin-eligible the same day', () => {
  // The rung that collapsed the ladder. A session quiet for 50 days that a sweep
  // archived a minute ago satisfies "idle >= 30d AND archived" instantly, so the
  // bin proposal would carry no evidence the archive step didn't already have.
  // Harmless while archiving was manual and rare; a daily auto-archive (the
  // Brain's dream) would have pushed every old session straight at deletion.
  assert.equal(verdict({ lastMessageAt: ago(50), closedAt: ago(0.01) })?.tier, undefined);
  // A month later, with nobody having reopened it, it qualifies.
  assert.equal(verdict({ lastMessageAt: ago(80), closedAt: ago(31) })?.tier, 'trash');
});

test('a session quiet for days but inside the archive window is left alone', () => {
  // There is no longer a `sleep` rung to catch it: the machine's idle-TTL reaper
  // (Machine.idleReapHours) already hibernates these, and cleanup duplicating that
  // bought a second threshold and a second row in the UI for no new outcome.
  assert.equal(verdict({ lastMessageAt: ago(3), alive: true }), null);
});

test('a session used today is left entirely alone', () => {
  assert.equal(verdict({ lastMessageAt: ago(0.2), alive: true }), null);
});

// ── Disposable by construction. ──────────────────────────────────────────────

test('a finished dispatch goes to the bin without waiting out the age gate', () => {
  // The one provable case: its result was already reported back to the Brain, so
  // the context is redundant by definition rather than by judgement.
  const v = verdict({ origin: 'dispatch', closedAt: ago(2), lastMessageAt: ago(2) });
  assert.equal(v?.tier, 'trash');
  assert.equal(v?.reason, 'dispatch-done');
});

test('an UNFINISHED dispatch is not disposable', () => {
  const v = verdict({ origin: 'dispatch', closedAt: null, lastMessageAt: ago(2) });
  assert.notEqual(v?.reason, 'dispatch-done');
});

test('a session that never got a reply is a failed spawn, not a conversation', () => {
  const v = verdict({ lastMessageAt: ago(2) }, { hasAssistant: new Set() });
  assert.equal(v?.tier, 'trash');
  assert.equal(v?.reason, 'stillborn');
});

test('a session with no messages at all is a mis-click', () => {
  const v = verdict({ lastMessageAt: ago(2) }, { hasAssistant: new Set(), anyMessage: new Set() });
  assert.equal(v?.reason, 'empty');
});

test('even a stillborn session is spared when something points at it', () => {
  // Ordering matters: the blocker table runs BEFORE the disposable shortcuts, so
  // "no reply yet" can never override "a cron reports here".
  const stillborn = { lastMessageAt: ago(40) };
  assert.equal(verdict(stillborn, { hasAssistant: new Set() })?.reason, 'stillborn');
  const v = verdict(stillborn, { hasAssistant: new Set(), hasCron: new Set(['s1']) });
  assert.equal(v?.tier, 'keep');
  assert.equal(v?.blockedBy, 'cron');
});

test('sessions of a trashed agent are residue', () => {
  const v = verdict({ lastMessageAt: ago(2) }, { trashedAgentNames: new Set(['finance-agent']) });
  assert.equal(v?.reason, 'agent-trashed');
});

// ── Idle is measured from the last message, falling back to creation. ────────

test('a session that never spoke is aged from startedAt, not treated as brand new', () => {
  const v = verdict({ lastMessageAt: null, startedAt: ago(40), closedAt: ago(40) });
  assert.equal(v?.tier, 'trash');
  assert.ok(v && v.idleDays > 39);
});
