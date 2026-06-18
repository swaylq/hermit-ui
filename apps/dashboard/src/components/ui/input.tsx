import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const BASE =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"

// A clear-x only makes sense on text-like fields. Steppers (number), file /
// checkbox, pickers, etc. render as the bare input — no wrapper, no layout change.
function isClearableType(type?: string): boolean {
  return type == null || ["text", "search", "email", "url", "tel"].includes(type)
}

function Input({
  className,
  type,
  clearable = true,
  wrapperClassName,
  value,
  defaultValue,
  disabled,
  readOnly,
  onChange,
  ...props
}: React.ComponentProps<"input"> & { clearable?: boolean; wrapperClassName?: string }) {
  const ref = React.useRef<HTMLInputElement>(null)
  const enableClear = clearable && isClearableType(type) && !disabled && !readOnly

  // Clear-button visibility. Controlled inputs (value provided) read it straight
  // off `value`; uncontrolled ones track it via the input's own change events.
  const isControlled = value !== undefined
  const [uncontrolledHas, setUncontrolledHas] = React.useState(() => !!defaultValue)
  const hasValue = isControlled ? String(value ?? "").length > 0 : uncontrolledHas
  const showClear = enableClear && hasValue

  const input = (
    <InputPrimitive
      ref={ref}
      type={type}
      data-slot="input"
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      readOnly={readOnly}
      onChange={(e) => {
        if (enableClear && !isControlled) setUncontrolledHas(e.target.value.length > 0)
        onChange?.(e)
      }}
      className={cn(BASE, showClear && "pr-7", className)}
      {...props}
    />
  )

  // Non-text inputs keep the exact previous DOM (a bare input) — no wrapper.
  if (!enableClear) return input

  // Clear via the native value setter + an 'input' event so React's onChange
  // fires — works for controlled (parent state resets) and uncontrolled alike.
  const clear = () => {
    const el = ref.current
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
      setter?.call(el, "")
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.focus()
    }
    if (!isControlled) setUncontrolledHas(false)
  }

  return (
    <span data-slot="input-wrapper" className={cn("relative block w-full", wrapperClassName)}>
      {input}
      {showClear && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="clear"
          // preventDefault on mousedown so clicking the x doesn't blur the input first
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  )
}

export { Input }
