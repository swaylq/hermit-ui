'use client';

// Which model this chat runs on, and the one gesture that changes it.
//
// It lives in the header meta line rather than in the session sheet because
// switching model is a thing you do WHILE reading a reply — "that was a Sonnet
// answer, do it again on Opus" — and a two-click detour into a sheet is enough
// friction that people stop doing it. It replaces the composer's `/model`
// entry, which typed a slash command AT Claude Code: that moved the model
// inside the CLI while the column that says which model this session runs
// stayed where it was, so the header, the context-window maths and the next
// respawn all disagreed with what was actually answering.
//
// Claude Code only. The pane driver takes its model from that machine's
// ~/.claude/settings.json and ignores the column (the server refuses it too),
// and every other backend picks its model from its credential in Settings →
// Models, where the catalogue that makes a picker meaningful lives.
//
// The list is the machine's own — `supportedModels()` off the CLI, cached on
// Machine.claudeModels by the gateway. See lib/claude-models.ts.

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { DEFAULT_MODEL_VALUE, modelChipLabel, modelPinOf } from '@/lib/claude-models';

/** Menu width, in px. Needed as a number to keep the menu on screen. */
const MENU_W = 256;

export function ModelChip({
  sessionId,
  /** The RESOLVED model for this session — the pin, or what it inherits. */
  model,
  disabled,
}: {
  sessionId: string;
  model: string | null | undefined;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // Viewport coordinates for the menu, measured when it opens.
  //
  // The menu is `fixed`, not `absolute`, because the header's meta line is
  // `overflow-hidden` — it truncates the agent name and the activity label to
  // keep the row on one line at 390px — and an absolutely-positioned popup
  // inside it is CLIPPED: the markup is all there, focusable and screen-reader
  // reachable, and a sighted user sees nothing. (Verified in the browser before
  // and after: none of the ancestors carry a transform/filter/contain, so a
  // fixed element escapes the clip instead of being contained by one of them.)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const utils = trpc.useUtils();

  // Changed by installing a new Claude Code, not by anything on this page.
  // Cached long, shared by every chat via the query key.
  const models = trpc.machines.getClaudeModels.useQuery(undefined, { staleTime: 10 * 60_000 }).data ?? [];

  const setModel = trpc.chat.setSessionModel.useMutation({
    onSuccess: () => {
      setOpen(false);
      setErr(null);
      utils.chat.getSession.invalidate({ sessionId });
      utils.chat.sessionDetail.invalidate({ sessionId });
    },
    // Mid-turn is the one the user will actually hit: Claude Code declines to
    // re-pin while it is answering, so the server refuses rather than write a
    // model the session is not running.
    onError: (e) => setErr(e.message),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Fixed coordinates are a snapshot; anything that moves the chip under them
    // closes the menu rather than leaving it stranded beside nothing.
    const onMove = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The chat page listens for Escape on `window` to stop the running turn.
      // Closing this menu must not also kill the turn behind it.
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const current = (model ?? '').trim();
  const selected = current || DEFAULT_MODEL_VALUE;

  function toggle() {
    setErr(null);
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      // Kept on screen: the chip sits mid-header on a phone, and a 256px menu
      // hung from its left edge would run off the right side.
      const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 8));
      setPos({ left, top: r.bottom + 4 });
    }
    setOpen(true);
  }

  // The wrapper is not `relative`: the menu is positioned against the viewport.
  // It stays only so the outside-click test can ask "is this click in the chip
  // or in its menu" — `fixed` moves the box, not the DOM parent.
  return (
    <div ref={boxRef} className="shrink-0">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-expanded={open}
        aria-label="switch model"
        title={
          current
            ? `model: ${current} — click to switch (applied to the next message; the conversation is kept)`
            : "model: this machine's Claude Code default — click to switch"
        }
        className={cn(
          'shrink-0 font-mono rounded px-1 -mx-1 transition-colors',
          disabled ? 'opacity-50' : 'cursor-pointer hover:bg-accent/60 hover:text-foreground',
          open && 'bg-accent text-foreground',
        )}
      >
        {modelChipLabel(current || null, models)}
      </button>

      {/* `whitespace-normal font-sans` on the menu are not decoration: the
          header's meta line is nowrap + font-mono to keep itself on one line,
          and the menu is a DOM descendant of it however it is positioned, so
          both inherit. Without the reset the four options laid themselves out
          on ONE line, 1000px wide, three of them past the right edge of the
          window. */}
      {open && pos && (
        <div
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: MENU_W }}
          className="z-50 rounded-lg border border-border bg-popover p-1 shadow-lg whitespace-normal font-sans"
        >
          {models.map((m) => {
            const active = m.value === selected;
            return (
              <button
                key={m.value}
                type="button"
                disabled={setModel.isPending}
                onClick={() => setModel.mutate({ id: sessionId, model: modelPinOf(m.value) })}
                className={cn(
                  // `block`: a <button> is inline-block, and four of those in a
                  // row is what the nowrap above produced.
                  'block w-full rounded-md px-2 py-1.5 text-left transition-colors',
                  active ? 'bg-accent' : 'hover:bg-accent/50',
                  setModel.isPending ? 'cursor-wait opacity-60' : 'cursor-pointer',
                )}
              >
                <span className="block text-[13px] text-foreground">{m.displayName}</span>
                {m.description && (
                  <span className="block text-[11px] leading-snug text-muted-foreground">{m.description}</span>
                )}
              </button>
            );
          })}
          {/* Where the switch actually lands. Claude Code re-pins a live session
              with one control request — no respawn, no lost context — but not
              mid-turn, so the honest promise is "from your next message". */}
          <p className="px-2 py-1 text-[11px] leading-snug text-muted-foreground/80">
            Applies from your next message. The conversation is kept.
          </p>
          {err && <p className="px-2 pb-1 text-[11px] leading-snug text-rose-600 dark:text-rose-400">{err}</p>}
        </div>
      )}
    </div>
  );
}
