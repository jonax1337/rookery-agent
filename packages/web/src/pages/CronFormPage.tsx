import { forwardRef, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';

import { toast } from 'sonner';
import { z } from 'zod';

import { api, type CronJobInput, type CronJobPatch } from '@/lib/api';
import { isRunBlocked } from '@/lib/cron-availability';
import { MAX_COOLDOWN_SECONDS, MS_PER_SECOND, parseCooldownSeconds } from '@/lib/cron-cooldown';
import { CRON_PRESETS, CRON_TRIGGER_MODE_CHOICES, DEFAULT_EVENT_COOLDOWN_MS } from '@/lib/cron';
import {
  PERMISSION_CHOICES,
  STANDARD_CHOICE,
  formatDateTime,
  type PermissionChoice,
} from '@/lib/format';
import type { CronJob, CronPreview, CronTriggerMode } from '@/lib/types';
import { useCronState, useOrgState } from '@/providers/rookery-provider';
import { useCronPreview } from '@/hooks/useCronPreview';
import { useDeleteCronJob } from '@/hooks/useDeleteCronJob';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
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
  type FieldErrors,
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Item, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  CalendarCheckIcon as CalendarClockIcon,
  ChevronDownIcon,
  DeleteIcon as AnimatedTrash2Icon,
} from "@/components/icons";

/**
 * A standing order: a prompt that fires on a cron expression.
 *
 * The server owns the parser, so the form never guesses what an expression
 * means - it asks `GET /api/cron/preview` and shows the answer in its own
 * card. That card is also the gate: while the server says the expression is
 * wrong, "Save" is disabled, instead of letting the save go out and
 * turning the refusal into a toast.
 *
 * The eight presets moved into the field itself. There used to be a second
 * select next to the expression plus a `'__custom__'` sentinel to keep the
 * two in sync; a menu that writes into the one input needs neither.
 */

const PROMPT_PLACEHOLDER =
  'What to do on every run, written so it can be completed without follow-up questions. For example: “Review the open ' +
  'tasks and assignments from the past 24 hours, then summarize in five sentences what ' +
  'happened and what is coming up today.”';

const FALLBACK_SCHEDULE = '0 8 * * *';
const UPCOMING_PREVIEW_COUNT = 5;
const PROMPT_ROWS = 10;

type RunnerChoice = 'assistant' | 'agent' | 'script';

interface CronDraft {
  name: string;
  schedule: string;
  prompt: string;
  triggerMode: CronTriggerMode;
  /** The rest after an event-driven run, in milliseconds. */
  cooldownMs: number;
  runner: RunnerChoice;
  agentId: string | null;
  projectId: string | null;
  permission: PermissionChoice;
  once: boolean;
  enabled: boolean;
}

const EMPTY: CronDraft = {
  name: '',
  schedule: CRON_PRESETS[0]?.schedule ?? FALLBACK_SCHEDULE,
  prompt: '',
  triggerMode: 'schedule',
  cooldownMs: DEFAULT_EVENT_COOLDOWN_MS,
  runner: 'assistant',
  agentId: null,
  projectId: null,
  permission: STANDARD_CHOICE,
  once: false,
  enabled: true,
};

const schema = z
  .object({
    name: z.string().trim().min(1, 'A name is required.'),
    schedule: z.string().trim(),
    prompt: z.string().trim(),
    triggerMode: z.enum(['schedule', 'event']),
    runner: z.enum(['assistant', 'agent', 'script']),
    agentId: z.string().nullable(),
  })
  .superRefine((value, context) => {
    // An event-only schedule has no timetable, so the expression stops being
    // something the form may insist on.
    if (value.triggerMode === 'schedule' && !value.schedule) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule'],
        message: 'An expression is required.',
      });
    }
    if (value.runner !== 'script' && !value.prompt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: 'The run needs instructions.',
      });
    }
    if (value.runner === 'agent' && !value.agentId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentId'],
        message: 'An agent schedule requires an agent.',
      });
    }
  });

const RUNNER_OPTIONS: ChoiceOption<RunnerChoice>[] = [
  {
    value: 'assistant',
    label: 'The assistant',
    description: 'Works in a dedicated conversation with all available tools.',
  },
  {
    value: 'agent',
    label: 'An agent',
    description: 'Receives an assignment in the project directory on every run.',
  },
];

function draftOf(job: CronJob): CronDraft {
  return {
    name: job.name,
    schedule: job.schedule,
    prompt: job.prompt,
    triggerMode: job.triggerMode,
    cooldownMs: job.eventCooldownMs ?? DEFAULT_EVENT_COOLDOWN_MS,
    runner: job.kind === 'script' ? 'script' : job.kind === 'agent' ? 'agent' : 'assistant',
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
    // An event-only schedule keeps whatever expression was typed before the
    // mode was switched - it is the backstop the moment the clock is back on.
    schedule: draft.schedule.trim(),
    prompt: draft.prompt.trim(),
    triggerMode: draft.triggerMode,
    eventCooldownMs: draft.cooldownMs,
    ...(draft.runner === 'script' ? { kind: 'script' as const } : {}),
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
    ...(patch.triggerMode ? { triggerMode: patch.triggerMode } : {}),
    ...(patch.eventCooldownMs !== undefined ? { eventCooldownMs: patch.eventCooldownMs } : {}),
    ...(patch.agentId ? { agentId: patch.agentId } : {}),
    ...(patch.projectId ? { projectId: patch.projectId } : {}),
    ...(patch.permission ? { permission: patch.permission } : {}),
    once: patch.once ?? false,
    enabled: patch.enabled ?? true,
  };
}

const MenuTrash2Icon = forwardRef<SVGSVGElement>(function MenuTrash2Icon() {
  return <AnimatedTrash2Icon />;
});

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
  const { preview, checking } = useCronPreview(draft.schedule, draft.triggerMode);
  const invalidSchedule = preview !== null && !preview.ok;

  useEffect(() => {
    if (!job) return;
    hydrate(job.id, () => draftOf(job));
  }, [hydrate, job]);

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

  const { errors, failure, saving, submit } = useFormSubmit(schema, draft, async () => {
    const patch = buildPatch(draft);
    const saved =
      editing && id ? await api.updateCronJob(id, patch) : await api.createCronJob(toInput(patch));
    markSaved();
    await cron.refresh();
    toast(editing ? 'Schedule saved' : 'Schedule created', {
      ...(preview?.ok ? { description: preview.description } : {}),
    });
    void navigate('/cron/' + saved.id);
  });

  const deleteJob = useDeleteCronJob(confirm, cron.refresh);
  const remove = useCallback(async (): Promise<void> => {
    if (job) await deleteJob(job);
  }, [deleteJob, job]);

  const leaf = editing ? (job?.name ?? 'Edit schedule') : 'Create schedule';

  usePageMeta(
    {
      breadcrumb: [{ label: 'Schedules', to: '/cron' }, { label: leaf }],
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
                    label: 'Delete',
                    icon: MenuTrash2Icon,
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

  if (editing && !job && !cron.loading) {
    return (
      <Notice>
        <EmptyState
          icon={CalendarClockIcon}
          title="This schedule no longer exists"
          description="It was deleted or never existed."
          actionLabel="View schedules"
          actionTo="/cron"
        />
      </Notice>
    );
  }

  // `sleep` is the system's own row: `ensureSleepSchedule` recreates it
  // every time, and its time of day belongs to the memory settings.
  if (job?.kind === 'sleep') {
    return (
      <Notice>
        <EmptyState
          icon={CalendarClockIcon}
          title="This schedule belongs to the system"
          description="Configure the system sleep schedule under memory.sleep in your Rookery config.json."
          actionLabel="Back to schedules"
          actionTo="/cron"
        />
      </Notice>
    );
  }

  if (editing && !job) {
    return (
      <Notice>
        <FormFieldsSkeleton fields={5} />
      </Notice>
    );
  }

  return (
    <PageBody width="3xl">
      {dialog}
      <FormPage
        formId={formId}
        showActions={false}
        onSubmit={submit}
        error={failure}
        aside={
          draft.triggerMode === 'event' ? (
            <EventCard />
          ) : (
            <PreviewCard preview={preview} />
          )
        }
      >
        <Fade>
          <ScheduleSection
            draft={draft}
            set={set}
            errors={errors}
            invalidSchedule={invalidSchedule}
            checking={checking}
          />
        </Fade>

        <FieldSeparator />

        <Fade delay={50}>
          <ExecutionSection
            draft={draft}
            set={set}
            errors={errors}
            job={job}
            agentOptions={agentOptions}
            projectOptions={projectOptions}
          />
        </Fade>

        <FieldSeparator />

        <Fade delay={100}>
          <InstructionsSection draft={draft} set={set} errors={errors} />
        </Fade>

        <FieldSeparator />

        <Fade delay={150}>
          <ActiveSection draft={draft} set={set} job={job} />
        </Fade>
      </FormPage>
    </PageBody>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <PageBody width="3xl">
      <Fade>{children}</Fade>
    </PageBody>
  );
}

interface SectionProps {
  draft: CronDraft;
  set(patch: Partial<CronDraft>): void;
}

interface ErrorSectionProps extends SectionProps {
  errors: FieldErrors;
}

interface ScheduleSectionProps extends ErrorSectionProps {
  invalidSchedule: boolean;
  checking: boolean;
}

// The legend sits here and not on the card header: without it the card
// opened with the bare guidance sentence while the later sections carried a
// heading, and the layout looked cut off at the top.
function ScheduleSection({ draft, set, errors, invalidSchedule, checking }: ScheduleSectionProps) {
  return (
    <FieldSet>
      <FieldLegend>Schedule</FieldLegend>
      <FieldDescription>
        {draft.triggerMode === 'schedule'
          ? 'Times use the time zone of the computer running the server.'
          : 'This schedule has no timetable. It waits for a webhook call or a listener.'}
      </FieldDescription>

      <Field>
        <FieldLabel htmlFor="cron-trigger-schedule">What fires it</FieldLabel>
        <ChoiceField
          id="cron-trigger"
          options={CRON_TRIGGER_MODE_CHOICES}
          value={draft.triggerMode}
          onChange={(triggerMode) => set({ triggerMode })}
        />
      </Field>

      {draft.triggerMode === 'schedule' ? (
        <ExpressionField
          schedule={draft.schedule}
          error={errors.schedule}
          invalid={invalidSchedule}
          checking={checking}
          onChange={(schedule) => set({ schedule })}
        />
      ) : null}

      <CooldownField value={draft.cooldownMs} onChange={(cooldownMs) => set({ cooldownMs })} />

      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>Run only once</FieldTitle>
          <FieldDescription>The schedule disables itself after the first run.</FieldDescription>
        </FieldContent>
        <Switch id="cron-once" checked={draft.once} onCheckedChange={(once) => set({ once })} />
      </Field>
    </FieldSet>
  );
}

function ExpressionField({
  schedule,
  error,
  invalid,
  checking,
  onChange,
}: {
  schedule: string;
  error: string | undefined;
  invalid: boolean;
  checking: boolean;
  onChange(schedule: string): void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor="cron-schedule">Expression</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id="cron-schedule"
          className="font-mono"
          placeholder="Minute Hour Day Month Weekday"
          value={schedule}
          aria-invalid={Boolean(error) || invalid}
          onChange={(event) => onChange(event.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <InputGroupButton>
                Templates
                <ChevronDownIcon />
              </InputGroupButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Common schedules</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {CRON_PRESETS.map((entry) => (
                <DropdownMenuItem key={entry.schedule} onSelect={() => onChange(entry.schedule)}>
                  {entry.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </InputGroupAddon>
      </InputGroup>
      <FieldDescription>
        Five fields: minute, hour, day, month, weekday. “0 8 * * 1-5” runs at 8:00 AM on
        weekdays. {checking ? 'Checking…' : ''}
      </FieldDescription>
      <FieldError>{error}</FieldError>
    </Field>
  );
}

/**
 * How long a schedule rests after an event fired it.
 *
 * Stored in milliseconds because that is what the scheduler counts in, typed
 * in seconds because that is what a person means. The typed text stays local
 * until it parses, so clearing the field to type a new number cannot put
 * `NaN` into the draft.
 */
function CooldownField({
  value,
  onChange,
}: {
  value: number;
  onChange(milliseconds: number): void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const shown = raw ?? String(Math.round(value / MS_PER_SECOND));
  const invalid = parseCooldownSeconds(shown) === null;

  const handleChange = (text: string) => {
    setRaw(text);
    const seconds = parseCooldownSeconds(text);
    if (seconds !== null) onChange(seconds * MS_PER_SECOND);
  };

  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor="cron-cooldown">Rest after an event</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id="cron-cooldown"
          inputMode="numeric"
          value={shown}
          aria-invalid={invalid || undefined}
          onChange={(event) => handleChange(event.target.value)}
          onBlur={() => setRaw(null)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>seconds</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      <FieldDescription>
        Events arriving during the rest are not lost: they collapse into one run once it is over.
        Zero runs on every event.
      </FieldDescription>
      <FieldError>
        {invalid ? 'Enter a whole number of seconds between 0 and ' + MAX_COOLDOWN_SECONDS + '.' : null}
      </FieldError>
    </Field>
  );
}

interface ExecutionSectionProps extends ErrorSectionProps {
  job: CronJob | undefined;
  agentOptions: EntityOption[];
  projectOptions: EntityOption[];
}

function ExecutionSection({
  draft,
  set,
  errors,
  job,
  agentOptions,
  projectOptions,
}: ExecutionSectionProps) {
  return (
    <FieldSet>
      <Field>
        <FieldLabel htmlFor="cron-runner-assistant">Execution</FieldLabel>
        {job?.script ? (
          <FieldDescription>
            Imported {job.script.runtime} script. Review the source and grant Full access on the
            schedule page.
          </FieldDescription>
        ) : (
          <ChoiceField
            id="cron-runner"
            options={RUNNER_OPTIONS}
            value={draft.runner}
            onChange={(runner) => set({ runner })}
          />
        )}
      </Field>

      {draft.runner === 'agent' ? (
        <Field>
          <FieldLabel htmlFor="cron-agent">Agent</FieldLabel>
          <EntityCombobox
            id="cron-agent"
            options={agentOptions}
            value={draft.agentId}
            onChange={(agentId) => set({ agentId })}
            placeholder="Select agent"
            emptyLabel="No agent found"
            invalid={Boolean(errors.agentId)}
          />
          <FieldError>{errors.agentId}</FieldError>
        </Field>
      ) : null}

      <Field>
        <FieldLabel htmlFor="cron-project">Project</FieldLabel>
        <EntityCombobox
          id="cron-project"
          options={projectOptions}
          value={draft.projectId}
          onChange={(projectId) => set({ projectId })}
          placeholder="No project"
          emptyLabel="No project found"
        />
        <FieldDescription>
          {job?.script
            ? 'The script runs in its imported directory. The project applies to the assistant follow-up.'
            : 'The project determines which directory the run uses.'}
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="cron-permission-standard">Permission</FieldLabel>
        {job?.script ? (
          <FieldDescription>
            {job.permission === 'full'
              ? 'Full access granted.'
              : 'Review the script on its schedule page before granting Full access.'}
          </FieldDescription>
        ) : (
          <ChoiceField
            id="cron-permission"
            options={PERMISSION_CHOICES}
            value={draft.permission}
            onChange={(permission) => set({ permission })}
          />
        )}
      </Field>
    </FieldSet>
  );
}

function InstructionsSection({ draft, set, errors }: ErrorSectionProps) {
  return (
    <FieldSet>
      <Field>
        <FieldLabel htmlFor="cron-name">Name</FieldLabel>
        <Input
          id="cron-name"
          placeholder="e.g. Morning briefing"
          value={draft.name}
          aria-invalid={Boolean(errors.name)}
          onChange={(event) => set({ name: event.target.value })}
        />
        <FieldError>{errors.name}</FieldError>
      </Field>

      <Field>
        <FieldLabel htmlFor="cron-prompt">Instructions</FieldLabel>
        <Textarea
          id="cron-prompt"
          rows={PROMPT_ROWS}
          placeholder={PROMPT_PLACEHOLDER}
          value={draft.prompt}
          aria-invalid={Boolean(errors.prompt)}
          onChange={(event) => set({ prompt: event.target.value })}
        />
        <FieldDescription>
          Write self-contained instructions that can run without follow-up questions.
        </FieldDescription>
        <FieldError>{errors.prompt}</FieldError>
      </Field>
    </FieldSet>
  );
}

function ActiveSection({
  draft,
  set,
  job,
}: SectionProps & { job: CronJob | undefined }) {
  return (
    <FieldSet>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>Active</FieldTitle>
          <FieldDescription>
            When disabled, the schedule remains saved but does not run.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="cron-enabled"
          checked={draft.enabled}
          disabled={job ? isRunBlocked(job) : false}
          onCheckedChange={(enabled) => set({ enabled })}
        />
      </Field>
    </FieldSet>
  );
}

function EventCard() {
  return (
    <Fade delay={200}>
      <Card>
        <CardHeader>
          <CardTitle>Fired by events</CardTitle>
          <CardDescription>Nothing runs until something asks for it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Save the schedule, then create its webhook URL on the schedule page. Anything that can
            send an HTTP request - another service, a script, a machine on your network - can fire
            it with that URL.
          </p>
          <p>
            A mailbox can fire it too: add an IMAP listener under Settings and point it at this
            schedule.
          </p>
        </CardContent>
      </Card>
    </Fade>
  );
}

function PreviewCard({ preview }: { preview: CronPreview | null }) {
  return (
    <Fade delay={200}>
      <Card>
        <PreviewCardBody preview={preview} />
      </Card>
    </Fade>
  );
}

function PreviewCardBody({ preview }: { preview: CronPreview | null }) {
  if (preview?.ok) {
    return (
      <>
        <CardHeader>
          <CardTitle>{preview.description}</CardTitle>
          <CardDescription>
            Upcoming times in the time zone of the computer running the server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ItemGroup className="grid gap-2 @md/main:grid-cols-2">
            {preview.next.slice(0, UPCOMING_PREVIEW_COUNT).map((at) => (
              <Item key={at} variant="outline" size="sm">
                <ItemContent>
                  <ItemTitle className="font-normal tabular-nums">{formatDateTime(at)}</ItemTitle>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </CardContent>
      </>
    );
  }

  if (preview) {
    return (
      <CardContent>
        <Alert variant="destructive">
          <AlertTitle>This expression is invalid</AlertTitle>
          <AlertDescription>
            {preview.error ?? 'The server could not parse the expression.'}
          </AlertDescription>
        </Alert>
      </CardContent>
    );
  }

  return (
    <CardContent className="flex flex-col gap-2">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </CardContent>
  );
}
