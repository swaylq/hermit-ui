// The rule this file defends is "the reply, not the work" — and the two ways it
// can break are opposite and both silent:
//
//   · too little — a session mid-turn, or one whose reply arrived in two rows,
//     yields nothing, and voice input is back to guessing at 「拉特霍尔」;
//   · too much — mid-turn narration ("Run 5。最高优先级未勾选…") gets mistaken for
//     the reply, and the budget fills with the agent talking to itself.
//
// The awkward cases below are all real shapes from live transcripts: text and
// tool_use arrive in SEPARATE rows, thinking rows sit between the last tool call
// and the reply, tool_results are role 'user', and a busy session's newest 100
// rows can contain no finished reply at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickContextItems,
  formatContext,
  buildContext,
  isContextEcho,
  MAX_ITEM_CHARS,
  MAX_REPLIES,
  MAX_TOTAL_CHARS,
  type ContextRow,
} from './transcribe-context';

// Row builders. Everything is written NEWEST FIRST, the order the scan returns.
const said = (text: string): ContextRow => ({ role: 'user', composed: true, texts: [text], hasTool: false });
const reply = (text: string): ContextRow => ({ role: 'assistant', composed: false, texts: [text], hasTool: false });
const thinking = (): ContextRow => ({ role: 'assistant', composed: false, texts: [], hasTool: false });
const toolUse = (): ContextRow => ({ role: 'assistant', composed: false, texts: [], hasTool: true });
const toolResult = (): ContextRow => ({ role: 'user', composed: false, texts: [], hasTool: false });

test('the final reply is kept and the narration before the tool calls is not', () => {
  const items = pickContextItems([
    reply('修好了，问题在 SSE 的重连退避。'),
    thinking(),
    toolResult(),
    toolUse(),
    reply('让我先看一下 gateway 的日志。'), // process: it precedes a tool call
    said('线上聊天卡住了，看一下'),
  ]);
  assert.deepEqual(items, [
    { who: 'user', text: '线上聊天卡住了，看一下' },
    { who: 'agent', text: '修好了，问题在 SSE 的重连退避。' },
  ]);
});

test('a reply split across rows is rejoined, in order', () => {
  const items = pickContextItems([
    reply('第二段：已经部署到 VPS。'),
    reply('第一段：改完了。'),
    toolUse(),
    said('部署一下'),
  ]);
  assert.deepEqual(items, [
    { who: 'user', text: '部署一下' },
    { who: 'agent', text: '第一段：改完了。 第二段：已经部署到 VPS。' },
  ]);
});

test('a turn with no tool calls at all still yields its reply', () => {
  const items = pickContextItems([reply('rathole 是内网穿透，Mac 端口映射到 VPS。'), said('rathole 是什么')]);
  assert.deepEqual(items, [
    { who: 'user', text: 'rathole 是什么' },
    { who: 'agent', text: 'rathole 是内网穿透，Mac 端口映射到 VPS。' },
  ]);
});

test('a turn still running contributes nothing, and the finished turn behind it does', () => {
  // Speaking while the agent works is the common case — the newest rows are all
  // tool traffic, and the context has to come from further back.
  const items = pickContextItems([
    toolUse(),
    thinking(),
    toolResult(),
    toolUse(),
    said('继续部署'),
    reply('Docker 配置改好了。'),
    toolUse(),
    said('改一下 Docker 配置'),
  ]);
  assert.deepEqual(items, [
    { who: 'user', text: '改一下 Docker 配置' },
    { who: 'agent', text: 'Docker 配置改好了。' },
    { who: 'user', text: '继续部署' },
  ]);
});

test('a tool_result ends the reply just like a tool_use does', () => {
  // A turn killed mid-tool-call leaves a tool_result as its last row; nothing
  // after the last tool call means no reply, not "use whatever text is around".
  const items = pickContextItems([toolResult(), reply('正在查'), toolUse(), said('查一下')]);
  assert.deepEqual(items, [{ who: 'user', text: '查一下' }]);
});

test('thinking rows neither open nor close a reply', () => {
  const items = pickContextItems([thinking(), reply('好了。'), thinking(), toolUse(), said('弄一下')]);
  assert.deepEqual(items, [
    { who: 'user', text: '弄一下' },
    { who: 'agent', text: '好了。' },
  ]);
});

test('at most MAX_REPLIES replies come back, the newest ones', () => {
  const rows: ContextRow[] = [];
  for (let i = 10; i >= 1; i--) {
    rows.push(reply(`回复${i}`), toolUse(), said(`问题${i}`));
  }
  const items = pickContextItems(rows);
  const agents = items.filter((i) => i.who === 'agent').map((i) => i.text);
  assert.equal(agents.length, MAX_REPLIES);
  assert.deepEqual(agents, ['回复8', '回复9', '回复10']); // chronological, newest last
});

test('fenced code blocks are dropped, inline code survives', () => {
  // A pasted diff would eat the whole budget; `pm2 restart` is the exact
  // identifier the user is about to say out loud.
  const items = pickContextItems([
    reply('跑 `pm2 restart hermit-ui-gateway`：\n```bash\npm2 restart hermit-ui-gateway\npm2 save\n```\n然后看日志。'),
    said('怎么重启'),
  ]);
  const agent = items.find((i) => i.who === 'agent')!;
  assert.ok(agent.text.includes('`pm2 restart hermit-ui-gateway`'));
  assert.ok(!agent.text.includes('pm2 save'));
  assert.ok(!agent.text.includes('```'));
});

test('an unterminated code fence does not swallow the text after it', () => {
  // Truncated agent output is common; a greedy fence match would blank the line.
  const items = pickContextItems([reply('看这个\n```\nhalf a block'), said('看看')]);
  assert.deepEqual(items.find((i) => i.who === 'agent'), { who: 'agent', text: '看这个' });
});

test('empty, blank and non-string text blocks produce no line at all', () => {
  const junk: ContextRow = { role: 'assistant', composed: false, texts: [null, 42, '   '], hasTool: false };
  assert.deepEqual(pickContextItems([junk, said('   ')]), []);
  assert.equal(buildContext([junk]), '');
  assert.equal(buildContext([]), '');
});

test('a gateway system row is not conversation', () => {
  const system: ContextRow = { role: 'system', composed: false, texts: ['Session restarted'], hasTool: false };
  assert.deepEqual(pickContextItems([system, said('在吗')]), [{ who: 'user', text: '在吗' }]);
});

test('the Brain speaking during a takeover counts as a composed message', () => {
  // authoredBy isn't read: a takeover turn is still what was said in this chat,
  // and the next utterance follows on from it.
  const items = pickContextItems([reply('好的。'), said('把日志发出来')]);
  assert.equal(items[0].text, '把日志发出来');
});

test('long lines are truncated and the whole block is capped', () => {
  const long = 'x'.repeat(2000);
  const block = buildContext([reply(long), said(long), reply(long), said(long), reply(long), said(long)]);
  assert.ok(block.length <= MAX_TOTAL_CHARS, `block was ${block.length}`);
  for (const line of block.split('\n')) {
    assert.ok(line.length <= MAX_ITEM_CHARS + 4, `line was ${line.length}`);
    assert.ok(line.endsWith('…'));
  }
});

test('when the budget runs out it is the OLDEST lines that go', () => {
  // Five full-width lines don't fit in MAX_TOTAL_CHARS; the ones nearest the
  // utterance are the ones that explain it, so they are the ones that survive.
  const items = [1, 2, 3, 4, 5].map((n) => ({
    who: (n % 2 ? 'user' : 'agent') as 'user' | 'agent',
    text: `第${n}句${'内容'.repeat(200)}`,
  }));
  const block = formatContext(items);
  assert.ok(block.length <= MAX_TOTAL_CHARS);
  assert.ok(block.includes('第5句'));
  assert.ok(!block.includes('第1句'));
  // …and what remains is still in reading order.
  assert.ok(block.indexOf('第4句') < block.indexOf('第5句'));
});

test('the block reads as a conversation, oldest first', () => {
  const block = buildContext([reply('改好了。'), toolUse(), said('改一下配置')]);
  assert.equal(block, '用户：改一下配置\n助手：改好了。');
});

// ── the echo guard ──────────────────────────────────────────────────────────
// The context below is the one used in the live A/B, and ECHO is verbatim what
// qwen3-asr-flash returned for 1.5 s of silence with that context attached —
// three runs out of three. Everything else here is a legitimate utterance that
// must survive: the guard is worthless if it eats the words people actually say.

const LIVE_CONTEXT = [
  '用户：语音输入偶尔把技术词听错，能不能带上下文',
  '助手：现在两步都直连 DashScope：ASR 是 `qwen3-asr-flash`，定稿是 `qwen-flash`，OpenRouter 的 voxtral 只在没配 key 时兜底。rathole 隧道把 Mac 的端口映射到 VPS，dash.swaylab.ai 走 VPS:4101；macmini003 那台的 gateway 还是旧代码。Docker 配置已经改好，要我重新部署吗？',
].join('\n');

const ECHO =
  '现在两步都直连 DashScope：ASR 是 `qwen3-asr-flash`，定稿是 `qwen-flash`，OpenRouter 的 voxtral 只在没配 key 时兜底。rathole 隧道把 Mac 的端口映射到 VPS，dash.swaylab.ai 走 VPS:4101；macmini003 那台的 gateway 还是旧代码。Docker 配置已经改好，要我重新部署吗？';

test('the live silence echo is caught', () => {
  assert.equal(isContextEcho(ECHO, LIVE_CONTEXT), true);
});

test('an echo with speech tacked on is still an echo', () => {
  assert.equal(isContextEcho(`${ECHO} 先别部署`, LIVE_CONTEXT), true);
});

test('punctuation and spacing differences do not let an echo through', () => {
  const restyled = ECHO.replace(/[，。：；]/g, ' ').replace(/`/g, '');
  assert.equal(isContextEcho(restyled, LIVE_CONTEXT), true);
});

test('real utterances that overlap the context are kept', () => {
  for (const said of [
    '把 rathole 的隧道重启一下',
    'voxtral 那条兜底还留着吗',
    '先别部署',
    'macmini003 上的 gateway 更新了吗',
    'dash.swaylab.ai 的 SSE 是不是又断了',
    // The worst legitimate case: reading a whole command back out loud.
    '跑一下 OpenRouter 的 voxtral 只在没配 key 时兜底这段是什么意思',
  ]) {
    assert.equal(isContextEcho(said, LIVE_CONTEXT), false, said);
  }
});

test('a long utterance that merely brushes the context is kept', () => {
  const spoken =
    '我想把语音输入这块再改一下，rathole 隧道那边先不动，重点是转写完之后草稿要能直接发出去，' +
    '另外手机上长按的手感也得再调调，现在按下去到开始录之间还是有点延迟。';
  assert.equal(isContextEcho(spoken, LIVE_CONTEXT), false);
});

test('no context, no echo', () => {
  assert.equal(isContextEcho(ECHO, ''), false);
  assert.equal(isContextEcho('', LIVE_CONTEXT), false);
});
