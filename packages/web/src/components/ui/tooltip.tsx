import * as React from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  type MotionValue,
  type HTMLMotionProps,
  type SpringOptions,
} from "motion/react"

import { getStrictContext } from "@/lib/get-strict-context"
import { useControlledState } from "@/hooks/use-controlled-state"

type TooltipContextType = {
  isOpen: boolean
  setIsOpen: (isOpen: boolean) => void
  x: MotionValue<number>
  y: MotionValue<number>
  followCursor?: boolean | "x" | "y"
  followCursorSpringOptions?: SpringOptions
}

const [LocalTooltipProvider, useTooltip] =
  getStrictContext<TooltipContextType>("TooltipContext")

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

type TooltipProps = React.ComponentProps<typeof TooltipPrimitive.Root> & {
  followCursor?: boolean | "x" | "y"
  followCursorSpringOptions?: SpringOptions
}

function Tooltip({
  followCursor = false,
  followCursorSpringOptions = { stiffness: 200, damping: 17 },
  ...props
}: TooltipProps) {
  const [isOpen, setIsOpen] = useControlledState({
    value: props?.open,
    defaultValue: props?.defaultOpen,
    onChange: props?.onOpenChange,
  })
  const x = useMotionValue(0)
  const y = useMotionValue(0)

  return (
    <LocalTooltipProvider
      value={{
        isOpen,
        setIsOpen,
        x,
        y,
        followCursor,
        followCursorSpringOptions,
      }}
    >
      <TooltipPrimitive.Root
        data-slot="tooltip"
        {...props}
        onOpenChange={setIsOpen}
      />
    </LocalTooltipProvider>
  )
}

function TooltipTrigger({ onMouseMove, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const { x, y, followCursor } = useTooltip()

  const handleMouseMove = (event: React.MouseEvent<HTMLButtonElement>) => {
    onMouseMove?.(event)

    const target = event.currentTarget.getBoundingClientRect()

    if (followCursor === "x" || followCursor === true) {
      const eventOffsetX = event.clientX - target.left
      const offsetXFromCenter = (eventOffsetX - target.width / 2) / 2
      x.set(offsetXFromCenter)
    }

    if (followCursor === "y" || followCursor === true) {
      const eventOffsetY = event.clientY - target.top
      const offsetYFromCenter = (eventOffsetY - target.height / 2) / 2
      y.set(offsetYFromCenter)
    }
  }

  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onMouseMove={handleMouseMove}
      {...props}
    />
  )
}

type TooltipPortalProps = Omit<
  React.ComponentProps<typeof TooltipPrimitive.Portal>,
  "forceMount"
>

function TooltipPortal(props: TooltipPortalProps) {
  const { isOpen } = useTooltip()

  return (
    <AnimatePresence>
      {isOpen && (
        <TooltipPrimitive.Portal
          forceMount
          data-slot="tooltip-portal"
          {...props}
        />
      )}
    </AnimatePresence>
  )
}

type TooltipContentProps = Omit<
  React.ComponentProps<typeof TooltipPrimitive.Content>,
  "forceMount" | "asChild"
> &
  HTMLMotionProps<"div">

function TooltipContent({
  onEscapeKeyDown,
  onPointerDownOutside,
  side,
  sideOffset = 0,
  align,
  alignOffset,
  avoidCollisions,
  collisionBoundary,
  collisionPadding,
  arrowPadding,
  sticky,
  hideWhenDetached,
  style,
  transition = { type: "spring", stiffness: 300, damping: 25 },
  className,
  children,
  ...props
}: TooltipContentProps) {
  const { x, y, followCursor, followCursorSpringOptions } = useTooltip()
  const translateX = useSpring(x, followCursorSpringOptions)
  const translateY = useSpring(y, followCursorSpringOptions)

  return (
    <TooltipPortal>
      <TooltipPrimitive.Content
        asChild
        forceMount
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        avoidCollisions={avoidCollisions}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding}
        arrowPadding={arrowPadding}
        sticky={sticky}
        hideWhenDetached={hideWhenDetached}
        onEscapeKeyDown={onEscapeKeyDown}
        onPointerDownOutside={onPointerDownOutside}
      >
        <motion.div
          key="tooltip-content"
          data-slot="tooltip-content"
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.5 }}
          transition={transition}
          style={{
            x:
              followCursor === "x" || followCursor === true
                ? translateX
                : undefined,
            y:
              followCursor === "y" || followCursor === true
                ? translateY
                : undefined,
            ...style,
          }}
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
        </motion.div>
      </TooltipPrimitive.Content>
    </TooltipPortal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
