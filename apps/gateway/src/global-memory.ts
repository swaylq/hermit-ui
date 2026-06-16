// global-memory.ts — mirror the dashboard's single shared note into this host's
// ~/.claude/CLAUDE.md so Claude Code auto-injects it into EVERY agent session.
//
// We keep a delimited managed block at the end of ~/.claude/CLAUDE.md and leave
// everything else untouched. Edits happen in the dashboard (Settings → Global
// Memory); this just pulls + writes-on-change. Clearing the note removes the
// block. The block is rebuilt idempotently (strip-then-append), so repeated ticks
// converge and a no-op tick never rewrites the file.

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { api } from './api';

const START = '<!-- HERMIT-GLOBAL-MEMORY:START — managed by hermit-ui; edit in the dashboard, not here -->';
const END = '<!-- HERMIT-GLOBAL-MEMORY:END -->';
const CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Existing file with any prior managed block stripped, then the current note
// appended as a fresh block at the end (or nothing, if the note is empty).
function rebuild(existing: string, content: string): string {
  const strip = new RegExp(`\\n*${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n*`, 'g');
  const base = existing.replace(strip, '\n').trimEnd();
  const note = content.trim();
  if (!note) return base ? base + '\n' : '';
  const block = `${START}\n# Global Memory — shared by all agents · edit in the hermit dashboard\n\n${note}\n${END}`;
  return (base ? base + '\n\n' : '') + block + '\n';
}

export async function globalMemoryTick(): Promise<void> {
  let mem: Awaited<ReturnType<typeof api.getGlobalMemory>>;
  try {
    mem = await api.getGlobalMemory();
  } catch {
    return; // dashboard blip — retry next tick
  }

  let existing = '';
  try {
    existing = fs.readFileSync(CLAUDE_MD, 'utf8');
  } catch {
    /* no ~/.claude/CLAUDE.md yet — we'll create it */
  }

  const desired = rebuild(existing, mem.content ?? '');
  if (desired === existing) return; // already in sync — never churn the file

  fs.mkdirSync(path.dirname(CLAUDE_MD), { recursive: true });
  fs.writeFileSync(CLAUDE_MD, desired);
  console.log(`[global-memory] synced ${CLAUDE_MD} (${(mem.content ?? '').length} chars)`);
}
