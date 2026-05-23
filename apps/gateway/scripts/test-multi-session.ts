// Multi-session test for the tmux-driver.
//
// Spawns two tmux panes with the fake-claude stub, each pretending to be a
// different ChatSession. Verifies:
//   - Both tmux panes are alive at the same time.
//   - Each session gets its own JSONL transcript in ~/.claude/projects/.
//   - watchTranscript fires on the events from its own JSONL only (no
//     cross-talk between sessions).
//
// Exits 0 on pass, 1 on any failure. Cleans up tmux + JSONL on exit.
//
// Run:
//   cd apps/gateway && npx tsx scripts/test-multi-session.ts

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { randomUUID } from 'node:crypto';
import {
  ensureSession,
  awaitTranscript,
  watchTranscript,
  encodedProjectDir,
  tmuxSessionExists,
  kill as killSession,
} from '@hermit-ui/tmux-driver';

const FAKE_CLAUDE = new URL('./fake-claude.sh', import.meta.url).pathname;
// agents/alpha exists from M2 scaffold. Use it as cwd for both sessions.
const ALPHA_CWD = '/Users/mac/claudeclaw/asst/hermit-ui/agents/alpha';

const sid = (label: string) => `test-${label}-${randomBytes(4).toString('hex')}`;

function check(label: string, cond: boolean) {
  console.log((cond ? '✓ ' : '✖ ') + label);
  if (!cond) process.exitCode = 1;
}

interface EventBuffer {
  events: any[];
  stop: () => void;
}

async function spinUp(sessionId: string): Promise<{ uuid: string; jsonl: string; buf: EventBuffer }> {
  // Pre-assign uuid — eliminates the parallel-spawn race where two sessions
  // sharing the same cwd both pick "the new jsonl" and end up watching the
  // same file. fake-claude.sh takes the uuid as its first positional arg.
  const uuid = randomUUID();
  const { name, created } = ensureSession({
    sessionId,
    cwd: ALPHA_CWD,
    claudeBin: FAKE_CLAUDE,
    claudeArgs: [uuid],
    // We pass uuid via claudeArgs instead of claudeSessionUuid because
    // fake-claude takes it positionally; real claude would use --session-id
    // which ensureSession appends when claudeSessionUuid is set.
  });
  check(`session ${sessionId}: tmux pane created (${name})`, created);

  const jsonl = join(encodedProjectDir(ALPHA_CWD), `${uuid}.jsonl`);
  await awaitTranscript(jsonl, 5_000);
  check(`session ${sessionId}: JSONL appeared (${uuid.slice(0, 8)})`, existsSync(jsonl));

  const events: any[] = [];
  const stop = watchTranscript(jsonl, (ev) => events.push(ev));

  return { uuid, jsonl, buf: { events, stop } };
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const sidA = sid('a');
  const sidB = sid('b');

  console.log(`\n--- spinning up two sessions in parallel ---`);
  const [a, b] = await Promise.all([spinUp(sidA), spinUp(sidB)]);

  // Give watchers + fake-claude a moment to flush.
  await sleep(800);

  // ── Assertions ─────────────────────────────────────────────────────────────

  check('panes have distinct claude UUIDs', a.uuid !== b.uuid);
  check('panes have distinct JSONL paths', a.jsonl !== b.jsonl);
  check('both tmux panes alive', tmuxSessionExists(sidA) && tmuxSessionExists(sidB));

  // Each watcher should have observed its own JSONL's events only — no cross-talk.
  // fake-claude writes: 1 permission-mode + 1 user + 1 assistant = 3 events.
  // (The user/assistant uuids embed `-${uuid}` so we can verify isolation.)
  const aUuidsSeen = a.buf.events.map((e: any) => e.uuid).filter(Boolean);
  const bUuidsSeen = b.buf.events.map((e: any) => e.uuid).filter(Boolean);
  console.log(`  watcher A events: ${a.buf.events.length} (uuids: ${aUuidsSeen.length})`);
  console.log(`  watcher B events: ${b.buf.events.length} (uuids: ${bUuidsSeen.length})`);

  check('watcher A saw user + assistant events', aUuidsSeen.length >= 2);
  check('watcher B saw user + assistant events', bUuidsSeen.length >= 2);

  const aUuidEmbedded = aUuidsSeen.some((u: string) => u.endsWith(`-${a.uuid}`));
  const bUuidEmbedded = bUuidsSeen.some((u: string) => u.endsWith(`-${b.uuid}`));
  check('watcher A saw its own uuid-tagged events', aUuidEmbedded);
  check('watcher B saw its own uuid-tagged events', bUuidEmbedded);

  // Cross-contamination: A should NOT have seen any of B's tagged events.
  const aSawB = aUuidsSeen.some((u: string) => u.endsWith(`-${b.uuid}`));
  const bSawA = bUuidsSeen.some((u: string) => u.endsWith(`-${a.uuid}`));
  check('watcher A did NOT see B events', !aSawB);
  check('watcher B did NOT see A events', !bSawA);

  // ── Cleanup ────────────────────────────────────────────────────────────────

  console.log(`\n--- cleanup ---`);
  a.buf.stop();
  b.buf.stop();
  await Promise.all([killSession(sidA, 500), killSession(sidB, 500)]);
  for (const j of [a.jsonl, b.jsonl]) {
    try { if (existsSync(j)) unlinkSync(j); } catch {}
  }
  check('panes killed after test', !tmuxSessionExists(sidA) && !tmuxSessionExists(sidB));
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
