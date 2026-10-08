/**
 * The Rookery TUI.
 *
 * This file owns three things and delegates everything else: the wiring from
 * the session, the turn and the prompt into one screen, the keymap, and the
 * mounting of Ink. Every component below it is a pure function of props,
 * which is what lets this package's `scripts/tui-render-check.mjs` assert on
 * real rendered output without a terminal.
 *
 * Contract with the rest of the CLI:
 *  - `startTui` is only ever called when stdin *and* stdout are TTYs.
 *    `src/index.ts` falls back to `src/repl.ts` otherwise, so pipes, CI and
 *    `echo "/exit" | rookery` keep working exactly as before.
 *  - One turn is one AbortController. Ctrl+C during a turn aborts it and
 *    returns to the prompt, and so does Ctrl+C while a spoken reply is still
 *    playing; Ctrl+C at an idle prompt leaves. Either way the provider child
 *    process is signalled, never orphaned.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Box, render, useApp, useInput } from 'ink';
import type { Key } from 'ink';
import { ThemeProvider } from '@inkjs/ui';
import type { Assistant, RookeryConfig } from '@rookery/core';
import { stopSpeaking } from '../ui/speech.js';
import { EMPTY_MODEL_CATALOGUE, modelName } from '../ui/modelNames.js';
import type { ModelCatalogue } from '../ui/modelNames.js';
import { bootTui } from './boot.js';
import type { TuiOptions } from './boot.js';
import { runSlashCommand } from './commands.js';
import type { SlashOutcome } from './commands.js';
import { Scrollback } from './components/Scrollback.js';
import { InputBox } from './components/InputBox.js';
import { SlashPalette } from './components/SlashPalette.js';
import { StatusLine } from './components/StatusLine.js';
import { QuestionView } from './components/QuestionView.js';
import { WatchView } from './components/WatchView.js';
import { inkUiTheme } from './inkTheme.js';
import { LiveRegion } from './LiveRegion.js';
import { useColumns } from './hooks/useColumns.js';
import { usePrompt } from './hooks/usePrompt.js';
import { useQuestion } from './hooks/useQuestion.js';
import { useScrollback } from './hooks/useScrollback.js';
import { useSession } from './hooks/useSession.js';
import { useSpeech } from './hooks/useSpeech.js';
import { useTicker } from './hooks/useTicker.js';
import { useTurn } from './hooks/useTurn.js';
import type { TurnResult } from './hooks/useTurn.js';
import { useWatch } from './hooks/useWatch.js';
import { glyph, ui } from './theme.js';
import { speakerName } from './types.js';
import type { Entry, SessionState } from './types.js';

/** Caret blink and spinner cadence, in milliseconds. */
const TICK_BUSY_MS = 80;
const TICK_IDLE_MS = 500;

/** While a turn spins, the caret blinks this many frames per half-cycle. */
const BUSY_CARET_FRAMES = 6;

const BUSY_HINT = 'Ctrl+C interrupts';
const IDLE_HINT = ['Enter send', 'Shift+Enter newline', '/ Commands', 'Ctrl+D exit'].join(
  ' ' + glyph.dot + ' ',
);

/* ================================= app ================================= */

export interface AppProps {
  assistant: Assistant;
  config: RookeryConfig;
  initial: SessionState;
  initialEntries?: Entry[];
  /** Model display names; without it ids are shown prettified but unresolved. */
  catalogue?: ModelCatalogue;
}

export function App({
  assistant,
  config,
  initial,
  initialEntries = [],
  catalogue = EMPTY_MODEL_CATALOGUE,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();

  const { session, sessionRef, setSession, onSession, onQuota, recordTurn } = useSession(
    assistant,
    initial,
  );
  const { entries, generation, append, warn, clear, nextId } = useScrollback(initialEntries);
  const [watch, setWatch] = useState<{ assignmentId: string } | null>(null);
  const columns = useColumns();
  const prompt = usePrompt();

  const warnVoice = useCallback((detail: string) => warn('Voice: ' + detail), [warn]);
  const { say, stop: stopVoice, isSpeaking } = useSpeech(config.voice, warnVoice);

  const onFinish = useCallback(
    (result: TurnResult) => {
      const { voice } = sessionRef.current;
      recordTurn(result.usage);
      if (voice && !result.aborted && result.text.trim()) say(result.text);
    },
    [recordTurn, say, sessionRef],
  );

  const turn = useTurn({ assistant, onCommit: append, onSession, onQuota, onFinish });
  // Callbacks that outlive a render start and abort the newest turn runner.
  const turnRef = useRef(turn);
  turnRef.current = turn;

  const { frame, now } = useTicker(turn.busy ? TICK_BUSY_MS : TICK_IDLE_MS);

  // The live watch of a running assignment. Mounted for the app's whole life,
  // but it only consumes while a watch is actually open.
  const watchFeed = useWatch(watch ? assistant : null, watch?.assignmentId ?? '');

  const warnAnsweredElsewhere = useCallback(
    () => warn('That question was already answered elsewhere'),
    [warn],
  );
  const {
    question,
    answer: answerQuestion,
    skip: skipQuestion,
  } = useQuestion(assistant, turn.question, watch !== null, warnAnsweredElsewhere);

  /* ------------------------------ leaving ----------------------------- */

  const interrupt = useCallback(() => {
    turnRef.current.abort();
    stopVoice();
  }, [stopVoice]);

  const leave = useCallback(() => {
    interrupt();
    exit();
  }, [exit, interrupt]);

  /* ------------------------------ actions ----------------------------- */

  const applyOutcome = useCallback(
    (outcome: SlashOutcome) => {
      if (outcome.clear) clear();
      if (outcome.patch) setSession((current) => ({ ...current, ...outcome.patch }));
      if (outcome.entries) append(outcome.entries);
      if (outcome.watch) setWatch(outcome.watch);
      if (outcome.run) {
        turnRef.current.start(outcome.run, { ...sessionRef.current, ...outcome.patch });
      }
      if (outcome.exit) leave();
    },
    [append, clear, leave, sessionRef, setSession],
  );

  const runSlash = useCallback(
    async (input: string) => {
      try {
        applyOutcome(
          await runSlashCommand(input, {
            assistant,
            session: sessionRef.current,
            nextId,
            catalogue,
          }),
        );
      } catch (error) {
        append([
          {
            kind: 'notice',
            id: nextId(),
            lines: [{ text: glyph.fail + ' ' + (error as Error).message, color: ui.danger }],
          },
        ]);
      }
    },
    [append, applyOutcome, assistant, catalogue, nextId, sessionRef],
  );

  const submit = (): void => {
    const text = prompt.draft.trim();
    if (!text) return;

    if (turn.busy) {
      warn('A turn is already running — Ctrl+C interrupts it');
      return;
    }

    prompt.commit();

    if (text.startsWith('/')) {
      void runSlash(text);
      return;
    }

    append([{ kind: 'user', id: nextId(), text }]);
    turnRef.current.start({ kind: 'chat', text }, sessionRef.current);
  };

  /* ------------------------------ keymap ------------------------------ */

  // The question owns the space the input box normally has. Arrows, Space and
  // Enter belong to the picker underneath, which reads the keyboard itself, so
  // they are deliberately not handled here; everything else is held back so
  // typing cannot reach a prompt that is not on screen.
  const handleQuestionKey = (input: string, key: Key): void => {
    if (key.escape) skipQuestion();
    // Interrupting the turn ends the question with it: core cancels the
    // pending ask off the turn's own abort signal.
    else if (key.ctrl && input === 'c') interrupt();
    else if (key.ctrl && input === 'd') leave();
  };

  // The watch owns the space below the scrollback: Esc and Ctrl+C leave only
  // the watch, Ctrl+D still leaves the app, everything else is held back so
  // typing cannot reach a prompt that is not on screen.
  const handleWatchKey = (input: string, key: Key): void => {
    if (key.escape || (key.ctrl && input === 'c')) setWatch(null);
    else if (key.ctrl && input === 'd') leave();
  };

  const handlePromptKey = (input: string, key: Key): void => {
    if (key.ctrl && input === 'c') {
      // Interrupt, don't leave: a turn in flight, or a spoken reply that is
      // still playing, stops there and the prompt comes back.
      if (turn.busy || isSpeaking()) interrupt();
      else leave();
      return;
    }
    if (key.ctrl && input === 'd') {
      leave();
      return;
    }
    if (key.ctrl && input === 'l') {
      void runSlash('/clear');
      return;
    }
    if (key.return) {
      if (prompt.pressEnter(key) === 'submit') submit();
      return;
    }
    prompt.edit(input, key);
  };

  useInput((input, key) => {
    if (question) handleQuestionKey(input, key);
    else if (watch) handleWatchKey(input, key);
    else handlePromptKey(input, key);
  });

  /* ------------------------------ render ------------------------------ */

  const caretVisible = Math.floor(frame / (turn.busy ? BUSY_CARET_FRAMES : 1)) % 2 === 0;

  const status = watch
    ? {
        busy: true,
        elapsedMs: Math.max(0, now - (watchFeed.state.startedAt || now)),
        label: 'watching',
      }
    : {
        busy: turn.busy,
        elapsedMs: turn.startedAt === null ? 0 : Math.max(0, now - turn.startedAt),
        // A blocked turn is not thinking. Saying so is the difference
        // between a slow answer and one that will never come on its own.
        label: question ? 'waiting for you' : turn.label,
      };

  const renderInputArea = (): React.JSX.Element | null => {
    if (watch) return null;
    // An open question takes the input box's place, the way the watch takes
    // the live region's: there is nothing useful to type at a turn that is
    // waiting for exactly one of these answers.
    if (question) return <QuestionView question={question} now={now} onAnswer={answerQuestion} />;
    const hint = prompt.paletteOpen ? '' : turn.busy ? BUSY_HINT : IDLE_HINT;
    return (
      <>
        <InputBox
          value={prompt.draft}
          cursor={prompt.cursor}
          busy={turn.busy}
          placeholder="Ask anything, or / for commands"
          hint={hint}
          caretVisible={caretVisible}
        />
        {prompt.paletteOpen ? (
          <SlashPalette matches={prompt.slash.matches} selected={prompt.slash.selected} />
        ) : null}
      </>
    );
  };

  return (
    <Box flexDirection="column" width="100%">
      <Scrollback key={generation} entries={entries} />

      {watch ? (
        // While a watch is open it takes the place of both the live region and
        // the input: the scrollback and the status line stay.
        <WatchView assignmentId={watch.assignmentId} feed={watchFeed} verbose={session.verbose} />
      ) : (
        <LiveRegion
          turn={turn}
          session={session}
          frame={frame}
          now={now}
          caretVisible={caretVisible}
        />
      )}

      <Box marginTop={1} flexDirection="column">
        <SessionStatusLine
          session={session}
          model={modelName(catalogue, session.provider, session.model)}
          columns={columns}
          {...status}
        />
        {renderInputArea()}
      </Box>
    </Box>
  );
}

interface SessionStatusLineProps {
  session: SessionState;
  /** The model's catalogue display name, or the account default when none is pinned. */
  model: string | undefined;
  columns: number;
  busy: boolean;
  elapsedMs: number;
  label: string;
}

function SessionStatusLine({
  session,
  model,
  columns,
  busy,
  elapsedMs,
  label,
}: SessionStatusLineProps): React.JSX.Element {
  return (
    <StatusLine
      assistantName={speakerName(session)}
      {...(session.agentTitle ? { counterpartTitle: session.agentTitle } : {})}
      provider={session.provider}
      {...(model ? { model } : {})}
      {...(session.effort ? { effort: session.effort } : {})}
      {...(session.contextTokens !== undefined ? { contextTokens: session.contextTokens } : {})}
      {...(session.contextWindow !== undefined ? { contextWindow: session.contextWindow } : {})}
      usage={session.usage}
      {...(session.quota ? { quota: session.quota } : {})}
      permission={session.permission}
      title={session.title}
      {...(session.projectName ? { project: session.projectName } : {})}
      {...(session.sessionId ? { sessionId: session.sessionId } : {})}
      busy={busy}
      elapsedMs={elapsedMs}
      label={label}
      voice={session.voice}
      verbose={session.verbose}
      columns={columns}
    />
  );
}

/* ================================ start ================================ */

/**
 * Mount the TUI. Only call this when both stdin and stdout are TTYs -
 * Ink needs raw mode on stdin and cursor control on stdout.
 */
export async function startTui(options: TuiOptions = {}): Promise<number> {
  const { assistant, config, state, catalogue, initialEntries } = await bootTui(options);

  const instance = render(
    <ThemeProvider theme={inkUiTheme}>
      <App
        assistant={assistant}
        config={config}
        initial={state}
        initialEntries={initialEntries}
        catalogue={catalogue}
      />
    </ThemeProvider>,
    {
      stdout: process.stdout,
      stdin: process.stdin,
      // Ctrl+C is ours: at an idle prompt it exits, during a turn it aborts.
      exitOnCtrlC: false,
      patchConsole: true,
    },
  );

  try {
    await instance.waitUntilExit();
  } finally {
    stopSpeaking();
    assistant.close();
  }

  process.stdout.write('\n');
  return 0;
}
