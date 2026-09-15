import * as React from "react"
import { cn } from "cn"
import { Accordion as AccordionPrimitive } from "radix-ui"
import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react"

import { IconPlaceholder } from "@/components/ui/icon-placeholder"
import { useControlledState } from "@/hooks/use-controlled-state"
import { getStrictContext } from "@/lib/get-strict-context"

type AccordionContextType = {
  value: string | string[] | undefined
  setValue: (value: string | string[] | undefined) => void
}

type AccordionItemContextType = {
  value: string
  isOpen: boolean
  setIsOpen: (open: boolean) => void
}

const [AccordionProvider, useAccordion] =
  getStrictContext<AccordionContextType>("AccordionContext")

const [AccordionItemProvider, useAccordionItem] =
  getStrictContext<AccordionItemContextType>("AccordionItemContext")

function Accordion({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  const [value, setValue] = useControlledState<string | string[] | undefined>({
    value: props?.value,
    defaultValue: props?.defaultValue,
    onChange: props?.onValueChange as (
      value: string | string[] | undefined
    ) => void,
  })

  return (
    <AccordionProvider value={{ value, setValue }}>
      <AccordionPrimitive.Root
        data-slot="accordion"
        className={cn("flex w-full flex-col", className)}
        {...props}
        onValueChange={setValue}
      />
    </AccordionProvider>
  )
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  const { value } = useAccordion()
  const [isOpen, setIsOpen] = React.useState(
    value?.includes(props?.value) ?? false
  )

  React.useEffect(() => {
    setIsOpen(value?.includes(props?.value) ?? false)
  }, [value, props?.value])

  return (
    <AccordionItemProvider value={{ isOpen, setIsOpen, value: props.value }}>
      <AccordionPrimitive.Item
        data-slot="accordion-item"
        className={cn("not-last:border-b", className)}
        {...props}
      />
    </AccordionItemProvider>
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/accordion-trigger relative flex flex-1 items-start justify-between rounded-md border border-transparent py-4 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:after:border-ring disabled:pointer-events-none disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:size-4 **:data-[slot=accordion-trigger-icon]:text-muted-foreground",
          className
        )}
        {...props}
      >
        {children}
        <IconPlaceholder
          lucide="ChevronDownIcon"
          tabler="IconChevronDown"
          data-slot="accordion-trigger-icon"
          hugeicons="ArrowDown01Icon"
          phosphor="CaretDownIcon"
          remixicon="RiArrowDownSLine"
          className="pointer-events-none shrink-0 group-aria-expanded/accordion-trigger:hidden"
        />
        <IconPlaceholder
          lucide="ChevronUpIcon"
          tabler="IconChevronUp"
          data-slot="accordion-trigger-icon"
          hugeicons="ArrowUp01Icon"
          phosphor="CaretUpIcon"
          remixicon="RiArrowUpSLine"
          className="pointer-events-none hidden shrink-0 group-aria-expanded/accordion-trigger:inline"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

type AccordionContentProps = Omit<
  React.ComponentProps<typeof AccordionPrimitive.Content>,
  "asChild" | "forceMount"
> &
  HTMLMotionProps<"div"> & {
    keepRendered?: boolean
  }

function AccordionContent({
  className,
  children,
  keepRendered = false,
  transition = { duration: 0.35, ease: "easeInOut" },
  ...props
}: AccordionContentProps) {
  const { isOpen } = useAccordionItem()

  return (
    <AnimatePresence>
      {keepRendered ? (
        <AccordionPrimitive.Content asChild forceMount>
          <motion.div
            key="accordion-content"
            data-slot="accordion-content"
            className="text-sm"
            initial={{ height: 0, opacity: 0, "--mask-stop": "0%", y: 20 }}
            animate={
              isOpen
                ? { height: "auto", opacity: 1, "--mask-stop": "100%", y: 0 }
                : { height: 0, opacity: 0, "--mask-stop": "0%", y: 20 }
            }
            transition={transition}
            style={{
              maskImage:
                "linear-gradient(black var(--mask-stop), transparent var(--mask-stop))",
              WebkitMaskImage:
                "linear-gradient(black var(--mask-stop), transparent var(--mask-stop))",
              overflow: "hidden",
            }}
            {...props}
          >
            <div
              className={cn(
                "pt-0 pb-4 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
                className
              )}
            >
              {children}
            </div>
          </motion.div>
        </AccordionPrimitive.Content>
      ) : (
        isOpen && (
          <AccordionPrimitive.Content asChild forceMount>
            <motion.div
              key="accordion-content"
              data-slot="accordion-content"
              className="text-sm"
              initial={{ height: 0, opacity: 0, "--mask-stop": "0%", y: 20 }}
              animate={{
                height: "auto",
                opacity: 1,
                "--mask-stop": "100%",
                y: 0,
              }}
              exit={{ height: 0, opacity: 0, "--mask-stop": "0%", y: 20 }}
              transition={transition}
              style={{
                maskImage:
                  "linear-gradient(black var(--mask-stop), transparent var(--mask-stop))",
                WebkitMaskImage:
                  "linear-gradient(black var(--mask-stop), transparent var(--mask-stop))",
                overflow: "hidden",
              }}
              {...props}
            >
              <div
                className={cn(
                  "pt-0 pb-4 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
                  className
                )}
              >
                {children}
              </div>
            </motion.div>
          </AccordionPrimitive.Content>
        )
      )}
    </AnimatePresence>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
