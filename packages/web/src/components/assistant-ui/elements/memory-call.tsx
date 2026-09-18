"use client";

import { useCallback, useState } from "react";
import { makeAssistantToolUI, type ToolCallMessagePartComponent } from "@assistant-ui/react";

import { ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { TooltipIconButton } from "@/components/tooltip-icon-button";
import { reportFailure } from "@/lib/errors";
import { shorten } from "@/lib/format";
import {
  applyJudgement,
  feedbackKey,
  postMemoryFeedback,
  MEMORY_RECALL_TOOL,
  type MemoryFeedbackVerdict,
  type MemoryRecallArgs,
} from "@/lib/memory-recall";
import type { RecalledMemory } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ToolCall } from "./tool-call";
import { mono } from "./surfaces";

/**
 * What the assistant read before it answered.
 *
 * Deliberately the same object as a tool call, down to the trigger: reading
 * from memory is one of the things the assistant did on the way to the
 * answer, and a second visual idiom would only suggest it is something else.
 * The panel is where they part company - rows instead of a request and a
 * result, because each row is a question to the reader.
 *
 * The two buttons are the only signal about recall quality that recall itself
 * cannot cause; everything else the system knows about a memory it learned
 * after delivering it. One verdict per (turn, memory), and a row that has been
 * judged shows what was said instead of offering a second vote.
 */
const MemoryRecallCall: ToolCallMessagePartComponent<MemoryRecallArgs, unknown> = ({ args }) => {
  const memories = args?.memories ?? [];
  const turnId = args?.turnId;
  const [open, setOpen] = useState(false);
  const [judged, setJudged] = useState<Record<string, MemoryFeedbackVerdict>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());

  const judge = useCallback(
    async (memory: RecalledMemory, verdict: MemoryFeedbackVerdict): Promise<void> => {
      if (!turnId) return;
      const key = feedbackKey(turnId, memory.id);
      if (key in judged || pending.has(key)) return;
      setPending((current) => new Set(current).add(key));
      try {
        await postMemoryFeedback(memory.id, turnId, verdict);
        setJudged((current) => applyJudgement(current, turnId, memory.id, verdict));
      } catch (caught) {
        reportFailure('Feedback', caught);
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [judged, pending, turnId],
  );

  // A turn that recalled nothing has no block at all, so this is only ever
  // reached with rows - but a hand-edited transcript is still not a reason to
  // draw an empty card.
  if (!memories.length) return null;

  const label = memories.length === 1 ? '1 memory used' : memories.length + ' memories used';

  return (
    <ToolCall
      label={label}
      activeLabel={label}
      query=""
      request=""
      result=""
      running={false}
      open={open}
      onOpenChange={setOpen}
      className="max-w-none"
    >
      <div className="px-3.5 pt-2.5 pb-2">
        <p className={cn(mono, "text-foreground/35")}>Read before answering</p>
      </div>
      {memories.map((memory) => (
        <div key={memory.id}>
          <div className="bg-foreground/[0.06] mx-3.5 h-px" />
          <div className="flex items-start gap-3 px-3.5 py-2.5">
            <p className="text-foreground/90 min-w-0 flex-1 font-sans text-xs leading-relaxed">
              {memory.content}
            </p>
            {turnId ? (
              <MemoryVerdict
                memory={memory}
                verdict={judged[feedbackKey(turnId, memory.id)]}
                busy={pending.has(feedbackKey(turnId, memory.id))}
                onJudge={judge}
              />
            ) : null}
          </div>
        </div>
      ))}
    </ToolCall>
  );
};

interface MemoryVerdictProps {
  memory: RecalledMemory;
  /** What this turn already said about this memory, if anything. */
  verdict: MemoryFeedbackVerdict | undefined;
  busy: boolean;
  onJudge(memory: RecalledMemory, verdict: MemoryFeedbackVerdict): Promise<void>;
}

/**
 * One row's verdict on one memory: two thumbs, and once one is pressed, only
 * the one that was pressed.
 *
 * Icons rather than words, because the question is asked of every delivered
 * row and a pair of labelled buttons per row shouts louder than the sentence
 * being judged. `StarIcon` on the assignment page is the precedent for
 * reaching straight into lucide for a rating control.
 */
function MemoryVerdict({ memory, verdict, busy, onJudge }: MemoryVerdictProps) {
  const name = shorten(memory.content, 40);
  if (verdict) {
    const up = verdict === 'point';
    const Icon = up ? ThumbsUpIcon : ThumbsDownIcon;
    return (
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center',
          up ? 'text-foreground' : 'text-muted-foreground',
        )}
        title={up ? 'You said this one helped' : "You said this one did not belong"}
      >
        <Icon className="size-4 fill-current" aria-hidden="true" />
        <span className="sr-only">
          {(up ? 'You said “' : 'You said “') + name + (up ? '” helped' : '” did not belong')}
        </span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {/*
        The tooltip stays short because the sentence it judges is right next to
        it; repeating it there would only push the row wider. The accessible
        name quotes it, because a screen reader has no "right next to it".
      */}
      <TooltipIconButton
        tooltip="This one helped"
        aria-label={'“' + name + '” helped'}
        side="top"
        disabled={busy}
        onClick={() => void onJudge(memory, 'point')}
      >
        {busy ? <Spinner /> : <ThumbsUpIcon aria-hidden="true" />}
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="This one did not belong"
        aria-label={'“' + name + '” did not belong'}
        side="top"
        disabled={busy}
        onClick={() => void onJudge(memory, 'ballast')}
      >
        {busy ? <Spinner /> : <ThumbsDownIcon aria-hidden="true" />}
      </TooltipIconButton>
    </span>
  );
}

/**
 * Mounts the renderer for {@link MEMORY_RECALL_TOOL}. Rendered once inside
 * the thread's page; `display: 'standalone'` keeps the card out of the
 * collapsed tool group, because what the assistant was given to read is not
 * one of the tools it went on to run.
 */
export const MemoryRecallToolUI = makeAssistantToolUI<MemoryRecallArgs, unknown>({
  toolName: MEMORY_RECALL_TOOL,
  render: MemoryRecallCall,
  display: "standalone",
});
