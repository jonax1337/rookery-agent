import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Microphone level for the orb.
 *
 * Speech recognition gives words, not loudness, so the orb reads the
 * microphone itself through an AnalyserNode. Nothing is recorded and the
 * stream is never connected to the speakers.
 */

export interface MicLevel {
  active: boolean;
  /** Ask for the microphone. Resolves false when the user declines. */
  start(): Promise<boolean>;
  stop(): void;
  /** Smoothed 0..1 loudness, cheap enough to read every frame. */
  getLevel(): number;
}

export function useMicLevel(): MicLevel {
  const [active, setActive] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const smoothRef = useRef(0);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
    smoothRef.current = 0;
    setActive(false);
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (streamRef.current) return true;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      context.createMediaStreamSource(stream).connect(analyser);
      streamRef.current = stream;
      contextRef.current = context;
      analyserRef.current = analyser;
      dataRef.current = new Uint8Array(analyser.fftSize);
      setActive(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  const getLevel = useCallback((): number => {
    const analyser = analyserRef.current;
    const data = dataRef.current;
    if (!analyser || !data) return 0;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let index = 0; index < data.length; index += 1) {
      const sample = ((data[index] ?? 128) - 128) / 128;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 5);
    // Fast attack, slow release, so the orb reacts instantly and settles calmly.
    smoothRef.current = level > smoothRef.current ? level : smoothRef.current * 0.9 + level * 0.1;
    return smoothRef.current;
  }, []);

  useEffect(() => stop, [stop]);

  return { active, start, stop, getLevel };
}
