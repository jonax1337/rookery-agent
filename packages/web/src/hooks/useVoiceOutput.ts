import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSpeech } from '../lib/api';
import type { VoiceConfig, VoiceEngine } from '../lib/types';

/**
 * The assistant's voice.
 *
 * Sentences go into a queue while the answer is still streaming; each one is
 * synthesised ahead of time and played back to back, so the first words are
 * heard long before the model has finished. Server engines (Edge, ElevenLabs,
 * OpenAI) return MP3 that is decoded and routed through a small Web Audio
 * chain; the browser's own speechSynthesis is the fallback whenever the
 * server cannot deliver, so the screen never goes mute.
 *
 * The output runs through an AnalyserNode so the orb can move with the voice.
 */

export interface VoiceOutput {
  /** The engine actually in use: `browser` once a server engine has failed. */
  engine: VoiceEngine;
  speaking: boolean;
  /** Why the server engine was abandoned, for the screen to explain. */
  error: string | null;
  /** Create and resume the audio context. Call once from a user gesture. */
  unlock(): void;
  /** Append a sentence; playback starts as soon as the first one is decoded. */
  enqueue(text: string): void;
  /** Drop the queue and say this instead. */
  speak(text: string): void;
  stop(): void;
  /** Smoothed 0..1 loudness of the voice, cheap enough to read every frame. */
  getLevel(): number;
}

interface QueueItem {
  text: string;
  /** Started lazily so only a few requests are in flight at once. */
  audio: Promise<AudioBuffer | null> | null;
}

/**
 * Sentences synthesised ahead of the one playing. ElevenLabs caps concurrent
 * requests per account (two on the free tier), so it gets a shorter run-up.
 */
const LOOKAHEAD: Record<VoiceEngine, number> = { browser: 0, edge: 3, elevenlabs: 2, openai: 3 };
/** One quick retry before a sentence falls back to the browser voice. */
const RETRY_DELAY_MS = 600;

export function useVoiceOutput(config: VoiceConfig | undefined): VoiceOutput {
  const wanted: VoiceEngine = config?.engine ?? 'browser';
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);

  const configRef = useRef(config);
  configRef.current = config;
  const contextRef = useRef<AudioContext | null>(null);
  const chainRef = useRef<{ input: AudioNode; analyser: AnalyserNode; jarvis: boolean } | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const playingRef = useRef<AudioBufferSourceNode | null>(null);
  const pumpingRef = useRef(false);
  /** Bumped by stop(); anything that finishes for an older generation is dropped. */
  const generationRef = useRef(0);
  const fallbackRef = useRef(false);
  const errorRef = useRef<string | null>(null);
  const browserActiveRef = useRef(0);
  const levelRef = useRef(0);
  const speakingRef = useRef(false);

  // A new engine in the settings gets a fresh chance.
  useEffect(() => {
    fallbackRef.current = false;
    setFallback(false);
    setError(null);
  }, [wanted]);

  const markSpeaking = useCallback((on: boolean) => {
    speakingRef.current = on;
    setSpeaking(on);
  }, []);

  /* ------------------------------ web audio ------------------------------ */

  const ensureContext = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
    if (!contextRef.current) contextRef.current = new AudioContext();
    return contextRef.current;
  }, []);

  const ensureChain = useCallback((): { input: AudioNode; analyser: AnalyserNode } | null => {
    const context = ensureContext();
    if (!context) return null;
    const jarvis = configRef.current?.jarvisEffect ?? false;
    if (chainRef.current && chainRef.current.jarvis === jarvis) return chainRef.current;
    chainRef.current?.analyser.disconnect();
    const chain = buildChain(context, jarvis);
    chainRef.current = { ...chain, jarvis };
    dataRef.current = new Uint8Array(chain.analyser.fftSize);
    return chain;
  }, [ensureContext]);

  const unlock = useCallback(() => {
    const context = ensureContext();
    if (context?.state === 'suspended') void context.resume();
    ensureChain();
  }, [ensureChain, ensureContext]);

  /* ------------------------------ browser tts ---------------------------- */

  const browserSpeak = useCallback(
    (text: string): Promise<void> =>
      new Promise((resolve) => {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
          resolve();
          return;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        const current = configRef.current;
        const voice = pickBrowserVoice(window.speechSynthesis.getVoices(), current);
        if (voice) utterance.voice = voice;
        utterance.lang = voice?.lang ?? current?.lang ?? 'de-DE';
        utterance.rate = current?.rate ?? 1;
        utterance.pitch = current?.pitch ?? 1;
        const done = (): void => {
          browserActiveRef.current = Math.max(0, browserActiveRef.current - 1);
          resolve();
        };
        utterance.onend = done;
        utterance.onerror = done;
        browserActiveRef.current += 1;
        window.speechSynthesis.speak(utterance);
      }),
    [],
  );

  /* -------------------------------- queue -------------------------------- */

  const synthesise = useCallback(
    async (text: string, generation: number): Promise<AudioBuffer | null> => {
      const context = ensureContext();
      if (!context) return null;
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const bytes = await fetchSpeech(text);
          if (generation !== generationRef.current) return null;
          const buffer = await context.decodeAudioData(bytes);
          // The server is fine again: forget an earlier stumble.
          if (fallbackRef.current || errorRef.current) {
            fallbackRef.current = false;
            errorRef.current = null;
            setFallback(false);
            setError(null);
          }
          return buffer;
        } catch (caught) {
          if (generation !== generationRef.current) return null;
          lastError = caught as Error;
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
      // This answer finishes in the browser voice; the next one tries the
      // server again, so one hiccup never silences the real voice for good.
      fallbackRef.current = true;
      errorRef.current = lastError?.message || 'Sprachausgabe auf dem Server fehlgeschlagen';
      setFallback(true);
      setError(errorRef.current);
      return null;
    },
    [ensureContext],
  );

  /** Start synthesis for the next few queued sentences that lack audio. */
  const prefetch = useCallback(() => {
    const generation = generationRef.current;
    queueRef.current.slice(0, LOOKAHEAD[wanted]).forEach((item) => {
      if (!item.audio) item.audio = synthesise(item.text, generation);
    });
  }, [synthesise, wanted]);

  const pump = useCallback(async (): Promise<void> => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    const generation = generationRef.current;
    try {
      while (queueRef.current.length && generation === generationRef.current) {
        const item = queueRef.current.shift() as QueueItem;
        markSpeaking(true);
        prefetch();

        let buffer: AudioBuffer | null = null;
        if (!fallbackRef.current && wanted !== 'browser') {
          buffer = await (item.audio ?? synthesise(item.text, generation));
        }
        if (generation !== generationRef.current) return;

        if (!buffer) {
          await browserSpeak(item.text);
          continue;
        }

        const context = ensureContext();
        const chain = ensureChain();
        if (!context || !chain) continue;
        if (context.state === 'suspended') await context.resume().catch(() => undefined);
        await new Promise<void>((resolve) => {
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(chain.input);
          source.onended = () => {
            if (playingRef.current === source) playingRef.current = null;
            resolve();
          };
          playingRef.current = source;
          source.start();
        });
      }
    } finally {
      pumpingRef.current = false;
      if (!queueRef.current.length && generation === generationRef.current) {
        markSpeaking(false);
        // The answer is over; give the server voice another chance next time.
        fallbackRef.current = false;
      }
    }
  }, [browserSpeak, ensureChain, ensureContext, markSpeaking, prefetch, synthesise, wanted]);

  const enqueue = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!body) return;
      queueRef.current.push({ text: body, audio: null });
      if (!fallbackRef.current && wanted !== 'browser') prefetch();
      void pump();
    },
    [prefetch, pump, wanted],
  );

  const stop = useCallback(() => {
    generationRef.current += 1;
    queueRef.current = [];
    try {
      playingRef.current?.stop();
    } catch {
      // Already finished.
    }
    playingRef.current = null;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    browserActiveRef.current = 0;
    levelRef.current = 0;
    markSpeaking(false);
  }, [markSpeaking]);

  const speak = useCallback(
    (text: string) => {
      stop();
      enqueue(text);
    },
    [enqueue, stop],
  );

  /* -------------------------------- level -------------------------------- */

  const getLevel = useCallback((): number => {
    if (!speakingRef.current) {
      levelRef.current *= 0.85;
      return levelRef.current;
    }
    const analyser = chainRef.current?.analyser;
    const data = dataRef.current;
    let level: number;
    if (playingRef.current && analyser && data) {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let index = 0; index < data.length; index += 1) {
        const sample = ((data[index] ?? 128) - 128) / 128;
        sum += sample * sample;
      }
      level = Math.min(1, Math.sqrt(sum / data.length) * 4);
    } else if (browserActiveRef.current > 0) {
      // speechSynthesis exposes no signal; a lively pulse stands in for it.
      const t = performance.now() / 1000;
      level = 0.35 + 0.2 * Math.sin(t * 9.3) + 0.12 * Math.sin(t * 23.7) + 0.08 * Math.sin(t * 3.1);
    } else {
      // Waiting for the next sentence to arrive: a quiet hum, not silence.
      level = 0.12;
    }
    levelRef.current = level > levelRef.current ? level : levelRef.current * 0.88 + level * 0.12;
    return levelRef.current;
  }, []);

  // Never leave the page still talking.
  useEffect(
    () => () => {
      generationRef.current += 1;
      queueRef.current = [];
      try {
        playingRef.current?.stop();
      } catch {
        // Already finished.
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
      void contextRef.current?.close().catch(() => undefined);
      contextRef.current = null;
      chainRef.current = null;
    },
    [],
  );

  return {
    engine: fallback ? 'browser' : wanted,
    speaking,
    error,
    unlock,
    enqueue,
    speak,
    stop,
    getLevel,
  };
}

/* --------------------------------- helpers -------------------------------- */

/**
 * The playback chain. With the effect on, the voice gets a comms treatment:
 * mud removed, presence lifted, gentle compression, and two short slapback
 * taps that put it inside a helmet without turning it into a robot.
 */
function buildChain(context: AudioContext, jarvis: boolean): { input: GainNode; analyser: AnalyserNode } {
  const input = context.createGain();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.5;
  analyser.connect(context.destination);

  if (!jarvis) {
    input.connect(analyser);
    return { input, analyser };
  }

  const filter = (type: BiquadFilterType, frequency: number, gain = 0, q = 0.8): BiquadFilterNode => {
    const node = context.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.gain.value = gain;
    node.Q.value = q;
    return node;
  };
  const highpass = filter('highpass', 110);
  const body = filter('lowshelf', 220, -2);
  const presence = filter('peaking', 1800, 3, 0.9);
  const air = filter('highshelf', 4200, 3.5);
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.12;

  input.connect(highpass);
  highpass.connect(body);
  body.connect(presence);
  presence.connect(air);
  air.connect(compressor);

  const dry = context.createGain();
  dry.gain.value = 0.9;
  compressor.connect(dry);
  dry.connect(analyser);

  for (const [seconds, amount] of [
    [0.013, 0.16],
    [0.029, 0.09],
  ] as const) {
    const delay = context.createDelay(0.1);
    delay.delayTime.value = seconds;
    const tap = context.createGain();
    tap.gain.value = amount;
    compressor.connect(delay);
    delay.connect(tap);
    tap.connect(analyser);
  }

  return { input, analyser };
}

/** Exact name match wins, then an exact locale, then the language prefix. */
function pickBrowserVoice(
  list: SpeechSynthesisVoice[],
  config: VoiceConfig | undefined,
): SpeechSynthesisVoice | undefined {
  if (!list.length) return undefined;
  const wantedName = config?.voiceName?.trim();
  if (wantedName) {
    const byName = list.find((voice) => voice.name === wantedName);
    if (byName) return byName;
  }
  const lang = config?.lang ?? 'de-DE';
  return (
    list.find((voice) => voice.lang === lang) ??
    list.find((voice) => voice.lang.startsWith(lang.split('-')[0] ?? '')) ??
    list.find((voice) => voice.default) ??
    list[0]
  );
}
