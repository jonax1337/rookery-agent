import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AudioLinesIcon,
  BadgeAlertIcon as TriangleAlertIcon,
  BanIcon as SquareIcon,
  MicIcon,
  MicOffIcon,
  RotateCcwIcon,
  SettingsIcon,
  XIcon,
} from "@/components/icons";
import { useNavigate, useSearchParams } from 'react-router';

import { VoiceOrb, type OrbState } from '@/components/VoiceOrb';
import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import {
  RotatingText,
  RotatingTextContainer,
} from '@/components/animate-ui/primitives/texts/rotating';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { SliderField } from '@/components/forms/form-kit';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from '@/components/ui/field';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ChatState } from '@/hooks/useChat';
import { useMicLevel } from '@/hooks/useMicLevel';
import {
  useAssignmentAnnouncements,
  useRecentActivity,
  useSpokenReply,
  useStoredToggle,
  useVoiceConversation,
} from '@/hooks/useVoiceStage';
import { useVoiceOutput } from '@/hooks/useVoiceOutput';
import { api } from '@/lib/api';
import { greeting } from '@/lib/format';
import { useSpeechInput, type SpeechInputState } from '@/hooks/useWakeWord';
import type { TtsCatalogue, TtsVoice, VoiceConfig, VoiceEngine } from '@/lib/types';
import { cn } from '@/lib/utils';
import { VOICE_ENGINE_LABEL, VOICE_PITCH, VOICE_RATE } from '@/lib/voice';
import { useChatSession, useConfig } from '@/providers/rookery-provider';

/**
 * The hands-free screen.
 *
 * THIS PAGE IS THE ONE DELIBERATE EXCEPTION TO THE BLOCK SYSTEM. It has no
 * `PageBody`, no `usePageMeta`, no card grid and no light mode: it is a route
 * beside the shell, a full screen of its own on a dark ground with a WebGL
 * orb behind everything, and that is what makes it feel like talking to
 * something rather than operating something. What it does borrow is the parts
 * that would otherwise be hand-drawn here - `Empty` for the start gate,
 * `ButtonGroup` and `Tooltip` for the control bar, `Kbd` for the shortcuts and
 * `DetailDrawer` for the settings sheet. The colours live in `.voice-stage`
 * in `styles/index.css`, not as literals in this file.
 *
 * Speech recognition runs continuously; every finished utterance becomes a
 * turn, the answer is read aloud sentence by sentence while it streams, and
 * the microphone reopens the moment the voice stops. Tap the orb to interrupt.
 *
 * Starting needs a click: browsers only hand out the microphone and audio
 * output after a user gesture, and that same click takes the page fullscreen.
 */

const WAKE_PREFERENCE = 'rookery.voice.requireWake';
const BARGE_IN_PREFERENCE = 'rookery.voice.bargeIn';

/** Where leaving goes: the conversation list, filtered to the spoken ones. */
const EXIT_TO = '/chats?art=voice';

export function VoicePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { config, assistantName, save } = useConfig();
  const { turn } = useChatSession();

  const buildPayload = turn.buildVoicePayload;
  const voice = useVoiceOutput(config?.voice);
  const mic = useMicLevel();
  const { chat, forgetSession } = useVoiceConversation(searchParams.get('session'));
  const { answer, enqueue, beginTurn, cancelReply, greet, isOwnEcho } = useSpokenReply(
    chat,
    voice,
    config?.voice.speakCleanText !== false,
  );

  const [phase, setPhase] = useState<'gate' | 'live'>('gate');
  const [muted, setMuted] = useState(false);
  const [requireWake, setRequireWake] = useStoredToggle(WAKE_PREFERENCE);
  const [bargeIn, setBargeIn] = useStoredToggle(BARGE_IN_PREFERENCE);
  const [heard, setHeard] = useState('');
  const [micDenied, setMicDenied] = useState(false);
  // The control bar fades out after a few seconds without activity and comes
  // back on any. Whether the fade happens at all is decided in CSS by
  // `@media (hover: hover)`: on a touch screen nothing moves a pointer, so a
  // faded bar would be unrecoverable.
  const pointerActive = useRecentActivity(phase === 'live');
  // The keyboard's own reason to keep the bar: as long as the focus sits in
  // it, it must not fade. A faded bar is `opacity: 0`, not `display: none` -
  // its six buttons stay in the tab order, so fading one out from under a
  // keyboard is a focus ring nobody can see.
  const [barFocus, setBarFocus] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const lang = config?.voice.lang ?? 'en-GB';
  const wakeWord = config?.voice.wakeWord ?? '';

  const onUtterance = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!body || chat.busy) return;
      // With barge-in the microphone stays open while we talk; ignore ourselves.
      if (isOwnEcho(body)) return;
      beginTurn();
      setHeard(body);
      chat.send(buildPayload(body));
    },
    [beginTurn, buildPayload, chat, isOwnEcho],
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

  const start = useCallback(async () => {
    voice.unlock();
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // Fullscreen is a nicety; the screen works without it.
    }
    // Go live at once; the microphone prompt must not hold the screen hostage.
    setPhase('live');
    greet(greeting() + ' Listening.');
    const granted = await mic.start();
    setMicDenied(!granted);
  }, [greet, mic, voice]);

  const exit = useCallback(() => {
    voice.stop();
    mic.stop();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    void navigate(EXIT_TO);
  }, [mic, navigate, voice]);

  /** Tap on the orb or Space: shut the voice up, or abort the thinking. */
  const interrupt = useCallback(() => {
    if (!voice.speaking && !chat.busy) return;
    cancelReply();
    voice.stop();
    if (!voice.speaking) chat.abort();
  }, [cancelReply, chat, voice]);

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

  useAssignmentAnnouncements(phase === 'live', enqueue);

  const { reset: resetChat } = chat;
  const newConversation = useCallback(() => {
    voice.stop();
    resetChat();
    setHeard('');
    forgetSession();
  }, [forgetSession, resetChat, voice]);

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

  const status = captionOf({
    phase,
    speech: stt,
    speaking: voice.speaking,
    busy: chat.busy,
    activity: chat.activity,
    muted,
    requireWake,
    wakeWord,
    assistantName,
  });

  const warning = micDenied
    ? 'Microphone level access failed. The orb stays still; speech recognition may still work.'
    : stt.error ?? (voice.error ? 'Server voice unavailable. Using the browser voice.' : null);

  const voiceLabel = describeVoice(voice.engine, config?.voice.edgeVoice);

  // Muted or broken states keep the bar pinned, and so does the focus sitting
  // inside it; otherwise it follows the pointer, and only where there is one -
  // see `.voice-controls`.
  const barIdle = !(pointerActive || barFocus || muted || Boolean(warning) || settingsOpen);

  return (
    // `dark` is not a theme choice here but a fact: every shadcn primitive on
    // this screen sits on a near-black ground, whatever the app's own theme.
    <div className="voice-stage dark fixed inset-0 z-50 select-none overflow-hidden">
      <VoiceOrb state={state} getLevel={getLevel} dim={phase === 'gate'} className="absolute inset-0" />

      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between p-4 sm:p-6">
        {/* Every white on `--voice-ground` here is held at /55 or above: below
            that the 4,5:1 minimum breaks, and the orb behind the text is not a
            constant ground to borrow contrast from. */}
        <Blur>
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.28em] text-white/55">
            {/* The equaliser dances only under the pointer, not forever: the
                orb is this screen's one steady motion. */}
            <AudioLinesIcon className="size-4" />
            <span>{assistantName}</span>
            <span className="text-white/40" aria-hidden="true">
              ·
            </span>
            <span>Voice</span>
          </div>
        </Blur>
        <Fade delay={50}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Exit voice mode"
                className="rounded-full text-white/60 hover:bg-white/10 hover:text-white"
                onClick={exit}
              >
                <XIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              Exit <Kbd>Esc</Kbd>
            </TooltipContent>
          </Tooltip>
        </Fade>
      </div>

      {/* The gate: one sentence and one button, on the dimmed orb. */}
      {phase === 'gate' ? (
        <Empty className="absolute inset-0 justify-center border-0 bg-transparent">
          <EmptyHeader>
            {/* No EmptyMedia: the orb behind this block *is* the medium, and a
                24-pixel icon in front of it would only compete with it. The
                entrance therefore staggers text and button, not an icon. */}
            <Blur delay={100}>
              <EmptyTitle className="text-2xl font-light tracking-tight text-white sm:text-3xl">
                {status}
              </EmptyTitle>
            </Blur>
            <Fade delay={150}>
              <EmptyDescription className="max-w-md text-white/50">
                {stt.supported
                  ? 'Click to enable full screen, the microphone and speech. Voice: ' +
                    voiceLabel +
                    '.'
                  : 'Speech recognition is unavailable in this browser. Try Chrome or Edge.'}
              </EmptyDescription>
            </Fade>
          </EmptyHeader>
          <Fade delay={200}>
            <EmptyContent>
              <Button type="button" size="lg" disabled={!stt.supported} onClick={() => void start()}>
                <MicIcon />
                Start listening
              </Button>
            </EmptyContent>
          </Fade>
        </Empty>
      ) : null}

      {/* Live: the orb itself is the interrupt button. */}
      {phase === 'live' ? (
        // Disabled while there is nothing to interrupt: the button is 42 vmin
        // of invisible surface, and in the tab order it used to announce
        // itself as "Orb" and then do nothing. Disabled it keeps its place in
        // the layout and its mouse target where the mouse target means
        // something, and leaves the tab order alone the rest of the time.
        <button
          type="button"
          aria-label={voice.speaking ? 'Interrupt speech' : 'Cancel reply'}
          disabled={!voice.speaking && !chat.busy}
          className="absolute left-1/2 top-[calc(50%-6vmin)] size-[42vmin] -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          onClick={interrupt}
        />
      ) : null}

      {/* Caption block, anchored below the orb's arcs whatever the aspect ratio. */}
      {phase === 'live' ? (
        // The whole caption block is the live region, not just the status
        // line: when the voice stays silent (no microphone, server voice
        // unreachable), the answer below is the only place the reply appears,
        // and a screen reader has to hear it change.
        <Fade
          className="pointer-events-none absolute inset-x-0 top-[calc(50%+21vmin)] bottom-28 flex flex-col items-center gap-3 overflow-hidden px-6 text-center"
          aria-live="polite"
        >
          <p
            className={cn(
              'max-w-3xl text-balance text-lg font-light tracking-tight text-white/70 transition-all duration-300 sm:text-xl',
              stt.interim && !voice.speaking && !chat.busy && 'italic text-white/60',
            )}
          >
            {status}
          </p>
          {heard || answer ? (
            <div className="mt-2 max-w-2xl space-y-2">
              {heard ? <p className="text-sm text-white/55">“{heard}”</p> : null}
              {answer ? (
                <p className="line-clamp-3 text-base leading-relaxed text-white/85 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
                  {answer}
                </p>
              ) : null}
            </div>
          ) : null}
        </Fade>
      ) : null}

      {phase === 'live' ? (
        <Fade
          delay={50}
          className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/85 via-black/50 to-transparent p-5 pt-16 sm:p-7 sm:pt-16"
        >
          {warning ? (
            // Amber by hand: the stage is a deliberate dark surface outside the theme tokens.
            <Badge variant="outline" className="gap-1.5 border-amber-400/40 bg-amber-500/15 text-amber-200">
              <TriangleAlertIcon className="size-3.5" />
              {warning}
            </Badge>
          ) : null}

          {/* No `aria-hidden` here: whether the bar is actually faded is a CSS
              decision that depends on the pointer, and on a touch screen it
              stays visible - marking a visible bar as hidden would be a lie.
              What the bar does instead is notice its own focus: `barFocus`
              pins it open for as long as a key press or Tab has put the focus
              into it, so the buttons are never invisible and focusable at the
              same time. */}
          <div
            className="voice-controls"
            data-idle={barIdle}
            onFocusCapture={() => setBarFocus(true)}
            onBlurCapture={(event) => {
              // Moving between two buttons of the bar is not leaving it.
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setBarFocus(false);
            }}
          >
            <ButtonGroup className="voice-bar rounded-full border p-1 backdrop-blur">
              <VoiceAction
                label={muted ? 'Unmute microphone' : 'Mute microphone'}
                shortcut="M"
                pressed={muted}
                onClick={() => setMuted((on) => !on)}
              >
                {muted ? <MicOffIcon /> : <MicIcon />}
              </VoiceAction>
              <VoiceAction
                label="Stop speaking"
                shortcut="Space"
                disabled={!voice.speaking && !chat.busy}
                onClick={interrupt}
              >
                <SquareIcon />
              </VoiceAction>

              <ButtonGroupSeparator />

              <VoiceToggle
                label="Wake word"
                on={requireWake}
                disabled={!wakeWord}
                hint={
                  wakeWord
                    ? 'Only utterances containing “' + wakeWord + '” are accepted'
                    : 'No wake word configured'
                }
                onToggle={() => setRequireWake(!requireWake)}
              />
              <VoiceToggle
                label="Barge in"
                on={bargeIn}
                hint="Keep the microphone on while the assistant speaks"
                onToggle={() => setBargeIn(!bargeIn)}
              />

              <ButtonGroupSeparator />

              <VoiceAction label="New conversation" onClick={newConversation}>
                {/* Animates on hover of its wrapper span - the button base `[&_svg]:pointer-events-none` mutes only the svg, not the span. */}
                <RotateCcwIcon />
              </VoiceAction>
              <VoiceAction label="Voice and microphone" onClick={() => setSettingsOpen(true)}>
                <SettingsIcon />
              </VoiceAction>
            </ButtonGroup>
          </div>

          {/* The shortcuts stay put. They used to fade with the bar, which hid
              the one thing a person looks for when the screen stops reacting. */}
          <KbdGroup className="text-[11px] text-white/60">
            <Kbd>Space</Kbd>
            <span>interrupts</span>
            <Kbd>M</Kbd>
            <span>toggles microphone</span>
            <Kbd>Esc</Kbd>
            <span>exits</span>
            <span className="text-white/55">· Voice: {voiceLabel}</span>
          </KbdGroup>
        </Fade>
      ) : null}

      <VoiceSettingsDrawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        voice={config?.voice ?? null}
        onSaveVoice={(patch) => {
          if (!config) return;
          void save({ voice: { ...config.voice, ...patch } });
        }}
        requireWake={requireWake}
        wakeWord={wakeWord}
        onRequireWake={setRequireWake}
        bargeIn={bargeIn}
        onBargeIn={setBargeIn}
      />
    </div>
  );
}

/** The one line under the orb (or on the start gate) that says what the screen is doing. */
function captionOf({
  phase,
  speech,
  speaking,
  busy,
  activity,
  muted,
  requireWake,
  wakeWord,
  assistantName,
}: {
  phase: 'gate' | 'live';
  speech: SpeechInputState;
  speaking: boolean;
  busy: boolean;
  activity: ChatState['activity'];
  muted: boolean;
  requireWake: boolean;
  wakeWord: string;
  assistantName: string;
}): string {
  if (phase === 'gate') {
    return speech.supported ? 'Voice mode' : 'Speech recognition requires a supported browser, such as Chrome or Edge.';
  }
  if (speaking) return assistantName;
  if (busy) {
    // Voice keeps tool activity out of the spoken and visual conversation.
    const working = [...activity].reverse().find((item) => !item.done && item.kind === 'assignment');
    return working ? working.label + ' is working …' : 'Thinking …';
  }
  if (muted) return 'Microphone off';
  if (speech.interim) return speech.interim;
  if (!speech.supported) return 'Speech recognition is unavailable in this browser.';
  return requireWake && wakeWord ? '“' + wakeWord + ', …”' : 'Listening.';
}

/** The engine, and for Edge the short name of its voice (`en-GB-SoniaNeural` reads `Sonia`). */
function describeVoice(engine: VoiceEngine, edgeVoice: string | undefined): string {
  if (engine !== 'edge' || !edgeVoice) return VOICE_ENGINE_LABEL[engine];
  const shortName = edgeVoice.match(/-(\w+?)(?:Multilingual)?Neural$/)?.[1] ?? edgeVoice;
  return VOICE_ENGINE_LABEL[engine] + ' · ' + shortName;
}

/** One round icon button in the bar: a tooltip on top of the aria-label. */
function VoiceAction({
  label,
  shortcut,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
          disabled={disabled ?? false}
          className={cn(
            'rounded-full text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30',
            pressed && 'bg-white/15 text-white',
          )}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A switch that reads at arm's length.
 *
 * The two inline `Switch`es used to sit in the bar with a lowercase label and
 * no state beyond the track colour, which is unreadable from a metre away -
 * which is the distance this screen is used from. One button, one badge.
 */
function VoiceToggle({
  label,
  on,
  hint,
  disabled,
  onToggle,
}: {
  label: string;
  on: boolean;
  hint: string;
  disabled?: boolean;
  onToggle(): void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={on}
          disabled={disabled ?? false}
          className={cn(
            'gap-2 rounded-full px-3 text-xs text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30',
            on && 'text-white',
          )}
          onClick={onToggle}
        >
          {label}
          <Badge
            variant="outline"
            className={cn(
              'border-white/20 px-1.5 text-[10px] font-normal text-white/50',
              on && 'border-transparent bg-white/20 text-white',
            )}
          >
            {/* The label flips between on and off; let it roll instead of
                snapping. */}
            <RotatingTextContainer text={on ? 'on' : 'off'}>
              <RotatingText />
            </RotatingTextContainer>
          </Badge>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Voice and microphone settings, without leaving the screen.
 *
 * The gear used to navigate to `/settings`, which meant dropping out of
 * fullscreen, losing the microphone and the conversation, and finding the way
 * back. Everything a person wants to change *while* talking is here; the rest
 * stays where it belongs.
 */
function VoiceSettingsDrawer({
  open,
  onOpenChange,
  voice,
  onSaveVoice,
  requireWake,
  wakeWord,
  onRequireWake,
  bargeIn,
  onBargeIn,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  voice: VoiceConfig | null;
  onSaveVoice(patch: Partial<VoiceConfig>): void;
  requireWake: boolean;
  wakeWord: string;
  onRequireWake(on: boolean): void;
  bargeIn: boolean;
  onBargeIn(on: boolean): void;
}) {
  const [catalogue, setCatalogue] = useState<TtsCatalogue | null>(null);
  // Sliders need a value that moves with the thumb; the server only hears
  // about it when the drag ends, or every frame would be a PATCH.
  const [rate, setRate] = useState(voice?.rate ?? 1);
  const [pitch, setPitch] = useState(voice?.pitch ?? 1);

  useEffect(() => {
    if (!open) return;
    setRate(voice?.rate ?? 1);
    setPitch(voice?.pitch ?? 1);
    if (catalogue) return;
    void api
      .ttsVoices()
      .then(setCatalogue)
      .catch(() => setCatalogue(null));
    // Only opening the sheet may refill it; a save while it is open must not
    // yank the slider out from under a finger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const engine = voice?.engine ?? 'browser';
  const options = useMemo<EntityOption[]>(() => {
    if (!voice || !catalogue) return [];
    return voicesFor(catalogue, voice).map((entry) => ({
      value: entry.id,
      label: entry.name,
      ...(entry.lang ? { hint: entry.lang } : {}),
    }));
  }, [catalogue, voice]);

  const selected = voice ? selectedVoiceOf(voice) : '';

  const chooseVoice = (value: string | null): void => {
    const id = value ?? '';
    if (engine === 'edge') onSaveVoice({ edgeVoice: id });
    else if (engine === 'elevenlabs') onSaveVoice({ elevenLabsVoiceId: id });
    else if (engine === 'openai') onSaveVoice({ openaiVoice: id });
  };

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      direction="bottom"
      // The sheet portals out of the stage, so it carries the dark palette
      // with it instead of flashing white over a black screen.
      className="dark mx-auto max-w-xl"
      title="Voice and microphone"
      description={'Applies immediately across the app. Engine: ' + VOICE_ENGINE_LABEL[engine] + '.'}
    >
      <FieldGroup className="pb-2">
        <FieldSet>
          {engine === 'browser' ? (
            <FieldDescription>
              The browser uses an operating system voice. Choose another under Settings → Voice.
            </FieldDescription>
          ) : (
            <Field>
              <FieldLabel htmlFor="voice-pick">Voice</FieldLabel>
              <EntityCombobox
                id="voice-pick"
                options={options}
                value={selected || null}
                onChange={chooseVoice}
                placeholder={catalogue ? 'Search voices' : 'Loading catalogue …'}
                emptyLabel="No voice found"
                clearable={false}
              />
            </Field>
          )}

          {/* The same slider as in Settings, from `form-kit`; its bounds live
              in `lib/voice.ts`. On the sheet it has no hint line and commits
              on release, so a drag does not send twenty PATCHes. */}
          <SliderField
            id="voice-rate"
            label="Speed"
            {...VOICE_RATE}
            value={rate}
            onChange={setRate}
            onCommit={(value) => onSaveVoice({ rate: value })}
          />

          <SliderField
            id="voice-pitch"
            label="Pitch"
            {...VOICE_PITCH}
            value={pitch}
            onChange={setPitch}
            onCommit={(value) => onSaveVoice({ pitch: value })}
          />
        </FieldSet>

        <FieldSet>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="voice-wake">Require wake word</FieldLabel>
              <FieldDescription>
                {wakeWord
                  ? 'Only utterances containing “' + wakeWord + '” are sent.'
                  : 'No wake word configured. Set one under Settings → Voice.'}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="voice-wake"
              checked={requireWake}
              disabled={!wakeWord}
              onCheckedChange={onRequireWake}
            />
          </Field>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="voice-barge">Barge in</FieldLabel>
              <FieldDescription>
                Keeps the microphone on during speech. With speakers, the assistant may occasionally hear its own voice.
              </FieldDescription>
            </FieldContent>
            <Switch id="voice-barge" checked={bargeIn} onCheckedChange={onBargeIn} />
          </Field>
        </FieldSet>
      </FieldGroup>
    </DetailDrawer>
  );
}

/** The voices the active server engine offers; the browser engine has no catalogue. */
function voicesFor(catalogue: TtsCatalogue, voice: VoiceConfig): TtsVoice[] {
  if (voice.engine === 'elevenlabs') return catalogue.elevenlabs;
  if (voice.engine === 'openai') return catalogue.openai;
  if (voice.engine !== 'edge') return [];
  const language = (voice.lang.split('-')[0] ?? 'en').toLowerCase();
  return catalogue.edge.filter(
    (entry) => entry.lang.toLowerCase().startsWith(language) || entry.id.includes('Multilingual'),
  );
}

function selectedVoiceOf(voice: VoiceConfig): string {
  if (voice.engine === 'edge') return voice.edgeVoice;
  if (voice.engine === 'elevenlabs') return voice.elevenLabsVoiceId;
  if (voice.engine === 'openai') return voice.openaiVoice;
  return '';
}
