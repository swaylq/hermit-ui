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

// A global, promise-based confirm dialog — the styled replacement for the
// browser's native confirm(). Call `const confirm = useConfirm()` in any
// component, then `if (await confirm({ ... })) doIt()`.
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

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return fn;
}

type Pending = ConfirmOptions & { resolve: (v: boolean) => void };

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Mirror into a ref so settle()/supersede read the latest without being a
  // side-effect inside a state updater (which React double-invokes in dev).
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      // Supersede any in-flight confirm (rare — you can't normally open two).
      if (pendingRef.current) pendingRef.current.resolve(false);
      setPending({ ...opts, resolve });
    });
  }, []);

  const settle = useCallback((v: boolean) => {
    const p = pendingRef.current;
    if (p) p.resolve(v);
    setPending(null);
  }, []);

  // While open: Esc cancels, Enter confirms, body scroll locks. Capture phase +
  // stopImmediatePropagation so a base-ui Sheet/Dialog underneath doesn't ALSO
  // act on the same Esc/Enter (which would close the sheet behind the confirm).
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation(); settle(false);
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopImmediatePropagation(); settle(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [pending, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4"
              // Click the dimmed area (not the popup) to cancel. The dim is on
              // THIS element (not a child overlay) so an outside click's target
              // IS currentTarget — a separate backdrop child would swallow it.
              onPointerDown={(e) => { if (e.target === e.currentTarget) settle(false); }}
            >
              <div
                role="alertdialog"
                aria-modal="true"
                className="w-full max-w-sm rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
              >
                {pending.title && (
                  <h2 className="text-sm font-semibold text-foreground">{pending.title}</h2>
                )}
                {pending.message != null && (
                  <div className={cn('text-[13px] leading-relaxed text-muted-foreground', pending.title && 'mt-1.5')}>
                    {pending.message}
                  </div>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => settle(false)}
                    className="inline-flex h-8 items-center rounded-md px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                  >
                    {pending.cancelLabel ?? 'Cancel'}
                  </button>
                  <button
                    type="button"
                    onClick={() => settle(true)}
                    className={cn(
                      'inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium transition-colors cursor-pointer',
                      pending.danger
                        ? 'bg-rose-600 text-white hover:bg-rose-500'
                        : 'bg-foreground text-background hover:bg-foreground/90',
                    )}
                  >
                    {pending.confirmLabel ?? 'Confirm'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </ConfirmContext.Provider>
  );
}
