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
