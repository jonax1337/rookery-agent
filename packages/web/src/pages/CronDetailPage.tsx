import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';

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
import { toast } from 'sonner';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { RotatingText, RotatingTextContainer } from '@/components/animate-ui/primitives/texts/rotating';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';

import { api } from '@/lib/api';
import {
  CRON_RUN_STATUS_LABEL,
  DEFAULT_EVENT_COOLDOWN_MS,
  cronRunReport,
  cronRunTrigger,
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
import type { CronJobDetail, CronRun } from '@/lib/types';
import { useConfig, useCronState } from '@/providers/rookery-provider';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
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
import { useRecord } from '@/hooks/useRecord';
import { reportFailure } from '@/lib/errors';
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

/**
 * One schedule: what it does, when it fires next, and every run so far.
 *
 * This is the only place that knows the German plain text of the cron
 * expression - `GET /api/cron/:id` computes it as `description`, the
 * overview's payload does not carry it - so the sentence sits under "Nächste
 * Runs" where the dates it describes are.
 *
 * The detail is fetched once and refetched whenever the socket reports a
 * change to this job, so a run's report appears as soon as it is in.
 */
export function CronDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const cron = useCronState();
  const { config } = useConfig();
  const { confirm, dialog } = useConfirm();

  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CronRun | null>(null);

  const { record: detail, missing, error, reload } = useRecord<CronJobDetail>(id, api.cronJob);

  // The hook's copy of this job changes identity on every broadcast about it,
  // which is exactly the moment the detail payload went stale.
  const live = cron.jobById(id);
  const running = id ? cron.running.has(id) : false;
  useEffect(() => {
    void reload();
  }, [live, running, reload]);

  const job = detail?.job;
  const scriptNeedsReview = job?.kind === 'script' && job.permission !== 'full';
  const exhausted = job?.remainingRuns === 0;

  const reviewScript = useCallback(async (): Promise<void> => {
    if (!id || !job?.script) return;
    const approved = await confirm({
      title: 'Grant this script Full access?',
      description: 'The script runs directly on this computer with your user permissions. Review the source below, its dependencies and any external actions before granting access. This does not start or enable the schedule.',
      confirmLabel: 'Grant Full access',
    });
    if (!approved) return;
    setBusy(true);
    try { await api.updateCronJob(id, { permission: 'full' }); await reload(); }
    catch (caught) { reportFailure('Review script', caught); }
    finally { setBusy(false); }
  }, [confirm, id, job, reload]);

  const runNow = useCallback(async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await api.runCronJob(id);
      toast('Schedule started');
    } catch (caught) {
      reportFailure('Start', caught);
    } finally {
      setBusy(false);
    }
  }, [id]);

  const toggle = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!id) return;
      setBusy(true);
      try {
        await api.updateCronJob(id, { enabled });
        toast(enabled ? 'Schedule enabled' : 'Schedule paused');
      } catch (caught) {
        reportFailure('Update', caught);
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const remove = useCallback(async (): Promise<void> => {
    if (!id || !job) return;
    const ok = await confirm({
      title: 'Delete schedule?',
      description:
        'The schedule “' + job.name + '” will no longer run. Existing assignments and conversations will remain.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteCronJob(id);
      toast('Schedule deleted', { description: job.name });
      void navigate('/cron');
    } catch (caught) {
      reportFailure('Delete', caught);
    }
  }, [confirm, id, job, navigate]);

  /* -------------------------------- webhook ------------------------------- */

  // Minting and rotating are the same call: a rotation is a new secret in the
  // place of the old one, and there is nothing else to ask the server for.
  const mintWebhook = useCallback(
    async (rotating: boolean): Promise<void> => {
      if (!id) return;
      if (rotating) {
        const ok = await confirm({
          title: 'Rotate the webhook URL?',
          description:
            'The current URL stops working immediately. Anything still calling it has to be given the new one.',
          confirmLabel: 'Rotate',
        });
        if (!ok) return;
      }
      setBusy(true);
      try {
        await api.enableCronWebhook(id);
        await reload();
        toast(rotating ? 'Webhook URL rotated' : 'Webhook URL created');
      } catch (caught) {
        reportFailure('Webhook', caught);
      } finally {
        setBusy(false);
      }
    },
    [confirm, id, reload],
  );

  const removeWebhook = useCallback(async (): Promise<void> => {
    if (!id) return;
    const ok = await confirm({
      title: 'Remove the webhook URL?',
      description: 'The URL stops working. Events can no longer start this schedule through it.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.disableCronWebhook(id);
      await reload();
      toast('Webhook URL removed');
    } catch (caught) {
      reportFailure('Webhook', caught);
    } finally {
      setBusy(false);
    }
  }, [confirm, id, reload]);

  // `sleep` is the system's own schedule: `ensureSleepSchedule` recreates it
  // and the memory settings own its timetable, so editing and deleting are off.
  const managed = job?.kind === 'sleep';

  usePageMeta(
    {
      ...(job ? { title: job.name } : {}),
      actions: job ? (
        <div className="flex items-center gap-2">
          <Label htmlFor="zeitplan-aktiv" className="flex h-8 items-center gap-2 rounded-md border px-2 font-normal">
            <Switch
              id="zeitplan-aktiv"
              checked={job.enabled}
              disabled={busy || scriptNeedsReview || exhausted}
              onCheckedChange={(checked) => void toggle(checked)}
            />
            Active
          </Label>
          <Button size="sm" disabled={running || busy || scriptNeedsReview || exhausted} onClick={() => void runNow()}>
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
              <DropdownMenuItem
                variant="destructive"
                disabled={managed}
                onSelect={() => void remove()}
              >
                <Trash2Icon data-icon="inline-start" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : undefined,
    },
    [busy, job, managed, running, remove, runNow, toggle, scriptNeedsReview, exhausted],
  );

  /* -------------------------------- Spalten ------------------------------- */

  const column = useMemo(() => createRookeryColumnHelper<CronRun>(), []);

  const columns = useMemo(
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
          header: () => <span className="text-sm font-medium">Assignment</span>,
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
              <DetailDrawerTrigger onClick={() => setReport(run)}>Report</DetailDrawerTrigger>
            ) : (
              emptyCell()
            ),
          { header: 'Report' },
        ),
      ]),
    [column],
  );

  /* -------------------------------- Zustände ------------------------------ */

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

  if (!detail || !job) {
    return (
      <PageBody>
        <Fade>
          <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
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

  const { runs, agent, project, session, next, description } = detail;

  const durations = runs
    .map((run) => run.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const meanDuration = durations.length ? formatDuration(Math.round(average(durations))) : '';

  // An event-only job has no timetable, so `next` is empty anyway - but the
  // card around it has to say something other than "no upcoming run".
  const eventOnly = job.triggerMode === 'event';
  const upcoming = job.enabled && !eventOnly ? next : [];

  const cooldownSeconds = Math.round((job.eventCooldownMs ?? DEFAULT_EVENT_COOLDOWN_MS) / 1000);
  const cooldownText =
    cooldownSeconds === 0
      ? 'Every event starts a run'
      : 'Rests ' + cooldownSeconds + ' s after a run, then fires once for everything that arrived';

  // The listeners are config, not part of the detail payload - and the config
  // is live in the provider, so this stays right when a mailbox is added.
  const listeners = (config?.listeners.imap ?? []).filter((entry) => entry.jobId === job.id);
  const hookUrl = job.webhookToken ? window.location.origin + '/hooks/' + job.webhookToken : '';

  // The label this card flips to whenever a run finishes.
  const latestStatus = running
    ? CRON_RUN_STATUS_LABEL.running
    : job.lastStatus
      ? CRON_RUN_STATUS_LABEL[job.lastStatus]
      : '–';

  // Fade stagger for the sections below (policy: delay = min(i * 0.05, 0.4));
  // the optional script card on top takes index 0 and shifts the rest by one.
  const sectionBase = job.script ? 1 : 0;

  return (
    <PageBody>
      {dialog}

      {job.script && (
        <Fade>
          <div className="px-4 lg:px-6">
            <Card>
              <CardHeader>
                <CardTitle>Imported script</CardTitle>
                <CardDescription>
                  {job.script.noAgent ? 'Runs without a model. Empty output stays quiet.' : 'Runs before the assistant and passes its output as context.'}
                  {' '}Review dependencies and paths from the previous installation. Provider credentials and source environment files are not imported. Runs stop after two minutes.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="break-all font-mono text-xs">{job.script.path}</p>
                {detail.scriptError && <p className="text-sm text-destructive">{detail.scriptError}</p>}
                {detail.scriptSource !== undefined && <details><summary className="cursor-pointer text-sm">Review script source</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">{detail.scriptSource}</pre></details>}
                {scriptNeedsReview && <Button disabled={busy || Boolean(detail.scriptError)} onClick={() => void reviewScript()}>Review and grant Full access</Button>}
              </CardContent>
            </Card>
          </div>
        </Fade>
      )}

      <Fade delay={sectionBase * 50}>
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
              footnote: job.remainingRuns !== undefined ? job.remainingRuns + ' runs remaining' : 'Created on ' + formatDateTime(job.createdAt),
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
            eventOnly
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
                ? 'Across ' + formatNumber(durations.length) + (durations.length === 1 ? ' run' : ' Runs')
                : 'An average will appear here once a run completes',
            },
          ]}
        />
      </Fade>

      <Fade delay={(sectionBase + 1) * 50}>
        <div className="grid gap-4 px-4 md:gap-6 lg:px-6 @4xl/main:grid-cols-[2fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Instructions</CardTitle>
              <CardDescription>
                {managed
                  ? 'This system schedule uses the memory.sleep settings in your Rookery config.json.'
                  : job.triggerMode === 'event'
                    ? 'What runs when something fires this.'
                    : 'What runs at the scheduled time.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {job.prompt ? (
                <ResultMarkdown text={job.prompt} />
              ) : (
                <EmptyState
                  icon={PencilIcon}
                  title="No custom instructions provided"
                  description={job.script ? 'The imported script defines the work.' : 'Without instructions, this schedule does not perform any custom work.'}
                  variant="plain"
                  size="sm"
                  {...(managed
                    ? {}
                    : { actionLabel: 'Edit', actionTo: '/cron/' + job.id + '/edit' })}
                />
              )}
            </CardContent>
          </Card>

          {eventOnly ? (
            <Card>
              <CardHeader>
                <CardTitle>What can fire this</CardTitle>
                <CardDescription>{cooldownText}.</CardDescription>
              </CardHeader>
              <CardContent>
                {job.webhookToken || listeners.length > 0 ? (
                  <ItemGroup className="gap-2">
                    {job.webhookToken ? (
                      <Item variant="muted" size="sm">
                        <ItemMedia variant="icon">
                          <LinkIcon className="text-muted-foreground" />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle className="font-normal">Webhook URL</ItemTitle>
                        </ItemContent>
                      </Item>
                    ) : null}
                    {listeners.map((listener) => (
                      <Item key={listener.id} variant="muted" size="sm">
                        <ItemMedia variant="icon">
                          <MailboxIcon className="text-muted-foreground" />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle className="font-normal">
                            {listener.mailbox + ' · ' + listener.user}
                          </ItemTitle>
                        </ItemContent>
                      </Item>
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
          ) : (
          <Card>
            <CardHeader>
              <CardTitle>Upcoming runs</CardTitle>
              {/* The only German plain text of the expression there is - it
                  comes from the server, it is not derived here. */}
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
                    <Item key={at} variant="muted" size="sm">
                      <ItemMedia variant="icon">
                        <CalendarClockIcon className="text-muted-foreground" />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle className="font-normal tabular-nums">
                          {formatDateTime(at)}
                        </ItemTitle>
                      </ItemContent>
                    </Item>
                  ))}
                </ItemGroup>
              )}
            </CardContent>
          </Card>
          )}
        </div>
      </Fade>

      <Fade delay={(sectionBase + 2) * 50}>
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
        <Fade delay={(sectionBase + 3) * 50}>
          <div className="px-4 lg:px-6">
            <WebhookCard
              url={hookUrl}
              busy={busy}
              onMint={() => void mintWebhook(Boolean(job.webhookToken))}
              onRemove={() => void removeWebhook()}
            />
          </div>
        </Fade>
      )}

      <Fade delay={(sectionBase + 4) * 50}>
        <DataTable
          data={runs}
          columns={columns}
          getRowId={(run) => run.id}
          idPrefix="laeufe"
          initialSorting={[{ id: 'startedAt', desc: true }]}
          pageSize={10}
          rowLabel={{ singular: 'Run', plural: 'runs' }}
          columnLabels={RUN_COLUMN_LABELS}
          // Fifty is the server's ceiling for one job's run list.
          capped={runs.length >= 50}
          empty={
            <EmptyState
              icon={HistoryIcon}
              title="Not run yet"
              description="When this schedule runs, automatically or manually, its run and report appear here."
              {...(!scriptNeedsReview && !exhausted ? { actionLabel: 'Run now', onAction: () => void runNow() } : {})}
              variant="plain"
              size="sm"
            />
          }
        />
      </Fade>

      {/* One drawer for the table, not one per row: a mounted vaul instance
          per run would bring fifty portals and focus traps along. */}
      <DetailDrawer
        open={report !== null}
        onOpenChange={(open) => {
          if (!open) setReport(null);
        }}
        title={job.name}
        description={
          report
            ? formatDateTime(report.startedAt) + ' · ' + cronRunTrigger(report)
            : undefined
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
    </PageBody>
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

const RUN_COLUMN_LABELS: Record<string, string> = {
  status: 'Status',
  startedAt: 'Start',
  trigger: 'Trigger',
  duration: 'Duration',
  assignment: 'Assignment',
  session: 'Conversation',
};
