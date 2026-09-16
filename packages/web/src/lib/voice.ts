
import {
  AudioLinesIcon,
  CloudCogIcon as CloudIcon,
  MonitorCogIcon as MonitorIcon,
  SparklesIcon,
} from "@/components/icons";

import type { TtsCatalogue, VoiceEngine } from './types';
import type { IconComponent } from "@/components/icons";

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
  icon: IconComponent;
  /** Which environment variable the server misses when the key is absent. */
  env?: string;
}

/** In the order the settings page offers them: free first, browser last. */
export const VOICE_ENGINES: readonly VoiceEngineMeta[] = [
  {
    id: 'edge',
    label: 'Microsoft Edge Neural',
    description: 'Free, no key required, with dozens of voices. The default.',
    icon: CloudIcon,
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    description: 'The most natural voice, with its own library. Requires a key.',
    icon: SparklesIcon,
    env: 'ELEVENLABS_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI gpt-4o-mini-tts',
    description: 'Fast and consistent, with adjustable tone. Requires a key.',
    icon: AudioLinesIcon,
    env: 'OPENAI_API_KEY',
  },
  {
    id: 'browser',
    label: 'Browser',
    description: 'Uses the operating system voices. Works without the server.',
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
