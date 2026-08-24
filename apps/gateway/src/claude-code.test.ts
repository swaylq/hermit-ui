// Unit tests for the shared Claude Code transcript predicates. These now back
// pane / session-snapshot / chat-runner / cron-runner, so locking their behavior
// here is what makes it safe to have removed the per-file copies.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, hasToolResult, hasToolUse, isNonTurnEvent, loopTriggerSummary, CcEvent, CcBlock } from './claude-code';

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

// ── CLI-injected loop iterations ────────────────────────────────────────────
//
// A `/loop` iteration prompt is enqueued by the CLI's own in-session cron, not
// by the dashboard, and reaches the transcript as a user record with
// `isMeta: true`. Both transcript readers drop plain user prompts because "the
// dashboard already wrote that row" — true of anything a human typed, false of
// this. loopTriggerSummary is the discriminator.

const ITERATION_PROMPT = [
  'Read silently first: run the startup command in /Users/mac/claudeclaw/humanize/CLAUDE.md',
  '(it is the single source of truth for the boot chain — do not hardcode a file list here),',
  'plus /Users/mac/claudeclaw/humanize/memory/2026-08-24.md if present.',
  '',
  'Then do this iteration of the loop: 推进 humanize-chinese v6 重构。先读 GOAL.md',
  '',
  'Then SELF-TEST this iteration before reporting — run the build / test / metric',
  'appropriate to the work and confirm it actually passed.',
].join('\n');

const block = (t: string) => [{ type: 'text', text: t }];

describe('loopTriggerSummary', () => {
  it('a loop iteration the CLI injected yields its task line', () => {
    assert.equal(
      loopTriggerSummary(true, block(ITERATION_PROMPT)),
      '推进 humanize-chinese v6 重构。先读 GOAL.md',
    );
  });

  it('the same text WITHOUT isMeta is not one — a human may have typed it', () => {
    // isMeta is the only thing that separates "the CLI wrote this" from "sway
    // pasted the loop prompt back in to re-run it by hand". Forwarding the
    // second would duplicate the row the dashboard already wrote.
    assert.equal(loopTriggerSummary(undefined, block(ITERATION_PROMPT)), null);
    assert.equal(loopTriggerSummary(false, block(ITERATION_PROMPT)), null);
    assert.equal(loopTriggerSummary('true', block(ITERATION_PROMPT)), null);
  });

  it('other isMeta frames are left alone', () => {
    // A skill-load preamble is isMeta too. It is machinery, not a round, and
    // turning every injected frame into a chat row trades a missing row for a
    // noisy one.
    assert.equal(
      loopTriggerSummary(true, block('Base directory for this skill: /x/.claude/skills/loop\n\n# Loop')),
      null,
    );
    assert.equal(loopTriggerSummary(true, block('<task-notification>\n<task-id>abc</task-id>')), null);
  });

  it('only the task line is kept, not the skill boilerplate below it', () => {
    // The rest of the prompt is identical every round; a chat row repeating it
    // hourly would be worse than the missing row.
    const s = loopTriggerSummary(true, block(ITERATION_PROMPT));
    assert.ok(s);
    assert.ok(!s!.includes('SELF-TEST'));
    assert.ok(!s!.includes('\n'));
  });

  it('a long task is capped', () => {
    const long = 'Then do this iteration of the loop: ' + 'x'.repeat(400);
    assert.equal(loopTriggerSummary(true, block(long))!.length, 160);
  });

  it('an empty task yields nothing rather than the boilerplate below it', () => {
    // A missing row beats a WRONG one: without the paragraph bound this would
    // report "Then SELF-TEST this iteration…" as if that were the round's task.
    const empty = 'Then do this iteration of the loop:\n\nThen SELF-TEST this iteration before reporting.';
    assert.equal(loopTriggerSummary(true, block(empty)), null);
  });

  it('a task wrapped onto the next line is still the task', () => {
    // Same paragraph, just wrapped — the bound is the blank line, not the newline.
    assert.equal(
      loopTriggerSummary(true, block('Then do this iteration of the loop:\n推进 v6 重构\n先读 GOAL.md')),
      '推进 v6 重构 先读 GOAL.md',
    );
  });

  it('tool_result content is not a loop trigger', () => {
    assert.equal(loopTriggerSummary(true, [{ type: 'tool_result', content: ITERATION_PROMPT }]), null);
  });
});
