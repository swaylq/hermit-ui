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
import path from 'node:path';
import { tmuxPaneName, encodedProjectDir, pickLiveTranscript } from '@hermit-ui/tmux-driver';

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
