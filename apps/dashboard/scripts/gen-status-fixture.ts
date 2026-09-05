/**
 * Renders `apps/ios/tools/fixtures/status-cases.json` — the answers THIS
 * `sessionStatusView` gives today, for the Swift port to be held against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:status-fixture
 *
 * `lib/session-status.ts` is the single source of truth for how a session's
 * state renders, and the iOS app is now a second implementation of it
 * (apps/ios/Hermit/SessionStatus.swift). A hand-written Swift test would encode
 * whatever the porter believed while reading — and most of what decides these
 * answers is not written down in that file at all:
 *
 *   · `a.label || 'tool'` falls back on an EMPTY STRING, not just on absent.
 *   · `attempt && maxRetries` treats 0 as absent, so a gateway sending zeros
 *     prints `retrying`, not `retrying 0/0`.
 *   · `shortDuration` is handed a raw JS number, so 12.5 seconds prints `12.5s`
 *     and 90.5 prints `1m 30.5s`. Swift's `"\(12.0)"` would print `12.0`.
 *   · `!observedAt` catches 0 as well as undefined — we have never heard from
 *     the dashboard, which is not the same as "heard from it at the epoch".
 *   · The ORDER of the checks is the whole design: closed beats working, stale
 *     beats state, restarting beats a dead pane, unread beats asleep.
 *
 * So the table is produced by RUNNING the real function, and
 * `status-fixture.test.ts` fails the moment the checked-in table stops being
 * what it produces. `apps/ios/tools/status-fixture.sh` runs the Swift side over
 * the same table.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  activityLabel,
  mergeLiveStatus,
  backgroundSummary,
  backgroundTaskList,
  isRestingState,
  sessionStatusView,
  shortDuration,
  snapshotSilenceMs,
  type SessionActivity,
  type SessionRuntimeLike,
  type StatusView,
} from '../src/lib/session-status';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURE_JSON = 'apps/ios/tools/fixtures/status-cases.json';

/** A fixed instant, so the table is reproducible. 2026-09-05T04:00:00Z. */
const NOW = Date.parse('2026-09-05T04:00:00.000Z');
/** ISO, because that is what the Swift side decodes. */
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

// ---------------------------------------------------------------------------
// shortDuration
// ---------------------------------------------------------------------------

const DURATIONS = [
  0, 1, 47, 59, 59.5, 60, 61, 90, 90.5, 119, 120, 200, 3599, 3600, 3601, 3660,
  5332, 7200, 86_400, 0.5,
];

// ---------------------------------------------------------------------------
// activityLabel / backgroundSummary / backgroundTaskList
// ---------------------------------------------------------------------------

type ActivityCase = { name: string; why: string; activity: unknown };

const ACTIVITIES: ActivityCase[] = [
  { name: 'null', why: 'No blob at all — the tmux backend, every row from listSessions.', activity: null },
  { name: 'empty', why: 'A blob with no kind: recognised as an object, matched by no branch.', activity: {} },
  { name: 'unknown-kind', why: 'A gateway newer than this build. Must read as "cannot say".', activity: { kind: 'teleporting', label: 'x' } },
  { name: 'tool', why: 'The common one.', activity: { kind: 'tool', label: 'Bash', elapsedSec: 12 } },
  { name: 'tool-fractional', why: 'elapsedSec is NOT floored here, unlike in backgroundTaskList.', activity: { kind: 'tool', label: 'Bash', elapsedSec: 12.5 } },
  { name: 'tool-no-label', why: "`a.label || 'tool'` — absent falls back.", activity: { kind: 'tool', elapsedSec: 3 } },
  { name: 'tool-empty-label', why: 'An EMPTY string is falsy in JS and falls back too.', activity: { kind: 'tool', label: '', elapsedSec: 3 } },
  { name: 'tool-zero-elapsed', why: '0 seconds drops the age suffix entirely.', activity: { kind: 'tool', label: 'Read', elapsedSec: 0 } },
  { name: 'tool-with-bg', why: 'A foreground tool plus background work keeps the tool name.', activity: { kind: 'tool', label: 'Bash', elapsedSec: 90, backgroundCount: 2 } },
  { name: 'subagent', why: '', activity: { kind: 'subagent', label: 'Explore', detail: 'searching' } },
  { name: 'subagent-no-label', why: '', activity: { kind: 'subagent' } },
  { name: 'compacting', why: '', activity: { kind: 'compacting', backgroundCount: 1 } },
  { name: 'thinking', why: '', activity: { kind: 'thinking', detail: null } },
  { name: 'retrying-full', why: 'Attempt, ceiling and wait all present.', activity: { kind: 'retrying', attempt: 2, maxRetries: 5, retryInSec: 8 } },
  { name: 'retrying-zeros', why: '`attempt && maxRetries` — 0 is falsy, so no "0/0".', activity: { kind: 'retrying', attempt: 0, maxRetries: 0, retryInSec: 0 } },
  { name: 'retrying-detail', why: 'A supplied detail wins over the built-in sentence.', activity: { kind: 'retrying', attempt: 1, maxRetries: 3, detail: '529 overloaded' } },
  { name: 'background-one', why: 'One task, named, with an age.', activity: { kind: 'background', backgroundCount: 1, backgroundTasks: [{ id: 't1', description: 'pnpm build', elapsedSec: 5332 }] } },
  { name: 'background-many', why: 'The ×N suffix, and only the OLDEST task decides the age.', activity: { kind: 'background', backgroundCount: 3, backgroundTasks: [{ id: 't1', description: 'watch', elapsedSec: 7200.9 }, { description: '  ', elapsedSec: 12 }, { id: '', description: 'tail -f', elapsedSec: 0 }] } },
  { name: 'background-count-only', why: 'A gateway from before backgroundTasks existed.', activity: { kind: 'background', backgroundCount: 2, detail: 'two things' } },
  { name: 'background-zero-count', why: 'Zero outstanding is not outstanding.', activity: { kind: 'background', backgroundCount: 0 } },
  { name: 'array', why: 'An array is typeof object; the web rejects it explicitly.', activity: [] },
  { name: 'string', why: 'A column holding a bare string.', activity: 'working' },
];

// ---------------------------------------------------------------------------
// sessionStatusView
// ---------------------------------------------------------------------------

type Opts = Parameters<typeof sessionStatusView>[1];
type StatusCase = { name: string; why: string; session: SessionRuntimeLike | null; opts: Opts };

const fresh = { snapshotAt: at(5_000) };

const STATUSES: StatusCase[] = [
  { name: 'no-session', why: 'The row is not there at all.', session: null, opts: { now: NOW } },
  { name: 'needs-you-outranks-all', why: 'A parked permission prompt beats every other signal, including closed.', session: { ...fresh, state: 'working', closedAt: at(0), alive: true }, opts: { needsYou: true, now: NOW } },
  { name: 'live-working-outranks-closed', why: "The client's own stream is above everything but needsYou.", session: { ...fresh, state: 'idle', closedAt: at(0) }, opts: { liveWorking: true, now: NOW } },
  { name: 'live-working-uses-activity', why: 'The label is sharpened even when the verdict came from the client.', session: { ...fresh, activity: { kind: 'tool', label: 'Grep', elapsedSec: 4 } }, opts: { liveWorking: true, now: NOW } },
  { name: 'closed', why: 'Archived mid-turn: closed beats a stale `working`.', session: { ...fresh, state: 'working', closedAt: at(60_000), alive: true }, opts: { now: NOW } },
  { name: 'stale', why: 'The gateway has stopped reporting; `state` is a memory.', session: { snapshotAt: at(46_000), state: 'working', alive: true }, opts: { now: NOW } },
  { name: 'stale-boundary-just-under', why: '45s exactly is NOT stale — the check is a strict >.', session: { snapshotAt: at(45_000), state: 'idle', alive: true }, opts: { now: NOW } },
  { name: 'stale-boundary-just-over', why: 'One millisecond past it is.', session: { snapshotAt: at(45_001), state: 'idle', alive: true }, opts: { now: NOW } },
  { name: 'never-snapshotted', why: 'A brand-new session has no snapshot, which is not staleness.', session: { state: 'starting' }, opts: { now: NOW } },
  { name: 'stale-forgiven-by-reachableSince', why: 'The dashboard was down too; that silence is not the gateway’s fault.', session: { snapshotAt: at(600_000), state: 'working', alive: true }, opts: { now: NOW, observedAt: NOW, reachableSince: NOW - 10_000 } },
  { name: 'stale-not-charged-when-we-were-blind', why: 'observedAt behind now: we simply have not asked.', session: { snapshotAt: at(60_000), state: 'idle', alive: true }, opts: { now: NOW, observedAt: NOW - 40_000 } },
  { name: 'never-observed', why: 'observedAt 0 — first paint off the local cache, nothing to judge on.', session: { snapshotAt: at(10_000_000), state: 'idle', alive: true }, opts: { now: NOW, observedAt: 0 } },
  { name: 'working-plain', why: '', session: { ...fresh, state: 'working', alive: true }, opts: { now: NOW } },
  { name: 'working-with-activity', why: '', session: { ...fresh, state: 'working', alive: true, activity: { kind: 'tool', label: 'WebFetch', elapsedSec: 61, detail: 'GET /x' } }, opts: { now: NOW } },
  { name: 'working-note-fallback', why: 'A sidebar row has no blob, so backgroundNote is the label.', session: { ...fresh, state: 'working', alive: true, backgroundNote: 'background · 12m' }, opts: { now: NOW } },
  { name: 'working-activity-beats-note', why: 'A caller holding the real blob keeps the richer label.', session: { ...fresh, state: 'working', alive: true, backgroundNote: 'background · 12m', activity: { kind: 'subagent', label: 'Explore' } }, opts: { now: NOW } },
  { name: 'parked-background-blob', why: 'idle + outstanding background = working, dimmed, not pulsing.', session: { ...fresh, state: 'idle', alive: true, lastMessageAt: at(60_000), activity: { kind: 'background', backgroundCount: 1, backgroundTasks: [{ id: 'a', description: 'pnpm test', elapsedSec: 300 }] } }, opts: { now: NOW } },
  { name: 'parked-background-boolean', why: 'The sidebar row only has the precomputed boolean and note.', session: { ...fresh, state: 'idle', alive: true, backgroundBusy: true, backgroundNote: 'background · 5m', lastMessageAt: at(60_000) }, opts: { now: NOW } },
  { name: 'background-gone-resident', why: 'Half an hour of silence: the task is a resident process, not an answer.', session: { ...fresh, state: 'idle', alive: true, backgroundBusy: true, backgroundNote: 'background · 9h', lastMessageAt: at(1_800_000) }, opts: { now: NOW } },
  { name: 'background-just-inside-resident', why: 'One millisecond under the half hour still counts.', session: { ...fresh, state: 'idle', alive: true, backgroundBusy: true, lastMessageAt: at(1_799_999) }, opts: { now: NOW } },
  { name: 'background-never-messaged', why: 'No lastMessageAt: no silence to measure, nothing expires.', session: { ...fresh, state: 'idle', alive: true, backgroundBusy: true }, opts: { now: NOW } },
  { name: 'restarting', why: 'Outranks a dead pane — `alive` flips false mid-restart.', session: { ...fresh, state: 'idle', alive: false, restartRequestedAt: at(2_000) }, opts: { now: NOW } },
  { name: 'restarting-beats-unread', why: '', session: { ...fresh, state: 'idle', alive: true, restartRequestedAt: at(2_000) }, opts: { unread: true, now: NOW } },
  { name: 'starting', why: '', session: { ...fresh, state: 'starting', alive: true }, opts: { now: NOW } },
  { name: 'starting-beats-unread', why: '', session: { ...fresh, state: 'starting', alive: true }, opts: { unread: true, now: NOW } },
  { name: 'unread', why: '', session: { ...fresh, state: 'idle', alive: true }, opts: { unread: true, now: NOW } },
  { name: 'unread-beats-asleep', why: 'The finished work is worth a colour whether or not a process is up.', session: { ...fresh, state: 'idle', alive: false }, opts: { unread: true, now: NOW } },
  { name: 'asleep', why: 'Nothing is running, and nothing is wrong.', session: { ...fresh, state: 'idle', alive: false }, opts: { now: NOW } },
  { name: 'ready', why: '', session: { ...fresh, state: 'idle', alive: true }, opts: { now: NOW } },
  { name: 'ready-alive-absent', why: '`alive` absent is not `alive === false`.', session: { ...fresh, state: 'idle' }, opts: { now: NOW } },
];

// ---------------------------------------------------------------------------

export type Fixture = {
  now: number;
  snapshotStaleMs: number;
  backgroundResidentMs: number;
  durations: { sec: number; expected: string }[];
  activities: (ActivityCase & {
    label: { label: string; detail?: string } | null;
    summary: string | null;
    tasks: ReturnType<typeof backgroundTaskList>;
  })[];
  statuses: (StatusCase & { expected: StatusView; resting: boolean; silenceMs: number | null })[];
  merges: (MergeCase & {
    merged: {
      alive: boolean | null;
      state: string | null;
      snapshotAt: string | Date | null;
      activity: unknown;
      closedAt: string | Date | null;
      restartRequestedAt: string | Date | null;
    } | null;
    view: StatusView;
  })[];
};

// ---------------------------------------------------------------------------
// mergeLiveStatus — the pushed frame against the polled row
// ---------------------------------------------------------------------------

type MergeCase = {
  name: string;
  why: string;
  session: SessionRuntimeLike | null;
  live: { state: string | null; alive: boolean; activity: unknown; snapshotAt: string | null } | null;
};

const MERGES: MergeCase[] = [
  {
    name: 'no-row',
    why: 'Nothing to merge into. The frame is dropped, not promoted into a row.',
    session: null,
    live: { state: 'working', alive: true, activity: { kind: 'tool', label: 'Bash' }, snapshotAt: at(0) },
  },
  {
    name: 'no-frame',
    why: 'The ordinary case before the socket has said anything.',
    session: { alive: true, state: 'idle', snapshotAt: at(1_000) },
    live: null,
  },
  {
    name: 'frame-newer',
    why: 'The whole point: a push lands between two polls and the header moves.',
    session: { alive: true, state: 'idle', snapshotAt: at(10_000) },
    live: { state: 'working', alive: true, activity: { kind: 'tool', label: 'Bash', elapsedSec: 3 }, snapshotAt: at(1_000) },
  },
  {
    name: 'frame-equal',
    why: 'A tie goes to the ROW — the poll has caught up and carries every field.',
    session: { alive: true, state: 'idle', snapshotAt: at(1_000), activity: { kind: 'tool', label: 'Read' } },
    live: { state: 'working', alive: true, activity: null, snapshotAt: at(1_000) },
  },
  {
    name: 'frame-older',
    why: 'A frame that arrives after the poll it predates must not undo it.',
    session: { alive: true, state: 'idle', snapshotAt: at(1_000) },
    live: { state: 'working', alive: true, activity: null, snapshotAt: at(9_000) },
  },
  {
    name: 'frame-no-snapshot',
    why: 'A frame that cannot say when it was taken counts as zero and loses.',
    session: { alive: true, state: 'idle', snapshotAt: at(5_000) },
    live: { state: 'working', alive: true, activity: null, snapshotAt: null },
  },
  {
    name: 'row-no-snapshot',
    why: 'A row that never had one loses to any frame that does.',
    session: { alive: false, state: 'idle', snapshotAt: null },
    live: { state: 'working', alive: true, activity: null, snapshotAt: at(9_000) },
  },
  {
    name: 'frame-does-not-clear-closed',
    why: 'It replaces four fields. `closedAt` is not one of them.',
    session: { alive: false, state: 'idle', snapshotAt: at(10_000), closedAt: at(60_000), restartRequestedAt: at(30_000) },
    live: { state: 'working', alive: true, activity: null, snapshotAt: at(1_000) },
  },
  {
    name: 'frame-clears-activity',
    why: 'A null activity on a newer frame really does clear the row\'s.',
    session: { alive: true, state: 'working', snapshotAt: at(10_000), activity: { kind: 'tool', label: 'Bash' } },
    live: { state: 'idle', alive: true, activity: null, snapshotAt: at(1_000) },
  },
];

export function buildFixture(): Fixture {
  return {
    now: NOW,
    // Rendered so a Swift side reading the generated contract can assert it is
    // looking at the same two numbers this table was built with.
    snapshotStaleMs: 45_000,
    backgroundResidentMs: 30 * 60_000,
    durations: DURATIONS.map((sec) => ({ sec, expected: shortDuration(sec) })),
    activities: ACTIVITIES.map((a) => ({
      ...a,
      label: activityLabel(a.activity),
      summary: backgroundSummary(a.activity),
      tasks: backgroundTaskList(a.activity),
    })),
    merges: MERGES.map((c) => {
      const merged = mergeLiveStatus(c.session, c.live);
      return {
        ...c,
        merged: merged
          ? {
              alive: merged.alive ?? null,
              state: merged.state ?? null,
              snapshotAt: merged.snapshotAt ?? null,
              activity: merged.activity ?? null,
              closedAt: merged.closedAt ?? null,
              restartRequestedAt: merged.restartRequestedAt ?? null,
            }
          : null,
        // What the header would actually print out of it, which is the only
        // reason the merge exists.
        view: sessionStatusView(merged, { unread: false, now: NOW }),
      };
    }),
    statuses: STATUSES.map((s) => {
      const expected = sessionStatusView(s.session, s.opts);
      return {
        ...s,
        expected,
        resting: isRestingState(expected.key),
        silenceMs: snapshotSilenceMs(s.session?.snapshotAt, s.opts),
      };
    }),
  };
}

export function renderFixture(): string {
  return JSON.stringify(buildFixture(), null, 2) + '\n';
}

export function checkedInFixture(): string {
  return readFileSync(join(REPO_ROOT, FIXTURE_JSON), 'utf8');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const out = join(REPO_ROOT, FIXTURE_JSON);
  mkdirSync(dirname(out), { recursive: true });
  const f = buildFixture();
  writeFileSync(out, renderFixture());
  console.log(
    `wrote      ${FIXTURE_JSON}  (${f.durations.length} durations, ${f.activities.length} activities, ${f.statuses.length} statuses, ${f.merges.length} merges)`,
  );
}
