"use client"

// Deferred entry point for the app's Select.
//
// base-ui's Select drags in the combobox machinery plus the floating-ui
// positioning engine — 75 KB raw / 25 KB gzip of JS that only matters once a
// dropdown is actually opened, yet it sat in the first-screen bundle of every
// route that renders one (/agents, /cron, /pi, /market/skills). So the base-ui
// parts live in select-impl.tsx and load on demand:
//
//   closed  → a plain <button> carrying the exact same classes and the same
//             label (every call site formats the label itself via
//             <SelectValue>{(v) => …}</SelectValue>), and no popup markup at all.
//   opening → the first pointer-down / open-key swaps in the real base-ui Select
//             mounted `defaultOpen`, so one click still opens the menu.
//
// The chunk is warmed on idle after first paint (same trick as markdown.tsx), so
// by the time anyone reaches for a dropdown it is normally already in memory and
// the swap is a synchronous state update. We deliberately do NOT swap on warm:
// leaving the placeholder in place until it is used means a focused trigger can
// never be yanked out from under the keyboard.

import type {
  SelectItemProps,
  SelectPopupProps,
  SelectRootProps,
  SelectTriggerProps,
  SelectValueProps,
} from "@base-ui/react/select"
import { ChevronDown } from "lucide-react"
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
} from "react"

import { cn } from "@/lib/utils"
import { SELECT_ICON_CLASS, SELECT_TRIGGER_CLASS, SELECT_VALUE_CLASS } from "./select-styles"

type SelectImpl = typeof import("./select-impl")

// Module-level cache: once resolved, later Selects mount the real thing straight
// away and `open()` becomes a synchronous setState (popup in the same frame).
let impl: SelectImpl | null = null
let implPromise: Promise<SelectImpl> | null = null
function loadImpl(): Promise<SelectImpl> {
  implPromise ??= import("./select-impl").then((m) => (impl = m))
  return implPromise
}

if (typeof window !== "undefined") {
  const w = window as unknown as { requestIdleCallback?: (cb: () => void) => void }
  const warm = () => { void loadImpl() }
  ;(w.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500)))(warm)
}

// Non-null only after the swap; the parts below use it to hand rendering over to
// the real base-ui components.
const ImplContext = createContext<SelectImpl | null>(null)

type Deferred = { value: unknown; disabled: boolean | undefined; open: () => void }
const DeferredContext = createContext<Deferred | null>(null)

// Keys that open a native <select>; anything else stays with the button.
const OPEN_KEYS = new Set([" ", "Enter", "ArrowDown", "ArrowUp"])

function Select<Value, Multiple extends boolean | undefined = false>(
  props: SelectRootProps<Value, Multiple>,
) {
  const [loaded, setLoaded] = useState<SelectImpl | null>(impl)
  const [openOnLoad, setOpenOnLoad] = useState(false)

  const open = useCallback(() => {
    setOpenOnLoad(true)
    if (impl) { setLoaded(impl); return }
    void loadImpl().then((m) => { setLoaded(m) })
  }, [])

  const { value, defaultValue, disabled, children } = props
  const deferred = useMemo<Deferred>(
    () => ({ value: value ?? defaultValue ?? null, disabled, open }),
    [value, defaultValue, disabled, open],
  )

  if (!loaded) {
    return <DeferredContext.Provider value={deferred}>{children}</DeferredContext.Provider>
  }

  const Root = loaded.SelectRoot as (p: SelectRootProps<Value, Multiple>) => ReactElement
  return (
    <ImplContext.Provider value={loaded}>
      <Root {...props} defaultOpen={openOnLoad || props.defaultOpen} />
    </ImplContext.Provider>
  )
}

function SelectValue({ className, children, ...props }: SelectValueProps) {
  const loaded = useContext(ImplContext)
  const deferred = useContext(DeferredContext)
  if (loaded) {
    return <loaded.SelectValue className={className} {...props}>{children}</loaded.SelectValue>
  }
  return (
    <span
      data-slot="select-value"
      className={cn(SELECT_VALUE_CLASS, typeof className === "string" ? className : undefined)}
    >
      {typeof children === "function" ? children(deferred?.value ?? null) : (children ?? props.placeholder)}
    </span>
  )
}

function SelectTrigger({ className, children, ...props }: SelectTriggerProps) {
  const loaded = useContext(ImplContext)
  const deferred = useContext(DeferredContext)
  if (loaded) {
    return <loaded.SelectTrigger className={className} {...props}>{children}</loaded.SelectTrigger>
  }
  // Only className / aria-label are ever passed here, but forward the rest and
  // chain any handler so the placeholder behaves like the button it replaces.
  const rest = props as ButtonHTMLAttributes<HTMLButtonElement>
  return (
    <button
      type="button"
      data-slot="select-trigger"
      aria-haspopup="listbox"
      aria-expanded={false}
      disabled={deferred?.disabled}
      {...rest}
      className={cn(SELECT_TRIGGER_CLASS, typeof className === "string" ? className : undefined)}
      // Swap on `click`, not `pointerdown`: the real trigger mounts under the
      // pointer, so a pointerdown swap leaves the browser's trailing click to
      // land on base-ui's trigger, which toggles the just-opened popup shut.
      // stopPropagation keeps that same click from reaching any document-level
      // outside-press handler the popup installs as it mounts.
      onClick={(e) => {
        rest.onClick?.(e)
        e.preventDefault()
        e.stopPropagation()
        deferred?.open()
      }}
      onKeyDown={(e) => {
        rest.onKeyDown?.(e)
        if (OPEN_KEYS.has(e.key)) { e.preventDefault(); deferred?.open() }
      }}
      // Cheap head start: by the time a click or key lands, the chunk is
      // normally already parsed and the swap is a synchronous setState.
      onPointerDown={(e) => { rest.onPointerDown?.(e); void loadImpl() }}
      onPointerEnter={(e) => { rest.onPointerEnter?.(e); void loadImpl() }}
      onFocus={(e) => { rest.onFocus?.(e); void loadImpl() }}
    >
      {children}
      <span aria-hidden className={SELECT_ICON_CLASS}>
        <ChevronDown className="size-3.5" />
      </span>
    </button>
  )
}

function SelectContent({ children, ...props }: SelectPopupProps & { sideOffset?: number }) {
  const loaded = useContext(ImplContext)
  // Closed and never loaded: the popup doesn't exist yet, so neither do its items.
  if (!loaded) return null
  return <loaded.SelectContent {...props}>{children}</loaded.SelectContent>
}

function SelectItem({ children, ...props }: SelectItemProps) {
  const loaded = useContext(ImplContext)
  if (!loaded) return null
  return <loaded.SelectItem {...props}>{children}</loaded.SelectItem>
}

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem }
