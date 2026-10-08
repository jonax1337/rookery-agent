import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { SliderField } from '@/components/forms/form-kit';
import { FieldLegend, FieldSet } from '@/components/ui/field';
import type { MemoryConfig, PublicConfig } from '@/lib/types';
import { formatPercent } from '@/lib/stats';
import { FADE_STEP_MS, NumberField, SwitchField } from './fields';

/** The recall threshold slider works in hundredths; the label shows percent. */
const PERCENT_PER_UNIT = 100;
const DEFAULT_RECALL_THRESHOLD = 0.12;

export function MemorySection({
  draft,
  setMemory,
}: {
  draft: PublicConfig;
  setMemory(patch: Partial<MemoryConfig>): void;
}) {
  const memory = draft.memory;

  return (
    <>
      <Fade>
        <FieldSet>
          <SwitchField
            id="set-memory-enabled"
            label="Use memory"
            description="When off, saved memories are not recalled. Existing memories remain stored."
            checked={memory.enabled}
            onChange={(on) => setMemory({ enabled: on })}
          />
          <SwitchField
            id="set-memory-extract"
            label="Learn automatically"
            description="After each exchange, the assistant checks what is worth remembering."
            checked={memory.autoExtract}
            onChange={(on) => setMemory({ autoExtract: on })}
          />
        </FieldSet>
      </Fade>

      <Fade delay={FADE_STEP_MS}>
        <FieldSet>
          <FieldLegend variant="label">Recall</FieldLegend>

          <NumberField
            id="set-memory-recall"
            label="Memories per reply"
            value={memory.recallLimit}
            min={0}
            max={50}
            suffix="items"
            description="Maximum number of matching memories recalled for a reply."
            onChange={(value) => setMemory({ recallLimit: value })}
          />

          <SliderField
            id="set-memory-threshold"
            label="Minimum match score"
            value={memory.recallThreshold}
            min={0}
            max={1}
            step={0.01}
            fallback={DEFAULT_RECALL_THRESHOLD}
            format={(value) => formatPercent(Math.round(value * PERCENT_PER_UNIT))}
            description="How closely a memory must match the topic to appear. Higher values are stricter."
            onChange={(value) => setMemory({ recallThreshold: value })}
          />
        </FieldSet>
      </Fade>

      <Fade delay={2 * FADE_STEP_MS}>
        <FieldSet>
          <FieldLegend variant="label">Context size</FieldLegend>

          <NumberField
            id="set-memory-window"
            label="Working window"
            value={memory.workingWindow}
            min={0}
            max={200}
            suffix="messages"
            description="How many recent messages are included verbatim when rebuilding context."
            onChange={(value) => setMemory({ workingWindow: value })}
          />

          <NumberField
            id="set-memory-budget"
            label="Context budget"
            value={memory.contextBudget}
            min={200}
            max={200000}
            suffix="characters"
            description="The budget for context contributed by memory."
            onChange={(value) => setMemory({ contextBudget: value })}
          />
        </FieldSet>
      </Fade>
    </>
  );
}
