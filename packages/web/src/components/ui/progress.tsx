import * as React from "react"
import { cn } from "cn"
import { Progress as ProgressPrimitive } from "radix-ui"
import { motion } from "motion/react"
import { getStrictContext } from "@/lib/get-strict-context"

type ProgressContextType = {
  value: number
}

const [ProgressProvider, useProgress] =
  getStrictContext<ProgressContextType>("ProgressContext")

type ProgressProps = React.ComponentProps<typeof ProgressPrimitive.Root>

function Progress({ className, ...props }: ProgressProps) {
  return (
    <ProgressProvider value={{ value: props.value ?? 0 }}>
      <ProgressPrimitive.Root
        data-slot="progress"
        className={cn(
          "relative flex h-1.5 w-full items-center overflow-x-hidden rounded-full bg-muted",
          className
        )}
        {...props}
      >
        <ProgressIndicator className="size-full flex-1 bg-primary" />
      </ProgressPrimitive.Root>
    </ProgressProvider>
  )
}

const MotionProgressIndicator = motion.create(ProgressPrimitive.Indicator)

type ProgressIndicatorProps = React.ComponentProps<
  typeof MotionProgressIndicator
>

function ProgressIndicator({
  transition = { type: "spring", stiffness: 100, damping: 30 },
  ...props
}: ProgressIndicatorProps) {
  const { value } = useProgress()

  return (
    <MotionProgressIndicator
      data-slot="progress-indicator"
      animate={{ x: `-${100 - (value || 0)}%` }}
      transition={transition}
      {...props}
    />
  )
}

export {
  Progress,
  ProgressIndicator,
  useProgress,
  type ProgressProps,
  type ProgressIndicatorProps,
  type ProgressContextType,
}
