// The session detail sheet's rules, with no React in them.
//
// Extracted so `apps/ios/Hermit/SessionDetailCore.swift` can be held against
// THIS code (`apps/ios/tools/detail-fixture.sh`) rather than against someone's
// reading of the JSX. `session-detail-sheet.tsx` calls everything here; nothing
// here is a second copy of anything it does.
//
// What is a rule and what is a widget:
//   · a rule — which backend the pickers show, whether Apply is live, whether a
//     switch keeps the running context, what the mutation sends, and every
//     label/value pair in the read-only sections
//   · a widget — the Sheet, the cards, the Select, the context bar
//
// The read-only rows are in here for the same reason the action cluster's list
// is: the ORDER and the exact strings are the answer, and two platforms
// re-deriving them from a screenshot is how they drift.

import { relTime } from '@/lib/format';
import { contextWindowFor } from '@/lib/context-window';
import {
  availableBackends, backendById, isBackendEnabled, DEFAULT_BACKEND_ID,
  type Backend, type BackendsConfig,
} from '@/lib/backends';
import { runtimeLabel, sharesConversation } from '@/lib/runtime-labels';
import {
  isPiMode, piModeLabel, DEFAULT_PI_MODE, PI_MODE_META, type PiMode,
} from '@/lib/pi-modes';
import {
  backgroundOutstanding, backgroundTaskList, shortDuration,
} from '@/lib/session-status';

// ── The inputs ───────────────────────────────────────────────────────────────

/** The half of `resolveRuntime`'s answer this sheet reads. */
export type DetailBackend = {
  backendId: string;
  runtime: string;
  runtimeModel: string | null;
  runtimeMode: string | null;
  runtimeCredentialId: string | null;
};

/** What `chat.sessionDetail` returns, as far as this sheet is concerned. */
export type DetailSnapshot = {
  id: string;
  agentName: string;
  title: string | null;
  titleAuto: boolean | null;
  origin: string | null;
  startedAt: string | Date;
  lastMessageAt: string | Date | null;
  lastActivity: string | Date | null;
  closedAt: string | Date | null;
  hiddenAt: string | Date | null;
  hibernatedAt: string | Date | null;
  snapshotAt: string | Date | null;
  runtimeProvider: string | null;
  runtimeModel: string | null;
  runtimeMode: string | null;
  claudeSessionId: string | null;
  transcriptPath: string | null;
  agentDirectory: string | null;
  pid: number | null;
  alive: boolean | null;
  state: string | null;
  rssMb: number | null;
  activity: unknown;
  contextTokens: number | null;
  messageCount: number;
  groupName: string | null;
  backend: DetailBackend;
  agentBackend: DetailBackend;
  inherited: boolean;
};

/**
 * What the user has CHANGED, and nothing else — null means "whatever the server
 * says". Keeping the form empty rather than seeded is what makes a 10s refetch
 * safe mid-edit; see the sheet's own note.
 */
export type DetailForm = { runtime: string | null; mode: PiMode | null };

export const EMPTY_FORM: DetailForm = { runtime: null, mode: null };

/**
 * The server's answer as one string. When it moves — our save landed, or
 * another device switched this session — the form is dropped.
 */
export function detailStamp(sessionId: string, d: DetailSnapshot | null | undefined): string | null {
  return d ? `${sessionId}|${d.backend.backendId}|${d.backend.runtimeMode ?? ''}` : null;
}

// ── The backend / mode pickers ───────────────────────────────────────────────

export type DetailPickerView = {
  /** The card drawn as selected. Never a backend the session is not on. */
  shownBackend: string;
  /** Does the HARNESS behind the chosen backend take a mode? */
  shownIsPi: boolean;
  currentMode: PiMode | string;
  shownMode: PiMode | string;
  /** What the mode does, under the select. Null for a mode this build doesn't list. */
  modeBlurb: string | null;
  /** Where the mode in the picker came from, or what Apply is about to do. */
  modeSource: string;
  /** Anything to apply? */
  dirty: boolean;
  /** Mid-turn: the switch is refused rather than queued. */
  working: boolean;
  /** A share link gets no machine-level control. */
  readOnly: boolean;
  /** The line under the picker: inherited from the agent, or set here. */
  inheritedLine: string;
  /** The cards, in the order the picker draws them. */
  cards: DetailBackendCard[];
};

export type DetailBackendCard = {
  id: string;
  label: string;
  blurb: string;
  builtIn: boolean;
  /** Switched off in Settings → Backends, and only listed because we are ON it. */
  retired: boolean;
  /** "what this agent normally uses" stays visible. */
  isAgentDefault: boolean;
  credentialId: string | null;
};

export type DetailPickerInput = {
  d: DetailSnapshot | null | undefined;
  cfg: BackendsConfig | null | undefined;
  form: DetailForm;
  /** A share link — `useScope().scoped`. */
  scoped: boolean;
};

export function backendLabelOf(cfg: BackendsConfig | null | undefined, id: string): string {
  return availableBackends(cfg, id).find((b) => b.id === id)?.label ?? runtimeLabel(id);
}

/** A backend id is not a harness — a composed one has an id of its own. */
export function harnessOfBackend(cfg: BackendsConfig | null | undefined, id: string): string {
  return backendById(cfg, id)?.harness ?? id;
}

/** Which driver AND whose endpoint — both halves decide whether the transcript survives. */
export function sideOfBackend(cfg: BackendsConfig | null | undefined, id: string) {
  return { runtime: harnessOfBackend(cfg, id), credentialId: backendById(cfg, id)?.credentialId ?? null };
}

export function detailCards(
  cfg: BackendsConfig | null | undefined,
  selected: string,
  agentDefault: string | null,
): DetailBackendCard[] {
  return availableBackends(cfg, selected).map((b: Backend) => ({
    id: b.id,
    label: b.label,
    blurb: b.blurb,
    builtIn: b.builtIn,
    retired: !isBackendEnabled(b.id, cfg),
    isAgentDefault: !!agentDefault && b.id === agentDefault,
    credentialId: b.credentialId,
  }));
}

export function detailPickerView(input: DetailPickerInput): DetailPickerView {
  const { d, cfg, form, scoped } = input;
  // The last fallback is the resolver's own floor: reaching it means the detail
  // query has not answered yet, and naming a backend the session is not on is
  // the one thing these pickers must never do.
  const shownBackend = form.runtime ?? d?.backend.backendId ?? DEFAULT_BACKEND_ID;
  // Follows the HARNESS behind the chosen backend, not its name: two backends
  // can both run pi against different credentials.
  const shownIsPi = backendById(cfg, shownBackend)?.harness === 'pi-rpc';
  // A claude session resolves to no mode at all, so flipping the picker to pi
  // opens the mode select on what the AGENT would start pi in — the same answer
  // "New chat" would give — rather than on the fleet default. The removed triage
  // router opens on the fleet default instead of on a row the select does not
  // offer; other unknown names pass through.
  const resolved = d?.backend.runtimeMode ?? d?.agentBackend.runtimeMode ?? DEFAULT_PI_MODE;
  const currentMode = resolved === 'triage' ? DEFAULT_PI_MODE : resolved;
  const shownMode = form.mode ?? currentMode;

  const modeSource = shownMode !== currentMode
    ? 'Applying pins it to this session.'
    : d?.runtimeMode
      ? 'Set on this session.'
      : currentMode === d?.agentBackend.runtimeMode
        ? `Inherited from ${d.agentName}.`
        : 'The default mode.';

  const agentDefaultId = d?.agentBackend.backendId ?? null;
  const agentLabel = agentDefaultId ? backendLabelOf(cfg, agentDefaultId) : '';
  return {
    shownBackend,
    shownIsPi,
    currentMode,
    shownMode,
    modeBlurb: isPiMode(shownMode) ? PI_MODE_META[shownMode].blurb : null,
    modeSource,
    dirty: !!d
      && (shownBackend !== d.backend.backendId
        || (shownIsPi && shownMode !== d.backend.runtimeMode)),
    working: d?.state === 'working',
    readOnly: scoped,
    inheritedLine: !d
      ? ''
      : d.inherited
        ? `Inherited from ${d.agentName} (${agentLabel}). Choosing here pins it to this session.`
        : `Set on this session. The agent's own default is ${agentLabel}.`,
    cards: detailCards(cfg, shownBackend, agentDefaultId),
  };
}

// ── The confirm before the switch ────────────────────────────────────────────

/** A sentence in pieces, so both platforms emphasise the same word. */
export type Emphasised = { text: string; em?: boolean };

export type DetailSwitchPrompt = {
  title: string;
  message: Emphasised[];
  confirmLabel: string;
  /**
   * The two Claude Code drivers write the same transcript, so moving between
   * them resumes it rather than abandoning it. Saying otherwise would talk a
   * user out of a move that costs nothing.
   */
  keepsContext: boolean;
};

export function detailSwitchPrompt(
  d: DetailSnapshot,
  cfg: BackendsConfig | null | undefined,
  view: DetailPickerView,
): DetailSwitchPrompt {
  const changingBackend = view.shownBackend !== d.backend.backendId;
  const label = (id: string) => backendLabelOf(cfg, id);
  const keepsContext = changingBackend && sharesConversation(
    { runtime: d.backend.runtime, credentialId: d.backend.runtimeCredentialId },
    sideOfBackend(cfg, view.shownBackend),
  );
  const from = changingBackend ? label(d.backend.backendId) : 'pi';
  const to = changingBackend ? label(view.shownBackend) : piModeLabel(view.shownMode);
  return {
    title: changingBackend
      ? `Switch to ${label(view.shownBackend)}?`
      : `Switch mode to ${piModeLabel(view.shownMode)}?`,
    confirmLabel: changingBackend ? 'Switch' : 'Switch mode',
    keepsContext,
    message: keepsContext
      ? [{
          text: `Both are Claude Code on the same conversation, so nothing is lost: ${label(d.backend.backendId)} is stopped and ${label(view.shownBackend)} resumes the same transcript, with its full history, on the next message.`,
        }]
      : [
          { text: 'The conversation on this page is kept. What is ' },
          { text: 'not', em: true },
          {
            text: ` kept is the running context: ${from} is stopped, and the next message starts a fresh turn on ${to} with no memory of this thread beyond what you say in it.`,
          },
        ],
  };
}

/** What `chat.setSessionRuntime` is sent. */
export type DetailSavePayload = {
  id: string;
  runtime: string;
  runtimeProvider: string | null;
  runtimeModel: string | null;
  runtimeMode?: string;
};

export function detailSavePayload(d: DetailSnapshot, view: DetailPickerView): DetailSavePayload {
  return {
    id: d.id,
    runtime: view.shownBackend,
    // The session's OWN pins, not the resolved ones. Writing a resolved value
    // would turn "inherits the agent's" into a pin, and on a cross-backend
    // switch it would pin the OLD backend's.
    runtimeProvider: view.shownIsPi ? d.runtimeProvider ?? null : null,
    runtimeModel: view.shownIsPi ? d.runtimeModel ?? null : null,
    // Omitted on a switch to claude, which has no modes: leaving the column
    // alone keeps the pi mode for a switch back.
    ...(view.shownIsPi ? { runtimeMode: String(view.shownMode) } : {}),
  };
}

// ── The read-only sections ───────────────────────────────────────────────────

export type DetailRowKind = 'text' | 'ctx' | 'agent' | 'task';

export type DetailRow = {
  label: string;
  /** null draws the muted em-dash. */
  value: string | null;
  mono?: boolean;
  /** Muted sans, after the value. */
  note?: string;
  kind?: DetailRowKind;
  /** `kind: 'ctx'` only. */
  ctxTokens?: number | null;
  ctxTotal?: number;
};

export type DetailSection = {
  title: string;
  rows: DetailRow[];
  /** The small print under the section. */
  footer?: string;
};

export type DetailSectionsInput = {
  d: DetailSnapshot;
  /** A share link is shown no filesystem paths and no backend session id. */
  readOnly: boolean;
  now?: number;
};

/** How many background tasks a snapshot claims, for the "cannot say which" line. */
export function bgCount(activity: unknown): number {
  const n = (activity as { backgroundCount?: unknown } | null)?.backgroundCount;
  return typeof n === 'number' && n > 0 ? n : 0;
}

const BG_FOOTER =
  'The turn ended; these did not. The session keeps its working dot until they finish, or for 30 minutes after the agent’s last message — whichever comes first.';

export function detailSections(input: DetailSectionsInput): DetailSection[] {
  const { d, readOnly } = input;
  const now = input.now ?? Date.now();
  const rel = (v: string | Date | null | undefined) => (v ? relTime(v, now) : null);
  const out: DetailSection[] = [];

  // What is running OUTSIDE the turn — first, and only when there is any.
  //
  // A backgrounded Bash or subagent ends the turn the instant it starts, so the
  // session goes idle with work still going, and every surface could say only
  // the word "background". Which command, and for how long, is the difference
  // between a build that is nearly done and a `du` over ~/Library that will
  // still be running tomorrow.
  if (backgroundOutstanding(d.activity)) {
    const tasks = backgroundTaskList(d.activity);
    out.push({
      title: 'background',
      footer: BG_FOOTER,
      rows: tasks.length > 0
        // The age gets the label column — it is what this list is scanned for,
        // and left-aligned durations compare by eye in a way trailing ones do
        // not. `kind: 'task'` because that label is not uppercased: "1H 28M"
        // reads as a heading, not a clock.
        ? tasks.map((t) => ({
            label: t.elapsedSec ? shortDuration(t.elapsedSec) : '—',
            value: t.description,
            mono: true,
            kind: 'task' as const,
          }))
        : [{
            label: 'running',
            value: `${bgCount(d.activity)} task${bgCount(d.activity) === 1 ? '' : 's'} — this machine’s gateway has not said which`,
          }],
    });
  }

  const runRows: DetailRow[] = [];
  // Reported, not edited: the switch is the chip in the chat header, one click
  // from the reply that made you want it, and keeping the only control in one
  // place is what stops this sheet growing a second, disagreeing answer.
  if (d.backend.runtime === 'claude-sdk' || d.backend.runtime === 'codex-exec') {
    runRows.push({
      label: 'model',
      value: d.backend.runtimeModel ?? 'default',
      mono: true,
      note: 'change it from the header chip',
    });
  }
  runRows.push({
    label: 'state',
    value: d.state ?? 'idle',
    mono: true,
    note: d.hibernatedAt ? `\u{1F4A4} asleep since ${rel(d.hibernatedAt)}` : undefined,
  });
  runRows.push({
    label: 'context',
    value: null,
    kind: 'ctx',
    ctxTokens: d.contextTokens,
    ctxTotal: contextWindowFor(d.backend.runtime, d.backend.runtimeModel),
  });
  runRows.push({
    label: 'process',
    mono: true,
    value: d.alive
      ? `alive${d.pid ? ` · pid ${d.pid}` : ''}${d.rssMb ? ` · ${d.rssMb} MB` : ''}`
      : 'not running',
  });
  runRows.push({ label: 'snapshot', value: rel(d.snapshotAt) });
  runRows.push({ label: 'last activity', value: rel(d.lastActivity) });
  out.push({ title: 'run', rows: runRows });

  out.push({
    title: 'conversation',
    rows: [
      { label: 'messages', value: String(d.messageCount), mono: true },
      { label: 'started', value: rel(d.startedAt) },
      { label: 'last message', value: rel(d.lastMessageAt) },
      { label: 'title', value: d.title ? `${d.title}${d.titleAuto ? ' (auto)' : ''}` : null },
      { label: 'group', value: d.groupName ?? null },
      {
        label: 'flags',
        value: [d.closedAt && 'closed', d.hiddenAt && 'hidden', d.origin && `origin:${d.origin}`]
          .filter(Boolean)
          .join(' · ') || null,
      },
    ],
  });

  const whereRows: DetailRow[] = [
    { label: 'agent', value: d.agentName, mono: true, kind: 'agent' },
  ];
  // Filesystem paths and the backend's own session id are machine internals —
  // not for a share link, which only ever gets one agent's conversation.
  if (!readOnly) {
    whereRows.push({ label: 'directory', value: d.agentDirectory ?? null, mono: true });
    whereRows.push({ label: 'backend id', value: d.claudeSessionId ?? null, mono: true });
    whereRows.push({ label: 'transcript', value: d.transcriptPath ?? null, mono: true });
  }
  out.push({ title: 'where', rows: whereRows });

  return out;
}

/** The sheet's own title, and the link under it. */
export function detailHeading(d: DetailSnapshot | null | undefined): string {
  return d?.title || d?.agentName || 'Session';
}

export function sessionUrl(origin: string, sessionId: string): string {
  return `${origin}/chat?session=${encodeURIComponent(sessionId)}`;
}
