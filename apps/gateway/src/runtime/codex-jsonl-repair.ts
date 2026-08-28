// Undo the line-splitting bug in @openai/codex-sdk's JSONL reader.
//
// The SDK reads `codex exec --experimental-json` stdout with node's `readline`
// (`dist/index.js`: `readline.createInterface({ input: child.stdout })` — 0.147.0
// is what we run, and unpacking 0.150.1, the latest on 2026-08-29, shows the same
// call, so there is no version to upgrade to). readline breaks a line on U+2028
// and U+2029 as well as on LF/CR — and those two are perfectly legal RAW inside a
// JSON string, which is how codex's serializer emits them. So one separator
// anywhere in a turn's payload — a JS bundle read by a tool, scraped web text, a
// test fixture carrying the character on purpose — chops the record into
// fragments, the SDK's `JSON.parse` throws `Failed to parse item:`, and the WHOLE
// TURN dies with `[codex could not run this turn]`. Everything the model did that
// turn is lost. Measured 2026-08-28: `sed`-ing this repo's own
// runtime/jsonl-transport.test.ts (line 34 carried both characters) killed the
// same session twice.
//
// This module puts the fragments back together before the SDK parses them, so
// the turn survives. The same protocol rule, stated from the other side, is in
// `jsonl-transport.ts`: split on `\n` and nothing else.
//
// ONE thing cannot be recovered: readline eats the separator without saying
// which of the two it was, so a rejoined record carries U+2028 where the
// original may have had U+2029. Both are invisible line separators, and the
// alternative is losing the turn.

/**
 * Restored in place of the separator readline swallowed (see above).
 *
 * Built at runtime on purpose: writing the character literally would put the
 * very byte sequence this module exists to survive into a file that codex
 * sessions read.
 */
const REJOIN_SEPARATOR = String.fromCharCode(0x2028);

/** Held text past this is a runaway, not a split record. */
const DEFAULT_MAX_HELD_CHARS = 32 * 1024 * 1024;

const OPEN_BRACE = 0x7b;

export type RejoinOptions = {
  /** Where a dropped record is reported. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** Overridable so a test can reach the give-up branch without 32 MB of input. */
  maxHeldChars?: number;
};

/**
 * How far into a JSON value the text scanned so far reaches.
 *
 * The point of tracking this incrementally is cost. Re-running `JSON.parse` on
 * the whole accumulated record after every fragment is quadratic, and the input
 * that triggers this module — a payload dense in separators, i.e. a minified JS
 * bundle — is exactly the input that makes it worst: measured 1.9s of blocked
 * event loop for a 2 MB record with 2000 separators, and the gateway runs every
 * session on that one thread. Scanning only the NEW text keeps it linear, and
 * `JSON.parse` runs once, when the braces actually balance.
 */
type Scan = {
  depth: number;
  inString: boolean;
  escaped: boolean;
  /** An object or array has been opened, so depth 0 now means "closed". */
  opened: boolean;
  /** A closing bracket with nothing open: this can never become one record. */
  broken: boolean;
};

const freshScan = (): Scan => ({ depth: 0, inString: false, escaped: false, opened: false, broken: false });

function advance(state: Scan, text: string): Scan {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (state.inString) {
      if (state.escaped) state.escaped = false;
      else if (c === 0x5c) state.escaped = true; // backslash
      else if (c === 0x22) state.inString = false; // quote
      continue;
    }
    if (c === 0x22) state.inString = true;
    else if (c === OPEN_BRACE || c === 0x5b) { state.depth += 1; state.opened = true; }
    else if (c === 0x7d || c === 0x5d) {
      state.depth -= 1;
      if (state.depth < 0) { state.broken = true; return state; }
    }
  }
  return state;
}

/** Structurally complete: every bracket closed and no string left open. */
const isClosed = (state: Scan): boolean => state.opened && state.depth === 0 && !state.inString && !state.broken;

/** The parsed record, or null if the text is not one JSON object. */
function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Yield whole JSON records from a line source that may have split some of them.
 *
 * A line that is already a complete record passes straight through. One that
 * opens a record without closing it is held, and each following line is appended
 * (separator restored) until the brackets balance.
 *
 * Three things are dropped with a warning rather than handed on, because handing
 * unparseable text to the SDK is what kills the turn — the failure this module
 * exists to remove:
 *   - a line that cannot even begin a record (does not open with `{`), including
 *     the blank lines that `JSON.parse('')` would die on;
 *   - a held record that closes but does not parse, or that goes structurally
 *     impossible;
 *   - a held record past `maxHeldChars`.
 * A hold cannot swallow the records after it: a line that is itself a complete
 * codex event ends the hold and is delivered.
 *
 * The one case that still fails the turn is a stream that ENDS mid-record. That
 * throws, because the alternative is worse: the SDK returns normally, codex-exec
 * never reports a failure, and a truncated turn is indistinguishable in the chat
 * from a finished one.
 */
export async function* rejoinSplitRecords(
  source: AsyncIterable<string>,
  opts: RejoinOptions = {},
): AsyncGenerator<string> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const maxHeldChars = opts.maxHeldChars ?? DEFAULT_MAX_HELD_CHARS;
  let held: string | null = null;
  let state = freshScan();

  for await (const line of source) {
    if (held !== null) {
      const joined: string = `${held}${REJOIN_SEPARATOR}${line}`;
      advance(state, `${REJOIN_SEPARATOR}${line}`);

      if (isClosed(state)) {
        held = null;
        if (parseRecord(joined)) yield joined;
        else warn(`[codex] dropping a ${joined.length}-char record that closed but does not parse`);
        continue;
      }

      // A line that is a whole event on its own means the hold was never going
      // to complete — deliver the event rather than swallowing it and every
      // record after it. `type` is what makes it unmistakable: a fragment from
      // the MIDDLE of a record begins inside a JSON string, where every quote is
      // escaped, so it cannot parse as an object at all.
      const standalone = line.charCodeAt(0) === OPEN_BRACE && isClosed(advance(freshScan(), line))
        ? parseRecord(line)
        : null;
      if (standalone && typeof standalone.type === 'string') {
        warn(`[codex] dropping ${held.length} chars of unparseable event data`);
        held = null;
        state = freshScan();
        yield line;
        continue;
      }

      if (state.broken || joined.length > maxHeldChars) {
        warn(`[codex] dropping an unusable record after ${joined.length} chars`);
        held = null;
        state = freshScan();
        continue;
      }
      held = joined;
      continue;
    }

    // Every codex record is a JSON object, so anything else is framing noise or
    // a stray diagnostic. Forwarding it is what `Failed to parse item:` is made
    // of — a blank line alone is enough — and holding it would swallow the
    // records behind it.
    if (line.charCodeAt(0) !== OPEN_BRACE) {
      if (line.trim()) warn(`[codex] ignoring a ${line.length}-char line that is not a JSON record`);
      continue;
    }

    state = advance(freshScan(), line);
    if (!isClosed(state)) {
      if (state.broken) warn(`[codex] ignoring a ${line.length}-char line that cannot be a record`);
      else held = line;
      continue;
    }
    if (parseRecord(line)) yield line;
    else warn(`[codex] dropping a ${line.length}-char line that closed but does not parse`);
  }

  if (held !== null) {
    throw new Error(`codex event stream ended mid-record (${held.length} chars unparsed)`);
  }
}

/** The one private field of `Codex` this reaches into. */
type ExecLike = { run: (...args: never[]) => AsyncIterable<string> };

/** Marks an exec we already wrapped, so a second call cannot wrap the wrapper. */
const WRAPPED = Symbol.for('hermit.codex.jsonlRepair');

/**
 * Wrap a `Codex` instance's line reader in {@link rejoinSplitRecords}.
 *
 * The SDK exposes no hook — `Codex.exec` is `private` in the .d.ts and the
 * readline lives inside `CodexExec.run` — so this patches the instance we just
 * built, which is ours alone and never shared. If a future SDK reshapes that
 * field the wrap is skipped and the backend behaves exactly as it does today;
 * a version that reads lines correctly makes this a no-op, since a record that
 * arrives whole passes straight through. Returns whether the wrap landed, which
 * is what the tests assert on — false means already wrapped, or a shape we do
 * not recognise.
 */
export function installJsonlRepair(codex: object, warn?: (message: string) => void): boolean {
  const exec = (codex as { exec?: unknown }).exec;
  if (!exec || typeof exec !== 'object') return false;
  const holder = exec as Partial<ExecLike> & { [WRAPPED]?: true };
  if (typeof holder.run !== 'function' || holder[WRAPPED]) return false;

  const original = holder.run.bind(exec) as ExecLike['run'];
  holder.run = (...args) => rejoinSplitRecords(original(...args), { warn });
  holder[WRAPPED] = true;
  return true;
}
