"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react"
import { Toggle as TogglePrimitive } from "radix-ui"

import { useControlledState } from "@/hooks/use-controlled-state"
import { getStrictContext } from "@/lib/get-strict-context"

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-md text-sm font-medium whitespace-nowrap transition-[color,box-shadow] outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-muted dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-transparent shadow-xs hover:bg-muted",
      },
      size: {
        default:
          "h-9 min-w-9 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        lg: "h-10 min-w-10 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ToggleContextType = {
  isPressed: boolean
  setIsPressed: (isPressed: boolean) => void
  disabled?: boolean
}

const [ToggleProvider, useToggle] =
  getStrictContext<ToggleContextType>("ToggleContext")

type ToggleProps = Omit<
  React.ComponentProps<typeof TogglePrimitive.Root>,
  "asChild"
> &
  HTMLMotionProps<"button"> &
  VariantProps<typeof toggleVariants>

function Toggle({
  className,
  variant = "default",
  size = "default",
  pressed,
  defaultPressed,
  onPressedChange,
  disabled,
  ...props
}: ToggleProps) {
  const [isPressed, setIsPressed] = useControlledState({
    value: pressed,
    defaultValue: defaultPressed,
    onChange: onPressedChange,
  })

  return (
    <ToggleProvider value={{ isPressed, setIsPressed, disabled }}>
      <TogglePrimitive.Root
        pressed={pressed}
        defaultPressed={defaultPressed}
        onPressedChange={setIsPressed}
        disabled={disabled}
        asChild
      >
        <motion.button
          data-slot="toggle"
          whileTap={{ scale: 0.95 }}
          className={cn(toggleVariants({ variant, size, className }))}
          {...props}
        />
      </TogglePrimitive.Root>
    </ToggleProvider>
  )
}

type ToggleHighlightProps = HTMLMotionProps<"div">

function ToggleHighlight({ style, ...props }: ToggleHighlightProps) {
  const { isPressed, disabled } = useToggle()

  return (
    <AnimatePresence>
      {isPressed && (
        <motion.div
          data-slot="toggle-highlight"
          aria-pressed={isPressed}
          data-state={isPressed ? "on" : "off"}
          data-disabled={disabled}
          style={{ position: "absolute", zIndex: 0, inset: 0, ...style }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          {...props}
        />
      )}
    </AnimatePresence>
  )
}

type ToggleItemProps = HTMLMotionProps<"div">

function ToggleItem({ style, ...props }: ToggleItemProps) {
  const { isPressed, disabled } = useToggle()

  return (
    <motion.div
      data-slot="toggle-item"
      aria-pressed={isPressed}
      data-state={isPressed ? "on" : "off"}
      data-disabled={disabled}
      style={{ position: "relative", zIndex: 1, ...style }}
      {...props}
    />
  )
}

export {
  Toggle,
  ToggleHighlight,
  ToggleItem,
  useToggle,
  toggleVariants,
  type ToggleProps,
  type ToggleHighlightProps,
  type ToggleItemProps,
  type ToggleContextType,
}
