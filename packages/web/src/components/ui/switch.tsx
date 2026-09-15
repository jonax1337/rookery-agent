import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"
import {
  motion,
  type HTMLMotionProps,
  type LegacyAnimationControls,
  type TargetAndTransition,
  type VariantLabels,
} from "motion/react"

import { getStrictContext } from "@/lib/get-strict-context"
import { useControlledState } from "@/hooks/use-controlled-state"

type SwitchContextType = {
  isChecked: boolean
  setIsChecked: (isChecked: boolean) => void
  isPressed: boolean
  setIsPressed: (isPressed: boolean) => void
}

const [SwitchProvider, useSwitch] =
  getStrictContext<SwitchContextType>("SwitchContext")

type SwitchProps = HTMLMotionProps<"button"> &
  Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, "asChild"> & {
    size?: "sm" | "default"
  }

function Switch({
  className,
  size = "default",
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  required,
  name,
  value,
  ...props
}: SwitchProps) {
  const [isPressed, setIsPressed] = React.useState(false)
  const [isChecked, setIsChecked] = useControlledState({
    value: checked,
    defaultValue: defaultChecked,
    onChange: onCheckedChange,
  })

  return (
    <SwitchProvider value={{ isChecked, setIsChecked, isPressed, setIsPressed }}>
      <SwitchPrimitive.Root
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={setIsChecked}
        disabled={disabled}
        required={required}
        name={name}
        value={value}
        asChild
      >
        <motion.button
          data-slot="switch"
          data-size={size}
          whileTap="tap"
          initial={false}
          onTapStart={() => setIsPressed(true)}
          onTapCancel={() => setIsPressed(false)}
          onTap={() => setIsPressed(false)}
          className={cn(
            "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none group-has-[:focus-visible]/field-label:border-transparent group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-input/80 data-disabled:cursor-not-allowed data-disabled:opacity-50",
            className
          )}
          {...props}
        >
          <SwitchThumb />
        </motion.button>
      </SwitchPrimitive.Root>
    </SwitchProvider>
  )
}

type SwitchThumbProps = Omit<
  React.ComponentProps<typeof SwitchPrimitive.Thumb>,
  "asChild"
> &
  HTMLMotionProps<"div"> & {
    pressedAnimation?:
      | TargetAndTransition
      | VariantLabels
      | boolean
      | LegacyAnimationControls
  }

function SwitchThumb({
  pressedAnimation,
  transition = { type: "spring", stiffness: 300, damping: 25 },
  className,
  ...props
}: SwitchThumbProps) {
  const { isPressed } = useSwitch()

  return (
    <SwitchPrimitive.Thumb asChild>
      <motion.div
        data-slot="switch-thumb"
        whileTap="tab"
        layout
        transition={transition}
        animate={isPressed ? pressedAnimation : undefined}
        className={cn(
          "pointer-events-none block rounded-full bg-background ring-0 group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] dark:data-checked:bg-primary-foreground group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0 dark:data-unchecked:bg-foreground",
          className
        )}
        {...props}
      />
    </SwitchPrimitive.Thumb>
  )
}

export { Switch }
