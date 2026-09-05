/**
 * Renders `apps/ios/tools/fixtures/actions-cases.json` — the answers the WEB's
 * own chat-header logic gives today, for the Swift port to be held against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:actions-fixture
 *
 * Two things are under test, and both are the kind that look obvious until they
 * are wrong on one platform only:
 *
 *   · `headerActions` — which buttons the cluster HAS. An action that does not
 *     apply is absent, not disabled, so the answer is a list and its ORDER is
 *     part of it: on a phone the persistent members stay on the row and the
 *     `secondary` ones move into the tray, and a renderer that re-derived
 *     either would drift.
 *   · `confirmStep` — the two-step confirm. Its whole content is timing: the
 *     350ms guard that stops a double-tap confirming what it just armed, and
 *     the 5s auto-disarm. Both are only visible in cases that differ by a
 *     millisecond, which is exactly what a table is for.
 *
 * `app/chat/page.tsx` and `confirm-icon-button.tsx` call these, so a red line
 * over there is two implementations disagreeing, never an implementation
 * disagreeing with a test author.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  ARM_GUARD_MS,
  AUTO_DISARM_MS,
  DISARMED,
  SECONDARY_FOLD_PX,
  confirmStep,
  headerActions,
  secondaryFolds,
  type ConfirmEvent,
  type ConfirmState,
  type HeaderActionState,
} from '../src/components/chat/header-actions-core';
import { hasTmuxPane } from '../src/lib/runtime-labels';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_JSON = 'apps/ios/tools/fixtures/actions-cases.json';

// ---------------------------------------------------------------------------
// headerActions — the cluster's shape
// ---------------------------------------------------------------------------

const LIVE = { agentName: 'asst', runtime: 'claude-tmux', closedAt: null, restartRequestedAt: null };

const base: HeaderActionState = {
  session: LIVE,
  scoped: false,
  creatingChat: false,
  deleting: false,
  restarting: false,
  reopening: false,
  findOpen: false,
  moreOpen: false,
  hasTmuxPane: true,
};

const shapeCases: Array<{ why: string; state: HeaderActionState }> = [
  { why: 'a live tmux session — everything but restore', state: base },
  {
    why: 'nothing loaded yet: the actions that need a target are disabled, but they are still THERE',
    state: { ...base, session: null, hasTmuxPane: hasTmuxPane(undefined) },
  },
  {
    why: 'archived: restore appears, and compact (which sends a message) goes dead while restart does not',
    state: { ...base, session: { ...LIVE, closedAt: '2026-09-01T00:00:00.000Z' } },
  },
  {
    why: 'archived + the reopen already in flight',
    state: { ...base, session: { ...LIVE, closedAt: '2026-09-01T00:00:00.000Z' }, reopening: true },
  },
  {
    why: 'codex-exec is a child process: no pane, so no terminal',
    state: { ...base, session: { ...LIVE, runtime: 'codex-exec' }, hasTmuxPane: hasTmuxPane('codex-exec') },
  },
  {
    why: 'claude-sdk is the other paneless one, and it is the DEFAULT backend',
    state: { ...base, session: { ...LIVE, runtime: 'claude-sdk' }, hasTmuxPane: hasTmuxPane('claude-sdk') },
  },
  {
    why: 'an unknown runtime is assumed to have a pane — the web list is a deny-list',
    state: { ...base, session: { ...LIVE, runtime: 'some-backend-shipped-next-week' },
      hasTmuxPane: hasTmuxPane('some-backend-shipped-next-week') },
  },
  {
    why: 'a share link: machine procedures would 403, so the terminal goes even with a pane',
    state: { ...base, scoped: true },
  },
  {
    why: 'no agent name (a share-scoped row): pure chat and new chat have nothing to spawn',
    state: { ...base, session: { ...LIVE, agentName: null } },
  },
  {
    why: 'an empty agent name is the same as none — JS falsiness, and Swift must agree',
    state: { ...base, session: { ...LIVE, agentName: '' } },
  },
  {
    why: 'a restart the server has already accepted: busy comes off the SESSION, not the mutation',
    state: { ...base, session: { ...LIVE, restartRequestedAt: '2026-09-01T00:00:00.000Z' } },
  },
  { why: 'a create in flight busies pure chat and disables new chat — two different treatments of one flag',
    state: { ...base, creatingChat: true } },
  { why: 'delete in flight', state: { ...base, deleting: true } },
  { why: 'restart in flight', state: { ...base, restarting: true } },
  { why: 'find open and the tray open — the two toggles are pressed together', state: { ...base, findOpen: true, moreOpen: true } },
];

const shape = shapeCases.map((c) => ({ why: c.why, state: c.state, expected: headerActions(c.state) }));

// ---------------------------------------------------------------------------
// secondaryFolds — the container-query threshold
// ---------------------------------------------------------------------------

const folds = [390, 430, 639, 640, 641, 834, 1024].map((w) => ({
  width: w,
  expected: secondaryFolds(w),
}));

// ---------------------------------------------------------------------------
// confirmStep — arm, guard, fire, auto-disarm
// ---------------------------------------------------------------------------

const T0 = 1_757_000_000_000;

type StepCase = { why: string; start: ConfirmState; steps: Array<{ event: ConfirmEvent; now: number }> };

const stepCases: StepCase[] = [
  { why: 'press arms it and fires nothing', start: DISARMED, steps: [{ event: 'press', now: T0 }] },
  {
    why: 'the bounce: a confirm inside the guard is DROPPED and the pill stays armed',
    start: DISARMED,
    steps: [{ event: 'press', now: T0 }, { event: 'confirm', now: T0 + ARM_GUARD_MS - 1 }],
  },
  {
    why: 'one millisecond later it fires — the guard boundary is >=, not >',
    start: DISARMED,
    steps: [{ event: 'press', now: T0 }, { event: 'confirm', now: T0 + ARM_GUARD_MS }],
  },
  {
    why: 'a swallowed confirm leaves the pill up, so the NEXT tap still works',
    start: DISARMED,
    steps: [
      { event: 'press', now: T0 },
      { event: 'confirm', now: T0 + 100 },
      { event: 'confirm', now: T0 + 400 },
    ],
  },
  {
    why: 'cancel is guarded the same way, for the same reason',
    start: DISARMED,
    steps: [{ event: 'press', now: T0 }, { event: 'cancel', now: T0 + 349 }, { event: 'cancel', now: T0 + 350 }],
  },
  {
    why: 'a confirm after cancel does nothing: the pill is gone, and a stray tap must not fire',
    start: DISARMED,
    steps: [
      { event: 'press', now: T0 },
      { event: 'cancel', now: T0 + 400 },
      { event: 'confirm', now: T0 + 500 },
    ],
  },
  {
    why: 'the timer landing early leaves it armed rather than yanking it out from under a finger',
    start: DISARMED,
    steps: [{ event: 'press', now: T0 }, { event: 'timeout', now: T0 + AUTO_DISARM_MS - 1 }],
  },
  {
    why: 'at the deadline it disarms, and fires nothing',
    start: DISARMED,
    steps: [{ event: 'press', now: T0 }, { event: 'timeout', now: T0 + AUTO_DISARM_MS }],
  },
  {
    why: 'a confirm collected after the auto-disarm is not a confirm',
    start: DISARMED,
    steps: [
      { event: 'press', now: T0 },
      { event: 'timeout', now: T0 + AUTO_DISARM_MS },
      { event: 'confirm', now: T0 + AUTO_DISARM_MS + 10 },
    ],
  },
  {
    why: 're-pressing an armed control RE-ARMS it (restarts the guard) instead of toggling off',
    start: DISARMED,
    steps: [
      { event: 'press', now: T0 },
      { event: 'press', now: T0 + 4_000 },
      { event: 'confirm', now: T0 + 4_100 },
      { event: 'confirm', now: T0 + 4_400 },
    ],
  },
  {
    why: 'timeout on a disarmed pill is a no-op, not a re-entry',
    start: DISARMED,
    steps: [{ event: 'timeout', now: T0 + 99_999 }],
  },
];

const steps = stepCases.map((c) => {
  let state = c.start;
  const trace = c.steps.map((s) => {
    const out = confirmStep(state, s.event, s.now);
    state = out.state;
    return {
      event: s.event,
      now: s.now,
      armed: out.state.armed,
      armedAt: out.state.armed ? out.state.armedAt : null,
      fire: out.fire,
    };
  });
  return { why: c.why, start: { armed: c.start.armed, armedAt: null }, steps: c.steps, trace };
});

// ---------------------------------------------------------------------------

const out = {
  armGuardMs: ARM_GUARD_MS,
  autoDisarmMs: AUTO_DISARM_MS,
  secondaryFoldPx: SECONDARY_FOLD_PX,
  shape,
  folds,
  steps,
};

const path = join(REPO_ROOT, FIXTURE_JSON);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
const count = shape.length + folds.length + steps.reduce((n, s) => n + s.trace.length, 0);
console.log(`wrote ${FIXTURE_JSON} — ${count} cases`);
