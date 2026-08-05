// Unit tests for the two PURE derivations the gateway shares with the dashboard:
// the tmux pane name and the ~/.claude/projects transcript-dir encoding. Both are
// duplicated by hand elsewhere (chat-runner.ts:715 inlines the pane name; the
// transcript-dir encoding is copied in session-snapshot). Locking the canonical
// behavior here is what makes the P1 dedup safe — the hand copies must produce
// exactly these strings. Tested from the gateway package because it already
// depends on @hermit-ui/tmux-driver and ships tsx.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmuxPaneName, encodedProjectDir, pickLiveTranscript, parseClaudeSessionIdArg, chunkLiteral, ensureSession } from '@hermit-ui/tmux-driver';

describe('tmuxPaneName', () => {
  it('keeps the last 12 id chars behind the hermit- prefix', () => {
    assert.equal(tmuxPaneName('abcdefghijklmnop'), 'hermit-efghijklmnop');
  });
  it('sanitizes non [a-zA-Z0-9_-] chars to underscore before slicing', () => {
    assert.equal(tmuxPaneName('abc/def.ghi xyz'), 'hermit-_def_ghi_xyz');
  });
  it('is stable for a realistic cuid session id', () => {
    const id = 'cmpqobvdi004zpvp6alyk63m4';
    assert.equal(tmuxPaneName(id), `hermit-${id.slice(-12)}`);
  });
});

describe('encodedProjectDir', () => {
  it('replaces every / with - under ~/.claude/projects', () => {
    assert.equal(
      encodedProjectDir('/Users/mac/claudeclaw/asst'),
      path.join(os.homedir(), '.claude', 'projects', '-Users-mac-claudeclaw-asst'),
    );
  });
});

// The shared uuid-drift adoption pick (P1-5 Part B) — one helper replacing the two
// open-coded copies in chat-runner (reattach drift) and cron-runner (freshly-spawned
// drift). Pure over (transcripts, opts, now), so each exclusion source + time bound the
// two callers relied on is locked here.
describe('pickLiveTranscript', () => {
  const NOW = 1_000_000_000_000; // fixed clock — deterministic, no Date.now()
  const t = (uuid: string, mtimeMs: number, size = 10) => ({ uuid, size, mtimeMs });

  it('picks the newest non-empty transcript', () => {
    const got = pickLiveTranscript(
      [t('a', NOW - 5000), t('b', NOW - 1000), t('c', NOW - 9000)],
      { exclude: new Set() }, NOW,
    );
    assert.equal(got?.uuid, 'b');
  });
  it('skips empty (size 0) transcripts', () => {
    const got = pickLiveTranscript(
      [t('a', NOW - 1000, 0), t('b', NOW - 5000, 10)],
      { exclude: new Set() }, NOW,
    );
    assert.equal(got?.uuid, 'b');
  });
  it('skips excluded uuids (recorded self + sibling / pinned)', () => {
    const got = pickLiveTranscript(
      [t('self', NOW - 1000), t('sibling', NOW - 2000), t('live', NOW - 3000)],
      { exclude: new Set(['self', 'sibling']) }, NOW,
    );
    assert.equal(got?.uuid, 'live');
  });
  it('respects maxAgeMs upper bound (chat FRESH_MS case)', () => {
    const got = pickLiveTranscript(
      [t('old', NOW - 10 * 60_000), t('fresh', NOW - 60_000)],
      { exclude: new Set(), maxAgeMs: 5 * 60_000 }, NOW,
    );
    assert.equal(got?.uuid, 'fresh'); // 'old' is >5min → excluded
  });
  it('with no maxAgeMs, adopts even an old transcript (pruned-recorded case)', () => {
    const got = pickLiveTranscript([t('old', NOW - 60 * 60_000)], { exclude: new Set() }, NOW);
    assert.equal(got?.uuid, 'old');
  });
  it('respects minMtimeMs lower bound (cron started-at case)', () => {
    const got = pickLiveTranscript(
      [t('before', NOW - 10_000), t('after', NOW - 1_000)],
      { exclude: new Set(), minMtimeMs: NOW - 5_000 }, NOW,
    );
    assert.equal(got?.uuid, 'after'); // 'before' is < minMtimeMs → excluded
  });
  it('returns null when nothing qualifies', () => {
    assert.equal(pickLiveTranscript([], { exclude: new Set() }, NOW), null);
    assert.equal(pickLiveTranscript([t('x', NOW, 0)], { exclude: new Set() }, NOW), null);
  });
});

// The recovery path for a pane whose uuid never reached the DB (first sync eaten
// by a timeout / a gateway restart within seconds of the spawn): the gateway
// launched claude itself, so its argv is ground truth about which transcript the
// pane writes. Before this, such a pane stayed untracked and the session sat on
// "starting" forever while the pane worked (2026-07-25 finance-agent).
describe('parseClaudeSessionIdArg', () => {
  const UUID = 'c00c2040-f0d0-4d78-8b7a-e51d1a9da0b3';
  it('pulls --session-id out of a real spawn argv (uuid sits after the mcp-config blob)', () => {
    const argv = `claude --dangerously-skip-permissions --mcp-config {"mcpServers":{"hermit":{"command":"node"}}} --effort max --session-id ${UUID}`;
    assert.equal(parseClaudeSessionIdArg(argv), UUID);
  });
  it('accepts the --flag=value form', () => {
    assert.equal(parseClaudeSessionIdArg(`claude --session-id=${UUID}`), UUID);
  });
  it('falls back to --resume when there is no --session-id', () => {
    assert.equal(parseClaudeSessionIdArg(`claude --resume ${UUID} --effort max`), UUID);
  });
  it('prefers --session-id over --resume — post-resume uuids drift, the assigned one does not', () => {
    const other = '910c1baa-9c3b-43dd-b570-e64a3af62669';
    assert.equal(parseClaudeSessionIdArg(`claude --resume ${other} --session-id ${UUID}`), UUID);
  });
  it('normalizes case so it compares equal to the transcript filename', () => {
    assert.equal(parseClaudeSessionIdArg(`claude --session-id ${UUID.toUpperCase()}`), UUID);
  });
  it('returns null when the pane runs something else entirely', () => {
    assert.equal(parseClaudeSessionIdArg('claude --dangerously-skip-permissions'), null);
    assert.equal(parseClaudeSessionIdArg('-zsh'), null);
    assert.equal(parseClaudeSessionIdArg('claude --session-id not-a-uuid'), null);
  });
});

// The send-keys size rule. tmux packs a command into one 16 KiB imsg and refuses
// anything larger ("command too long"), which is how a 21 KB pasted document — a
// single 20.5 KB line — never reached the pane and left the chat on "starting"
// (2026-07-31). Chunking has to respect BOTH the byte ceiling and character
// boundaries: this text is routinely Chinese, 3 bytes per char.
describe('chunkLiteral', () => {
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

  it('leaves a line that already fits as one piece', () => {
    assert.deepEqual(chunkLiteral('hello'), ['hello']);
    assert.deepEqual(chunkLiteral(''), ['']);
  });

  it('splits an oversized ASCII line into pieces under the ceiling', () => {
    const line = 'a'.repeat(20_000);
    const pieces = chunkLiteral(line);
    assert.ok(pieces.length > 1);
    for (const p of pieces) assert.ok(bytes(p) <= 4096, `piece is ${bytes(p)} bytes`);
    assert.equal(pieces.join(''), line);
  });

  it('never splits a multi-byte character — pieces rejoin byte-identical', () => {
    const line = '金融产品网络营销管理办法'.repeat(600); // ~21 KB of 3-byte chars
    const pieces = chunkLiteral(line);
    assert.ok(pieces.length > 1);
    for (const p of pieces) {
      assert.ok(bytes(p) <= 4096);
      // A cut mid-sequence would show up as U+FFFD on the decode round-trip.
      assert.equal(Buffer.from(p, 'utf8').toString('utf8'), p);
      assert.ok(!p.includes('�'));
    }
    assert.equal(pieces.join(''), line);
  });

  it('keeps surrogate pairs whole', () => {
    const line = '🐟'.repeat(2000); // 4 bytes each
    const pieces = chunkLiteral(line);
    for (const p of pieces) {
      assert.ok(bytes(p) <= 4096);
      assert.ok(!p.includes('�'));
    }
    assert.equal(pieces.join(''), line);
  });

  it('honours a custom ceiling, and a char wider than it still goes out whole', () => {
    assert.deepEqual(chunkLiteral('abcdef', 2), ['ab', 'cd', 'ef']);
    assert.deepEqual(chunkLiteral('🐟🐟', 2), ['🐟', '🐟']);
  });
});

// The lie that took sway003's message path down after a reboot: with $TMUX pointing at
// a dead server, `tmux new-session -d` exits 0 and creates nothing. ensureSession used
// to believe the exit code. These run against real tmux; skipped where it isn't
// installed (CI, a Linux box without it).
describe('ensureSession vs a stale $TMUX', () => {
  const haveTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
  const opts = () => ({
    sessionId: 'zzprobe' + Math.random().toString(36).slice(2, 8),
    cwd: os.tmpdir(),
    claudeBin: '/bin/sh',
    claudeArgs: ['-c', 'sleep 30'],
  });

  it('creates a real session when the environment is clean', { skip: !haveTmux }, () => {
    const o = opts();
    const saved = process.env.TMUX;
    delete process.env.TMUX;
    try {
      const r = ensureSession(o as Parameters<typeof ensureSession>[0]);
      assert.equal(r.created, true);
      assert.equal(spawnSync('tmux', ['has-session', '-t', r.name]).status, 0, 'session should exist');
      spawnSync('tmux', ['kill-session', '-t', r.name]);
    } finally {
      if (saved !== undefined) process.env.TMUX = saved;
    }
  });

  // Production shape: the socket path inherited from $TMUX sits in a directory that no
  // longer exists (a reboot cleared /tmp). tmux only mkdirs the socket dir when IT
  // derives the path — given one, it just binds, gets ENOENT, and still exits 0.
  it('THROWS instead of reporting a phantom session when $TMUX is dead', { skip: !haveTmux }, () => {
    const o = opts();
    const saved = process.env.TMUX;
    process.env.TMUX = '/private/tmp/tmux-501-gone-after-reboot/default,999,1';
    try {
      assert.throws(
        () => ensureSession(o as Parameters<typeof ensureSession>[0]),
        /does not exist/,
        'a session tmux did not create must not be reported as created',
      );
      assert.notEqual(spawnSync('tmux', ['has-session', '-t', tmuxPaneName(o.sessionId)]).status, 0);
    } finally {
      if (saved === undefined) delete process.env.TMUX;
      else process.env.TMUX = saved;
    }
  });
});
