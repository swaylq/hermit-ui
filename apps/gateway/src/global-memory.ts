// global-memory.ts — mirror this machine's global memory onto disk so Claude Code
// loads it in EVERY agent session, but PROGRESSIVELY:
//
//   L0  always resident — the inline note (edited in the dashboard, stored in the
//       DB) plus any folder file marked `always: true`, written as a managed block
//       in ~/.claude/CLAUDE.md (note verbatim, pinned files as eager @imports).
//   L1  on trigger — ~/.claude/skills/global-memory/SKILL.md, a generated INDEX of
//       the folder (one line per file). Claude Code preloads only its name +
//       description; the body loads when the model reaches for the skill.
//   L2  on demand — the files themselves, read by the agent straight out of
//       ~/.claude/global-memory/**.
//
// Every folder file used to be an @import, and @imports are EAGER — Claude Code
// inlines them into the prompt before the first turn, so the whole folder sat in
// every session on the host. The always-on cost is now O(1) in the folder's size.
//
// Unlike a knowledge base (docs/knowledge-base-design.md), the skill holds NO
// copies: here the folder IS the source of truth (the dashboard's file manager
// writes straight into it), so the index just points at the real absolute paths —
// one copy on disk, nothing to keep in sync.
//
// Both artifacts are rebuilt idempotently from the note + the folder's current
// contents and written only when the rendering actually changes, so repeated ticks
// converge and a no-op tick never touches disk. Disabling drops the block and the
// skill; the folder is always ensured to exist so the user has somewhere to write.
//
// Design: docs/global-memory-progressive-design.md

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { api } from './api';

const START = '<!-- HERMIT-GLOBAL-MEMORY:START — managed by hermit-ui; edit in the dashboard, not here -->';
const END = '<!-- HERMIT-GLOBAL-MEMORY:END -->';
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const MEMORY_DIR = path.join(CLAUDE_DIR, 'global-memory');
const SKILL_DIR = path.join(CLAUDE_DIR, 'skills', 'global-memory');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');

const IMPORTABLE = /\.(md|markdown|mdx|txt)$/i; // only text files make sense as memory
const MAX_FILES = 200; // guard against a pathologically large folder
const HEAD_BYTES = 4096; // enough for frontmatter + a heading + a first line
const TITLE_CHARS = 80;
const SUMMARY_CHARS = 120;
const TOPICS_CHARS = 170; // the topic list inside the always-resident description

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

// ── reading a memory file's metadata ─────────────────────────────────────────

interface MemoryFile {
  abs: string;
  title: string;
  summary: string;
  always: boolean; // frontmatter `always: true` → stays an eager @import (L0)
}

// The head of a file — we only ever need its frontmatter, first heading and first
// prose line, never the body. Not loading the body is the entire point.
function readHead(abs: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, n).toString('utf8');
    // A full read may have stopped mid-character; drop the trailing partial line.
    if (n === HEAD_BYTES) {
      const cut = text.lastIndexOf('\n');
      if (cut > 0) return text.slice(0, cut);
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

// Optional YAML frontmatter: `title`, `summary`, `always`. All three are optional —
// a file with no frontmatter still gets a usable index line (see probeFile), so
// this design needs no edits to existing memory files to start working.
function parseMeta(text: string): { title?: string; summary?: string; always: boolean; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { always: false, body: text };
  const out: { title?: string; summary?: string; always: boolean; body: string } = {
    always: false,
    body: text.slice(m[0].length),
  };
  for (const line of m[1].split(/\r?\n/)) {
    const fm = line.match(/^(title|summary|always):\s*(.*)$/);
    if (!fm) continue;
    const val = fm[2].trim().replace(/^["']|["']$/g, '');
    if (fm[1] === 'always') out.always = /^(true|yes|1|on)$/i.test(val);
    else if (fm[1] === 'title') out.title = val;
    else out.summary = val;
  }
  return out;
}

// Index metadata for one file: explicit frontmatter wins, else the first `# H1`
// (title) and the first non-heading line (summary), else the bare filename.
function probeFile(abs: string): MemoryFile {
  const meta = parseMeta(readHead(abs));
  const lines = meta.body.split(/\r?\n/).map((l) => l.trim());
  const h1 = lines.find((l) => /^#{1,3}\s+\S/.test(l));
  const prose = lines.find((l) => l && !l.startsWith('#') && !l.startsWith('---'));
  const title = meta.title || (h1 ? h1.replace(/^#+\s+/, '') : path.basename(abs).replace(/\.[^.]+$/, ''));
  return {
    abs,
    title: clip(title, TITLE_CHARS),
    summary: clip(meta.summary ?? prose ?? '', SUMMARY_CHARS),
    always: meta.always,
  };
}

// Every importable text file under MEMORY_DIR (recursive, sorted, dotfiles skipped),
// with its index metadata. Absolute paths so both the @import and the index line are
// unambiguous regardless of the agent's CWD.
function collectMemoryFiles(): MemoryFile[] {
  const out: MemoryFile[] = [];
  const walk = (absDir: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(absDir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= MAX_FILES) return;
      if (name.startsWith('.')) continue;
      const abs = path.join(absDir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() && IMPORTABLE.test(name)) out.push(probeFile(abs));
    }
  };
  walk(MEMORY_DIR);
  return out;
}

// ── L0: the ~/.claude/CLAUDE.md managed block ────────────────────────────────

// Existing file with any prior managed block stripped, then a fresh block (note +
// eager @imports for the pinned files) appended at the end — or nothing, if both
// are empty.
function rebuild(existing: string, note: string, imports: string[]): string {
  const strip = new RegExp(`\\n*${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n*`, 'g');
  const base = existing.replace(strip, '\n').trimEnd();
  const importBlock = imports.map((p) => `@${p}`).join('\n');
  const body = [note.trim(), importBlock].filter(Boolean).join('\n\n');
  if (!body) return base ? base + '\n' : '';
  const block = `${START}\n# Global Memory — shared by all agents · edit in the hermit dashboard\n\n${body}\n${END}`;
  return (base ? base + '\n\n' : '') + block + '\n';
}

// ── L1: the generated index skill ────────────────────────────────────────────

function machineLabel(): string {
  return os.hostname().replace(/\.local$/i, '') || 'this machine';
}

// The always-resident sentence: what's inside + when to consult it. A description
// that only names the topic won't fire at the right moment, so the "consult when"
// half is not decoration. Topics come from the files' own titles, so it tracks the
// folder with no second place to edit.
function renderDescription(machine: string, files: MemoryFile[]): string {
  const topics: string[] = [];
  let used = 0;
  for (const f of files) {
    const next = used + f.title.length + 2;
    if (topics.length && next > TOPICS_CHARS) {
      topics.push('…');
      break;
    }
    topics.push(f.title);
    used = next;
  }
  return (
    `Shared memory for this machine (${machine}): ${topics.join('; ')}. ` +
    `Consult it before asking the user for an account, URL, host, path, credential or local convention, ` +
    `and whenever a task touches one of the topics listed here.`
  );
}

function renderSkill(machine: string, files: MemoryFile[]): string {
  const index = files.map((f) => `- \`${f.abs}\` — ${f.summary ? `${f.title} · ${f.summary}` : f.title}`).join('\n');
  return `---
name: global-memory
description: ${JSON.stringify(renderDescription(machine, files))}
hermit_kind: memory
---
# Global Memory — ${machine}

Shared notes for every agent on this machine. Read the specific file below rather
than answering from memory; the paths are absolute and readable as-is.

Documents:
${index}
`;
}

// A SKILL.md is ours iff it carries the hermit_kind: memory marker — the same
// posture as the knowledge-base pruner. A human skill that happens to be named
// global-memory is never overwritten and never deleted.
function isManagedSkill(content: string): boolean {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return !!fm && /(^|\n)hermit_kind:\s*memory\s*(\r?\n|$)/.test(fm[1]);
}

let warnedForeignSkill = false;
function warnForeignSkillOnce(why: string): void {
  if (warnedForeignSkill) return;
  warnedForeignSkill = true;
  console.warn(`[global-memory] ${SKILL_DIR} ${why} — leaving it alone (no memory index will be written)`);
}

// Converge the skill dir on `desired` (null = there should be no skill).
function syncSkill(desired: string | null): void {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(SKILL_MD, 'utf8');
  } catch {
    /* no SKILL.md — either the dir is absent, or it isn't a skill dir at all */
  }

  if (existing !== null && !isManagedSkill(existing)) {
    warnForeignSkillOnce('holds a SKILL.md that is not ours (no hermit_kind: memory)');
    return;
  }

  if (desired === null) {
    // Only ever delete a dir whose SKILL.md we wrote.
    if (existing !== null) {
      fs.rmSync(SKILL_DIR, { recursive: true, force: true });
      console.log('[global-memory] removed the memory index skill (nothing to index)');
    }
    return;
  }

  if (existing === desired) return; // already in sync — never churn the file

  if (existing === null) {
    // A pre-existing non-empty dir with no SKILL.md isn't ours to write into.
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(SKILL_DIR);
    } catch {
      /* absent — ours to create */
    }
    if (entries.length) {
      warnForeignSkillOnce('exists with other contents and no SKILL.md');
      return;
    }
  }

  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.writeFileSync(SKILL_MD, desired);
  console.log(`[global-memory] wrote ${SKILL_MD} (indexing ${desired.split('\n- `').length - 1} files)`);
}

// ── the tick ─────────────────────────────────────────────────────────────────

export async function globalMemoryTick(): Promise<void> {
  let mem: Awaited<ReturnType<typeof api.getGlobalMemory>>;
  try {
    mem = await api.getGlobalMemory();
  } catch {
    return; // dashboard blip — retry next tick
  }

  // Always ensure the folder exists so the user has somewhere to drop files.
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  } catch {
    /* best effort */
  }

  // Disabled → drop the block AND the skill; content stays on disk + in the DB.
  const enabled = mem.enabled !== false;
  const note = enabled ? mem.content ?? '' : '';
  const files = enabled ? collectMemoryFiles() : [];
  const pinned = files.filter((f) => f.always);
  const indexed = files.filter((f) => !f.always);

  let existing = '';
  try {
    existing = fs.readFileSync(CLAUDE_MD, 'utf8');
  } catch {
    /* no ~/.claude/CLAUDE.md yet — we'll create it */
  }
  const desired = rebuild(existing, note, pinned.map((f) => f.abs));
  if (desired !== existing) {
    fs.mkdirSync(path.dirname(CLAUDE_MD), { recursive: true });
    fs.writeFileSync(CLAUDE_MD, desired);
    console.log(
      `[global-memory] synced ${CLAUDE_MD} (note ${note.length} chars, ${pinned.length} always-on import(s))`,
    );
  }

  syncSkill(indexed.length ? renderSkill(machineLabel(), indexed) : null);
}
