/**
 * Renders `apps/ios/tools/fixtures/detail-cases.json` — the answers the WEB's
 * own session-detail logic gives today, for the Swift port to be held against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:detail-fixture
 *
 * Three things are under test, and each is the kind that is quietly wrong on
 * one platform only:
 *
 *   · `detailPickerView` — which card is drawn as selected, whether a Mode
 *     select belongs on screen at all, where the shown mode CAME from, and
 *     whether Apply is live. The picker must never name a backend the session
 *     is not on, and "inherited from the agent" must never be shown as a
 *     session setting.
 *   · `detailSwitchPrompt` / `detailSavePayload` — what the confirm says before
 *     a switch, and what the mutation then sends. `keepsContext` is the one
 *     that costs a user something if it is wrong in either direction.
 *   · `detailSections` — every label/value pair in the read-only sections, in
 *     order. Two platforms re-deriving these from a screenshot is how they
 *     drift; a table is how they do not.
 *
 * `session-detail-sheet.tsx` calls all of it, so a red line over in
 * `apps/ios/tools/detail-fixture.sh` is two implementations disagreeing, never
 * an implementation disagreeing with a test author.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  detailPickerView, detailSavePayload, detailSections, detailStamp, detailSwitchPrompt,
  backendLabelOf, harnessOfBackend, sessionUrl, detailHeading,
  type DetailForm, type DetailSnapshot,
} from '../src/components/chat/session-detail-core';
import type { BackendsConfig } from '../src/lib/backends';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_JSON = 'apps/ios/tools/fixtures/detail-cases.json';

// A fixed clock: every `relTime` in the read-only rows is measured from here.
const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

// ---------------------------------------------------------------------------
// The machine's backends. One with nothing composed (the resting state), one
// with a composed pi and a composed claude-sdk, one with a built-in switched
// off — which is the case where the picker still has to draw the card the
// session is ON.
// ---------------------------------------------------------------------------

const CFG_PLAIN: BackendsConfig = { disabled: [] };
const CFG_COMPOSED: BackendsConfig = {
  disabled: [],
  instances: [
    { id: 'pi-home', harness: 'pi-rpc', credentialId: 'cred-dsk', label: 'pi (home)', mode: 'coding' },
    { id: 'kimi-lan', harness: 'kimi-code', credentialId: 'cred-kimi', label: 'Kimi (LAN)' },
  ],
};
const CFG_RETIRED: BackendsConfig = {
  disabled: ['claude-tmux'],
  instances: [{ id: 'pi-home', harness: 'pi-rpc', credentialId: 'cred-dsk', label: 'pi (home)' }],
};

const CONFIGS: Array<{ key: string; cfg: BackendsConfig | null }> = [
  { key: 'plain', cfg: CFG_PLAIN },
  { key: 'composed', cfg: CFG_COMPOSED },
  { key: 'retired', cfg: CFG_RETIRED },
  // The picker has to answer before the config query has: nothing composed and
  // nothing disabled is exactly what `null` has to behave as.
  { key: 'null', cfg: null },
];
const cfgOf = (key: string) => CONFIGS.find((c) => c.key === key)!.cfg;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const BASE: DetailSnapshot = {
  id: 's_timeline',
  agentName: 'asst',
  title: 'the ios port',
  titleAuto: false,
  origin: null,
  startedAt: ago(86_400 * 3),
  lastMessageAt: ago(45),
  lastActivity: ago(12),
  closedAt: null,
  hiddenAt: null,
  hibernatedAt: null,
  snapshotAt: ago(3_600),
  runtimeProvider: null,
  runtimeModel: null,
  runtimeMode: null,
  claudeSessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
  transcriptPath: '/Users/z/.claude/projects/asst/a1b2c3d4.jsonl',
  agentDirectory: '/Users/z/agents/asst',
  pid: 4711,
  alive: true,
  state: 'idle',
  rssMb: 812,
  activity: null,
  contextTokens: 51_200,
  messageCount: 318,
  groupName: null,
  backend: {
    backendId: 'claude-sdk', runtime: 'claude-sdk',
    runtimeModel: 'claude-opus-4-6', runtimeMode: null, runtimeCredentialId: null,
  },
  agentBackend: {
    backendId: 'claude-sdk', runtime: 'claude-sdk',
    runtimeModel: null, runtimeMode: null, runtimeCredentialId: null,
  },
  inherited: true,
};

const s = (over: Partial<DetailSnapshot>): DetailSnapshot => ({ ...BASE, ...over });

const PI_SESSION = s({
  runtimeMode: 'ops',
  backend: { backendId: 'pi-rpc', runtime: 'pi-rpc', runtimeModel: null, runtimeMode: 'ops', runtimeCredentialId: null },
  agentBackend: { backendId: 'claude-sdk', runtime: 'claude-sdk', runtimeModel: null, runtimeMode: null, runtimeCredentialId: null },
  inherited: false,
});

const SESSIONS: Array<{ key: string; d: DetailSnapshot | null }> = [
  { key: 'base', d: BASE },
  { key: 'none', d: null },
  { key: 'pi-pinned', d: PI_SESSION },
  {
    // Inherits pi AND the agent's mode: "Inherited from asst." is the line, and
    // it must not read as a session setting.
    key: 'pi-inherited',
    d: s({
      runtimeMode: null,
      backend: { backendId: 'pi-rpc', runtime: 'pi-rpc', runtimeModel: null, runtimeMode: 'writer', runtimeCredentialId: null },
      agentBackend: { backendId: 'pi-rpc', runtime: 'pi-rpc', runtimeModel: null, runtimeMode: 'writer', runtimeCredentialId: null },
      inherited: true,
    }),
  },
  {
    // The removed triage router: opens on the fleet default, not on a row the
    // select does not offer.
    key: 'pi-triage',
    d: s({
      runtimeMode: 'triage',
      backend: { backendId: 'pi-rpc', runtime: 'pi-rpc', runtimeModel: null, runtimeMode: 'triage', runtimeCredentialId: null },
      agentBackend: { backendId: 'pi-rpc', runtime: 'pi-rpc', runtimeModel: null, runtimeMode: 'triage', runtimeCredentialId: null },
      inherited: false,
    }),
  },
  {
    // A machine-local mode this build does not list: it must keep reading as
    // itself rather than snapping to the default.
    key: 'pi-unknown-mode',
    d: s({
      runtimeMode: 'lab',
      backend: { backendId: 'pi-home', runtime: 'pi-rpc', runtimeModel: null, runtimeMode: 'lab', runtimeCredentialId: 'cred-dsk' },
      agentBackend: { backendId: 'pi-home', runtime: 'pi-rpc', runtimeModel: null, runtimeMode: 'coding', runtimeCredentialId: 'cred-dsk' },
      inherited: false,
    }),
  },
  {
    key: 'codex-working',
    d: s({
      state: 'working',
      backend: { backendId: 'codex-exec', runtime: 'codex-exec', runtimeModel: 'gpt-5-codex', runtimeMode: null, runtimeCredentialId: null },
      agentBackend: { backendId: 'codex-exec', runtime: 'codex-exec', runtimeModel: null, runtimeMode: null, runtimeCredentialId: null },
      inherited: true,
    }),
  },
  {
    key: 'tmux-retired',
    d: s({
      backend: { backendId: 'claude-tmux', runtime: 'claude-tmux', runtimeModel: null, runtimeMode: null, runtimeCredentialId: null },
      agentBackend: { backendId: 'claude-sdk', runtime: 'claude-sdk', runtimeModel: null, runtimeMode: null, runtimeCredentialId: null },
      inherited: false,
    }),
  },
  {
    // Nothing loaded, nothing running, everything missing — the em-dash rows.
    key: 'bare',
    d: s({
      title: null, titleAuto: null, snapshotAt: null, lastMessageAt: null, lastActivity: null,
      alive: false, pid: null, rssMb: null, state: null, contextTokens: null,
      agentDirectory: null, claudeSessionId: null, transcriptPath: null, groupName: null,
      messageCount: 0,
    }),
  },
  {
    key: 'archived-hidden',
    d: s({
      closedAt: ago(600), hiddenAt: ago(300), origin: 'cron',
      title: 'nightly sweep', titleAuto: true, groupName: 'chores',
      hibernatedAt: ago(7_200), state: 'closed', alive: false, pid: null, rssMb: null,
    }),
  },
  {
    // Two background tasks outstanding: the section that only exists sometimes.
    key: 'background',
    d: s({
      state: 'idle',
      activity: {
        kind: 'background',
        backgroundCount: 3,
        backgroundTasks: [
          { id: 'bg1', description: 'pnpm build', elapsedSec: 5_280 },
          { id: 'bg2', description: 'du -sh ~/Library', elapsedSec: 88 },
          // No description and no id: the defensive defaults, which are part of
          // the answer this row prints.
          { elapsedSec: 0 },
        ],
      },
    }),
  },
  {
    // The gateway says how many but not which — the "cannot say which" row.
    key: 'background-countonly',
    d: s({ state: 'idle', activity: { backgroundCount: 1 } }),
  },
];

const FORMS: Array<{ key: string; form: DetailForm }> = [
  { key: 'clean', form: { runtime: null, mode: null } },
  { key: 'to-tmux', form: { runtime: 'claude-tmux', mode: null } },
  { key: 'to-codex', form: { runtime: 'codex-exec', mode: null } },
  { key: 'to-pi', form: { runtime: 'pi-rpc', mode: null } },
  { key: 'to-pi-home', form: { runtime: 'pi-home', mode: null } },
  { key: 'mode-only', form: { runtime: null, mode: 'scout' } },
  { key: 'to-pi-and-mode', form: { runtime: 'pi-rpc', mode: 'patch' } },
];

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

type PickerCase = {
  why: string;
  session: string; cfg: string; form: DetailForm; scoped: boolean;
  stamp: string | null;
  heading: string;
  view: ReturnType<typeof detailPickerView>;
  prompt: ReturnType<typeof detailSwitchPrompt> | null;
  payload: ReturnType<typeof detailSavePayload> | null;
};

const pickers: PickerCase[] = [];
function picker(why: string, sessionKey: string, cfgKey: string, formKey: string, scoped = false) {
  const d = SESSIONS.find((x) => x.key === sessionKey)!.d;
  const cfg = cfgOf(cfgKey);
  const form = FORMS.find((f) => f.key === formKey)!.form;
  const view = detailPickerView({ d, cfg, form, scoped });
  pickers.push({
    why,
    session: sessionKey, cfg: cfgKey, form, scoped,
    stamp: detailStamp('s_timeline', d),
    heading: detailHeading(d),
    view,
    // The sheet only builds these two when there IS something to apply.
    prompt: d && view.dirty ? detailSwitchPrompt(d, cfg, view) : null,
    payload: d && view.dirty ? detailSavePayload(d, view) : null,
  });
}

picker('a claude-sdk session, nothing touched', 'base', 'plain', 'clean');
picker('the detail query has not answered — the floor, and nothing dirty', 'none', 'plain', 'clean');
picker('the same, with a form already set: still the floor, still not dirty', 'none', 'plain', 'to-pi');
picker('claude-sdk → claude-tmux: the same transcript, so the confirm says so', 'base', 'plain', 'to-tmux');
picker('claude-sdk → codex: the running context does not travel', 'base', 'plain', 'to-codex');
picker('claude-sdk → pi: the mode select appears in the same breath', 'base', 'plain', 'to-pi');
picker('…and pi opens on what the AGENT would start pi in, not the fleet default', 'pi-inherited', 'plain', 'clean');
picker('a pi session pinned to ops', 'pi-pinned', 'plain', 'clean');
picker('mode-only switch on a pi session', 'pi-pinned', 'plain', 'mode-only');
picker('a mode change on a CLAUDE session is not dirty — there is no mode to change', 'base', 'plain', 'mode-only');
picker('triage resolves to the fleet default rather than a row the select lacks', 'pi-triage', 'plain', 'clean');
picker('a machine-local mode keeps reading as itself', 'pi-unknown-mode', 'composed', 'clean');
picker('a composed pi backend is a pi backend — by HARNESS, not by name', 'base', 'composed', 'to-pi-home');
picker('backend AND mode in one Apply', 'base', 'composed', 'to-pi-and-mode');
picker('mid-turn: dirty, but the switch is refused until the turn ends', 'codex-working', 'plain', 'to-tmux');
picker('a share link: read-only, and the picker still says what is running', 'base', 'plain', 'clean', true);
picker('a share link with a form set — dirty is about the FORM, readOnly is the gate', 'base', 'plain', 'to-codex', true);
picker('the session is on a backend the machine switched off: its card is still drawn', 'tmux-retired', 'retired', 'clean');
picker('…and moving off it is a normal claude-to-claude move', 'tmux-retired', 'retired', 'to-pi-home');
picker('no config yet: two built-ins and nothing composed', 'base', 'null', 'clean');
picker('archived session, unchanged', 'archived-hidden', 'plain', 'clean');
picker('a codex session inheriting the agent default', 'codex-working', 'plain', 'clean');

// ── the read-only sections ──────────────────────────────────────────────────

type SectionCase = {
  why: string;
  session: string;
  readOnly: boolean;
  sections: ReturnType<typeof detailSections>;
};
const sections: SectionCase[] = [];
function sect(why: string, sessionKey: string, readOnly = false) {
  const d = SESSIONS.find((x) => x.key === sessionKey)!.d!;
  sections.push({ why, session: sessionKey, readOnly, sections: detailSections({ d, readOnly, now: NOW }) });
}

sect('a live claude-sdk session', 'base');
sect('…as a share link: no directory, no backend id, no transcript', 'base', true);
sect('pi: no model row at all — pi\'s model is not switchable from the header', 'pi-pinned');
sect('codex: the model row is there, and says where to change it', 'codex-working');
sect('everything missing — the em-dash rows', 'bare');
sect('archived, hidden, hibernated, grouped, auto-titled, with an origin', 'archived-hidden');
sect('two outstanding background tasks, oldest first', 'background');
sect('the gateway said how many but not which', 'background-countonly');

// ── the labels the pickers lean on ──────────────────────────────────────────

const labels: Array<{ cfg: string; id: string; label: string; harness: string }> = [];
for (const { key, cfg } of CONFIGS) {
  for (const id of ['claude-sdk', 'claude-tmux', 'codex-exec', 'pi-rpc', 'pi-home', 'kimi-lan', 'omp-rpc', 'nope']) {
    labels.push({ cfg: key, id, label: backendLabelOf(cfg, id), harness: harnessOfBackend(cfg, id) });
  }
}

const out = {
  now: NOW,
  sessions: Object.fromEntries(SESSIONS.map((x) => [x.key, x.d])),
  configs: Object.fromEntries(CONFIGS.map((c) => [c.key, c.cfg])),
  url: sessionUrl('https://hermit.example', 's_timeline'),
  pickers,
  sections,
  labels,
};

const path = join(REPO_ROOT, FIXTURE_JSON);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
const count = pickers.length + sections.reduce((n, s) => n + s.sections.reduce((m, x) => m + x.rows.length, 0), 0) + labels.length;
console.log(`wrote ${FIXTURE_JSON} — ${count} cases`);
