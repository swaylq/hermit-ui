"use client"

// The real base-ui Select. Loaded on demand by select.tsx (see the note there) —
// nothing outside that module should import this file, or the combobox +
// floating-ui positioning engine lands back in the importer's first-screen chunk.

import { Select as SelectPrimitive } from "@base-ui/react/select"
import { Check, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { SELECT_ICON_CLASS, SELECT_TRIGGER_CLASS, SELECT_VALUE_CLASS } from "./select-styles"

// Root re-exported directly so its <Value, Multiple> generics pass through.
const SelectRoot = SelectPrimitive.Root

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn(SELECT_VALUE_CLASS, className)}
      {...props}
    />
  )
}

function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(SELECT_TRIGGER_CLASS, className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className={SELECT_ICON_CLASS}>
        <ChevronDown className="size-3.5" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  sideOffset = 4,
  ...props
}: SelectPrimitive.Popup.Props & { sideOffset?: number }) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        data-slot="select-positioner"
        side="bottom"
        align="start"
        sideOffset={sideOffset}
        alignItemWithTrigger={false}
        // z-[200] so the dropdown floats ABOVE modal overlays (Overlay = z-110,
        // lightbox = z-100) when a Select is used inside one — e.g. the market
        // skill detail's group setter. Was z-50, which hid behind the modal.
        className="z-[200] outline-none"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "max-h-[var(--available-height)] min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex cursor-pointer items-center gap-2 rounded-md py-1.5 pl-2 pr-7 text-[12px] text-popover-foreground/90 outline-none transition-colors select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center text-foreground">
        <Check className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

export { SelectRoot, SelectValue, SelectTrigger, SelectContent, SelectItem }
