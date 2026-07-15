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
import {
  WORK_MARKER_RE, newestLineIsTurn, transcriptFresh, sessionTranscriptPath,
  transcriptToolRunning, sessionActivity,
} from './pane';

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

// The retroactive "a tool call is in flight" signal (moved here from the snapshot
// collector in P1-5). Pure over its `lines` input given the wall clock, so the caps +
// newest-of-kind comparison are directly assertable.
describe('transcriptToolRunning', () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const toolUse = (msAgo: number) =>
    JSON.stringify({ type: 'assistant', timestamp: iso(msAgo), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
  const toolResult = (msAgo: number) =>
    JSON.stringify({ type: 'user', timestamp: iso(msAgo), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  const assistantText = (msAgo: number) =>
    JSON.stringify({ type: 'assistant', timestamp: iso(msAgo), message: { content: [{ type: 'text', text: 'hi' }] } });

  it('is true when the newest tool_use is newer than the newest tool_result (in flight)', () => {
    assert.equal(transcriptToolRunning([toolResult(10_000), toolUse(2_000)]), true);
  });
  it('is false when the tool_result is newer than the tool_use (tool returned)', () => {
    assert.equal(transcriptToolRunning([toolUse(10_000), toolResult(2_000)]), false);
  });
  it('is true for a dangling tool_use with no tool_result at all', () => {
    assert.equal(transcriptToolRunning([assistantText(20_000), toolUse(2_000)]), true);
  });
  it('is false when there is no tool_use', () => {
    assert.equal(transcriptToolRunning([assistantText(5_000), toolResult(3_000)]), false);
  });
  it('self-heals: an abandoned tool_use older than the 20-min cap is not working', () => {
    assert.equal(transcriptToolRunning([toolUse(21 * 60_000)]), false);
  });
  it('is false for empty / unparseable lines', () => {
    assert.equal(transcriptToolRunning([]), false);
    assert.equal(transcriptToolRunning(['not json', '{ partial']), false);
  });
});

// The single working-detection verdict. Only the two transcript-driven short-circuits
// are unit-testable without a live tmux pane — they return before capturePaneMarker
// shells out, so they run deterministically here. The pane-marker / hook / idle paths
// need a real pane and are covered by the runtime parity check.
describe('sessionActivity', () => {
  it('reports transcript-fresh (no shell-out) for a just-written turn transcript', async () => {
    const p = writeTranscript('act-fresh.jsonl', [{ type: 'assistant' }]);
    assert.deepEqual(await sessionActivity('sid', { transcriptPath: p }), {
      working: true, reason: 'transcript-fresh',
    });
  });
  it('reports tool-running from the supplied tail when the mtime is not fresh', async () => {
    // No transcriptPath → freshness is false → falls through to the caller-supplied tail
    // (this is the narrow-pane long-tool-call signal the snapshot folds in).
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const lines = [
      JSON.stringify({ type: 'user', timestamp: iso(30_000), message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: iso(2_000), message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }),
    ];
    assert.deepEqual(await sessionActivity('sid', { transcriptLines: lines }), {
      working: true, reason: 'tool-running',
    });
  });
});
