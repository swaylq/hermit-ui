import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionStatusView, activityLabel, isRestingState, SNAPSHOT_STALE_MS } from './session-status';

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
