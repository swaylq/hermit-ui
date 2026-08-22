'use client';

// The message timeline: the day-grouped list of chat messages and everything
// it renders. MessageTimeline (the only export) is consumed by SessionPane;
// MessageRow / GroupView / MessageActions / HarnessTerminatorRow and the
// grouping helpers are module-private, called only from within this cluster.
//
// The list is not one row per message. Tool calls, tool results and thinking are
// folded out of the message stream and into a single run capsule per stretch of
// machinery (fold-runs.ts) — so what remains is what someone said, plus one
// expandable row standing in for how it was carried out.

import { memo, useState, useCallback } from 'react';
import { useTimelineWindow, WINDOW_ROW_ATTR } from '@/components/chat/use-timeline-window';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { TimeAgo } from '@/components/time-ago';
import { isSameDay, type Block } from '@/components/chat/lib';
import { sinkDeliverables, isAskToolUse } from '@/components/chat/sink-deliverables';
import { StreamingDots, TypedText, DateDivider } from '@/components/chat/message-bits';
import { TranslatedText } from '@/components/chat/translated-text';
import { useTranslatePrefs } from '@/lib/translate-prefs';
import { shouldAutoTranslate } from '@/lib/translate-text';
import { originalFor } from '@/lib/translate-outbound';
import { ToolChip, ToolBatchChip } from '@/components/chat/tool-chips';
import { InteractionCard } from '@/components/chat/interaction-card';
import { ChatImage, ChatFile } from '@/components/chat/file-preview';
import { RunCapsule } from '@/components/chat/run-capsule';
import { foldRuns } from '@/components/chat/fold-runs';

function HarnessTerminatorRow({ ts }: { ts: Date | string }) {
  return (
    <div className="flex justify-center my-2">
      <span
        className="text-[11px] italic text-muted-foreground/70 font-mono px-2 py-0.5 rounded border border-dashed border-border"
        title="Claude Code 在没产出回复文字的情况下结束了这一轮 — 通常发生在 restart 后 --resume 接续上一轮被中断的 tool 调用、或 prompt 被模型读成纯指令时。"
      >
        — turn ended without a reply · {relTime(ts)}
      </span>
    </div>
  );
}

export const MessageTimeline = memo(function MessageTimeline({
  messages,
  streamingTailId,
  streamKey = '',
  sessionId = '',
  dotClass,
  getViewport,
  running = false,
  runLabel = null,
  runDetail = null,
}: {
  messages: Array<{ id: string; role: string; content: any; createdAt: Date | string; authoredBy?: string | null }>;
  streamingTailId?: string | null;
  /** Which conversation this is, so a reveal can survive the row swap mid-reply
   *  (the gateway retracts its placeholder row and lands the real one). */
  streamKey?: string;
  /** The session these messages belong to — the translate route checks it owns
   *  them. Same value as streamKey today, kept separate because streamKey is a
   *  reveal-lane identifier and is allowed to stop being a session id. */
  sessionId?: string;
  dotClass?: string;
  getViewport?: () => HTMLElement | null;
  /** A turn is in flight — the trailing run capsule shows live progress. */
  running?: boolean;
  /** Gateway-reported current activity, so the capsule label survives a long
   *  silent tool call that emits no new block. */
  runLabel?: string | null;
  runDetail?: string | null;
}) {
  // Insert date dividers when day rolls over.
  // The `ask` tool renders its InteractionCard at the tool_use call site (see
  // groupConsecutiveTools). Build a question→interaction-block map from the
  // separately-synced system messages, and suppress those standalone system
  // cards when a matching ask tool_use is in the window — the system row is
  // created (by the MCP stub) BEFORE the assistant turn's blocks finish syncing,
  // so it gets an earlier id and would otherwise sort ABOVE the question text
  // instead of beside it. `pendingQuestions` then tells sinkDeliverables which
  // of those call sites is still waiting on a human, so it can sink that row to
  // the end of the turn; an answered card stays where it was asked.
  const askCardByQuestion = new Map<string, any>();
  const askedQuestions = new Set<string>();
  const pendingQuestions = new Set<string>();
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? (m.content as any[]) : [];
    for (const b of blocks) {
      if (isAskToolUse(b)) {
        askedQuestions.add(b.input.question);
      } else if (b?.type === 'interaction' && (b?.kind ?? 'question') === 'question' && typeof b?.payload?.question === 'string') {
        askCardByQuestion.set(b.payload.question, b);
        if ((b?.status ?? 'pending') === 'pending') pendingQuestions.add(b.payload.question);
      }
    }
  }
  const visibleMessages = messages.filter((m) => {
    if (m.role !== 'system') return true;
    const blocks = Array.isArray(m.content) ? (m.content as any[]) : [];
    if (blocks.length === 0 || !blocks.every((b) => b?.type === 'interaction')) return true;
    // Drop only if EVERY interaction block is a question whose ask tool_use is
    // in the window (the call site renders the card); otherwise keep it.
    return !blocks.every((b) => (b?.kind ?? 'question') === 'question' && askedQuestions.has(b?.payload?.question));
  });

  // Deliverables sink to the end of their turn — a download chip below the prose
  // that describes it, an unanswered question card below that. See
  // sink-deliverables.ts for why createdAt can't express this on its own.
  const orderedMessages = sinkDeliverables(visibleMessages, (q) => pendingQuestions.has(q));
  // Typewriter is a property of the row that JUST ARRIVED, so it's decided
  // against arrival order — not against the order we're about to render in,
  // where a sunk attachment can sit below the text that was actually last.
  const newestId = visibleMessages.length ? visibleMessages[visibleMessages.length - 1].id : null;

  // Machinery out of the stream and into capsules. This is what turns a
  // 15-row tool chain into one row.
  const folded = foldRuns(orderedMessages);

  // Items rather than a flat node list: a long timeline renders only the slice
  // near the viewport (see use-timeline-window.ts), which means the list has to
  // be sliceable and every item has to carry a stable key to remember its
  // measured height by.
  const out: Array<{ key: string; node: React.ReactNode }> = [];
  let prevDay: Date | string | null = null;
  for (let i = 0; i < folded.length; i++) {
    const r = folded[i];
    const ts = r.kind === 'run' ? r.from : r.createdAt;
    if (!prevDay || !isSameDay(prevDay, ts)) {
      out.push({ key: `d-${r.key}`, node: <DateDivider key={`d-${r.key}`} day={ts} /> });
      prevDay = ts;
    }

    if (r.kind === 'end') {
      out.push({ key: r.key, node: <HarnessTerminatorRow key={r.key} ts={r.createdAt} /> });
      continue;
    }

    if (r.kind === 'run') {
      // Only the LAST row of the whole timeline can be the turn in flight.
      const live = running && i === folded.length - 1;
      out.push({
        key: r.key,
        // `data-msg-id` carries every id folded into this row, space-separated
        // so a lookup can use the `[data-msg-id~="…"]` word-match selector.
        // It's how a search hit scrolls to its message — see use-anchored-window.ts.
        //
        // `data-run` says "this row can swallow more of the conversation later".
        // Loading earlier history folds the machinery it brings into the capsule
        // at the seam, so the SAME row comes back taller and starting further
        // back — and a word-match lookup still finds it, which is what makes it
        // a trap. The prepend anchor uses the mark to refuse to anchor here.
        node: (
          <div key={r.key} data-msg-id={r.ids.join(' ')} data-run="" {...{ [WINDOW_ROW_ATTR]: r.key }} className="flex justify-start">
            <div className="min-w-0 w-full max-w-[85%]">
              <RunCapsule ids={r.ids} steps={r.steps} from={r.from} to={r.to} running={live} label={live ? runLabel : null} detail={live ? runDetail : null} />
            </div>
          </div>
        ),
      });
      continue;
    }

    const streamingTail = !!streamingTailId && r.msgId === streamingTailId && i === folded.length - 1;
    // Typewriter is decided at render time, NOT from streamingTailId alone —
    // that's set by a post-render effect (one render late), which would mount
    // the text already-complete and skip the animation. So a row that landed in
    // the last few seconds may start typing on sight; a row the page has SEEN
    // grow may start typing whatever its age, which is what keeps a reply that
    // takes a minute to write animating for the whole minute.
    //
    // Either way this only STARTS the reveal — useTypewriter latches, because
    // both of these signals decay while a long reply is still being written.
    const isLast = r.msgId === newestId;
    const typing = isLast && r.role === 'assistant'
      && (streamingTail || Date.now() - new Date(r.createdAt).getTime() < 8_000);
    // askCardByQuestion is rebuilt as a fresh Map every render, and `view`
    // hands us a new array on every streaming tick — so passing the Map to
    // every row would break MessageRow's memo shallow-compare each tick and
    // re-render the whole visible timeline, not just the growing tail. Only
    // ask tool_use rows actually read the map (groupConsecutiveTools);
    // every other row gets a stable `undefined` and its memo bails.
    const rowHasAsk = r.blocks.some((b) => isAskToolUse(b));
    out.push({
      key: r.key,
      node: (
        <div key={r.key} data-msg-id={r.ids.join(' ')} {...{ [WINDOW_ROW_ATTR]: r.key }}>
          <MessageRow role={r.role} authoredBy={r.authoredBy} content={r.blocks} ts={r.createdAt} streamingTail={streamingTail} typing={typing} streamKey={streamKey} sessionId={sessionId} streamingDot={streamingTail ? dotClass : undefined} askCardByQuestion={rowHasAsk ? askCardByQuestion : undefined} />
        </div>
      ),
    });
  }
  return <TimelineBody items={out} getViewport={getViewport} />;
});

// Rendering half of MessageTimeline, split out only so the windowing hook has a
// component of its own to live in — the hook must run on every render, and
// MessageTimeline's body is a long straight-line build of `items`.
function TimelineBody({ items, getViewport }: { items: Array<{ key: string; node: React.ReactNode }>; getViewport?: () => HTMLElement | null }) {
  const keys = items.map((it) => it.key);
  const noViewport = useCallback(() => null, []);
  const win = useTimelineWindow(keys, getViewport ?? noViewport);
  return (
    <div className="space-y-3">
      {win.padTop > 0 && <div data-window-spacer="top" style={{ height: win.padTop }} aria-hidden />}
      {items.slice(win.start, win.end).map((it) => it.node)}
      {win.padBottom > 0 && <div data-window-spacer="bottom" style={{ height: win.padBottom }} aria-hidden />}
    </div>
  );
}

const MessageRow = memo(function MessageRow({ role, authoredBy, content, ts, streamingTail = false, typing = false, streamKey = '', sessionId = '', streamingDot, askCardByQuestion }: { role: string; authoredBy?: string | null; content: Block[]; ts: Date | string; streamingTail?: boolean; typing?: boolean; streamKey?: string; sessionId?: string; streamingDot?: string; askCardByQuestion?: Map<string, any> }) {
  // Hooks first — everything below this can return early.
  const translatePrefs = useTranslatePrefs();
  // null = follow the automatic setting; true/false = the reader overrode it on
  // THIS message. Row-local on purpose: the override is a glance at one reply,
  // not a mode, and it should not outlive scrolling past.
  const [translateOverride, setTranslateOverride] = useState<boolean | null>(null);

  // A role='user' row is not automatically the human. During a Brain takeover the
  // Brain speaks in this slot, and the gateway's watchers drop `[dispatch update]`
  // pokes here too. Rendering all three identically would make a driven
  // conversation unreadable after the fact — you could no longer tell which
  // instructions were actually yours.
  const byBrain = role === 'user' && authoredBy === 'brain';
  const byMachine = role === 'user' && authoredBy === 'system';
  // A scheduled run reporting in. It's an assistant row, but it did NOT arrive
  // because you just said something — labelling it keeps the transcript honest about
  // which replies were answers to you.
  const byCron = role === 'assistant' && authoredBy === 'cron';
  const isHumanUser = role === 'user' && !byBrain && !byMachine;
  // Machine pokes read as notices, not conversation — same treatment as the
  // gateway's system banners.
  const isSystem = role === 'system' || byMachine;

  // A message this device sent translated is displayed as the Chinese that was
  // typed. The English in `content` is the truth of what the agent received and
  // stays one tap away — but a conversation where your own bubbles are in a
  // language you never used is not readable. See lib/translate-outbound.ts.
  const sentText = isHumanUser
    ? content
        .filter((b) => b.type === 'text' && (b as { text?: string }).text)
        .map((b) => (b as { text?: string }).text ?? '')
        .join('\n\n')
        .trim()
    : '';
  const outboundOriginal = sentText ? originalFor(sentText) : undefined;
  // The same row-local override drives both directions: on a reply it means
  // "translate this", on your own message it means "show me what was sent".
  const showSentText = translateOverride === true;
  const displayContent =
    outboundOriginal && !showSentText
      ? content.map((b) =>
          b.type === 'text' && (b as { text?: string }).text === sentText ? { ...b, text: outboundOriginal } : b,
        )
      : content;

  // Group consecutive same-tool tool_use calls. After folding, the only tool_use
  // that reaches here is `ask` (swapped for its card below), so this is mostly a
  // safety net for content shapes the fold does not recognise.
  const grouped = groupConsecutiveTools(displayContent, askCardByQuestion);
  // Only the LAST text block of a row can be the one being written; an earlier
  // one was finished before this one started, and animating it again would
  // retype text the reader has already read.
  const liveGroup = grouped.reduce((at, g, i) => (g.kind === 'text' ? i : at), -1);
  const hasVisibleText = content.some((b) => b.type === 'text' && (b as any).text?.trim());

  // Interaction cards (permission / question prompts) carry their own border +
  // controls — render full-width & centered regardless of which message hosts
  // them: a standalone system row, OR an mcp__hermit__ask tool_use we swapped
  // for the card at its call site (so it sits beside the question text, not in
  // an assistant bubble). Must precede the role-specific branches below.
  if (grouped.some((g) => g.kind === 'interaction')) {
    return (
      <div className="flex justify-center my-2">
        <div className="w-full max-w-[92%] space-y-2">
          {grouped.map((g, i) => (
            <GroupView key={i} group={g} dark={false} />
          ))}
        </div>
      </div>
    );
  }

  // Nothing a person can read — an empty row, or a shape the fold left behind.
  // Render bare so it belongs visually with the surrounding capsules rather than
  // becoming a card with an empty body.
  if (!isHumanUser && !byBrain && !isSystem && !hasVisibleText && grouped.every((g) => g.kind === 'tool' || g.kind === 'thinking')) {
    return (
      <div className="flex justify-start">
        <div className="min-w-0 max-w-[85%] space-y-1.5">
          {grouped.map((g, i) => (
            <GroupView key={i} group={g} dark inline />
          ))}
          {streamingTail && (
            <div className="flex">
              <StreamingDots variant="chip" dot={streamingDot} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Flatten visible text blocks into one plain-text string so the hover Copy
  // action grabs only what the user can actually read (skip tool calls,
  // thinking, images). Used by MessageActions below.
  const plainText = displayContent
    .filter((b) => b.type === 'text' && (b as { text?: string }).text)
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n\n')
    .trim();

  // Only replies get translated INTO Chinese. What the human sent is shown in
  // what they typed — if it went out translated, composer-side bookkeeping put
  // the original back (see lib/translate-outbound.ts), so there is nothing here
  // to undo.
  const translatable = translatePrefs.on && role === 'assistant' && !isSystem && !!plainText;
  const translateMode: 'auto' | 'on' | 'off' = !translatable
    ? 'off'
    : translateOverride === null
      // No override: follow the setting. `auto` still asks whether this
      // particular reply needs it — the switch says "you may", the text says
      // "there is a point". Without the autoIn check here, turning the
      // automatic switch OFF would have translated every English reply anyway.
      ? translatePrefs.autoIn
        ? 'auto'
        : 'off'
      : translateOverride
        ? 'on'
        : 'off';
  // What the button says it will do. In `auto` the answer depends on the text,
  // so the label is computed from the same gate the renderer uses rather than
  // from the flag alone — otherwise a Chinese reply under auto-translate would
  // offer "show original" for a translation that never happened.
  // Exactly the decision TranslatedText makes from the same inputs. Kept in
  // step by hand because the button has to be labelled BEFORE the block renders
  // — if these two ever disagree the button lies about what it will do.
  const showingTranslated =
    translateMode === 'on' || (translateMode === 'auto' && shouldAutoTranslate(plainText, 'zh'));
  // The first press flips away from what is currently displayed; after that it
  // alternates. Deriving it from `showingTranslated` rather than from the
  // override alone is what makes the button work under auto-translate: there,
  // `null` already means "showing the translation", so a first press that set
  // the override to `true` would change nothing at all.
  //
  // The same expression covers a sent message, where nothing is "translated"
  // but the Chinese original is what is on screen: false → first press true →
  // showSentText → the English that actually went out.
  const toggleTranslate = () => setTranslateOverride((v) => (v === null ? !showingTranslated : !v));
  const translateAction: { label: string; title: string } | undefined = outboundOriginal
    ? showSentText
      ? { label: '中文', title: '显示你输入的中文' }
      : { label: 'EN', title: '显示实际发送给 agent 的英文' }
    // Offered only when translating would actually change something — the same
    // gate the renderer uses. A reply already in Chinese used to carry a 「译」
    // button that spent a round trip to hand back the identical text; so did an
    // acknowledgement with no prose in it.
    : translatable && shouldAutoTranslate(plainText, 'zh')
      ? showingTranslated
        ? { label: '原文', title: '显示原文' }
        : { label: '译', title: '翻译成中文' }
      : undefined;

  // System messages (gateway-emitted banners like "[session restarted —
  // send a message to continue]") should read as inline notices, not real
  // conversation. Render them centered, muted, and full-width with a hairline
  // divider treatment instead of the loud amber bubble.
  if (isSystem) {
    // (Interaction cards are handled by the role-agnostic branch above.)
    // Short notices (one-liners like "[session restarted]") render as the
    // existing hairline pill. Long ones (captured slash-command TUI output,
    // multi-line errors, etc.) get a wider card so any fenced code block
    // inside has room — a pill would either clip or stretch oddly.
    const sysText = grouped.map((g) => (g.kind === 'text' ? g.text : '')).join('');
    const isLong = sysText.includes('\n') || sysText.length > 100;
    if (isLong) {
      return (
        <div className="flex justify-center my-2">
          <div className="max-w-[92%] w-full text-xs text-muted-foreground/90 px-3 py-2 rounded-md border border-border bg-muted/40">
            {grouped.map((g, i) => (
              <GroupView key={i} group={g} dark={false} />
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-center my-2">
        <div className="text-[11px] text-muted-foreground/80 font-mono px-3 py-1 rounded-full border border-border bg-muted/40">
          {grouped.map((g, i) => (
            <GroupView key={i} group={g} dark={false} />
          ))}
        </div>
      </div>
    );
  }

  // Brain-spoken turns sit on the SENDER side — they're instructions to the agent,
  // same as yours — but never wear your bubble. Outlined instead of solid, with a
  // standing label: at a glance the right-hand column reads as "things said to this
  // agent", and within it you can still see which ones you said.
  const onSenderSide = isHumanUser || byBrain;
  return (
    <div className={`group/msg flex ${onSenderSide ? 'justify-end' : 'justify-start'}`}>
      <div
        className={cn(
          'min-w-0 max-w-[85%] space-y-2 text-sm',
          isHumanUser && 'rounded-md px-3 py-2 bg-foreground text-background',
          byBrain && 'rounded-md px-3 py-2 border border-dashed border-foreground/30 bg-muted/40 text-foreground/90',
          !onSenderSide && 'text-foreground/90',
        )}
      >
        {byBrain && (
          <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <span aria-hidden="true">🦀</span>
            <span>Brain</span>
          </div>
        )}
        {byCron && (
          <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <span aria-hidden="true">⏰</span>
            <span>Scheduled</span>
          </div>
        )}
        {grouped.map((g, i) => (
          <GroupView
            key={i}
            group={g}
            dark={false}
            typing={typing && !onSenderSide && i === liveGroup}
            // Only the live group may claim the session's reveal lane. It was
            // already true in practice — a non-typing TypedText returns before
            // it marks anything — but a translated block animates on its own
            // schedule, so the restriction has to be explicit now.
            streamKey={i === liveGroup ? streamKey : ''}
            translate={
              translateMode === 'off'
                ? undefined
                : { sessionId, target: 'zh' as const, mode: translateMode }
            }
          />
        ))}
        {streamingTail && (
          <div className="flex">
            <StreamingDots variant="bubble" dot={streamingDot} />
          </div>
        )}
        <div className={cn(
          'flex items-center gap-1.5 pt-0.5',
          onSenderSide ? 'justify-end' : 'justify-start',
        )}>
          <div className={cn(
            'text-[10px] font-mono tabular-nums',
            isHumanUser ? 'text-background/60' : 'text-muted-foreground/60',
          )}>
            <TimeAgo date={ts} />
          </div>
          {/* Hidden until row hover (or focus inside), to keep the rest text. */}
          {plainText && !streamingTail && !isSystem && (
            <MessageActions
              text={plainText}
              tone={isHumanUser ? 'on-dark' : 'on-light'}
              translateAction={translateAction}
              onTranslate={toggleTranslate}
            />
          )}
        </div>
      </div>
    </div>
  );
});

// Compact hover-action cluster shown below a message bubble. Copy, and — when
// translation is switched on and this message has prose in it — a toggle
// between the reply and its Chinese. Adding Edit/Regenerate later means
// dropping more buttons here.
//
// `tone` flips foreground colors so the label stays readable on light vs dark
// bubble backgrounds.
function MessageActions({
  text,
  tone,
  translateAction,
  onTranslate,
}: {
  text: string;
  tone: 'on-light' | 'on-dark';
  /** Undefined → the button is not offered at all (feature off, nothing to translate). */
  translateAction?: { label: string; title: string };
  onTranslate?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard write can fail in non-secure contexts or when permission is
      // denied — silently swallow rather than throw at the user.
    }
  }, [text]);
  const btn = cn(
    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-opacity cursor-pointer',
    // Desktop (hover-capable): hidden until the row is hovered or a key grabs
    // focus, so the conversation stays clean to read. Touch devices
    // (`hover: none`) can't discover via hover, so always show — slightly
    // muted, tap to use.
    'opacity-0 group-hover/msg:opacity-100 focus-visible:opacity-100',
    '[@media(hover:none)]:opacity-80',
    tone === 'on-dark'
      ? 'text-background/80 hover:text-background hover:bg-background/10'
      : 'text-muted-foreground hover:text-foreground hover:bg-accent',
  );
  return (
    <>
      {translateAction && (
        <button
          type="button"
          onClick={onTranslate}
          aria-label={translateAction.title}
          title={translateAction.title}
          className={btn}
        >
          {translateAction.label}
        </button>
      )}
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'copied' : 'copy message'}
      title={copied ? 'copied' : 'copy'}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-opacity cursor-pointer',
        // Desktop (hover-capable): hidden until the row is hovered or a key
        // grabs focus, so the conversation stays clean to read. Touch devices
        // (`hover: none`) can't discover via hover, so always show the button —
        // slightly muted, tap to copy. Both user and assistant rows render this
        // (different `tone`); the previous always-invisible default meant the
        // assistant copy button felt missing on phones.
        'opacity-0 group-hover/msg:opacity-100 focus-visible:opacity-100',
        '[@media(hover:none)]:opacity-80',
        tone === 'on-dark'
          ? 'text-background/80 hover:text-background hover:bg-background/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent',
      )}
    >
      {copied ? '✓ copied' : 'copy'}
    </button>
    </>
  );
}

type Group =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; calls: Array<{ id: string; name: string; input: any }> }
  | { kind: 'image'; url: string; mimeType: string | null; width: number | null; height: number | null }
  | { kind: 'file'; url: string; name: string; mimeType: string | null }
  | { kind: 'interaction'; block: any }
  | { kind: 'unknown'; block: Block };

// Coerce an Anthropic image block's `source` into a URL the dashboard can show.
// Three variants in the wild:
//   { type: 'url', url: '/uploads/...' }              → our composer uploads
//   { type: 'url', url: 'https://…' }                 → external (gateway-relayed)
//   { type: 'base64', media_type, data }              → MCP attach_image-style
function imageSourceToUrl(src: any): { url: string; mimeType: string | null } | null {
  if (!src || typeof src !== 'object') return null;
  if (src.type === 'url' && typeof src.url === 'string') {
    return { url: src.url, mimeType: src.media_type ?? null };
  }
  if (src.type === 'base64' && typeof src.data === 'string') {
    const mt = src.media_type || 'image/png';
    return { url: `data:${mt};base64,${src.data}`, mimeType: mt };
  }
  return null;
}

function groupConsecutiveTools(blocks: Block[], askCardByQuestion?: Map<string, any>): Group[] {
  const out: Group[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text) out.push({ kind: 'text', text: b.text });
    } else if (b.type === 'thinking') {
      const t = (b as any).thinking ?? (b as any).text;
      if (t) out.push({ kind: 'thinking', text: String(t) });
    } else if (b.type === 'tool_use') {
      // mcp__hermit__ask IS the question prompt — render the interactive
      // InteractionCard right here at the call site instead of the raw tool
      // JSON. The card is matched (by question text) to the separately-synced
      // system interaction message, which carries the interactionId/status the
      // buttons need. Falls back to the raw call if that block isn't in the
      // loaded window. (The standalone system card is suppressed in
      // MessageTimeline so the card shows once, anchored beside the question —
      // it otherwise sorts ABOVE the question text, see the suppression note.)
      const askQ = isAskToolUse(b) ? (b as any).input.question : undefined;
      const askCard = typeof askQ === 'string' ? askCardByQuestion?.get(askQ) : undefined;
      if (askCard) { out.push({ kind: 'interaction', block: askCard }); continue; }
      const prev = out[out.length - 1];
      const call = { id: (b as any).id ?? '', name: (b as any).name ?? '?', input: (b as any).input ?? {} };
      if (prev && prev.kind === 'tool') prev.calls.push(call);
      else out.push({ kind: 'tool', calls: [call] });
    } else if (b.type === 'image') {
      const src = imageSourceToUrl(b.source);
      if (src) {
        out.push({
          kind: 'image',
          url: src.url,
          mimeType: src.mimeType,
          width: typeof b.width === 'number' ? b.width : null,
          height: typeof b.height === 'number' ? b.height : null,
        });
      }
    } else if (b.type === 'file') {
      const src: any = b.source;
      const url = src && typeof src === 'object' && typeof src.url === 'string' ? src.url : null;
      if (url) out.push({ kind: 'file', url, name: typeof b.name === 'string' && b.name ? b.name : 'file', mimeType: typeof src.media_type === 'string' ? src.media_type : null });
    } else if (b.type === 'interaction') {
      out.push({ kind: 'interaction', block: b });
    } else {
      out.push({ kind: 'unknown', block: b });
    }
  }
  return out;
}

function GroupView({ group, dark, inline = false, typing = false, streamKey = '', translate }: { group: Group; dark: boolean; inline?: boolean; typing?: boolean; streamKey?: string; translate?: { sessionId: string; target: 'zh' | 'en'; mode: 'auto' | 'on' } }) {
  if (group.kind === 'text') {
    if (translate) {
      return (
        <TranslatedText
          text={group.text}
          typing={typing}
          streamKey={streamKey}
          sessionId={translate.sessionId}
          target={translate.target}
          mode={translate.mode}
        />
      );
    }
    return <TypedText text={group.text} typing={typing} streamKey={streamKey} />;
  }
  if (group.kind === 'image') {
    return <ChatImage url={group.url} width={group.width} height={group.height} />;
  }
  if (group.kind === 'file') {
    return <ChatFile url={group.url} name={group.name} mimeType={group.mimeType} />;
  }
  if (group.kind === 'thinking') {
    return (
      <details className="text-xs italic text-zinc-500/80">
        <summary className="cursor-pointer">💭 thinking</summary>
        <p className="mt-1 whitespace-pre-wrap">{group.text}</p>
      </details>
    );
  }
  if (group.kind === 'tool') {
    // Sub-group consecutive same-name calls so a turn with 8× Read renders as
    // a single "⚙ Read × 8" expandable chip instead of 8 wrapped chips.
    const byName: Array<{ name: string; calls: typeof group.calls }> = [];
    for (const c of group.calls) {
      const last = byName[byName.length - 1];
      if (last && last.name === c.name) last.calls.push(c);
      else byName.push({ name: c.name, calls: [c] });
    }
    return (
      <div className="flex flex-wrap gap-1.5">
        {byName.map((g, i) =>
          g.calls.length === 1 ? (
            <ToolChip key={g.calls[0].id || `${g.name}-${i}`} call={g.calls[0]} dark={dark} inline={inline} />
          ) : (
            <ToolBatchChip key={`${g.name}-${i}`} name={g.name} calls={g.calls} dark={dark} inline={inline} />
          ),
        )}
      </div>
    );
  }
  if (group.kind === 'interaction') {
    return <InteractionCard block={group.block} />;
  }
  return (
    <pre className="text-[11px] whitespace-pre-wrap text-zinc-500">
      [{group.block.type}] {JSON.stringify(group.block, null, 2).slice(0, 200)}
    </pre>
  );
}
