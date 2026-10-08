import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { RadioGroup } from '@/components/ui/radio-group';
import type { TelegramGatewayConfig, TranscribeEngine } from '@/lib/types';
import { parseIntegerInRange, RadioOptionField, SwitchField } from '../settings/fields';

/** Telegram hands a bot at most 20 MB. */
const MIN_ATTACHMENT_MB = 1;
const MAX_ATTACHMENT_MB = 20;

/** Where a voice message becomes text, free first. */
const TRANSCRIBE_ENGINES: TranscribeEngine[] = ['auto', 'local', 'openai', 'elevenlabs', 'off'];

const TRANSCRIBE_LABEL: Record<TranscribeEngine, string> = {
  auto: 'Automatic',
  local: 'On this machine',
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
  off: 'Off',
};

const TRANSCRIBE_HINT: Record<TranscribeEngine, string> = {
  auto: 'A speech key from the voice page when there is one, the local model otherwise. Always has somewhere to go.',
  local: 'Whisper, running here. No key, nothing leaves the machine; the model is downloaded once, about 130 MB.',
  openai: 'gpt-4o-mini-transcribe. Needs the OpenAI key from the voice page.',
  elevenlabs: 'Scribe v1. Needs the ElevenLabs key from the voice page.',
  off: 'Voice messages arrive as a file and are not listened to.',
};

interface DraftFieldProps {
  draft: TelegramGatewayConfig;
  set(patch: Partial<TelegramGatewayConfig>): void;
}

export function FilesAndSpeechSection({ draft, set }: DraftFieldProps) {
  const usesLocalModel = draft.transcribe === 'auto' || draft.transcribe === 'local';

  return (
    <FieldSet>
      <FieldLegend variant="label">Files and speech</FieldLegend>
      <FieldDescription>
        What arrives from the phone besides text. Files are saved in the workspace under{' '}
        <code>inbox/telegram/</code>, where a turn can open them, and swept after 30 days.
      </FieldDescription>

      <SwitchField
        id="gw-media"
        label="Accept attachments"
        description="Photos, voice messages, documents. When off, they are dropped and only logged."
        checked={draft.media}
        onChange={(on) => set({ media: on })}
      />
      <MaxAttachmentField draft={draft} set={set} />
      <VoiceEngineGroup draft={draft} set={set} />
      {usesLocalModel ? <LocalModelField draft={draft} set={set} /> : null}
    </FieldSet>
  );
}

function MaxAttachmentField({ draft, set }: DraftFieldProps) {
  // Unlike `NumberField`, the typed text is not kept aside: an out-of-range
  // keystroke is simply refused, and an emptied field falls back to the floor.
  const handleChange = (text: string): void => {
    const parsed = parseIntegerInRange(text, MIN_ATTACHMENT_MB, MAX_ATTACHMENT_MB);
    if (parsed !== null) set({ maxAttachmentMb: parsed });
    else if (text === '') set({ maxAttachmentMb: MIN_ATTACHMENT_MB });
  };

  return (
    <Field>
      <FieldLabel htmlFor="gw-max-attachment">Largest attachment</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id="gw-max-attachment"
          inputMode="numeric"
          disabled={!draft.media}
          value={String(draft.maxAttachmentMb)}
          onChange={(event) => handleChange(event.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>MB</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      <FieldDescription>
        Telegram hands a bot at most {MAX_ATTACHMENT_MB} MB, so that is the ceiling here too.
      </FieldDescription>
    </Field>
  );
}

function VoiceEngineGroup({ draft, set }: DraftFieldProps) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Voice messages</FieldLegend>
      <FieldDescription>Which engine turns a recording into words.</FieldDescription>
      <RadioGroup
        value={draft.transcribe}
        onValueChange={(value) => set({ transcribe: value as TranscribeEngine })}
      >
        {TRANSCRIBE_ENGINES.map((engine) => (
          <RadioOptionField
            key={engine}
            id={'gw-transcribe-' + engine}
            value={engine}
            title={TRANSCRIBE_LABEL[engine]}
            hint={TRANSCRIBE_HINT[engine]}
            disabled={!draft.media}
          />
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

function LocalModelField({ draft, set }: DraftFieldProps) {
  return (
    <Field>
      <FieldLabel htmlFor="gw-transcribe-model">Local model</FieldLabel>
      <Input
        id="gw-transcribe-model"
        spellCheck={false}
        value={draft.transcribeModel}
        placeholder="onnx-community/whisper-base"
        onChange={(event) => set({ transcribeModel: event.target.value })}
      />
      <FieldDescription>
        <code>whisper-base</code> is the balance that holds on a laptop.{' '}
        <code>onnx-community/whisper-small</code> hears more and takes about four times as long. The
        model is downloaded once into <code>models/</code> in the Rookery home, and ffmpeg has to be
        installed for the audio to be decoded.
      </FieldDescription>
    </Field>
  );
}
