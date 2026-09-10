import { useCallback, useEffect, useRef, useState } from 'react';
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

  /** Exact name match wins, then an exact locale, then the language prefix. */
  const pickVoice = useCallback(
    (list: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined => {
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
    },
    [config?.lang, config?.voiceName],
  );

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
      const voice = pickVoice(window.speechSynthesis.getVoices());
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? config?.lang ?? 'de-DE';
      utterance.rate = config?.rate ?? 1;
      utterance.pitch = config?.pitch ?? 1;

      utterance.onstart = () => {
        progressRef.current = 0;
        setSpeaking(true);
      };
      utterance.onboundary = (event) => {
        // charIndex lets the orb pulse in time with the words being spoken.
        progressRef.current = Math.min(1, event.charIndex / Math.max(1, body.length));
      };
      utterance.onend = () => {
        progressRef.current = 0;
        utteranceRef.current = null;
        setSpeaking(false);
      };
      utterance.onerror = () => {
        progressRef.current = 0;
        utteranceRef.current = null;
        setSpeaking(false);
      };

      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [config?.lang, config?.pitch, config?.rate, pickVoice, supported],
  );

  // Never leave the page still talking.
  useEffect(() => () => {
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);

  return { supported, speaking, progressRef, voices, speak, stop };
}
