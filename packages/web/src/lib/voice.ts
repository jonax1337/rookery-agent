import { AudioLinesIcon, CloudIcon, MonitorIcon, SparklesIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { TtsCatalogue, VoiceEngine } from './types';

/**
 * The speech engines and the two sliders that shape them, in one place.
 *
 * The settings page and the voice sheet each kept their own list and called
 * the same engine two different things - "Microsoft Edge Neural" against "Edge
 * Neural", "OpenAI gpt-4o-mini-tts" against "OpenAI". Every other label map in
 * this project already lives in `lib/`; this one was the exception.
 *
 * The long names win: they are what the reader sees while choosing an engine,
 * and the sheet only ever shows the one that is set, where the extra words
 * cost nothing.
 */

export interface VoiceEngineMeta {
  id: VoiceEngine;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Which environment variable the server misses when the key is absent. */
  env?: string;
}

/** In the order the settings page offers them: free first, browser last. */
export const VOICE_ENGINES: readonly VoiceEngineMeta[] = [
  {
    id: 'edge',
    label: 'Microsoft Edge Neural',
    description: 'Kostenlos, ohne Schlüssel, Dutzende Stimmen. Die Vorgabe.',
    icon: CloudIcon,
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    description: 'Die natürlichste Stimme, mit eigener Bibliothek. Braucht einen Schlüssel.',
    icon: SparklesIcon,
    env: 'ELEVENLABS_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI gpt-4o-mini-tts',
    description: 'Schnell und gleichmäßig, mit steuerbarem Ton. Braucht einen Schlüssel.',
    icon: AudioLinesIcon,
    env: 'OPENAI_API_KEY',
  },
  {
    id: 'browser',
    label: 'Browser',
    description: 'Was das Betriebssystem mitbringt. Läuft ohne Server, klingt aber danach.',
    icon: MonitorIcon,
  },
];

export const VOICE_ENGINE_LABEL: Record<VoiceEngine, string> = Object.fromEntries(
  VOICE_ENGINES.map((engine) => [engine.id, engine.label]),
) as Record<VoiceEngine, string>;

/**
 * The environment variable the server is missing for this engine, or `null`
 * when the engine works (or needs no key at all).
 */
export function missingVoiceEnv(
  engine: VoiceEngine,
  catalogue: TtsCatalogue | null,
): string | null {
  if (!catalogue || catalogue.engines[engine]) return null;
  return VOICE_ENGINES.find((entry) => entry.id === engine)?.env ?? null;
}

/* -------------------------------- sliders -------------------------------- */

/**
 * Everything a `SliderField` needs for one voice parameter, spread at the call
 * site: `<SliderField id="…" {...VOICE_RATE} value={…} onChange={…} />`.
 *
 * The four numbers stood twice, digit for digit, in two files.
 */
export interface VoiceSliderRange {
  min: number;
  max: number;
  step: number;
  /** What "Zurücksetzen" restores. */
  fallback: number;
  format(value: number): string;
}

/** Speaking rate. The `×` says it is a factor, not a speed in words per minute. */
export const VOICE_RATE: VoiceSliderRange = {
  min: 0.5,
  max: 1.8,
  step: 0.02,
  fallback: 1,
  format: (value) => value.toFixed(2) + '×',
};

/** Pitch. Edge and the browser honour it; ElevenLabs and OpenAI ignore it. */
export const VOICE_PITCH: VoiceSliderRange = {
  min: 0.5,
  max: 1.6,
  step: 0.02,
  fallback: 1,
  format: (value) => value.toFixed(2),
};
