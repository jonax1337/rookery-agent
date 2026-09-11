import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CalendarClockIcon, ChevronDownIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, type CronJobInput, type CronJobPatch } from '@/lib/api';
import { CRON_PRESETS } from '@/lib/cron';
import { reportFailure } from '@/lib/errors';
import {
  PERMISSION_CHOICES,
  STANDARD_CHOICE,
  formatDateTime,
  type PermissionChoice,
} from '@/lib/format';
import type { CronJob, CronPreview } from '@/lib/types';
import { useCronState, useOrgState } from '@/providers/rookery-provider';
import { PageBody } from '@/components/blocks/page-body';
import { FormPage } from '@/components/blocks/form-page';
import { usePageMeta } from '@/components/shell/page-meta';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import {
  ChoiceField,
  FormFieldsSkeleton,
  FormHeaderActions,
  useDraft,
  useFormSubmit,
  type ChoiceOption,
} from '@/components/forms/form-kit';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Item, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/**
 * A standing order: a prompt that fires on a cron expression.
 *
 * The server owns the parser, so the form never guesses what an expression
 * means - it asks `GET /api/cron/preview` and shows the answer in its own
 * card. That card is also the gate: while the server says the expression is
 * wrong, "Speichern" is disabled, instead of letting the save go out and
 * turning the refusal into a toast.
 *
 * The eight presets moved into the field itself. There used to be a second
 * select next to the expression plus a `'__custom__'` sentinel to keep the
 * two in sync; a menu that writes into the one input needs neither.
 */

const PROMPT_PLACEHOLDER =
  'Was bei jedem Lauf zu tun ist, so dass es ohne Rückfragen geht. Etwa: „Sieh dir die offenen ' +
  'Aufgaben und die Aufträge der letzten 24 Stunden an und fasse in fünf Sätzen zusammen, was ' +
  'passiert ist und was heute ansteht.“';

type RunnerChoice = 'assistant' | 'agent';

interface CronDraft {
  name: string;
  schedule: string;
  prompt: string;
  runner: RunnerChoice;
  agentId: string | null;
  projectId: string | null;
  permission: PermissionChoice;
  once: boolean;
  enabled: boolean;
}

const EMPTY: CronDraft = {
  name: '',
  schedule: CRON_PRESETS[0]?.schedule ?? '0 8 * * *',
  prompt: '',
  runner: 'assistant',
  agentId: null,
  projectId: null,
  permission: STANDARD_CHOICE,
  once: false,
  enabled: true,
};

const schema = z
  .object({
    name: z.string().trim().min(1, 'Ein Name ist Pflicht.'),
    schedule: z.string().trim().min(1, 'Ohne Ausdruck feuert nichts.'),
    prompt: z.string().trim().min(1, 'Ohne Anweisung weiß der Lauf nicht, was er tun soll.'),
    runner: z.enum(['assistant', 'agent']),
    agentId: z.string().nullable(),
  })
  .superRefine((value, context) => {
    if (value.runner === 'agent' && !value.agentId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentId'],
        message: 'Ein Agentenzeitplan braucht einen Agenten.',
      });
    }
  });

const RUNNER_OPTIONS: ChoiceOption<RunnerChoice>[] = [
  {
    value: 'assistant',
    label: 'Der Assistent',
    description: 'Arbeitet in einem eigenen Gespräch mit all seinen Werkzeugen.',
  },
  {
    value: 'agent',
    label: 'Ein Agent',
    description: 'Bekommt bei jedem Lauf einen Auftrag im Projektverzeichnis.',
  },
];

function draftOf(job: CronJob): CronDraft {
  return {
    name: job.name,
    schedule: job.schedule,
    prompt: job.prompt,
    runner: job.kind === 'agent' ? 'agent' : 'assistant',
    agentId: job.agentId ?? null,
    projectId: job.projectId ?? null,
    permission: job.permission ?? STANDARD_CHOICE,
    once: job.once,
    enabled: job.enabled,
  };
}

/**
 * One shape for create and update. `kind` is left out on purpose: the
 * scheduler derives it from `agentId` (`null` means the assistant), so
 * sending both would be two sources for one fact.
 */
function buildPatch(draft: CronDraft): CronJobPatch {
  return {
    name: draft.name.trim(),
    schedule: draft.schedule.trim(),
    prompt: draft.prompt.trim(),
    agentId: draft.runner === 'agent' ? draft.agentId : null,
    projectId: draft.projectId,
    permission: draft.permission === STANDARD_CHOICE ? null : draft.permission,
    once: draft.once,
    enabled: draft.enabled,
  };
}

function toInput(patch: CronJobPatch): CronJobInput {
  return {
    name: patch.name ?? '',
    schedule: patch.schedule ?? '',
    prompt: patch.prompt ?? '',
    ...(patch.agentId ? { agentId: patch.agentId } : {}),
    ...(patch.projectId ? { projectId: patch.projectId } : {}),
    ...(patch.permission ? { permission: patch.permission } : {}),
    once: patch.once ?? false,
    enabled: patch.enabled ?? true,
  };
}

export function CronFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const cron = useCronState();
  const org = useOrgState();
  const { confirm, dialog } = useConfirm();

  const editing = Boolean(id);
  const job = cron.jobById(id);

  const formId = useId();
  const { draft, dirty, set, hydrate, markSaved } = useDraft<CronDraft>(EMPTY);
  const [preview, setPreview] = useState<CronPreview | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!job) return;
    hydrate(job.id, () => draftOf(job));
  }, [hydrate, job]);

  /* -------------------------------- Vorschau ------------------------------ */

  // Debounced, because the endpoint is cheap but one request per keystroke is
  // not, and the answer for a half-typed expression is noise either way.
  useEffect(() => {
    const wanted = draft.schedule.trim();
    if (!wanted) {
      setPreview(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .cronPreview(wanted)
        .then((next) => {
          if (!cancelled) setPreview(next);
        })
        // A failed request is not an invalid expression: leave the last
        // answer standing rather than claiming the timetable is broken.
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft.schedule]);

  const invalidSchedule = preview !== null && !preview.ok;

  /* -------------------------------- Auswahl ------------------------------- */

  const agentOptions = useMemo<EntityOption[]>(
    () =>
      org.agents
        .filter((agent) => !agent.archived)
        .map((agent) => ({ value: agent.id, label: agent.name, hint: agent.title })),
    [org.agents],
  );

  const projectOptions = useMemo<EntityOption[]>(
    () =>
      org.projects
        .filter((project) => !project.archived)
        .map((project) => ({ value: project.id, label: project.name })),
    [org.projects],
  );

  /* -------------------------------- Sichern ------------------------------- */

  const { errors, failure, saving, submit } = useFormSubmit(schema, draft, async () => {
    const patch = buildPatch(draft);
    const saved =
      editing && id ? await api.updateCronJob(id, patch) : await api.createCronJob(toInput(patch));
    markSaved();
    await cron.refresh();
    toast(editing ? 'Zeitplan gespeichert' : 'Zeitplan angelegt', {
      ...(preview?.ok ? { description: preview.description } : {}),
    });
    void navigate('/cron/' + saved.id);
  });

  const remove = useCallback(async (): Promise<void> => {
    if (!id || !job) return;
    const ok = await confirm({
      title: 'Zeitplan löschen?',
      description:
        'Der Zeitplan „' +
        job.name +
        '“ feuert danach nicht mehr. Bereits gelaufene Aufträge und Gespräche bleiben erhalten.',
      confirmLabel: 'Löschen',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteCronJob(id);
      await cron.refresh();
      toast('Zeitplan gelöscht', { description: job.name });
      void navigate('/cron');
    } catch (caught) {
      reportFailure('Löschen', caught);
    }
  }, [confirm, cron, id, job, navigate]);

  /* --------------------------------- Kopf --------------------------------- */

  const leaf = editing ? (job?.name ?? 'Zeitplan bearbeiten') : 'Zeitplan anlegen';

  usePageMeta(
    {
      breadcrumb: [{ label: 'Zeitpläne', to: '/cron' }, { label: leaf }],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo={editing && id ? '/cron/' + id : '/cron'}
          submitting={saving}
          submitDisabled={!dirty || saving || invalidSchedule}
          menu={
            editing
              ? [
                  {
                    label: 'Löschen',
                    icon: Trash2Icon,
                    destructive: true,
                    onSelect: () => void remove(),
                  },
                ]
              : []
          }
        />
      ),
    },
    [dirty, editing, formId, id, invalidSchedule, remove, saving],
  );

  /* ------------------------------- Zustände ------------------------------- */

  if (editing && !job && !cron.loading) {
    return (
      <PageBody width="3xl">
        <EmptyState
          icon={CalendarClockIcon}
          title="Diesen Zeitplan gibt es nicht mehr"
          description="Er wurde gelöscht oder hat nie existiert."
          actionLabel="Zu den Zeitplänen"
          actionTo="/cron"
        />
      </PageBody>
    );
  }

  // `sleep` ist die Zeile des Systems: `ensureSleepSchedule` legt sie immer
  // wieder an, und ihre Uhrzeit gehört den Gedächtnis-Einstellungen.
  if (job?.kind === 'sleep') {
    return (
      <PageBody width="3xl">
        <EmptyState
          icon={CalendarClockIcon}
          title="Dieser Zeitplan gehört dem System"
          description="Die Nacht des Gedächtnisses wird in den Einstellungen eingestellt, nicht hier."
          actionLabel="Zu den Einstellungen"
          actionTo="/settings/memory"
        />
      </PageBody>
    );
  }

  if (editing && !job) {
    return (
      <PageBody width="3xl">
        <FormFieldsSkeleton fields={5} />
      </PageBody>
    );
  }

  /* -------------------------------- Vorschau ------------------------------ */

  const previewCard = (
    <Card>
      {preview && preview.ok ? (
        <>
          <CardHeader>
            <CardTitle>{preview.description}</CardTitle>
            <CardDescription>
              Die nächsten Termine, in der Zeitzone des Rechners, auf dem der Server läuft.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ItemGroup className="grid gap-2 @md/main:grid-cols-2">
              {preview.next.slice(0, 5).map((at) => (
                <Item key={at} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle className="font-normal tabular-nums">
                      {formatDateTime(at)}
                    </ItemTitle>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          </CardContent>
        </>
      ) : preview && !preview.ok ? (
        <CardContent>
          <Alert variant="destructive">
            <AlertTitle>Der Ausdruck geht so nicht</AlertTitle>
            <AlertDescription>
              {preview.error ?? 'Der Server konnte den Ausdruck nicht lesen.'}
            </AlertDescription>
          </Alert>
        </CardContent>
      ) : (
        <CardContent className="flex flex-col gap-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </CardContent>
      )}
    </Card>
  );

  return (
    <PageBody width="3xl">
      {dialog}
      <FormPage
        formId={formId}
        showActions={false}
        onSubmit={submit}
        error={failure}
        aside={previewCard}
      >
        {/*
          Die Legende steht hier und nicht als Kartenkopf: ohne sie begann die
          Karte mit dem blossen Hinweissatz, waehrend die spaeteren Abschnitte
          eine Ueberschrift trugen - der Aufbau wirkte oben abgeschnitten.
        */}
        <FieldSet>
          <FieldLegend>Zeitplan</FieldLegend>
          <FieldDescription>
            Zeiten gelten in der Zeitzone des Rechners, auf dem der Server läuft.
          </FieldDescription>
          <Field>
            <FieldLabel htmlFor="cron-schedule">Ausdruck</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="cron-schedule"
                className="font-mono"
                placeholder="Minute Stunde Tag Monat Wochentag"
                value={draft.schedule}
                aria-invalid={Boolean(errors.schedule) || invalidSchedule}
                onChange={(event) => set({ schedule: event.target.value })}
              />
              <InputGroupAddon align="inline-end">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <InputGroupButton>
                      Vorlagen
                      <ChevronDownIcon />
                    </InputGroupButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>Übliche Zeiten</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {CRON_PRESETS.map((entry) => (
                      <DropdownMenuItem
                        key={entry.schedule}
                        onSelect={() => set({ schedule: entry.schedule })}
                      >
                        {entry.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>
              Fünf Felder: Minute, Stunde, Tag, Monat, Wochentag. „0 8 * * 1-5“ ist werktags um
              08:00. {checking ? 'Wird geprüft …' : ''}
            </FieldDescription>
            <FieldError>{errors.schedule}</FieldError>
          </Field>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Nur einmal ausführen</FieldTitle>
              <FieldDescription>
                Nach dem ersten Lauf schaltet sich der Zeitplan selbst ab.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="cron-once"
              checked={draft.once}
              onCheckedChange={(once) => set({ once })}
            />
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <Field>
            <FieldLabel htmlFor="cron-runner-assistant">Ausführung</FieldLabel>
            <ChoiceField
              id="cron-runner"
              options={RUNNER_OPTIONS}
              value={draft.runner}
              onChange={(runner) => set({ runner })}
            />
          </Field>

          {draft.runner === 'agent' ? (
            <Field>
              <FieldLabel htmlFor="cron-agent">Agent</FieldLabel>
              <EntityCombobox
                id="cron-agent"
                options={agentOptions}
                value={draft.agentId}
                onChange={(agentId) => set({ agentId })}
                placeholder="Agent wählen"
                emptyLabel="Kein Agent gefunden"
                invalid={Boolean(errors.agentId)}
              />
              <FieldError>{errors.agentId}</FieldError>
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="cron-project">Projekt</FieldLabel>
            <EntityCombobox
              id="cron-project"
              options={projectOptions}
              value={draft.projectId}
              onChange={(projectId) => set({ projectId })}
              placeholder="Kein Projekt"
              emptyLabel="Kein Projekt gefunden"
            />
            <FieldDescription>
              Das Projekt entscheidet, in welchem Verzeichnis der Lauf arbeitet.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="cron-permission-standard">Zugriff</FieldLabel>
            <ChoiceField
              id="cron-permission"
              options={PERMISSION_CHOICES}
              value={draft.permission}
              onChange={(permission) => set({ permission })}
            />
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <Field>
            <FieldLabel htmlFor="cron-name">Name</FieldLabel>
            <Input
              id="cron-name"
              placeholder="z. B. Morgenbriefing"
              value={draft.name}
              aria-invalid={Boolean(errors.name)}
              onChange={(event) => set({ name: event.target.value })}
            />
            <FieldError>{errors.name}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="cron-prompt">Anweisung</FieldLabel>
            <Textarea
              id="cron-prompt"
              rows={10}
              placeholder={PROMPT_PLACEHOLDER}
              value={draft.prompt}
              aria-invalid={Boolean(errors.prompt)}
              onChange={(event) => set({ prompt: event.target.value })}
            />
            <FieldDescription>
              Jeder Lauf startet frisch: der Text muss ohne Rückfragen für sich stehen.
            </FieldDescription>
            <FieldError>{errors.prompt}</FieldError>
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Aktiv</FieldTitle>
              <FieldDescription>
                Ausgeschaltet bleibt der Zeitplan erhalten, feuert aber nicht.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="cron-enabled"
              checked={draft.enabled}
              onCheckedChange={(enabled) => set({ enabled })}
            />
          </Field>
        </FieldSet>
      </FormPage>
    </PageBody>
  );
}
