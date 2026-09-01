import fs from 'node:fs';
import path from 'node:path';

// Pure-chat mode: the read-only tool surface, one definition per backend family.
//
// A pure-chat session can look at files and search the web; it cannot write,
// edit, run commands or spawn sub-agents. The point is a fast conversational
// turn — analysis and opinion, no side effects — so the enforcement has to
// REMOVE the tools rather than refuse them per call: a tool the model cannot
// see is a tool it does not waste a round trip trying.
//
// There is no shared mechanism. Every backend's write tools (bash / write /
// edit / apply_patch / ipython) ship inside its own CLI — not one of them is
// forwarded by the gateway — so each family gets its own switch, and they are
// listed side by side here so the lists cannot drift apart unnoticed.
// docs/chat-only-mode.md has the full per-backend table.

/**
 * Claude Code (claude-sdk and claude-tmux), for `--tools` / the SDK's `tools`.
 *
 * Verified against claude 2.1.251 by reading the `init` event's tool list back:
 * with this flag the session's tools ARE exactly this set — Bash, Write, Edit
 * and Task are not refused, they are absent from the model's tool table.
 *
 * Two findings worth keeping:
 *  · `--tools` only governs BUILT-IN tools. The hermit MCP surface
 *    (mcp__hermit__ask, attach_file, …) is untouched, which is what still lets
 *    a pure-chat session hand the user a file or ask them a question.
 *  · `TodoWrite` is deliberately absent: it is not accepted by `--tools` (pass
 *    it and it simply does not appear), and a pure-chat turn has no use for it.
 *    Do not "fix" this by adding it back — verify before you trust a name here,
 *    because an unrecognised one is dropped SILENTLY.
 *
 * Not `--restricted`: that flag refuses bypassPermissions, which both Claude
 * paths pass. `--tools` coexists with it (verified).
 */
export const CHAT_ONLY_CLAUDE_TOOLS = ['Read', 'Grep', 'Glob', 'Skill', 'WebFetch', 'WebSearch'];

/**
 * pi — all 7 built-ins are read, bash, edit, write, grep, find, ls; this is the
 * read-only 4. pi's own docs give the same recipe, and the shipped `scout` mode
 * already uses it. buildModeArgs unions the hermit extension tools on top.
 */
export const CHAT_ONLY_PI_TOOLS = ['read', 'grep', 'find', 'ls'];

/**
 * The pure-chat write tool, registered by the shared hermit pi extension.
 *
 * It has to be NAMED in pi's and prime's allowlists because their `--tools`
 * covers extension tools as well as built-ins — leave it out and the mode's
 * only route to disk is filtered away. omp's `--tools` covers built-ins only,
 * so naming it there would hard-error the spawn instead. Same asymmetry that
 * governs HERMIT_TOOL_NAMES, and the same trap.
 */
export const CHAT_ONLY_MEMORY_TOOL = 'memory_write';

/**
 * omp — a read-only subset of its 31 built-ins.
 *
 * Two traps, both different from pi:
 *  · omp's `--tools` covers built-ins ONLY, and an unknown name is a HARD spawn
 *    error (not a silent drop). So this list must never union the hermit tool
 *    names the way pi's does — the extension tools are unaffected by the flag
 *    and remain available regardless.
 *  · `yield` must stay in: it is how the child ends a turn.
 *
 * Left out on purpose: bash/write/edit/ast_edit/memory_edit/retain/learn/
 * manage_skill (mutate), task/hub (sub-agents), browser/computer/github
 * (act on the outside), eval/debug/security_scan (run code), checkpoint/rewind
 * (session state), goal (unclear — excluded until someone checks).
 */
export const CHAT_ONLY_OMP_TOOLS = [
  'read', 'glob', 'grep', 'ast_grep', 'lsp', 'inspect_image',
  'todo', 'web_search', 'recall', 'reflect', 'yield',
];

// prime deliberately has no list here. Its entire built-in surface is ONE tool,
// `ipython` — a persistent Python kernel in which reading, writing, running
// commands and spawning sub-agents all happen — so there is no read-only subset
// to name. prime-rpc.ts passes hermit's extension tool names and nothing else,
// which leaves a session that can talk and hand things over but cannot even
// read a file. See the comment at that call site.

// ── the startup preamble ────────────────────────────────────────────────────
// Measured on this fleet before it existed: a pure-chat claude session opening
// in an agent directory spent SIX Read calls and seven turns reading its own
// operating files before answering "hello", because the agent's own bootstrap
// instruction is a single `cat` of six files and the mode had just taken away
// the shell that runs it. The read-only mode made that agent SLOWER, which is
// the exact opposite of the point.
//
// The fix is not to hand the shell back — it is to stop making the child fetch
// what we could simply have given it. With this preamble the same session
// answers in ONE turn with zero tool calls, and the context drops from 27k to
// 11k.
//
// Every backend with a system-prompt hook gets this. codex has none, so it
// receives the same text as a prefix on its first prompt instead; dsh has
// neither and is documented as unable to honour this half of the mode.

/** What the mode is, in the child's own terms. Always sent. */
const PURE_CHAT_RULES = [
  'PURE-CHAT SESSION. Your tools are read-only: no shell, no writing or editing',
  'files, no sub-agents, no scheduling. Two consequences, and the second one is',
  'the one that costs people time:',
  '',
  '1. Do NOT start by running a bootstrap or startup routine over your operating',
  '   files. You cannot — the shell is gone — and falling back to reading them',
  '   one at a time costs a round trip each while the person waits. Whatever you',
  '   need to know about yourself is below.',
  '2. Answer from what is in front of you. Look something up only when the answer',
  '   genuinely turns on it, and then read ONE file or run ONE search rather than',
  '   sweeping. The person picked this mode to get a fast, considered reply — not',
  '   a thorough investigation.',
  '',
  'You can still remember things: memory_write appends to your own memory files.',
].join('\n');

/**
 * The system-prompt text for a pure-chat session: the rules above, plus the
 * agent's own short brief from CHAT.md if it wrote one.
 *
 * CHAT.md is the agent's compressed self — identity, language, reply style, how
 * to search its memory — in one or two KB. It exists because the full operating
 * files are far too big to inject on every turn (this agent's are 27KB) and far
 * too important to drop: without them the child answers in the wrong language,
 * at the wrong length, as nobody in particular.
 *
 * Absent, the session still works and still stops making the six-read mistake;
 * it just has no personality. That degradation is deliberate — a missing file
 * must not be able to break a session.
 */
export function chatOnlyPreamble(agentDirectory: string): string {
  let brief = '';
  try {
    brief = fs.readFileSync(path.join(agentDirectory, 'CHAT.md'), 'utf8').trim();
  } catch {
    brief = '';
  }
  if (!brief) return PURE_CHAT_RULES;
  return `${PURE_CHAT_RULES}

── who you are ──

${brief}`;
}
