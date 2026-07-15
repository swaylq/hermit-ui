// Unit tests for the width-independent "is this session working?" primitives in
// pane.ts — the ground-truth signals behind session status + the delivery gate.
// They're pure (given a file / string), so they're the natural first safety net
// for the code-quality cleanup: they lock the behavior recent bug fixes
// established (58e09c2 transcript-fresh, b87fab2 newestLineIsTurn metadata guard)
// so later refactors can't silently regress it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORK_MARKER_RE, newestLineIsTurn, transcriptFresh, sessionTranscriptPath } from './pane';

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-pane-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Write a JSONL transcript whose lines are the given events (objects → JSON).
function writeTranscript(name: string, events: Array<Record<string, unknown>>): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

describe('WORK_MARKER_RE', () => {
  it('matches the in-flight spinner timer', () => {
    assert.ok(WORK_MARKER_RE.test('✶ Considering… (6m 44s · thinking)'));
    assert.ok(WORK_MARKER_RE.test('✽ Warping… (10s · ↓ 43.1k tokens)'));
  });
  it('matches the bottom-mode-line interrupt hint', () => {
    assert.ok(WORK_MARKER_RE.test('· esc to interrupt'));
    assert.ok(WORK_MARKER_RE.test('escape to interrupt'));
  });
  it('does NOT match the past-tense done line (idle)', () => {
    assert.ok(!WORK_MARKER_RE.test('✻ Cooked for 4m 57s'));
  });
  it('does NOT match a parenthesized duration in prose (no spinner ellipsis)', () => {
    assert.ok(!WORK_MARKER_RE.test('done in (3s · 200ms)'));
  });
});

describe('newestLineIsTurn', () => {
  it('is true when the newest line is a real turn (assistant / user)', () => {
    assert.equal(newestLineIsTurn(writeTranscript('a.jsonl', [{ type: 'assistant' }])), true);
    assert.equal(newestLineIsTurn(writeTranscript('u.jsonl', [{ type: 'user' }])), true);
  });
  it('is false when the newest line is known non-turn metadata', () => {
    for (const type of ['bridge-session', 'summary', 'file-history-snapshot']) {
      assert.equal(newestLineIsTurn(writeTranscript(`m-${type}.jsonl`, [{ type }])), false, type);
    }
  });
  it('uses the NEWEST line, not earlier ones', () => {
    const busy = writeTranscript('busy.jsonl', [{ type: 'bridge-session' }, { type: 'assistant' }]);
    assert.equal(newestLineIsTurn(busy), true);
    const idle = writeTranscript('idle.jsonl', [{ type: 'assistant' }, { type: 'bridge-session' }]);
    assert.equal(newestLineIsTurn(idle), false);
  });
  it('conservatively returns true for an empty / unparseable / missing file', () => {
    const empty = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    assert.equal(newestLineIsTurn(empty), true);
    const garbage = path.join(dir, 'garbage.jsonl');
    fs.writeFileSync(garbage, '{ not valid json\n');
    assert.equal(newestLineIsTurn(garbage), true);
    assert.equal(newestLineIsTurn(path.join(dir, 'does-not-exist.jsonl')), true);
  });
});

describe('transcriptFresh', () => {
  it('is false for a null / undefined path', () => {
    assert.equal(transcriptFresh(null), false);
    assert.equal(transcriptFresh(undefined), false);
  });
  it('is true for a just-written transcript whose newest line is a turn', () => {
    assert.equal(transcriptFresh(writeTranscript('fresh.jsonl', [{ type: 'assistant' }])), true);
  });
  it('is false when a fresh mtime is only a metadata (bridge-session) write', () => {
    assert.equal(transcriptFresh(writeTranscript('bridge.jsonl', [{ type: 'bridge-session' }])), false);
  });
  it('is false once the mtime is older than the freshness window', () => {
    const p = writeTranscript('stale.jsonl', [{ type: 'assistant' }]);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(p, old, old);
    assert.equal(transcriptFresh(p), false);
  });
  it('is false for a missing file', () => {
    assert.equal(transcriptFresh(path.join(dir, 'nope.jsonl')), false);
  });
});

describe('sessionTranscriptPath', () => {
  it('returns null when the claude session id or agent dir is unknown', () => {
    assert.equal(sessionTranscriptPath(null, '/Users/mac/claudeclaw/asst'), null);
    assert.equal(sessionTranscriptPath('uuid', null), null);
    assert.equal(sessionTranscriptPath(undefined, undefined), null);
  });
  it('encodes the agent dir the way Claude Code lays out ~/.claude/projects', () => {
    assert.equal(
      sessionTranscriptPath('abc-123', '/Users/mac/claudeclaw/asst'),
      path.join(os.homedir(), '.claude', 'projects', '-Users-mac-claudeclaw-asst', 'abc-123.jsonl'),
    );
  });
});
