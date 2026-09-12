import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router';
import { ChevronDownIcon, MoonIcon, PlusIcon, SunIcon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { api } from '@/lib/api';
import {
  MEMORY_KIND_LABEL,
  MEMORY_KINDS,
  SLEEP_PHASE_DETAIL,
  SLEEP_PHASE_LABEL,
} from '@/lib/format';
import { formatNumber, formatPercent } from '@/lib/stats';
import type { MemoryKind } from '@/lib/types';
import { useMemoryState } from '@/providers/rookery-provider';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards, type StatCardProps } from '@/components/blocks/stat-cards';
import { collectErrors, type FieldErrors } from '@/components/forms/form-kit';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

/**
 * The memory, three ways - and the frame all three share.
 *
 * The three views used to be `Tabs` inside one page, which meant a link into
 * the net or into last night's report did not exist: everything was `/memory`.
 * They are routes now, and this layout is what stays put across them - the
 * headline numbers, the running night, the tab row.
 *
 * Neither number is summed over a capped list: `GET /api/memories/stats`
 * counts in SQL (`memoryStats` in `core/memory/store.ts`), and the growth
 * badge comes from `GET /api/stats`, which groups by day in the database.
 * They still count different things - the total only what is awake, the badge
 * everything ever learned - so the card says so in its footnote.
 *
 * The night's `SleepCard` is gone as a permanent block above everything: a
 * card that mostly said "nothing is happening" earned its space perhaps once
 * a day. While a night actually runs, one row appears under the cards; the
 * rest of what the card held lives on `/memory/sleep`.
 */

/** How far back the growth badge counts. Whole local days, including today. */
const GROWTH_DAYS = 7;

/** The stages of a night, in order - the row's progress bar walks them. */
const SLEEP_PHASES = ['started', 'light', 'deep', 'rem', 'finished'] as const;

const TABS = [
  { to: '/memory', label: 'Erinnerungen', end: true },
  { to: '/memory/graph', label: 'Netz', end: false },
  { to: '/memory/sleep', label: 'Nächte', end: false },
] as const;

/** What the three child routes may reach back into the frame for. */
export interface MemoryOutletContext {
  /**
   * Opens the shared "Merken" dialog. The header button and the list's
   * toolbar button are the same dialog, so a half-typed memory survives a
   * click on the wrong one.
   */
  openRemember(): void;
}

export function useMemoryOutlet(): MemoryOutletContext {
  return useOutletContext<MemoryOutletContext>();
}

function phaseProgress(phase: string): number {
  const index = SLEEP_PHASES.indexOf(phase as (typeof SLEEP_PHASES)[number]);
  if (index < 0) return 0;
  return (index / (SLEEP_PHASES.length - 1)) * 100;
}

export function MemoryLayout() {
  const { pathname } = useLocation();
  const { memories, sleep } = useMemoryState();
  const [rememberOpen, setRememberOpen] = useState(false);

  const active = useMemo(() => {
    const match = [...TABS].reverse().find((tab) => (tab.end ? pathname === tab.to : pathname.startsWith(tab.to)));
    return match ?? TABS[0];
  }, [pathname]);

  const running = sleep.status?.running ?? false;
  const busy = sleep.busy;

  const openRemember = useCallback(() => setRememberOpen(true), []);

  const startNight = useCallback(async (): Promise<void> => {
    const ok = await sleep.start();
    if (ok) toast('Die Nacht läuft', { description: 'Der Fortschritt steht über den Reitern.' });
    else toast.error('Die Nacht konnte nicht gestartet werden');
  }, [sleep]);

  usePageMeta(
    {
      breadcrumb: [{ label: 'Gedächtnis', to: '/memory' }, { label: active.label }],
      // "Merken" is the primary action; running a night is an operational one
      // and moves into the overflow menu rather than sitting glued beside it as
      // an equal. A night in progress is the exception - then the way to stop
      // it has to be visible, not two clicks deep.
      actions: (
        <>
          <Button size="sm" onClick={openRemember}>
            <PlusIcon data-icon="inline-start" />
            Merken
          </Button>
          {running && (
            <Button size="sm" variant="outline" onClick={() => void sleep.cancel()}>
              <Spinner data-icon="inline-start" aria-hidden="true" />
              Aufwecken
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton tone="header" label="Weitere Aktionen für das Gedächtnis" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={busy || running} onSelect={() => void startNight()}>
                {busy ? <Spinner aria-hidden="true" /> : <MoonIcon />}
                Jetzt schlafen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ),
    },
    [busy, openRemember, running, sleep, startNight],
  );

  /* ------------------------------ die Zahlen ------------------------------ */

  const stats = memories.stats;
  const total = stats?.total ?? null;

  // Real growth, counted in the database rather than over the loaded nodes.
  // It is refetched whenever the total moves, which is every write to the bank
  // and every finished night.
  const [growth, setGrowth] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .stats({ days: GROWTH_DAYS })
      .then((snapshot) => {
        if (cancelled) return;
        setGrowth(snapshot.series.reduce((sum, day) => sum + day.memories, 0));
      })
      .catch(() => {
        if (!cancelled) setGrowth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [total]);

  const waiting = <Skeleton className="h-7 w-16" />;

  const cards: StatCardProps[] = [
    {
      label: 'Erinnerungen',
      value: stats ? formatNumber(stats.total) : waiting,
      // "gelernt", nicht "dazugekommen": die Tagesreihe zählt jede neu
      // angelegte Erinnerung, die Zahl darüber nur die noch wachen. Eine
      // Nacht, die das Gelernte verdichtet oder einschläfert, senkt die Zahl,
      // ohne das Badge anzufassen - die Fußnote sagt das, statt die beiden
      // wie dieselbe Menge aussehen zu lassen.
      ...(growth !== null && growth > 0
        ? {
            badge: (
              <Badge variant="outline">
                +{formatNumber(growth)} gelernt in {GROWTH_DAYS} Tagen
              </Badge>
            ),
          }
        : {}),
      headline: stats ? formatNumber(stats.forgotten) + ' vergessen' : ' ',
      footnote:
        'Wache Erinnerungen. Neu gelernt zählt auch inzwischen verdichtete Einträge.',
      to: '/memory',
    },
    {
      label: 'Angeheftet',
      value: stats ? formatNumber(stats.pinned) : waiting,
      headline: 'Nachtfest',
      footnote: 'Angeheftetes rührt das nächtliche Aufräumen nicht an',
    },
    {
      label: 'Schlafend',
      value: stats ? formatNumber(stats.dormant) : waiting,
      headline: 'Wird beim Erinnern übersprungen',
      footnote: 'Nicht gelöscht — ein Klick holt eine schlafende Erinnerung zurück',
    },
    {
      label: 'Verbindungen',
      value: stats ? formatNumber(stats.edges) : waiting,
      headline: stats
        ? 'Über ' + formatNumber(stats.entities) + (stats.entities === 1 ? ' Thema' : ' Themen')
        : ' ',
      footnote: 'Kanten zwischen zwei Erinnerungen, meist im Schlaf gezogen',
      to: '/memory/graph',
    },
  ];

  // Keep the view switcher on every route; only the overview needs the cards.
  const isIndex = active.to === TABS[0]?.to;

  return (
    <PageBody>
      {isIndex && <StatCards items={cards} />}

      {running ? (
        <div className="px-4 lg:px-6">
          <Item variant="outline" size="sm">
            <ItemMedia variant="icon">
              <Spinner aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{SLEEP_PHASE_LABEL[sleep.phase] ?? 'arbeitet'}</Badge>
                {sleep.cycle > 0 ? (
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    Zyklus {formatNumber(sleep.cycle)}
                  </span>
                ) : null}
              </ItemTitle>
              <ItemDescription>
                {SLEEP_PHASE_DETAIL[sleep.phase] ?? 'Das Gedächtnis wird gerade umgeräumt.'}
              </ItemDescription>
              <Progress
                value={phaseProgress(sleep.phase)}
                aria-label="Fortschritt der Nacht"
                className="mt-2 h-1"
              />
            </ItemContent>
            <ItemActions>
              <Button size="sm" variant="outline" onClick={() => void sleep.cancel()}>
                <SunIcon data-icon="inline-start" />
                Aufwecken
              </Button>
            </ItemActions>
          </Item>
        </div>
      ) : null}

      {/*
        Radix' tabs give the routes the block's own tab look and its keyboard
        handling; the triggers are `NavLink`s underneath, so each view has a
        URL somebody can send.

        The outlet sits in a `TabsContent` inside the same root, exactly as in
        `OrgLayout`: every trigger announces an `aria-controls`, and without a
        panel of that id the promise points at nothing.
      */}
      <Tabs value={active.to} className="min-h-0 flex-1 gap-4">
          <div className="px-4 lg:px-6">
            <TabsList>
              {TABS.map((tab) => (
                <TabsTrigger key={tab.to} value={tab.to} asChild>
                  <NavLink to={tab.to} end={tab.end}>
                    {tab.label}
                  </NavLink>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

        <TabsContent
          value={active.to}
          forceMount
          className="flex min-h-0 flex-1 flex-col gap-4 md:gap-6"
        >
          <Outlet context={{ openRemember } satisfies MemoryOutletContext} />
        </TabsContent>
      </Tabs>

      <RememberDialog open={rememberOpen} onOpenChange={setRememberOpen} onAdd={memories.add} />
    </PageBody>
  );
}

/* -------------------------------- merken --------------------------------- */

const rememberSchema = z.object({
  content: z.string().trim().min(3, 'Ein Satz reicht — aber einer muss es sein.'),
  kind: z.enum(['fact', 'preference', 'project', 'event', 'summary', 'insight']),
  tags: z.string(),
  importance: z.number().min(0).max(1),
});

interface RememberDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdd(input: {
    content: string;
    kind?: MemoryKind;
    tags?: string[];
    importance?: number;
  }): Promise<boolean>;
}

/**
 * "Merken", as a dialog rather than the permanent two-line form that used to
 * sit in the foot of the memory panel.
 *
 * It is the only way into the bank by hand, and what it writes carries
 * `origin: 'user'` on the server - which is what protects it from the night.
 * That is worth a sentence in the dialog, because it is the difference
 * between a note and a note that survives.
 */
function RememberDialog({ open, onOpenChange, onAdd }: RememberDialogProps) {
  const formId = useId();
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [tags, setTags] = useState('');
  const [importance, setImportance] = useState(0.7);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const reset = useCallback(() => {
    setContent('');
    setKind('fact');
    setTags('');
    setImportance(0.7);
    setErrors({});
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    const parsed = rememberSchema.safeParse({ content, kind, tags, importance });
    if (!parsed.success) {
      setErrors(collectErrors(parsed.error));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const list = parsed.data.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      const ok = await onAdd({
        content: parsed.data.content,
        kind: parsed.data.kind,
        importance: parsed.data.importance,
        ...(list.length ? { tags: list } : {}),
      });
      if (!ok) {
        toast.error('Nicht gemerkt', { description: 'Der Server hat die Erinnerung nicht angenommen.' });
        return;
      }
      toast('Gemerkt', { description: parsed.data.content });
      reset();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }, [content, importance, kind, onAdd, onOpenChange, reset, tags]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Etwas merken</DialogTitle>
          <DialogDescription>
            Von Hand Gemerktes bleibt im nächtlichen Aufräumen unangetastet.
          </DialogDescription>
        </DialogHeader>

        <form
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={formId + '-content'}>Inhalt</FieldLabel>
              <Textarea
                id={formId + '-content'}
                rows={3}
                value={content}
                aria-invalid={errors.content ? true : undefined}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Zum Beispiel: Rookery läuft lokal, ohne Cloud."
              />
              <FieldDescription>
                Ein ganzer Satz erinnert sich besser als ein Stichwort.
              </FieldDescription>
              {errors.content ? <FieldError>{errors.content}</FieldError> : null}
            </Field>

            <Field>
              <FieldLabel htmlFor={formId + '-kind-fact'}>Art</FieldLabel>
              <RadioGroup
                value={kind}
                onValueChange={(value) => setKind(value as MemoryKind)}
                className="grid grid-cols-1 gap-2 sm:grid-cols-2"
              >
                {MEMORY_KINDS.map((value) => (
                  <FieldLabel key={value} htmlFor={formId + '-kind-' + value}>
                    <Field orientation="horizontal">
                      <RadioGroupItem id={formId + '-kind-' + value} value={value} aria-label={MEMORY_KIND_LABEL[value]} />
                      <FieldTitle>{MEMORY_KIND_LABEL[value]}</FieldTitle>
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
            </Field>

            <Field>
              <FieldLabel htmlFor={formId + '-tags'}>Themen</FieldLabel>
              <Input
                id={formId + '-tags'}
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="Rookery, Gedächtnis"
              />
              <FieldDescription>
                Kommagetrennt. Themen verbinden diese Erinnerung im Netz mit anderen.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={formId + '-importance'}>Wichtigkeit</FieldLabel>
              <div className="flex items-center gap-3">
                <Slider
                  id={formId + '-importance'}
                  min={0}
                  max={1}
                  step={0.05}
                  value={[importance]}
                  onValueChange={(value) => setImportance(value[0] ?? 0.7)}
                  className="flex-1"
                />
                <Badge variant="secondary" className="tabular-nums">
                  {formatPercent(importance * 100)}
                </Badge>
              </div>
              <FieldDescription>
                Wichtiges wird eher erinnert und überlebt das Verdichten.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? <Spinner aria-label="Wird gespeichert" data-icon="inline-start" /> : null}
            Merken
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
