import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { VoiceConfig, VoiceEngine } from '@rookery/core';

/**
 * Server-side text-to-speech.
 *
 * The browser's own `speechSynthesis` voices are fine for a notification and
 * awful for a conversation. This module gives the web UI a real voice:
 *
 *   edge        Microsoft's neural voices through the Edge "read aloud"
 *               service. Free, no account, no key; the same voices Azure
 *               sells. The default, and what most people will use.
 *   elevenlabs  Best-in-class cloned voices. Needs ELEVENLABS_API_KEY.
 *   openai      gpt-4o-mini-tts, which takes style instructions, so the
 *               butler register comes from a prompt. Needs OPENAI_API_KEY.
 *
 * Keys live in the environment only. Rookery's config has no API-key setting
 * on purpose, and a browser must never be able to read one back.
 *
 * Every engine returns MP3, so the client decodes one format.
 */

export interface TtsVoice {
  id: string;
  name: string;
  lang: string;
  gender: string;
}

export interface TtsCatalogue {
  engines: Record<VoiceEngine, boolean>;
  edge: TtsVoice[];
  /** Premade voices, plus the account's own library when a key is set. */
  elevenlabs: TtsVoice[];
  openai: TtsVoice[];
}

export interface TtsAudio {
  audio: Buffer;
  mime: string;
}

export class TtsError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = 'TtsError';
    this.statusCode = statusCode;
  }
}

const DEFAULT_EDGE_VOICE = 'de-DE-FlorianMultilingualNeural';
/** ElevenLabs' premade "George": a warm British narrator, closest to the brief. */
const DEFAULT_ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_OPENAI_VOICE = 'onyx';

const OPENAI_VOICES: TtsVoice[] = (
  [
    ['alloy', 'Alloy', 'neutral'],
    ['ash', 'Ash', 'male'],
    ['ballad', 'Ballad', 'male'],
    ['coral', 'Coral', 'female'],
    ['echo', 'Echo', 'male'],
    ['fable', 'Fable', 'neutral'],
    ['onyx', 'Onyx', 'male'],
    ['nova', 'Nova', 'female'],
    ['sage', 'Sage', 'female'],
    ['shimmer', 'Shimmer', 'female'],
    ['verse', 'Verse', 'male'],
  ] as const
).map(([id, name, gender]) => ({ id, name, lang: 'multi', gender }));

/** How the OpenAI voice is asked to carry itself. Content language follows the text. */
const OPENAI_STYLE =
  'You are a calm, precise, quietly witty AI butler in the manner of a classic film assistant. ' +
  'Measured pace, warm low register, crisp articulation, understated confidence. ' +
  'Never theatrical. Speak in the language of the text.';

const EDGE_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;
const VOICES_TTL_MS = 6 * 60 * 60 * 1000;
const SYNTH_TIMEOUT_MS = 25_000;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function ttsEngines(): Record<VoiceEngine, boolean> {
  return {
    browser: true,
    edge: true,
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
  };
}

/* --------------------------------- voices --------------------------------- */

let edgeCache: { at: number; voices: TtsVoice[] } | null = null;

/** Edge's voice list, cached; the service rarely changes it. */
export async function edgeVoices(): Promise<TtsVoice[]> {
  if (edgeCache && Date.now() - edgeCache.at < VOICES_TTL_MS) return edgeCache.voices;
  const tts = new MsEdgeTTS();
  try {
    const list = await withTimeout(tts.getVoices(), SYNTH_TIMEOUT_MS, 'Edge voice list');
    const voices = list
      .map((voice) => ({
        id: voice.ShortName,
        // "Microsoft FlorianMultilingual Online (Natural) - German" -> "Florian (multilingual)"
        name:
          voice.FriendlyName.replace(/^Microsoft\s+/, '')
            .replace(/\s+Online.*$/, '')
            .replace(/Multilingual$/, ' (multilingual)') || voice.ShortName,
        lang: voice.Locale,
        gender: voice.Gender.toLowerCase(),
      }))
      .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    edgeCache = { at: Date.now(), voices };
    return voices;
  } finally {
    tts.close();
  }
}

let elevenCache: { at: number; key: string; voices: TtsVoice[] } | null = null;

/**
 * ElevenLabs voices: the premade set is public, so the picker is populated
 * even before a key exists; with a key the account's own library (cloned
 * voices included) comes along.
 */
export async function elevenLabsVoices(): Promise<TtsVoice[]> {
  const key = process.env.ELEVENLABS_API_KEY ?? '';
  if (elevenCache && elevenCache.key === key && Date.now() - elevenCache.at < VOICES_TTL_MS) {
    return elevenCache.voices;
  }
  const response = await fetch('https://api.elevenlabs.io/v1/voices?show_legacy=false', {
    headers: key ? { 'xi-api-key': key } : {},
    signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
  });
  if (!response.ok) throw new TtsError('ElevenLabs voice list ' + response.status);
  const body = (await response.json()) as {
    voices?: Array<{
      voice_id: string;
      name: string;
      category?: string;
      labels?: Record<string, string | undefined>;
    }>;
  };
  const voices = (body.voices ?? [])
    .map((voice) => {
      const labels = voice.labels ?? {};
      const traits = [labels.accent, labels.description ?? labels.descriptive, labels.age]
        .filter((part): part is string => Boolean(part))
        .join(', ');
      return {
        id: voice.voice_id,
        name: voice.name + (traits ? ' (' + traits + ')' : '') + (voice.category === 'premade' ? '' : ' · eigene'),
        lang: 'multi',
        gender: labels.gender ?? '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  // A key without the voices_read permission yields an empty list; do not
  // pin that for hours, so fixing the key shows up on the next page load.
  if (voices.length) elevenCache = { at: Date.now(), key, voices };
  return voices;
}

export async function ttsCatalogue(): Promise<TtsCatalogue> {
  // Each list is optional: offline or blocked, the page still shows the rest.
  const [edge, elevenlabs] = await Promise.all([
    edgeVoices().catch(() => [] as TtsVoice[]),
    elevenLabsVoices().catch(() => [] as TtsVoice[]),
  ]);
  return { engines: ttsEngines(), edge, elevenlabs, openai: OPENAI_VOICES };
}

/* -------------------------------- synthesis ------------------------------- */

export async function synthesize(voice: VoiceConfig, text: string): Promise<TtsAudio> {
  const body = text.trim();
  if (!body) throw new TtsError('Nothing to say', 400);
  switch (voice.engine) {
    case 'edge':
      return synthesizeEdge(voice, body);
    case 'elevenlabs':
      return synthesizeElevenLabs(voice, body);
    case 'openai':
      return synthesizeOpenAi(voice, body);
    case 'browser':
      throw new TtsError('The browser engine synthesises locally; nothing to do here', 400);
    default:
      throw new TtsError('Unknown voice engine: ' + String(voice.engine), 400);
  }
}

/** Azure prosody wants percentages; the sliders are centred on 1.0. */
function prosodyPercent(value: number): string {
  const percent = Math.round(clamp((value - 1) * 100, -50, 50));
  return (percent >= 0 ? '+' : '') + percent + '%';
}

/** msedge-tts splices the text into SSML verbatim, so markup has to be escaped here. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function synthesizeEdge(voice: VoiceConfig, text: string): Promise<TtsAudio> {
  const tts = new MsEdgeTTS();
  // The library has no abort; closing the socket is what ends a hung stream.
  const timer = setTimeout(() => tts.close(), SYNTH_TIMEOUT_MS);
  try {
    await tts.setMetadata(voice.edgeVoice || DEFAULT_EDGE_VOICE, EDGE_FORMAT);
    const { audioStream } = tts.toStream(escapeXml(text), {
      rate: prosodyPercent(voice.rate),
      pitch: prosodyPercent(voice.pitch),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    const audio = Buffer.concat(chunks);
    if (!audio.length) throw new TtsError('Edge returned no audio');
    return { audio, mime: 'audio/mpeg' };
  } catch (error) {
    if (error instanceof TtsError) throw error;
    throw new TtsError('Edge TTS failed: ' + (error as Error).message);
  } finally {
    clearTimeout(timer);
    tts.close();
  }
}

/**
 * ElevenLabs allows two requests in flight on the starter plans and answers
 * a third with 429. The voice page speaks sentence by sentence while the
 * answer streams, so bursts of three or four are normal; queue them here
 * instead of letting the browser fall back to its own voice.
 */
const ELEVENLABS_MAX_INFLIGHT = Number(process.env.ELEVENLABS_MAX_CONCURRENCY) || 2;
let elevenLabsInflight = 0;
const elevenLabsWaiting: (() => void)[] = [];

async function withElevenLabsSlot<T>(work: () => Promise<T>): Promise<T> {
  if (elevenLabsInflight >= ELEVENLABS_MAX_INFLIGHT) {
    await new Promise<void>((resolve) => elevenLabsWaiting.push(resolve));
  }
  elevenLabsInflight += 1;
  try {
    return await work();
  } finally {
    elevenLabsInflight -= 1;
    elevenLabsWaiting.shift()?.();
  }
}

async function synthesizeElevenLabs(voice: VoiceConfig, text: string): Promise<TtsAudio> {
  return withElevenLabsSlot(() => requestElevenLabs(voice, text));
}

async function requestElevenLabs(voice: VoiceConfig, text: string): Promise<TtsAudio> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new TtsError('ELEVENLABS_API_KEY is not set on the server', 503);
  const voiceId = voice.elevenLabsVoiceId || DEFAULT_ELEVENLABS_VOICE;
  const model = process.env.ELEVENLABS_MODEL || voice.elevenLabsModel || 'eleven_multilingual_v2';
  const response = await fetch(
    'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=mp3_44100_128',
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.8,
          style: 0.2,
          use_speaker_boost: true,
          speed: clamp(voice.rate, 0.7, 1.2),
        },
      }),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    },
  ).catch((error: Error) => {
    throw new TtsError('ElevenLabs unreachable: ' + error.message);
  });
  if (!response.ok) {
    throw new TtsError('ElevenLabs ' + response.status + ': ' + (await errorText(response)));
  }
  return { audio: Buffer.from(await response.arrayBuffer()), mime: 'audio/mpeg' };
}

async function synthesizeOpenAi(voice: VoiceConfig, text: string): Promise<TtsAudio> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new TtsError('OPENAI_API_KEY is not set on the server', 503);
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      voice: voice.openaiVoice || DEFAULT_OPENAI_VOICE,
      input: text,
      response_format: 'mp3',
      speed: clamp(voice.rate, 0.25, 4),
      instructions: OPENAI_STYLE,
    }),
    signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
  }).catch((error: Error) => {
    throw new TtsError('OpenAI unreachable: ' + error.message);
  });
  if (!response.ok) {
    throw new TtsError('OpenAI ' + response.status + ': ' + (await errorText(response)));
  }
  return { audio: Buffer.from(await response.arrayBuffer()), mime: 'audio/mpeg' };
}

/* --------------------------------- helpers -------------------------------- */

async function errorText(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; detail?: { message?: string } };
    if (typeof parsed.error === 'string') return parsed.error;
    return parsed.error?.message ?? parsed.detail?.message ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200) || response.statusText;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TtsError(label + ' timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
