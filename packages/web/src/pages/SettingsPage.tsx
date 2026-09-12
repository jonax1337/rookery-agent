import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, useNavigate, useParams } from 'react-router';
import {
  AudioLinesIcon,
  BrainIcon,
  Building2Icon,
  PaletteIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  UserRoundIcon,
  Volume2Icon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';

import { FormPage } from '@/components/blocks/form-page';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState } from '@/components/common/empty-state';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { SliderField } from '@/components/forms/form-kit';
import { ProviderIcon } from '@/components/provider-icon';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { SHOW_TOOL_CALLS_KEY, showToolCalls } from '@/hooks/useChat';
import { useVoiceOutput } from '@/hooks/useVoiceOutput';
import { api } from '@/lib/api';
import {
  EFFORT_HINT,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  PERMISSION_HINT,
  PERMISSION_LABEL,
  PROVIDER_LABEL,
} from '@/lib/format';
import { formatPercent } from '@/lib/stats';
import { VOICE_ENGINES, VOICE_PITCH, VOICE_RATE, missingVoiceEnv } from '@/lib/voice';
import type {
  EffortLevel,
  MemoryConfig,
  OrgConfig,
  PermissionLevel,
  ProviderId,
  PublicConfig,
  TtsCatalogue,
  TtsVoice,
  VoiceConfig,
} from '@/lib/types';
import { useConfig, useSpeechState } from '@/providers/rookery-provider';
import { cn } from '@/lib/utils';

/**
 * Everything the server-side config holds, as six addressable sections.
 *
 * The page used to be four `Tabs` plus two switches hanging below them, one
 * hand-rolled `Row` component and a footer that scrolled away exactly when a
 * person wanted to save. Three things changed with the rebuild:
 *
 * - the sections live in the URL (`/settings/:section`), so a hint elsewhere
 *   in the app can link straight at the one it means;
 * - the action pair moved into the page header via `usePageMeta`, where it is
 *   always visible, and "Speichern" is gated on a deep comparison of draft
 *   against config rather than on "something was typed";
 * - two new sections appeared. `memory` was fully editable on the server and
 *   had no UI at all, and the local-only preferences (tool calls, appearance)
 *   are now named as local instead of sitting next to server settings.
 *
 * What is deliberately *not* here: `memory.gate`, `memory.graph` and
 * `memory.sleep`. `PATCH /api/config` is a deep merge, so leaving them out of
 * the patch leaves them untouched - and this page has no honest labels for
 * numbers whose effect is only visible in the nightly run.
 */

/* -------------------------------- sections ------------------------------- */

interface SectionMeta {
  slug: string;
  label: string;
  /** One line under the card title. Says what the section decides. */
  description: string;
  icon: LucideIcon;
}

const SECTIONS = [
  {
    slug: 'identity',
    label: 'Identität',
    description: 'Wie der Assistent heißt und wie er den Nutzer anspricht.',
    icon: UserRoundIcon,
  },
  {
    slug: 'defaults',
    label: 'Standardwerte',
    description: 'Womit ein Gespräch startet, solange nichts anderes gewählt ist.',
    icon: SlidersHorizontalIcon,
  },
  {
    slug: 'voice',
    label: 'Sprache',
    description: 'Womit gesprochene Antworten entstehen und wie sie klingen.',
    icon: AudioLinesIcon,
  },
  {
    slug: 'memory',
    label: 'Gedächtnis',
    description: 'Was behalten wird und wie weit der Assistent zurückgreift.',
    icon: BrainIcon,
  },
  {
    slug: 'org',
    label: 'Firma',
    description: 'Die Grenzen, in denen Agenten arbeiten und weiterdelegieren.',
    icon: Building2Icon,
  },
  {
    slug: 'appearance',
    label: 'Ansicht',
    description: 'Nur dieser Browser: Darstellung und Detailgrad.',
    icon: PaletteIcon,
  },
] as const satisfies readonly SectionMeta[];

const FIRST_SECTION = SECTIONS[0];

/**
 * Die Abschnitte hiessen bis zum Umbau deutsch, mit ASCII-Umschrift der
 * Umlaute - als einzige Routen der App. Routen sind englisch, Beschriftungen
 * deutsch; die alten Adressen leiten weiter, damit ein Lesezeichen oder ein
 * aelterer Link nicht auf der Identitaet landet, sondern dort, wo er hinwollte.
 */
const LEGACY_SLUGS: Record<string, string> = {
  identitaet: 'identity',
  standardwerte: 'defaults',
  sprache: 'voice',
  gedaechtnis: 'memory',
  firma: 'org',
  ansicht: 'appearance',
};

/** Die id des Formulars - der Speichern-Knopf steht im Kopf, ausserhalb davon. */
const FORM_ID = 'einstellungen';

/** Radix' radio groups have no empty value, so the provider default needs one. */
const DEFAULT = '__default__';

/* ------------------------------- the engines ------------------------------ */

/*
  Die Engine-Liste und die beiden Regler-Grenzen liegen in `lib/voice.ts`: sie
  standen hier und im Sprach-Sheet doppelt und nannten dieselbe Engine zweimal
  verschieden („Microsoft Edge Neural“ gegen „Edge Neural“).
*/

const ELEVEN_MODEL_LABEL: Record<VoiceConfig['elevenLabsModel'], string> = {
  eleven_multilingual_v2: 'Multilingual v2 · Qualität',
  eleven_flash_v2_5: 'Flash v2.5 · Tempo',
  eleven_v3: 'v3 · Ausdruck',
};

/* -------------------------------- the page ------------------------------- */

export function SettingsPage() {
  const { section } = useParams<{ section: string }>();
  const navigate = useNavigate();
  const { config, providers, save } = useConfig();
  const speech = useSpeechState();

  const active = SECTIONS.find((entry) => entry.slug === section);
  const current: SectionMeta = active ?? FIRST_SECTION;

  /* ------------------------------- the draft ------------------------------ */

  const [draft, setDraft] = useState<PublicConfig | null>(config);
  const [saving, setSaving] = useState(false);

  // Read synchronously by the effect below, so it cannot be state: the config
  // refetches on every socket reconnect, and a refetch must not wipe an edit
  // that is still in the middle of being typed.
  const touched = useRef(false);
  useEffect(() => {
    if (config && !touched.current) setDraft(config);
  }, [config]);

  const update = useCallback((make: (current: PublicConfig) => PublicConfig) => {
    touched.current = true;
    setDraft((currentDraft) => (currentDraft ? make(currentDraft) : currentDraft));
  }, []);

  const set = useCallback(
    (patch: Partial<PublicConfig>) => update((currentDraft) => ({ ...currentDraft, ...patch })),
    [update],
  );
  const setVoice = useCallback(
    (patch: Partial<VoiceConfig>) =>
      update((currentDraft) => ({ ...currentDraft, voice: { ...currentDraft.voice, ...patch } })),
    [update],
  );
  const setMemory = useCallback(
    (patch: Partial<MemoryConfig>) =>
      update((currentDraft) => ({ ...currentDraft, memory: { ...currentDraft.memory, ...patch } })),
    [update],
  );
  const setOrg = useCallback(
    (patch: Partial<OrgConfig>) =>
      update((currentDraft) => ({ ...currentDraft, org: { ...currentDraft.org, ...patch } })),
    [update],
  );

  // The deep comparison, not the "was touched" flag: typing a character and
  // deleting it again leaves nothing to save, and the header should say so.
  const dirty = draft !== null && config !== null && !deepEqual(draft, config);

  const discard = useCallback(() => {
    touched.current = false;
    setDraft(config);
  }, [config]);

  // Read through a ref so the callback keeps its identity while typing: it
  // goes into the header's action row, and a new identity per keystroke would
  // republish the page meta - and with it re-render the whole frame.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const submit = useCallback(async (): Promise<void> => {
    const pending = draftRef.current;
    if (!pending) return;
    setSaving(true);
    try {
      // The whole draft goes out: `PATCH /api/config` merges deeply, so the
      // sub-objects this page never shows survive untouched.
      if (await save(pending)) {
        if (draftRef.current === pending) touched.current = false;
      }
    } finally {
      setSaving(false);
    }
  }, [save]);

  usePageMeta(
    {
      breadcrumb: [
        { label: 'Einstellungen', to: '/settings/' + FIRST_SECTION.slug },
        { label: current.label },
      ],
      actions: (
        <div className="flex items-center gap-2">
          {dirty ? (
            <Badge variant="outline" className="hidden font-normal text-muted-foreground sm:inline-flex">
              Ungespeicherte Änderungen
            </Badge>
          ) : null}
          {/*
            Keine ButtonGroup: die verschweisst ihre Kinder zu einem Bauteil,
            und ein randloser Ghost-Knopf an einem gefuellten sieht aus wie ein
            Schalter, dem eine Kante fehlt. Der Abstand des Elterncontainers
            trennt die beiden.
          */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={discard}
          >
            Verwerfen
          </Button>
          {/*
            Ein echter Submit-Knopf, per `form` an das Formular im Inhalt
            gebunden: so speichert auch die Eingabetaste im Feld, und der
            Kopf bleibt der einzige Ort der Aktion.
          */}
          <Button type="submit" form={FORM_ID} size="sm" disabled={!dirty || saving}>
            {saving ? <Spinner aria-label="Wird gespeichert" /> : null}
            Speichern
          </Button>
        </div>
      ),
    },
    [dirty, saving, discard, submit],
  );

  /* ------------------------------ the catalogue ---------------------------- */

  const [catalogue, setCatalogue] = useState<TtsCatalogue | null>(null);
  const [catalogueFailed, setCatalogueFailed] = useState(false);

  const loadCatalogue = useCallback(async (): Promise<void> => {
    try {
      setCatalogue(await api.ttsVoices());
      setCatalogueFailed(false);
    } catch {
      setCatalogue(null);
      setCatalogueFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  // Preview speaks the *draft*, which is the whole point of a preview: until
  // this rebuild it synthesised the saved settings, so trying a voice out
  // meant saving it first and listening to the old one on the way.
  const preview = useVoiceOutput(draft?.voice);

  /* -------------------------------- render -------------------------------- */

  // Hooks first, redirect after. Eine alte deutsche Adresse geht auf ihren
  // englischen Abschnitt, alles andere (auch `/settings` selbst) auf den
  // ersten - lieber eine Weiterleitung als eine leere Karte.
  if (!active) {
    const moved = section ? LEGACY_SLUGS[section] : undefined;
    return <Navigate to={'/settings/' + (moved ?? FIRST_SECTION.slug)} replace />;
  }

  return (
    // 5xl statt 3xl: bei 1440 px blieb neben der 220-px-Navigation eine rund
    // 470 px schmale Karte stehen, waehrend rechts ueber 200 px tot lagen. In
    // dieser Breite kommt die Karte auf gut 730 px und die Felder landen in
    // der Lesebreite, die ein Formular vertraegt.
    <PageBody width="5xl">
      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <SectionNav
          current={current}
          onChange={(slug) => void navigate('/settings/' + slug)}
        />

        {/*
          Der Rahmen kommt aus dem Template, nicht von Hand: FormPage bringt
          Karte, Kopf und die `FieldGroup`-Klammer mit - und vor allem ein
          echtes `<form>`, weshalb die Eingabetaste jetzt speichert. Die
          Aktionen stehen im Seitenkopf (`showActions={false}`), der
          Speichern-Knopf dort ist per `form={FORM_ID}` angebunden.

          `error` bleibt bewusst leer: `saveConfig` faengt den Fehlschlag
          selbst ab und meldet ihn als Toast. Ihn zusaetzlich inline zu zeigen,
          hiesse erst den Provider umzubauen.
        */}
        <FormPage
          formId={FORM_ID}
          showActions={false}
          onSubmit={submit}
          title={current.label}
          description={current.description}
        >
          {draft === null ? (
            <SectionSkeleton />
          ) : (
            <>
              {current.slug === 'identity' ? <IdentitySection draft={draft} set={set} /> : null}
              {current.slug === 'defaults' ? (
                <DefaultsSection draft={draft} providers={providers} set={set} />
              ) : null}
              {current.slug === 'voice' ? (
                <VoiceSection
                  draft={draft}
                  catalogue={catalogue}
                  failed={catalogueFailed}
                  onRetry={() => void loadCatalogue()}
                  browserVoices={speech.voices}
                  setVoice={setVoice}
                  preview={preview}
                />
              ) : null}
              {current.slug === 'memory' ? (
                <MemorySection draft={draft} setMemory={setMemory} />
              ) : null}
              {current.slug === 'org' ? <OrgSection draft={draft} setOrg={setOrg} /> : null}
              {current.slug === 'appearance' ? <ViewSection /> : null}
            </>
          )}
        </FormPage>
      </div>
    </PageBody>
  );
}

/* ------------------------------ section nav ------------------------------ */

/**
 * The left column. A list of `Item`s on a wide screen, a `NativeSelect` on a
 * phone - a six-entry rail would eat the whole first screen there.
 */
function SectionNav({
  current,
  onChange,
}: {
  current: SectionMeta;
  onChange(slug: string): void;
}) {
  return (
    <>
      <NativeSelect
        className="w-full md:hidden"
        aria-label="Abschnitt der Einstellungen"
        value={current.slug}
        onChange={(event) => onChange(event.target.value)}
      >
        {SECTIONS.map((entry) => (
          <NativeSelectOption key={entry.slug} value={entry.slug}>
            {entry.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>

      <ItemGroup className="hidden gap-1 self-start md:sticky md:top-4 md:flex">
        {SECTIONS.map((entry) => {
          const selected = entry.slug === current.slug;
          return (
            <Item
              key={entry.slug}
              asChild
              size="sm"
              variant={selected ? 'muted' : 'default'}
              className={cn(selected && 'font-medium text-foreground')}
            >
              <NavLink to={'/settings/' + entry.slug}>
                <ItemMedia variant="icon">
                  <entry.icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{entry.label}</ItemTitle>
                </ItemContent>
              </NavLink>
            </Item>
          );
        })}
      </ItemGroup>
    </>
  );
}

/** Steht in der `FieldGroup` von `FormPage`, bringt also keine eigene mit. */
function SectionSkeleton() {
  return (
    <FieldSet>
      {Array.from({ length: 4 }, (_, index) => (
        <Field key={index}>
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-9 w-full" />
        </Field>
      ))}
    </FieldSet>
  );
}

/* -------------------------------- identity ------------------------------- */

function IdentitySection({
  draft,
  set,
}: {
  draft: PublicConfig;
  set(patch: Partial<PublicConfig>): void;
}) {
  return (
    <FieldSet>
      <Field>
        <FieldLabel htmlFor="set-name">Name des Assistenten</FieldLabel>
        <Input
          id="set-name"
          value={draft.assistantName}
          onChange={(event) => set({ assistantName: event.target.value })}
        />
        <FieldDescription>
          Steht im Systemprompt, in der Seitenleiste und über jeder gesprochenen Antwort.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="set-user">Name des Nutzers</FieldLabel>
        <Input
          id="set-user"
          value={draft.userName ?? ''}
          placeholder="optional"
          onChange={(event) => set({ userName: event.target.value })}
        />
      </Field>

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="set-formal">Siezen</FieldLabel>
          <FieldDescription>
            Der Assistent spricht durchgehend mit „Sie“ an, im Chat wie im Sprachmodus.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="set-formal"
          checked={draft.formalAddress}
          onCheckedChange={(on) => set({ formalAddress: on })}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="set-honorific">Anrede</FieldLabel>
        <Input
          id="set-honorific"
          value={draft.honorific}
          placeholder="optional"
          onChange={(event) => set({ honorific: event.target.value })}
        />
        <FieldDescription>
          Wie der Assistent hin und wieder anredet, etwa „Master“ oder „Sir“. Leer: der Name von oben.
        </FieldDescription>
      </Field>
    </FieldSet>
  );
}

/* -------------------------------- defaults ------------------------------- */

function DefaultsSection({
  draft,
  providers,
  set,
}: {
  draft: PublicConfig;
  providers: readonly { id: ProviderId; models?: string[] }[];
  set(patch: Partial<PublicConfig>): void;
}) {
  const models = providers.find((entry) => entry.id === draft.defaultProvider)?.models ?? [];

  // A model pinned through the CLI or the environment is not necessarily in
  // the provider's list, and it must stay selectable all the same.
  const options = useMemo<EntityOption[]>(() => {
    const names =
      draft.defaultModel && !models.includes(draft.defaultModel)
        ? [draft.defaultModel, ...models]
        : models;
    return names.map((name) => ({ value: name, label: name }));
  }, [draft.defaultModel, models]);

  return (
    <>
      <FieldSet>
        <FieldLegend variant="label">Anbieter</FieldLegend>
        <FieldDescription>
          Wer antwortet, wenn im Eingabefeld nichts anderes gewählt ist.
        </FieldDescription>
        <RadioGroup
          value={draft.defaultProvider}
          onValueChange={(value) =>
            // A model name belongs to exactly one provider; it goes with the switch.
            set({ defaultProvider: value as ProviderId, defaultModel: '' })
          }
        >
          {(['claude', 'codex'] as ProviderId[]).map((id) => (
            <FieldLabel key={id} htmlFor={'set-provider-' + id}>
              <Field orientation="horizontal">
                <ProviderIcon provider={id} className="size-5 text-muted-foreground" />
                <FieldContent>
                  <FieldTitle>{PROVIDER_LABEL[id]}</FieldTitle>
                </FieldContent>
                <RadioGroupItem value={id} id={'set-provider-' + id} aria-label={PROVIDER_LABEL[id]} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>

      <FieldSet>
        <Field>
          <FieldLabel htmlFor="set-model">Modell</FieldLabel>
          <EntityCombobox
            id="set-model"
            options={options}
            value={draft.defaultModel || null}
            onChange={(value) => set({ defaultModel: value ?? '' })}
            placeholder="Standard des Anbieters"
            emptyLabel="Kein Modell gefunden"
          />
          <FieldDescription>
            Leer bedeutet: das Modell, das der Anbieter selbst wählt.
          </FieldDescription>
        </Field>
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">Effort</FieldLegend>
        <FieldDescription>Wie lange das Modell nachdenken darf, bevor es antwortet.</FieldDescription>
        <RadioGroup
          value={draft.defaultEffort || DEFAULT}
          onValueChange={(value) =>
            // Empty rather than undefined: the server's merge skips undefined,
            // so only '' actually clears a stored value.
            set({ defaultEffort: value === DEFAULT ? '' : (value as EffortLevel) })
          }
        >
          <FieldLabel htmlFor="set-effort-default">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>Standard des Anbieters</FieldTitle>
                <FieldDescription>Was der Anbieter vorsieht.</FieldDescription>
              </FieldContent>
              <RadioGroupItem value={DEFAULT} id="set-effort-default" aria-label="Standard des Anbieters" />
            </Field>
          </FieldLabel>
          {EFFORT_LEVELS.map((level) => (
            <FieldLabel key={level} htmlFor={'set-effort-' + level}>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>{EFFORT_LABEL[level]}</FieldTitle>
                  <FieldDescription>{EFFORT_HINT[level]}</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={level} id={'set-effort-' + level} aria-label={EFFORT_LABEL[level]} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">Zugriff</FieldLegend>
        <FieldDescription>
          Was der Assistent ohne Rückfrage darf. Gilt als Vorauswahl je Gespräch.
        </FieldDescription>
        <RadioGroup
          value={draft.defaultPermission}
          onValueChange={(value) => set({ defaultPermission: value as PermissionLevel })}
        >
          {(Object.keys(PERMISSION_LABEL) as PermissionLevel[]).map((level) => (
            <FieldLabel key={level} htmlFor={'set-permission-' + level}>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>{PERMISSION_LABEL[level]}</FieldTitle>
                  <FieldDescription>{PERMISSION_HINT[level]}</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={level} id={'set-permission-' + level} aria-label={PERMISSION_LABEL[level]} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>
    </>
  );
}

/* --------------------------------- voice --------------------------------- */

function VoiceSection({
  draft,
  catalogue,
  failed,
  onRetry,
  browserVoices,
  setVoice,
  preview,
}: {
  draft: PublicConfig;
  catalogue: TtsCatalogue | null;
  failed: boolean;
  onRetry(): void;
  browserVoices: SpeechSynthesisVoice[];
  setVoice(patch: Partial<VoiceConfig>): void;
  preview: ReturnType<typeof useVoiceOutput>;
}) {
  const voice = draft.voice;

  const langPrefix = (voice.lang.split('-')[0] ?? 'de').toLowerCase();
  const edgeOptions = useMemo<EntityOption[]>(() => {
    const picks = (catalogue?.edge ?? []).filter(
      (entry) => entry.lang.toLowerCase().startsWith(langPrefix) || entry.id.includes('Multilingual'),
    );
    return withCurrent(picks, voice.edgeVoice).map(toOption);
  }, [catalogue, langPrefix, voice.edgeVoice]);

  const openaiOptions = useMemo<EntityOption[]>(
    () => withCurrent(catalogue?.openai ?? [], voice.openaiVoice).map(toOption),
    [catalogue, voice.openaiVoice],
  );

  const browserOptions = useMemo<EntityOption[]>(
    () => browserVoices.map((entry) => ({ value: entry.name, label: entry.name, hint: entry.lang })),
    [browserVoices],
  );

  return (
    <>
      <FieldSet>
        <FieldLegend>Ausgabe</FieldLegend>
        <FieldDescription>
          Womit der Server Sprache erzeugt. Fehlt einem Dienst der Schlüssel, springt die
          Browser-Stimme ein.
        </FieldDescription>

        {failed ? (
          <EmptyState
            icon={Volume2Icon}
            title="Stimmenkatalog nicht geladen"
            description="Ohne den Katalog lässt sich keine Stimme auswählen; die gespeicherte bleibt in Kraft."
            actionLabel="Erneut versuchen"
            onAction={onRetry}
            variant="plain"
            size="sm"
          />
        ) : (
          <ItemGroup className="gap-2">
            {VOICE_ENGINES.map((engine) => {
              const selected = voice.engine === engine.id;
              const missing = Boolean(catalogue && !catalogue.engines[engine.id]);
              return (
                <Item
                  key={engine.id}
                  asChild
                  variant="outline"
                  size="sm"
                  className={cn(
                    'cursor-pointer hover:bg-muted/50',
                    selected && 'border-primary bg-primary/5 dark:bg-primary/10',
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    className="text-left"
                    onClick={() => setVoice({ engine: engine.id })}
                  >
                    <ItemMedia variant="icon">
                      <engine.icon />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{engine.label}</ItemTitle>
                      <ItemDescription>{engine.description}</ItemDescription>
                    </ItemContent>
                    {missing && engine.env ? (
                      <ItemActions>
                        <Badge variant="destructive">Schlüssel fehlt</Badge>
                      </ItemActions>
                    ) : null}
                  </button>
                </Item>
              );
            })}
          </ItemGroup>
        )}

        {/* The missing key is a server-side fact, so it says which variable and
            where - a badge alone leaves a person guessing. */}
        {missingVoiceEnv(voice.engine, catalogue) ? (
          <FieldDescription>
            Dem Server fehlt{' '}
            <code className="font-mono">{missingVoiceEnv(voice.engine, catalogue)}</code>{' '}
            in <code className="font-mono">~/.rookery/.env</code>. Bis der Schlüssel gesetzt und der
            Server neu gestartet ist, spricht die Browser-Stimme.
          </FieldDescription>
        ) : null}
      </FieldSet>

      {!failed && voice.engine === 'edge' ? (
        <FieldSet>
          <FieldLegend variant="label">Edge Neural</FieldLegend>
          <Field>
            <FieldLabel htmlFor="set-edge-voice">Stimme</FieldLabel>
            <EntityCombobox
              id="set-edge-voice"
              options={edgeOptions}
              value={voice.edgeVoice || null}
              onChange={(value) => setVoice({ edgeVoice: value ?? '' })}
              placeholder="Stimme suchen"
              emptyLabel="Keine Stimme gefunden"
              clearable={false}
            />
            <FieldDescription>
              Multilingual-Stimmen sprechen jede Sprache. Florian ist die ruhige deutsche
              Männerstimme, Andrew und Brian die tiefen englischen.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      {!failed && voice.engine === 'elevenlabs' ? (
        <FieldSet>
          <FieldLegend variant="label">ElevenLabs</FieldLegend>
          <Field>
            <FieldLabel htmlFor="set-eleven-voice">Stimme</FieldLabel>
            {/* One field, one config value. There used to be a select and a text
                input writing to `elevenLabsVoiceId` side by side, and whichever
                was touched last silently won. */}
            <InputGroup>
              <InputGroupInput
                id="set-eleven-voice"
                value={voice.elevenLabsVoiceId}
                placeholder="Standard (George)"
                onChange={(event) => setVoice({ elevenLabsVoiceId: event.target.value })}
              />
              <InputGroupAddon align="inline-end">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <InputGroupButton>Bibliothek</InputGroupButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
                    <DropdownMenuLabel>Stimme aus der Bibliothek</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup
                      value={voice.elevenLabsVoiceId || DEFAULT}
                      onValueChange={(value) =>
                        setVoice({ elevenLabsVoiceId: value === DEFAULT ? '' : value })
                      }
                    >
                      <DropdownMenuRadioItem value={DEFAULT}>Standard (George)</DropdownMenuRadioItem>
                      {(catalogue?.elevenlabs ?? []).map((entry) => (
                        <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                          {entry.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>
              Eine Voice-ID aus der Voice Library lässt sich auch direkt eintragen. George, Daniel und
              Brian sind die Jarvis-Kandidaten.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="set-eleven-model">Modell</FieldLabel>
            <Select
              value={voice.elevenLabsModel}
              onValueChange={(value) =>
                setVoice({ elevenLabsModel: value as VoiceConfig['elevenLabsModel'] })
              }
            >
              <SelectTrigger id="set-eleven-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ELEVEN_MODEL_LABEL) as VoiceConfig['elevenLabsModel'][]).map((id) => (
                  <SelectItem key={id} value={id}>
                    {ELEVEN_MODEL_LABEL[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Multilingual v2 klingt auf Deutsch am besten, Flash antwortet schneller, v3 ist am
              ausdrucksstärksten und am langsamsten.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      {!failed && voice.engine === 'openai' ? (
        <FieldSet>
          <FieldLegend variant="label">OpenAI</FieldLegend>
          <Field>
            <FieldLabel htmlFor="set-openai-voice">Stimme</FieldLabel>
            <EntityCombobox
              id="set-openai-voice"
              options={openaiOptions}
              value={voice.openaiVoice || null}
              onChange={(value) => setVoice({ openaiVoice: value ?? '' })}
              placeholder="Stimme suchen"
              emptyLabel="Keine Stimme gefunden"
              clearable={false}
            />
            <FieldDescription>
              Onyx und Echo sind die tiefen; der Butler-Ton kommt aus der Stilanweisung, nicht aus der
              Stimme.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      {!failed && voice.engine === 'browser' ? (
        <FieldSet>
          <FieldLegend variant="label">Browser</FieldLegend>
          <Field>
            <FieldLabel htmlFor="set-browser-voice">Stimme</FieldLabel>
            <EntityCombobox
              id="set-browser-voice"
              options={browserOptions}
              value={voice.voiceName || null}
              onChange={(value) => setVoice({ voiceName: value ?? '' })}
              placeholder="Automatisch"
              emptyLabel="Keine Stimme gefunden"
            />
            <FieldDescription>
              Was dieses Betriebssystem mitbringt. Automatisch nimmt die erste Stimme der eingestellten
              Sprache.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      <FieldSet>
        <FieldLegend>Klang</FieldLegend>

        <SliderField
          id="set-rate"
          label="Tempo"
          {...VOICE_RATE}
          value={voice.rate}
          description="Wie schnell gesprochen wird. 1,00 ist das Tempo der Stimme selbst."
          onChange={(value) => setVoice({ rate: value })}
        />

        <SliderField
          id="set-pitch"
          label="Tonhöhe"
          {...VOICE_PITCH}
          value={voice.pitch}
          description="Wirkt bei Edge und im Browser. ElevenLabs und OpenAI ignorieren sie."
          onChange={(value) => setVoice({ pitch: value })}
        />

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="set-jarvis">Jarvis-Effekt</FieldLabel>
            <FieldDescription>
              Präsenz-EQ, leichte Kompression und ein kurzer Raum-Doppel bei der Wiedergabe. Klingt
              nach Helmfunk.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="set-jarvis"
            checked={voice.jarvisEffect}
            onCheckedChange={(on) => setVoice({ jarvisEffect: on })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="set-clean">Bereinigten Text sprechen</FieldLabel>
            <FieldDescription>
              Codeblöcke, Listenzeichen und Links werden vor dem Vorlesen entfernt.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="set-clean"
            checked={voice.speakCleanText}
            onCheckedChange={(on) => setVoice({ speakCleanText: on })}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="set-style">Sprechstil</FieldLabel>
          <Select
            value={voice.style}
            onValueChange={(value) => setVoice({ style: value as VoiceConfig['style'] })}
          >
            <SelectTrigger id="set-style" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="jarvis">Jarvis</SelectItem>
              <SelectItem value="neutral">Neutral</SelectItem>
            </SelectContent>
          </Select>
          <FieldDescription>
            Jarvis: gelassener britischer Butler, trocken, knapp, ein Hauch Ironie. Wirkt auf die
            Formulierung gesprochener Antworten, nicht auf den Chat.
          </FieldDescription>
        </Field>

        <ButtonGroup>
          <Button
            type="button"
            variant="outline"
            disabled={preview.speaking}
            onClick={() => {
              preview.unlock();
              preview.speak('Guten Abend. Alle Systeme laufen, ich bin bereit.');
            }}
          >
            {preview.speaking ? <Spinner aria-label="Spricht" /> : null}
            Probehören
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!preview.speaking}
            onClick={() => preview.stop()}
          >
            <SquareIcon data-icon="inline-start" />
            Stoppen
          </Button>
        </ButtonGroup>
        <FieldDescription>
          Spricht mit den Einstellungen auf diesem Bildschirm, auch ungespeicherten.
          {preview.error ? ' Server-Stimme fehlgeschlagen: ' + preview.error : ''}
        </FieldDescription>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Erkennung</FieldLegend>
        <FieldDescription>Gilt für den Sprachmodus und das Diktat im Eingabefeld.</FieldDescription>

        <Field>
          <FieldLabel htmlFor="set-lang">Sprache</FieldLabel>
          <Input
            id="set-lang"
            value={voice.lang}
            placeholder="de-DE"
            onChange={(event) => setVoice({ lang: event.target.value })}
          />
          <FieldDescription>
            Als BCP-47-Kennung. Steuert die Spracherkennung und die Vorauswahl der Stimmen.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="set-wake">Aktivierungswort</FieldLabel>
          <Input
            id="set-wake"
            value={voice.wakeWord}
            placeholder="optional"
            onChange={(event) => setVoice({ wakeWord: event.target.value })}
          />
          <FieldDescription>
            Im Sprachmodus zuschaltbar. Ohne Wort zählt dort jede Äußerung.
          </FieldDescription>
        </Field>
      </FieldSet>
    </>
  );
}

/** The voice currently configured, kept selectable even when the list lacks it. */
function withCurrent(list: readonly TtsVoice[], current: string): TtsVoice[] {
  const picks = [...list];
  if (current && !picks.some((entry) => entry.id === current)) {
    picks.unshift({ id: current, name: current, lang: '', gender: '' });
  }
  return picks;
}

function toOption(entry: TtsVoice): EntityOption {
  const hint = [entry.lang, entry.gender === 'male' ? 'm' : entry.gender === 'female' ? 'w' : '']
    .filter(Boolean)
    .join(' · ');
  return { value: entry.id, label: entry.name, ...(hint ? { hint } : {}) };
}

/* --------------------------------- memory -------------------------------- */

function MemorySection({
  draft,
  setMemory,
}: {
  draft: PublicConfig;
  setMemory(patch: Partial<MemoryConfig>): void;
}) {
  const memory = draft.memory;

  return (
    <>
      <FieldSet>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="set-memory-enabled">Gedächtnis benutzen</FieldLabel>
            <FieldDescription>
              Aus: der Assistent beginnt jedes Gespräch ohne Vorwissen. Bereits Gelerntes bleibt
              gespeichert.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="set-memory-enabled"
            checked={memory.enabled}
            onCheckedChange={(on) => setMemory({ enabled: on })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="set-memory-extract">Von selbst lernen</FieldLabel>
            <FieldDescription>
              Nach jedem Gespräch prüft der Assistent, was sich zu merken lohnt.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="set-memory-extract"
            checked={memory.autoExtract}
            onCheckedChange={(on) => setMemory({ autoExtract: on })}
          />
        </Field>
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">Abruf</FieldLegend>

        <NumberField
          id="set-memory-recall"
          label="Erinnerungen je Antwort"
          value={memory.recallLimit}
          min={0}
          max={50}
          suffix="Stück"
          description="Wie viele passende Erinnerungen höchstens in den Prompt wandern."
          onChange={(value) => setMemory({ recallLimit: value })}
        />

        <SliderField
          id="set-memory-threshold"
          label="Mindestähnlichkeit"
          value={memory.recallThreshold}
          min={0}
          max={1}
          step={0.01}
          fallback={0.12}
          format={(value) => formatPercent(Math.round(value * 100))}
          description="Wie nah eine Erinnerung am Thema liegen muss, um überhaupt aufzutauchen. Höher heißt strenger."
          onChange={(value) => setMemory({ recallThreshold: value })}
        />
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">Umfang</FieldLegend>

        <NumberField
          id="set-memory-window"
          label="Arbeitsfenster"
          value={memory.workingWindow}
          min={0}
          max={200}
          suffix="Nachrichten"
          description="Wie viele der letzten Nachrichten wörtlich im Kontext stehen."
          onChange={(value) => setMemory({ workingWindow: value })}
        />

        <NumberField
          id="set-memory-budget"
          label="Kontextbudget"
          value={memory.contextBudget}
          min={200}
          max={200000}
          suffix="Tokens"
          description="Die Obergrenze für alles, was das Gedächtnis beisteuert."
          onChange={(value) => setMemory({ contextBudget: value })}
        />
      </FieldSet>
    </>
  );
}

/* ---------------------------------- org ---------------------------------- */

function OrgSection({
  draft,
  setOrg,
}: {
  draft: PublicConfig;
  setOrg(patch: Partial<OrgConfig>): void;
}) {
  return (
    <FieldSet>
      <NumberField
        id="set-concurrency"
        label="Gleichzeitige Aufträge"
        value={draft.org.maxConcurrentAssignments}
        min={1}
        max={16}
        suffix="Prozesse"
        description="Wie viele Agentenprozesse zur selben Zeit laufen dürfen."
        onChange={(value) => setOrg({ maxConcurrentAssignments: value })}
      />

      <NumberField
        id="set-depth"
        label="Delegationstiefe"
        value={draft.org.maxDelegationDepth}
        min={1}
        max={6}
        suffix="Ebenen"
        description="Wie tief Agenten unter dem Assistenten weiterdelegieren dürfen."
        onChange={(value) => setOrg({ maxDelegationDepth: value })}
      />

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="set-lazy">Sparsam programmieren</FieldLabel>
          <FieldDescription>
            Agenten bekommen die Ponytail-Regeln in den Prompt: erst verstehen, dann prüfen, ob es
            etwas schon gibt, und die kleinste Lösung nehmen, die trägt. Validierung,
            Fehlerbehandlung, Sicherheit und Barrierefreiheit bleiben ausdrücklich ausgenommen.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="set-lazy"
          checked={draft.org.lazyCoding}
          onCheckedChange={(on) => setOrg({ lazyCoding: on })}
        />
      </Field>
    </FieldSet>
  );
}

/* ---------------------------------- view --------------------------------- */

const LOCAL_HINT = 'Wirkt sofort und wird nur in diesem Browser gemerkt.';

const THEMES: { value: string; label: string; description: string }[] = [
  { value: 'light', label: 'Hell', description: 'Immer die helle Palette.' },
  { value: 'dark', label: 'Dunkel', description: 'Immer die dunkle Palette.' },
  { value: 'system', label: 'System', description: 'Folgt der Einstellung des Betriebssystems.' },
];

/**
 * The two preferences that never reach the server.
 *
 * They sit in their own section instead of hanging below the tabs, because
 * the two storage models are genuinely different: everything else on this
 * page needs "Speichern" and then applies everywhere, these apply at once and
 * only here. The appearance radio is the same choice the sidebar footer
 * offers - named in full where a person goes looking for it.
 */
function ViewSection() {
  const { theme, setTheme } = useTheme();
  const [showTools, setShowTools] = useState<boolean>(() => showToolCalls());

  return (
    <>
      <FieldSet>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="set-show-tools">Werkzeugaufrufe im Chat anzeigen</FieldLabel>
            <FieldDescription>
              Aus: der Assistent arbeitet still, nur Aufträge an Agenten bleiben sichtbar. An: jeder
              Aufruf erscheint als Zeile. {LOCAL_HINT}
            </FieldDescription>
          </FieldContent>
          <Switch
            id="set-show-tools"
            checked={showTools}
            onCheckedChange={(on) => {
              setShowTools(on);
              try {
                localStorage.setItem(SHOW_TOOL_CALLS_KEY, on ? '1' : '0');
              } catch {
                // Private mode: the switch still applies to this page load.
              }
            }}
          />
        </Field>
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">Erscheinungsbild</FieldLegend>
        <FieldDescription>{LOCAL_HINT}</FieldDescription>
        <RadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
          {THEMES.map((entry) => (
            <FieldLabel key={entry.value} htmlFor={'set-theme-' + entry.value}>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>{entry.label}</FieldTitle>
                  <FieldDescription>{entry.description}</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={entry.value} id={'set-theme-' + entry.value} aria-label={entry.label} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>
    </>
  );
}

/* -------------------------------- controls ------------------------------- */

/**
 * A whole number with a hard range.
 *
 * The old page wrote `Number(event.target.value)` straight into the draft,
 * which put `NaN` in the patch the moment the field was cleared to type a new
 * value. Here the typed text lives locally until it parses inside the range;
 * only then does it reach the draft, and until then the field says why.
 */
function NumberField({
  id,
  label,
  value,
  min,
  max,
  suffix,
  description,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  description?: string;
  onChange(value: number): void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const shown = raw ?? String(value);
  const parsed = Number(shown);
  const invalid =
    shown.trim() === '' || !Number.isInteger(parsed) || parsed < min || parsed > max;

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          inputMode="numeric"
          value={shown}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            const next = event.target.value;
            setRaw(next);
            const number = Number(next);
            if (next.trim() !== '' && Number.isInteger(number) && number >= min && number <= max) {
              onChange(number);
            }
          }}
          onBlur={() => setRaw(null)}
        />
        {suffix ? (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{suffix}</InputGroupText>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>
        {invalid ? 'Bitte eine ganze Zahl zwischen ' + min + ' und ' + max + '.' : null}
      </FieldError>
    </Field>
  );
}

/* -------------------------------- compare -------------------------------- */

/**
 * Structural equality for the config tree.
 *
 * `JSON.stringify` would do it only as long as every copy keeps its key
 * order, and a spread of a sub-object does not guarantee that. This does not
 * have to be fast: it runs once per keystroke over an object with about
 * thirty leaves.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}
