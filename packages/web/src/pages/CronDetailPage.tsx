import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { NavLink, useParams } from 'react-router';

import {
  BriefcaseBusinessIcon as Building2Icon,
  CalendarCheckIcon as CalendarClockIcon,
  CheckIcon,
  CopyIcon,
  DeleteIcon as Trash2Icon,
  HistoryIcon,
  KeyIcon as KeyRoundIcon,
  LinkIcon,
  MailboxIcon,
  MessageSquareIcon as MessagesSquareIcon,
  PenToolIcon as PencilIcon,
  PlayIcon as AnimatedPlayIcon,
  RadioTowerIcon,
  ShieldCheckIcon as ShieldIcon,
  UserIcon as UserRoundIcon,
} from "@/components/icons";

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { RotatingText, RotatingTextContainer } from '@/components/animate-ui/primitives/texts/rotating';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';

import { api } from '@/lib/api';
import { isRunBlocked } from '@/lib/cron-availability';
import { describeEventCooldown } from '@/lib/cron-cooldown';
import {
  CRON_RUN_STATUS_LABEL,
  DEFAULT_EVENT_COOLDOWN_MS,
  cronRunReport,
  cronRunTrigger,
  isBoardWatch,
} from '@/lib/cron';
import {
  CRON_JOB_KIND_LABEL,
  PERMISSION_LABEL,
  REQUESTER_LABEL,
  formatDateTime,
  formatDuration,
  timeAgo,
} from '@/lib/format';
import { average, formatNumber } from '@/lib/stats';
import type { CronJob, CronJobDetail, CronRun, ImapListenerConfig } from '@/lib/types';
import { useConfig, useCronState } from '@/providers/rookery-provider';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useCronJobActions } from '@/hooks/useCronJobActions';
import { useCronRunReport } from '@/hooks/useCronRunReport';
import { useDeleteCronJob } from '@/hooks/useDeleteCronJob';
import { useRecord } from '@/hooks/useRecord';
import { usePageMeta } from '@/components/shell/page-meta';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards } from '@/components/blocks/stat-cards';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  EMPTY_CELL,
  actionsColumn,
  emptyCell,
} from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawer, DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { StatusBadge } from '@/components/common/status-badge';
import { ResultMarkdown } from '@/components/result-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';

/** The server's ceiling for one job's run list. */
const RUN_LIST_LIMIT = 50;
const RUNS_PAGE_SIZE = 10;
const SKELETON_CARD_COUNT = 4;
const SECTION_FADE_STEP_MS = 50;

const RUN_COLUMN_LABELS: Record<string, string> = {
  status: 'Status',
  startedAt: 'Start',
  trigger: 'Trigger',
  duration: 'Duration',
  assignment: 'Assignment',
  session: 'Conversation',
};

/**
 * One schedule: what it does, when it fires next, and every run so far.
 *
 * This is the only place that knows the plain-text description of the cron
 * expression - `GET /api/cron/:id` computes it as `description`, the
 * overview's payload does not carry it - so the sentence sits under
 * "Upcoming runs" where the dates it describes are.
 *
 * The detail is fetched once and refetched whenever the socket reports a
 * change to this job, so a run's report appears as soon as it is in.
 */
export function CronDetailPage() {
  const { id } = useParams<{ id: string }>();
  const cron = useCronState();
  const { config } = useConfig();
  const { confirm, dialog } = useConfirm();

  const { record: detail, missing, error, reload } = useRecord<CronJobDetail>(id, api.cronJob);
  const { report, setReport } = useCronRunReport(detail);

  // The hook's copy of this job changes identity on every broadcast about it,
  // which is exactly the moment the detail payload went stale.
  const live = cron.jobById(id);
  const running = id ? cron.running.has(id) : false;
  useEffect(() => {
    void reload();
  }, [live, running, reload]);

  const job = detail?.job;
  const actions = useCronJobActions({ id, hasScript: Boolean(job?.script), confirm, reload });
  const { busy, runNow, toggle } = actions;

  const deleteJob = useDeleteCronJob(confirm);
  const remove = useCallback(async (): Promise<void> => {
    if (job) await deleteJob(job);
  }, [deleteJob, job]);

  // `sleep` is the system's own schedule: `ensureSleepSchedule` recreates it
  // and the memory settings own its timetable, so editing and deleting are off.
  const managed = job?.kind === 'sleep';
  // The board watcher stays editable - the timing and the brief are yours -
  // but deleting it was never real: `ensureBoardWatchSchedule` seeded the
  // row again on the next start. Switching it off is what actually sticks.
  const permanent = managed || (job ? isBoardWatch(job) : false);
  const blocked = job ? isRunBlocked(job) : false;

  usePageMeta(
    {
      ...(job ? { title: job.name } : {}),
      actions: job ? (
        <DetailHeaderActions
          job={job}
          busy={busy}
          running={running}
          managed={managed}
          permanent={permanent}
          blocked={blocked}
          onToggle={(enabled) => void toggle(enabled)}
          onRunNow={() => void runNow()}
          onRemove={() => void remove()}
        />
      ) : undefined,
    },
    [busy, job, managed, permanent, running, remove, runNow, toggle, blocked],
  );

  const columns = useRunColumns(setReport);

  if (missing) {
    return (
      <PageBody width="3xl">
        <Fade>
          <EmptyState
            icon={CalendarClockIcon}
            title="Schedule not found"
            description="This schedule was deleted or never existed."
            actionLabel="View schedules"
            actionTo="/cron"
          />
        </Fade>
      </PageBody>
    );
  }

  if (error && !detail) {
    return (
      <PageBody width="3xl">
        <Fade>
          <ServerOffline onRetry={() => void reload()} />
        </Fade>
      </PageBody>
    );
  }

  if (!detail || !job) return <DetailSkeleton />;

  const { runs, agent, project, session, next, description } = detail;

  // An event-only job has no timetable, so `next` is empty anyway - but the
  // card around it has to say something other than "no upcoming run".
  const eventOnly = job.triggerMode === 'event';
  const upcoming = job.enabled && !eventOnly ? next : [];
  const cooldownText = describeEventCooldown(job.eventCooldownMs ?? DEFAULT_EVENT_COOLDOWN_MS);

  // The listeners are config, not part of the detail payload - and the config
  // is live in the provider, so this stays right when a mailbox is added.
  const listeners = (config?.listeners.imap ?? []).filter((entry) => entry.jobId === job.id);
  // A job on the clock can still have a webhook or a mailbox pointing at it.
  // Hiding what fires it just because it also has a timetable is how somebody
  // ends up hunting for the mailbox they attached last week.
  const firedByEvents = Boolean(job.webhookToken) || listeners.length > 0;
  const hookUrl = job.webhookToken ? window.location.origin + '/hooks/' + job.webhookToken : '';

  // Fade stagger for the sections below (policy: delay = min(i * 0.05, 0.4));
  // the optional script card on top takes index 0 and shifts the rest by one.
  const sectionBase = job.script ? 1 : 0;
  const delayOf = (section: number) => (sectionBase + section) * SECTION_FADE_STEP_MS;

  return (
    <PageBody>
      {dialog}

      {job.script && (
        <Fade>
          <div className="px-4 lg:px-6">
            <ScriptReviewCard
              script={job.script}
              detail={detail}
              needsReview={job.kind === 'script' && job.permission !== 'full'}
              busy={busy}
              onReview={() => void actions.reviewScript()}
            />
          </div>
        </Fade>
      )}

      <Fade delay={delayOf(0)}>
        <RunStatCards
          job={job}
          runs={runs}
          running={running}
          description={description}
          cooldownText={cooldownText}
        />
      </Fade>

      <Fade delay={delayOf(1)}>
        <div className="grid gap-4 px-4 md:gap-6 lg:px-6 @4xl/main:grid-cols-[2fr_1fr]">
          <InstructionsCard job={job} managed={managed} />
          {eventOnly || firedByEvents ? (
            <EventSourcesCard job={job} listeners={listeners} cooldownText={cooldownText} />
          ) : null}
          {!eventOnly ? (
            <UpcomingRunsCard job={job} description={description} upcoming={upcoming} />
          ) : null}
        </div>
      </Fade>

      <Fade delay={delayOf(2)}>
        <div className="px-4 lg:px-6">
          <MetaList
            columns={3}
            items={[
              {
                label: 'Run as',
                value: agent ? agent.name + ' · ' + agent.title : CRON_JOB_KIND_LABEL[job.kind],
                icon: UserRoundIcon,
                ...(agent ? { to: '/org/agents/' + agent.id } : {}),
              },
              { label: 'Project', value: project?.name ?? '', icon: Building2Icon },
              {
                label: 'Conversation',
                value: session?.title ?? '',
                icon: MessagesSquareIcon,
                ...(session ? { to: '/c/' + session.id } : {}),
              },
              {
                label: 'Permission',
                value: job.permission ? PERMISSION_LABEL[job.permission] : '',
                icon: ShieldIcon,
              },
              {
                label: 'Created by',
                value: REQUESTER_LABEL[job.createdBy],
                icon: KeyRoundIcon,
              },
              {
                label: 'Fired by',
                value: eventOnly ? 'Events only' : 'Timetable and events',
                icon: RadioTowerIcon,
              },
            ]}
          />
        </div>
      </Fade>

      {managed ? null : (
        <Fade delay={delayOf(3)}>
          <div className="px-4 lg:px-6">
            <WebhookCard
              url={hookUrl}
              busy={busy}
              onMint={() => void actions.mintWebhook(Boolean(job.webhookToken))}
              onRemove={() => void actions.removeWebhook()}
            />
          </div>
        </Fade>
      )}

      <Fade delay={delayOf(4)}>
        <DataTable
          data={runs}
          columns={columns}
          getRowId={(run) => run.id}
          idPrefix="laeufe"
          initialSorting={[{ id: 'startedAt', desc: true }]}
          pageSize={RUNS_PAGE_SIZE}
          rowLabel={{ singular: 'Run', plural: 'runs' }}
          columnLabels={RUN_COLUMN_LABELS}
          capped={runs.length >= RUN_LIST_LIMIT}
          empty={
            <EmptyState
              icon={HistoryIcon}
              title="Not run yet"
              description="When this schedule runs, automatically or manually, its run and report appear here."
              {...(blocked ? {} : { actionLabel: 'Run now', onAction: () => void runNow() })}
              variant="plain"
              size="sm"
            />
          }
        />
      </Fade>

      <RunReportDrawer jobName={job.name} report={report} onClose={() => setReport(null)} />
    </PageBody>
  );
}

function DetailSkeleton() {
  return (
    <PageBody>
      <Fade>
        <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
          {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
            <Skeleton key={index} className="h-32 w-full rounded-xl" />
          ))}
        </div>
        <div className="px-4 lg:px-6">
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </Fade>
    </PageBody>
  );
}

interface DetailHeaderActionsProps {
  job: CronJob;
  busy: boolean;
  running: boolean;
  managed: boolean;
  permanent: boolean;
  blocked: boolean;
  onToggle(enabled: boolean): void;
  onRunNow(): void;
  onRemove(): void;
}

function DetailHeaderActions({
  job,
  busy,
  running,
  managed,
  permanent,
  blocked,
  onToggle,
  onRunNow,
  onRemove,
}: DetailHeaderActionsProps) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="zeitplan-aktiv" className="flex h-8 items-center gap-2 rounded-md border px-2 font-normal">
        <Switch
          id="zeitplan-aktiv"
          checked={job.enabled}
          disabled={busy || blocked}
          onCheckedChange={onToggle}
        />
        Active
      </Label>
      <Button size="sm" disabled={running || busy || blocked} onClick={onRunNow}>
        {running ? (
          <Spinner aria-label="Running" data-icon="inline-start" />
        ) : (
          // Animates on hover of its wrapper span - the button base `[&_svg]:pointer-events-none` mutes only the svg, not the span.
          <AnimatedPlayIcon data-icon="inline-start" />
        )}
        Run now
      </Button>
      <Button size="sm" variant="outline" disabled={managed} asChild={!managed}>
        {managed ? (
          <>
            <PencilIcon data-icon="inline-start" />
            Edit
          </>
        ) : (
          <NavLink to={'/cron/' + job.id + '/edit'}>
            <PencilIcon data-icon="inline-start" />
            Edit
          </NavLink>
        )}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton tone="header" label="More actions" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem variant="destructive" disabled={permanent} onSelect={onRemove}>
            <Trash2Icon data-icon="inline-start" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function useRunColumns(onOpenReport: (run: CronRun) => void) {
  const column = useMemo(() => createRookeryColumnHelper<CronRun>(), []);

  return useMemo(
    () =>
      column.columns([
        column.accessor('status', {
          id: 'status',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
          cell: ({ row }) => <StatusBadge kind="cronRun" status={row.original.status} />,
        }),
        column.accessor('startedAt', {
          id: 'startedAt',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Start" />,
          cell: ({ row }) => (
            <span className="tabular-nums">{formatDateTime(row.original.startedAt)}</span>
          ),
        }),
        // The source rides along with the word: an event run without the thing
        // that raised it reads exactly like a clock run.
        column.accessor((run) => cronRunTrigger(run), {
          id: 'trigger',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Trigger" />,
          cell: ({ getValue }) => (
            <span className="text-muted-foreground">{getValue() as string}</span>
          ),
        }),
        column.accessor((run) => run.durationMs ?? null, {
          id: 'duration',
          header: ({ column: col }) => (
            <DataTableColumnHeader column={col} title="Duration" align="end" />
          ),
          cell: ({ row }) => (
            <div className="text-right tabular-nums">
              {formatDuration(row.original.durationMs) || EMPTY_CELL}
            </div>
          ),
        }),
        column.display({
          id: 'assignment',
          header: () => <span className="text-sm font-medium">Run</span>,
          cell: ({ row }) =>
            row.original.assignmentId ? (
              <NavLink
                to={'/assignments/' + row.original.assignmentId}
                className="hover:underline"
              >
                Assignment
              </NavLink>
            ) : (
              emptyCell()
            ),
        }),
        column.display({
          id: 'session',
          header: () => <span className="text-sm font-medium">Conversation</span>,
          cell: ({ row }) =>
            row.original.sessionId ? (
              <NavLink to={'/c/' + row.original.sessionId} className="hover:underline">
                Conversation
              </NavLink>
            ) : (
              emptyCell()
            ),
        }),
        actionsColumn<CronRun>(
          (run) =>
            cronRunReport(run) ? (
              <DetailDrawerTrigger onClick={() => onOpenReport(run)}>Report</DetailDrawerTrigger>
            ) : (
              emptyCell()
            ),
          { header: 'Report' },
        ),
      ]),
    [column, onOpenReport],
  );
}

interface ScriptReviewCardProps {
  script: NonNullable<CronJob['script']>;
  detail: CronJobDetail;
  needsReview: boolean;
  busy: boolean;
  onReview(): void;
}

function ScriptReviewCard({ script, detail, needsReview, busy, onReview }: ScriptReviewCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Imported script</CardTitle>
        <CardDescription>
          {script.noAgent
            ? 'Runs without a model. Empty output stays quiet.'
            : 'Runs before the assistant and passes its output as context.'}{' '}
          Review dependencies and paths from the previous installation. Provider credentials and
          source environment files are not imported. Runs stop after two minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="break-all font-mono text-xs">{script.path}</p>
        {detail.scriptError && <p className="text-sm text-destructive">{detail.scriptError}</p>}
        {detail.scriptSource !== undefined && (
          <details>
            <summary className="cursor-pointer text-sm">Review script source</summary>
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
              {detail.scriptSource}
            </pre>
          </details>
        )}
        {needsReview && (
          <Button disabled={busy || Boolean(detail.scriptError)} onClick={onReview}>
            Review and grant Full access
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** The finished runs' durations, ignoring runs that never recorded one. */
function measuredDurations(runs: CronRun[]): number[] {
  return runs
    .map((run) => run.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

interface RunStatCardsProps {
  job: CronJob;
  runs: CronRun[];
  running: boolean;
  description: string;
  cooldownText: string;
}

function RunStatCards({ job, runs, running, description, cooldownText }: RunStatCardsProps) {
  const durations = measuredDurations(runs);
  const meanDuration = durations.length ? formatDuration(Math.round(average(durations))) : '';

  // The label this card flips to whenever a run finishes.
  const latestStatus = running
    ? CRON_RUN_STATUS_LABEL.running
    : job.lastStatus
      ? CRON_RUN_STATUS_LABEL[job.lastStatus]
      : '–';

  return (
    <StatCards
      items={[
        {
          label: 'Runs',
          // The count rolls its digits rather than counts up: it keeps
          // changing with the socket, and only SlidingNumber holds
          // formatNumber's en-GB grouping ("1,234") once it settles -
          // CountingNumber would drop the separator and change the
          // resting pose.
          value: <SlidingNumber number={job.runCount} thousandSeparator="," />,
          badge: job.once ? <Badge variant="outline">once</Badge> : undefined,
          headline: job.lastRunAt ? 'Last run ' + timeAgo(job.lastRunAt) : 'Not run yet',
          footnote:
            job.remainingRuns !== undefined
              ? job.remainingRuns + ' runs remaining'
              : 'Created on ' + formatDateTime(job.createdAt),
        },
        {
          label: 'Latest status',
          // The label flips with every finished run; RotatingText rolls
          // it instead of snapping it.
          value: (
            <RotatingTextContainer text={latestStatus}>
              <RotatingText />
            </RotatingTextContainer>
          ),
          headline: job.lastRunAt ? timeAgo(job.lastRunAt) : 'No runs',
          footnote: job.lastError ? job.lastError : undefined,
        },
        job.triggerMode === 'event'
          ? {
              label: 'Next run',
              value: job.enabled ? 'On event' : 'Disabled',
              headline: job.enabled ? 'No timetable - it waits' : 'Paused',
              footnote: cooldownText,
            }
          : {
              label: 'Next run',
              value: job.enabled ? formatDateTime(job.nextRunAt) : 'Disabled',
              headline: job.enabled ? description : 'Paused',
              footnote: job.schedule,
            },
        {
          label: 'Average duration',
          value: meanDuration || '–',
          headline: meanDuration ? 'How long a run takes' : 'Nothing measured yet',
          footnote: durations.length
            ? 'Across ' + formatNumber(durations.length) + (durations.length === 1 ? ' run' : ' runs')
            : 'An average will appear here once a run completes',
        },
      ]}
    />
  );
}

function InstructionsCard({ job, managed }: { job: CronJob; managed: boolean }) {
  const subtitle = managed
    ? 'This system schedule uses the memory.sleep settings in your Rookery config.json.'
    : job.triggerMode === 'event'
      ? 'What runs when something fires this.'
      : 'What runs at the scheduled time.';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Instructions</CardTitle>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        {job.prompt ? (
          <ResultMarkdown text={job.prompt} />
        ) : (
          <EmptyState
            icon={PencilIcon}
            title="No custom instructions provided"
            description={
              job.script
                ? 'The imported script defines the work.'
                : 'Without instructions, this schedule does not perform any custom work.'
            }
            variant="plain"
            size="sm"
            {...(managed ? {} : { actionLabel: 'Edit', actionTo: '/cron/' + job.id + '/edit' })}
          />
        )}
      </CardContent>
    </Card>
  );
}

interface EventSourcesCardProps {
  job: CronJob;
  listeners: ImapListenerConfig[];
  cooldownText: string;
}

function EventSourcesCard({ job, listeners, cooldownText }: EventSourcesCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What can fire this</CardTitle>
        <CardDescription>{cooldownText}.</CardDescription>
      </CardHeader>
      <CardContent>
        {job.webhookToken || listeners.length > 0 ? (
          <ItemGroup className="gap-2">
            {job.webhookToken ? (
              <MutedItem icon={<LinkIcon className="text-muted-foreground" />}>
                Webhook URL
              </MutedItem>
            ) : null}
            {listeners.map((listener) => (
              <MutedItem
                key={listener.id}
                icon={<MailboxIcon className="text-muted-foreground" />}
              >
                {listener.mailbox + ' · ' + listener.user}
              </MutedItem>
            ))}
          </ItemGroup>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing can fire this schedule yet. Create a webhook URL below, or point an IMAP
            listener at it in Settings.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface UpcomingRunsCardProps {
  job: CronJob;
  description: string;
  upcoming: number[];
}

function UpcomingRunsCard({ job, description, upcoming }: UpcomingRunsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Upcoming runs</CardTitle>
        {/* The plain-text description comes from the server, it is not derived here. */}
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {job.enabled
              ? 'This expression has no upcoming run.'
              : 'Paused — no run is scheduled.'}
          </p>
        ) : (
          <ItemGroup className="gap-2">
            {upcoming.map((at) => (
              <MutedItem
                key={at}
                icon={<CalendarClockIcon className="text-muted-foreground" />}
                titleClassName="font-normal tabular-nums"
              >
                {formatDateTime(at)}
              </MutedItem>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}

function MutedItem({
  icon,
  titleClassName = 'font-normal',
  children,
}: {
  icon: ReactNode;
  titleClassName?: string;
  children: ReactNode;
}) {
  return (
    <Item variant="muted" size="sm">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle className={titleClassName}>{children}</ItemTitle>
      </ItemContent>
    </Item>
  );
}

interface RunReportDrawerProps {
  jobName: string;
  report: CronRun | null;
  onClose(): void;
}

// One drawer for the table, not one per row: a mounted vaul instance
// per run would bring fifty portals and focus traps along.
function RunReportDrawer({ jobName, report, onClose }: RunReportDrawerProps) {
  return (
    <DetailDrawer
      open={report !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={jobName}
      description={
        report ? formatDateTime(report.startedAt) + ' · ' + cronRunTrigger(report) : undefined
      }
      footer={
        report?.assignmentId ? (
          <Button variant="outline" asChild>
            <NavLink to={'/assignments/' + report.assignmentId}>Open assignment</NavLink>
          </Button>
        ) : undefined
      }
    >
      {report ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="cronRun" status={report.status} />
            {report.durationMs !== undefined ? (
              <span className="text-muted-foreground">{formatDuration(report.durationMs)}</span>
            ) : null}
          </div>
          <pre
            className={
              'whitespace-pre-wrap break-words font-mono text-xs ' +
              (report.error ? 'text-destructive' : '')
            }
          >
            {cronRunReport(report)}
          </pre>
        </>
      ) : null}
    </DetailDrawer>
  );
}

/**
 * The one URL that starts this schedule from outside.
 *
 * The token is shown in full rather than once at creation: the URL is what
 * has to be pasted into whatever will call it, and the page it sits on is
 * already behind the server's own token. Rotating replaces it; removing it
 * closes the door again.
 */
function WebhookCard({
  url,
  busy,
  onMint,
  onRemove,
}: {
  url: string;
  busy: boolean;
  onMint(): void;
  onRemove(): void;
}) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook</CardTitle>
        <CardDescription>
          A URL that starts this schedule. Anything that can send an HTTP POST can fire it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {url ? (
          <>
            <div className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>
                {url}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground"
                aria-label="Copy webhook URL"
                onClick={() => copyToClipboard(url)}
              >
                {isCopied ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Anyone holding this URL can start this schedule. Treat it like a password, and rotate
              it if it has been somewhere it should not have been.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onMint}>
                Rotate URL
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
                Remove
              </Button>
            </div>
          </>
        ) : (
          <Button type="button" size="sm" disabled={busy} onClick={onMint}>
            <LinkIcon data-icon="inline-start" />
            Create webhook URL
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
