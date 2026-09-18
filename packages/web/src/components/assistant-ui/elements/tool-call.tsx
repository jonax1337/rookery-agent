"use client";


import type { ReactNode } from "react";

import { BadgeAlertIcon as CircleAlertIcon, CheckIcon, ChevronRightIcon } from "@/components/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  collapsePanel,
  field,
  mono,
  ShimmerLabel,
  SwapLabel,
} from "./surfaces";

export interface ToolCallProps {
  label: string;
  activeLabel: string;
  query: string;
  request: string;
  result: string;
  running: boolean;
  failed?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  /**
   * The panel's rows, for a call whose content is not a request and a result.
   * The trigger stays exactly as it is either way: everything the assistant
   * did before it answered reads as the same kind of thing. Omitted - the
   * ordinary case - the panel shows `request` and `result`.
   */
  children?: ReactNode;
}

export function ToolCall({
  label,
  activeLabel,
  query,
  request,
  result,
  running,
  failed = false,
  open,
  onOpenChange,
  className,
  children,
}: ToolCallProps) {
  return (
    <Collapsible
      data-slot="tool-call"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-sm", className)}
    >
      <CollapsibleTrigger aria-label={`${running ? 'Running' : failed ? 'Not completed' : 'Completed'}: ${label}`} className="group/trigger text-muted-foreground hover:text-foreground flex max-w-full items-center gap-1.5 rounded-md py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-90 group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none" />
        <SwapLabel active={running ? 0 : 1} className="min-w-0 max-w-64 text-start first-letter:uppercase">
          <ShimmerLabel
            active={running}
            className="relative inline-block leading-none"
          >
            {activeLabel}
          </ShimmerLabel>
          <>{label}</>
        </SwapLabel>
        {query && <span
          className={cn(
            mono,
            "bg-foreground/[0.06] text-foreground/70 rounded-md px-1.5 py-0.5",
          )}
        >
          {query}
        </span>}
        <span className="ms-auto flex w-4 items-center justify-end">
          {!running && (failed ? <CircleAlertIcon className="size-3 text-destructive" /> :
            <CheckIcon className="fade-in zoom-in-90 animate-in size-3 text-muted-foreground/60 duration-200 motion-reduce:animate-none" />
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <div className={cn(field, "my-1 ml-5 overflow-hidden rounded-lg text-xs")}>
          {children ?? (
            <>
              <div className="px-3.5 pt-2.5 pb-2">
                <p className={cn(mono, "text-foreground/35 mb-1")}>Request</p>
                <pre className="text-muted-foreground max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{request || 'No arguments'}</pre>
              </div>
              <div className="bg-foreground/[0.06] mx-3.5 h-px" />
              <div className="px-3.5 pt-2 pb-2.5">
                <p className={cn(mono, "text-foreground/35 mb-1")}>Result</p>
                <pre className="text-foreground/90 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">{result || (running ? 'In progress…' : failed ? 'No result received.' : 'Completed without output.')}</pre>
              </div>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
