// Unit tests for the shared Claude Code transcript predicates. These now back
// pane / session-snapshot / chat-runner / cron-runner, so locking their behavior
// here is what makes it safe to have removed the per-file copies.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, hasToolResult, hasToolUse, isNonTurnEvent, CcEvent, CcBlock } from './claude-code';

describe('extractText', () => {
  it('passes a plain string through unchanged', () => {
    assert.equal(extractText('hello'), 'hello');
  });
  it('joins the text blocks of a content array with newlines', () => {
    assert.equal(
      extractText([{ type: 'text', text: 'a' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'b' }]),
      'a\nb',
    );
  });
  it('does NOT trim (callers trim if they want to)', () => {
    assert.equal(extractText([{ type: 'text', text: '  spaced  ' }]), '  spaced  ');
  });
  it('returns empty string for non-array, non-string content', () => {
    assert.equal(extractText(null), '');
    assert.equal(extractText(undefined), '');
    assert.equal(extractText({ type: 'text', text: 'nope' }), '');
  });
  it('ignores text blocks whose text is not a string', () => {
    assert.equal(extractText([{ type: 'text' }, { type: 'text', text: 'ok' }]), 'ok');
  });
});

describe('hasToolResult / hasToolUse', () => {
  it('detect the respective block type', () => {
    assert.equal(hasToolResult([{ type: 'tool_result', id: '1' }]), true);
    assert.equal(hasToolUse([{ type: 'tool_use', name: 'Bash' }]), true);
  });
  it('are false when the block type is absent or content is not an array', () => {
    assert.equal(hasToolResult([{ type: 'text', text: 'hi' }]), false);
    assert.equal(hasToolUse('a string'), false);
    assert.equal(hasToolResult(null), false);
  });
});

describe('isNonTurnEvent', () => {
  it('is true for the metadata event types', () => {
    for (const t of [CcEvent.bridgeSession, CcEvent.summary, CcEvent.fileHistorySnapshot]) {
      assert.equal(isNonTurnEvent(t), true, t);
    }
  });
  it('is false for real turn events and junk', () => {
    assert.equal(isNonTurnEvent(CcEvent.assistant), false);
    assert.equal(isNonTurnEvent(CcEvent.user), false);
    assert.equal(isNonTurnEvent(undefined), false);
    assert.equal(isNonTurnEvent(''), false);
  });
});

describe('vocabulary constants', () => {
  it('hold the exact SDK string values', () => {
    assert.equal(CcEvent.assistant, 'assistant');
    assert.equal(CcEvent.user, 'user');
    assert.equal(CcBlock.toolUse, 'tool_use');
    assert.equal(CcBlock.toolResult, 'tool_result');
    assert.equal(CcBlock.text, 'text');
  });
});
