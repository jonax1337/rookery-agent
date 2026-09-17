/**
 * The Rookery TUI.
 *
 * This file owns three things and delegates everything else: the session and
 * scrollback state, the wiring from `AgentEvent`s to that state (via
 * `useTurn`), and the keymap. Every component below it is a pure function of
 * props, which is what lets this package's `scripts/tui-render-check.mjs`
 * assert on real rendered output without a terminal.
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, render, useApp, useInput } from 'ink';
import { ThemeProvider } from '@inkjs/ui';
import { Assistant, loadConfig } from '@rookery/core';
import type { ProviderQuota, RookeryConfig, TurnUsage } from '@rookery/core';
import {
  parseEffort,
  parsePermission,
  parseProvider,
  resolveAgent,
  resolveProject,
  resolveSession,
} from '../commands/shared.js';
import { speak, stopSpeaking } from '../ui/speech.js';
import {
  EMPTY_MODEL_CATALOGUE,
  loadModelCatalogue,
  modelName,
} from '../ui/modelNames.js';
import type { ModelCatalogue } from '../ui/modelNames.js';
import { runSlashCommand } from './commands.js';
import { historyEntries } from './history.js';
import { Scrollback } from './components/Scrollback.js';
import { AssistantMessage } from './components/Message.js';
import { ActivityLine } from './components/ActivityLine.js';
import { ToolGroup } from './components/ToolGroup.js';
import { InputBox } from './components/InputBox.js';
import { SlashPalette } from './components/SlashPalette.js';
import { StatusLine } from './components/StatusLine.js';
import { AssignmentsView } from './components/AssignmentsView.js';
import { QuestionView } from './components/QuestionView.js';
import { WatchView } from './components/WatchView.js';
import { inkUiTheme } from './inkTheme.js';
import { useColumns } from './hooks/useColumns.js';
import { useHistory } from './hooks/useHistory.js';
import { useSlash } from './hooks/useSlash.js';
import { useTurn } from './hooks/useTurn.js';
import { useWatch } from './hooks/useWatch.js';
import { glyph, ui } from './theme.js';
import { EMPTY_USAGE, addUsage, blockSegments, thinkingLines } from './types.js';
import type { BannerState, Entry, SessionState } from './types.js';

export interface TuiOptions {
  session?: string;
  provider?: string;
  model?: string;
  effort?: string;
  permission?: string;
  /** Project name or id this conversation is about. */
  project?: string;
  /** Agent slug or name to talk to instead of the assistant. */
  agent?: string;
  voice?: boolean;
  verbose?: boolean;
}

/** Caret blink and spinner cadence, in milliseconds. */
const TICK_BUSY_MS = 80;
const TICK_IDLE_MS = 500;

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

  const [session, setSession] = useState<SessionState>(initial);
  const [entries, setEntries] = useState<Entry[]>(initialEntries);
  const [generation, setGeneration] = useState(0);
  const [draft, setDraft] = useState('');
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [watch, setWatch] = useState<{ assignmentId: string } | null>(null);
  // The question this terminal has already acted on. Core closes the card by
  // streaming `question-closed`, but the surface must go the instant the key
  // is pressed - waiting a round trip, however short, invites a second answer.
  const [settled, setSettled] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const columns = useColumns();
  const ids = useRef(0);
  const nextId = useCallback(() => 'x' + (ids.current += 1), []);

  // Callbacks handed to the turn runner outlive any single render, so the
  // current session is read from a ref rather than captured.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Speech outlives its turn: a reply is only spoken once the turn has ended,
  // so it gets an AbortController of its own. While one is set here, Ctrl+C
  // stops the voice instead of leaving, exactly as in the REPL.
  const speechRef = useRef<AbortController | null>(null);

  const history = useHistory();
  const slash = useSlash(draft, cursor);
  const paletteOpen = slash.open && !dismissed;

  const append = useCallback((added: Entry[]) => {
    if (added.length) setEntries((current) => [...current, ...added]);
  }, []);

  const onSession = useCallback(
    (sessionId: string) => {
      setSession((current) => {
        const title = assistant.getSession(sessionId)?.title ?? current.title;
        return { ...current, sessionId, title };
      });
    },
    [assistant],
  );

  const onQuota = useCallback((quota: ProviderQuota) => {
    setSession((current) => ({ ...current, quota }));
  }, []);

  const onFinish = useCallback(
    (result: { text: string; aborted: boolean; usage?: TurnUsage }) => {
      const current = sessionRef.current;
      if (current.sessionId) {
        const stored = assistant.getSession(current.sessionId);
        if (stored) setSession((state) => ({ ...state, title: stored.title }));
      }
      if (result.usage) {
        const usage = result.usage;
        setSession((state) => ({
          ...state,
          usage: addUsage(state.usage, usage),
          ...(usage.contextTokens !== undefined ? { contextTokens: usage.contextTokens } : {}),
          ...(usage.contextWindow !== undefined ? { contextWindow: usage.contextWindow } : {}),
        }));
      }
      if (!current.voice || result.aborted || !result.text.trim()) return;
      const speech = new AbortController();
      speechRef.current = speech;
      void speak(result.text, {
        lang: config.voice.lang,
        rate: config.voice.rate,
        voiceName: config.voice.voiceName,
        signal: speech.signal,
      }).then((spoken) => {
        // leave() or a newer reply replaced this controller; its outcome
        // no longer belongs to anyone.
        if (speechRef.current !== speech) return;
        speechRef.current = null;
        if (!spoken.ok && spoken.detail !== 'aborted') {
          append([
            { kind: 'activity', id: nextId(), icon: glyph.warn, text: 'Voice: ' + spoken.detail },
          ]);
        }
      });
    },
    [append, assistant, config.voice.lang, config.voice.rate, config.voice.voiceName, nextId],
  );

  const turn = useTurn({ assistant, onCommit: append, onSession, onQuota, onFinish });
  const turnRef = useRef(turn);
  turnRef.current = turn;

  // The live watch of a running assignment. Mounted for the app's whole life,
  // but it only consumes while a watch is actually open.
  const watchFeed = useWatch(watch ? assistant : null, watch?.assignmentId ?? '');

  /* ------------------------------ ticker ------------------------------ */

  useEffect(() => {
    const interval = turn.busy ? TICK_BUSY_MS : TICK_IDLE_MS;
    const timer = setInterval(() => {
      setFrame((value) => (value + 1) % 100_000);
      setNow(Date.now());
    }, interval);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [turn.busy]);

  /* ------------------------------ leaving ----------------------------- */

  const leave = useCallback(() => {
    turnRef.current.abort();
    speechRef.current?.abort();
    stopSpeaking();
    exit();
  }, [exit]);

  /* ------------------------------ actions ----------------------------- */

  const setBuffer = useCallback((value: string, caret: number) => {
    setDraft(value);
    setCursor(Math.max(0, Math.min(caret, value.length)));
    setDismissed(false);
  }, []);

  const handleSlash = useCallback(
    async (input: string) => {
      try {
        const outcome = await runSlashCommand(input, {
          assistant,
          session: sessionRef.current,
          nextId,
          catalogue,
        });
        if (outcome.clear) {
          setEntries([]);
          setGeneration((value) => value + 1);
          // Wipe the screen and the scrollback the way `clear` does, so the
          // <Static> lines Ink already committed do not linger above us.
          process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
        }
        if (outcome.patch) setSession((current) => ({ ...current, ...outcome.patch }));
        if (outcome.entries) append(outcome.entries);
        if (outcome.watch) setWatch(outcome.watch);
        if (outcome.run) {
          turnRef.current.start(outcome.run, { ...sessionRef.current, ...outcome.patch });
        }
        if (outcome.exit) leave();
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
    [append, assistant, leave, nextId],
  );

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;

    if (turn.busy) {
      append([
        {
          kind: 'activity',
          id: nextId(),
          icon: glyph.warn,
          text: 'A turn is already running — Ctrl+C interrupts it',
        },
      ]);
      return;
    }

    history.push(draft);
    setBuffer('', 0);

    if (text.startsWith('/')) {
      void handleSlash(text);
      return;
    }

    append([{ kind: 'user', id: nextId(), text }]);
    turnRef.current.start({ kind: 'chat', text }, sessionRef.current);
  }, [append, draft, handleSlash, history, nextId, setBuffer, turn.busy]);

  const complete = useCallback(() => {
    const command = slash.active;
    if (!command) return;
    // Commands that take arguments get a trailing space so typing continues.
    const value = command.name + (command.args ? ' ' : '');
    setBuffer(value, value.length);
  }, [setBuffer, slash.active]);

  /* ----------------------------- questions ---------------------------- */

  /*
   * The CLI holds the assistant in its own process, so answering is a direct
   * call into the registry the waiting tool is parked on - no socket, no
   * route, nothing that could be offline while the turn is not.
   *
   * A watch already owns the screen below the scrollback, so a question that
   * lands while one is open waits behind it: Esc closes the watch and the
   * card is there, still counting down.
   */
  const question = !watch && turn.question && turn.question.id !== settled ? turn.question : null;

  const closeQuestion = useCallback(
    (act: (id: string) => boolean) => {
      const open = turnRef.current.question;
      if (!open) return;
      setSettled(open.id);
      // The registry says whether the id was still open. A `false` means the
      // question was settled somewhere else - the phone, a timeout - between
      // the keystroke and this call. Nothing is broken: the turn already has
      // its answer, so the card goes away and one dim line says why.
      if (act(open.id)) return;
      append([
        {
          kind: 'activity',
          id: nextId(),
          icon: glyph.warn,
          text: 'That question was already answered elsewhere',
        },
      ]);
    },
    [append, nextId],
  );

  const answerQuestion = useCallback(
    (selected: number[]) => {
      closeQuestion((id) =>
        assistant.questions.answer(id, { selected, source: 'tui', at: Date.now() }),
      );
    },
    [assistant, closeQuestion],
  );

  const skipQuestion = useCallback(() => {
    closeQuestion((id) => assistant.questions.cancel(id, 'cancelled'));
  }, [assistant, closeQuestion]);

  /* ------------------------------ keymap ------------------------------ */

  useInput((input, key) => {
    if (question) {
      // The question owns the space the input box normally has. Arrows, Space
      // and Enter belong to the picker underneath, which reads the keyboard
      // itself, so they are deliberately not handled here; everything else is
      // held back so typing cannot reach a prompt that is not on screen.
      if (key.escape) {
        skipQuestion();
        return;
      }
      if (key.ctrl && input === 'c') {
        // Interrupting the turn ends the question with it: core cancels the
        // pending ask off the turn's own abort signal.
        turnRef.current.abort();
        speechRef.current?.abort();
        stopSpeaking();
        return;
      }
      if (key.ctrl && input === 'd') {
        leave();
        return;
      }
      return;
    }

    if (watch) {
      // The watch owns the space below the scrollback: Esc and Ctrl+C leave
      // only the watch, Ctrl+D still leaves the app, everything else is held
      // back so typing cannot reach a prompt that is not on screen.
      if (key.escape || (key.ctrl && input === 'c')) {
        setWatch(null);
        return;
      }
      if (key.ctrl && input === 'd') {
        leave();
        return;
      }
      return;
    }

    if (key.ctrl && input === 'c') {
      // Interrupt, don't leave: a turn in flight, or a spoken reply that is
      // still playing, stops there and the prompt comes back.
      if (turn.busy || speechRef.current) {
        turnRef.current.abort();
        speechRef.current?.abort();
        stopSpeaking();
        return;
      }
      leave();
      return;
    }

    if (key.ctrl && input === 'd') {
      leave();
      return;
    }

    if (key.escape) {
      setDismissed(true);
      return;
    }

    if (key.tab) {
      if (paletteOpen) complete();
      return;
    }

    if (key.return) {
      // Shift+Enter / Alt+Enter, where the terminal reports them, insert a
      // newline. A trailing backslash is the portable equivalent for the
      // many terminals that send a bare CR for both.
      if (key.shift || key.meta) {
        insert(draft, cursor, '\n', setBuffer);
        return;
      }
      if (draft.slice(0, cursor).endsWith('\\')) {
        const next = draft.slice(0, cursor - 1) + '\n' + draft.slice(cursor);
        setBuffer(next, cursor);
        return;
      }
      if (paletteOpen && slash.active && slash.active.name !== draft.trim()) {
        complete();
        return;
      }
      submit();
      return;
    }

    // Ctrl+J is the other portable "newline without sending".
    if (input === '\n' || (key.ctrl && input === 'j')) {
      insert(draft, cursor, '\n', setBuffer);
      return;
    }

    if (key.upArrow || key.downArrow) {
      if (paletteOpen) {
        slash.move(key.upArrow ? -1 : 1);
        return;
      }
      const line = history.walk(key.upArrow ? -1 : 1, draft);
      if (line !== null) {
        setDraft(line);
        setCursor(line.length);
      }
      return;
    }

    if (key.leftArrow) {
      setCursor((value) => Math.max(0, value - (key.ctrl || key.meta ? wordLeft(draft, value) : 1)));
      return;
    }
    if (key.rightArrow) {
      setCursor((value) =>
        Math.min(draft.length, value + (key.ctrl || key.meta ? wordRight(draft, value) : 1)),
      );
      return;
    }
    if (key.home || (key.ctrl && input === 'a')) {
      setCursor(0);
      return;
    }
    if (key.end || (key.ctrl && input === 'e')) {
      setCursor(draft.length);
      return;
    }

    // Ctrl+W and Alt+Backspace both delete the word to the left.
    if ((key.ctrl && input === 'w') || ((key.meta || key.ctrl) && (key.backspace || key.delete))) {
      const span = wordLeft(draft, cursor);
      if (!span) return;
      setBuffer(draft.slice(0, cursor - span) + draft.slice(cursor), cursor - span);
      history.reset();
      return;
    }

    if (key.ctrl && input === 'u') {
      setBuffer(draft.slice(cursor), 0);
      history.reset();
      return;
    }
    if (key.ctrl && input === 'k') {
      setBuffer(draft.slice(0, cursor), cursor);
      history.reset();
      return;
    }
    if (key.ctrl && input === 'l') {
      void handleSlash('/clear');
      return;
    }

    if (key.backspace || input === '\x7F') {
      if (!cursor) return;
      setBuffer(draft.slice(0, cursor - 1) + draft.slice(cursor), cursor - 1);
      history.reset();
      return;
    }
    if (key.delete) {
      if (cursor >= draft.length) return;
      setBuffer(draft.slice(0, cursor) + draft.slice(cursor + 1), cursor);
      history.reset();
      return;
    }

    // Everything else is literal text, including pasted multi-line blocks.
    if (input && !key.ctrl && !key.meta) {
      insert(draft, cursor, input.replace(/\r/gu, '\n'), setBuffer);
      history.reset();
    }
  });

  /* ------------------------------ render ------------------------------ */

  const hint = useMemo(() => {
    if (paletteOpen) return '';
    if (turn.busy) return 'Ctrl+C interrupts';
    return (
      'Enter send ' + glyph.dot + ' Shift+Enter newline ' + glyph.dot +
      ' / Commands ' + glyph.dot + ' Ctrl+D exit'
    );
  }, [paletteOpen, turn.busy]);

  // The live region walks exactly the `blockSegments` the committed scrollback
  // will be built from, so a finished turn never visibly re-flows. The
  // accumulator hands out a fresh array per read, so this recomputes on every
  // flush by design - the walk is cheap and the data is always current.
  const segments = blockSegments(turn.blocks.blocks, {
    streaming: turn.busy,
    toolTimes: turn.blocks.toolTimes,
  });

  // What the interface calls the model: its catalogue display name, with the
  // account's own default standing in when none is pinned.
  const modelDisplay = useMemo(
    () => modelName(catalogue, session.provider, session.model),
    [catalogue, session.provider, session.model],
  );

  const elapsedMs = turn.startedAt === null ? 0 : Math.max(0, now - turn.startedAt);
  const caretVisible = Math.floor(frame / (turn.busy ? 6 : 1)) % 2 === 0;

  const watchElapsedMs = watch
    ? Math.max(0, now - (watchFeed.state.startedAt || now))
    : 0;

  return (
    <Box flexDirection="column" width="100%">
      <Scrollback key={generation} entries={entries} />

      {watch ? (
        /* While a watch is open it takes the place of both the live region
         * and the input: the scrollback and the status line stay. */
        <WatchView
          assignmentId={watch.assignmentId}
          feed={watchFeed}
          verbose={session.verbose}
        />
      ) : (
      /* The live region: only this repaints while a turn streams. */
      <Box flexDirection="column">
        {segments.map((segment, index) => {
          if (segment.kind === 'tools') {
            return <ToolGroup key={'g' + index} calls={segment.calls} frame={frame} now={now} />;
          }
          if (segment.kind === 'note') {
            return (
              <ActivityLine
                key={segment.note.id}
                icon={segment.note.icon}
                text={segment.note.text}
                {...(segment.note.color ? { color: segment.note.color } : {})}
              />
            );
          }
          if (segment.kind === 'thinking') {
            if (!session.verbose) return null;
            return (
              <Box key={'y' + index} flexDirection="column">
                {thinkingLines(segment.text).map((line, at) => (
                  <ActivityLine key={at} icon={glyph.thinking} text={line} />
                ))}
              </Box>
            );
          }
          return (
            <AssistantMessage
              key={'m' + index}
              text={segment.text}
              speaker={session.counterpart || session.assistantName}
              provider={session.provider}
              streaming={segment.streaming}
              cursorVisible={caretVisible}
            />
          );
        })}

        {turn.assignments ? (
          <AssignmentsView state={turn.assignments} frame={frame} now={now} />
        ) : null}
      </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <StatusLine
          assistantName={session.counterpart || session.assistantName}
          {...(session.agentTitle ? { counterpartTitle: session.agentTitle } : {})}
          provider={session.provider}
          {...(modelDisplay ? { model: modelDisplay } : {})}
          {...(session.effort ? { effort: session.effort } : {})}
          {...(session.contextTokens !== undefined ? { contextTokens: session.contextTokens } : {})}
          {...(session.contextWindow !== undefined ? { contextWindow: session.contextWindow } : {})}
          usage={session.usage}
          {...(session.quota ? { quota: session.quota } : {})}
          permission={session.permission}
          title={session.title}
          {...(session.projectName ? { project: session.projectName } : {})}
          {...(session.sessionId ? { sessionId: session.sessionId } : {})}
          busy={Boolean(watch) || turn.busy}
          elapsedMs={watch ? watchElapsedMs : elapsedMs}
          // A blocked turn is not thinking. Saying so is the difference
          // between a slow answer and one that will never come on its own.
          label={watch ? 'watching' : question ? 'waiting for you' : turn.label}
          voice={session.voice}
          verbose={session.verbose}
          columns={columns}
        />
        {watch ? null : question ? (
          /* An open question takes the input box's place, the way the watch
           * takes the live region's: there is nothing useful to type at a
           * turn that is waiting for exactly one of these answers. */
          <QuestionView question={question} now={now} onAnswer={answerQuestion} />
        ) : (
          <>
            <InputBox
              value={draft}
              cursor={cursor}
              busy={turn.busy}
              placeholder="Ask anything, or / for commands"
              hint={hint}
              caretVisible={caretVisible}
            />
            {paletteOpen ? <SlashPalette matches={slash.matches} selected={slash.selected} /> : null}
          </>
        )}
      </Box>
    </Box>
  );
}

/* ------------------------------- editing ------------------------------- */

function insert(
  value: string,
  cursor: number,
  text: string,
  setBuffer: (next: string, caret: number) => void,
): void {
  setBuffer(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
}

/** How many characters back the previous word boundary is. */
export function wordLeft(value: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && /\s/u.test(value[index - 1] ?? '')) index -= 1;
  while (index > 0 && !/\s/u.test(value[index - 1] ?? '')) index -= 1;
  return cursor - index;
}

/** How many characters forward the next word boundary is. */
export function wordRight(value: string, cursor: number): number {
  let index = cursor;
  while (index < value.length && /\s/u.test(value[index] ?? '')) index += 1;
  while (index < value.length && !/\s/u.test(value[index] ?? '')) index += 1;
  return index - cursor;
}

/* ================================ start ================================ */

/**
 * Mount the TUI. Only call this when both stdin and stdout are TTYs -
 * Ink needs raw mode on stdin and cursor control on stdout.
 */
export async function startTui(options: TuiOptions = {}): Promise<number> {
  const config = loadConfig();
  const assistant = new Assistant();

  const assistantName = config.assistantName || 'Rookery';

  const state: SessionState = {
    sessionId: options.session,
    title: 'New conversation',
    assistantName,
    counterpart: assistantName,
    provider: parseProvider(options.provider) ?? config.defaultProvider,
    model: options.model ?? config.defaultModel,
    effort: parseEffort(options.effort) ?? config.defaultEffort,
    permission: parsePermission(options.permission) ?? config.defaultPermission,
    usage: EMPTY_USAGE,
    voice: options.voice ?? false,
    verbose: options.verbose ?? false,
  };

  const warnings: string[] = [];

  try {
    const project = resolveProject(assistant, options.project);
    if (project) {
      state.projectId = project.id;
      state.projectName = project.name;
    }
  } catch (error) {
    warnings.push((error as Error).message);
  }

  if (options.agent) {
    try {
      const agent = resolveAgent(assistant, options.agent);
      state.agentId = agent.id;
      state.counterpart = agent.slug;
      state.agentTitle = agent.title;
      state.provider = agent.provider ?? state.provider;
      state.model = agent.model ?? state.model;
    } catch (error) {
      warnings.push((error as Error).message);
    }
  }

  if (state.sessionId) {
    try {
      const existing = resolveSession(assistant, state.sessionId);
      state.sessionId = existing.id;
      state.title = existing.title;
      state.provider = existing.provider;
      state.model = existing.model ?? state.model;
      // A resumed conversation keeps its own counterpart: core will not let
      // `--agent` re-point a session that already has one.
      const agent = existing.agentId ? assistant.store.org.getAgent(existing.agentId) : null;
      state.agentId = existing.agentId;
      state.counterpart = agent ? agent.slug : assistantName;
      state.agentTitle = agent?.title;
      if (existing.projectId && !state.projectId) {
        state.projectId = existing.projectId;
        state.projectName = assistant.store.org.getProject(existing.projectId)?.name;
      }
    } catch (error) {
      warnings.push((error as Error).message);
      state.sessionId = undefined;
    }
  }

  // The banner needs model display names, and so does everything live; one
  // catalogue load serves both. It is cached on disk, so this only spawns the
  // CLIs once a day.
  const catalogue = await loadModelCatalogue(assistant.providers, config.home);

  const banner: Entry[] = [
    { kind: 'banner', id: 'b1', banner: await bannerState(assistant, state, warnings, catalogue) },
  ];

  // A resumed conversation starts with its scrollback, not with amnesia: the
  // ordered blocks rebuild the turns the way they happened.
  let initialEntries: Entry[] = banner;
  if (state.sessionId) {
    try {
      let historySeq = 0;
      const nextHistoryId = () => 'h' + (historySeq += 1);
      initialEntries = [
        ...banner,
        ...historyEntries(assistant.store.getMessages(state.sessionId, 50), state, nextHistoryId),
      ];
    } catch (error) {
      warnings.push((error as Error).message);
    }
  }

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

/** What the boot banner shows: the mark, the counterpart, the logins. */
async function bannerState(
  assistant: Assistant,
  state: SessionState,
  warnings: string[],
  catalogue: ModelCatalogue,
): Promise<BannerState> {
  const statuses = await assistant.providers.statuses();
  const ready = statuses.filter((status) => status.available && status.authenticated);
  const offline = statuses.filter((status) => !(status.available && status.authenticated));

  return {
    wordmark: 'Rookery',
    assistantName: state.assistantName,
    ready: ready.map((status) => status.id),
    offline: offline.map((status) => status.id),
    provider: state.provider,
    ...(modelName(catalogue, state.provider, state.model)
      ? { model: modelName(catalogue, state.provider, state.model) }
      : {}),
    permission: state.permission,
    ...(state.projectName ? { project: state.projectName } : {}),
    ...(state.agentId ? { agent: state.counterpart } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
