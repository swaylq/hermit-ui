/**
 * Renders `apps/ios/tools/fixtures/block-cases.json` — the answers THIS
 * `parseBlock` / `parseBlocks` give today, for the Swift port to be held against.
 *
 *     pnpm --filter @hermit-ui/dashboard gen:blocks-fixture
 *
 * `src/lib/chat-blocks.ts` is the single definition of what a message's content
 * is, and `apps/ios/Hermit/ContentBlock.swift` is a second implementation of it.
 * A hand-written Swift check would encode whatever the porter believed while
 * reading, and most of what decides these answers is not obvious from the type:
 *
 *   · a `text` block with NO text is an empty text block, but one whose `text`
 *     is a number is not a text block at all;
 *   · a `thinking` block's char count comes from `chars` after the digest ran
 *     and from the body's length before it;
 *   · an `image` source is classified by which FIELD is present, not by its own
 *     `type` — an elided one (`data:''` + `elidedKB`) is still base64;
 *   · `is_error` is true only for the literal `true`;
 *   · an interaction with no `kind` is a question, and any `status` other than
 *     the literal 'pending' counts as answered;
 *   · a block naming a known type but missing the field that type is FOR falls
 *     through to `unknown`, rather than half-rendering.
 *
 * The INPUTS below are hand-written — they are the shapes the four producers
 * actually write (gateway relay, `send-user-file`, the MCP stub, the composer),
 * plus what `capMessageContent` and `digestMessageContent` rewrite them into.
 * The EXPECTATIONS are not: they come out of running the real functions.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { DIGEST_FLAG, parseBlock, parseBlocks } from '../src/lib/chat-blocks';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = 'apps/ios/tools/fixtures/block-cases.json';

/** One block in, one block out. */
const BLOCKS: Array<{ name: string; block: unknown }> = [
  // text — the conversation itself
  { name: 'text', block: { type: 'text', text: 'hello world' } },
  { name: 'text/empty', block: { type: 'text', text: '' } },
  { name: 'text/missing', block: { type: 'text' } },
  { name: 'text/null', block: { type: 'text', text: null } },
  { name: 'text/number', block: { type: 'text', text: 42 } },
  { name: 'text/multiline', block: { type: 'text', text: 'one\ntwo\n' } },
  { name: 'text/capped', block: { type: 'text', text: 'x'.repeat(40) + '\n\n— 内容过长 —' } },

  // thinking — before and after the cap and the digest
  { name: 'thinking', block: { type: 'thinking', thinking: 'let me check the index' } },
  { name: 'thinking/empty', block: { type: 'thinking', thinking: '' } },
  { name: 'thinking/no-body', block: { type: 'thinking' } },
  { name: 'thinking/digested', block: { type: 'thinking', thinking: '', chars: 1204, [DIGEST_FLAG]: 1 } },
  { name: 'thinking/text-field', block: { type: 'thinking', text: 'older shape' } },
  { name: 'thinking/signature-stripped', block: { type: 'thinking', thinking: 'reasoned' } },

  // tool_use — whole, digested, and the ask call the question card joins on
  {
    name: 'tool_use',
    block: { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/tmp/a.txt', limit: 20 } },
  },
  {
    name: 'tool_use/digested',
    block: { type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'ls -la' }, [DIGEST_FLAG]: 1 },
  },
  {
    name: 'tool_use/ask',
    block: { type: 'tool_use', id: 'toolu_03', name: 'ask', input: { question: 'Ship it?' } },
  },
  { name: 'tool_use/no-input', block: { type: 'tool_use', id: 'toolu_04', name: 'ListAgents' } },
  { name: 'tool_use/array-input', block: { type: 'tool_use', id: 'toolu_05', name: 'X', input: [1, 'two', null] } },
  { name: 'tool_use/no-id', block: { type: 'tool_use', name: 'Read', input: {} } },
  { name: 'tool_use/no-name', block: { type: 'tool_use', id: 'toolu_06' } },

  // tool_result — a string, nested blocks, an error, and the digest's first line
  { name: 'tool_result/string', block: { type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' } },
  {
    name: 'tool_result/blocks',
    block: {
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: [{ type: 'text', text: 'first line' }, { type: 'image', source: { type: 'base64', data: '' } }],
    },
  },
  { name: 'tool_result/error', block: { type: 'tool_result', tool_use_id: 'toolu_02', content: 'boom', is_error: true } },
  { name: 'tool_result/is_error-string', block: { type: 'tool_result', tool_use_id: 'toolu_02', content: 'x', is_error: 'true' } },
  {
    name: 'tool_result/digested',
    block: { type: 'tool_result', tool_use_id: 'toolu_03', is_error: false, content: 'first line…', [DIGEST_FLAG]: 1 },
  },
  { name: 'tool_result/no-content', block: { type: 'tool_result', tool_use_id: 'toolu_04' } },
  { name: 'tool_result/no-id', block: { type: 'tool_result', content: 'orphan' } },

  // image — the composer, the relay, and what capMessageContent leaves behind
  {
    name: 'image/url',
    block: { type: 'image', source: { type: 'url', url: '/uploads/s/a.png', media_type: 'image/png' }, width: 1024, height: 768 },
  },
  { name: 'image/base64', block: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } } },
  { name: 'image/elided', block: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '', elidedKB: 167 } } },
  { name: 'image/bare-url', block: { type: 'image', source: { url: 'https://x/y.png' } } },
  { name: 'image/bare-data', block: { type: 'image', source: { data: 'AAAA' } } },
  { name: 'image/empty-source', block: { type: 'image', source: {} } },
  { name: 'image/no-source', block: { type: 'image' } },
  { name: 'image/null-dims', block: { type: 'image', source: { type: 'url', url: '/u/a.png' }, width: null, height: null } },

  // file — the download chip
  {
    name: 'file',
    block: { type: 'file', source: { type: 'url', url: '/uploads/s/r.pdf', media_type: 'application/pdf' }, name: 'r.pdf' },
  },
  { name: 'file/no-name', block: { type: 'file', source: { type: 'url', url: '/uploads/s/r.pdf' } } },
  { name: 'file/no-source', block: { type: 'file', name: 'r.pdf' } },

  // interaction — the only block a reader has to ACT on
  {
    name: 'interaction/question',
    block: {
      type: 'interaction',
      interactionId: 'int_1',
      kind: 'question',
      payload: { question: 'Which branch?', options: ['main', 'next'] },
      status: 'pending',
    },
  },
  {
    name: 'interaction/permission',
    block: {
      type: 'interaction',
      interactionId: 'int_2',
      kind: 'permission',
      payload: { tool: 'Bash', input: { command: 'rm -rf /tmp/x' } },
      status: 'pending',
    },
  },
  {
    name: 'interaction/resolved-allow',
    block: {
      type: 'interaction',
      interactionId: 'int_3',
      kind: 'permission',
      payload: { tool: 'Bash' },
      status: 'resolved',
      decision: { behavior: 'allow' },
      answeredBy: null,
    },
  },
  {
    name: 'interaction/resolved-brain',
    block: {
      type: 'interaction',
      interactionId: 'int_4',
      kind: 'question',
      payload: { question: 'q' },
      status: 'resolved',
      decision: { answers: ['main'] },
      answeredBy: 'brain',
    },
  },
  { name: 'interaction/no-kind', block: { type: 'interaction', interactionId: 'int_5', payload: {} } },
  { name: 'interaction/odd-status', block: { type: 'interaction', interactionId: 'int_6', kind: 'question', status: 'expired' } },

  // unknown — the whole point of the fallback
  { name: 'unknown/redacted_thinking', block: { type: 'redacted_thinking', data: 'AAAA' } },
  { name: 'unknown/server_tool_use', block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } } },
  { name: 'unknown/empty-type', block: { type: '' } },
  { name: 'unknown/no-type', block: { text: 'orphan' } },
  { name: 'unknown/numeric-type', block: { type: 7 } },
  { name: 'unknown/null', block: null },
  { name: 'unknown/number', block: 3 },
  { name: 'unknown/string', block: 'bare' },
  { name: 'unknown/array', block: [{ type: 'text', text: 'nested' }] },
];

/** A whole `content` column in, a list of blocks out. */
const CONTENTS: Array<{ name: string; content: unknown }> = [
  { name: 'content/array', content: [{ type: 'text', text: 'hi' }, { type: 'thinking', thinking: 'hm' }] },
  { name: 'content/string', content: 'a plain old row' },
  { name: 'content/empty-string', content: '' },
  { name: 'content/empty-array', content: [] },
  { name: 'content/null', content: null },
  { name: 'content/object', content: { type: 'text', text: 'not an array' } },
  { name: 'content/number', content: 12 },
  {
    name: 'content/mixed',
    content: [
      { type: 'text', text: 'here you go' },
      { type: 'image', source: { type: 'url', url: '/u/a.png' } },
      { type: 'wat', payload: 1 },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
    ],
  },
  {
    name: 'content/terminator',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'No response requested.' }],
  },
];

const fixture = {
  note: 'GENERATED by apps/dashboard/scripts/gen-blocks-fixture.ts — do not hand-edit.',
  digestFlag: DIGEST_FLAG,
  blocks: BLOCKS.map((c) => ({ name: c.name, block: c.block ?? null, expected: parseBlock(c.block) })),
  contents: CONTENTS.map((c) => ({ name: c.name, content: c.content ?? null, expected: parseBlocks(c.content) })),
};

const dest = join(REPO_ROOT, OUT);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(fixture, null, 2) + '\n');
console.log(`${OUT}: ${fixture.blocks.length} blocks · ${fixture.contents.length} contents`);
