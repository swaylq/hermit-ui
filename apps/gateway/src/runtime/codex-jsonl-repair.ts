// Undo the line-splitting bug in @openai/codex-sdk's JSONL reader.
//
// The SDK reads `codex exec --experimental-json` stdout with node's `readline`
// (`dist/index.js`: `readline.createInterface({ input: child.stdout })`, still
// there in 0.150.1). readline breaks a line on U+2028 and U+2029 as well as on
// LF/CR — and those two are perfectly legal RAW inside a JSON string, which is
// how codex's serializer emits them. So one separator anywhere in a turn's
// payload — a JS bundle read by a tool, scraped web text, a test fixture that
// carries the character on purpose — chops the record into fragments, the SDK's
// `JSON.parse` throws `Failed to parse item:`, and the WHOLE TURN dies with
// `[codex could not run this turn]`. Everything the model did that turn is lost.
// Measured 2026-08-28: `sed`-ing this repo's own runtime/jsonl-transport.test.ts
// (line 34 carried both characters) killed the same session twice.
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

/**
 * Held text this long is a runaway, not a split record. Same ceiling
 * `jsonl-transport.ts` puts on a single frame.
 */
const MAX_REJOIN_CHARS = 32 * 1024 * 1024;

/**
 * The parsed record, if this line is a whole one.
 *
 * Every codex JSONL record is a JSON object, so a line that does not open with
 * `{` cannot be one — that check keeps the fragment path off `JSON.parse`,
 * leaving one extra parse per whole record (the SDK parses it again) and none
 * per fragment.
 */
function parseRecord(line: string): Record<string, unknown> | null {
  if (line.charCodeAt(0) !== 0x7b) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A line that is not just parseable but unmistakably the START of a new record,
 * used to give up on a hold instead of eating the rest of the turn.
 *
 * The `type` discriminator is what makes it unmistakable: every codex event
 * carries one, and a MIDDLE fragment of a split record — which begins inside a
 * JSON string — cannot both parse as an object and carry one.
 */
function startsNewRecord(line: string): boolean {
  return typeof parseRecord(line)?.type === 'string';
}

/**
 * Yield whole JSON records from a line source that may have split some of them.
 *
 * A line that parses on its own passes straight through — the common case. A
 * line that does not is held, and each following line is appended (separator
 * restored) until the joined text parses.
 *
 * A hold that never parses is dropped rather than yielded, on the same reasoning
 * `jsonl-transport.ts` drops an oversized frame: a record nobody can parse is
 * unusable either way, and handing it on kills the turn — the exact failure this
 * module exists to remove. A real child failure still surfaces, because the SDK
 * checks the exit code after the stream ends. Three ways to reach the drop: the
 * next line is plainly a new record, the held text passes MAX_REJOIN_CHARS, or
 * the source ends mid-record.
 */
export async function* rejoinSplitRecords(
  source: AsyncIterable<string>,
  warn: (message: string) => void = (m) => console.warn(m),
): AsyncGenerator<string> {
  let held: string | null = null;

  for await (const line of source) {
    if (held !== null) {
      // Annotated because `held` is later assigned from it, and a yield in the
      // loop is enough to make the inference circular (TS7022).
      const joined: string = `${held}${REJOIN_SEPARATOR}${line}`;
      if (parseRecord(joined)) {
        held = null;
        yield joined;
        continue;
      }
      if (startsNewRecord(line)) {
        // Whatever was held was never going to complete — a new record has
        // begun. Drop it and let this line be handled as a fresh one below.
        warn(`[codex] dropping ${held.length} chars of unparseable event data`);
        held = null;
      } else if (joined.length > MAX_REJOIN_CHARS) {
        warn(`[codex] dropping an unparseable record after ${joined.length} chars`);
        held = null;
      } else {
        held = joined;
        continue;
      }
    }

    // A blank line is framing noise, never a truncated record: holding one would
    // glue the next two good records together.
    if (!line.trim() || parseRecord(line)) yield line;
    else held = line;
  }

  if (held !== null) {
    warn(`[codex] the event stream ended mid-record; dropping ${held.length} chars`);
  }
}

/** The one private field of `Codex` this reaches into. */
type ExecLike = { run: (...args: never[]) => AsyncIterable<string> };

/**
 * Wrap a `Codex` instance's line reader in {@link rejoinSplitRecords}.
 *
 * The SDK exposes no hook — `Codex.exec` is `private` in the .d.ts and the
 * readline lives inside `CodexExec.run` — so this patches the instance we just
 * built, which is ours alone and never shared. If a future SDK reshapes that
 * field the wrap is skipped and the backend behaves exactly as it does today;
 * a version that reads lines correctly makes this a no-op, since a record that
 * arrives whole passes straight through. Returns whether the wrap landed, which
 * is what the test asserts on.
 */
export function installJsonlRepair(codex: object): boolean {
  const exec = (codex as { exec?: unknown }).exec;
  if (!exec || typeof exec !== 'object') return false;
  const holder = exec as Partial<ExecLike>;
  if (typeof holder.run !== 'function') return false;

  const original = holder.run.bind(exec) as ExecLike['run'];
  holder.run = (...args) => rejoinSplitRecords(original(...args));
  return true;
}
