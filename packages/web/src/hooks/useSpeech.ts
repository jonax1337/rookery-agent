import { useCallback, useEffect, useRef, useState } from 'react';
import { pickBrowserVoice } from '../lib/speech';
import type { VoiceConfig } from '../lib/types';

/**
 * Speech synthesis.
 *
 * Everything is feature-detected: Firefox and some Linux builds ship no
 * usable voices, and the app has to stay fully usable in that case. Voice
 * lists load asynchronously in Chrome, hence the voiceschanged listener.
 */

export interface SpeechState {
  supported: boolean;
  speaking: boolean;
  /** 0..1 progress through the current utterance, for the orb. */
  progressRef: React.RefObject<number>;
  voices: SpeechSynthesisVoice[];
  speak(text: string): void;
  stop(): void;
}

export function useSpeech(config: VoiceConfig | undefined): SpeechState {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const progressRef = useRef(0);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    if (!supported) return;
    const load = (): void => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, [supported]);

  const stop = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    progressRef.current = 0;
    setSpeaking(false);
  }, [supported]);

  const speak = useCallback(
    (text: string) => {
      if (!supported) return;
      const body = text.trim();
      if (!body) return;

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(body);
      const voice = pickBrowserVoice(window.speechSynthesis.getVoices(), config);
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? config?.lang ?? 'en-GB';
      utterance.rate = config?.rate ?? 1;
      utterance.pitch = config?.pitch ?? 1;

      // `cancel()` ends the old utterance asynchronously; its late `end`/`error`
      // must not switch off the speaking state of the one that replaced it.
      const isCurrent = (): boolean => utteranceRef.current === utterance;
      const finish = (): void => {
        if (!isCurrent()) return;
        progressRef.current = 0;
        utteranceRef.current = null;
        setSpeaking(false);
      };

      utterance.onstart = () => {
        if (!isCurrent()) return;
        progressRef.current = 0;
        setSpeaking(true);
      };
      utterance.onboundary = (event) => {
        if (!isCurrent()) return;
        // charIndex lets the orb pulse in time with the words being spoken.
        progressRef.current = Math.min(1, event.charIndex / Math.max(1, body.length));
      };
      utterance.onend = finish;
      utterance.onerror = finish;

      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [config, supported],
  );

  // Never leave the page still talking.
  useEffect(() => () => {
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);

  return { supported, speaking, progressRef, voices, speak, stop };
}
