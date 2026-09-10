import { useEffect, useMemo, useState } from 'react';
import type {
  EffortLevel,
  PermissionLevel,
  ProviderId,
  ProviderStatus,
  PublicConfig,
  TtsCatalogue,
  TtsVoice,
  VoiceEngine,
} from '../lib/types';
import { api } from '../lib/api';
import { useVoiceOutput } from '../hooks/useVoiceOutput';
import { SHOW_TOOL_CALLS_KEY, showToolCalls } from '../hooks/useChat';
import { EFFORT_HINT, EFFORT_LABEL, EFFORT_LEVELS, PERMISSION_HINT, PERMISSION_LABEL } from '../lib/format';

/** Radix Select has no empty value; this stands for "provider default". */
const DEFAULT = '__default__';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface SettingsPageProps {
  config: PublicConfig;
  /** For the model list of the default provider. */
  providers: ProviderStatus[];
  voices: SpeechSynthesisVoice[];
  onSave(patch: Partial<PublicConfig>): void;
}

/** Settings page: edits the server-side config, which lands in ~/.rookery/config.json. */
export function SettingsPage({ config, providers, voices, onSave }: SettingsPageProps) {
  const [draft, setDraft] = useState<PublicConfig>(config);
  useEffect(() => setDraft(config), [config]);

  // The server's voice catalogue: which engines have a key, and Edge's voices.
  const [catalogue, setCatalogue] = useState<TtsCatalogue | null>(null);
  useEffect(() => {
    void api.ttsVoices().then(setCatalogue).catch(() => setCatalogue(null));
  }, []);
  // Preview speaks with the saved settings: the server synthesises, not the draft.
  const preview = useVoiceOutput(config.voice);

  const langPrefix = (draft.voice.lang.split('-')[0] ?? 'de').toLowerCase();
  const edgeChoices = useMemo<TtsVoice[]>(() => {
    const picks = (catalogue?.edge ?? []).filter(
      (voice) => voice.lang.toLowerCase().startsWith(langPrefix) || voice.id.includes('Multilingual'),
    );
    // Offline, or a voice typed by hand: keep it selectable either way.
    const current = draft.voice.edgeVoice;
    if (current && !picks.some((voice) => voice.id === current)) {
      picks.unshift({ id: current, name: current, lang: '', gender: '' });
    }
    return picks;
  }, [catalogue, draft.voice.edgeVoice, langPrefix]);
  const elevenChoices = useMemo<TtsVoice[]>(() => {
    const picks = [...(catalogue?.elevenlabs ?? [])];
    const current = draft.voice.elevenLabsVoiceId;
    if (current && !picks.some((voice) => voice.id === current)) {
      picks.unshift({ id: current, name: current, lang: 'multi', gender: '' });
    }
    return picks;
  }, [catalogue, draft.voice.elevenLabsVoiceId]);

  const modelChoices = providers.find((entry) => entry.id === draft.defaultProvider)?.models ?? [];
  // The draft keeps the model even if it is not in the list (typed via CLI or
  // env), so the select must still be able to show it.
  const modelValue = draft.defaultModel || DEFAULT;
  const modelOptions =
    draft.defaultModel && !modelChoices.includes(draft.defaultModel)
      ? [draft.defaultModel, ...modelChoices]
      : modelChoices;

  const setVoice = (patch: Partial<PublicConfig['voice']>): void =>
    setDraft((current) => ({ ...current, voice: { ...current.voice, ...patch } }));

  const setOrg = (patch: Partial<PublicConfig['org']>): void =>
    setDraft((current) => ({ ...current, org: { ...current.org, ...patch } }));

  const [showTools, setShowTools] = useState<boolean>(() => showToolCalls());


  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Einstellungen</h1>
          <p className="text-sm text-muted-foreground">Gilt für CLI und Web-Interface gleichermaßen.</p>
        </div>

        <Tabs defaultValue="identity">
          <TabsList className="w-full">
            <TabsTrigger value="identity">Identität</TabsTrigger>
            <TabsTrigger value="defaults">Standardwerte</TabsTrigger>
            <TabsTrigger value="voice">Sprache</TabsTrigger>
            <TabsTrigger value="org">Firma</TabsTrigger>
          </TabsList>

          <TabsContent value="identity" className="space-y-4 py-1">
            <Row htmlFor="set-name" label="Name des Assistenten">
              <Input
                id="set-name"
                value={draft.assistantName}
                onChange={(event) => setDraft({ ...draft, assistantName: event.target.value })}
              />
            </Row>
            <Row htmlFor="set-user" label="Dein Name">
              <Input
                id="set-user"
                value={draft.userName ?? ''}
                placeholder="optional"
                onChange={(event) => setDraft({ ...draft, userName: event.target.value })}
              />
            </Row>
            <Row
              htmlFor="set-honorific"
              label="Anrede"
              hint="Wie dich der Assistent hin und wieder nennt, etwa „Master“ oder „Sir“. Leer: dein Name."
            >
              <Input
                id="set-honorific"
                value={draft.honorific}
                placeholder="optional"
                onChange={(event) => setDraft({ ...draft, honorific: event.target.value })}
              />
            </Row>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="set-formal">Siezen</Label>
                <p className="text-[10.5px] text-muted-foreground/80">
                  Der Assistent spricht dich immer mit „Sie“ an, im Chat wie im Sprachmodus.
                </p>
              </div>
              <Switch
                id="set-formal"
                checked={draft.formalAddress}
                onCheckedChange={(on) => setDraft({ ...draft, formalAddress: on })}
              />
            </div>
          </TabsContent>

          <TabsContent value="defaults" className="space-y-4 py-1">
            <Row htmlFor="set-provider" label="Anbieter">
              <Select
                value={draft.defaultProvider}
                onValueChange={(value) =>
                  // A model name belongs to one provider; drop it with the switch.
                  setDraft({ ...draft, defaultProvider: value as ProviderId, defaultModel: '' })
                }
              >
                <SelectTrigger id="set-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude Code</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row htmlFor="set-model" label="Modell" hint="Standard heißt: Das Modell, das der Anbieter selbst wählt.">
              <Select
                value={modelValue}
                onValueChange={(value) =>
                  setDraft({ ...draft, defaultModel: value === DEFAULT ? '' : value })
                }
              >
                <SelectTrigger id="set-model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>Standard</SelectItem>
                  {modelOptions.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row
              htmlFor="set-effort"
              label="Effort"
              hint={draft.defaultEffort ? EFFORT_HINT[draft.defaultEffort] : 'Was der Anbieter vorsieht.'}
            >
              <Select
                value={draft.defaultEffort || DEFAULT}
                onValueChange={(value) =>
                  // Empty rather than undefined: the server merge skips
                  // undefined, so only '' actually clears a stored value.
                  setDraft({
                    ...draft,
                    defaultEffort: value === DEFAULT ? '' : (value as EffortLevel),
                  })
                }
              >
                <SelectTrigger id="set-effort" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>Standard</SelectItem>
                  {EFFORT_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {EFFORT_LABEL[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row
              htmlFor="set-permission"
              label="Berechtigung"
              hint={PERMISSION_HINT[draft.defaultPermission]}
            >
              <Select
                value={draft.defaultPermission}
                onValueChange={(value) =>
                  setDraft({ ...draft, defaultPermission: value as PermissionLevel })
                }
              >
                <SelectTrigger id="set-permission" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PERMISSION_LABEL) as PermissionLevel[]).map((level) => (
                    <SelectItem key={level} value={level}>
                      {PERMISSION_LABEL[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          </TabsContent>

          <TabsContent value="voice" className="space-y-4 py-1">
            <Row
              htmlFor="set-engine"
              label="Stimme erzeugen mit"
              hint="Edge Neural ist kostenlos und braucht keinen Key. ElevenLabs und OpenAI brauchen ELEVENLABS_API_KEY bzw. OPENAI_API_KEY in der Umgebung des Servers."
            >
              <Select
                value={draft.voice.engine}
                onValueChange={(value) => setVoice({ engine: value as VoiceEngine })}
              >
                <SelectTrigger id="set-engine" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="edge">Microsoft Edge Neural (kostenlos)</SelectItem>
                  <SelectItem value="elevenlabs">
                    ElevenLabs{catalogue && !catalogue.engines.elevenlabs ? ' · Key fehlt' : ''}
                  </SelectItem>
                  <SelectItem value="openai">
                    OpenAI gpt-4o-mini-tts{catalogue && !catalogue.engines.openai ? ' · Key fehlt' : ''}
                  </SelectItem>
                  <SelectItem value="browser">Browser (speechSynthesis)</SelectItem>
                </SelectContent>
              </Select>
            </Row>

            {catalogue && (draft.voice.engine === 'elevenlabs' || draft.voice.engine === 'openai') && !catalogue.engines[draft.voice.engine] && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Dem Server fehlt {draft.voice.engine === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY'}. Trag den Key in
                <code className="mx-1">~/.rookery/.env</code>ein und starte den Server neu; bis dahin springt die Browser-Stimme ein.
              </p>
            )}

            {draft.voice.engine === 'edge' && (
              <Row
                htmlFor="set-edge-voice"
                label="Edge-Stimme"
                hint="Multilingual-Stimmen sprechen jede Sprache. Florian ist die ruhige deutsche Männerstimme, Andrew und Brian die tiefen englischen."
              >
                <Select value={draft.voice.edgeVoice} onValueChange={(value) => setVoice({ edgeVoice: value })}>
                  <SelectTrigger id="set-edge-voice" className="w-full">
                    <SelectValue placeholder="Stimme wählen" />
                  </SelectTrigger>
                  <SelectContent>
                    {edgeChoices.map((voice) => (
                      <SelectItem key={voice.id} value={voice.id}>
                        {voice.name}
                        {voice.lang ? ' · ' + voice.lang : ''}
                        {voice.gender ? (voice.gender === 'male' ? ' · m' : ' · w') : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
            )}

            {draft.voice.engine === 'elevenlabs' && (
              <>
                <Row
                  htmlFor="set-eleven-voice"
                  label="ElevenLabs-Stimme"
                  hint="Vorgefertigte Stimmen plus, mit Key, deine eigene Library. George, Daniel und Brian sind die Jarvis-Kandidaten."
                >
                  <Select
                    value={draft.voice.elevenLabsVoiceId || 'default'}
                    onValueChange={(value) => setVoice({ elevenLabsVoiceId: value === 'default' ? '' : value })}
                  >
                    <SelectTrigger id="set-eleven-voice" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Standard (George)</SelectItem>
                      {elevenChoices.map((voice) => (
                        <SelectItem key={voice.id} value={voice.id}>
                          {voice.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Row>
                <Row htmlFor="set-eleven-id" label="oder Voice-ID" hint="Für eine Stimme aus der Voice Library, die nicht in der Liste steht.">
                  <Input
                    id="set-eleven-id"
                    value={draft.voice.elevenLabsVoiceId}
                    placeholder="z. B. JBFqnCBsd6RMkjVDRZzb"
                    onChange={(event) => setVoice({ elevenLabsVoiceId: event.target.value })}
                  />
                </Row>
                <Row htmlFor="set-eleven-model" label="ElevenLabs-Modell" hint="Multilingual v2 klingt am besten auf Deutsch. Flash antwortet schneller. v3 ist am ausdrucksstärksten, aber langsamer.">
                  <Select
                    value={draft.voice.elevenLabsModel}
                    onValueChange={(value) => setVoice({ elevenLabsModel: value as PublicConfig['voice']['elevenLabsModel'] })}
                  >
                    <SelectTrigger id="set-eleven-model" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="eleven_multilingual_v2">Multilingual v2 (Qualität)</SelectItem>
                      <SelectItem value="eleven_flash_v2_5">Flash v2.5 (Tempo)</SelectItem>
                      <SelectItem value="eleven_v3">v3 (Ausdruck)</SelectItem>
                    </SelectContent>
                  </Select>
                </Row>
              </>
            )}

            {draft.voice.engine === 'openai' && (
              <Row htmlFor="set-openai-voice" label="OpenAI-Stimme" hint="Onyx und Echo sind die tiefen; der Butler-Ton kommt aus der Stilanweisung.">
                <Select value={draft.voice.openaiVoice} onValueChange={(value) => setVoice({ openaiVoice: value })}>
                  <SelectTrigger id="set-openai-voice" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(catalogue?.openai ?? []).map((voice) => (
                      <SelectItem key={voice.id} value={voice.id}>
                        {voice.name} · {voice.gender}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
            )}

            {draft.voice.engine === 'browser' && (
              <Row htmlFor="set-voice" label="Browser-Stimme">
                <Select
                  value={draft.voice.voiceName || 'auto'}
                  onValueChange={(value) => setVoice({ voiceName: value === 'auto' ? '' : value })}
                >
                  <SelectTrigger id="set-voice" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Automatisch</SelectItem>
                    {voices.map((voice) => (
                      <SelectItem key={voice.name} value={voice.name}>
                        {voice.name} ({voice.lang})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
            )}

            <Row
              htmlFor="set-style"
              label="Sprechstil"
              hint="Jarvis: gelassener britischer Butler, trocken, knapp, ein Hauch Ironie. Wirkt auf die Formulierung gesprochener Antworten, nicht auf den Chat."
            >
              <Select
                value={draft.voice.style}
                onValueChange={(value) => setVoice({ style: value as PublicConfig['voice']['style'] })}
              >
                <SelectTrigger id="set-style" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="jarvis">Jarvis</SelectItem>
                  <SelectItem value="neutral">Neutral</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row htmlFor="set-lang" label="Sprache (BCP-47)" hint="Für Spracherkennung und die Vorauswahl der Stimmen.">
              <Input
                id="set-lang"
                value={draft.voice.lang}
                onChange={(event) => setVoice({ lang: event.target.value })}
              />
            </Row>
            <Row
              htmlFor="set-wake"
              label="Aktivierungswort"
              hint="Im Freihandmodus zuschaltbar. Standardmäßig zählt dort jede Äußerung."
            >
              <Input
                id="set-wake"
                value={draft.voice.wakeWord}
                onChange={(event) => setVoice({ wakeWord: event.target.value })}
              />
            </Row>
            <Row label={'Tempo ' + draft.voice.rate.toFixed(2)}>
              <Slider
                min={0.5}
                max={1.8}
                step={0.02}
                value={[draft.voice.rate]}
                onValueChange={([value]) => setVoice({ rate: value ?? 1 })}
                aria-label="Sprechtempo"
              />
            </Row>
            <Row label={'Tonhöhe ' + draft.voice.pitch.toFixed(2)} hint="Wirkt bei Edge und Browser; ElevenLabs und OpenAI ignorieren sie.">
              <Slider
                min={0.5}
                max={1.6}
                step={0.02}
                value={[draft.voice.pitch]}
                onValueChange={([value]) => setVoice({ pitch: value ?? 1 })}
                aria-label="Tonhöhe"
              />
            </Row>

            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="set-jarvis">Jarvis-Effekt</Label>
                <p className="text-[10.5px] text-muted-foreground/80">
                  Präsenz-EQ, leichte Kompression und ein kurzer Raum-Doppel bei der Wiedergabe. Klingt nach Helmfunk.
                </p>
              </div>
              <Switch
                id="set-jarvis"
                checked={draft.voice.jarvisEffect}
                onCheckedChange={(on) => setVoice({ jarvisEffect: on })}
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="set-clean">Markdown vor dem Vorlesen entfernen</Label>
                <p className="text-[10.5px] text-muted-foreground/80">
                  Codeblöcke, Listenzeichen und Links werden nicht mitgesprochen.
                </p>
              </div>
              <Switch
                id="set-clean"
                checked={draft.voice.speakCleanText}
                onCheckedChange={(on) => setVoice({ speakCleanText: on })}
              />
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={preview.speaking}
                onClick={() => preview.speak('Guten Abend. Alle Systeme laufen, ich bin bereit.')}
              >
                Probehören
              </Button>
              <span className="text-[10.5px] text-muted-foreground/80">
                Nutzt die gespeicherten Einstellungen.
                {preview.error ? ' Server-Stimme fehlgeschlagen: ' + preview.error : ''}
              </span>
            </div>
          </TabsContent>

          <TabsContent value="org" className="space-y-4 py-1">
            <Row
              htmlFor="set-concurrency"
              label="Gleichzeitige Aufträge"
              hint="Wie viele Agenten-Prozesse zur selben Zeit laufen dürfen (1 bis 16)."
            >
              <Input
                id="set-concurrency"
                type="number"
                min={1}
                max={16}
                value={draft.org.maxConcurrentAssignments}
                onChange={(event) =>
                  setOrg({ maxConcurrentAssignments: Number(event.target.value) })
                }
              />
            </Row>
            <Row
              htmlFor="set-depth"
              label="Delegationstiefe"
              hint="Wie tief Agenten unter dem Assistenten weiterdelegieren dürfen (1 bis 6)."
            >
              <Input
                id="set-depth"
                type="number"
                min={1}
                max={6}
                value={draft.org.maxDelegationDepth}
                onChange={(event) => setOrg({ maxDelegationDepth: Number(event.target.value) })}
              />
            </Row>
          </TabsContent>

        </Tabs>

        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="set-show-tools">Werkzeugaufrufe im Chat anzeigen</Label>
            <p className="text-[10.5px] text-muted-foreground/80">
              Nur in diesem Browser, wird sofort wirksam. Aus: der Assistent arbeitet still, nur Aufträge an
              Agenten bleiben sichtbar. An: jeder Aufruf erscheint als Zeile, zum Nachvollziehen.
            </p>
          </div>
          <Switch
            id="set-show-tools"
            checked={showTools}
            onCheckedChange={(on) => {
              setShowTools(on);
              try {
                localStorage.setItem(SHOW_TOOL_CALLS_KEY, on ? '1' : '0');
              } catch {
                // storage blocked: the switch still applies to this page load
              }
            }}
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDraft(config)}>
            Abbrechen
          </Button>
          <Button onClick={() => onSave(draft)}>Speichern</Button>
        </div>
      </div>
    </div>
  );
}

function Row({
  htmlFor,
  label,
  hint,
  children,
}: {
  htmlFor?: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-[12px] text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[10.5px] text-muted-foreground/80">{hint}</p>}
    </div>
  );
}
