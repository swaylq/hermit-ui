// Unit tests for the two PURE derivations the gateway shares with the dashboard:
// the tmux pane name and the ~/.claude/projects transcript-dir encoding. Both are
// duplicated by hand elsewhere (chat-runner.ts:715 inlines the pane name; the
// transcript-dir encoding is copied in session-snapshot). Locking the canonical
// behavior here is what makes the P1 dedup safe — the hand copies must produce
// exactly these strings. Tested from the gateway package because it already
// depends on @hermit-ui/tmux-driver and ships tsx.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmuxPaneName, encodedProjectDir, pickLiveTranscript, parseClaudeSessionIdArg, chunkLiteral, ensureSession, probeInputPath, hardKill, readComposerText, pickComposerLine, pickFocusStealer, dismissFocusStealer } from '@hermit-ui/tmux-driver';

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

// The health check the gateway did not have on 2026-08-10, when a claude kept painting
// its TUI at 0% CPU while its stdin loop was dead: every existing check (pane exists,
// pid alive, composer renders) passed, the message went into the composer, the submit
// Enter was swallowed, and — never having been submitted — it was in no transcript to
// recover from. These panes reproduce that shape exactly:
//
//   deaf  — `stty -echo` + paints a `❯` line + never reads stdin. A real claude TUI puts
//           the terminal in raw/no-echo mode, so when its reader dies the tty echoes
//           nothing either; keys land in the pty and disappear. This is the corpse.
//   alive — same painted line, then a `read` on a normal tty. The kernel line
//           discipline echoes a typed character and erases it on backspace, which is
//           precisely a composer's observable behaviour — so this fixture exercises the
//           net-zero property for real, not just the detection.
//
// The pair is the whole point: 'deaf' is what authorizes killing a process, so the
// tests have to prove BOTH that a corpse is detected and that a live pane never is.
describe('probeInputPath — is anything reading this pane stdin?', () => {
  const haveTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
  const LINE = 'hello world';
  const started: string[] = [];

  // `sh -c` bodies are passed to ensureSession as the "claude binary + args" so the
  // driver's own naming/spawn path is what creates these panes.
  const spawnPane = (body: string) => {
    const sessionId = 'zzprobe' + Math.random().toString(36).slice(2, 8);
    started.push(sessionId);
    const saved = process.env.TMUX;
    delete process.env.TMUX;
    try {
      ensureSession({ sessionId, cwd: os.tmpdir(), claudeBin: '/bin/sh', claudeArgs: ['-c', body] });
    } finally {
      if (saved !== undefined) process.env.TMUX = saved;
    }
    return sessionId;
  };
  const DEAF = `stty -echo; printf '❯ ${LINE}'; sleep 60`;
  const ALIVE = `printf '❯ ${LINE}'; read x; sleep 60`;
  const settle = () => new Promise((r) => setTimeout(r, 700));

  after(() => {
    for (const id of started) spawnSync('tmux', ['kill-session', '-t', tmuxPaneName(id)]);
  });

  it('says DEAF for a pane that paints a composer but never reads stdin', { skip: !haveTmux }, async () => {
    const id = spawnPane(DEAF);
    await settle();
    assert.equal(readComposerText(id), LINE, 'precondition: the composer line is readable');
    assert.equal(await probeInputPath(id, { expectText: LINE, timeoutMs: 2_000 }), 'deaf');
  });

  it('says ALIVE for a pane that consumes the keystroke', { skip: !haveTmux }, async () => {
    const id = spawnPane(ALIVE);
    await settle();
    assert.equal(await probeInputPath(id, { expectText: LINE, timeoutMs: 4_000 }), 'alive');
  });

  // A probe that damages the buffer is worse than no probe: 'alive' means we are about
  // to tell the user "resend / press Enter", and the text they would send must be the
  // text they wrote. So the marker has to be taken back.
  it('leaves the buffer byte-identical on a live pane — a probe must never corrupt the message', { skip: !haveTmux }, async () => {
    const id = spawnPane(ALIVE);
    await settle();
    assert.equal(readComposerText(id), LINE);
    assert.equal(await probeInputPath(id, { expectText: LINE, timeoutMs: 4_000 }), 'alive');
    await settle(); // let the undoing BSpace land
    assert.equal(readComposerText(id), LINE, 'probe must restore the buffer exactly');
  });

  // The guard that decides whether this feature is safe to ship. A permission prompt
  // and the resume picker BOTH paint a `❯`, and a menu ignores a typed character much
  // the way a corpse does — so without this, "claude is waiting for you to approve a
  // tool call" would read as "claude is dead" and we would kill a working session.
  it('refuses to judge when the composer is not holding the message we sent', { skip: !haveTmux }, async () => {
    const id = spawnPane(DEAF);
    await settle();
    assert.equal(
      await probeInputPath(id, { expectText: 'a completely different message', timeoutMs: 2_000 }),
      'inconclusive',
    );
  });

  it('refuses to judge a pane with no composer line at all', { skip: !haveTmux }, async () => {
    const id = spawnPane('stty -echo; sleep 60'); // paints nothing → no ❯
    await settle();
    assert.equal(readComposerText(id), null);
    assert.equal(await probeInputPath(id, { timeoutMs: 2_000 }), 'inconclusive');
  });

  it('refuses to judge a session that does not exist', { skip: !haveTmux }, async () => {
    assert.equal(await probeInputPath('zzprobe-nonexistent-xyz', { timeoutMs: 2_000 }), 'inconclusive');
  });
});

// The kill that has to work on the pane probeInputPath just condemned. `kill()` types
// `/exit` and waits for it to be obeyed — which is exactly what a process that has
// stopped reading stdin cannot do. hardKill signals the pid instead, because signals
// do not travel through stdin.
describe('hardKill — killing a process that cannot hear you', () => {
  const haveTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

  it('removes a pane that ignores everything typed at it', { skip: !haveTmux }, async () => {
    const sessionId = 'zzkill' + Math.random().toString(36).slice(2, 8);
    const saved = process.env.TMUX;
    delete process.env.TMUX;
    try {
      // Ignores SIGTERM too, so the SIGKILL fallback is what has to finish the job.
      ensureSession({
        sessionId,
        cwd: os.tmpdir(),
        claudeBin: '/bin/sh',
        claudeArgs: ['-c', "trap '' TERM; stty -echo; printf '❯ stuck'; sleep 60"],
      });
    } finally {
      if (saved !== undefined) process.env.TMUX = saved;
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(spawnSync('tmux', ['has-session', '-t', tmuxPaneName(sessionId)]).status, 0, 'precondition: pane is up');

    assert.equal(await hardKill(sessionId, 1_500), true);
    assert.notEqual(spawnSync('tmux', ['has-session', '-t', tmuxPaneName(sessionId)]).status, 0, 'pane must be gone');
  });

  it('is a no-op that reports success when the session is already gone', { skip: !haveTmux }, async () => {
    assert.equal(await hardKill('zzkill-nonexistent-xyz'), true);
  });
});

// The composer read that decides whether a message was submitted, whether a pane is
// deaf, and what text is worth rescuing before a kill. It used to be "the last ❯ on
// the screen wins", which held right up until Claude Code started painting widgets
// UNDER the composer that carry a `❯` of their own when focused.
//
// 2026-08-19: a /compact left the published-artifact chip focused. The bottom-up scan
// read the chip as the composer, so the composer was reported as permanently holding
// text; confirmSubmitted never saw 'clear' and pressed Enter ~160 times into a chip
// whose Enter binding is "open the artifact"; probeInputPath diffed a line that could
// not change; the deaf-pane heal never fired. Two messages were typed at that pane and
// vanished, and the log said only "likely unsent".
//
// These frames are transcribed from that pane's `capture-pane` output.
describe('pickComposerLine — the composer is the box, not the last ❯', () => {
  const rule = '─'.repeat(152);
  const WEDGED = [
    '⏺ 循环已停。cron job da38bd9f 删掉了。',
    '',
    '✻ Sautéed for 55s',
    '',
    '❯ /compact',                                    // the echoed prompt, above the box
    '  ⎿  Compacted (ctrl+o to see full summary)',
    '',
    rule,
    '❯ ',                                            // the REAL composer — empty
    rule,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    '❯ ⧉  cat-demo · Enter to open · x to dismiss',   // the chip, holding focus
    '     https://claude.ai/code/artifact/0ec5f10d-e50a-40e4-85b5-21ece682ae9e',
  ];

  it('reads the empty composer as EMPTY even while a focused chip paints its own ❯', () => {
    assert.equal(pickComposerLine(WEDGED), '');
  });

  it('reads buffered text out of the box, not the chip', () => {
    const held = WEDGED.map((l) => (l === '❯ ' ? '❯ 把 cron 时间改成 16:30' : l));
    assert.equal(pickComposerLine(held), '把 cron 时间改成 16:30');
  });

  it('ignores the echoed prompt above the box (a plain idle pane)', () => {
    assert.equal(pickComposerLine(['❯ an earlier turn', '', rule, '❯ ', rule, '  ⏵⏵ bypass permissions on']), '');
  });

  it('reads a multi-line composer from its ❯ line', () => {
    assert.equal(pickComposerLine([rule, '❯ first line', '  second line', rule, '  ⏵⏵ mode']), 'first line');
  });

  // waitForReplReady and the resume-picker driver both depend on a bare ❯ still being
  // found when Claude Code has painted no composer box at all.
  it('falls back to a bare ❯ when there is no box — the resume picker', () => {
    const picker = ['Resume this session?', '❯ 1. Resume from summary (recommended)', '  2. Resume full session as-is'];
    assert.equal(pickComposerLine(picker), '1. Resume from summary (recommended)');
  });

  it('never lets an overlay win the no-box fallback either', () => {
    const noBox = ['❯ 1. Approve', '❯ ⧉  cat-demo · Enter to open · x to dismiss'];
    assert.equal(pickComposerLine(noBox), '1. Approve');
  });

  it('is null for a frame with no ❯ at all (pre-REPL / capture of a blank pane)', () => {
    assert.equal(pickComposerLine(['', 'starting…', '']), null);
  });
});

// The other half: knowing the composer is empty is not enough, because a focused chip
// eats the keystrokes too. Typing into that pane loses the message outright, so the
// send path has to notice and hand focus back first.
describe('pickFocusStealer — has something under the composer taken focus?', () => {
  const rule = '─'.repeat(80);
  const box = [rule, '❯ ', rule, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];

  it('finds the focused artifact chip below the box', () => {
    const got = pickFocusStealer([...box, '❯ ⧉  cat-demo · Enter to open · x to dismiss', '     https://…']);
    assert.match(got ?? '', /cat-demo/);
  });

  it('is null once the chip collapses and gives the ❯ back', () => {
    assert.equal(pickFocusStealer([...box, '  ⧉  cat-demo']), null);
  });

  it('is null on an ordinary pane with nothing under the box', () => {
    assert.equal(pickFocusStealer(box), null);
  });

  it('is null when the composer itself holds the ❯ — the box is never the stealer', () => {
    assert.equal(pickFocusStealer([rule, '❯ typing something', rule, '  ⏵⏵ mode']), null);
  });

  // The verdict authorizes pressing `x` at someone's pane, so an UNRECOGNISED widget
  // below the box must not qualify: a wrong dismissal types a stray character into a
  // message. Only a line that documents its own dismiss key is dismissable.
  it('refuses to judge an unfamiliar widget below the box', () => {
    assert.equal(pickFocusStealer([...box, '❯ some future thing we have never seen']), null);
  });

  it('is null when there is no composer box to be "below" of', () => {
    assert.equal(pickFocusStealer(['❯ 1. Resume from summary', '  2. Resume full session']), null);
  });
});

// dismissFocusStealer against a real pane. The fixture paints the wedged frame and then
// reads stdin, so `x` genuinely lands — proving the driver presses the key the chip
// documents rather than the Enter that only opens the artifact.
describe('dismissFocusStealer — handing focus back to the composer', () => {
  const haveTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
  const started: string[] = [];
  const rule = '─'.repeat(80);

  const spawnPane = (body: string) => {
    const sessionId = 'zzfocus' + Math.random().toString(36).slice(2, 8);
    started.push(sessionId);
    const saved = process.env.TMUX;
    delete process.env.TMUX;
    try {
      ensureSession({ sessionId, cwd: os.tmpdir(), claudeBin: '/bin/sh', claudeArgs: ['-c', body] });
    } finally {
      if (saved !== undefined) process.env.TMUX = saved;
    }
    return sessionId;
  };
  const settle = () => new Promise((r) => setTimeout(r, 700));

  after(() => {
    for (const id of started) spawnSync('tmux', ['kill-session', '-t', tmuxPaneName(id)]);
  });

  // Paints the chip-focused frame, then consumes ONE character (raw mode — the chip's
  // dismiss key is a bare `x`, never a line) and repaints with focus back in the
  // composer, the same collapse the real chip does when dismissed.
  const CHIP = [
    `printf '${rule}\\n❯ \\n${rule}\\n  mode line\\n❯ \\u29c9  cat-demo · Enter to open · x to dismiss\\n'`,
    'stty raw -echo',
    'dd bs=1 count=1 >/dev/null 2>&1',
    'stty sane',
    `printf '\\033[2J\\033[H${rule}\\n❯ \\n${rule}\\n  mode line\\n  \\u29c9  cat-demo\\n'`,
    'sleep 60',
  ].join('; ');

  it('presses x and reports the chip dismissed once the ❯ is back in the box', { skip: !haveTmux }, async () => {
    const id = spawnPane(CHIP);
    await settle();
    assert.equal(await dismissFocusStealer(id, { timeoutMs: 4_000 }), 'dismissed');
    assert.equal(readComposerText(id), '', 'the composer must be readable and empty afterwards');
  });

  it('is a no-op on a pane whose composer already has focus', { skip: !haveTmux }, async () => {
    const id = spawnPane(`printf '${rule}\\n❯ \\n${rule}\\n  mode line\\n'; read k; sleep 60`);
    await settle();
    assert.equal(await dismissFocusStealer(id, { timeoutMs: 2_000 }), 'none');
  });

  // A pane that never consumes the x. The dismissal fails, and the buffer has to come
  // back byte-identical — a stray character prepended to the user's next message is its
  // own corruption.
  it('backs the x out again when the dismissal does not take', { skip: !haveTmux }, async () => {
    const id = spawnPane(`stty -echo; printf '${rule}\\n❯ \\n${rule}\\n  mode line\\n❯ \\u29c9  cat-demo · Enter to open · x to dismiss\\n'; sleep 60`);
    await settle();
    assert.equal(await dismissFocusStealer(id, { timeoutMs: 1_500 }), 'stuck');
  });

  it('is a no-op for a session that does not exist', { skip: !haveTmux }, async () => {
    assert.equal(await dismissFocusStealer('zzfocus-nonexistent-xyz'), 'none');
  });
});
