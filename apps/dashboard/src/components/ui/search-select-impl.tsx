"use client"

// The real base-ui Combobox behind SearchSelect. Loaded on demand by
// search-select.tsx (see the note there) — nothing outside that module should
// import this file, or base-ui's combobox root plus the floating-ui positioning
// engine lands in the importer's first-screen chunk.
//
// It is a Select, not a free-text field: the trigger shows the current value, and
// the only text you can type is the query, which lives INSIDE the popup. base-ui
// notices an Input mounted under the Popup and switches to that mode on its own —
// which is also what clears the query on close, and what makes a touch open focus
// the popup rather than the input (no keyboard in your face on a phone; tap the
// box when you actually want to search).
//
// The trigger label arrives as a prop rather than via <Combobox.Value> so that
// search-select.tsx's closed placeholder can render the very same text without
// importing anything from here.

import type { ReactNode } from "react"
import { Combobox } from "@base-ui/react/combobox"
import { Check, ChevronDown, Search } from "lucide-react"

import { cn } from "@/lib/utils"
import { SELECT_ICON_CLASS, SELECT_TRIGGER_CLASS, SELECT_VALUE_CLASS } from "./select-styles"

export type SearchSelectProps = {
  value: string
  onValueChange: (value: string) => void
  items: string[]
  /** Trigger text when nothing is picked yet. */
  placeholder?: string
  /** Trigger text when there is nothing to pick at all. */
  emptyPlaceholder?: string
  /** Query box placeholder. */
  searchPlaceholder?: string
  /** Popup text when the query matches nothing. */
  noMatchLabel?: string
  disabled?: boolean
  className?: string
  popupClassName?: string
  "aria-label"?: string
}

export function SearchSelectImpl({
  value,
  onValueChange,
  items,
  searchPlaceholder = "search",
  noMatchLabel = "no match",
  disabled,
  className,
  popupClassName,
  label,
  defaultOpen,
  ...props
}: SearchSelectProps & { label: ReactNode; defaultOpen?: boolean }) {
  return (
    <Combobox.Root
      items={items}
      // null, not '', for "nothing picked": base-ui takes '' for a real value and
      // would tick — and filter the list down to — an item named the empty string.
      value={value || null}
      onValueChange={(v) => onValueChange(v ?? "")}
      disabled={disabled}
      defaultOpen={defaultOpen}
      // Enter takes the top match right after typing, so the common case is
      // three letters and go, without ever reaching for the arrow keys.
      autoHighlight
      // Same reason as every other dropdown here: the modal backdrop's scroll
      // lock outlives the popup often enough to leave the page dead to clicks,
      // and nothing about picking from a list needs the page inert.
      modal={false}
    >
      <Combobox.Trigger
        data-slot="select-trigger"
        aria-label={props["aria-label"]}
        className={cn(SELECT_TRIGGER_CLASS, className)}
      >
        <span data-slot="select-value" className={SELECT_VALUE_CLASS}>{label}</span>
        <Combobox.Icon className={SELECT_ICON_CLASS}>
          <ChevronDown className="size-3.5" />
        </Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          data-slot="select-positioner"
          side="bottom"
          align="start"
          sideOffset={4}
          // z-[200] for the same reason the Select's positioner uses it: to float
          // above modal overlays (Overlay = z-110, lightbox = z-100).
          className="z-[200] outline-none"
        >
          <Combobox.Popup
            data-slot="select-content"
            className={cn(
              "flex max-h-[var(--available-height)] min-w-[var(--anchor-width)] flex-col origin-[var(--transform-origin)] overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              popupClassName,
            )}
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
              <Combobox.Input
                placeholder={searchPlaceholder}
                // text-base under md for the same reason input.tsx does it: iOS
                // zooms the page on focus for anything below 16px.
                className="min-w-0 flex-1 bg-transparent text-base text-foreground/90 outline-none placeholder:text-muted-foreground/60 md:text-[12px]"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {/* Empty stays mounted whatever the list does — it is a live region,
                  and base-ui only swaps its children in and out. Hence the padding
                  on the inner span: with no children the div must take up no room. */}
              <Combobox.Empty className="text-center text-[12px] text-muted-foreground">
                <span className="block px-2 py-3">{noMatchLabel}</span>
              </Combobox.Empty>
              <Combobox.List>
                {(item: string) => (
                  <Combobox.Item
                    key={item}
                    value={item}
                    data-slot="select-item"
                    className="relative flex cursor-pointer items-center gap-2 rounded-md py-1.5 pl-2 pr-7 text-[12px] text-popover-foreground/90 outline-none transition-colors select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                  >
                    <span className="min-w-0 flex-1 truncate">{item}</span>
                    <Combobox.ItemIndicator className="absolute right-2 inline-flex items-center text-foreground">
                      <Check className="size-3.5" />
                    </Combobox.ItemIndicator>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </div>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
