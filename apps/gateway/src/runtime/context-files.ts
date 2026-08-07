// The machine's global memory, in a form the pi engine can be handed.
//
// The gateway mirrors global memory into ~/.claude/CLAUDE.md (global-memory.ts)
// because Claude Code loads that path automatically. Of the two pi-backend
// engines, only one follows:
//
//   omp  — loads it already, in every auth mode, and needs NOTHING from here.
//          It builds a PROJECT system block containing a <repo-rules> section
//          with the agent's AGENTS.md/CLAUDE.md *and* ~/.claude/CLAUDE.md, and
//          it expands the `@import` lines while doing so. Verified on the wire
//          2026-08-07 (captured from a live request): the block carried
//          "Global Memory", "secret exec" and "secrets.age" — the last two
//          existing only inside the imported secrets-usage.md. That block also
//          survives the subscription path, where --system-prompt is reduced to
//          a gate and its CONTENT is discarded. So adding global memory to that
//          prompt would be dropped on subscription machines and duplicated on
//          the others. Do not re-add it.
//
//   pi   — does not. Its resource loader walks CWD's ANCESTORS for
//          AGENTS.md/CLAUDE.md, and ~/.claude/ is not an ancestor of an agent
//          directory. Verified the same way: pi's request carried the agent's
//          own AGENTS.md but no "HERMIT-GLOBAL-MEMORY" marker and no "Global
//          Memory" heading, in either auth mode.
//
// Hence one job: read it, expand the imports, hand it to pi.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code's own nesting limit for @imports. */
const MAX_IMPORT_DEPTH = 5;
/**
 * Ceiling on the text handed to a child. It rides on every turn of every
 * session, so a pathological memory folder must not quietly become a six-figure
 * token bill per message.
 */
export const MAX_CONTEXT_CHARS = 200_000;

/**
 * An `@import` line, as global-memory.ts writes them: the whole line is `@`
 * followed by a path.
 *
 * Requiring a path-shaped target is what keeps prose safe. Claude Code also
 * honours `@name` inline, but this text is full of `@anthropic-ai/...` package
 * names and `@handle` mentions, and turning one of those into a failed file
 * read — or worse, a read of something that happens to exist — is a bad trade
 * for a syntax the gateway itself never emits.
 */
const IMPORT_LINE = /^@(\/|~\/|\.\.?\/)([^\s]*)$/;

function readSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function resolveImport(target: string, baseDir: string): string {
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
  return path.resolve(baseDir, target);
}

/**
 * Inline every `@import` in `text`, depth-first.
 *
 * `seen` carries the whole ancestry, so a file that imports itself — directly
 * or round a cycle — is dropped rather than expanded forever. An import that
 * cannot be read is left as its original line: silently deleting it would hide
 * a broken memory file, and the literal line at least shows up in the prompt.
 */
export function expandImports(
  text: string,
  baseDir: string,
  seen: ReadonlySet<string> = new Set(),
  depth = 0,
): string {
  if (depth >= MAX_IMPORT_DEPTH) return text;
  return text.split('\n').map((line) => {
    const m = IMPORT_LINE.exec(line.trim());
    if (!m) return line;
    const file = resolveImport(`${m[1]}${m[2]}`, baseDir);
    if (seen.has(file)) return line;
    const body = readSafe(file);
    if (body === null) return line;
    return expandImports(body.trimEnd(), path.dirname(file), new Set([...seen, file]), depth + 1);
  }).join('\n');
}

/**
 * Global memory as one block of text, imports inlined and size capped.
 *
 * Empty when the machine has none — the caller then passes no flag at all,
 * rather than an empty one.
 */
export function globalMemoryPrompt(
  claudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md'),
): string {
  const raw = readSafe(claudeMd);
  if (!raw?.trim()) return '';
  const out = expandImports(raw, path.dirname(claudeMd), new Set([claudeMd])).trim();
  if (out.length <= MAX_CONTEXT_CHARS) return out;
  console.warn(`[context-files] global memory is ${out.length} chars; truncated to ${MAX_CONTEXT_CHARS}`);
  return `${out.slice(0, MAX_CONTEXT_CHARS)}\n\n[global memory truncated]`;
}
