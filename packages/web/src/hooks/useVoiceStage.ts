import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError } from '@/lib/api';
import { readStored, writeStored } from '@/lib/storage';
import { cleanForSpeech, SentenceSplitter } from '@/lib/speech';
import { useConnection, useSessionsState } from '@/providers/rookery-provider';

import { useChat, type ChatState } from './useChat';
import type { VoiceOutput } from './useVoiceOutput';

/**
 * The parts of the hands-free screen that are not drawing: the conversation
 * it keeps, the reply it reads aloud, and the signals that wake its controls.
 */

const VOICE_SESSION_KEY = 'rookery.voice.sessionId';

/** How many sentences the voice remembers saying, to recognise its own echo. */
const ECHO_MEMORY = 16;
/** Share of a heard utterance's words that must come from our own speech to call it an echo. */
const ECHO_WORD_SHARE = 0.6;
/** Words this short say nothing about who spoke them. */
const MIN_ECHO_WORD_LENGTH = 3;
const CONTROLS_IDLE_MS = 2800;

/** A preference that survives a reload as `1` / `0`. */
export function useStoredToggle(key: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readStored(key) === '1');
  const set = useCallback(
    (next: boolean) => {
      setOn(next);
      writeStored(key, next ? '1' : '0');
    },
    [key],
  );
  return [on, set];
}

/**
 * Hands-free has its own conversation with the assistant, kept apart from
 * the text chats. It survives leaving the screen; `startOver` forgets it.
 * `requestedSessionId` (`/voice?session=<id>`) re-enters an earlier voice
 * conversation from the list.
 */
export function useVoiceConversation(requestedSessionId: string | null) {
  const { socket } = useConnection();
  const { refresh } = useSessionsState();
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (requestedSessionId) writeStored(VOICE_SESSION_KEY, requestedSessionId);
    return requestedSessionId ?? readStored(VOICE_SESSION_KEY);
  });

  // The list refreshes through the provider; read it through a ref so the
  // callbacks below keep their identity across a refetch.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const onSession = useCallback((id: string) => {
    setSessionId(id);
    writeStored(VOICE_SESSION_KEY, id);
    void api
      .patchSession(id, { title: 'Voice conversation · ' + new Date().toLocaleDateString('en-GB') })
      // A title that did not stick leaves the default one; the list refreshes either way.
      .catch(() => undefined)
      .then(() => void refreshRef.current());
  }, []);
  const onSettled = useCallback(() => void refreshRef.current(), []);
  const chat = useChat(socket, sessionId, onSession, onSettled);

  const forgetSession = useCallback(() => {
    setSessionId(null);
    writeStored(VOICE_SESSION_KEY, null);
  }, []);

  // A remembered conversation the server no longer has must not be reused;
  // any other failure (a dropped connection) is no reason to forget it.
  useEffect(() => {
    if (!sessionId) return;
    void api.session(sessionId).catch((caught: unknown) => {
      if (caught instanceof ApiError && caught.status === 404) forgetSession();
    });
  }, [sessionId, forgetSession]);

  return { chat, forgetSession };
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
  const isSpoken = (words: string): boolean => corpus.includes(' ' + words + ' ');
  if (isSpoken(text)) return true;
  const words = text.split(' ').filter((word) => word.length >= MIN_ECHO_WORD_LENGTH);
  if (words.length < 2) return false;
  return words.filter(isSpoken).length / words.length >= ECHO_WORD_SHARE;
}

/**
 * Reads the assistant's answer aloud while it streams, sentence by sentence,
 * and keeps what was said so the microphone can tell it from the user.
 */
export function useSpokenReply(chat: ChatState, voice: VoiceOutput, cleanText: boolean) {
  const { enqueue: enqueueVoice, stop: stopVoice, speak: speakVoice, speaking } = voice;
  const [splitter] = useState(() => new SentenceSplitter());
  /** Cleaned text of the stream so far, to know what has been handed to the voice. */
  const streamRef = useRef('');
  const turnStartedAtRef = useRef(0);
  const turnOpenRef = useRef(false);
  const cancelledRef = useRef(false);
  /** What the voice has said lately, to recognise its own echo in the microphone. */
  const spokenRef = useRef<string[]>([]);

  const enqueue = useCallback(
    (sentence: string) => {
      spokenRef.current = [...spokenRef.current.slice(1 - ECHO_MEMORY), normalise(sentence)];
      enqueueVoice(sentence);
    },
    [enqueueVoice],
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
    for (const sentence of splitter.feed(cleaned)) enqueue(sentence);
  }, [chat.busy, chat.streaming, enqueue, prepare, splitter]);

  // The turn ended: read whatever is left, including text only the final
  // message carried, and never an older answer.
  useEffect(() => {
    if (chat.busy) {
      turnOpenRef.current = true;
      return;
    }
    if (!turnOpenRef.current) return;
    turnOpenRef.current = false;

    if (!cancelledRef.current) {
      const final = lastAnswerSince(chat.messages, turnStartedAtRef.current, prepare);
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
  }, [chat.busy, chat.messages, enqueue, prepare, splitter]);

  /** What the screen shows under the caption: the answer being spoken, or the last one. */
  const answer = useMemo(
    () => (chat.streaming ? prepare(chat.streaming) : lastAnswerSince(chat.messages, turnStartedAtRef.current, prepare)),
    [chat.messages, chat.streaming, prepare],
  );

  /** A new utterance cuts the voice off and opens the next turn. */
  const beginTurn = useCallback(() => {
    stopVoice();
    splitter.reset();
    streamRef.current = '';
    cancelledRef.current = false;
    turnStartedAtRef.current = Date.now();
  }, [splitter, stopVoice]);

  /** The rest of this reply is not wanted: neither the stream nor the final text gets read. */
  const cancelReply = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  const greet = useCallback(
    (line: string) => {
      spokenRef.current = [normalise(line)];
      speakVoice(line);
    },
    [speakVoice],
  );

  const isOwnEcho = useCallback(
    (heard: string) => speaking && isEcho(heard, spokenRef.current),
    [speaking],
  );

  return { answer, enqueue, beginTurn, cancelReply, greet, isOwnEcho };
}

function lastAnswerSince(
  messages: ChatState['messages'],
  since: number,
  prepare: (markdown: string) => string,
): string {
  const last = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.createdAt >= since);
  return last ? prepare(last.content) : '';
}

/**
 * Whether the pointer or keyboard was used in the last few seconds, while
 * `active`. A key press counts too: someone who reaches the bar with Tab has
 * no pointer to move, and the controls have to be there before the focus
 * ring lands on them.
 */
export function useRecentActivity(active: boolean): boolean {
  const [recent, setRecent] = useState(true);

  useEffect(() => {
    if (!active) return;
    let timer = 0;
    const wake = (): void => {
      setRecent(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRecent(false), CONTROLS_IDLE_MS);
    };
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [active]);

  return recent;
}

/**
 * Agents finishing in the background get announced, so the user can keep
 * talking while they work and still hear when a result is in.
 */
export function useAssignmentAnnouncements(active: boolean, announce: (sentence: string) => void): void {
  const { socket } = useConnection();

  useEffect(() => {
    if (!active) return;
    const seen = new Map<string, string>();
    return socket.onAssignment((assignment) => {
      const previous = seen.get(assignment.id);
      seen.set(assignment.id, assignment.status);
      if (!previous || previous === assignment.status) return;
      if (assignment.status === 'done') {
        announce(assignment.agentName + ' has finished. Ask for the result.');
      } else if (assignment.status === 'failed') {
        announce(assignment.agentName + ' has failed.');
      }
    });
  }, [active, announce, socket]);
}
