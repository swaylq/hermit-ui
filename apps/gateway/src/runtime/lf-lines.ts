// Split a child's JSONL stream on LF and nothing else.
//
// Node's `readline` is the obvious tool and the wrong one: it breaks a line on
// U+2028 and U+2029 as well as on LF and CR (those four and no others — scanned
// every BMP code point on node 26). Both are perfectly legal RAW inside a JSON
// string, and they turn up in real payloads —
// scraped web text, a JS bundle echoed into a tool result. readline chops such
// a record into halves that neither parse, so a backend built on it drops the
// event without a word. Both pi and prime say so outright: "Do not use generic
// line readers that treat Unicode separators as newlines."
//
// One reader, used by every JSONL backend here (kimi's stdout, dsh's fd 3,
// JsonlTransport's stdio). The codex backend cannot use it — the SDK owns its
// child — and pays for that in `codex-jsonl-repair.ts`.

import { StringDecoder } from 'node:string_decoder';

export type LfLineOptions = {
  /**
   * A single line longer than this is a runaway, not a record: it is dropped
   * (and reported) rather than buffered until the process dies.
   */
  maxLineChars?: number;
  /** Called when a runaway line is dropped. */
  onOversize?: (chars: number) => void;
};

const DEFAULT_MAX_LINE_CHARS = 32 * 1024 * 1024;

/**
 * Call `onLine` once per LF-terminated line, plus once for a non-empty tail if
 * the stream ends without one (readline parity: a child that dies mid-write
 * still gets its last complete record delivered).
 *
 * A trailing CR is stripped, so CRLF input reads the same as LF input — the
 * framing itself stays LF-only, which is what the protocol says.
 */
export function readLfLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  opts: LfLineOptions = {},
): void {
  const maxLineChars = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const decoder = new StringDecoder('utf8');
  let parts: string[] = [];
  let length = 0;
  let discarding = false;

  const emit = (line: string): void => {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  };

  stream.on('data', (buf: Buffer | string) => {
    // A stream someone called `setEncoding` on hands over strings; a raw child
    // pipe hands over Buffers, which must go through the decoder so a multi-byte
    // character split across two reads is not mangled.
    const chunk = typeof buf === 'string' ? buf : decoder.write(buf);
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf('\n', from);
      if (nl === -1) break;
      if (discarding) {
        discarding = false;
      } else {
        parts.push(chunk.slice(from, nl));
        emit(parts.join(''));
      }
      parts = [];
      length = 0;
      from = nl + 1;
    }
    const rest = chunk.slice(from);
    if (!rest) return;
    length += rest.length;
    if (length > maxLineChars) {
      opts.onOversize?.(length);
      parts = [];
      length = 0;
      discarding = true;
    } else if (!discarding) {
      parts.push(rest);
    }
  });

  stream.on('end', () => {
    // A discarded runaway has no tail worth delivering.
    if (discarding) return;
    const tail = parts.join('') + decoder.end();
    parts = [];
    length = 0;
    if (tail) emit(tail);
  });
}
