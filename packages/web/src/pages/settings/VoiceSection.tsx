import { forwardRef } from 'react';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { EmptyState } from '@/components/common/empty-state';
import { SliderField } from '@/components/forms/form-kit';
import { VoiceKeys } from '@/components/forms/voice-keys';
import { BanIcon as SquareIcon, VolumeIcon as Volume2Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import type { VoiceOutput } from '@/hooks/useVoiceOutput';
import { VOICE_ENGINES, VOICE_PITCH, VOICE_RATE, missingVoiceEnv } from '@/lib/voice';
import type { TtsCatalogue, VoiceConfig } from '@/lib/types';
import { cn } from '@/lib/utils';
import { FADE_STEP_MS, SwitchField } from './fields';
import { VoiceEnginePanel } from './VoiceEnginePanels';

const PREVIEW_PHRASE = 'Good evening. All systems are running. Ready when you are.';

/*
  The "voice catalogue unreachable" state shows the speaker as an animate-ui
  icon: the waves drift off once when the block enters the viewport. Same
  forwardRef wrapper as the section icons, because EmptyState draws its icon
  as an IconComponent without props.
*/
const AnimatedVolume2Icon = forwardRef<SVGSVGElement>(function AnimatedVolume2Icon() {
  return <Volume2Icon size={24} />;
});

export function VoiceSection({
  voice,
  catalogue,
  failed,
  onRetry,
  browserVoices,
  setVoice,
  preview,
}: {
  voice: VoiceConfig;
  catalogue: TtsCatalogue | null;
  failed: boolean;
  onRetry(): void;
  browserVoices: SpeechSynthesisVoice[];
  setVoice(patch: Partial<VoiceConfig>): void;
  preview: VoiceOutput;
}) {
  return (
    <>
      <Fade>
        <EngineChooser voice={voice} catalogue={catalogue} failed={failed} onRetry={onRetry} setVoice={setVoice} />
      </Fade>

      <Fade delay={FADE_STEP_MS}>
        <VoiceKeys onSaved={onRetry} />
      </Fade>

      {failed ? null : (
        <VoiceEnginePanel
          voice={voice}
          catalogue={catalogue}
          browserVoices={browserVoices}
          setVoice={setVoice}
        />
      )}

      <Fade delay={3 * FADE_STEP_MS}>
        <SoundFields voice={voice} setVoice={setVoice} preview={preview} />
      </Fade>

      <Fade delay={4 * FADE_STEP_MS}>
        <RecognitionFields voice={voice} setVoice={setVoice} />
      </Fade>
    </>
  );
}

function EngineChooser({
  voice,
  catalogue,
  failed,
  onRetry,
  setVoice,
}: {
  voice: VoiceConfig;
  catalogue: TtsCatalogue | null;
  failed: boolean;
  onRetry(): void;
  setVoice(patch: Partial<VoiceConfig>): void;
}) {
  return (
    <FieldSet>
      <FieldLegend>Output</FieldLegend>
      <FieldDescription>
        Choose a speech engine. If a service key is missing, the browser voice takes over.
      </FieldDescription>

      {failed ? (
        <EmptyState
          icon={AnimatedVolume2Icon}
          title="Voice catalogue unavailable"
          description="New voices cannot be selected without the catalogue. Your saved voice remains selected."
          actionLabel="Try again"
          onAction={onRetry}
          variant="plain"
          size="sm"
        />
      ) : (
        <ItemGroup className="gap-2">
          {VOICE_ENGINES.map((engine) => {
            const selected = voice.engine === engine.id;
            const missing = Boolean(catalogue && !catalogue.engines[engine.id]);
            return (
              <Item
                key={engine.id}
                asChild
                variant="outline"
                size="sm"
                className={cn(
                  'cursor-pointer hover:bg-muted/50',
                  selected && 'border-primary bg-primary/5 dark:bg-primary/10',
                )}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  className="text-left"
                  onClick={() => setVoice({ engine: engine.id })}
                >
                  <ItemMedia variant="icon">
                    <engine.icon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{engine.label}</ItemTitle>
                    <ItemDescription>{engine.description}</ItemDescription>
                  </ItemContent>
                  {missing && engine.env ? (
                    <ItemActions>
                      <Badge variant="destructive">Key missing</Badge>
                    </ItemActions>
                  ) : null}
                </button>
              </Item>
            );
          })}
        </ItemGroup>
      )}

      {missingVoiceEnv(voice.engine, catalogue) ? (
        <FieldDescription>
          Add a key under Speech service keys below to enable this engine. Until then, the browser voice is used.
        </FieldDescription>
      ) : null}
    </FieldSet>
  );
}

function SoundFields({
  voice,
  setVoice,
  preview,
}: {
  voice: VoiceConfig;
  setVoice(patch: Partial<VoiceConfig>): void;
  preview: VoiceOutput;
}) {
  const speakPreview = (): void => {
    preview.unlock();
    preview.speak(PREVIEW_PHRASE);
  };

  return (
    <FieldSet>
      <FieldLegend>Sound</FieldLegend>

      <SliderField
        id="set-rate"
        label="Speed"
        {...VOICE_RATE}
        value={voice.rate}
        description="Speaking speed. 1.00 uses the voice default pace."
        onChange={(value) => setVoice({ rate: value })}
      />

      <SliderField
        id="set-pitch"
        label="Pitch"
        {...VOICE_PITCH}
        value={voice.pitch}
        description="Applies to Edge and browser voices. ElevenLabs and OpenAI ignore this setting."
        onChange={(value) => setVoice({ pitch: value })}
      />

      <SwitchField
        id="set-jarvis"
        label="Jarvis effect"
        description="Adds presence EQ, light compression and a short room effect during playback."
        checked={voice.jarvisEffect}
        onChange={(on) => setVoice({ jarvisEffect: on })}
      />

      <SwitchField
        id="set-clean"
        label="Speak clean text"
        description="Removes code blocks, list markers and links before reading aloud."
        checked={voice.speakCleanText}
        onChange={(on) => setVoice({ speakCleanText: on })}
      />

      <Field>
        <FieldLabel htmlFor="set-style">Speaking style</FieldLabel>
        <Select
          value={voice.style}
          onValueChange={(value) => setVoice({ style: value as VoiceConfig['style'] })}
        >
          <SelectTrigger id="set-style" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="jarvis">Jarvis</SelectItem>
            <SelectItem value="neutral">Neutral</SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>
          Jarvis: a composed British butler, dry and concise with a touch of irony. Changes the wording of voice replies only.
        </FieldDescription>
      </Field>

      <ButtonGroup>
        <Button type="button" variant="outline" disabled={preview.speaking} onClick={speakPreview}>
          {preview.speaking ? <Spinner aria-label="Speaking" /> : null}
          Preview voice
        </Button>
        <Button type="button" variant="outline" disabled={!preview.speaking} onClick={() => preview.stop()}>
          <SquareIcon data-icon="inline-start" />
          Stop
        </Button>
      </ButtonGroup>
      <FieldDescription>
        Uses the settings on this screen, including unsaved changes.
        {preview.error ? ' Server voice failed: ' + preview.error : ''}
      </FieldDescription>
    </FieldSet>
  );
}

function RecognitionFields({
  voice,
  setVoice,
}: {
  voice: VoiceConfig;
  setVoice(patch: Partial<VoiceConfig>): void;
}) {
  return (
    <FieldSet>
      <FieldLegend>Recognition</FieldLegend>
      <FieldDescription>Applies to voice conversations and composer dictation.</FieldDescription>

      <Field>
        <FieldLabel htmlFor="set-lang">Language</FieldLabel>
        <Input
          id="set-lang"
          value={voice.lang}
          placeholder="en-GB"
          onChange={(event) => setVoice({ lang: event.target.value })}
        />
        <FieldDescription>
          A BCP 47 language code. Controls speech recognition and voice filtering.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="set-wake">Wake word</FieldLabel>
        <Input
          id="set-wake"
          value={voice.wakeWord}
          placeholder="optional"
          onChange={(event) => setVoice({ wakeWord: event.target.value })}
        />
        <FieldDescription>
          Can be enabled in voice mode. Without a wake word, every utterance is accepted.
        </FieldDescription>
      </Field>
    </FieldSet>
  );
}
