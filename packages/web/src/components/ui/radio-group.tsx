import * as React from "react"
import { cn } from "cn"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"
import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react"
import { getStrictContext } from "@/lib/get-strict-context"
import { useControlledState } from "@/hooks/use-controlled-state"

type RadioGroupContextType = {
  value: string
  setValue: (value: string) => void
}

type RadioGroupItemContextType = {
  isChecked: boolean
  setIsChecked: (isChecked: boolean) => void
}

const [RadioGroupProvider, useRadioGroup] =
  getStrictContext<RadioGroupContextType>("RadioGroupContext")

const [RadioGroupItemProvider, useRadioGroupItem] =
  getStrictContext<RadioGroupItemContextType>("RadioGroupItemContext")

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  const [value, setValue] = useControlledState({
    value: props.value ?? undefined,
    defaultValue: props.defaultValue,
    onChange: props.onValueChange,
  })

  return (
    <RadioGroupProvider value={{ value, setValue }}>
      <RadioGroupPrimitive.Root
        data-slot="radio-group"
        className={cn("grid w-full gap-3", className)}
        {...props}
        onValueChange={setValue}
      />
    </RadioGroupProvider>
  )
}

type RadioGroupIndicatorProps = Omit<
  React.ComponentProps<typeof RadioGroupPrimitive.Indicator>,
  "asChild" | "forceMount"
> &
  HTMLMotionProps<"div">

function RadioGroupIndicator({
  transition = { type: "spring", stiffness: 200, damping: 16 },
  ...props
}: RadioGroupIndicatorProps) {
  const { isChecked } = useRadioGroupItem()

  return (
    <AnimatePresence>
      {isChecked && (
        <RadioGroupPrimitive.Indicator
          data-slot="radio-group-indicator"
          asChild
          forceMount
        >
          <motion.div
            key="radio-group-indicator-circle"
            data-slot="radio-group-indicator-circle"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0 }}
            transition={transition}
            {...props}
          />
        </RadioGroupPrimitive.Indicator>
      )}
    </AnimatePresence>
  )
}

type RadioGroupItemProps = Omit<
  React.ComponentProps<typeof RadioGroupPrimitive.Item>,
  "asChild"
> &
  HTMLMotionProps<"button">

function RadioGroupItem({
  value: valueProps,
  disabled,
  required,
  className,
  ...props
}: RadioGroupItemProps) {
  const { value } = useRadioGroup()
  const [isChecked, setIsChecked] = React.useState(value === valueProps)

  React.useEffect(() => {
    setIsChecked(value === valueProps)
  }, [value, valueProps])

  return (
    <RadioGroupItemProvider value={{ isChecked, setIsChecked }}>
      <RadioGroupPrimitive.Item
        asChild
        value={valueProps}
        disabled={disabled}
        required={required}
      >
        <motion.button
          data-slot="radio-group-item"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className={cn(
            "group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-input outline-none group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary dark:data-checked:bg-primary",
            className
          )}
          {...props}
        >
          <RadioGroupIndicator className="flex size-4 items-center justify-center">
            <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
          </RadioGroupIndicator>
        </motion.button>
      </RadioGroupPrimitive.Item>
    </RadioGroupItemProvider>
  )
}

export { RadioGroup, RadioGroupItem }
