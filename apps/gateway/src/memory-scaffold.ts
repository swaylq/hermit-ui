// memory-scaffold.ts — create a new agent's own memory store.
//
// It cannot ship as template content: the template's .gitignore ignores the
// whole `memory/` folder (everything in it is personal), so git would drop it.
// And it cannot be skipped either — AGENTS.md sends a fresh agent to
// `memory/notes/INDEX.md`, and pointing "search before you answer" at a folder
// that does not exist is how that rule quietly degrades into guessing. That is
// the same failure that hid for two weeks when CLAUDE.md went missing: no
// error, just no memory.
import fs from 'node:fs';
import path from 'node:path';

// One line per note, because the note that isn't listed is the note nobody finds.
export const MEMORY_INDEX_SEED = `# INDEX.md — one line per note

Every file in \`memory/notes/\` gets a line here: a link, then the one-sentence version.
This index is what future-you greps.

    - [Short Title](slug.md) — the one-sentence version

Nothing writes this for you: Claude Code's built-in auto-memory is off machine-wide
(\`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1\` in \`~/.claude/settings.json\`). If you don't write
it down, it isn't remembered.
`;

/** Create `<agentDir>/memory/notes/` and seed INDEX.md. Never clobbers an
 *  existing index — restoring a trashed agent or overlaying a marketplace
 *  template must not wipe notes the agent already wrote. */
export function seedMemoryStore(agentDir: string): void {
  const notes = path.join(agentDir, 'memory', 'notes');
  fs.mkdirSync(notes, { recursive: true });
  const index = path.join(notes, 'INDEX.md');
  if (!fs.existsSync(index)) fs.writeFileSync(index, MEMORY_INDEX_SEED);
}
