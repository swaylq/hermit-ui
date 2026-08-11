// harness router — pick the cheapest harness that can finish the task.
//
// A mode exists only as spawn arguments, so the choice has to be made BEFORE the
// child boots (changing it later evicts the child and restarts the thread). That
// makes routing a pre-flight decision, not something the agent does mid-turn —
// which is lucky, because it means it can be a pure function and cost nothing.
//
// Two stages:
//   1. rules   — regex signals over the task text. ~0.1 ms, 0 tokens, no network.
//   2. smol    — one ~250-token call to a cheap model, ONLY when the rules are
//                not confident. Costs about $0.0003 and ~400 ms.
//
// Anything still unresolved escalates to `omp`, the full-surface harness. The
// router is allowed to be wrong toward expensive; it must never be wrong toward
// "can't do the job".
//
// Usage:
//   node route.mjs "把 pi-rpc.ts 里的超时改成 60s"      → patch
//   node route.mjs --json "where is RETRY_BUDGET defined"
//   node route.mjs --smol "..."          (allow stage 2)
//   node route.mjs --explain "..."       (show the scoring)

/**
 * The harnesses this router knows.
 *
 * `cost` is the MEASURED standing tax in tokens, as each one is actually
 * spawned — hermit's six tools unioned in, SYSTEM.md appended, the extension
 * loaded (bench/harness-tax.sh). Not estimates: an estimate here would quietly
 * mis-rank the escalation.
 *
 * Re-measured 2026-08-11 when `office` was added. Every pi harness came back
 * exactly 278 tokens above its 2026-08-10 figure and omp 621 above — a shared
 * preamble grew, not a regression in any one recipe. Numbers on two different
 * scales in one table would make office look 515 dearer than patch when the
 * real gap is 237, so the whole column was retaken rather than one row added.
 */
export const HARNESSES = {
  answer: { cost: 4754, needs: 'nothing — reasoning and prose only' },
  shell: { cost: 4944, needs: 'bash on this machine' },
  scout: { cost: 5384, needs: 'read/grep/find over files, read-only' },
  patch: { cost: 5885, needs: 'edit/write plus bash to verify' },
  office: { cost: 6122, needs: 'an .xlsx/.docx/.pptx edited as a binary archive, not as text' },
  web: { cost: 11403, needs: 'web_search (omp-only)' },
  omp: { cost: 22720, needs: 'browser / lsp / ast_edit / open-ended multi-file work' },
};

/**
 * Tie-break order, MOST capable first — not cheapest first.
 *
 * Being wrong toward expensive is a cost bug; being wrong toward cheap is a
 * failed task and a wasted round trip. So an even score resolves upward.
 */
// `office` sits below web and omp, not above patch, and both halves of that are
// deliberate. This order resolves the HARD set, whose only members can be omp,
// web and office — patch has no hard signal — so office beating patch is
// already guaranteed by the short-circuit above and does not need rank. What
// rank decides is office against a real exclusive capability: "搜一下 openpyxl
// 最新版本" fires both, and the internet is the part no other harness can fake.
const BY_CAPABILITY = ['omp', 'patch', 'web', 'office', 'shell', 'scout', 'answer'];
const rank = (h) => BY_CAPABILITY.indexOf(h);

// Signals. Latin terms are word-bounded; CJK is matched raw because it has no
// word boundaries. Weights are coarse on purpose — 3 = decisive, 2 = strong,
// 1 = a hint. A signal that fires on half of all prompts is worth 0 and is not
// listed.
//
// `hard: true` marks a signal for a capability NO cheaper harness has at all —
// a browser, or the internet. Those short-circuit scoring entirely: no amount
// of "fix"-ness makes `patch` able to take a screenshot.
const SIGNALS = [
  // ---- web: needs the internet -------------------------------------------
  { h: 'web', w: 3, hard: true, re: /https?:\/\/\S+/i },
  { h: 'web', w: 3, hard: true, re: /\b(google it|search the web|web search|search online|look (it |this )?up)\b/i },
  { h: 'web', w: 3, hard: true, re: /(搜一下|搜索一下|上网查|网上查|查一下网上|谷歌一下|百度一下)/ },
  { h: 'web', w: 3, hard: true, re: /\b(official (docs|documentation|site)|release notes|changelog) (for|of)\b/i },
  { h: 'web', w: 2, re: /\b(latest|newest|current price|news about|what changed in)\b/i },
  { h: 'web', w: 2, re: /(最新|最近发布|新闻|官网|价格是多少|发布了什么|有没有.{0,6}论文)/ },

  // ---- shell: run something on this machine -------------------------------
  { h: 'shell', w: 3, re: /\b(pm2|systemctl|launchctl|docker|kubectl|journalctl|lsof|netstat)\b/i },
  { h: 'shell', w: 3, re: /(重启|启动服务|停止服务|部署一下|看下日志|看一下日志|查日志|端口占用|进程)/ },
  { h: 'shell', w: 3, re: /\b(listening on|what'?s? (running |on )?port|which process)\b/i },
  { h: 'shell', w: 2, re: /\b(restart|reboot|is .{1,20} (running|up)|tail the logs?|check the logs?|uptime|disk (usage|space)|kill the)\b/i },
  { h: 'shell', w: 2, re: /(磁盘|内存占用|还在(跑|运行|工作)(吗|没)?|服务(还)?在(不在|吗)|跑起来了吗|状态怎么样)/ },
  { h: 'shell', w: 2, re: /\b(run|execute) (the )?(tests?|test suite|build|lint|type ?check|command|script|it)\b/i },
  { h: 'shell', w: 2, re: /(执行(一下)?命令|跑一下(命令|测试|构建)|git status)/ },

  // ---- patch: change code -------------------------------------------------
  // Bare verbs are kept narrow: an unanchored /migrate/ matched "prisma migrate
  // resolve" and sent a documentation lookup to the code editor.
  { h: 'patch', w: 3, re: /\b(fix|refactor|rename|implement|revert) (the|this|it|a|an|that|\w+\.\w+)\b/i },
  { h: 'patch', w: 3, re: /(修复|修一下|修好|改成|改一下|重构|实现一个|实现下|加一个|删掉|替换成|去掉|补一个|补个|新增)/ },
  { h: 'patch', w: 2, re: /\b(add|remove|delete|change|update|edit|wire up|hook up) (the |a |an )?\w+/i },
  { h: 'patch', w: 2, re: /\b(migrate|port) (the|this|all|every)\b/i },
  { h: 'patch', w: 2, re: /\b(add|write) (a |an )?(unit |integration )?tests?\b/i },
  { h: 'patch', w: 2, re: /(写一个函数|加个字段|写测试|单元测试|改逻辑|优化代码|清理代码)/ },
  { h: 'patch', w: 2, re: /\b(bug|broken|failing test|does ?n'?t work|regression)\b/i },
  { h: 'patch', w: 2, re: /(报错了|坏了|不工作|跑不通|测试挂了)/ },
  { h: 'patch', w: 1, re: /\b(make it|should be|instead of) \b/i },

  // ---- scout: read-only investigation -------------------------------------
  { h: 'scout', w: 3, re: /\b(where is|where does|which file|who calls|find (the|all|every)|trace (the|how))\b/i },
  { h: 'scout', w: 3, re: /(在哪(里|儿)?|哪个文件|谁调用|找一下|搜一下代码|定义在哪)/ },
  { h: 'scout', w: 2, re: /\b(how does .{1,40} work|what does .{1,40} do|read (the )?(file|code)|walk me through)\b/i },
  { h: 'scout', w: 2, re: /(怎么实现的|是怎么工作的|读一下|看一下代码|梳理一下|捋一遍)/ },
  { h: 'scout', w: 1, re: /\b(grep|search the (repo|codebase|code))\b/i },
  { h: 'scout', w: 1, re: /(代码库|这个仓库|项目里)/ },

  // ---- office: Excel / Word / PowerPoint files ----------------------------
  // `hard` here for a different reason than the browser and the internet above.
  // office and patch have IDENTICAL tool lists, so no amount of scoring can
  // separate them — and patch, handed an .xlsx, reaches for `edit` and corrupts
  // it, because a ZIP of XML looks like a file the editor should be able to
  // open. What is exclusive is the discipline in office/SYSTEM.md, not a tool.
  // Being wrong toward office is cheap in a way the usual rule does not cover:
  // it has patch's whole tool set, so a misrouted code task still finishes.
  { h: 'office', w: 3, hard: true, re: /\.(xlsx|xlsm|xls|docx|doc|pptx|ppt)\b/i },
  { h: 'office', w: 3, hard: true, re: /\b(excel|powerpoint|openpyxl|python-docx|python-pptx)\b/i },
  { h: 'office', w: 3, hard: true, re: /(电子表格|工作簿|工作表|幻灯片|演示文稿)/ },
  // `word` alone is a common English noun, so it counts only when a document
  // follows it. `ppt` needs no qualifier — nothing else in this fleet is called that.
  { h: 'office', w: 3, hard: true, re: /\bword\b\s*(文档|文件|表格|里|中|的|doc|document|file)/i },
  { h: 'office', w: 3, hard: true, re: /\bppt\b/i },
  { h: 'office', w: 2, re: /\b(spreadsheet|workbook|worksheet|pivot table)\b/i },
  { h: 'office', w: 2, re: /(单元格|合并单元格|数据透视|透视表|表头|sheet 页)/ },

  // ---- omp: the escalation ------------------------------------------------
  { h: 'omp', w: 3, hard: true, re: /\b(screenshot|browser|viewport|responsive|dark mode|focus ring)\b/i },
  { h: 'omp', w: 3, hard: true, re: /(截图|浏览器|前端|页面(样式|布局)|样式不对|响应式)/ },
  { h: 'omp', w: 3, re: /(设计并实现|从零(开始)?(做|写|搭))/ },
  { h: 'omp', w: 2, re: /\b(css|tailwind|render(ed|ing))\b/i },
  { h: 'omp', w: 2, re: /\b(across (the )?(whole|entire) (repo|codebase|project)|end.to.end|from scratch|design and (build|implement))\b/i },
  { h: 'omp', w: 2, re: /(整个项目|全仓库|多个文件|新的.{0,4}页面)/ },
  { h: 'omp', w: 1, re: /\b(lsp|ast|type ?check the whole)\b/i },
];

/** A path-looking token is evidence the task touches a repo, not just prose. */
const PATH_RE = /(^|[\s"'`(])(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|mjs|jsx|py|go|rs|java|rb|sh|json|ya?ml|toml|md|css|html|sql|prisma)\b/;

/** A fenced or inline shell command. */
const CMD_RE = /```(?:sh|bash|zsh|console)?\s|\$\s+\w+|\b(?:sudo|npm|pnpm|yarn|bun|git|curl|ssh|cat|tail|grep -r)\s+\S/;

/**
 * Stage 1. Pure, synchronous, no network.
 *
 * Returns the winner plus enough detail to debug a bad route without rerunning
 * anything — a router you cannot explain is a router nobody will trust with a
 * default.
 */
export function routeRules(task) {
  const text = String(task ?? '').slice(0, 4000);
  const scores = Object.fromEntries(Object.keys(HARNESSES).map((h) => [h, 0]));
  const hits = [];
  const hard = new Set();

  for (const sig of SIGNALS) {
    if (sig.re.test(text)) {
      scores[sig.h] += sig.w;
      if (sig.hard) hard.add(sig.h);
      hits.push({ harness: sig.h, weight: sig.w, pattern: String(sig.re).slice(0, 60) });
    }
  }

  // An exclusive capability is not negotiable. "fix the focus ring and send a
  // screenshot" scores as a patch AND as a browser task; only one of the two
  // harnesses owns a browser, so the score is irrelevant.
  if (hard.size) {
    const winner = [...hard].sort((a, b) => rank(a) - rank(b))[0];
    return {
      harness: winner,
      confidence: 0.9,
      via: 'rules',
      why: `exclusive capability — ${HARNESSES[winner].needs}`,
      scores,
      hits,
    };
  }

  // Structural evidence, weaker than an explicit verb but it decides ties.
  const hasPath = PATH_RE.test(text);
  const hasCmd = CMD_RE.test(text);
  if (hasPath) {
    // A path with no change-verb is someone asking about code, not asking for a
    // change. Both get a point; the verb signals above are what separates them.
    scores.scout += 1;
    scores.patch += 1;
    hits.push({ harness: 'scout+patch', weight: 1, pattern: 'file path present' });
  }
  if (hasCmd) {
    scores.shell += 2;
    hits.push({ harness: 'shell', weight: 2, pattern: 'shell command present' });
  }

  const ranked = BY_CAPABILITY
    .map((h) => ({ harness: h, score: scores[h] }))
    .sort((a, b) => b.score - a.score || rank(a.harness) - rank(b.harness));

  const [top, second] = ranked;

  // Nothing fired: the rules ABSTAIN. They used to answer "answer" here, which
  // scored 100% on the set they were tuned against and 27% on a held-out set —
  // because natural phrasing ("这段代码有点重复，抽出来", "how much RAM is node
  // eating") hits no keyword, and every one of those misses landed in the one
  // harness that has no tools at all. A keyword list is a cache of phrasings
  // already seen, not a classifier. Abstaining hands the case to stage 2, which
  // is what actually generalises.
  if (top.score === 0) {
    return { harness: null, confidence: 0, via: 'rules', why: 'no signal — abstained', scores, hits };
  }

  // Confidence is the margin, not the magnitude: two signals for scout beats
  // five signals split evenly between scout and patch.
  const margin = top.score - (second?.score ?? 0);
  const confidence = Math.min(0.95, 0.4 + 0.18 * margin);

  return { harness: top.harness, confidence, via: 'rules', why: describe(hits, top.harness), scores, hits };
}

function describe(hits, harness) {
  const mine = hits.filter((h) => h.harness === harness || h.harness.includes(harness));
  if (mine.length === 0) return 'ranked top on cost with no direct signal';
  return mine.map((h) => h.pattern).slice(0, 3).join(' + ');
}

/**
 * Stage 2. One cheap model call, used only when stage 1 is unsure.
 *
 * Deliberately not a conversation: a single user turn, a forced short answer,
 * and any reply that is not a known harness name is discarded rather than
 * guessed at. A router that hallucinates a mode name would send the session to
 * resolveMode's fallback, which is exactly the expensive default we are trying
 * to avoid.
 */
export async function routeSmol(task, opts = {}) {
  const {
    baseUrl = process.env.HARNESS_ROUTER_BASE_URL || 'https://litellm.hyqubit.com',
    apiKey = process.env.HERMIT_PI_API_KEY,
    model = process.env.HARNESS_ROUTER_MODEL || 'claude-haiku-4-5',
    timeoutMs = 8000,
  } = opts;
  if (!apiKey) return null;

  const SYSTEM = [
    'You are a router. You classify a task; you never perform it.',
    '',
    'answer — no tools at all. Reasoning, opinion, prose, translation, naming, summarising the conversation.',
    'scout  — read-only over the local repo (read/grep/find). The person wants to KNOW something, not change it.',
    'patch  — edit/write plus bash to verify. Anything that changes a file: fix, refactor, add, remove, rename, add a test.',
    'shell  — bash only, on THIS machine. Services, ports, logs, processes, disk, running a build or a test',
    '         suite, checking whether something that already ran succeeded.',
    'office — an Excel workbook, a Word document or a PowerPoint deck, named by extension or by name. Reading',
    '         one counts too: they are ZIP archives, so no other harness can even open them.',
    'web    — needs the internet. Search, open a URL, current facts, prices, a third party\'s docs, finding an',
    '         article or paper — anything that is not on this machine.',
    'omp    — a real browser is required, i.e. how something LOOKS or BEHAVES on screen: a control that will not',
    '         click, a layout that breaks on a phone or a narrow window, anything to be proved with a screenshot.',
    '         Also open-ended work spanning many files or both ends of a stack.',
    '',
    'Rules:',
    '- Any hint that a file should CHANGE is patch, never scout. scout only answers "where / what / how".',
    '- No repo, no machine, no internet involved is answer.',
    '- When two fit, pick the MORE capable one. Sending work to a harness that cannot finish it is the only real',
    '  error; an over-powered harness merely costs more.',
    '',
    'Reply with exactly one word: answer, scout, patch, shell, office, web, or omp.',
  ].join('\n');

  const body = {
    model,
    max_tokens: 16,
    // Load-bearing. This endpoint has thinking on by default, and a router asked
    // to emit one word spent its ENTIRE budget reasoning about retry logic
    // before saying anything — 400 output tokens, no text block, and the router
    // fell through to the fallback on every single call while looking healthy.
    // Disabled: 1 output token, one word, ~200 ms. Retried without the field
    // below for providers that reject it.
    thinking: { type: 'disabled' },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        // The task goes inside a tag, with the instruction after it. Handed the
        // bare text, the model ANSWERED it — "总结一下我们刚才讨论的结论" came
        // back as "I can't, this is the start of the conversation" rather than
        // the word `answer`. A task that reads like a request will be treated as
        // one unless it is visibly quoted data.
        content: `<task>\n${String(task ?? '').slice(0, 2000)}\n</task>\n\nWhich harness? One word.`,
      },
      // Prefill: the reply can only continue this line, so there is no room for
      // a preamble. Safe here only because thinking is disabled.
      { role: 'assistant', content: 'harness:' },
    ],
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const post = (payload) =>
    fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });

  try {
    let r = await post(body);
    if (!r.ok) {
      // A provider that does not know the `thinking` field rejects the whole
      // request. Falling back with a bigger budget keeps it working there, just
      // slower — better than a router that silently stops routing.
      const { thinking, ...plain } = body;
      r = await post({ ...plain, max_tokens: 512 });
    }
    if (!r.ok) return null;
    const json = await r.json();
    const text = (json?.content ?? [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
      .toLowerCase();
    // Take the first harness name that appears, so "**scout**" and "scout." and
    // "harness: scout" all land. Anything with no known name at all is discarded
    // rather than guessed — a hallucinated mode name would hit resolveMode's
    // fallback, which is the expensive default this whole thing exists to avoid.
    const found = Object.keys(HARNESSES)
      .map((h) => ({ h, at: text.search(new RegExp(`\\b${h}\\b`)) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)[0];
    return found
      ? { harness: found.h, confidence: 0.75, via: 'smol', why: `model chose "${text.trim().slice(0, 40)}"` }
      : null;
  } catch {
    return null; // network blip, timeout, bad key — fall back to the rules answer
  } finally {
    clearTimeout(timer);
  }
}

/** How sure the rules must be before stage 2 is skipped. */
export const CONFIDENCE_FLOOR = 0.75;

/**
 * Where an undecidable task goes.
 *
 * `omp` and not `answer`, deliberately. A task sent to a harness that is merely
 * too expensive costs tokens; a task sent to one that cannot do the job costs a
 * failed turn, a confused user, and a second round trip that pays the whole
 * context again. Wrong-upward is a budget line item, wrong-downward is a bug.
 */
export const FALLBACK = 'omp';

/**
 * The routing decision.
 *
 * `smol: true` allows the model fallback. Without it the rules are a pure
 * function that costs nothing — and abstain often, so the caller gets `omp`.
 * With it, the rules become a free fast-path cache in front of a real
 * classifier: measured on the held-out set, they decide ~1 case in 4 for free
 * and hand the rest to one ~250-token call.
 */
export async function route(task, opts = {}) {
  const rules = routeRules(task);
  if (rules.harness && rules.confidence >= CONFIDENCE_FLOOR) return rules;
  if (opts.smol) {
    const smol = await routeSmol(task, opts);
    if (smol) return smol;
  }
  if (rules.harness) return { ...rules, why: `${rules.why} (low confidence, no stage 2)` };
  return { harness: FALLBACK, confidence: 0.3, via: 'fallback', why: 'no signal and no stage 2 — escalated', scores: rules.scores, hits: rules.hits };
}

// ---- CLI --------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const task = args.filter((a) => !a.startsWith('--')).join(' ');
  if (!task) {
    console.error('usage: route.mjs [--json] [--smol] [--explain] "<task text>"');
    process.exit(2);
  }
  const out = await route(task, { smol: flags.has('--smol') });
  if (flags.has('--json')) {
    console.log(JSON.stringify(out, null, 2));
  } else if (flags.has('--explain')) {
    console.log(`${out.harness}  (${out.confidence.toFixed(2)}, ${out.via})`);
    console.log(`  why: ${out.why}`);
    console.log(`  scores: ${Object.entries(out.scores ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
  } else {
    console.log(out.harness);
  }
}
