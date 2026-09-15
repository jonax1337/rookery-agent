"use client"

import * as React from "react"
import { type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"
import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react"

import {
  Highlight,
  HighlightItem,
  type HighlightItemProps,
  type HighlightProps,
} from "@/components/animate-ui/primitives/effects/highlight"
import { toggleVariants } from "@/components/ui/toggle"
import { useControlledState } from "@/hooks/use-controlled-state"
import { getStrictContext } from "@/lib/get-strict-context"

type ToggleGroupContextType = {
  value: string | string[] | undefined
  setValue: (value: string | string[] | undefined) => void
  type: "single" | "multiple"
}

const [ToggleGroupProvider, useToggleGroup] =
  getStrictContext<ToggleGroupContextType>("ToggleGroupContext")

const ToggleGroupVariantContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }
>({
  size: "default",
  variant: "default",
  spacing: 2,
  orientation: "horizontal",
})

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 2,
  orientation = "horizontal",
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }) {
  const [value, setValue] = useControlledState<string | string[] | undefined>({
    value: props.value,
    defaultValue: props.defaultValue,
    onChange: props.onValueChange as (
      value: string | string[] | undefined
    ) => void,
  })

  return (
    <ToggleGroupProvider value={{ value, setValue, type: props.type }}>
      <ToggleGroupPrimitive.Root
        data-slot="toggle-group"
        data-variant={variant}
        data-size={size}
        data-spacing={spacing}
        data-orientation={orientation}
        style={{ "--gap": spacing } as React.CSSProperties}
        className={cn(
          "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-md data-[spacing=0]:data-[variant=outline]:shadow-xs data-vertical:flex-col data-vertical:items-stretch",
          className
        )}
        {...props}
        onValueChange={setValue}
      >
        <ToggleGroupVariantContext.Provider
          value={{ variant, size, spacing, orientation }}
        >
          {children}
        </ToggleGroupVariantContext.Provider>
      </ToggleGroupPrimitive.Root>
    </ToggleGroupProvider>
  )
}

function ToggleGroupItem({
  value,
  disabled,
  className,
  children,
  variant = "default",
  size = "default",
  ...props
}: Omit<React.ComponentProps<typeof ToggleGroupPrimitive.Item>, "asChild"> &
  VariantProps<typeof toggleVariants> &
  HTMLMotionProps<"button">) {
  const context = React.useContext(ToggleGroupVariantContext)

  return (
    <ToggleGroupPrimitive.Item value={value} disabled={disabled} asChild>
      <motion.button
        data-slot="toggle-group-item"
        data-variant={context.variant || variant}
        data-size={context.size || size}
        data-spacing={context.spacing}
        whileTap={{ scale: 0.95 }}
        className={cn(
          "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 group-data-[spacing=0]/toggle-group:shadow-none focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-md group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-md group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-md group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-md data-[state=on]:bg-muted group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t",
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        className
      )}
        {...props}
      >
        {children}
      </motion.button>
    </ToggleGroupPrimitive.Item>
  )
}

type ToggleGroupHighlightProps = Omit<HighlightProps, "controlledItems">

function ToggleGroupHighlight({
  transition = { type: "spring", stiffness: 200, damping: 25 },
  ...props
}: ToggleGroupHighlightProps) {
  const { value } = useToggleGroup()

  return (
    <Highlight
      data-slot="toggle-group-highlight"
      controlledItems
      value={typeof value === "string" ? value : null}
      exitDelay={0}
      transition={transition}
      {...props}
    />
  )
}

type ToggleGroupHighlightItemProps = HighlightItemProps &
  HTMLMotionProps<"div"> & {
    children: React.ReactElement
  }

function ToggleGroupHighlightItem({
  children,
  style,
  ...props
}: ToggleGroupHighlightItemProps) {
  const { type, value } = useToggleGroup()

  if (type === "single") {
    return (
      <HighlightItem
        data-slot="toggle-group-highlight-item"
        style={{ inset: 0, ...style }}
        {...props}
      >
        {children}
      </HighlightItem>
    )
  }

  if (type === "multiple" && React.isValidElement(children)) {
    const isActive = props.value && value && value.includes(props.value)

    const element = children as React.ReactElement<React.ComponentProps<"div">>

    return React.cloneElement(
      children,
      {
        style: {
          ...element.props.style,
          position: "relative",
        },
        ...element.props,
      },
      <>
        <AnimatePresence>
          {isActive && (
            <motion.div
              data-slot="toggle-group-highlight-item"
              style={{ position: "absolute", inset: 0, zIndex: 0, ...style }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              {...props}
            />
          )}
        </AnimatePresence>

        <div
          style={{
            position: "relative",
            zIndex: 1,
          }}
        >
          {element.props.children}
        </div>
      </>
    )
  }
}

export {
  ToggleGroup,
  ToggleGroupItem,
  ToggleGroupHighlight,
  ToggleGroupHighlightItem,
  useToggleGroup,
  type ToggleGroupHighlightProps,
  type ToggleGroupHighlightItemProps,
}
