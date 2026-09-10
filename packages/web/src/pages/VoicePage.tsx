import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLinesIcon,
  MicIcon,
  MicOffIcon,
  RotateCcwIcon,
  SettingsIcon,
  SquareIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import { VoiceOrb, type OrbState } from '@/components/VoiceOrb';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useChat } from '../hooks/useChat';
import { api } from '../lib/api';
import type { RookerySocket } from '../lib/socket';
import { useMicLevel } from '../hooks/useMicLevel';
import { useVoiceOutput } from '../hooks/useVoiceOutput';
import { useSpeechInput } from '../hooks/useWakeWord';
import { cleanForSpeech, SentenceSplitter } from '../lib/speech';
import type { ChatPayload, PublicConfig, VoiceEngine } from '../lib/types';

/**
 * The hands-free screen.
 *
 * Nothing but the orb, a caption and a few controls. Speech recognition runs
 * continuously; every finished utterance becomes a turn, the answer is read
 * aloud sentence by sentence while it streams, and the microphone reopens
 * the moment the voice stops. Tap the orb to interrupt.
 *
 * Starting needs a click: browsers only hand out the microphone and audio
 * output after a user gesture, and that same click takes the page fullscreen.
 */

interface VoicePageProps {
  socket: RookerySocket;
  config: PublicConfig | null;
  assistantName: string;
  /** Turns an utterance into the payload for the assistant. */
  buildPayload(text: string): ChatPayload;
  /** The voice conversation shows in the session list like any other. */
  onSessionsChanged(): void;
  onExit(): void;
}

const WAKE_PREFERENCE = 'rookery.voice.requireWake';
const BARGE_IN_PREFERENCE = 'rookery.voice.bargeIn';
const VOICE_SESSION = 'rookery.voice.sessionId';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode; the preference lives for this visit only.
  }
}

/** Lowercase words only, so a recognised echo of our own voice compares cleanly. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9äöüß ]+/g, ' ').replace(/ +/g, ' ').trim();
}

/**
 * Did the microphone just hear the assistant itself? True when most of the
 * words were part of what the voice has been saying. Barge-in relies on it
 * with speakers instead of headphones.
 */
function isEcho(heard: string, spoken: string[]): boolean {
  const text = normalise(heard);
  if (!text) return true;
  const corpus = ' ' + spoken.join(' ') + ' ';
  if (corpus.includes(' ' + text + ' ')) return true;
  const words = text.split(' ').filter((word) => word.length > 2);
  if (words.length < 2) return corpus.includes(' ' + text + ' ');
  const hits = words.filter((word) => corpus.includes(' ' + word + ' ')).length;
  return hits / words.length >= 0.6;
}

const ENGINE_LABEL: Record<VoiceEngine, string> = {
  browser: 'Browser',
  edge: 'Edge Neural',
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
};

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Noch wach? Ich höre.';
  if (hour < 11) return 'Guten Morgen. Ich höre.';
  if (hour < 18) return 'Guten Tag. Ich höre.';
  return 'Guten Abend. Ich höre.';
}

function readWakePreference(): boolean {
  try {
    return localStorage.getItem(WAKE_PREFERENCE) === '1';
  } catch {
    return false;
  }
}

export function VoicePage({
  socket,
  config,
  assistantName,
  buildPayload,
  onSessionsChanged,
  onExit,
}: VoicePageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const voice = useVoiceOutput(config?.voice);
  const mic = useMicLevel();

  const [phase, setPhase] = useState<'gate' | 'live'>('gate');
  const [muted, setMuted] = useState(false);
  const [requireWake, setRequireWake] = useState(readWakePreference);
  const [heard, setHeard] = useState('');
  const [micDenied, setMicDenied] = useState(false);
  const [pointerActive, setPointerActive] = useState(true);
  const [bargeIn, setBargeIn] = useState(() => readStored(BARGE_IN_PREFERENCE) === '1');

  /* ------------------------------ session ------------------------------- */

  // Hands-free has its own conversation with the assistant, kept apart from
  // the text chats. It survives leaving the screen; the reset button starts over.
  // `/voice?session=<id>` re-enters an earlier voice conversation from the list.
  const [voiceSessionId, setVoiceSessionId] = useState<string | null>(() => {
    const requested = searchParams.get('session');
    if (requested) writeStored(VOICE_SESSION, requested);
    return requested ?? readStored(VOICE_SESSION);
  });
  const onSessionsChangedRef = useRef(onSessionsChanged);
  onSessionsChangedRef.current = onSessionsChanged;
  const onSession = useCallback((id: string) => {
    setVoiceSessionId(id);
    writeStored(VOICE_SESSION, id);
    void api
      .patchSession(id, { title: 'Sprachgespräch · ' + new Date().toLocaleDateString('de-DE') })
      .catch(() => undefined)
      .then(() => onSessionsChangedRef.current());
  }, []);
  const onSettled = useCallback(() => onSessionsChangedRef.current(), []);
  const chat = useChat(socket, voiceSessionId, onSession, onSettled);

  // A remembered conversation the server no longer has must not be reused.
  useEffect(() => {
    if (!voiceSessionId) return;
    void api.session(voiceSessionId).catch(() => {
      setVoiceSessionId(null);
      writeStored(VOICE_SESSION, null);
    });
  }, [voiceSessionId]);

  const lang = config?.voice.lang ?? 'de-DE';
  const wakeWord = config?.voice.wakeWord ?? '';
  const cleanText = config?.voice.speakCleanText !== false;

  /* ------------------------------ speaking ------------------------------ */

  const splitterRef = useRef(new SentenceSplitter());
  /** Cleaned text of the stream so far, to know what has been handed to the voice. */
  const streamRef = useRef('');
  const turnStartedAtRef = useRef(0);
  const turnOpenRef = useRef(false);
  const cancelledRef = useRef(false);
  /** What the voice has said lately, to recognise its own echo in the microphone. */
  const spokenRef = useRef<string[]>([]);
  const { enqueue: enqueueRaw, stop: stopVoice } = voice;
  const enqueue = useCallback(
    (sentence: string) => {
      spokenRef.current = [...spokenRef.current.slice(-15), normalise(sentence)];
      enqueueRaw(sentence);
    },
    [enqueueRaw],
  );

  const prepare = useCallback(
    (markdown: string): string => (cleanText ? cleanForSpeech(markdown) : markdown),
    [cleanText],
  );

  // Hand every sentence to the voice as soon as the stream completes it.
  useEffect(() => {
    if (!chat.busy || !chat.streaming || cancelledRef.current) return;
    const cleaned = prepare(chat.streaming);
    streamRef.current = cleaned;
    for (const sentence of splitterRef.current.feed(cleaned)) enqueue(sentence);
  }, [chat.busy, chat.streaming, enqueue, prepare]);

  // The turn ended: read whatever is left, including text only the final
  // message carried, and never an older answer.
  useEffect(() => {
    if (chat.busy) {
      turnOpenRef.current = true;
      return;
    }
    if (!turnOpenRef.current) return;
    turnOpenRef.current = false;

    const splitter = splitterRef.current;
    if (!cancelledRef.current) {
      const answer = [...chat.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.createdAt >= turnStartedAtRef.current);
      const final = answer ? prepare(answer.content) : '';
      if (final) {
        if (!streamRef.current) splitter.reset();
        if (final.startsWith(streamRef.current) || !streamRef.current) {
          for (const sentence of splitter.feed(final)) enqueue(sentence);
        }
      }
      for (const sentence of splitter.flush()) enqueue(sentence);
    }
    splitter.reset();
    streamRef.current = '';
    cancelledRef.current = false;
  }, [chat.busy, chat.messages, enqueue, prepare]);

  /* ------------------------------ listening ----------------------------- */

  const onUtterance = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!body || chat.busy) return;
      // With barge-in the microphone stays open while we talk; ignore ourselves.
      if (voice.speaking && isEcho(body, spokenRef.current)) return;
      stopVoice();
      splitterRef.current.reset();
      streamRef.current = '';
      cancelledRef.current = false;
      turnStartedAtRef.current = Date.now();
      setHeard(body);
      chat.send(buildPayload(body));
    },
    [buildPayload, chat, stopVoice, voice.speaking],
  );

  const stt = useSpeechInput({
    lang,
    wakeWord: requireWake ? wakeWord : '',
    handsFree: phase === 'live' && !muted,
    onUtterance,
    // No requests pile up while one runs; while we talk the microphone stays
    // open only if the user wants to interrupt by speaking.
    paused: (voice.speaking && !bargeIn) || chat.busy,
  });

  /* ------------------------------ lifecycle ----------------------------- */

  const start = useCallback(async () => {
    voice.unlock();
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // Fullscreen is a nicety; the screen works without it.
    }
    // Go live at once; the microphone prompt must not hold the screen hostage.
    setPhase('live');
    const line = greeting();
    spokenRef.current = [normalise(line)];
    voice.speak(line);
    const granted = await mic.start();
    setMicDenied(!granted);
  }, [mic, voice]);

  const exit = useCallback(() => {
    voice.stop();
    mic.stop();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    onExit();
  }, [mic, onExit, voice]);

  /** Tap on the orb or Space: shut the voice up, or abort the thinking. */
  const interrupt = useCallback(() => {
    if (voice.speaking) {
      cancelledRef.current = true;
      voice.stop();
    } else if (chat.busy) {
      cancelledRef.current = true;
      voice.stop();
      chat.abort();
    }
  }, [chat, voice]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        exit();
      } else if (event.key === ' ' && phase === 'live') {
        event.preventDefault();
        interrupt();
      } else if (event.key === 'm' && phase === 'live') {
        setMuted((on) => !on);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exit, interrupt, phase]);

  // The control bar fades out after a few seconds without pointer activity
  // and comes back on any movement, so the captions own the bottom edge.
  useEffect(() => {
    if (phase !== 'live') return;
    let timer = 0;
    const wake = (): void => {
      setPointerActive(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPointerActive(false), 2800);
    };
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
    };
  }, [phase]);

  // Agents finishing in the background get announced, so the user can keep
  // talking while they work and still hear when a result is in.
  useEffect(() => {
    if (phase !== 'live') return;
    const seen = new Map<string, string>();
    return socket.onAssignment((assignment) => {
      const previous = seen.get(assignment.id);
      seen.set(assignment.id, assignment.status);
      if (!previous || previous === assignment.status) return;
      if (assignment.status === 'done') enqueue(assignment.agentName + ' ist fertig. Fragen Sie nach dem Ergebnis.');
      else if (assignment.status === 'failed') enqueue(assignment.agentName + ' ist gescheitert.');
    });
  }, [enqueue, phase, socket]);

  const { reset: resetChat } = chat;
  const newConversation = useCallback(() => {
    voice.stop();
    resetChat();
    setHeard('');
    setVoiceSessionId(null);
    writeStored(VOICE_SESSION, null);
  }, [resetChat, voice]);

  const toggleBargeIn = useCallback((on: boolean) => {
    setBargeIn(on);
    writeStored(BARGE_IN_PREFERENCE, on ? '1' : '0');
  }, []);

  const toggleWake = useCallback((on: boolean) => {
    setRequireWake(on);
    try {
      localStorage.setItem(WAKE_PREFERENCE, on ? '1' : '0');
    } catch {
      // Private mode; the preference lives for this visit only.
    }
  }, []);

  /* -------------------------------- view -------------------------------- */

  const state: OrbState = voice.speaking
    ? 'speaking'
    : chat.busy
      ? 'thinking'
      : phase === 'live' && stt.listening && !muted
        ? 'listening'
        : 'idle';

  const { getLevel: voiceLevel, speaking } = voice;
  const { getLevel: micLevel } = mic;
  const listening = state === 'listening';
  const getLevel = useCallback(
    () => (speaking ? voiceLevel() : listening ? micLevel() : 0),
    [listening, micLevel, speaking, voiceLevel],
  );

  const answer = useMemo(() => {
    if (chat.streaming) return prepare(chat.streaming);
    const last = [...chat.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.createdAt >= turnStartedAtRef.current);
    return last ? prepare(last.content) : '';
  }, [chat.messages, chat.streaming, prepare]);

  const status = (() => {
    if (phase === 'gate') {
      return stt.supported ? 'Tippen, um zu starten' : 'Spracherkennung braucht Chrome oder Edge.';
    }
    if (voice.speaking) return assistantName;
    if (chat.busy) {
      // Name what is actually happening instead of pretending to think.
      const current = [...chat.activity].reverse().find((item) => !item.done && item.kind !== 'memory');
      if (current?.kind === 'assignment') return current.label + ' arbeitet …';
      if (current?.kind === 'tool') return current.label + ' …';
      return 'Denke nach …';
    }
    if (muted) return 'Mikrofon aus';
    if (stt.interim) return stt.interim;
    if (!stt.supported) return 'Keine Spracherkennung in diesem Browser.';
    return requireWake && wakeWord ? '„' + wakeWord + ', …“' : 'Ich höre zu.';
  })();

  const warning = micDenied
    ? 'Kein Mikrofonzugriff: der Orb bleibt ruhig, Zuhören klappt trotzdem.'
    : stt.error ?? (voice.error ? 'Server-Stimme nicht erreichbar, Browser-Stimme übernimmt.' : null);
  // Muted or broken states stay visible; otherwise the bar follows the pointer.
  const controlsVisible = phase === 'live' && (pointerActive || muted || Boolean(warning));

  const voiceLabel =
    ENGINE_LABEL[voice.engine] +
    (voice.engine === 'edge' && config?.voice.edgeVoice
      ? ' · ' + (config.voice.edgeVoice.match(/-(\w+?)(?:Multilingual)?Neural$/)?.[1] ?? config.voice.edgeVoice)
      : '');

  return (
    <div className="fixed inset-0 z-50 select-none overflow-hidden bg-[#03040a] text-white">
      <VoiceOrb state={state} getLevel={getLevel} dim={phase === 'gate'} className="absolute inset-0" />

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between p-4 sm:p-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.28em] text-white/45">
          <AudioLinesIcon className="size-4" />
          <span>{assistantName}</span>
          <span className="text-white/25">·</span>
          <span>Sprechen</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Sprachmodus beenden"
          className="rounded-full text-white/60 hover:bg-white/10 hover:text-white"
          onClick={exit}
        >
          <XIcon />
        </Button>
      </div>

      {/* The orb is the interrupt button. */}
      {phase === 'live' ? (
        <button
          type="button"
          aria-label={voice.speaking ? 'Sprachausgabe unterbrechen' : chat.busy ? 'Abbrechen' : 'Orb'}
          className="absolute left-1/2 top-[calc(50%-6vmin)] size-[42vmin] -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          onClick={interrupt}
        />
      ) : (
        <button
          type="button"
          className="absolute inset-0 cursor-pointer focus-visible:outline-none"
          aria-label="Sprachmodus starten"
          disabled={!stt.supported}
          onClick={() => void start()}
        />
      )}

      {/* Caption block */}
      {/* Anchored below the orb's arcs, whatever the aspect ratio. */}
      <div className="pointer-events-none absolute inset-x-0 top-[calc(50%+21vmin)] bottom-10 flex flex-col items-center gap-3 overflow-hidden px-6 text-center">
        <p
          className={cn(
            'max-w-3xl text-balance font-light tracking-tight transition-all duration-300',
            phase === 'gate' ? 'text-2xl text-white/85 sm:text-3xl' : 'text-lg text-white/70 sm:text-xl',
            stt.interim && !voice.speaking && !chat.busy && 'italic text-white/60',
          )}
          aria-live="polite"
        >
          {status}
        </p>
        {phase === 'gate' && (
          <p className="text-sm text-white/40">
            Sprich einfach. Leertaste unterbricht, Esc beendet. Stimme: {voiceLabel}.
          </p>
        )}
        {phase === 'live' && (heard || answer) && (
          <div className="mt-2 max-w-2xl space-y-2">
            {heard && <p className="text-sm text-white/40">„{heard}“</p>}
            {answer && (
              <p className="line-clamp-3 text-base leading-relaxed text-white/85 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
                {answer}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Bottom controls */}
      {phase === 'live' && (
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/85 via-black/50 to-transparent p-5 pt-16 transition-opacity duration-500 sm:p-7 sm:pt-16',
            controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          aria-hidden={!controlsVisible}
        >
          {warning && (
            <p className="flex items-center gap-2 rounded-full bg-amber-500/15 px-3 py-1 text-xs text-amber-200">
              <TriangleAlertIcon className="size-3.5" />
              {warning}
            </p>
          )}
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2 py-1.5 backdrop-blur">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={muted}
              aria-label={muted ? 'Mikrofon einschalten' : 'Mikrofon stummschalten'}
              className={cn(
                'rounded-full text-white/80 hover:bg-white/10 hover:text-white',
                muted && 'bg-white/15 text-white',
              )}
              onClick={() => setMuted((on) => !on)}
            >
              {muted ? <MicOffIcon /> : <MicIcon />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Stopp"
              disabled={!voice.speaking && !chat.busy}
              className="rounded-full text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30"
              onClick={interrupt}
            >
              <SquareIcon />
            </Button>
            <div className="mx-1 h-5 w-px bg-white/15" />
            <label className="flex items-center gap-2 px-2 text-xs text-white/70">
              <Switch
                checked={requireWake}
                onCheckedChange={toggleWake}
                disabled={!wakeWord}
                aria-label="Aktivierungswort verlangen"
              />
              Aktivierungswort
            </label>
            <label className="flex items-center gap-2 px-2 text-xs text-white/70">
              <Switch checked={bargeIn} onCheckedChange={toggleBargeIn} aria-label="Reinreden erlaubt" />
              Reinreden
            </label>
            <div className="mx-1 h-5 w-px bg-white/15" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Neues Gespräch"
              className="rounded-full text-white/80 hover:bg-white/10 hover:text-white"
              onClick={newConversation}
            >
              <RotateCcwIcon />
            </Button>
            <div className="mx-1 h-5 w-px bg-white/15" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Einstellungen"
              className="rounded-full text-white/80 hover:bg-white/10 hover:text-white"
              onClick={() => {
                exit();
                void navigate('/settings');
              }}
            >
              <SettingsIcon />
            </Button>
          </div>
          <p className="text-[11px] text-white/30">
            Stimme: {voiceLabel} · Leertaste unterbricht · M schaltet das Mikrofon · Esc beendet
          </p>
        </div>
      )}
    </div>
  );
}
