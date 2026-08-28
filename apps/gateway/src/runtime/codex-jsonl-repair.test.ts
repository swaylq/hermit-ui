import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { Codex } from '@openai/codex-sdk';
import { rejoinSplitRecords, installJsonlRepair } from './codex-jsonl-repair';

// Built, never typed literally: a literal here would put the byte sequence this
// module exists to survive into a file that codex sessions read.
const LS = String.fromCharCode(0x2028); // U+2028 LINE SEPARATOR
const PS = String.fromCharCode(0x2029); // U+2029 PARAGRAPH SEPARATOR

const silent = { warn: () => {} };

async function* lines(...items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item;
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of source) out.push(line);
  return out;
}

/** What the SDK's reader does to one record, so the fixtures are not guesses. */
async function readlineSplit(record: string): Promise<string[]> {
  const rl = readline.createInterface({
    input: Readable.from([`${record}\n`]),
    crlfDelay: Infinity,
  });
  return collect(rl);
}

test('the upstream reader really does split a legal JSON record — the reason this file exists', async () => {
  const record = JSON.stringify({ type: 'item.completed', item: { text: `a${LS}b` } });
  assert.doesNotThrow(() => JSON.parse(record), 'a raw U+2028 inside a JSON string is legal JSON');

  const split = await readlineSplit(record);
  assert.equal(split.length, 2, 'readline broke one record in two — delete this wrapper when it stops');
  for (const half of split) assert.throws(() => JSON.parse(half), 'and neither half parses');
});

test('a record split on U+2028 is put back together', async () => {
  const record = JSON.stringify({ type: 'item.completed', item: { text: `before${LS}after` } });
  const out = await collect(rejoinSplitRecords(lines(...await readlineSplit(record)), silent));

  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0]), JSON.parse(record), 'byte-for-byte, separator included');
});

test('a record split several times, on both separators, is put back together', async () => {
  const text = `one${LS}two${PS}three${LS}four`;
  const record = JSON.stringify({ type: 'item.completed', item: { text } });
  const fragments = await readlineSplit(record);
  assert.equal(fragments.length, 4, 'three separators, four fragments');

  const out = await collect(rejoinSplitRecords(lines(...fragments), silent));
  assert.equal(out.length, 1);
  const parsed = JSON.parse(out[0]) as { item: { text: string } };
  assert.equal(
    parsed.item.text.replace(new RegExp(LS, 'g'), '|'),
    'one|two|three|four',
    'every separator position is restored; U+2029 comes back as U+2028, which readline made unknowable',
  );
});

test('whole records pass straight through, in order', async () => {
  const a = JSON.stringify({ type: 'thread.started', thread_id: 't1' });
  const b = JSON.stringify({ type: 'item.completed', item: { text: 'plain' } });
  assert.deepEqual(await collect(rejoinSplitRecords(lines(a, b), silent)), [a, b]);
});

test('a blank line is dropped, never forwarded', async () => {
  const a = JSON.stringify({ type: 'thread.started', thread_id: 't1' });
  // `JSON.parse('')` throws, and the SDK parses every line it is handed — so
  // passing a blank line on is itself a `Failed to parse item:` turn death.
  assert.deepEqual(await collect(rejoinSplitRecords(lines(a, '', '   ', a), silent)), [a, a]);
});

test('a split record between two whole ones does not swallow its neighbours', async () => {
  const first = JSON.stringify({ type: 'thread.started', thread_id: 't1' });
  const split = JSON.stringify({ type: 'item.completed', item: { text: `x${LS}y` } });
  const last = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } });

  const out = await collect(rejoinSplitRecords(
    lines(first, ...await readlineSplit(split), last),
    silent,
  ));
  assert.deepEqual(out, [first, split, last]);
});

test('a stray non-JSON line is dropped where it stands, and the split record behind it survives', async () => {
  const split = JSON.stringify({ type: 'item.completed', item: { text: `x${LS}y` } });
  const warnings: string[] = [];
  const out = await collect(rejoinSplitRecords(
    lines('{ stray log noise', ...await readlineSplit(split)),
    { warn: (m) => warnings.push(m) },
  ));

  assert.deepEqual(out, [split], 'holding the noise would have eaten the record behind it');
  assert.equal(warnings.length, 1, 'and the drop is logged, not silent');
});

test('a hold that can never complete gives up at the next real event instead of eating it', async () => {
  const good = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } });
  const warnings: string[] = [];
  const out = await collect(rejoinSplitRecords(lines('{"truncated', good), { warn: (m) => warnings.push(m) }));

  assert.deepEqual(out, [good], 'one bad line must not eat the rest of the turn');
  assert.match(warnings[0], /an event may be lost/, 'and the log says an event may have gone with it');
});

test('a held record past the ceiling is dropped, and the stream resyncs on the next event', async () => {
  const good = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } });
  const warnings: string[] = [];
  const out = await collect(rejoinSplitRecords(
    lines('{"a":"open', 'still open', 'still open', good),
    { warn: (m) => warnings.push(m), maxHeldChars: 20 },
  ));

  assert.deepEqual(out, [good]);
  assert.match(warnings[0], /never completed a record/);
});

// ── the scanner: braces, quotes and backslashes INSIDE the payload ───────────
// Plain-letter fixtures cannot tell a working scanner from a broken one. These
// carry the characters the scanner exists to interpret, so dropping the string
// tracking or the escape tracking in `advance()` loses the record and fails here.

test('a payload full of JSON-looking text is rejoined, not miscounted', async () => {
  const text = `json {"a":[1,2]} then }}} then \\" then${LS}the rest [ { " \\\\`;
  const record = JSON.stringify({ type: 'item.completed', item: { id: 'i', text } });
  const after = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } });

  const out = await collect(rejoinSplitRecords(lines(...await readlineSplit(record), after), silent));
  assert.deepEqual(out, [record, after]);
  assert.equal((JSON.parse(out[0]) as { item: { text: string } }).item.text, text);
});

test('a separator directly after an escaped quote does not desynchronise the scanner', async () => {
  const text = `he said \\"stop\\"${LS}and \\\\${LS}{ unbalanced`;
  const record = JSON.stringify({ type: 'item.completed', item: { text } });
  const fragments = await readlineSplit(record);
  assert.equal(fragments.length, 3);

  assert.deepEqual(await collect(rejoinSplitRecords(lines(...fragments), silent)), [record]);
});

test('a record whose payload is itself whole codex JSONL survives', async () => {
  const inner = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7 } });
  const record = JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', aggregated_output: `${inner}\n${inner}${LS}tail` },
  });

  assert.deepEqual(await collect(rejoinSplitRecords(lines(...await readlineSplit(record)), silent)), [record]);
});

test('a line that closes but does not parse is dropped, and the next record still lands', async () => {
  const good = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } });
  const warnings: string[] = [];
  // A trailing comma: the braces balance, so only the parse can reject it. Handing
  // it to the SDK is `Failed to parse item:` — the very death this module removes.
  const out = await collect(rejoinSplitRecords(lines('{"type":"x",}', good), { warn: (m) => warnings.push(m) }));

  assert.deepEqual(out, [good]);
  assert.match(warnings[0], /closed but does not parse/);
});

test('a rejoined record that closes but does not parse is dropped, not handed on', async () => {
  const warnings: string[] = [];
  const out = await collect(rejoinSplitRecords(
    lines('{"type":"x","t":"a', 'b",}'),
    { warn: (m) => warnings.push(m) },
  ));

  assert.deepEqual(out, []);
  assert.match(warnings[0], /record that closed but does not parse/);
});

test('a line with more closing braces than opening ones is dropped where it stands', async () => {
  const good = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } });
  const warnings: string[] = [];
  const out = await collect(rejoinSplitRecords(lines('{"a":1}}', good), { warn: (m) => warnings.push(m) }));

  assert.deepEqual(out, [good]);
  assert.match(warnings[0], /cannot be a record/);
});

test('blank lines are dropped in silence — they are framing, not a fault', async () => {
  const good = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } });
  const warnings: string[] = [];
  const out = await collect(rejoinSplitRecords(lines('', '  ', good), { warn: (m) => warnings.push(m) }));

  assert.deepEqual(out, [good]);
  assert.deepEqual(warnings, [], 'a warning per blank line would bury the ones that matter');
});

test('a fragment that happens to parse on its own is still treated as a fragment', async () => {
  // An empty object between two separators: the middle fragment parses as an
  // object, so only the `type` discriminator tells it apart from a new record.
  // (Anything richer cannot even get this far — a quote inside the record is
  // escaped, so `{\"b\":2}` is not valid JSON standalone.)
  const record = JSON.stringify({ type: 'item.completed', item: { text: `a${LS}{}${LS}c` } });
  const fragments = await readlineSplit(record);
  assert.equal(fragments.length, 3);
  assert.deepEqual(JSON.parse(fragments[1]), {}, 'the middle fragment is valid JSON on its own');

  assert.deepEqual(await collect(rejoinSplitRecords(lines(...fragments), silent)), [record]);
});

test('a stream that ends mid-record fails loudly instead of truncating the turn silently', async () => {
  const [head] = await readlineSplit(
    JSON.stringify({ type: 'item.completed', item: { text: `head${LS}tail` } }),
  );
  await assert.rejects(
    () => collect(rejoinSplitRecords(lines(head), silent)),
    /ended mid-record/,
    'a silent return here is indistinguishable, in the chat, from a finished turn',
  );
});

test('rejoining a separator-dense record stays linear', async () => {
  // The input this module exists for — a minified bundle — is also the one that
  // punishes re-parsing the whole accumulated record per fragment: that costs
  // ~1.9s of blocked event loop here, on the gateway's only thread. Budget is
  // 30x the linear cost, so it fails on a regression, not on a busy machine.
  const chunk = 'x'.repeat(1000);
  const record = JSON.stringify({ type: 'item.completed', item: { text: Array(2000).fill(chunk).join(LS) } });
  const fragments = await readlineSplit(record);
  assert.equal(fragments.length, 2000);

  const started = Date.now();
  const out = await collect(rejoinSplitRecords(lines(...fragments), silent));
  const elapsed = Date.now() - started;

  assert.deepEqual(out, [record]);
  assert.ok(elapsed < 500, `rejoining 2000 fragments of a 2MB record took ${elapsed}ms`);
});

test('the wrap lands on a real Codex instance — an SDK that reshapes it fails here, not in production', () => {
  const codex = new Codex({});
  assert.equal(installJsonlRepair(codex), true, '@openai/codex-sdk no longer exposes exec.run as expected');
  assert.equal(installJsonlRepair(codex), false, 'and a second call must not wrap the wrapper');
});

test('an SDK whose shape we do not recognise is left alone', () => {
  assert.equal(installJsonlRepair({}), false);
  assert.equal(installJsonlRepair({ exec: {} }), false);
  assert.equal(installJsonlRepair({ exec: { run: 'not a function' } }), false);
});

test('the wrapped run repairs what the raw one would have broken, and reports drops to the caller', async () => {
  const record = JSON.stringify({ type: 'item.completed', item: { text: `left${LS}right` } });
  const warnings: string[] = [];
  const fake = {
    exec: {
      run: async function* (): AsyncGenerator<string> {
        yield 'stray diagnostic line';
        yield* await readlineSplit(record);
      },
    },
  };

  assert.equal(installJsonlRepair(fake, (m) => warnings.push(m)), true);
  assert.deepEqual(await collect(fake.exec.run()), [record]);
  assert.equal(warnings.length, 1, 'the drop must reach the caller’s logger, not a session-less console');
});

test('abandoning the stream still closes the source — an interrupt must reach the child', async () => {
  let cleanedUp = false;
  async function* source(): AsyncGenerator<string> {
    try {
      yield JSON.stringify({ type: 'item.started' });
      yield JSON.stringify({ type: 'item.completed' });
    } finally {
      // Where the SDK does `rl.close(); child.kill()`.
      cleanedUp = true;
    }
  }

  for await (const _line of rejoinSplitRecords(source(), silent)) break;
  assert.equal(cleanedUp, true, 'a wrapper that swallowed the close would leak a codex process per interrupt');
});

/**
 * A stand-in for the codex binary: prints a fixed JSONL turn, one of whose
 * records carries a raw U+2028, and exits 0. Lets the test drive the REAL SDK —
 * its argv, its spawn, its readline, its JSON.parse — without a model call.
 */
function fakeCodex(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-repair-'));
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-fake' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: `before${LS}after` },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 },
    }),
  ].join('\n');
  const data = path.join(dir, 'turn.jsonl');
  fs.writeFileSync(data, `${jsonl}\n`, 'utf8');

  const script = path.join(dir, 'codex');
  fs.writeFileSync(script, `#!/bin/sh\nexec /bin/cat ${JSON.stringify(data)}\n`, 'utf8');
  fs.chmodSync(script, 0o755);
  return script;
}

async function runFakeTurn(codex: Codex): Promise<unknown[]> {
  const { events } = await codex.startThread().runStreamed('hello');
  const seen: unknown[] = [];
  for await (const ev of events) seen.push(ev);
  return seen;
}

test('end to end: the real SDK chokes on a raw U+2028, and the repair fixes it', async (t) => {
  const bin = fakeCodex();
  t.after(() => fs.rmSync(path.dirname(bin), { recursive: true, force: true }));

  await assert.rejects(
    () => runFakeTurn(new Codex({ codexPathOverride: bin })),
    /Failed to parse item/,
    'unpatched, one separator in a payload kills the turn — this is the bug',
  );

  const patched = new Codex({ codexPathOverride: bin });
  assert.equal(installJsonlRepair(patched), true);
  const events = await runFakeTurn(patched) as Array<Record<string, any>>;

  assert.deepEqual(events.map((e) => e.type), ['thread.started', 'item.completed', 'turn.completed']);
  assert.equal(events[1].item.text, `before${LS}after`, 'and the payload survives intact');
});
