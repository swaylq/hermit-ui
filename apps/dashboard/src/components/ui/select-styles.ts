// Class strings shared by the two halves of the Select (select.tsx's deferred
// placeholder and select-impl.tsx's real base-ui parts). They live here, in a
// module with no base-ui import, so the placeholder can be pixel-identical to
// the real trigger without either half importing the other.

export const SELECT_TRIGGER_CLASS =
  "group flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12px] text-foreground/90 outline-none transition-colors hover:border-foreground/20 hover:bg-accent/50 focus-visible:border-foreground/40 focus-visible:ring-1 focus-visible:ring-foreground/15 data-[popup-open]:border-foreground/30"

export const SELECT_ICON_CLASS =
  "shrink-0 text-muted-foreground/60 transition-transform duration-150 group-data-[popup-open]:rotate-180"

export const SELECT_VALUE_CLASS = "min-w-0 flex-1 truncate text-left"
