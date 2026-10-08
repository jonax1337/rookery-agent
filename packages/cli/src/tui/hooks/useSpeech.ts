/**
 * Spoken replies.
 *
 * Speech outlives its turn: a reply is only spoken once the turn has ended,
 * so it gets an AbortController of its own. While one is set, Ctrl+C stops
 * the voice instead of leaving, exactly as in the REPL.
 */

import { useCallback, useRef } from 'react';
import type { RookeryConfig } from '@rookery/core';
import { SPEECH_ABORTED, speak, stopSpeaking } from '../../ui/speech.js';

export interface SpeechApi {
  /** Speak `text`, replacing any reply still playing. */
  say: (text: string) => void;
  /** Silence the voice, if it is playing. */
  stop: () => void;
  /** True while a spoken reply is still playing. */
  isSpeaking: () => boolean;
}

/** `onFailure` hears why a reply could not be spoken; an abort is not a failure. */
export function useSpeech(
  { lang, rate, voiceName }: RookeryConfig['voice'],
  onFailure: (detail: string) => void,
): SpeechApi {
  const current = useRef<AbortController | null>(null);

  const say = useCallback(
    (text: string) => {
      const speech = new AbortController();
      current.current = speech;
      void speak(text, { lang, rate, voiceName, signal: speech.signal }).then((spoken) => {
        // A newer reply replaced this controller; its outcome no longer
        // belongs to anyone.
        if (current.current !== speech) return;
        current.current = null;
        if (!spoken.ok && spoken.detail !== SPEECH_ABORTED) onFailure(spoken.detail ?? 'speech failed');
      });
    },
    [lang, rate, voiceName, onFailure],
  );

  const stop = useCallback(() => {
    current.current?.abort();
    stopSpeaking();
  }, []);

  const isSpeaking = useCallback(() => current.current !== null, []);

  return { say, stop, isSpeaking };
}
