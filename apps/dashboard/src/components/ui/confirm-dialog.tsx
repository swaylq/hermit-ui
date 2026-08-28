'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

// The app's global, promise-based dialogs — the styled replacement for the
// browser's native confirm() AND prompt(). Call `const confirm = useConfirm()`
// or `const prompt = usePrompt()` in any component, then
// `if (await confirm({ ... })) doIt()` / `const name = await prompt({ ... })`.
//
// Both share one pending slot, so they also share the portal, the dim, the
// scroll-lock and the Esc handling below — a prompt is a confirm with one text
// field, not a second dialog implementation.
//
// Built with a BARE createPortal + hand-managed Esc/Enter + scroll-lock +
// opaque popup, NOT base-ui Dialog: base-ui's Backdrop animate-in sticks at
// opacity:0 and nested transparency gets composited away here (see the
// base-ui overlay-quirks lesson). It also has to render correctly when fired
// from INSIDE a base-ui modal Sheet (e.g. the agent-detail skill list): the
// portal is appended to <body> after the sheet opened, so base-ui's one-shot
// markOthers() inert sweep never tagged it; the capture-phase key handler
// below stops Esc/Enter from also reaching the sheet underneath.
export type ConfirmOptions = {
  title?: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions (delete, etc). */
  danger?: boolean;
};

/** A confirm plus one text field. Resolves to the trimmed value, or null if cancelled. */
export type PromptOptions = ConfirmOptions & {
  /** Prefilled AND selected on open, so a rename can be typed straight over. */
  defaultValue?: string;
  placeholder?: string;
  /** Mirror the server's limit here so the field can't overrun it. */
  maxLength?: number;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
type PromptFn = (opts: PromptOptions) => Promise<string | null>;

const ConfirmContext = createContext<ConfirmFn | null>(null);
const PromptContext = createContext<PromptFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return fn;
}

export function usePrompt(): PromptFn {
  const fn = useContext(PromptContext);
  if (!fn) throw new Error('usePrompt must be used within <ConfirmProvider>');
  return fn;
}

type Pending =
  | (ConfirmOptions & { kind: 'confirm'; resolve: (v: boolean) => void })
  | (PromptOptions & { kind: 'prompt'; resolve: (v: string | null) => void });

// The shared footer. `disabled` only ever comes from the prompt field being empty.
function Actions({
  confirmLabel,
  cancelLabel,
  danger,
  disabled,
  onCancel,
  onConfirm,
}: {
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex h-8 items-center rounded-md px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
      >
        {cancelLabel ?? 'Cancel'}
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={disabled}
        className={cn(
          'inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-40',
          danger
            ? 'bg-rose-600 text-white hover:bg-rose-500'
            : 'bg-foreground text-background hover:bg-foreground/90',
        )}
      >
        {confirmLabel ?? 'Confirm'}
      </button>
    </div>
  );
}

// The prompt's field + footer. Its own component so typing re-renders this and
// not the whole provider (and therefore not the entire app under it).
function PromptBody({
  options,
  onCancel,
  onSubmit,
}: {
  options: PromptOptions;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(options.defaultValue ?? '');
  const ref = useRef<HTMLInputElement>(null);
  // Focus on open; select a prefilled value so "rename" starts as type-over.
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const valid = value.trim().length > 0;
  return (
    <>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Enter submits — but NOT while an IME is composing: typing Chinese
          // sends Enter to accept a candidate, which would submit the pinyin.
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (valid) onSubmit(value);
          }
        }}
        placeholder={options.placeholder}
        maxLength={options.maxLength}
        aria-label={options.title ?? options.placeholder ?? 'value'}
        // text-base until md: a <16px field makes iOS zoom the page on focus
        // (same reason as ui/input.tsx).
        className="mt-3 h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
      />
      <Actions
        confirmLabel={options.confirmLabel}
        cancelLabel={options.cancelLabel}
        danger={options.danger}
        disabled={!valid}
        onCancel={onCancel}
        onConfirm={() => onSubmit(value)}
      />
    </>
  );
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Enter/leave animation, same controlled-show pattern as overlay.tsx: mount
  // hidden, flip to shown next frame; the leave transition plays before unmount.
  const [show, setShow] = useState(false);
  // Mirror into a ref so settle()/supersede read the latest without being a
  // side-effect inside a state updater (which React double-invokes in dev).
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  // Supersede any in-flight dialog (rare — you can't normally open two).
  const open = useCallback((next: Pending) => {
    const p = pendingRef.current;
    if (p) {
      if (p.kind === 'prompt') p.resolve(null);
      else p.resolve(false);
    }
    setPending(next);
  }, []);

  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<boolean>((resolve) => open({ ...opts, kind: 'confirm', resolve })),
    [open],
  );

  const prompt = useCallback<PromptFn>(
    (opts) => new Promise<string | null>((resolve) => open({ ...opts, kind: 'prompt', resolve })),
    [open],
  );

  // `value` is the prompt's field; a confirm ignores it. An empty submit can't
  // reach here (the field guards it), but treat it as a cancel if it ever does.
  // The promise resolves immediately; the dialog stays mounted for the 150ms
  // leave transition before `pending` clears and the portal unmounts.
  const settle = useCallback((ok: boolean, value?: string) => {
    const p = pendingRef.current;
    if (p) {
      if (p.kind === 'prompt') {
        const v = (value ?? '').trim();
        p.resolve(ok && v ? v : null);
      } else {
        p.resolve(ok);
      }
    }
    setShow(false);
    // Unmount only if nothing newer superseded this dialog during the leave.
    window.setTimeout(() => {
      if (pendingRef.current === p) setPending(null);
    }, 150);
  }, []);

  // While open: Esc cancels, Enter confirms, body scroll locks. Capture phase +
  // stopImmediatePropagation so a base-ui Sheet/Dialog underneath doesn't ALSO
  // act on the same Esc/Enter (which would close the sheet behind the confirm).
  useEffect(() => {
    if (!pending) return;
    // Enter: mount hidden, flip to shown next frame so the CSS transition runs.
    const r = requestAnimationFrame(() => setShow(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation(); settle(false);
      } else if (e.key === 'Enter' && pending.kind === 'confirm') {
        // A prompt's Enter belongs to its own field — it carries the value and
        // has to let an IME composition finish first (see PromptBody).
        e.preventDefault(); e.stopImmediatePropagation(); settle(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(r);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [pending, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      <PromptContext.Provider value={prompt}>
        {children}
        {pending && typeof document !== 'undefined'
          ? createPortal(
              <div
                className={cn(
                  'fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4 transition-opacity duration-150 ease-out',
                  show ? 'opacity-100' : 'opacity-0',
                )}
                // Click the dimmed area (not the popup) to cancel. The dim is on
                // THIS element (not a child overlay) so an outside click's target
                // IS currentTarget — a separate backdrop child would swallow it.
                onPointerDown={(e) => { if (e.target === e.currentTarget) settle(false); }}
              >
                <div
                  role={pending.kind === 'prompt' ? 'dialog' : 'alertdialog'}
                  aria-modal="true"
                  className={cn(
                    'w-full max-w-sm rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl transition-[opacity,transform] duration-150 ease-out',
                    show ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
                  )}
                >
                  {pending.title && (
                    <h2 className="text-sm font-semibold text-foreground">{pending.title}</h2>
                  )}
                  {pending.message != null && (
                    <div className={cn('text-[13px] leading-relaxed text-muted-foreground', pending.title && 'mt-1.5')}>
                      {pending.message}
                    </div>
                  )}
                  {pending.kind === 'prompt' ? (
                    <PromptBody
                      options={pending}
                      onCancel={() => settle(false)}
                      onSubmit={(v) => settle(true, v)}
                    />
                  ) : (
                    <Actions
                      confirmLabel={pending.confirmLabel}
                      cancelLabel={pending.cancelLabel}
                      danger={pending.danger}
                      onCancel={() => settle(false)}
                      onConfirm={() => settle(true)}
                    />
                  )}
                </div>
              </div>,
              document.body,
            )
          : null}
      </PromptContext.Provider>
    </ConfirmContext.Provider>
  );
}
