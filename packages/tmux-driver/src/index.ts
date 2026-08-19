// @hermit-ui/tmux-driver
//
// Long-lived tmux session per ChatSession. Each pane runs an interactive
// `claude` — keeps quota in the Interactive billing bucket (see L1) and
// gives us slash commands, sub-agents, /compact for free.
//
// Public surface:
//   ensureSession    — spawn pane if missing, idempotent
//   sendKeys         — push user text into the pane + submit
//   sendInterrupt    — Escape key (claude's mid-turn interrupt)
//   kill             — graceful /exit then SIGKILL after grace period
//   getClaudeSessionUuid — find the JSONL transcript path
//   watchTranscript  — tail -F a JSONL, emit parsed events
//
// Structured output comes from `~/.claude/projects/<encoded>/<uuid>.jsonl`,
// not from `tmux capture-pane` — the TUI is unparseable (ANSI/box drawing),
// the JSONL is Anthropic-native.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, readdirSync, statSync, mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Tmux helpers ─────────────────────────────────────────────────────────────

/**
 * Run a tmux subcommand. Returns { ok, stdout, stderr }. Doesn't throw on
 * non-zero exit — caller decides what to do.
 */
function tmux(args: string[], opts: { timeoutMs?: number } = {}): { ok: boolean; stdout: string; stderr: string; status: number } {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 5_000 });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    status: r.status ?? -1,
  };
}

/** True iff tmux server is reachable and the named session exists. */
export function hasSession(name: string): boolean {
  return tmux(['has-session', '-t', `=${name}`]).ok;
}

/** True iff the hermit-ui pane for `sessionId` is currently running. */
export function tmuxSessionExists(sessionId: string): boolean {
  return hasSession(paneName(sessionId));
}

/** Public version of the pane name function — callers may need it. */
export function tmuxPaneName(sessionId: string): string {
  return paneName(sessionId);
}

/**
 * The claude session uuid a pane was LAUNCHED with, read out of its argv.
 * `--session-id` (fresh spawns) wins over `--resume` (which can drift once claude
 * is running); null when neither is present. Pure half of paneClaudeSessionId so
 * the parsing is testable without a live pane.
 */
export function parseClaudeSessionIdArg(argv: string): string | null {
  const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  for (const flag of ['--session-id', '--resume']) {
    const m = new RegExp(`${flag}[= ]+(${UUID})`).exec(argv);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Ground truth for "which transcript is this pane writing": the uuid the gateway
 * itself passed on the command line. Used to recover a pane whose uuid never made
 * it into the DB (the first sync — which carries the stamp — can be eaten by a
 * dashboard timeout or a gateway restart seconds after the spawn), which otherwise
 * leaves the session "starting" forever while the pane works away untracked.
 */
export function paneClaudeSessionId(sessionId: string): string | null {
  // `<name>.0` (the house pane target), NOT `=<name>`: display-message silently
  // prints an EMPTY string with exit 0 for the `=` form, so the `=` variant looks
  // like "no pane" for every session. A missing session also exits 0 with no
  // output, hence the pid sanity check below rather than trusting the status.
  const r = tmux(['display-message', '-p', '-t', `${paneName(sessionId)}.0`, '#{pane_pid}']);
  const pid = Number(r.stdout);
  if (!r.ok || !Number.isInteger(pid) || pid <= 0) return null;
  // -ww: don't truncate argv to terminal width — the uuid sits after a long
  // --mcp-config JSON blob and would otherwise be cut off.
  const ps = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (ps.status !== 0) return null;
  return parseClaudeSessionIdArg(ps.stdout || '');
}

/** List all tmux sessions whose name starts with the given prefix. */
export function listSessions(prefix: string): string[] {
  const r = tmux(['list-sessions', '-F', '#{session_name}']);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter((s) => s.startsWith(prefix));
}

/** A live tmux session with the two clocks the orphan sweep judges on. */
export interface TmuxSessionInfo {
  name: string;
  /** When the session was created (epoch ms). */
  createdAt: number;
  /** Last activity in the session (epoch ms). */
  activityAt: number;
}

/**
 * Like `listSessions`, but carries `session_created` / `session_activity`.
 *
 * The orphan sweep needs BOTH: activity alone would kill a pane that was created
 * seconds ago and hasn't produced output yet (its activity stamp is its birth),
 * which is exactly the pane whose DB row is still in flight. Requiring both to be
 * older than the grace closes that race.
 *
 * A session tmux can't stat is skipped rather than defaulted — a zero here would
 * read as "created in 1970", i.e. always reapable, which is the wrong direction
 * for a function whose callers kill things.
 */
export function listSessionsDetailed(prefix: string): TmuxSessionInfo[] {
  const r = tmux(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_activity}']);
  if (!r.ok) return [];
  const out: TmuxSessionInfo[] = [];
  for (const line of r.stdout.split('\n')) {
    const [name, created, activity] = line.split('\t');
    if (!name?.startsWith(prefix)) continue;
    const createdAt = Number(created) * 1000;
    const activityAt = Number(activity) * 1000;
    if (!Number.isFinite(createdAt) || !Number.isFinite(activityAt) || createdAt <= 0) continue;
    out.push({ name, createdAt, activityAt });
  }
  return out;
}

// ── Session lifecycle ────────────────────────────────────────────────────────

export interface EnsureOpts {
  /** Stable id used to name the tmux session. We'll prefix with `hermit-`. */
  sessionId: string;
  /** Working directory for the spawned claude. */
  cwd: string;
  /**
   * Pre-assign claude's transcript uuid. When set, `--session-id <uuid>` is
   * appended to claudeArgs so the JSONL filename is known up-front — avoids
   * the race when two ChatSessions spin up against the same agent dir in
   * parallel (both would otherwise see "the new jsonl" and pick the same one).
   */
  claudeSessionUuid?: string;
  /** Extra args to pass to `claude` (e.g. ['--model', 'opus']). */
  claudeArgs?: string[];
  /** Path to the claude binary. Defaults to `claude` on PATH. */
  claudeBin?: string;
  /** Pane dimensions. Default 200x50 — wide enough that claude doesn't truncate tool output. */
  width?: number;
  height?: number;
  /**
   * Extra environment variables for the pane, passed via `tmux new-session -e
   * K=V`. claude AND every subprocess it spawns (notably PreToolUse hooks)
   * inherit these — so the permission hook gets the dashboard URL + key without
   * them ever touching the command line. Values are passed as literal argv
   * entries (no shell), so no quoting is needed.
   */
  env?: Record<string, string>;
}

/**
 * Where `claude` actually is, rather than trusting PATH.
 *
 * The pane runs whatever string we hand tmux, and a bare `claude` is resolved against
 * the PATH the GATEWAY happens to have. That PATH is inherited from whoever started
 * it: a login shell during hands-on work, but launchd → pm2-resurrect after a reboot,
 * and launchd's PATH has no `~/.local/bin` — which is exactly where the native claude
 * installer puts it. The failure is silent and total: every pane dies the instant it
 * starts (command not found), tmux reports "session not found" on the next send, and
 * every message to that machine stops being deliverable. Cost 50 days of uptime to
 * hide, then surfaced the moment sway003 rebooted (2026-08-05).
 *
 * So look for the binary where it actually lives, and fall back to the bare name only
 * if none of the known locations exist (PATH may genuinely carry it elsewhere).
 * HERMIT_CLAUDE_BIN overrides everything for an unusual install.
 */
function resolveClaudeBin(): string {
  const override = process.env.HERMIT_CLAUDE_BIN;
  if (override && existsSync(override)) return override;
  const home = homedir();
  for (const p of [
    join(home, '.local', 'bin', 'claude'),   // native installer (the fleet's default)
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]) {
    if (existsSync(p)) return p;
  }
  return 'claude';
}

/**
 * Idempotent: returns the tmux session name. Pre-snapshots existing JSONL files
 * in the project dir so callers can later identify which file is THIS session's
 * transcript (see getClaudeSessionUuid).
 */
export function ensureSession(opts: EnsureOpts): { name: string; created: boolean; preExistingUuids: Set<string> } {
  const name = paneName(opts.sessionId);
  const projectDir = encodedProjectDir(opts.cwd);
  mkdirSync(projectDir, { recursive: true });
  const preExistingUuids = new Set(listJsonlUuids(projectDir));

  if (hasSession(name)) {
    return { name, created: false, preExistingUuids };
  }

  const claudeBin = opts.claudeBin ?? resolveClaudeBin();
  const extraArgs = [...(opts.claudeArgs ?? [])];
  if (opts.claudeSessionUuid) {
    extraArgs.push('--session-id', opts.claudeSessionUuid);
  }
  const claudeCmd = [claudeBin, ...extraArgs]
    .map((a) => shellQuote(a))
    .join(' ');

  // `-e K=V` per env entry — sets the pane's session environment, inherited by
  // claude and its hook subprocesses. Literal argv (no shell), so no quoting.
  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v != null && v !== '') envFlags.push('-e', `${k}=${v}`);
  }

  const r = tmux([
    'new-session', '-d',
    '-s', name,
    '-c', opts.cwd,
    '-x', String(opts.width ?? 200),
    '-y', String(opts.height ?? 50),
    ...envFlags,
    claudeCmd,
  ]);
  if (!r.ok) {
    throw new Error(`tmux new-session failed: ${r.stderr || 'exit ' + r.status}`);
  }
  // Exit 0 is not proof. `tmux new-session -d` returns 0 and creates NOTHING when the
  // caller's $TMUX points at a dead server — the exact shape of the 2026-08-05 sway003
  // outage, where the gateway "created" a pane for every message and delivered into
  // nothing. The env is scrubbed at gateway startup now, but a lie this quiet deserves
  // its own check: ask tmux whether the session is actually there.
  if (!hasSession(name)) {
    throw new Error(
      `tmux new-session reported success but ${name} does not exist ` +
        `(stale $TMUX pointing at a dead server does this — it is scrubbed in the gateway entrypoint)`,
    );
  }
  return { name, created: true, preExistingUuids };
}

/**
 * tmux packs a whole command into ONE imsg to its server (MAX_IMSGSIZE 16384), and
 * refuses anything bigger outright: `send-keys -l -- <huge>` dies with "command too
 * long" and the message never reaches the pane. Measured on tmux 3.6a: 16300 bytes of
 * text goes through, 16380 does not.
 *
 * 4 KiB per call keeps a wide margin for the rest of the argv, and costs a couple of
 * extra round-trips on the rare long paste. (Incident 2026-07-31: a 21 KB regulation
 * pasted into one 20.5 KB LINE, which was sent as a single send-keys — the chat sat on
 * "starting" with only a gateway error to show for it.)
 */
const SEND_CHUNK_BYTES = 4096;

/**
 * Split one line into send-keys-sized pieces, never mid-character: chunking by BYTES
 * would cut a UTF-8 sequence in half and put mojibake in the composer, and this text
 * is routinely Chinese (3 bytes/char). Pieces are typed into the same composer in
 * order, so the buffer ends up identical either way.
 *
 * Exported for the unit test — the size rule is the whole point of the function.
 */
export function chunkLiteral(line: string, maxBytes = SEND_CHUNK_BYTES): string[] {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return [line];
  const out: string[] = [];
  let buf = '';
  let bytes = 0;
  for (const ch of line) {
    // Iterating a string yields whole code points, so a surrogate pair stays intact.
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes && buf) {
      out.push(buf);
      buf = '';
      bytes = 0;
    }
    buf += ch;
    bytes += n;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Send a user message to the pane. Submits with Enter on the next line so
 * claude treats the buffer as a complete turn. Backslash-escapes any embedded
 * Enter via Alt+Enter so a multi-line paste doesn't accidentally submit early.
 */
/**
 * Is this pane sitting in a tmux MODE (copy-mode, view-mode) rather than passing
 * keys through to the program running in it?
 *
 * This is the state nothing in this driver used to ask about, and it is a trap with
 * teeth, because tmux swallows every key while it holds: `send-keys` returns success,
 * the keys go to tmux's own mode bindings, and the program never sees them. Verified
 * on tmux 3.x: with the pane in copy-mode, text typed earlier sits unsubmitted in the
 * program's input, a subsequent `send-keys Enter` is never read, and the pane stays in
 * the mode. Nothing on screen says so — the TUI is painted exactly as before.
 *
 * We put panes into this state OURSELVES: the browser terminal runs
 * `set-option -t <session> mouse on` before attaching (so the wheel scrolls tmux's
 * scrollback), and with mouse mode on ONE scroll of the wheel is copy-mode. So the
 * ordinary act of scrolling up to re-read what the agent said, then pressing Enter to
 * send the reply you already typed, silently eats the Enter and strands the message.
 *
 * Worse, it is indistinguishable from a corpse by every test diagnoseFailedSubmit
 * runs: the composer still holds our text, the transcript never grows, and two
 * keystroke probes get no reaction — all three links hold, and the verdict is to KILL
 * the process. A healthy claude in a scrolled-back pane must never be condemned for
 * tmux's mode.
 */
export function paneInMode(sessionId: string): boolean {
  const name = paneName(sessionId);
  if (!hasSession(name)) return false;
  const r = tmux(['display-message', '-p', '-t', `${name}.0`, '#{pane_in_mode}']);
  return r.ok && r.stdout.trim() === '1';
}

/**
 * Take a pane out of copy-mode so keys reach the program again. Returns true if it
 * actually had to (i.e. the pane WAS swallowing input), which is the signal callers
 * use to explain away a silence they would otherwise have to blame on the process.
 *
 * `-X cancel` is the mode-table command for "leave the mode", so it works whatever
 * mode and whatever mode-keys the user configured. Idempotent: on a pane that is in
 * no mode it is a no-op error we ignore, which is why the state is checked first.
 */
export function leaveCopyMode(sessionId: string): boolean {
  if (!paneInMode(sessionId)) return false;
  const name = paneName(sessionId);
  tmux(['send-keys', '-t', `${name}.0`, '-X', 'cancel']);
  return true;
}

export function sendKeys(sessionId: string, text: string): void {
  const name = paneName(sessionId);
  if (!hasSession(name)) throw new Error(`tmux session not found: ${name}`);

  // Never type into a mode — tmux would eat the whole message and report success.
  leaveCopyMode(sessionId);

  // Strategy:
  //   For each line of `text`, paste-buffer the line, then send Alt+Enter for
  //   in-message newline. After the last line, send a single Enter to submit.
  //   Using -l (literal) avoids tmux interpreting metakeys inside user text.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 0) {
      // One line can be far bigger than tmux will carry in a single command (a
      // pasted document is often one enormous paragraph), so send it in pieces.
      // `--` terminates option parsing so a piece starting with `-` (markdown
      // bullets, LaTeX, diffs) is sent as literal text, not mistaken for a flag.
      for (const piece of chunkLiteral(line)) {
        const r = tmux(['send-keys', '-t', `${name}.0`, '-l', '--', piece]);
        if (!r.ok) throw new Error(`tmux send-keys (literal) failed: ${r.stderr || 'exit ' + r.status}`);
      }
    }
    if (i < lines.length - 1) {
      // Mid-message line break: M-Enter ("Alt+Enter") inserts a newline in
      // claude's composer without submitting.
      const r = tmux(['send-keys', '-t', `${name}.0`, 'M-Enter']);
      if (!r.ok) throw new Error(`tmux send-keys (M-Enter) failed: ${r.stderr || 'exit ' + r.status}`);
    }
  }
  // Submit.
  const r = tmux(['send-keys', '-t', `${name}.0`, 'Enter']);
  if (!r.ok) throw new Error(`tmux send-keys (Enter) failed: ${r.stderr || 'exit ' + r.status}`);
}

// Read the composer's input line (`❯ …`). Tri-state so a FAILED capture is never
// mistaken for "empty": 'text' = still holds buffered (unsent) text, 'clear' =
// positively empty (submitted), 'unknown' = capture failed OR no composer line was
// visible this frame (a transient render). confirmSubmitted only concludes
// "submitted" on 'clear' — returning false here on a capture timeout used to
// silently strand a multi-line / image paste whose submit Enter got swallowed.
function composerStatus(name: string): 'text' | 'clear' | 'unknown' {
  const line = composerLine(name);
  if (line === null) return 'unknown';
  return line.length > 0 ? 'text' : 'clear';
}

// Claude Code draws widgets BELOW the composer that carry their own `❯` when they hold
// focus — currently the published-artifact chip:
//
//     ────────────────────────      ← composer box, top rule
//     ❯                             ← the real composer, EMPTY
//     ────────────────────────      ← bottom rule
//       ⏵⏵ bypass permissions on (shift+tab to cycle)
//     ❯ ⧉  cat-demo · Enter to open · x to dismiss     ← focus is HERE
//          https://claude.ai/code/artifact/…
//
// A bottom-up "last ❯ wins" scan reads that chip as the composer, and every conclusion
// downstream inverts: the composer is reported as permanently holding text, so
// confirmSubmitted never sees 'clear' and hammers ~160 Enters at a chip whose Enter
// binding is "open the artifact"; robustSubmit takes its buffered-text branch;
// probeInputPath diffs a line that cannot change no matter what is typed, so the pane
// can be neither cleared nor condemned and healDeafPane never runs. That is what
// silently ate two messages on 2026-08-19 after a /compact left the chip focused —
// the session stayed wedged with nothing but "likely unsent" in the log.
//
// So anchor on the BOX, not on the glyph: the composer is the region between the last
// two full-width `─` rules, and only a `❯` inside it is the composer's.
const RULE_RE = /^\s*─{8,}\s*$/;

// The artifact chip and its siblings, matched by the hints they document themselves
// with. Only used to skip them in the no-box fallback below (a permission prompt or
// the resume picker paints a `❯` with no composer box at all, and those must still be
// found) — the box path never needs it.
const OVERLAY_CHIP_RE = /⧉|\bEnter to open\b|\b(?:x|esc(?:ape)?) to dismiss\b|←\/→ to navigate/i;

/**
 * The composer's input line out of one captured frame, or null when the frame has no
 * composer in it. Pure over the pane's lines so the frames that broke it are locked in
 * a unit test rather than reproduced by hand against a live claude.
 */
export function pickComposerLine(paneLines: string[]): string | null {
  const rules: number[] = [];
  for (let i = 0; i < paneLines.length; i++) if (RULE_RE.test(paneLines[i])) rules.push(i);

  // The composer box: between the LAST two rules. Anything painted under the box —
  // mode line, artifact chip, whatever Claude Code adds next — is out of scope by
  // construction, focused or not.
  if (rules.length >= 2) {
    const [top, bottom] = [rules[rules.length - 2], rules[rules.length - 1]];
    for (let i = top + 1; i < bottom; i++) {
      const idx = paneLines[i].indexOf('❯');
      if (idx >= 0) return paneLines[i].slice(idx + 1).trim();
    }
  }

  // No box in this frame. Claude Code still paints a bare `❯` for the resume picker and
  // for permission prompts, and waitForReplReady / the picker driver depend on seeing
  // it, so keep the legacy bottom-up scan — minus the overlays, which are exactly the
  // lines that must never win it.
  for (let i = paneLines.length - 1; i >= 0; i--) {
    const idx = paneLines[i].indexOf('❯');
    if (idx < 0) continue;
    const text = paneLines[i].slice(idx + 1).trim();
    if (OVERLAY_CHIP_RE.test(text)) continue;
    return text;
  }
  return null;
}

/**
 * The line of the widget that has STOLEN focus from the composer, or null when the
 * composer has it. A `❯` painted below the composer box is Claude Code saying "the
 * cursor is down here, not in the input" — while it is, typed text never reaches the
 * composer at all (verified 2026-08-19: a 9-char burst sent to such a pane left the
 * composer empty; the same pane accepted a keystroke normally once the chip collapsed).
 */
export function pickFocusStealer(paneLines: string[]): string | null {
  const rules: number[] = [];
  for (let i = 0; i < paneLines.length; i++) if (RULE_RE.test(paneLines[i])) rules.push(i);
  if (rules.length < 2) return null; // no box → no "below the box" to speak of
  const bottom = rules[rules.length - 1];
  for (let i = paneLines.length - 1; i > bottom; i--) {
    const idx = paneLines[i].indexOf('❯');
    if (idx < 0) continue;
    const text = paneLines[i].slice(idx + 1).trim();
    return OVERLAY_CHIP_RE.test(text) ? text : null; // only a KNOWN overlay is dismissable
  }
  return null;
}

// One captured frame as lines, SGR stripped. null when the capture failed — never an
// empty frame, so "could not read" stays distinguishable from "read, saw nothing".
function capturePaneLines(name: string): string[] | null {
  const r = tmux(['capture-pane', '-t', `${name}.0`, '-p'], { timeoutMs: 2000 });
  if (!r.ok) return null;
  return r.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
}

// The composer's input line (`❯ …`) as TEXT: '' when it is positively empty, null when
// it could not be read at all. composerStatus is the tri-state view of this; the probe
// below needs the characters themselves, because "did this pane react to a keystroke"
// is a question about the content changing, not about empty-vs-not.
function composerLine(name: string): string | null {
  const lines = capturePaneLines(name);
  return lines === null ? null : pickComposerLine(lines);
}

/**
 * Make sure a sent message actually submitted. claude's Ink TUI drops the submit
 * Enter while it's still settling — most often right after a LONG turn, when the
 * pane reads "idle" (no "esc to interrupt" marker, so the deliver gate lets us
 * send) but claude is still rendering that turn's large output, so Enters are
 * swallowed. A multi-line paste (user text + a `Read <image>` line) makes it
 * likelier still. The text lands in the composer but never sends.
 *
 * We re-send Enter while the composer still shows buffered text, polling until it
 * clears. Idempotent: an Enter on an already-empty composer is a no-op, so extra
 * rounds never double-submit. The window must outlast a big-output render settle
 * (the old 0.8s gave up mid-render → the message sat unsent forever, since the
 * caller has already ack'd it and won't redeliver). Returns true once the composer
 * clears (submitted), false if it still holds text at the end — the caller surfaces
 * that so a stuck message is never silent. (Past incident 2026-06-03: a follow-up
 * sent right after an 8m turn sat in the composer, unsent.)
 */
export async function confirmSubmitted(sessionId: string, tries = 40, gapMs = 500): Promise<boolean> {
  const name = paneName(sessionId);
  if (!hasSession(name)) return true;
  for (let i = 0; i < tries; i++) {
    await sleep(gapMs);
    if (composerStatus(name) === 'clear') return true; // POSITIVELY empty → submitted
    // A scroll of the wheel between our send and this poll puts the pane in copy-mode,
    // where every Enter below would be eaten by tmux instead of submitting. Re-checked
    // each round, not just once: the person reading the pane can scroll at any moment.
    leaveCopyMode(sessionId);
    // 'text' (still buffered) or 'unknown' (capture failed / composer not seen this
    // frame) → re-send Enter and keep polling. We must NOT treat a failed capture as
    // "cleared": that's exactly what stranded image / multi-line pastes — the
    // settle-render capture timed out, we reported success, and the message sat
    // unsent with no warning (the user had to press Enter in the pane themselves).
    tmux(['send-keys', '-t', `${name}.0`, 'Enter']);
  }
  return composerStatus(name) === 'clear';
}

/** Public read of a pane's composer state (tri-state; see composerStatus). */
export function readComposer(sessionId: string): 'text' | 'clear' | 'unknown' {
  return composerStatus(paneName(sessionId));
}

/**
 * The text currently stranded in a pane's composer, or null if it can't be read.
 *
 * Text sitting here has been TYPED but never submitted, so it exists in exactly one
 * place on the machine — this pane's screen. It is in no transcript, no DB row, no
 * log. Read it before killing a pane so the message can be re-sent (or at minimum
 * quoted back to the user) instead of dying with the process.
 */
export function readComposerText(sessionId: string): string | null {
  return composerLine(paneName(sessionId));
}

/** See dismissFocusStealer. */
export type DismissOutcome = 'none' | 'dismissed' | 'stuck';

/**
 * Hand focus back to the composer if a widget below it has taken it.
 *
 * A focused artifact chip swallows everything typed at the pane, so a message sent
 * into one is not delayed — it is gone, and the pane looks perfectly healthy while it
 * happens. The old code's answer was to press Enter until the composer cleared, which
 * against this chip is the worst possible key: Enter is its "open the artifact"
 * binding, so ~160 of them changed nothing and the session stayed wedged until the
 * chip's own timer collapsed it ~25 minutes later (2026-08-19).
 *
 * The chip documents its own way out — `x to dismiss` — so use that, and only ever
 * against a line pickFocusStealer has positively identified as a known overlay.
 *
 * Net-zero on the buffer, like probeInputPath: if the dismissal does not take, the `x`
 * may have landed in the composer instead, and a stray character prepended to the
 * user's message is its own corruption — so it is backspaced away on the failing path.
 * Callers must run this BEFORE typing, so that undo can never eat real text.
 */
export async function dismissFocusStealer(
  sessionId: string,
  opts: { timeoutMs?: number; gapMs?: number } = {},
): Promise<DismissOutcome> {
  const name = paneName(sessionId);
  if (!hasSession(name)) return 'none';
  leaveCopyMode(sessionId); // the `x` below would be eaten by tmux's mode otherwise
  const before = capturePaneLines(name);
  if (!before || pickFocusStealer(before) === null) return 'none';

  tmux(['send-keys', '-t', `${name}.0`, '-l', '--', 'x']);
  const deadline = Date.now() + (opts.timeoutMs ?? 4_000);
  while (Date.now() < deadline) {
    await sleep(opts.gapMs ?? 250);
    const now = capturePaneLines(name);
    if (now && pickFocusStealer(now) === null) return 'dismissed';
  }
  tmux(['send-keys', '-t', `${name}.0`, 'BSpace']); // the x may have gone into the composer
  return 'stuck';
}

/** See probeInputPath. */
export type InputPathVerdict = 'alive' | 'deaf' | 'inconclusive';

/**
 * Ask a pane whether anything is still READING its stdin.
 *
 * Every other health check in this driver answers a different question: hasSession
 * says the pane exists, pane_pid says the process is up, capture-pane says the TUI is
 * painting. A claude can pass all three and still be unusable — the Ink render loop
 * keeps drawing while the stdin event loop has stopped, so keys land in the terminal
 * and are never consumed. The pane looks perfect and is deaf. That state cost a
 * ceo-session message permanently (2026-08-10): the text went into the composer, the
 * submit Enter was swallowed, no turn ever started, and because the message had never
 * been submitted it existed in no transcript — it could only be re-typed by the user.
 * The pane then sat "healthy" for 24h.
 *
 * The only way to answer the question is to press a key and look for a reaction, so:
 * type one marker character and watch for it on screen. A pane that is reading stdin
 * shows it within a frame; a deaf one never changes.
 *
 * The probe is NET-ZERO on the buffer, which matters because a wrong 'alive' must not
 * damage the message: it types PROBE_CHAR and then always sends BSpace, in every
 * outcome and every ordering. If the pane is deaf, neither key ever lands. If it is
 * alive, the character appears and is deleted again. If it was merely slow and the
 * marker arrives after we gave up, the trailing BSpace still removes it. (Deleting
 * first instead — backspace, look for a shorter line — would be simpler, but it eats a
 * real character of the user's text on every healthy pane it misjudges.)
 *
 * Three refusals, because a false 'deaf' costs a process:
 *  - the pane must not be in a tmux MODE. copy-mode reproduces a corpse EXACTLY —
 *    tmux eats every key, so the composer keeps our text, the transcript never grows,
 *    and no probe ever gets a reaction — and one scroll of the wheel is all it takes
 *    to get there (see paneInMode). We leave the mode and decline to judge this
 *    round; the caller's next attempt meets a pane that can hear again;
 *  - the composer must be readable and non-empty; on an empty one the marker is
 *    indistinguishable from a stray keystroke landing → 'inconclusive';
 *  - with `expectText`, the composer must actually be holding THAT message. This is
 *    the guard against condemning a healthy pane that is merely BLOCKED: a permission
 *    prompt and the resume picker both paint a `❯`, and a menu ignores a typed
 *    character much the way a corpse does. If the line isn't our stranded text, we
 *    decline to judge rather than guess.
 *
 * 'inconclusive' is never grounds to kill anything — only 'deaf' is.
 */
const PROBE_CHAR = '.';

export async function probeInputPath(
  sessionId: string,
  opts: { expectText?: string; timeoutMs?: number; gapMs?: number } = {},
): Promise<InputPathVerdict> {
  const name = paneName(sessionId);
  if (!hasSession(name)) return 'inconclusive';

  // tmux, not the process, is eating the keys. Fix that and let the caller retry —
  // condemning here would kill a healthy claude because someone scrolled the pane.
  if (leaveCopyMode(sessionId)) return 'inconclusive';

  const before = composerLine(name);
  if (!before) return 'inconclusive'; // null (unreadable) or '' (empty — nothing to compare against)

  if (opts.expectText) {
    // Compare on the TAIL: the composer renders on one line, so a long message is
    // elided, and Chinese text plus the box drawing make an exact match hopeless. The
    // last few characters are what survives on screen, and they are enough to tell our
    // own stranded message from a menu.
    const tail = opts.expectText.trim().slice(-12);
    if (tail && !before.includes(tail)) return 'inconclusive';
  }

  try {
    // `--` so the marker is never parsed as a flag.
    tmux(['send-keys', '-t', `${name}.0`, '-l', '--', PROBE_CHAR]);
    const deadline = Date.now() + (opts.timeoutMs ?? 4_000);
    while (Date.now() < deadline) {
      await sleep(opts.gapMs ?? 250);
      const now = composerLine(name);
      if (now !== null && now !== before) return 'alive'; // it consumed the keystroke
    }
    // Unchanged for the whole window. One last read, so a single failed capture inside
    // the loop is not what decides a pane's fate.
    return composerLine(name) === before ? 'deaf' : 'alive';
  } finally {
    // Undo the marker on EVERY path — including 'deaf', where it is a no-op now but
    // cleans up if the pane was only slow and the marker lands later.
    tmux(['send-keys', '-t', `${name}.0`, 'BSpace']);
  }
}

/**
 * Kill a pane WITHOUT going through its stdin, and confirm it is gone.
 *
 * `kill()` above types `/exit` and waits — which is worthless against the case this
 * exists for. A claude whose input path is dead never reads the command, so the
 * graceful path burns its grace period every time and only the fallback does any
 * work. Signals don't travel through stdin, so SIGTERM lands on a deaf process just
 * as it does on a healthy one (verified during the 2026-08-10 recovery).
 *
 * SIGTERM first so claude tears down its own children (notably the mcp-stub) rather
 * than orphaning them, SIGKILL if it won't go, then kill-session to reclaim the tmux
 * session itself. Returns true once the session is gone.
 *
 * Losing the process does NOT lose the conversation: the transcript is on disk, and
 * the next setupSession spawns with `--resume <uuid>` onto the same history.
 */
export async function hardKill(sessionId: string, graceMs = 5_000): Promise<boolean> {
  const name = paneName(sessionId);
  if (!hasSession(name)) return true;

  const r = tmux(['display-message', '-p', '-t', `${name}.0`, '#{pane_pid}']);
  const pid = Number(r.stdout);
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!hasSession(name)) return true;
      await sleep(200);
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    await sleep(300);
  }
  if (hasSession(name)) tmux(['kill-session', '-t', name]);
  return !hasSession(name);
}

/**
 * Wait until the pane's REPL has rendered its composer prompt (the `❯` line is
 * visible) — i.e. claude is up and able to accept typed input. Typing BEFORE this
 * is the cold-start race that silently drops a session's first message: the keys
 * (and the submit Enter) land in a not-yet-ready Ink TUI and vanish, the composer
 * stays empty, and an empty composer otherwise reads as "submitted". Returns true
 * once the composer is readable, false on timeout / dead pane.
 */
export async function waitForReplReady(sessionId: string, timeoutMs = 45_000, gapMs = 500): Promise<boolean> {
  const name = paneName(sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!hasSession(name)) return false;
    if (composerStatus(name) !== 'unknown') return true; // ❯ visible → REPL ready
    await sleep(gapMs);
  }
  return composerStatus(name) !== 'unknown';
}

/**
 * `claude --resume` on a LARGE session blocks on an in-pane prompt before the
 * REPL loads (the header sentence has changed across Claude Code versions, the
 * numbered options have not):
 *     Resuming the full session will consume a substantial portion of your usage
 *     limits. We recommend resuming from a summary.
 *      ❯ 1. Resume from summary (recommended)
 *        2. Resume full session as-is
 *        3. Don't ask me again
 * It's painted in the tmux pane and never reaches the web chat, so the session
 * hangs forever (resolveResumedUuid waits on a transcript that never appears).
 * Watch the pane and auto-pick "Resume full session as-is" to keep the COMPLETE
 * history: step the ❯ cursor toward the full-session option (comparing option
 * numbers, so direction is right regardless of the default/order), Enter to
 * confirm; idempotent, so re-issuing each tick survives tmux dropping a key.
 *
 * Hardened (2026-07-21, after a miss on a loaded macmini): (1) watch for the
 * whole resume window (~240s, matching resolveResumedUuid) instead of 20s — a
 * slow-to-appear picker or dropped keys no longer time the watcher out early;
 * (2) detect by the stable option KEYWORDS, not the exact header/option text;
 * (3) locate the cursor on a numbered option line, not the first ❯ anywhere in
 * the pane; (4) exit early once the REPL is ready (small sessions don't spin the
 * full window); (5) log on detect / give-up so any future miss is captured.
 * Fire-and-forget: runs in the background alongside the resume.
 */
export async function acceptResumePromptAsFull(sessionId: string, timeoutMs = 240_000, gapMs = 500): Promise<boolean> {
  const name = paneName(sessionId);
  const deadline = Date.now() + timeoutMs;
  const optNum = (l: string | undefined): number => {
    const m = l?.match(/(\d+)\./);
    return m ? Number(m[1]) : NaN;
  };
  // A numbered menu line that is one of the resume-picker options.
  const isPickerOption = (l: string): boolean => /^\s*[❯>]?\s*\d+\.\s/.test(l) && /(resume from summary|resume full session|full session as-is)/i.test(l);
  let answered = false;
  let sawPrompt = false;
  while (Date.now() < deadline) {
    await sleep(gapMs);
    if (!hasSession(name)) return answered; // pane gone — nothing to answer
    const cap = tmux(['capture-pane', '-t', `${name}.0`, '-p'], { timeoutMs: 2_000 });
    if (!cap.ok) continue;
    const lines = cap.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    const summaryLine = lines.find((l) => /^\s*[❯>]?\s*\d+\./.test(l) && /resume from summary/i.test(l));
    const fullLine = lines.find((l) => /^\s*[❯>]?\s*\d+\./.test(l) && /full session/i.test(l));
    if (!(summaryLine && fullLine)) {
      // No picker on screen. If the REPL composer is ready, the resume is done
      // (dismissed / never needed) → stop watching. Otherwise it's still loading
      // (or the picker hasn't painted yet) → keep watching until the deadline.
      if (composerStatus(name) !== 'unknown') return answered;
      continue;
    }
    if (!sawPrompt) {
      sawPrompt = true;
      console.log(`[resume-prompt] ${sessionId.slice(0, 8)}: picker up — auto-selecting full session`);
    }
    // Cursor = the ❯-carrying numbered option line (not just the first ❯ in the
    // pane, which could be the composer). Step toward the full-session option.
    const cursorLine = lines.find((l) => l.includes('❯') && isPickerOption(l));
    if (cursorLine && /full session/i.test(cursorLine)) {
      tmux(['send-keys', '-t', `${name}.0`, 'Enter']); // cursor on full session → confirm
      answered = true;
    } else {
      const cur = optNum(cursorLine), full = optNum(fullLine);
      if (Number.isFinite(cur) && Number.isFinite(full) && cur !== full) {
        tmux(['send-keys', '-t', `${name}.0`, cur < full ? 'Down' : 'Up']);
      }
      // cursor not on a picker option this frame → re-read next tick
    }
  }
  if (sawPrompt && !answered) {
    console.error(`[resume-prompt] ${sessionId.slice(0, 8)}: gave up after ${Math.round(timeoutMs / 1000)}s — picker may still be up`);
  }
  return answered;
}

/** Send Escape to interrupt the in-flight turn (claude's cancel key). */
export function sendInterrupt(sessionId: string): void {
  const name = paneName(sessionId);
  if (!hasSession(name)) return;
  tmux(['send-keys', '-t', `${name}.0`, 'Escape']);
}

/**
 * Graceful shutdown. Tries `/exit` first; falls back to kill-session after
 * `graceMs`. Resolves once the session is gone (or never existed).
 */
export async function kill(sessionId: string, graceMs = 2_000): Promise<void> {
  const name = paneName(sessionId);
  if (!hasSession(name)) return;

  tmux(['send-keys', '-t', `${name}.0`, '-l', '--', '/exit']);
  tmux(['send-keys', '-t', `${name}.0`, 'Enter']);

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!hasSession(name)) return;
    await sleep(150);
  }
  tmux(['kill-session', '-t', name]);
}

// ── Claude session UUID lookup ───────────────────────────────────────────────

/**
 * Wait for claude to write a fresh JSONL transcript file. Returns its UUID
 * (the filename without `.jsonl`). Times out after `timeoutMs` and throws.
 *
 * Callers should pass the `preExistingUuids` set returned from ensureSession
 * so we ignore transcript files that were already there from prior sessions.
 */
export async function getClaudeSessionUuid(opts: {
  cwd: string;
  preExistingUuids: Set<string>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<string> {
  const projectDir = encodedProjectDir(opts.cwd);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(projectDir)) {
      const uuids = listJsonlUuids(projectDir);
      for (const uuid of uuids) {
        if (!opts.preExistingUuids.has(uuid)) {
          // Sanity: make sure the file is non-empty (claude has actually started
          // writing). Empty file = race with mkdir, not a real session yet.
          const stat = safeStat(join(projectDir, `${uuid}.jsonl`));
          if (stat && stat.size > 0) return uuid;
        }
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for claude transcript in ${projectDir}`);
}

/**
 * Wait for a specific JSONL path to exist and be non-empty. Use this when
 * the caller pre-assigned the uuid via `claudeSessionUuid` — no need to
 * scan for "new" files.
 */
export async function awaitTranscript(jsonlPath: string, timeoutMs = 30_000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = safeStat(jsonlPath);
    if (st && st.size > 0) return;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for transcript at ${jsonlPath}`);
}

/** Returns the encoded project directory under ~/.claude/projects/. */
export function encodedProjectDir(cwd: string): string {
  // Claude Code replaces every `/` with `-`. Leading `/` becomes leading `-`.
  const encoded = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded);
}

/** UUID list from .jsonl files in a project dir. */
function listJsonlUuids(projectDir: string): string[] {
  if (!existsSync(projectDir)) return [];
  return readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length));
}

/**
 * Every JSONL transcript in an agent's project dir, with size + mtime. Used to
 * detect + recover claude-session-uuid DRIFT: when a pane's claude was respawned
 * without `--session-id` and minted a uuid the gateway never recorded, the gateway
 * tails a `<recorded-uuid>.jsonl` that never appears. The caller finds the live
 * transcript here (newest non-empty, excluding uuids owned by sibling sessions that
 * share this project dir) and adopts it.
 */
export interface TranscriptInfo {
  uuid: string;
  size: number;
  mtimeMs: number;
}

export function listTranscripts(cwd: string): TranscriptInfo[] {
  const projectDir = encodedProjectDir(cwd);
  const out: TranscriptInfo[] = [];
  for (const uuid of listJsonlUuids(projectDir)) {
    const st = safeStat(join(projectDir, `${uuid}.jsonl`));
    if (st) out.push({ uuid, size: Number(st.size), mtimeMs: Number(st.mtimeMs) });
  }
  return out;
}

// Pick the newest "live" transcript for uuid-DRIFT adoption (see listTranscripts): the
// most-recently-written non-empty transcript whose uuid isn't excluded and whose mtime
// is within the caller's window. Pure over its inputs (the filesystem read + the clock
// live in resolveLiveTranscript) so the exclusion + bounds logic is unit-testable. Both
// drift-adopt sites (chat reattach, cron freshly-spawned) were open-coded copies of this
// same "newest unclaimed transcript" pick with different exclusion sources + time bounds:
//   • exclude    — uuids to skip: the recorded uuid itself + those owned by sibling chat
//                  sessions sharing the project dir (chat), or already-seen uuids (cron).
//   • minMtimeMs — lower bound: only transcripts written at/after this (cron pins the adopt
//                  to a transcript created around/after the run started). Omit for none.
//   • maxAgeMs   — upper bound: only transcripts newer than this age (chat bounds the size-0
//                  ambiguous case to FRESH_MS; omit for no bound, e.g. a pruned recorded uuid).
export function pickLiveTranscript(
  transcripts: TranscriptInfo[],
  opts: { exclude: Set<string>; minMtimeMs?: number; maxAgeMs?: number },
  now: number,
): TranscriptInfo | null {
  return transcripts
    .filter((t) =>
      t.size > 0 &&
      !opts.exclude.has(t.uuid) &&
      (opts.minMtimeMs == null || t.mtimeMs >= opts.minMtimeMs) &&
      (opts.maxAgeMs == null || now - t.mtimeMs < opts.maxAgeMs))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

// Read the project dir and pick the drift-adopt target — the entry point the cron
// freshly-spawned path uses. (The chat reattach path already holds a listTranscripts()
// result — it reuses it for the recorded-uuid lookup — so it calls pickLiveTranscript
// directly to avoid re-reading the dir.)
export function resolveLiveTranscript(
  cwd: string,
  opts: { exclude: Set<string>; minMtimeMs?: number; maxAgeMs?: number },
): TranscriptInfo | null {
  return pickLiveTranscript(listTranscripts(cwd), opts, Date.now());
}

// ── Transcript watcher ───────────────────────────────────────────────────────

export interface TranscriptEvent {
  type: string;
  uuid?: string;
  sessionId?: string;
  parentUuid?: string | null;
  message?: any;
  timestamp?: string;
  // Anything else from the JSONL line is passed through.
  [k: string]: any;
}

/**
 * Tail -F a JSONL transcript. Calls `onEvent` for each parsed line. Returns
 * a stop function. Survives file rotation (`-F` reopens). Skips lines that
 * fail to JSON.parse — claude occasionally writes partial chunks during fsync.
 *
 * Dedup is up to the caller — we just stream lines. Most events have a `.uuid`
 * field; ChatMessage upsert by `externalId = uuid` keeps the row stable.
 */
export function watchTranscript(jsonlPath: string, onEvent: (ev: TranscriptEvent) => void): () => void {
  // -n +1 = start from the first line (we want history too, in case the
  //         watcher attaches after some events have been written).
  // -F    = follow by name, re-opening on rotation.
  const child = spawn('tail', ['-n', '+1', '-F', jsonlPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // partial line during write — `tail -F` will hand us the rest next tick
      }
    }
  });

  // We let tail's stderr drop on the floor; it occasionally complains about
  // "file truncated" mid-rotation, which is expected and harmless.
  child.stderr.on('data', () => {});

  return () => {
    try { child.kill('SIGTERM'); } catch {}
  };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function paneName(sessionId: string): string {
  // tmux session names allow alnum + . _ -. Take 12 chars of the id (cuids are
  // 25 chars, the suffix is the entropic part) to keep the name short but
  // collision-resistant.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-12);
  return `hermit-${safe}`;
}

function shellQuote(s: string): string {
  // Safe single-quote wrapping. tmux new-session's command string is run
  // through the user's $SHELL, so shell escaping is what matters.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try { return statSync(path); } catch { return null; }
}
