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

const silent = () => {};

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
  assert.throws(() => JSON.parse(split[0]), 'and neither half parses');
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

test('whole records pass straight through, in order and unaltered', async () => {
  const a = JSON.stringify({ type: 'thread.started', thread_id: 't1' });
  const b = JSON.stringify({ type: 'item.completed', item: { text: 'plain' } });
  const out = await collect(rejoinSplitRecords(lines(a, '', b), silent));
  assert.deepEqual(out, [a, '', b], 'a blank line is framing noise, not a truncated record');
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

test('an unparseable line is dropped with a warning and the next record still lands', async () => {
  const good = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } });
  const warnings: string[] = [];
  const out = await collect(rejoinSplitRecords(lines('{not json', good), (m) => warnings.push(m)));

  assert.deepEqual(out, [good], 'one bad line must not eat the rest of the turn');
  assert.equal(warnings.length, 1, 'and the drop is logged, not silent');
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

  const out = await collect(rejoinSplitRecords(lines(...fragments), silent));
  assert.deepEqual(out, [record], 'and it is still rejoined, not mistaken for a record');
});

test('a stream that ends mid-record drops the fragment instead of failing the turn', async () => {
  const warnings: string[] = [];
  const [head] = await readlineSplit(
    JSON.stringify({ type: 'item.completed', item: { text: `head${LS}tail` } }),
  );
  const out = await collect(rejoinSplitRecords(lines(head), (m) => warnings.push(m)));

  assert.deepEqual(out, []);
  assert.match(warnings[0], /ended mid-record/);
});

test('the wrap lands on a real Codex instance — an SDK that reshapes it fails here, not in production', () => {
  const codex = new Codex({});
  assert.equal(installJsonlRepair(codex), true, '@openai/codex-sdk no longer exposes exec.run as expected');
});

test('an SDK whose shape we do not recognise is left alone', () => {
  assert.equal(installJsonlRepair({}), false);
  assert.equal(installJsonlRepair({ exec: {} }), false);
  assert.equal(installJsonlRepair({ exec: { run: 'not a function' } }), false);
});

test('the wrapped run repairs what the raw one would have broken', async () => {
  const record = JSON.stringify({ type: 'item.completed', item: { text: `left${LS}right` } });
  const fake = {
    exec: {
      run: async function* (): AsyncGenerator<string> {
        yield* await readlineSplit(record);
      },
    },
  };

  assert.equal(installJsonlRepair(fake), true);
  const out = await collect(fake.exec.run());
  assert.deepEqual(out, [record]);
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
  t.after(() => fs.rmSync(path.dirname(bin), { recursive: true, force: true }));
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
