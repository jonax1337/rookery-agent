"use client";

import { useCallback, useState } from "react";
import { makeAssistantToolUI, type ToolCallMessagePartComponent } from "@assistant-ui/react";

import { BanIcon as CircleXIcon, CircleCheckIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Spinner } from "@/components/ui/spinner";
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

/** One row's two words about one memory - or, once said, what was said. */
function MemoryVerdict({ memory, verdict, busy, onJudge }: MemoryVerdictProps) {
  if (verdict) {
    return (
      <Badge variant={verdict === 'point' ? 'secondary' : 'outline'} className="shrink-0 gap-1">
        {verdict === 'point' ? (
          <CircleCheckIcon aria-hidden="true" />
        ) : (
          <CircleXIcon aria-hidden="true" />
        )}
        {verdict === 'point' ? 'Was the point' : 'Was ballast'}
      </Badge>
    );
  }
  const name = shorten(memory.content, 40);
  return (
    <ButtonGroup className="shrink-0">
      <Button
        variant="outline"
        size="xs"
        aria-label={'Mark “' + name + '” as the point'}
        disabled={busy}
        onClick={() => void onJudge(memory, 'point')}
      >
        {busy ? <Spinner /> : <CircleCheckIcon aria-hidden="true" />}
        Was the point
      </Button>
      <Button
        variant="outline"
        size="xs"
        aria-label={'Mark “' + name + '” as ballast'}
        disabled={busy}
        onClick={() => void onJudge(memory, 'ballast')}
      >
        {busy ? <Spinner /> : <CircleXIcon aria-hidden="true" />}
        Was ballast
      </Button>
    </ButtonGroup>
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
