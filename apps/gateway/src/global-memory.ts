// global-memory.ts — mirror the dashboard's global memory into this host's
// ~/.claude/CLAUDE.md so Claude Code auto-injects it into EVERY agent session.
//
// Two sources, both per-machine:
//   1. the inline note (edited in the dashboard, stored in the DB), and
//   2. text files the user drops in ~/.claude/global-memory/ (browsed/authored
//      via the dashboard's file manager) — referenced into CLAUDE.md as `@…`
//      imports, which Claude Code resolves and loads.
// We keep one delimited managed block at the end of ~/.claude/CLAUDE.md and leave
// everything else untouched. The block is rebuilt idempotently (strip-then-append)
// from the note + the folder's current contents, so repeated ticks converge and a
// no-op tick never rewrites the file. Disabling drops the block (note + imports);
// the folder is always ensured to exist so the user has somewhere to write.

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { api } from './api';

const START = '<!-- HERMIT-GLOBAL-MEMORY:START — managed by hermit-ui; edit in the dashboard, not here -->';
const END = '<!-- HERMIT-GLOBAL-MEMORY:END -->';
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const MEMORY_DIR = path.join(CLAUDE_DIR, 'global-memory');

const IMPORTABLE = /\.(md|markdown|mdx|txt)$/i; // only text files make sense as @imports
const MAX_IMPORTS = 200; // guard against a pathologically large folder

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Absolute paths of the importable text files under MEMORY_DIR (recursive, sorted,
// dotfiles skipped). Absolute so the @import is unambiguous regardless of CWD.
function collectImports(): string[] {
  const out: string[] = [];
  const walk = (absDir: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(absDir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= MAX_IMPORTS) return;
      if (name.startsWith('.')) continue;
      const abs = path.join(absDir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() && IMPORTABLE.test(name)) out.push(abs);
    }
  };
  walk(MEMORY_DIR);
  return out;
}

// Existing file with any prior managed block stripped, then a fresh block (note +
// @imports) appended at the end — or nothing, if both are empty.
function rebuild(existing: string, note: string, imports: string[]): string {
  const strip = new RegExp(`\\n*${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n*`, 'g');
  const base = existing.replace(strip, '\n').trimEnd();
  const importBlock = imports.map((p) => `@${p}`).join('\n');
  const body = [note.trim(), importBlock].filter(Boolean).join('\n\n');
  if (!body) return base ? base + '\n' : '';
  const block = `${START}\n# Global Memory — shared by all agents · edit in the hermit dashboard\n\n${body}\n${END}`;
  return (base ? base + '\n\n' : '') + block + '\n';
}

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

  let existing = '';
  try {
    existing = fs.readFileSync(CLAUDE_MD, 'utf8');
  } catch {
    /* no ~/.claude/CLAUDE.md yet — we'll create it */
  }

  // Disabled → drop the block (no note, no imports); content stays on disk + in the DB.
  const enabled = mem.enabled !== false;
  const note = enabled ? mem.content ?? '' : '';
  const imports = enabled ? collectImports() : [];
  const desired = rebuild(existing, note, imports);
  if (desired === existing) return; // already in sync — never churn the file

  fs.mkdirSync(path.dirname(CLAUDE_MD), { recursive: true });
  fs.writeFileSync(CLAUDE_MD, desired);
  console.log(`[global-memory] synced ${CLAUDE_MD} (note ${note.length} chars, ${imports.length} imports)`);
}
