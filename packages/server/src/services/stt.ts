import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { TranscribeEngine } from '@rookery/core';
import { voiceKeys, type VoiceKeys } from './voice-keys.js';

/**
 * Server-side speech-to-text: the other half of `tts.ts`.
 *
 * A voice note is the fastest way to say something to an assistant and the
 * one thing this machine could not hear. Three engines turn it into words:
 *
 *   local       Whisper through `@huggingface/transformers`, on this
 *               machine. No key, no account, and the audio never leaves the
 *               house. The model is fetched once (about 130 MB for `base`)
 *               and cached under `<home>/models`; every run after that is
 *               offline. This is the engine that makes the feature a
 *               promise rather than an upsell.
 *   openai      gpt-4o-mini-transcribe. Faster and a little sharper on
 *               names. Needs the OpenAI key the voice page already stores.
 *   elevenlabs  Scribe v1. Needs the ElevenLabs key.
 *
 * `auto` walks that list backwards - a configured key first, the local model
 * when there is none or the keyed attempt fails - so the answer to "is
 * transcription available" is always yes.
 *
 * Decoding is ffmpeg's job. Telegram sends OGG/Opus, phones record m4a, and
 * a video note is an mp4 with a sound track; one decoder handles all of it
 * and hands back exactly what Whisper wants: mono 16 kHz float samples.
 */

export interface TranscribeRequest {
  audio: Buffer;
  /** Telegram's mime type, used to name the upload for the keyed engines. */
  mime?: string;
  fileName?: string;
  /** Which engine to use; `auto` picks, `off` never reaches here. */
  engine: TranscribeEngine;
  /** Local Whisper model id, e.g. `onnx-community/whisper-base`. */
  model: string;
  /** BCP-47 tag from the voice config. Only the language part is used. */
  lang?: string;
  /** Rookery home; the local model cache lives under it. */
  home: string;
  signal?: AbortSignal;
}

export interface Transcript {
  text: string;
  engine: 'local' | 'openai' | 'elevenlabs';
  ms: number;
  /** True when the local model had to be fetched or loaded for this run. */
  coldStart?: boolean;
}

export class SttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttError';
  }
}

/** How long a single transcription may take before it is given up on. */
const TIMEOUT_MS = 180_000;

/** Whisper's own sample rate. Anything else is silently wrong, not loud. */
const SAMPLE_RATE = 16_000;

/** Where ffmpeg is, when it is not simply on PATH. */
const ffmpegPath = (): string => process.env.ROOKERY_FFMPEG?.trim() || 'ffmpeg';

/* ----------------------------- decoding ----------------------------- */

/**
 * Any audio container to mono 16 kHz float samples, through ffmpeg on stdin.
 *
 * Reading from a pipe rather than a temp file keeps a voice note out of the
 * file system on the way to being heard. A broken pipe is ignored on the
 * write side: ffmpeg closing stdin early (a header it cannot read) has to
 * surface as its own exit status, not as an unhandled EPIPE.
 */
async function decodeToPcm(audio: Buffer, signal?: AbortSignal): Promise<Float32Array> {
  const binary = ffmpegPath();
  return new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(
      binary,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(error);
    };

    const abort = (): void => fail(new SttError('The transcription was cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(
        error.code === 'ENOENT'
          ? new SttError(
              'ffmpeg was not found. Install it (winget install Gyan.FFmpeg, brew install ffmpeg, apt install ffmpeg) ' +
                'or point ROOKERY_FFMPEG at the binary; local transcription decodes audio with it.',
            )
          : new SttError('ffmpeg could not be started: ' + error.message),
      );
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const detail = Buffer.concat(err).toString('utf8').trim().split('\n').at(-1) ?? 'unknown error';
        reject(new SttError('The audio could not be decoded: ' + detail));
        return;
      }
      const pcm = Buffer.concat(out);
      if (pcm.length < 4) {
        reject(new SttError('The audio held no sound.'));
        return;
      }
      // A copy, not a view: `Buffer.concat` may hand back a slice of a
      // pooled allocation whose offset is not four-byte aligned, and a
      // Float32Array cannot be laid over that.
      const samples = new Float32Array(Math.floor(pcm.length / 4));
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = pcm.readFloatLE(index * 4);
      }
      resolve(samples);
    });

    child.stdin.end(audio);
  });
}

/* --------------------------- local Whisper --------------------------- */

/** What a loaded automatic-speech-recognition pipeline is, as far as this file cares. */
type AsrPipeline = (input: Float32Array, options: Record<string, unknown>) => Promise<{ text?: string }>;

/** As much of `@huggingface/transformers` as this file uses. */
interface TransformersModule {
  env: { cacheDir?: string };
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Not a literal, so TypeScript does not try to resolve the module at build
 * time. The package is an optional dependency; a build machine without it
 * still has to produce a server that runs.
 */
const TRANSFORMERS: string = '@huggingface/transformers';

/**
 * The loaded pipeline, per model.
 *
 * Held for the life of the process: loading is seconds and a fetch on the
 * first run, and a voice note that waits for the same work twice is a voice
 * note nobody sends again. Keyed by model so switching in the settings does
 * not serve an answer from the previous one.
 */
const localModels = new Map<string, Promise<AsrPipeline>>();

/** Whether the local engine has been loaded already, for the "cold" note. */
export function localModelReady(model: string): boolean {
  return localModels.has(model);
}

async function localPipeline(model: string, home: string): Promise<AsrPipeline> {
  const existing = localModels.get(model);
  if (existing) return existing;

  const loading = (async (): Promise<AsrPipeline> => {
    let transformers: TransformersModule;
    try {
      // Through a variable, and typed structurally: the package is optional,
      // and an install that skipped it must still compile and still start -
      // it is a missing engine, not a broken server.
      transformers = (await import(TRANSFORMERS)) as unknown as TransformersModule;
    } catch {
      throw new SttError(
        'Local transcription needs @huggingface/transformers, which is an optional dependency and is not installed. ' +
          'Run npm install @huggingface/transformers in the Rookery folder, or set a transcription key on the voice page.',
      );
    }
    // The cache goes next to the rest of the user's Rookery state rather
    // than into a hidden folder in the home directory, so "what is this
    // 130 MB" has an answer and deleting it is a decision, not a rescue.
    transformers.env.cacheDir = join(home, 'models');
    // The encoder stays fp32 - quantising it is where Whisper starts
    // mishearing numbers - while the decoder, which is most of the
    // download, is quantised.
    const pipe = await transformers.pipeline('automatic-speech-recognition', model, {
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    });
    return pipe as unknown as AsrPipeline;
  })();

  localModels.set(model, loading);
  try {
    return await loading;
  } catch (error) {
    // A failed load must not be cached, or a missing package would be
    // reported forever after it has been installed.
    localModels.delete(model);
    throw error;
  }
}

/** "de-DE" to "de"; anything unreadable means "let the model decide". */
function languageOf(lang?: string): string | undefined {
  const code = lang?.trim().slice(0, 2).toLowerCase();
  return code && /^[a-z]{2}$/.test(code) ? code : undefined;
}

async function transcribeLocal(request: TranscribeRequest): Promise<string> {
  const audio = await decodeToPcm(request.audio, request.signal);
  const run = await localPipeline(request.model, request.home);
  const options: Record<string, unknown> = {
    task: 'transcribe',
    // 30 s is Whisper's own window; the overlap keeps a word from being cut
    // in half at the seam of two windows.
    chunk_length_s: 30,
    stride_length_s: 5,
  };
  const language = languageOf(request.lang);
  if (language) options.language = language;
  try {
    const result = await run(audio, options);
    return typeof result?.text === 'string' ? result.text : '';
  } catch (error) {
    // An unsupported language tag is the one failure worth a second pass:
    // letting Whisper detect the language beats refusing the note.
    if (language) {
      delete options.language;
      const result = await run(audio, options);
      return typeof result?.text === 'string' ? result.text : '';
    }
    throw error instanceof SttError
      ? error
      : new SttError('The local model could not transcribe this: ' + (error as Error).message);
  }
}

/* ---------------------------- keyed engines ---------------------------- */

/** A name the upload can carry; the extension is what the APIs sniff. */
function uploadName(request: TranscribeRequest): string {
  if (request.fileName && /\.[A-Za-z0-9]{1,5}$/.test(request.fileName)) return request.fileName;
  const mime = request.mime ?? '';
  if (mime.includes('ogg')) return 'voice.ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'voice.mp3';
  if (mime.includes('wav')) return 'voice.wav';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'voice.m4a';
  if (mime.includes('webm')) return 'voice.webm';
  return 'voice.ogg';
}

function form(request: TranscribeRequest, fields: Record<string, string>): FormData {
  const body = new FormData();
  const blob = new Blob([new Uint8Array(request.audio)], { type: request.mime || 'application/octet-stream' });
  body.append('file', blob, uploadName(request));
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return body;
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: FormData,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new SttError('Transcription failed (' + response.status + ') ' + detail.slice(0, 200));
  }
  return (await response.json()) as Record<string, unknown>;
}

async function transcribeOpenAi(request: TranscribeRequest, key: string): Promise<string> {
  const fields: Record<string, string> = { model: 'gpt-4o-mini-transcribe', response_format: 'json' };
  const language = languageOf(request.lang);
  if (language) fields.language = language;
  const body = await post(
    'https://api.openai.com/v1/audio/transcriptions',
    { authorization: 'Bearer ' + key },
    form(request, fields),
    request.signal,
  );
  return typeof body.text === 'string' ? body.text : '';
}

async function transcribeElevenLabs(request: TranscribeRequest, key: string): Promise<string> {
  const fields: Record<string, string> = { model_id: 'scribe_v1' };
  const language = languageOf(request.lang);
  if (language) fields.language_code = language;
  const body = await post(
    'https://api.elevenlabs.io/v1/speech-to-text',
    { 'xi-api-key': key },
    form(request, fields),
    request.signal,
  );
  return typeof body.text === 'string' ? body.text : '';
}

/* -------------------------------- entry -------------------------------- */

/** Which engines could run right now, for the settings page and the logs. */
export function sttEngines(keys: VoiceKeys = voiceKeys()): Record<'local' | 'openai' | 'elevenlabs', boolean> {
  return {
    // The local engine counts as available even before the model is
    // fetched: "needs a download" is a wait, not an absence.
    local: true,
    openai: Boolean(keys.openai),
    elevenlabs: Boolean(keys.elevenlabs),
  };
}

/**
 * Speech to text, by whichever engine the config asks for.
 *
 * `auto` tries a configured key first and falls through to the local model
 * on any failure, because a rate-limited account is not a reason for the
 * phone to go deaf. An explicitly named engine is not second-guessed: the
 * user who picked ElevenLabs wants to hear when ElevenLabs is broken.
 */
export async function transcribe(
  request: TranscribeRequest,
  keys: VoiceKeys = voiceKeys(request.home),
): Promise<Transcript> {
  const started = Date.now();
  const done = (text: string, engine: Transcript['engine'], coldStart?: boolean): Transcript => {
    const clean = text.trim();
    if (!clean) throw new SttError('No speech was recognised in this recording.');
    const result: Transcript = { text: clean, engine, ms: Date.now() - started };
    if (coldStart) result.coldStart = true;
    return result;
  };

  switch (request.engine) {
    case 'off':
      throw new SttError('Transcription is switched off for this gateway.');

    case 'openai': {
      if (!keys.openai) throw new SttError('No OpenAI key is configured for transcription.');
      return done(await transcribeOpenAi(request, keys.openai), 'openai');
    }

    case 'elevenlabs': {
      if (!keys.elevenlabs) throw new SttError('No ElevenLabs key is configured for transcription.');
      return done(await transcribeElevenLabs(request, keys.elevenlabs), 'elevenlabs');
    }

    case 'local': {
      const cold = !localModelReady(request.model);
      return done(await transcribeLocal(request), 'local', cold);
    }

    case 'auto':
    default: {
      const attempts: Array<[Transcript['engine'], () => Promise<string>]> = [];
      const openaiKey = keys.openai;
      const elevenKey = keys.elevenlabs;
      if (openaiKey) attempts.push(['openai', () => transcribeOpenAi(request, openaiKey)]);
      if (elevenKey) attempts.push(['elevenlabs', () => transcribeElevenLabs(request, elevenKey)]);
      let keyedError: unknown;
      for (const [engine, attempt] of attempts) {
        try {
          return done(await attempt(), engine);
        } catch (error) {
          keyedError = error;
        }
      }
      const cold = !localModelReady(request.model);
      try {
        return done(await transcribeLocal(request), 'local', cold);
      } catch (error) {
        // Both roads are gone. The local message is the one that names
        // something to install, so it leads; the keyed failure follows,
        // because "your key was refused" is the other half of the story.
        const local = error instanceof Error ? error.message : String(error);
        const keyed = keyedError instanceof Error ? ' The configured key failed first: ' + keyedError.message : '';
        throw new SttError(local + keyed);
      }
    }
  }
}
