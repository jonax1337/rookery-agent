import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, useNavigate, useParams } from 'react-router';
import {
  AudioLinesIcon,
  BanIcon as SquareIcon,
  BrainIcon,
  BriefcaseBusinessIcon as Building2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon as ImportIcon,
  MailboxIcon,
  PaletteIcon,
  SlidersHorizontalIcon,
  UserIcon as UserRoundIcon,
  VolumeIcon as Volume2Icon,
} from "@/components/icons";

import { ThemeTogglerButton } from '@/components/animate-ui/components/buttons/theme-toggler';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { FormPage } from '@/components/blocks/form-page';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState } from '@/components/common/empty-state';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { SliderField } from '@/components/forms/form-kit';
import { VoiceKeys } from '@/components/forms/voice-keys';
import { AssistantProfile } from '@/components/forms/assistant-profile';
import { AssistantMigration } from '@/components/forms/assistant-migration';
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
import { useListeners } from '@/hooks/useListeners';
import { useVoiceOutput } from '@/hooks/useVoiceOutput';
import { api } from '@/lib/api';
import { listenerStateLook } from '@/lib/listeners';
import {
  EFFORT_HINT,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  PERMISSION_HINT,
  PERMISSION_LABEL,
  PROVIDER_LABEL,
  timeAgo,
} from '@/lib/format';
import { formatPercent } from '@/lib/stats';
import { VOICE_ENGINES, VOICE_PITCH, VOICE_RATE, missingVoiceEnv } from '@/lib/voice';
import type {
  EffortLevel,
  ImapListenerConfig,
  ListenerStatus,
  MemoryConfig,
  OrgConfig,
  PermissionLevel,
  ProviderCatalogItem,
  ProviderId,
  ProviderStatus,
  PublicConfig,
  TtsCatalogue,
  TtsVoice,
  VoiceConfig,
} from '@/lib/types';
import { useConfig, useCronState, useSpeechState } from '@/providers/rookery-provider';
import { cn } from '@/lib/utils';
import type { IconComponent } from "@/components/icons";

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
 *   had no UI at all, and the local-only preferences (appearance)
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
  icon: IconComponent;
}

/*
  Drei der sieben Abschnitts-Icons gibt es als animate-ui-Fassung; sie spielen
  ihre kleine Geste beim Hover der Navigation ab. Der Rest bleibt Lucide, weil
  die Bibliothek kein Gegenstueck hat (Migration, Memory, Organization,
  Appearance). Der forwardRef-Mantel ist noetig, weil `SectionMeta.icon` als
  IconComponent getypt ist und prop-los gerendert wird - derselbe Trick wie
  AnimatedPlugZapIcon im EmptyState.
*/
const AnimatedUserRoundIcon = forwardRef<SVGSVGElement>(function AnimatedUserRoundIcon() {
  return <UserRoundIcon />;
});

const AnimatedSlidersHorizontalIcon = forwardRef<SVGSVGElement>(
  function AnimatedSlidersHorizontalIcon() {
    return <SlidersHorizontalIcon />;
  },
);

const AnimatedAudioLinesIcon = forwardRef<SVGSVGElement>(function AnimatedAudioLinesIcon() {
  return <AudioLinesIcon />;
});

const SECTIONS = [
  {
    slug: 'identity',
    label: 'Identity',
    description: 'The assistant name and how it addresses the user.',
    icon: AnimatedUserRoundIcon,
  },
  {
    slug: 'migration',
    label: 'Migration',
    description: 'Bring your assistant from OpenClaw or Hermes.',
    icon: ImportIcon,
  },
  {
    slug: 'defaults',
    label: 'Defaults',
    description: 'How conversations start when no other options are selected.',
    icon: AnimatedSlidersHorizontalIcon,
  },
  {
    slug: 'voice',
    label: 'Voice',
    description: 'How spoken replies are generated and how they sound.',
    icon: AnimatedAudioLinesIcon,
  },
  {
    slug: 'memory',
    label: 'Memory',
    description: 'What is remembered and how much context the assistant recalls.',
    icon: BrainIcon,
  },
  {
    slug: 'org',
    label: 'Organization',
    description: 'Limits for agent work and delegation.',
    icon: Building2Icon,
  },
  {
    slug: 'listeners',
    label: 'Listeners',
    description: 'Mailboxes Rookery watches, and the schedule each one fires.',
    icon: MailboxIcon,
  },
  {
    slug: 'appearance',
    label: 'Appearance',
    description: 'Display and detail preferences for this browser only.',
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
  eleven_multilingual_v2: 'Multilingual v2 · Quality',
  eleven_flash_v2_5: 'Flash v2.5 · Speed',
  eleven_v3: 'v3 · Expression',
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
  // The whole list, every time: `listeners.imap` is an array, and a deep merge
  // cannot express "this one is gone".
  const setListeners = useCallback(
    (imap: ImapListenerConfig[]) =>
      update((currentDraft) => ({ ...currentDraft, listeners: { imap } })),
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
        { label: 'Settings', to: '/settings/' + FIRST_SECTION.slug },
        { label: current.label },
      ],
      actions: (
        <div className="flex items-center gap-2">
          {dirty ? (
            <Badge variant="outline" className="hidden font-normal text-muted-foreground sm:inline-flex">
              Unsaved changes
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
            Discard
          </Button>
          {/*
            Ein echter Submit-Knopf, per `form` an das Formular im Inhalt
            gebunden: so speichert auch die Eingabetaste im Feld, und der
            Kopf bleibt der einzige Ort der Aktion.
          */}
          <Button type="submit" form={FORM_ID} size="sm" disabled={!dirty || saving}>
            {saving ? <Spinner aria-label="Saving" /> : null}
            Save
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
              {current.slug === 'identity' ? (
                <>
                  <IdentitySection draft={draft} set={set} />
                  <Fade delay={50}>
                    <AssistantProfile />
                  </Fade>
                </>
              ) : null}
              {current.slug === 'migration' ? (
                <Fade>
                  <AssistantMigration />
                </Fade>
              ) : null}
              {current.slug === 'defaults' ? (
                <>
                  <DefaultsSection draft={draft} providers={providers} set={set} />
                  <Fade delay={200}>
                    <ProviderFallbackSection draft={draft} providers={providers} set={set} />
                  </Fade>
                  <Fade delay={250}>
                    <ProviderProfilesSection providers={providers} />
                  </Fade>
                </>
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
              {current.slug === 'listeners' ? (
                <ListenersSection draft={draft} setListeners={setListeners} />
              ) : null}
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
 * The left column. A list of `Item`s on a wide screen, a `Select` on a
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
      <Select value={current.slug} onValueChange={onChange}>
        <SelectTrigger className="w-full md:hidden" aria-label="Settings section"><SelectValue /></SelectTrigger>
        <SelectContent>{SECTIONS.map((entry) => <SelectItem key={entry.slug} value={entry.slug}>{entry.label}</SelectItem>)}</SelectContent>
      </Select>

      <Fade asChild>
        <ItemGroup className="hidden gap-1 self-start md:sticky md:top-6 md:flex">
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
      </Fade>
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
    <Fade>
      <FieldSet>
        <Field>
          <FieldLabel htmlFor="set-name">Assistant name</FieldLabel>
          <Input
            id="set-name"
            value={draft.assistantName}
            onChange={(event) => set({ assistantName: event.target.value })}
          />
          <FieldDescription>
            Display name in the sidebar and spoken replies. Also used by default profile templates; imported Markdown keeps its own identity.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="set-user">User name</FieldLabel>
          <Input
            id="set-user"
            value={draft.userName ?? ''}
            placeholder="optional"
            onChange={(event) => set({ userName: event.target.value })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="set-formal">Formal address</FieldLabel>
            <FieldDescription>
              Use a formal register in both chat and voice conversations.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="set-formal"
            checked={draft.formalAddress}
            onCheckedChange={(on) => set({ formalAddress: on })}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="set-honorific">Honorific</FieldLabel>
          <Input
            id="set-honorific"
            value={draft.honorific}
            placeholder="optional"
            onChange={(event) => set({ honorific: event.target.value })}
          />
          <FieldDescription>
            An occasional form of address, such as “Sir”. Leave empty to use the user name above.
          </FieldDescription>
        </Field>
      </FieldSet>
    </Fade>
  );
}

/* -------------------------------- defaults ------------------------------- */

function DefaultsSection({
  draft,
  providers,
  set,
}: {
  draft: PublicConfig;
  providers: readonly ProviderStatus[];
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
      <Fade>
        <FieldSet>
          <FieldLegend variant="label">Provider</FieldLegend>
          <FieldDescription>
            Who responds when no other provider is selected in the composer.
          </FieldDescription>
          <RadioGroup
            value={draft.defaultProvider}
            onValueChange={(value) =>
              // A model name belongs to exactly one provider; it goes with the switch.
              set({ defaultProvider: value as ProviderId, defaultModel: '' })
            }
          >
            {providers.map((status) => {
              const label = PROVIDER_LABEL[status.id] ?? status.displayName;
              // A provider that cannot answer must not become the default: the
              // composer would show it while the runtime quietly fell back to
              // another one. Setting it up is a click away, in the section below.
              const ready = status.available && status.authenticated;
              return (
                <FieldLabel key={status.id} htmlFor={'set-provider-' + status.id}>
                  <Field orientation="horizontal" data-disabled={!ready || undefined}>
                    <ProviderIcon
                      provider={status.id}
                      label={status.displayName}
                      className="size-5 text-muted-foreground"
                    />
                    <FieldContent>
                      <FieldTitle>{label}</FieldTitle>
                      {!ready ? <FieldDescription>{status.detail ?? 'Not ready yet.'}</FieldDescription> : null}
                    </FieldContent>
                    <RadioGroupItem
                      value={status.id}
                      id={'set-provider-' + status.id}
                      aria-label={label}
                      disabled={!ready}
                    />
                  </Field>
                </FieldLabel>
              );
            })}
          </RadioGroup>
        </FieldSet>
      </Fade>

      <Fade delay={50}>
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="set-model">Model</FieldLabel>
            <EntityCombobox
              id="set-model"
              options={options}
              value={draft.defaultModel || null}
              onChange={(value) => set({ defaultModel: value ?? '' })}
              placeholder="Provider default"
              emptyLabel="No model found"
            />
            <FieldDescription>
              Leave empty to use the provider default model.
            </FieldDescription>
          </Field>
        </FieldSet>
      </Fade>

      <Fade delay={100}>
        <FieldSet>
          <FieldLegend variant="label">Effort</FieldLegend>
          <FieldDescription>How much reasoning effort the model uses before responding.</FieldDescription>
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
                  <FieldTitle>Provider default</FieldTitle>
                  <FieldDescription>Use the provider default.</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={DEFAULT} id="set-effort-default" aria-label="Provider default" />
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
      </Fade>

      <Fade delay={150}>
        <FieldSet>
          <FieldLegend variant="label">Permissions</FieldLegend>
          <FieldDescription>
            The default permission level for each conversation.
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
      </Fade>
    </>
  );
}

/* --------------------------- provider fallback ---------------------------- */

/**
 * Was passiert, wenn ein Provider seine Quota verliert: wer als Naechster dran
 * ist, und ab wie viel Verbrauch ein Provider als "fast voll" gilt. Die
 * Reihenfolge zeigt jeden bekannten Provider - einer, der spaeter hinzukommt,
 * haengt sich hinten an, statt hier unsichtbar zu bleiben.
 */
function ProviderFallbackSection({
  draft,
  providers,
  set,
}: {
  draft: PublicConfig;
  providers: readonly ProviderStatus[];
  set(patch: Partial<PublicConfig>): void;
}) {
  const fallback = draft.providerFallback ?? { enabled: true, thresholdPercent: 95, order: [] };
  // Die gespeicherte Reihenfolge zuerst, dann was die Registry kennt und die
  // Datei nicht: so steht ein neuer Provider ganz hinten statt gar nicht.
  const ordered: ProviderId[] = [
    ...fallback.order.filter((id) => providers.some((status) => status.id === id)),
    ...providers.map((status) => status.id).filter((id) => !fallback.order.includes(id)),
  ];

  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const entry = ordered[index];
    const other = ordered[target];
    if (entry === undefined || other === undefined) return;
    const next = [...ordered];
    next[index] = other;
    next[target] = entry;
    set({ providerFallback: { ...fallback, order: next } });
  };

  return (
    <FieldSet>
      <FieldLegend variant="label">Fallback</FieldLegend>
      <FieldDescription>
        When a provider runs out of quota, turns and assignments continue on another one instead of failing.
      </FieldDescription>

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="set-fallback">Switch automatically</FieldLabel>
          <FieldDescription>
            Route around a provider that hit its usage limit or is nearly spent.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="set-fallback"
          checked={fallback.enabled}
          onCheckedChange={(on) => set({ providerFallback: { ...fallback, enabled: on } })}
        />
      </Field>

      <SliderField
        id="set-fallback-threshold"
        label="Threshold"
        value={fallback.thresholdPercent}
        min={50}
        max={100}
        step={1}
        fallback={95}
        format={(value) => value + ' % used'}
        description="A provider whose window is this full is avoided while a roomier one is signed in."
        onChange={(value) => set({ providerFallback: { ...fallback, thresholdPercent: value } })}
      />

      <Field>
        <FieldLabel>Fallback order</FieldLabel>
        <FieldDescription>Who a turn tries next when the preferred provider cannot serve it.</FieldDescription>
        <div className="flex flex-col gap-1">
          {ordered.map((id, index) => {
            const status = providers.find((entry) => entry.id === id);
            const label = PROVIDER_LABEL[id] ?? status?.displayName ?? id;
            return (
              <div key={id} className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
                <ProviderIcon provider={id} label={label} className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                {status?.usageBlocked ? <Badge variant="outline">Avoided</Badge> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={'Move ' + label + ' up'}
                >
                  <ChevronUpIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={'Move ' + label + ' down'}
                >
                  <ChevronDownIcon className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
      </Field>
    </FieldSet>
  );
}

/* --------------------------- provider profiles ---------------------------- */

/**
 * The providers Rookery can set up, one row each.
 *
 * Everything technical - endpoint, transport, model names - comes from the
 * catalogue on the server, so the only thing asked for here is the part that
 * is actually the user's: a key, or where a checkout lives.
 */
function ProviderProfilesSection({ providers }: { providers: readonly ProviderStatus[] }) {
  const [items, setItems] = useState<ProviderCatalogItem[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await api.providerCatalog();
    setItems(list);
    setValues(Object.fromEntries(list.map((item) => [item.id, ''])));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const connect = async (item: ProviderCatalogItem) => {
    setBusy(item.id);
    setError(null);
    try {
      const value = (values[item.id] ?? '').trim();
      await api.saveProviderProfile(item.id, { authToken: value || undefined });
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (id: string) => {
    setBusy(id);
    try {
      await api.deleteProviderProfile(id);
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (!items) return null;

  return (
    <FieldSet>
      <FieldLegend variant="label">More providers</FieldLegend>
      <FieldDescription>
        Other models, answered through Claude Code itself. Claude and ChatGPT are already built in.
      </FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}

      {items.map((item) => {
        const status = providers.find((entry) => entry.id === item.id);
        const ready = Boolean(status?.available && status.authenticated);
        const badge = !item.configured
          ? { label: 'Not set up', variant: 'outline' as const }
          : ready
            ? { label: 'Ready', variant: 'default' as const }
            : { label: 'Needs attention', variant: 'secondary' as const };
        return (
          <Field key={item.id} className="gap-2 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <ProviderIcon provider={item.id} label={item.name} className="size-5 text-muted-foreground" />
              <FieldTitle className="flex-1">{item.name}</FieldTitle>
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </div>
            <FieldDescription>{item.description}</FieldDescription>
            {item.configured && !ready && status?.detail ? (
              <FieldDescription className="text-destructive">{status.detail}</FieldDescription>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-0 flex-1"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={item.name + ' API key'}
                value={values[item.id] ?? ''}
                placeholder={item.authTokenSet ? 'Saved — leave empty to keep it' : 'API key'}
                onChange={(event) => setValues((current) => ({ ...current, [item.id]: event.target.value }))}
              />
              <Button type="button" size="sm" disabled={busy === item.id} onClick={() => void connect(item)}>
                {item.configured ? 'Save' : 'Set up'}
              </Button>
              {item.configured ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy === item.id}
                  onClick={() => void disconnect(item.id)}
                >
                  Remove
                </Button>
              ) : null}
            </div>
            <FieldDescription>{item.hint}</FieldDescription>
          </Field>
        );
      })}
    </FieldSet>
  );
}


/* --------------------------------- voice --------------------------------- */

/*
  Der Fehlzustand "Sprachkatalog nicht erreichbar" zeigt den Lautsprecher als
  animate-ui-Icon: die Wellen ziehen einmal ab, wenn der Block in den
  Viewport kommt. Gleiche forwardRef-Kapsel wie bei den Abschnitts-Icons,
  weil EmptyState sein Icon als IconComponent ohne Props zeichnet.
*/
const AnimatedVolume2Icon = forwardRef<SVGSVGElement>(function AnimatedVolume2Icon() {
  return <Volume2Icon size={24} />;
});

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

  const langPrefix = (voice.lang.split('-')[0] ?? 'en').toLowerCase();
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
      <Fade>
        <FieldSet>
          <FieldLegend>Output</FieldLegend>
          <FieldDescription>
            Choose a speech engine. If a service key is missing, the browser voice takes over.
          </FieldDescription>

          {failed ? (
            <EmptyState
              icon={AnimatedVolume2Icon}
              title="Voice catalogue unavailable"
              description="New voices cannot be selected without the catalogue. Your saved voice remains selected."
              actionLabel="Try again"
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
                          <Badge variant="destructive">Key missing</Badge>
                        </ItemActions>
                      ) : null}
                    </button>
                  </Item>
                );
              })}
            </ItemGroup>
          )}

          {missingVoiceEnv(voice.engine, catalogue) ? (
            <FieldDescription>
              Add a key under Speech service keys below to enable this engine. Until then, the browser voice is used.
            </FieldDescription>
          ) : null}
        </FieldSet>
      </Fade>

      <Fade delay={50}>
        <VoiceKeys onSaved={onRetry} />
      </Fade>

      {!failed && voice.engine === 'edge' ? (
        <Fade delay={100}>
          <FieldSet>
            <FieldLegend variant="label">Edge Neural</FieldLegend>
            <Field>
              <FieldLabel htmlFor="set-edge-voice">Voice</FieldLabel>
              <EntityCombobox
                id="set-edge-voice"
                options={edgeOptions}
                value={voice.edgeVoice || null}
                onChange={(value) => setVoice({ edgeVoice: value ?? '' })}
                placeholder="Search voices"
                emptyLabel="No voice found"
                clearable={false}
              />
              <FieldDescription>
                Ryan is the default British English voice. Multilingual voices support multiple languages.
              </FieldDescription>
            </Field>
          </FieldSet>
        </Fade>
      ) : null}

      {!failed && voice.engine === 'elevenlabs' ? (
        <Fade delay={100}>
          <FieldSet>
            <FieldLegend variant="label">ElevenLabs</FieldLegend>
            <Field>
              <FieldLabel htmlFor="set-eleven-voice">Voice</FieldLabel>
              {/* One field, one config value. There used to be a select and a text
                  input writing to `elevenLabsVoiceId` side by side, and whichever
                  was touched last silently won. */}
              <InputGroup>
                <InputGroupInput
                  id="set-eleven-voice"
                  value={voice.elevenLabsVoiceId}
                  placeholder="Default (George)"
                  onChange={(event) => setVoice({ elevenLabsVoiceId: event.target.value })}
                />
                <InputGroupAddon align="inline-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <InputGroupButton>Library</InputGroupButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
                      <DropdownMenuLabel>Voice library</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup
                        value={voice.elevenLabsVoiceId || DEFAULT}
                        onValueChange={(value) =>
                          setVoice({ elevenLabsVoiceId: value === DEFAULT ? '' : value })
                        }
                      >
                        <DropdownMenuRadioItem value={DEFAULT}>Default (George)</DropdownMenuRadioItem>
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
                You can also enter a voice ID directly from the Voice Library. George is the default.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="set-eleven-model">Model</FieldLabel>
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
                Choose a model, then preview the voice to compare its sound and response time.
              </FieldDescription>
            </Field>
          </FieldSet>
        </Fade>
      ) : null}

      {!failed && voice.engine === 'openai' ? (
        <Fade delay={100}>
          <FieldSet>
            <FieldLegend variant="label">OpenAI</FieldLegend>
            <Field>
              <FieldLabel htmlFor="set-openai-voice">Voice</FieldLabel>
              <EntityCombobox
                id="set-openai-voice"
                options={openaiOptions}
                value={voice.openaiVoice || null}
                onChange={(value) => setVoice({ openaiVoice: value ?? '' })}
                placeholder="Search voices"
                emptyLabel="No voice found"
                clearable={false}
              />
              <FieldDescription>
                Onyx is the default. Style instructions add the butler register to the selected voice.
              </FieldDescription>
            </Field>
          </FieldSet>
        </Fade>
      ) : null}

      {!failed && voice.engine === 'browser' ? (
        <Fade delay={100}>
          <FieldSet>
            <FieldLegend variant="label">Browser</FieldLegend>
            <Field>
              <FieldLabel htmlFor="set-browser-voice">Voice</FieldLabel>
              <EntityCombobox
                id="set-browser-voice"
                options={browserOptions}
                value={voice.voiceName || null}
                onChange={(value) => setVoice({ voiceName: value ?? '' })}
                placeholder="Automatic"
                emptyLabel="No voice found"
              />
              <FieldDescription>
                Voices available on this operating system. Automatic selects a voice for the configured language.
              </FieldDescription>
            </Field>
          </FieldSet>
        </Fade>
      ) : null}

      <Fade delay={150}>
        <FieldSet>
          <FieldLegend>Sound</FieldLegend>

          <SliderField
            id="set-rate"
            label="Speed"
            {...VOICE_RATE}
            value={voice.rate}
            description="Speaking speed. 1.00 uses the voice default pace."
            onChange={(value) => setVoice({ rate: value })}
          />

          <SliderField
            id="set-pitch"
            label="Pitch"
            {...VOICE_PITCH}
            value={voice.pitch}
            description="Applies to Edge and browser voices. ElevenLabs and OpenAI ignore this setting."
            onChange={(value) => setVoice({ pitch: value })}
          />

          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="set-jarvis">Jarvis effect</FieldLabel>
              <FieldDescription>
                Adds presence EQ, light compression and a short room effect during playback.
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
              <FieldLabel htmlFor="set-clean">Speak clean text</FieldLabel>
              <FieldDescription>
                Removes code blocks, list markers and links before reading aloud.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="set-clean"
              checked={voice.speakCleanText}
              onCheckedChange={(on) => setVoice({ speakCleanText: on })}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="set-style">Speaking style</FieldLabel>
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
              Jarvis: a composed British butler, dry and concise with a touch of irony. Changes the wording of voice replies only.
            </FieldDescription>
          </Field>

          <ButtonGroup>
            <Button
              type="button"
              variant="outline"
              disabled={preview.speaking}
              onClick={() => {
                preview.unlock();
                preview.speak('Good evening. All systems are running. Ready when you are.');
              }}
            >
              {preview.speaking ? <Spinner aria-label="Speaking" /> : null}
              Preview voice
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!preview.speaking}
              onClick={() => preview.stop()}
            >
              <SquareIcon data-icon="inline-start" />
              Stop
            </Button>
          </ButtonGroup>
          <FieldDescription>
            Uses the settings on this screen, including unsaved changes.
            {preview.error ? ' Server voice failed: ' + preview.error : ''}
          </FieldDescription>
        </FieldSet>
      </Fade>

      <Fade delay={200}>
        <FieldSet>
          <FieldLegend>Recognition</FieldLegend>
          <FieldDescription>Applies to voice conversations and composer dictation.</FieldDescription>

          <Field>
            <FieldLabel htmlFor="set-lang">Language</FieldLabel>
            <Input
              id="set-lang"
              value={voice.lang}
              placeholder="en-GB"
              onChange={(event) => setVoice({ lang: event.target.value })}
            />
            <FieldDescription>
              A BCP 47 language code. Controls speech recognition and voice filtering.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="set-wake">Wake word</FieldLabel>
            <Input
              id="set-wake"
              value={voice.wakeWord}
              placeholder="optional"
              onChange={(event) => setVoice({ wakeWord: event.target.value })}
            />
            <FieldDescription>
              Can be enabled in voice mode. Without a wake word, every utterance is accepted.
            </FieldDescription>
          </Field>
        </FieldSet>
      </Fade>
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
  const hint = [entry.lang, entry.gender === 'male' ? 'm' : entry.gender === 'female' ? 'f' : '']
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
      <Fade>
        <FieldSet>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="set-memory-enabled">Use memory</FieldLabel>
              <FieldDescription>
                When off, saved memories are not recalled. Existing memories remain stored.
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
              <FieldLabel htmlFor="set-memory-extract">Learn automatically</FieldLabel>
              <FieldDescription>
                After each exchange, the assistant checks what is worth remembering.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="set-memory-extract"
              checked={memory.autoExtract}
              onCheckedChange={(on) => setMemory({ autoExtract: on })}
            />
          </Field>
        </FieldSet>
      </Fade>

      <Fade delay={50}>
        <FieldSet>
          <FieldLegend variant="label">Recall</FieldLegend>

          <NumberField
            id="set-memory-recall"
            label="Memories per reply"
            value={memory.recallLimit}
            min={0}
            max={50}
            suffix="items"
            description="Maximum number of matching memories recalled for a reply."
            onChange={(value) => setMemory({ recallLimit: value })}
          />

          <SliderField
            id="set-memory-threshold"
            label="Minimum match score"
            value={memory.recallThreshold}
            min={0}
            max={1}
            step={0.01}
            fallback={0.12}
            format={(value) => formatPercent(Math.round(value * 100))}
            description="How closely a memory must match the topic to appear. Higher values are stricter."
            onChange={(value) => setMemory({ recallThreshold: value })}
          />
        </FieldSet>
      </Fade>

      <Fade delay={100}>
        <FieldSet>
          <FieldLegend variant="label">Context size</FieldLegend>

          <NumberField
            id="set-memory-window"
            label="Working window"
            value={memory.workingWindow}
            min={0}
            max={200}
            suffix="messages"
            description="How many recent messages are included verbatim when rebuilding context."
            onChange={(value) => setMemory({ workingWindow: value })}
          />

          <NumberField
            id="set-memory-budget"
            label="Context budget"
            value={memory.contextBudget}
            min={200}
            max={200000}
            suffix="characters"
            description="The budget for context contributed by memory."
            onChange={(value) => setMemory({ contextBudget: value })}
          />
        </FieldSet>
      </Fade>
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
    <Fade>
      <FieldSet>
        <NumberField
          id="set-concurrency"
          label="Concurrent assignments"
          value={draft.org.maxConcurrentAssignments}
          min={1}
          max={16}
          suffix="processes"
          description="Maximum number of agent processes running at once."
          onChange={(value) => setOrg({ maxConcurrentAssignments: value })}
        />

        <NumberField
          id="set-depth"
          label="Delegation depth"
          value={draft.org.maxDelegationDepth}
          min={1}
          max={6}
          suffix="levels"
          description="How many levels agents can delegate below the assistant."
          onChange={(value) => setOrg({ maxDelegationDepth: value })}
        />

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="set-lazy">Keep code minimal</FieldLabel>
            <FieldDescription>
              Agents receive Ponytail instructions: understand the task, check what already exists, and use the smallest working solution. Validation, error handling, security and accessibility remain required.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="set-lazy"
            checked={draft.org.lazyCoding}
            onCheckedChange={(on) => setOrg({ lazyCoding: on })}
          />
        </Field>
      </FieldSet>
    </Fade>
  );
}

/* -------------------------------- listeners ------------------------------- */

/** What a new mailbox starts as: implicit TLS on 993, and off until it is finished. */
const NEW_LISTENER: ImapListenerConfig = {
  id: '',
  enabled: false,
  host: '',
  port: 993,
  secure: true,
  user: '',
  password: '',
  mailbox: 'INBOX',
  jobId: '',
};

/**
 * The mailboxes Rookery keeps a connection to.
 *
 * A listener is the cheap half of an event-driven schedule: instead of a job
 * that polls a mailbox every few minutes and pays for a model call each time,
 * the server holds one connection open and fires the schedule the moment mail
 * arrives. The mailboxes themselves are part of the config draft like every
 * other section on this page, so the header's "Save" writes them; only the
 * state beside each row comes from `GET /api/listeners`.
 */
function ListenersSection({
  draft,
  setListeners,
}: {
  draft: PublicConfig;
  setListeners(imap: ImapListenerConfig[]): void;
}) {
  const { listeners: live, refresh } = useListeners();
  const cron = useCronState();

  const entries = draft.listeners?.imap ?? [];

  const jobOptions = useMemo<EntityOption[]>(
    () =>
      cron.jobs
        .filter((job) => job.kind !== 'sleep')
        .map((job) => ({
          value: job.id,
          label: job.name,
          hint: job.triggerMode === 'event' ? 'event' : job.schedule,
        })),
    [cron.jobs],
  );

  return (
    <Fade>
      <FieldSet>
        <FieldLegend variant="label">Mailboxes</FieldLegend>
        <FieldDescription>
          One connection stays open per mailbox, and the chosen schedule runs when mail arrives.
          Nothing is polled, and a mailbox that stays empty costs nothing.
        </FieldDescription>

        {entries.length === 0 ? (
          <FieldDescription>No mailbox is being watched.</FieldDescription>
        ) : null}

        {entries.map((entry, index) => (
          <ListenerRow
            key={index}
            entry={entry}
            index={index}
            status={live.find((candidate) => candidate.id === entry.id)}
            jobOptions={jobOptions}
            onChange={(change) =>
              setListeners(
                entries.map((current, position) =>
                  position === index ? { ...current, ...change } : current,
                ),
              )
            }
            onRemove={() => setListeners(entries.filter((_, position) => position !== index))}
          />
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setListeners([...entries, { ...NEW_LISTENER }])}
          >
            Add mailbox
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
            Refresh status
          </Button>
        </div>
      </FieldSet>
    </Fade>
  );
}

/**
 * One mailbox.
 *
 * The password is write-only, exactly like the Telegram token: the browser
 * never receives it, an empty field on save keeps whatever is stored, and
 * clearing it is its own deliberate act rather than something an empty field
 * could do by accident.
 */
function ListenerRow({
  entry,
  index,
  status,
  jobOptions,
  onChange,
  onRemove,
}: {
  entry: ImapListenerConfig;
  index: number;
  status: ListenerStatus | undefined;
  jobOptions: readonly EntityOption[];
  onChange(change: Partial<ImapListenerConfig>): void;
  onRemove(): void;
}) {
  // The typed port lives here until it parses, so clearing the field to type
  // a new one cannot put `NaN` or a stray `0` in the draft.
  const [rawPort, setRawPort] = useState<string | null>(null);
  const shownPort = rawPort ?? String(entry.port);
  const parsedPort = Number(shownPort);
  const invalidPort =
    shownPort.trim() === '' ||
    !Number.isInteger(parsedPort) ||
    parsedPort < 1 ||
    parsedPort > 65535;

  const look = status ? listenerStateLook(status) : null;
  const clearing = entry.password === null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <FieldTitle className="flex-1">{entry.id || 'New mailbox'}</FieldTitle>
        {look ? (
          <Badge variant={look.variant} className="gap-1">
            {look.icon ? <look.icon className={look.iconClassName} aria-hidden="true" /> : null}
            {look.label}
          </Badge>
        ) : (
          <Badge variant="outline">Not saved yet</Badge>
        )}
        <Switch
          checked={entry.enabled}
          aria-label={entry.enabled ? 'Stop watching this mailbox' : 'Watch this mailbox'}
          onCheckedChange={(on) => onChange({ enabled: on })}
        />
      </div>

      {status?.lastError ? (
        <FieldDescription className="text-destructive">{status.lastError}</FieldDescription>
      ) : null}
      {status?.lastEventAt ? (
        <FieldDescription>
          {'Last event ' + timeAgo(status.lastEventAt)}
          {status.lastFiredAt ? ' · last run ' + timeAgo(status.lastFiredAt) : ''}
        </FieldDescription>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={'listener-id-' + index}>Name</FieldLabel>
          <Input
            id={'listener-id-' + index}
            value={entry.id}
            placeholder="work"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange({ id: event.target.value })}
          />
          <FieldDescription>{'Runs record it as imap:' + (entry.id || 'name') + '.'}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor={'listener-job-' + index}>Schedule</FieldLabel>
          <EntityCombobox
            id={'listener-job-' + index}
            options={jobOptions}
            value={entry.jobId || null}
            onChange={(jobId) => onChange({ jobId: jobId ?? '' })}
            placeholder="Select schedule"
            emptyLabel="No schedule found"
          />
          <FieldDescription>What runs when this mailbox reports mail.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor={'listener-host-' + index}>Server</FieldLabel>
          <Input
            id={'listener-host-' + index}
            value={entry.host}
            placeholder="imap.example.com"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange({ host: event.target.value })}
          />
        </Field>

        <Field data-invalid={invalidPort || undefined}>
          <FieldLabel htmlFor={'listener-port-' + index}>Port</FieldLabel>
          <Input
            id={'listener-port-' + index}
            inputMode="numeric"
            value={shownPort}
            aria-invalid={invalidPort || undefined}
            onChange={(event) => {
              const next = event.target.value;
              setRawPort(next);
              const port = Number(next);
              if (next.trim() !== '' && Number.isInteger(port) && port >= 1 && port <= 65535) {
                onChange({ port });
              }
            }}
            onBlur={() => setRawPort(null)}
          />
          <FieldError>{invalidPort ? 'Enter a port between 1 and 65535.' : null}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor={'listener-user-' + index}>User</FieldLabel>
          <Input
            id={'listener-user-' + index}
            value={entry.user}
            placeholder="name@example.com"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange({ user: event.target.value })}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={'listener-mailbox-' + index}>Mailbox</FieldLabel>
          <Input
            id={'listener-mailbox-' + index}
            value={entry.mailbox}
            placeholder="INBOX"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange({ mailbox: event.target.value })}
          />
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor={'listener-password-' + index}>Password</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={'listener-password-' + index}
            className="min-w-0 flex-1"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={clearing}
            value={entry.password ?? ''}
            placeholder={
              clearing
                ? 'Will be removed when you save'
                : status?.configured
                  ? 'Saved — leave empty to keep it'
                  : 'Mailbox password'
            }
            onChange={(event) => onChange({ password: event.target.value })}
          />
          {clearing ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ password: '' })}>
              Keep it
            </Button>
          ) : status?.configured ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ password: null })}>
              Clear
            </Button>
          ) : null}
        </div>
        <FieldDescription>
          The password stays on the server and is never sent back to this page.
        </FieldDescription>
      </Field>

      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove mailbox
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------- view --------------------------------- */

const LOCAL_HINT = 'Applies immediately and is saved in this browser only.';

/**
 * Appearance preferences never reach the server.
 *
 * They sit in their own section instead of hanging below the tabs, because
 * the two storage models are genuinely different: everything else on this
 * page needs "Speichern" and then applies everywhere, these apply at once and
 * only here. The theme choice is the same one the sidebar footer offers; the
 * toggler cycles light, dark and system, and the icon says where the cycle
 * stands.
 */
function ViewSection() {
  return (
    <Fade>
      <FieldSet>
        <FieldLegend variant="label">Theme</FieldLegend>
        <FieldDescription>{LOCAL_HINT}</FieldDescription>
        {/*
          Policy B9: der Radio-Dreier ist einem ThemeTogglerButton gewichen,
          der zyklisch light - dark - system schaltet und den Wechsel als
          Wisch ueber die Flaeche zieht. Optik an unseren Outline-Button
          angeglichen (Muted statt Accent beim Hover).
        */}
        <ThemeTogglerButton
          variant="outline"
          aria-label="Change theme"
          className="hover:bg-muted hover:text-foreground"
        />
      </FieldSet>
    </Fade>
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
        {invalid ? 'Enter a whole number between ' + min + ' and ' + max + '.' : null}
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
