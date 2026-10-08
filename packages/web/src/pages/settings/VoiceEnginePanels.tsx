import { useMemo } from 'react';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TtsCatalogue, TtsVoice, VoiceConfig } from '@/lib/types';
import { DEFAULT_OPTION_VALUE, FADE_STEP_MS } from './fields';

/*
  The engine list and the two slider ranges live in `lib/voice.ts`: they used
  to be here and in the voice sheet twice, and named the same engine two ways
  ("Microsoft Edge Neural" against "Edge Neural").
*/

type ElevenLabsModel = VoiceConfig['elevenLabsModel'];

const ELEVEN_MODEL_LABEL: Record<ElevenLabsModel, string> = {
  eleven_multilingual_v2: 'Multilingual v2 · Quality',
  eleven_flash_v2_5: 'Flash v2.5 · Speed',
  eleven_v3: 'v3 · Expression',
};

const ELEVEN_MODELS = Object.keys(ELEVEN_MODEL_LABEL) as ElevenLabsModel[];

interface VoicePanelProps {
  voice: VoiceConfig;
  catalogue: TtsCatalogue | null;
  setVoice(patch: Partial<VoiceConfig>): void;
}

/** The settings of the engine the voice is currently set to. */
export function VoiceEnginePanel({
  voice,
  catalogue,
  browserVoices,
  setVoice,
}: VoicePanelProps & { browserVoices: SpeechSynthesisVoice[] }) {
  switch (voice.engine) {
    case 'edge':
      return <EdgePanel voice={voice} catalogue={catalogue} setVoice={setVoice} />;
    case 'elevenlabs':
      return <ElevenLabsPanel voice={voice} catalogue={catalogue} setVoice={setVoice} />;
    case 'openai':
      return <OpenAiPanel voice={voice} catalogue={catalogue} setVoice={setVoice} />;
    case 'browser':
      return <BrowserPanel voice={voice} browserVoices={browserVoices} setVoice={setVoice} />;
    default:
      return null;
  }
}

function EdgePanel({ voice, catalogue, setVoice }: VoicePanelProps) {
  const langPrefix = (voice.lang.split('-')[0] ?? 'en').toLowerCase();
  const options = useMemo<EntityOption[]>(() => {
    const picks = (catalogue?.edge ?? []).filter(
      (entry) => entry.lang.toLowerCase().startsWith(langPrefix) || entry.id.includes('Multilingual'),
    );
    return withCurrent(picks, voice.edgeVoice).map(toOption);
  }, [catalogue, langPrefix, voice.edgeVoice]);

  return (
    <Fade delay={2 * FADE_STEP_MS}>
      <FieldSet>
        <FieldLegend variant="label">Edge Neural</FieldLegend>
        <Field>
          <FieldLabel htmlFor="set-edge-voice">Voice</FieldLabel>
          <EntityCombobox
            id="set-edge-voice"
            options={options}
            value={voice.edgeVoice || null}
            onChange={(value) => setVoice({ edgeVoice: value ?? '' })}
            placeholder="Search voices"
            emptyLabel="No voice found"
            clearable={false}
          />
          <FieldDescription>
            Ryan is the default British English voice. Multilingual voices support multiple languages.
          </FieldDescription>
        </Field>
      </FieldSet>
    </Fade>
  );
}

function ElevenLabsPanel({ voice, catalogue, setVoice }: VoicePanelProps) {
  return (
    <Fade delay={2 * FADE_STEP_MS}>
      <FieldSet>
        <FieldLegend variant="label">ElevenLabs</FieldLegend>
        <Field>
          <FieldLabel htmlFor="set-eleven-voice">Voice</FieldLabel>
          {/* One field, one config value. There used to be a select and a text
              input writing to `elevenLabsVoiceId` side by side, and whichever
              was touched last silently won. */}
          <InputGroup>
            <InputGroupInput
              id="set-eleven-voice"
              value={voice.elevenLabsVoiceId}
              placeholder="Default (George)"
              onChange={(event) => setVoice({ elevenLabsVoiceId: event.target.value })}
            />
            <InputGroupAddon align="inline-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <InputGroupButton>Library</InputGroupButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
                  <DropdownMenuLabel>Voice library</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup
                    value={voice.elevenLabsVoiceId || DEFAULT_OPTION_VALUE}
                    onValueChange={(value) =>
                      setVoice({ elevenLabsVoiceId: value === DEFAULT_OPTION_VALUE ? '' : value })
                    }
                  >
                    <DropdownMenuRadioItem value={DEFAULT_OPTION_VALUE}>Default (George)</DropdownMenuRadioItem>
                    {(catalogue?.elevenlabs ?? []).map((entry) => (
                      <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                        {entry.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>
            You can also enter a voice ID directly from the Voice Library. George is the default.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="set-eleven-model">Model</FieldLabel>
          <Select
            value={voice.elevenLabsModel}
            onValueChange={(value) => setVoice({ elevenLabsModel: value as ElevenLabsModel })}
          >
            <SelectTrigger id="set-eleven-model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ELEVEN_MODELS.map((id) => (
                <SelectItem key={id} value={id}>
                  {ELEVEN_MODEL_LABEL[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Choose a model, then preview the voice to compare its sound and response time.
          </FieldDescription>
        </Field>
      </FieldSet>
    </Fade>
  );
}

function OpenAiPanel({ voice, catalogue, setVoice }: VoicePanelProps) {
  const options = useMemo<EntityOption[]>(
    () => withCurrent(catalogue?.openai ?? [], voice.openaiVoice).map(toOption),
    [catalogue, voice.openaiVoice],
  );

  return (
    <Fade delay={2 * FADE_STEP_MS}>
      <FieldSet>
        <FieldLegend variant="label">OpenAI</FieldLegend>
        <Field>
          <FieldLabel htmlFor="set-openai-voice">Voice</FieldLabel>
          <EntityCombobox
            id="set-openai-voice"
            options={options}
            value={voice.openaiVoice || null}
            onChange={(value) => setVoice({ openaiVoice: value ?? '' })}
            placeholder="Search voices"
            emptyLabel="No voice found"
            clearable={false}
          />
          <FieldDescription>
            Onyx is the default. Style instructions add the butler register to the selected voice.
          </FieldDescription>
        </Field>
      </FieldSet>
    </Fade>
  );
}

function BrowserPanel({
  voice,
  browserVoices,
  setVoice,
}: Pick<VoicePanelProps, 'voice' | 'setVoice'> & { browserVoices: SpeechSynthesisVoice[] }) {
  const options = useMemo<EntityOption[]>(
    () => browserVoices.map((entry) => ({ value: entry.name, label: entry.name, hint: entry.lang })),
    [browserVoices],
  );

  return (
    <Fade delay={2 * FADE_STEP_MS}>
      <FieldSet>
        <FieldLegend variant="label">Browser</FieldLegend>
        <Field>
          <FieldLabel htmlFor="set-browser-voice">Voice</FieldLabel>
          <EntityCombobox
            id="set-browser-voice"
            options={options}
            value={voice.voiceName || null}
            onChange={(value) => setVoice({ voiceName: value ?? '' })}
            placeholder="Automatic"
            emptyLabel="No voice found"
          />
          <FieldDescription>
            Voices available on this operating system. Automatic selects a voice for the configured language.
          </FieldDescription>
        </Field>
      </FieldSet>
    </Fade>
  );
}

/** The voice currently configured, kept selectable even when the list lacks it. */
function withCurrent(list: readonly TtsVoice[], current: string): TtsVoice[] {
  const picks = [...list];
  if (current && !picks.some((entry) => entry.id === current)) {
    picks.unshift({ id: current, name: current, lang: '', gender: '' });
  }
  return picks;
}

const GENDER_HINT: Partial<Record<string, string>> = { male: 'm', female: 'f' };

function toOption(entry: TtsVoice): EntityOption {
  const hint = [entry.lang, GENDER_HINT[entry.gender] ?? ''].filter(Boolean).join(' · ');
  return { value: entry.id, label: entry.name, ...(hint ? { hint } : {}) };
}
