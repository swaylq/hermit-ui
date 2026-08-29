import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionStatusView,
  activityLabel,
  isRestingState,
  snapshotSilenceMs,
  SNAPSHOT_STALE_MS,
  BACKGROUND_RESIDENT_MS,
  mergeLiveStatus,
  workingUnconfirmed,
  WORKING_HOLD_CAP_MS,
} from './session-status';

// ── the label a working session shows ───────────────────────────────────────
//
// "working" is everything a scraped terminal spinner can support. A backend with
// a typed event stream can say WHICH tool and for how long, or that the session
// is not slow but rate-limited — which is the difference between a chat that
// looks hung and one that explains itself.

test('a backend that cannot say keeps the label it always had', () => {
  assert.equal(sessionStatusView({ alive: true, state: 'working' }).label, 'working');
  assert.equal(sessionStatusView({ alive: true, state: 'working', activity: null }).label, 'working');
});

test('a running tool is named with its elapsed time', () => {
  const v = sessionStatusView({
    alive: true, state: 'working',
    activity: { kind: 'tool', label: 'Bash', detail: 'npm test', elapsedSec: 47 },
  });
  assert.equal(v.key, 'working', 'still the working state — only the wording changed');
  assert.equal(v.label, 'Bash · 47s');
  assert.equal(v.detail, 'npm test');
});

test('minutes read as minutes', () => {
  assert.equal(activityLabel({ kind: 'tool', label: 'Bash', elapsedSec: 200 })?.label, 'Bash · 3m 20s');
  assert.equal(activityLabel({ kind: 'tool', label: 'Bash', elapsedSec: 180 })?.label, 'Bash · 3m');
  assert.equal(activityLabel({ kind: 'tool', label: 'Bash', elapsedSec: 0 })?.label, 'Bash');
});

// The state the pane could not report at all: a rate-limited session just looked
// hung, and the user had no way to tell waiting from wedged.
test('a rate limit says so, with the count and the wait', () => {
  const v = sessionStatusView({
    alive: true, state: 'working',
    activity: { kind: 'retrying', label: 'retrying', attempt: 2, maxRetries: 5, retryInSec: 12 },
  });
  assert.equal(v.label, 'retrying 2/5, 12s');
});

test('subagent, compaction and background each get their own wording', () => {
  assert.equal(
    activityLabel({ kind: 'subagent', label: 'code-reviewer', detail: 'review the diff' })?.label,
    'code-reviewer',
  );
  assert.equal(activityLabel({ kind: 'compacting', label: 'compacting' })?.label, 'compacting');
  assert.equal(activityLabel({ kind: 'background', label: 'background', backgroundCount: 2 })?.label, 'background +2 bg');
});

test('background work is counted alongside the foreground', () => {
  assert.equal(
    activityLabel({ kind: 'tool', label: 'Read', elapsedSec: 3, backgroundCount: 2 })?.label,
    'Read · 3s +2 bg',
  );
  // Zero is not worth saying.
  assert.equal(activityLabel({ kind: 'tool', label: 'Read', backgroundCount: 0 })?.label, 'Read');
});

// It arrives through an opaque JSON column, so nothing in it is guaranteed —
// including its shape after a gateway upgrade this build predates.
test('an unreadable payload falls back rather than throwing', () => {
  for (const junk of [null, undefined, 'working', 42, [], {}, { kind: 'something-new' }]) {
    assert.equal(activityLabel(junk), null, JSON.stringify(junk));
    assert.equal(
      sessionStatusView({ alive: true, state: 'working', activity: junk }).label,
      'working',
    );
  }
});

// Activity only ever REFINES the working state. A stale payload on an idle
// session must not resurrect it — `state` is the authority on whether a turn is
// in flight.
test('activity never contradicts the state', () => {
  const idle = sessionStatusView(
    { alive: true, state: 'idle', activity: { kind: 'tool', label: 'Bash', elapsedSec: 900 } },
    { unread: false },
  );
  assert.equal(idle.key, 'ready');
  assert.equal(idle.label, 'ready');
});

test('a client-side working signal picks up the label too', () => {
  const v = sessionStatusView(
    { alive: true, state: 'idle', activity: { kind: 'compacting', label: 'compacting' } },
    { liveWorking: true },
  );
  assert.equal(v.label, 'compacting');
});

// ── needs you ───────────────────────────────────────────────────────────────
//
// The one state only a view with the MESSAGES loaded can see: a turn parked on a
// permission prompt. It used to be an object literal inlined in the chat header,
// outside this union, which is why the sidebar could never show it — the same
// session read "needs you" in the header and "working" in the row beside it.

test('a turn waiting on a click says so, and outranks working', () => {
  const v = sessionStatusView(
    { alive: true, state: 'working', activity: { kind: 'tool', label: 'Bash', elapsedSec: 47 } },
    { needsYou: true },
  );
  assert.equal(v.key, 'needs-you');
  assert.equal(v.label, 'needs you');
});

// Whoever is blocked on you is blocked on you whatever else is true of the row —
// including the local send signal, and including a closed/absent session.
test('nothing outranks needs you', () => {
  assert.equal(sessionStatusView(null, { needsYou: true }).key, 'needs-you');
  assert.equal(
    sessionStatusView({ closedAt: new Date(), restartRequestedAt: new Date() }, { needsYou: true }).key,
    'needs-you',
  );
  assert.equal(
    sessionStatusView({ alive: true, state: 'idle' }, { needsYou: true, liveWorking: true, unread: true }).key,
    'needs-you',
  );
});

test('an absent needsYou changes nothing', () => {
  assert.equal(sessionStatusView({ alive: true, state: 'idle' }, { needsYou: false }).key, 'ready');
  assert.equal(sessionStatusView({ alive: true, state: 'working' }, {}).key, 'working');
});

// The desync sway reported, as a test: the header and the sidebar run this same
// function over the same listSessions row, and what used to differ was the fast
// local signal layered on top — the chat page reads the message stream, the
// sidebar only had a send stamp. Feed both sides the same signal and they agree.
test('one row plus one signal is one answer, whoever is asking', () => {
  const row = { alive: true, state: 'idle', snapshotAt: new Date() } as const;
  for (const [live, expected] of [['working', 'working'], ['needs-you', 'needs-you'], ['idle', 'ready']] as const) {
    const header = sessionStatusView(row, {
      liveWorking: live === 'working',
      unread: false,
      needsYou: live === 'needs-you',
    });
    const sidebar = sessionStatusView(row, {
      liveWorking: live === 'working',
      unread: false, // the open session is read by definition — chat.markRead
      needsYou: live === 'needs-you',
    });
    assert.equal(header.key, expected);
    assert.deepEqual(header, sidebar, live);
  }
});

// ── the two things the row was asserting without evidence ───────────────────
//
// sway: "让侧边栏会话状态和实际的会话状态显示一致，尤其用了 claude sdk".
//
// Both of these were tmux-shaped assumptions that stopped holding when the
// default backend became an SDK child. On tmux a pane outlives the gateway, so
// `alive` was true for everything and `state` was refreshed by SOMEONE even
// across a gateway restart. Neither is true of a gateway subprocess.

const NOW = 1_700_000_000_000;
const fresh = new Date(NOW - 1_000);
const ancient = new Date(NOW - SNAPSHOT_STALE_MS - 1);

test('a gateway that stopped reporting stops the row saying "working"', () => {
  // The failure with no other backstop in the pipeline: nothing expires `state`,
  // so a gateway that dies mid-turn leaves the dot pulsing amber indefinitely.
  const v = sessionStatusView({ alive: true, state: 'working', snapshotAt: ancient }, { now: NOW });
  assert.equal(v.key, 'stale');
  assert.equal(v.pulse, false, 'a memory must not animate as though it were live');
});

test('a fresh snapshot is still believed', () => {
  const v = sessionStatusView({ alive: true, state: 'working', snapshotAt: fresh }, { now: NOW });
  assert.equal(v.key, 'working');
});

test('never snapshotted is not the same as stale', () => {
  // A session created seconds ago has no snapshotAt at all. Greying it would
  // report "the gateway is gone" for what is really "the gateway has not got
  // to it yet".
  assert.equal(sessionStatusView({ alive: true, state: 'idle' }, { now: NOW }).key, 'ready');
  assert.equal(sessionStatusView({ alive: true, state: 'idle', snapshotAt: null }, { now: NOW }).key, 'ready');
});

test('what the browser can see outlives the gateway that cannot report it', () => {
  // liveWorking is the open chat page reading its own message stream. It is
  // ranked above the staleness check on purpose: the gateway being quiet is
  // exactly when this is the only signal left.
  const v = sessionStatusView({ alive: true, state: 'idle', snapshotAt: ancient }, { liveWorking: true, now: NOW });
  assert.equal(v.key, 'working');
});

test('a session with no process is asleep, not ready', () => {
  // `alive` was declared on the input type and never read. On claude-sdk the
  // child is a gateway subprocess with no reattach, so this is the resting
  // state of most of the sidebar most of the time — and every one of those rows
  // was rendering the SOLID green that the colour spec defines as "alive".
  const v = sessionStatusView({ alive: false, state: null, snapshotAt: fresh }, { now: NOW });
  assert.equal(v.key, 'asleep');
  assert.notEqual(v.dot, 'bg-emerald-500', 'must not be the same dot as a live idle session');
  assert.equal(v.pulse, false);
});

test('a live idle session keeps the solid dot it always had', () => {
  // The other half of the same claim: this is what tmux sessions still are, and
  // they must not have moved.
  const v = sessionStatusView({ alive: true, state: 'idle', snapshotAt: fresh }, { now: NOW });
  assert.equal(v.key, 'ready');
  assert.equal(v.dot, 'bg-emerald-500');
});

test('unread work outranks being asleep', () => {
  // Which process is up is a detail; "it finished something you have not read"
  // is the thing worth a colour.
  const v = sessionStatusView({ alive: false, state: null, snapshotAt: fresh }, { unread: true, now: NOW });
  assert.equal(v.key, 'unread');
});

test('an unknown `alive` claims nothing', () => {
  // A caller that does not select the column must not be told its sessions are
  // asleep. Only an explicit false means asleep.
  assert.equal(sessionStatusView({ state: 'idle', snapshotAt: fresh }, { now: NOW }).key, 'ready');
});

test('a session archived mid-turn stops pulsing', () => {
  // The gateway only polls sessions with closedAt = null, so a session archived
  // while working keeps that `state` for good. It used to outrank the closed
  // check and pulse amber forever, for a conversation that is over.
  const v = sessionStatusView({ alive: true, state: 'working', closedAt: new Date(NOW), snapshotAt: fresh }, { now: NOW });
  assert.equal(v.key, 'down');
  assert.equal(v.label, 'closed');
});

test('only the resting states go unlabelled', () => {
  // The sidebar prints status.label for everything else, so anything wrongly
  // called "resting" would go silent in the list.
  assert.equal(isRestingState('ready'), true);
  assert.equal(isRestingState('asleep'), true);
  for (const k of ['working', 'needs-you', 'unread', 'starting', 'restarting', 'down', 'stale'] as const) {
    assert.equal(isRestingState(k), false, k);
  }
});

// ── whose silence is it ─────────────────────────────────────────────────────
//
// `stale` answers "has the gateway gone quiet". The age it reads that off is
// also large when the BROWSER went quiet — a poll queued behind a busy
// dashboard, a backgrounded tab, a dropped connection — and that second case is
// the common one. Reported 2026-08-21: an agent partway through a long task
// flipped to grey "stale" for a few seconds every time a tool finished. Both
// halves of that are the same event. A finishing tool is a large sync POST that
// stalls the dashboard's event loop, so the browser's own 5s polls queue behind
// it; and it only SHOWS at a tool boundary because that is when the chat page's
// fast local `working` signal lapses and the dot falls back to the snapshot it
// has been failing to refresh. See lib/dashboard-reach.

test('a poll that never came back is not the gateway going quiet', () => {
  // 90s of wall clock since the snapshot, but only 10s since we last got an
  // answer: the other 80s are ours. Under the old subtraction this was `stale`.
  const v = sessionStatusView(
    { alive: true, state: 'working', snapshotAt: new Date(NOW - 90_000) },
    { now: NOW, observedAt: NOW - 80_000, reachableSince: 0 },
  );
  assert.equal(v.key, 'working');
});

test('a gateway that really has gone quiet is still called out', () => {
  // The other half: our polls keep landing, and each one hands back the same old
  // snapshot. That IS evidence, and it must still grey the dot.
  const v = sessionStatusView(
    { alive: true, state: 'working', snapshotAt: new Date(NOW - 60_000) },
    { now: NOW, observedAt: NOW, reachableSince: 0 },
  );
  assert.equal(v.key, 'stale');
});

test('silence shared with the dashboard is not charged to the gateway', () => {
  // When the DASHBOARD is what went down, the gateway could not write either, so
  // the first read after recovery legitimately carries an ancient snapshot. It
  // is about to be replaced within a tick or two; greying every session in the
  // fleet on the way past is the flicker, not a diagnosis.
  const v = sessionStatusView(
    { alive: true, state: 'working', snapshotAt: new Date(NOW - 120_000) },
    { now: NOW, observedAt: NOW, reachableSince: NOW - 3_000 },
  );
  assert.equal(v.key, 'working');
});

test('…and once contact has held long enough, the clock runs again', () => {
  // The forgiveness above is bounded by the same threshold as everything else:
  // contact restored a minute ago and still no snapshot means the gateway, not
  // the outage.
  const v = sessionStatusView(
    { alive: true, state: 'working', snapshotAt: new Date(NOW - 120_000) },
    { now: NOW, observedAt: NOW, reachableSince: NOW - SNAPSHOT_STALE_MS - 1_000 },
  );
  assert.equal(v.key, 'stale');
});

test('a row we have never had an answer about claims nothing', () => {
  // First paint: the sidebar renders from its IndexedDB cache, whose rows can be
  // hours old, before any poll has landed. Nothing has been observed, so there
  // is nothing to call stale — a whole sidebar of grey on open would be a lie
  // about every session at once.
  const v = sessionStatusView(
    { alive: true, state: 'working', snapshotAt: new Date(NOW - 6 * 3_600_000) },
    { now: NOW, observedAt: 0, reachableSince: 0 },
  );
  assert.equal(v.key, 'working');
});

test('a caller with no reach information behaves exactly as before', () => {
  // Every other caller, and every test above, passes neither stamp.
  assert.equal(
    sessionStatusView({ alive: true, state: 'working', snapshotAt: ancient }, { now: NOW }).key,
    'stale',
  );
});

test('silence is never negative', () => {
  // The browser's clock and the dashboard's are independent. One running behind
  // the other would otherwise produce a negative age, which is meaningless.
  assert.equal(snapshotSilenceMs(new Date(NOW + 30_000), { observedAt: NOW }), 0);
  assert.equal(snapshotSilenceMs(new Date(NOW - 5_000), { observedAt: NOW }), 5_000);
  assert.equal(snapshotSilenceMs(null, { observedAt: NOW }), null);
  assert.equal(snapshotSilenceMs('not a date', { observedAt: NOW }), null);
});

// ── the turn ended, the work did not ────────────────────────────────────────
//
// On claude-sdk, backgrounding a Bash or a subagent ends the turn immediately —
// `result` and `session_state_changed: idle` land ~1ms after the tool fires,
// while the task runs on. Falling through to 'unread' told sway the agent had
// FINISHED something, when all it had done was start it. Every Agent call is
// backgrounded by default, so this is the common shape, not an edge case.

test('idle with background work still running reads as working, not unread', () => {
  const v = sessionStatusView(
    { alive: true, state: 'idle', activity: { kind: 'background', label: 'background', detail: 'rebuild v5', backgroundCount: 2 } },
    { unread: true },
  );
  assert.equal(v.key, 'working');
  assert.equal(v.label, 'background +2 bg');
  assert.equal(v.detail, 'rebuild v5');
});

test('idle with background work is not "ready" either', () => {
  const v = sessionStatusView({ alive: true, state: 'idle', activity: { kind: 'background', backgroundCount: 1 } });
  assert.equal(v.key, 'working');
});

test('idle with nothing in the background is unchanged', () => {
  assert.equal(sessionStatusView({ alive: true, state: 'idle' }, { unread: true }).key, 'unread');
  assert.equal(sessionStatusView({ alive: true, state: 'idle' }).key, 'ready');
  assert.equal(
    sessionStatusView({ alive: true, state: 'idle', activity: { kind: 'tool', label: 'Bash' } }).key,
    'ready',
    'a leftover non-background payload on an idle session says nothing is running',
  );
});

test('background work does not outrank needs-you, closed, or a stale gateway', () => {
  const activity = { kind: 'background', backgroundCount: 1 };
  assert.equal(sessionStatusView({ alive: true, state: 'idle', activity }, { needsYou: true }).key, 'needs-you');
  assert.equal(sessionStatusView({ alive: true, state: 'idle', activity, closedAt: new Date() }).key, 'down');
  const now = Date.now();
  assert.equal(
    sessionStatusView(
      { alive: true, state: 'idle', activity, snapshotAt: new Date(now - SNAPSHOT_STALE_MS - 1) },
      { now },
    ).key,
    'stale',
  );
});

test('the sidebar row learns the same fact through its pre-chewed boolean', () => {
  // chat.listSessions collapses `activity` to `backgroundBusy` rather than
  // shipping the blob on the 5s poll. Both doors must reach the same verdict,
  // or the sidebar dot and the chat header disagree about the same session.
  assert.equal(sessionStatusView({ alive: true, state: 'idle', backgroundBusy: true }, { unread: true }).key, 'working');
  assert.equal(sessionStatusView({ alive: true, state: 'idle', backgroundBusy: false }, { unread: true }).key, 'unread');
  assert.equal(
    sessionStatusView({ alive: true, state: 'idle', backgroundBusy: null }, { unread: true }).key,
    'unread',
    'a row that cannot say falls through to what it always did',
  );
});

test('a background task nobody is waiting on stops pinning the session amber', () => {
  // The mirror-image lie. Measured on the fleet the day this was written: four
  // sessions idle with one outstanding task, the oldest left over from the
  // PREVIOUS day ("Wait for smoke completion"). Without a bound, each would read
  // as working for ever and could never go red or ring a phone again.
  const now = Date.now();
  const activity = { kind: 'background', backgroundCount: 1 };
  const stale = { alive: true, state: 'idle', activity, lastMessageAt: new Date(now - BACKGROUND_RESIDENT_MS) };
  assert.equal(sessionStatusView(stale, { now, unread: true }).key, 'unread');
  assert.equal(sessionStatusView(stale, { now }).key, 'ready');
  // A minute short of the bound it is still part of the answer.
  assert.equal(
    sessionStatusView(
      { alive: true, state: 'idle', activity, lastMessageAt: new Date(now - BACKGROUND_RESIDENT_MS + 60_000) },
      { now, unread: true },
    ).key,
    'working',
  );
});

test('a session that has never been spoken in has no silence to expire', () => {
  const now = Date.now();
  const v = sessionStatusView(
    { alive: true, state: 'idle', backgroundBusy: true, lastMessageAt: null },
    { now, unread: true },
  );
  assert.equal(v.key, 'working');
});


// ── the pushed status frame ─────────────────────────────────────────────────
// The stream carries the same row the poll does, only earlier. `snapshotAt` —
// the gateway's clock on both sides — decides which is later; nothing here
// compares against the browser's clock.

const isoAt = (ms: number) => new Date(ms).toISOString();

test('a newer pushed frame wins over the polled row', () => {
  const merged = mergeLiveStatus(
    { state: 'idle', alive: true, snapshotAt: new Date(1_000), activity: null },
    { state: 'working', alive: true, activity: { kind: 'tool', label: 'Bash' }, snapshotAt: isoAt(2_000) },
  );
  assert.equal(merged?.state, 'working');
  assert.deepEqual(merged?.activity, { kind: 'tool', label: 'Bash' });
});

test('a frame the poll has already caught up to is ignored', () => {
  const row = { state: 'working', alive: true, snapshotAt: new Date(3_000), activity: null };
  // Equal timestamps mean the same observation; prefer the row, which carries
  // every column rather than four.
  assert.equal(mergeLiveStatus(row, { state: 'idle', alive: true, activity: null, snapshotAt: isoAt(3_000) }), row);
  assert.equal(mergeLiveStatus(row, { state: 'idle', alive: true, activity: null, snapshotAt: isoAt(2_000) }), row);
});

test('a frame never invents a session, and never touches what it does not carry', () => {
  assert.equal(mergeLiveStatus(null, { state: 'working', alive: true, activity: null, snapshotAt: isoAt(9) }), null);
  const merged = mergeLiveStatus(
    { state: 'idle', alive: false, snapshotAt: new Date(1), closedAt: new Date(5), contextTokens: 42 },
    { state: 'working', alive: true, activity: null, snapshotAt: isoAt(2) },
  ) as unknown as Record<string, unknown>;
  assert.equal(merged.closedAt instanceof Date, true, 'closedAt still outranks working downstream');
  assert.equal(merged.contextTokens, 42);
});

// ── refusing to call a session idle on evidence that predates the turn ──────
// This is the whole flicker in one rule. The chat page's fast local signals
// (an unanswered user row; the tail bubble grew in the last 1.8s) lapse on
// their own schedule — a tool call that runs three seconds without emitting
// clears the second one — and the `state` underneath may not have been
// rewritten since BEFORE the turn began.

const T0 = 1_000_000;

test('an idle reading on the same snapshot we were working on is not evidence', () => {
  assert.equal(
    workingUnconfirmed({
      snapshotAt: new Date(T0 - 5_000),
      lastWorkingSnapshotMs: T0 - 5_000,
      lastWorkingAtMs: T0 - 2_000,
      now: T0,
    }),
    true,
  );
});

test('a genuinely newer snapshot releases the hold with no lag', () => {
  assert.equal(
    workingUnconfirmed({
      snapshotAt: new Date(T0 - 1_000),   // the gateway looked again, after
      lastWorkingSnapshotMs: T0 - 5_000,
      lastWorkingAtMs: T0 - 2_000,
      now: T0,
    }),
    false,
    'that is a turn actually ending — showing ready must not be delayed',
  );
});

test('a session never seen working holds nothing', () => {
  assert.equal(
    workingUnconfirmed({ snapshotAt: new Date(T0), lastWorkingSnapshotMs: 0, lastWorkingAtMs: 0, now: T0 }),
    false,
  );
  // A brand-new session has no snapshot at all. Holding on 0 <= 0 would pin it
  // amber from the first optimistic reading until the cap expired.
  assert.equal(
    workingUnconfirmed({ snapshotAt: null, lastWorkingSnapshotMs: 0, lastWorkingAtMs: T0 - 1, now: T0 }),
    false,
  );
});

test('a gateway that stops writing releases the hold rather than pinning amber', () => {
  // Only reachable when snapshotAt has stopped moving — a live gateway rewrites
  // it every 8s. The cap is under SNAPSHOT_STALE_MS so `stale` is what shows
  // next, not a green `ready` over a session nobody is reporting on.
  assert.ok(WORKING_HOLD_CAP_MS < SNAPSHOT_STALE_MS, 'stale must be reachable before the hold expires');
  assert.equal(
    workingUnconfirmed({
      snapshotAt: new Date(T0 - 60_000),
      lastWorkingSnapshotMs: T0 - 60_000,
      lastWorkingAtMs: T0 - WORKING_HOLD_CAP_MS - 1,
      now: T0,
    }),
    false,
  );
});
