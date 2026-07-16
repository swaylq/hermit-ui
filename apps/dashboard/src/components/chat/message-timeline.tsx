'use client';

// The message timeline: the day-grouped list of chat messages and everything
// it renders. Extracted verbatim from chat/page.tsx (P2-3); behaviour
// identical. MessageTimeline (the only export) is consumed by SessionPane;
// MessageRow / GroupView / MessageActions / HarnessTerminatorRow and the
// grouping helpers (Group / imageSourceToUrl / groupConsecutiveTools) are
// module-private, called only from within this cluster.

import { memo, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { relTime } from '@/lib/format';
import { TimeAgo } from '@/components/time-ago';
import { isSameDay, isHarnessTerminator, type Block } from '@/components/chat/lib';
import { StreamingDots, TypedText, DateDivider } from '@/components/chat/message-bits';
import { ToolChip, ToolBatchChip, InlineToolResult, InlineToolResultBatch } from '@/components/chat/tool-chips';
import { InteractionCard } from '@/components/chat/interaction-card';
import { ChatImage, ChatFile } from '@/components/chat/file-preview';

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

export const MessageTimeline = memo(function MessageTimeline({ messages, streamingTailId, dotClass }: { messages: Array<{ id: string; role: string; content: any; createdAt: Date | string }>; streamingTailId?: string | null; dotClass?: string }) {
  // Insert date dividers when day rolls over. Also coalesce consecutive
  // tool-result-only messages into a single row so a parallel-fanout batch
  // (e.g. 6 Read calls → 6 result rows) collapses to one expandable chip.
  // mcp__hermit__ask renders its InteractionCard at the tool_use call site (see
  // groupConsecutiveTools). Build a question→interaction-block map from the
  // separately-synced system messages, and suppress those standalone system
  // cards when a matching ask tool_use is in the window — the system row is
  // created (by the MCP stub) BEFORE the assistant turn's blocks finish syncing,
  // so it gets an earlier id and would otherwise sort ABOVE the question text
  // instead of beside it.
  const askCardByQuestion = new Map<string, any>();
  const askedQuestions = new Set<string>();
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? (m.content as any[]) : [];
    for (const b of blocks) {
      if (b?.type === 'tool_use' && b?.name === 'mcp__hermit__ask' && typeof b?.input?.question === 'string') {
        askedQuestions.add(b.input.question);
      } else if (b?.type === 'interaction' && (b?.kind ?? 'question') === 'question' && typeof b?.payload?.question === 'string') {
        askCardByQuestion.set(b.payload.question, b);
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

  const out: React.ReactNode[] = [];
  let prevDay: Date | string | null = null;
  let i = 0;
  while (i < visibleMessages.length) {
    const m = visibleMessages[i];
    if (!prevDay || !isSameDay(prevDay, m.createdAt)) {
      out.push(<DateDivider key={`d-${m.id}`} day={m.createdAt} />);
      prevDay = m.createdAt;
    }
    // Harness "No response requested." terminator → render as a small dashed
    // pill explaining what actually ended the turn, not as a normal bubble.
    if (m.role === 'assistant' && isHarnessTerminator(m.content)) {
      out.push(<HarnessTerminatorRow key={m.id} ts={m.createdAt} />);
      i += 1;
      continue;
    }
    const blocks = m.content as Block[];
    const isToolResultOnly = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
    if (isToolResultOnly) {
      const combined: Block[] = [...blocks];
      let lastId = m.id;
      let j = i + 1;
      while (j < visibleMessages.length) {
        const nb = visibleMessages[j].content as Block[];
        const nIsToolResultOnly = nb.length > 0 && nb.every((b) => b.type === 'tool_result');
        if (!nIsToolResultOnly) break;
        if (!isSameDay(prevDay!, visibleMessages[j].createdAt)) break;
        combined.push(...nb);
        lastId = visibleMessages[j].id;
        j++;
      }
      out.push(<MessageRow key={`g-${m.id}-${lastId}`} role={m.role} content={combined} ts={m.createdAt} />);
      i = j;
    } else {
      const streamingTail = !!streamingTailId && m.id === streamingTailId;
      // Typewriter is decided at render time, NOT from streamingTailId — that's
      // set by a post-render effect (one render late), which would mount the
      // text already-complete and skip the animation. The last assistant row,
      // if it landed in the last few seconds, types out.
      const isLast = i === visibleMessages.length - 1;
      const typing = isLast && m.role === 'assistant' && Date.now() - new Date(m.createdAt).getTime() < 8_000;
      // askCardByQuestion is rebuilt as a fresh Map every render, and `view`
      // hands us a new array on every streaming tick — so passing the Map to
      // every row would break MessageRow's memo shallow-compare each tick and
      // re-render the whole visible timeline, not just the growing tail. Only
      // mcp__hermit__ask tool_use rows actually read the map (groupConsecutiveTools);
      // every other row gets a stable `undefined` and its memo bails. Identical
      // output either way — non-ask rows never touch the map.
      const rowHasAsk = blocks.some((b) => b.type === 'tool_use' && (b as any).name === 'mcp__hermit__ask');
      out.push(<MessageRow key={m.id} role={m.role} content={blocks} ts={m.createdAt} streamingTail={streamingTail} typing={typing} streamingDot={streamingTail ? dotClass : undefined} askCardByQuestion={rowHasAsk ? askCardByQuestion : undefined} />);
      i += 1;
    }
  }
  return <div className="space-y-3">{out}</div>;
});

const MessageRow = memo(function MessageRow({ role, content, ts, streamingTail = false, typing = false, streamingDot, askCardByQuestion }: { role: string; content: Block[]; ts: Date | string; streamingTail?: boolean; typing?: boolean; streamingDot?: string; askCardByQuestion?: Map<string, any> }) {
  // Tool-result-only rows belong with the assistant's preceding tool calls,
  // so we render them as condensed inline chips with no bubble.
  const allToolResults = content.length > 0 && content.every((b) => b.type === 'tool_result');
  if (allToolResults) {
    const results = content as Array<{ type: string; tool_use_id?: string; content?: any; is_error?: boolean }>;
    if (results.length === 1) {
      return (
        <div className="flex justify-start">
          <div className="min-w-0 max-w-[85%]"><InlineToolResult block={results[0]} /></div>
        </div>
      );
    }
    return (
      <div className="flex justify-start">
        <div className="min-w-0 max-w-[85%]"><InlineToolResultBatch results={results} /></div>
      </div>
    );
  }

  const isHumanUser = role === 'user';
  const isSystem = role === 'system';

  // Group consecutive same-tool tool_use calls so a noisy claude turn doesn't
  // generate 12 individual cards.
  const grouped = groupConsecutiveTools(content, askCardByQuestion);
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

  // Tool-use-only assistant turns: render the chips bare (no bubble, no
  // placeholder text). They belong visually with the surrounding tool_result
  // chips, not as standalone cards with empty bodies. When this row is the
  // streaming tail, append a small dots chip at the end of the chip cluster.
  if (!isHumanUser && !isSystem && !hasVisibleText && grouped.every((g) => g.kind === 'tool' || g.kind === 'thinking')) {
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
  const plainText = content
    .filter((b) => b.type === 'text' && (b as { text?: string }).text)
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n\n')
    .trim();

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

  return (
    <div className={`group/msg flex ${isHumanUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={cn(
          'min-w-0 max-w-[85%] space-y-2 text-sm',
          isHumanUser
            ? 'rounded-md px-3 py-2 bg-foreground text-background'
            : 'text-foreground/90',
        )}
      >
        {grouped.map((g, i) => (
          <GroupView key={i} group={g} dark={false} typing={typing && !isHumanUser} />
        ))}
        {streamingTail && (
          <div className="flex">
            <StreamingDots variant="bubble" dot={streamingDot} />
          </div>
        )}
        <div className={cn(
          'flex items-center gap-1.5 pt-0.5',
          isHumanUser ? 'justify-end' : 'justify-start',
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
            />
          )}
        </div>
      </div>
    </div>
  );
});

// Compact hover-action cluster shown below a message bubble. Currently just
// Copy; adding Edit/Regenerate later means dropping more icon buttons here.
// `tone` flips foreground colors so the icon stays readable on light vs dark
// bubble backgrounds.
function MessageActions({ text, tone }: { text: string; tone: 'on-light' | 'on-dark' }) {
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
  return (
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
      const askQ = (b as any).name === 'mcp__hermit__ask' ? (b as any).input?.question : undefined;
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

function GroupView({ group, dark, inline = false, typing = false }: { group: Group; dark: boolean; inline?: boolean; typing?: boolean }) {
  if (group.kind === 'text') return <TypedText text={group.text} typing={typing} />;
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
