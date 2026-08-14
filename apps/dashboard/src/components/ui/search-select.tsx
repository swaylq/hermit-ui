"use client"

// A Select whose popup carries a search box — for lists too long to eyeball, like
// the fleet's agents on the New chat screen.
//
// Deferred exactly the way select.tsx defers its own popup, and for the same
// reason: base-ui's combobox plus the floating-ui positioning engine is a chunk
// nobody should download to look at a closed dropdown.
//
//   closed  → a plain <button> carrying the same trigger classes and the same
//             label as the real thing, and no popup markup at all.
//   opening → the first pointer-down / open-key swaps in the real base-ui
//             Combobox mounted `defaultOpen`, so one click still opens the menu.
//
// The chunk is warmed on idle after first paint; the swap on warm is deliberately
// NOT done, so a focused trigger can never be yanked out from under the keyboard.

import { ChevronDown } from "lucide-react"
import { useCallback, useState, type ButtonHTMLAttributes } from "react"

import { cn } from "@/lib/utils"
import { SELECT_ICON_CLASS, SELECT_TRIGGER_CLASS, SELECT_VALUE_CLASS } from "./select-styles"
import type { SearchSelectProps } from "./search-select-impl"

export type { SearchSelectProps }

type Impl = typeof import("./search-select-impl")

// Module-level cache: once resolved, later SearchSelects mount the real thing
// straight away and `open()` becomes a synchronous setState.
let impl: Impl | null = null
let implPromise: Promise<Impl> | null = null
function loadImpl(): Promise<Impl> {
  implPromise ??= import("./search-select-impl").then((m) => (impl = m))
  return implPromise
}

if (typeof window !== "undefined") {
  const w = window as unknown as { requestIdleCallback?: (cb: () => void) => void }
  const warm = () => { void loadImpl() }
  ;(w.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500)))(warm)
}

// Keys that open a native <select>; anything else stays with the button.
const OPEN_KEYS = new Set([" ", "Enter", "ArrowDown", "ArrowUp"])

export function SearchSelect(props: SearchSelectProps) {
  const [loaded, setLoaded] = useState<Impl | null>(impl)
  const [openOnLoad, setOpenOnLoad] = useState(false)

  const open = useCallback(() => {
    setOpenOnLoad(true)
    if (impl) { setLoaded(impl); return }
    void loadImpl().then((m) => { setLoaded(m) })
  }, [])

  const { value, items, placeholder, emptyPlaceholder, disabled, className } = props
  // Computed here, in the half that has no base-ui import, so both halves show
  // the identical trigger text.
  const label = value || (items.length ? placeholder : emptyPlaceholder)

  if (loaded) return <loaded.SearchSelectImpl {...props} label={label} defaultOpen={openOnLoad} />

  const rest: ButtonHTMLAttributes<HTMLButtonElement> = { "aria-label": props["aria-label"] }
  return (
    <button
      type="button"
      data-slot="select-trigger"
      // dialog, not listbox: with the query box inside it, that is what the real
      // popup is, and what base-ui's own trigger advertises.
      aria-haspopup="dialog"
      aria-expanded={false}
      disabled={disabled}
      {...rest}
      className={cn(SELECT_TRIGGER_CLASS, className)}
      // Swap on `click`, not `pointerdown`: the real trigger mounts under the
      // pointer, so a pointerdown swap leaves the browser's trailing click to
      // land on base-ui's trigger, which toggles the just-opened popup shut.
      // stopPropagation keeps that same click from reaching any document-level
      // outside-press handler the popup installs as it mounts.
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        open()
      }}
      onKeyDown={(e) => {
        if (OPEN_KEYS.has(e.key)) { e.preventDefault(); open() }
      }}
      // Cheap head start: by the time a click or key lands, the chunk is
      // normally already parsed and the swap is a synchronous setState.
      onPointerDown={() => { void loadImpl() }}
      onPointerEnter={() => { void loadImpl() }}
      onFocus={() => { void loadImpl() }}
    >
      <span data-slot="select-value" className={SELECT_VALUE_CLASS}>{label}</span>
      <span aria-hidden className={SELECT_ICON_CLASS}>
        <ChevronDown className="size-3.5" />
      </span>
    </button>
  )
}
