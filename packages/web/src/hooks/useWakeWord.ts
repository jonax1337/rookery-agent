import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Speech recognition: push-to-talk and hands-free wake word.
 *
 * The Web Speech API is Chromium-only in practice and is not in lib.dom, so
 * the surface we use is declared here. Everything is guarded: on Firefox and
 * Safari `supported` is false and the app falls back to typing.
 */

interface RecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface RecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: RecognitionAlternative;
}
interface RecognitionResultList {
  readonly length: number;
  [index: number]: RecognitionResult;
}
interface RecognitionEvent extends Event {
  resultIndex: number;
  results: RecognitionResultList;
}
interface RecognitionErrorEvent extends Event {
  error: string;
  message: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type RecognitionConstructor = new () => SpeechRecognitionLike;

function getRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export interface SpeechInputOptions {
  lang: string;
  wakeWord: string;
  /** Keep listening and trigger only on the wake word. */
  handsFree: boolean;
  /** Called with a finished utterance, wake word already removed. */
  onUtterance(text: string): void;
  /** Suppress recognition while the assistant is talking, to avoid self-triggering. */
  paused?: boolean;
}

export interface SpeechInputState {
  supported: boolean;
  listening: boolean;
  /** Live partial transcript, for the composer. */
  interim: string;
  error: string | null;
  /** Push-to-talk: begin a single dictation. */
  start(): void;
  stop(): void;
}

export function useSpeechInput(options: SpeechInputOptions): SpeechInputState {
  const { lang, wakeWord, handsFree, onUtterance, paused = false } = options;

  const [supported] = useState(() => getRecognitionConstructor() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** True while a push-to-talk dictation is running, so `end` does not restart. */
  const manualRef = useRef(false);
  const wantRunningRef = useRef(false);
  const callbackRef = useRef(onUtterance);
  callbackRef.current = onUtterance;

  const handleFinal = useCallback(
    (transcript: string) => {
      const text = transcript.trim();
      if (!text) return;

      if (manualRef.current || !handsFree) {
        callbackRef.current(text);
        return;
      }

      // Hands-free without a wake word (the voice screen): everything counts.
      const needle = wakeWord.trim().toLowerCase();
      if (!needle) {
        callbackRef.current(text);
        return;
      }
      const haystack = text.toLowerCase();
      const at = haystack.indexOf(needle);
      if (at === -1) return;

      const command = text.slice(at + needle.length).replace(/^[\s,.:;!?-]+/, '').trim();
      if (command) callbackRef.current(command);
    },
    [handsFree, wakeWord],
  );

  // The recogniser instance is cached, so its handlers must read the current
  // matcher via a ref — otherwise they keep matching the wake word (and
  // hands-free flag) that was current when they were first bound.
  const handleFinalRef = useRef(handleFinal);
  handleFinalRef.current = handleFinal;

  const stop = useCallback(() => {
    wantRunningRef.current = false;
    manualRef.current = false;
    recognitionRef.current?.stop();
    setListening(false);
    setInterim('');
  }, []);

  const ensureRecognition = useCallback((): SpeechRecognitionLike | null => {
    if (recognitionRef.current) return recognitionRef.current;
    const Constructor = getRecognitionConstructor();
    if (!Constructor) return null;

    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setListening(true);
      setError(null);
    };

    recognition.onresult = (event) => {
      let partial = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) handleFinalRef.current(text);
        else partial += text;
      }
      setInterim(partial);
    };

    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are routine; only surface real problems.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      setError(
        event.error === 'not-allowed'
          ? 'Microphone access was denied.'
          : 'Speech recognition: ' + event.error,
      );
      wantRunningRef.current = false;
    };

    recognition.onend = () => {
      setListening(false);
      setInterim('');
      manualRef.current = false;
      // Chrome ends the session after a pause; hands-free has to restart it.
      if (wantRunningRef.current) {
        setTimeout(() => {
          if (!wantRunningRef.current) return;
          try {
            recognition.start();
          } catch {
            // Already starting; the next onend will retry.
          }
        }, 250);
      }
    };

    recognitionRef.current = recognition;
    return recognition;
    // No handleFinal dependency on purpose: the handlers above read it through
    // handleFinalRef, so wake-word changes must not churn this callback (and
    // with it the hands-free effect) — the cached instance stays as is.
  }, []);

  const start = useCallback(() => {
    const recognition = ensureRecognition();
    if (!recognition) return;
    recognition.lang = lang;
    manualRef.current = true;
    try {
      recognition.start();
    } catch {
      // start() throws if it is already running, which is harmless here.
    }
  }, [ensureRecognition, lang]);

  // Hands-free mode owns the recogniser for as long as it is enabled.
  useEffect(() => {
    if (!supported) return;
    if (!handsFree || paused) {
      wantRunningRef.current = false;
      recognitionRef.current?.stop();
      return;
    }

    const recognition = ensureRecognition();
    if (!recognition) return;
    recognition.lang = lang;
    wantRunningRef.current = true;
    try {
      recognition.start();
    } catch {
      // Already running.
    }

    return () => {
      wantRunningRef.current = false;
      recognition.stop();
    };
  }, [ensureRecognition, handsFree, lang, paused, supported]);

  useEffect(
    () => () => {
      wantRunningRef.current = false;
      recognitionRef.current?.abort();
    },
    [],
  );

  return { supported, listening, interim, error, start, stop };
}
