import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  BadgeAlertIcon,
  BrainIcon,
  RotateCcwIcon,
} from '@/components/icons';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { EMPTY_CELL, actionsColumn } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import {
  DetailDrawer,
  DetailDrawerTrigger,
  useDrawerSubject,
} from '@/components/blocks/detail-drawer';
import { SectionHeading } from '@/components/blocks/section-heading';
import { StatCards, cappedBadge } from '@/components/blocks/stat-cards';
import { VersionCurveCard, type VersionPoint, type VersionSeries } from '@/components/blocks/version-curve-card';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type {
  DreamEval,
  DreamSlot,
  DreamSlotFreezeReason,
  DreamSlotView,
  PolicyVersion,
} from '@/lib/types';
import { useConfig } from '@/providers/rookery-provider';

/**
 * The dream, as a section of the nights page.
 *
 * It is a section and not a fourth tab under `/memory` on purpose (concept
 * 9.6): the dream stage runs inside the same night as light, deep and REM
 * sleep, and `web/test/page-navigation.test.mjs` asserts that `/memory` keeps
 * exactly three children. What it shows is what the four dream routes hand
 * out and nothing else - the frames themselves never leave the server (E19).
 *
 * Three things live here that live nowhere else:
 *
 * - **What is in force.** One card per slot: the promoted version, or the
 *   configured default when nothing was ever promoted, which is the normal
 *   state of a fresh installation.
 * - **A frozen slot as an action item.** A freeze is a decision the night
 *   made about itself, and a decision nobody sees is a decision nobody can
 *   undo. It is drawn the way an unresolved contradiction is (concept 10.3),
 *   and it always says which of the two things the slot is doing: it keeps
 *   measuring, it has stopped promoting.
 * - **A diff sheet per promotion.** A promotion changes how the assistant
 *   recalls, so the numbers it stood on - delta, `ci_low`, `audit_ci_low` -
 *   and the way back out of it belong in one place.
 *
 * The empty case is the case the reader will actually meet: `memory.dream`
 * ships with `enabled`, `record` and `promote` all false, so there are no
 * versions, no evaluations and no promotions. That must read as "switched
 * off", never as a card that failed to load, which is why the switches are
 * printed from the served config rather than guessed at from the empty list.
 */

/** The three recall-family slots the routes carry a policy for (concept 7.1). */
const SLOTS: DreamSlot[] = ['recall', 'budget', 'retry'];

/** What `GET /api/dream/policies/:slot/history` is asked for, per slot. */
const HISTORY_LIMIT = 50;

const SLOT_LABEL: Record<DreamSlot, string> = {
  recall: 'Recall',
  budget: 'Budget',
  retry: 'Retry',
};

const SLOT_HINT: Record<DreamSlot, string> = {
  recall: 'How much the assistant pulls out of memory, and from how far out.',
  budget: 'How the night divides its model calls between its phases.',
  retry: 'When a failed step is worth a second attempt.',
};

/** One colour per slot, so a card and its line in the curve match. */
const SLOT_COLOR: Record<DreamSlot, string> = {
  recall: 'var(--chart-1)',
  budget: 'var(--chart-2)',
  retry: 'var(--chart-3)',
};

/**
 * The four freeze causes of concept 10.3, each said in one sentence.
 *
 * Kept as a full record rather than a lookup with a fallback: a fifth cause
 * added to `DreamSlotFreezeReason` in core is then a type error here instead
 * of an unlabelled badge in the browser.
 */
const FREEZE_REASON: Record<DreamSlotFreezeReason, { label: string; detail: string }> = {
  calibration: {
    label: 'calibration',
    detail:
      'After the last promotion the waking test measured a drift past the tolerance, so what was promoted did not hold up in the live bank.',
  },
  staleness: {
    label: 'staleness',
    detail:
      'The freshness check scored the candidate against the live bank as well as the frozen frames, and the two disagreed about the sign of the change.',
  },
  agreement: {
    label: 'agreement',
    detail:
      'The label sources agreed with each other less often than the floor allows, so the score rests on evidence that contradicts itself.',
  },
  manual: {
    label: 'manual',
    detail: 'Somebody froze this slot by hand.',
  },
};

const column = createRookeryColumnHelper<PolicyVersion>();

const PROMOTION_COLUMN_LABELS: Record<string, string> = {
  promotedAt: 'Promoted',
  slot: 'Slot',
  version: 'Version',
  replayScore: 'Holdout score',
  baselineScore: 'Baseline',
  auditCiLow: 'audit_ci_low',
  rationale: 'Reason',
};

/** A score in 0..1. Two decimals; the third digit is noise at these sample sizes. */
function score(value: number | undefined): string {
  return value === undefined ? EMPTY_CELL : value.toFixed(2);
}

/**
 * A signed difference, so a minus sign is never mistaken for a hyphen. A whole
 * number stays whole: `limit` moving from 8 to 10 is `+2`, and printing it as
 * `+2.000` claims a precision the parameter does not have.
 */
function signed(value: number | undefined): string {
  if (value === undefined) return EMPTY_CELL;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(3);
  return (value > 0 ? '+' : '') + text;
}

/** A parameter value as text. Objects are rare and print as JSON, never as `[object Object]`. */
function paramText(value: unknown): string {
  if (value === undefined) return EMPTY_CELL;
  if (value === null) return 'null';
  if (typeof value === 'number') return formatNumber(value, { maximumFractionDigits: 4 });
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** One row of the diff sheet: what the parameter was, and what it became. */
interface ParamDiffRow {
  field: string;
  before: unknown;
  after: unknown;
  /** Only when both sides are numbers - otherwise a difference means nothing. */
  delta?: number;
  changed: boolean;
}

/**
 * Flattens one level of nesting, so `w` becomes `w.relevance` and its three
 * siblings rather than a line of raw JSON. The weights ARE the policy: three
 * of the four moving is the whole story of a promotion, and a serialised
 * object in one cell hides exactly that.
 */
function flattenParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, nested] of Object.entries(value as Record<string, unknown>)) {
        flat[key + '.' + inner] = nested;
      }
    } else {
      flat[key] = value;
    }
  }
  return flat;
}

function diffParams(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): ParamDiffRow[] {
  const left = flattenParams(before);
  const right = flattenParams(after);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.map((field) => {
    const was = left[field];
    const now = right[field];
    const numeric = typeof was === 'number' && typeof now === 'number';
    return {
      field,
      before: was,
      after: now,
      delta: numeric ? (now as number) - (was as number) : undefined,
      changed: JSON.stringify(was) !== JSON.stringify(now),
    };
  });
}

export interface DreamSectionProps {
  /** Whose bank. Left out, every route answers for the assistant's own. */
  owner?: string;
}

export function DreamSection({ owner }: DreamSectionProps) {
  const { config } = useConfig();
  const { confirm, dialog } = useConfirm();
  const dream = config?.memory?.dream;

  const [slots, setSlots] = useState<DreamSlotView[] | null>(null);
  const [history, setHistory] = useState<Record<DreamSlot, PolicyVersion[]> | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);

  const [promotion, setPromotion] = useState<PolicyVersion | null>(null);
  const [evals, setEvals] = useState<DreamEval[] | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);

  // One pass over the four reads: the slot list, and one history per slot.
  // Everything else on this surface is derived from those - a promotion is a
  // version with `promotedAt` set, a candidate is one with a score and no
  // promotion, so there is no second list to keep in step with this one.
  useEffect(() => {
    let live = true;
    setFailed(false);
    Promise.all([
      api.dreamPolicies(owner),
      ...SLOTS.map((slot) => api.dreamPolicyHistory(slot, { owner, limit: HISTORY_LIMIT })),
    ])
      .then(([views, ...histories]) => {
        if (!live) return;
        setSlots(views);
        const bySlot = {} as Record<DreamSlot, PolicyVersion[]>;
        SLOTS.forEach((slot, index) => {
          bySlot[slot] = histories[index] ?? [];
        });
        setHistory(bySlot);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [owner, reloads]);

  // The receipt behind one promotion's numbers, fetched when its sheet opens:
  // `ci_low` lives on the evaluation, not on the version, and pulling every
  // evaluation up front would be a second capped list for one drawer.
  useEffect(() => {
    if (!promotion) return;
    let live = true;
    setEvals(null);
    api
      .dreamEvals({ owner, policyId: promotion.id, limit: 20 })
      .then((rows) => {
        if (live) setEvals(rows);
      })
      .catch(() => {
        if (live) setEvals([]);
      });
    return () => {
      live = false;
    };
  }, [owner, promotion]);

  const promotions = useMemo(() => {
    if (!history) return [];
    return SLOTS.flatMap((slot) => history[slot].filter((version) => version.promotedAt))
      .slice()
      .sort((left, right) => (right.promotedAt ?? 0) - (left.promotedAt ?? 0));
  }, [history]);

  const measured = useMemo(() => {
    if (!history) return 0;
    return SLOTS.reduce(
      (total, slot) => total + history[slot].filter((v) => v.replayScore !== undefined).length,
      0,
    );
  }, [history]);

  const versionCount = useMemo(
    () => (history ? SLOTS.reduce((total, slot) => total + history[slot].length, 0) : 0),
    [history],
  );

  const historyCapped = useMemo(
    () => (history ? SLOTS.some((slot) => history[slot].length >= HISTORY_LIMIT) : false),
    [history],
  );

  /* ------------------------------- the curve ------------------------------- */

  /*
    One row per version number, one line per slot that actually has a measured
    version, plus that slot's baseline as a dashed line. A slot with no measured
    version contributes no line at all rather than a flat zero: nothing was
    measured there, and a line along the floor would say something else.
  */
  const curveSeries = useMemo<VersionSeries[]>(() => {
    if (!history) return [];
    const series: VersionSeries[] = [];
    for (const slot of SLOTS) {
      if (!history[slot].some((version) => version.replayScore !== undefined)) continue;
      series.push({ key: slot, label: SLOT_LABEL[slot] + ' score', color: SLOT_COLOR[slot] });
      series.push({
        key: slot + 'Baseline',
        label: SLOT_LABEL[slot] + ' baseline',
        color: SLOT_COLOR[slot],
        dashed: true,
      });
    }
    return series;
  }, [history]);

  const curve = useMemo<VersionPoint[]>(() => {
    if (!history || curveSeries.length === 0) return [];
    const rows = new Map<number, VersionPoint & Record<string, number>>();
    for (const slot of SLOTS) {
      for (const version of history[slot]) {
        if (version.replayScore === undefined) continue;
        const row = rows.get(version.version) ?? ({ version: version.version } as VersionPoint & Record<string, number>);
        row[slot] = version.replayScore;
        if (version.baselineScore !== undefined) row[slot + 'Baseline'] = version.baselineScore;
        rows.set(version.version, row);
      }
    }
    return [...rows.values()].sort((left, right) => left.version - right.version);
  }, [curveSeries.length, history]);

  /* -------------------------------- actions -------------------------------- */

  const revert = useCallback(
    async (version: PolicyVersion): Promise<void> => {
      const ok = await confirm({
        title: 'Revert this promotion?',
        description:
          'Takes version ' +
          version.version +
          ' of the ' +
          SLOT_LABEL[version.slot].toLowerCase() +
          ' slot out of force and puts back whatever was in force before it. Measurements and evaluations stay; only what the assistant recalls with changes back.',
        confirmLabel: 'Revert',
        destructive: true,
      });
      if (!ok) return;
      setReverting(version.id);
      try {
        const result = await api.revertPolicy(version.id, owner);
        toast('Promotion reverted', {
          description: result.restored
            ? 'Version ' + result.restored.version + ' is in force again.'
            : 'There was no earlier version; the configured default is in force again.',
        });
        setPromotion(null);
        setReloads((count) => count + 1);
      } catch (caught) {
        reportFailure('Revert', caught);
      } finally {
        setReverting(null);
      }
    },
    [confirm, owner],
  );

  /* -------------------------------- columns -------------------------------- */

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor((version) => version.promotedAt ?? 0, {
          id: 'promotedAt',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Promoted" />,
          enableHiding: false,
          cell: ({ row }) => (
            <span className="whitespace-nowrap tabular-nums">
              {formatDateTime(row.original.promotedAt)}
            </span>
          ),
        }),
        column.accessor((version) => SLOT_LABEL[version.slot], {
          id: 'slot',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Slot" />,
          cell: ({ getValue }) => <span>{getValue() as string}</span>,
        }),
        column.accessor('version', {
          id: 'version',
          header: ({ column: col }) => (
            <DataTableColumnHeader column={col} title="Version" align="end" />
          ),
          cell: ({ row }) => (
            <div className="text-right tabular-nums">v{row.original.version}</div>
          ),
        }),
        column.accessor((version) => version.replayScore ?? 0, {
          id: 'replayScore',
          header: ({ column: col }) => (
            <DataTableColumnHeader column={col} title="Holdout score" align="end" />
          ),
          cell: ({ row }) => (
            <div className="text-right tabular-nums">{score(row.original.replayScore)}</div>
          ),
        }),
        column.accessor((version) => version.baselineScore ?? 0, {
          id: 'baselineScore',
          header: ({ column: col }) => (
            <DataTableColumnHeader column={col} title="Baseline" align="end" />
          ),
          cell: ({ row }) => (
            <div className="text-right tabular-nums">{score(row.original.baselineScore)}</div>
          ),
        }),
        column.accessor((version) => version.auditCiLow ?? 0, {
          id: 'auditCiLow',
          header: ({ column: col }) => (
            <DataTableColumnHeader column={col} title="audit_ci_low" align="end" />
          ),
          cell: ({ row }) => (
            <div className="text-right tabular-nums">{signed(row.original.auditCiLow)}</div>
          ),
        }),
        column.accessor((version) => version.rationale ?? '', {
          id: 'rationale',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Reason" />,
          cell: ({ getValue }) => {
            const text = getValue() as string;
            return text ? (
              <span className="line-clamp-2 text-muted-foreground">{text}</span>
            ) : (
              <span className="text-muted-foreground">{EMPTY_CELL}</span>
            );
          },
        }),
        actionsColumn<PolicyVersion>((version) => (
          <div className="flex items-center justify-end">
            <DetailDrawerTrigger onClick={() => setPromotion(version)}>
              Diff sheet
            </DetailDrawerTrigger>
          </div>
        )),
      ]),
    [],
  );

  /* ------------------------------- rendering ------------------------------- */

  const frozen = (slots ?? []).filter((view) => view.state?.frozenAt);
  const loading = slots === null && !failed;
  const nothingEverWritten = !loading && !failed && versionCount === 0;

  const sheet = useDrawerSubject(promotion);
  const sheetHistory = sheet && history ? history[sheet.slot] : [];
  const previous = sheet?.prevActiveId
    ? (sheetHistory.find((version) => version.id === sheet.prevActiveId) ?? null)
    : null;
  const sheetEval = evals?.find((entry) => entry.policyId === sheet?.id) ?? null;
  const diff = sheet ? diffParams(previous?.params, sheet.params) : [];

  return (
    <>
      {dialog}

      <Fade delay={150}>
        <SectionHeading
          title="Dream"
          hint="What the night measured about its own recall, and what it put in force."
        >
          <div className="flex flex-col gap-4">
            {/* The action items first: a frozen slot is a decision waiting for a person. */}
            {frozen.length > 0 ? (
              <Fade asChild>
                <div className="flex flex-col gap-2 px-4 lg:px-6">
                  {frozen.map((view) => {
                    const reason = view.state.frozenReason;
                    const said = reason ? FREEZE_REASON[reason] : null;
                    return (
                      <Alert key={view.slot} variant="destructive">
                        <BadgeAlertIcon aria-hidden="true" />
                        <AlertTitle>
                          {SLOT_LABEL[view.slot]} is frozen
                          {said ? ' — ' + said.label : ''}
                        </AlertTitle>
                        <AlertDescription>
                          <span>
                            {said ? said.detail : 'No cause was recorded for this freeze.'}
                          </span>
                          {/* The one sentence a frozen slot must say out loud. */}
                          <span>
                            {' '}
                            It keeps measuring; it no longer promotes. Frozen{' '}
                            {formatDateTime(view.state.frozenAt)}.
                          </span>
                        </AlertDescription>
                      </Alert>
                    );
                  })}
                </div>
              </Fade>
            ) : null}

            {failed ? (
              <div className="px-4 lg:px-6">
                <ServerOffline onRetry={() => setReloads((count) => count + 1)} />
              </div>
            ) : null}

            {/* What is in force, per slot - the default when nothing was promoted. */}
            {!failed ? (
              <StatCards
                items={SLOTS.map((slot) => {
                  const view = slots?.find((entry) => entry.slot === slot) ?? null;
                  const active = view?.active ?? null;
                  const versions = history?.[slot] ?? [];
                  const scored = versions.filter((v) => v.replayScore !== undefined).length;
                  return {
                    label: SLOT_LABEL[slot] + ' policy',
                    value: loading ? '…' : active ? 'v' + active.version : 'Default',
                    badge: view?.state?.frozenAt ? (
                      <Badge variant="destructive">frozen</Badge>
                    ) : active ? (
                      <Badge variant="outline">in force</Badge>
                    ) : undefined,
                    headline: active
                      ? 'Promoted ' + formatDateTime(active.promotedAt)
                      : 'Nothing promoted; the configured default is in force.',
                    footnote:
                      SLOT_HINT[slot] +
                      (versions.length > 0
                        ? ' ' +
                          formatNumber(versions.length) +
                          (versions.length === 1 ? ' version' : ' versions') +
                          ', ' +
                          formatNumber(scored) +
                          ' measured.'
                        : ''),
                  };
                })}
              />
            ) : null}

            {/* Every number on this surface rests on the same served config. */}
            {dream ? (
              <div className="px-4 lg:px-6">
                <MetaList
                  columns={3}
                  items={[
                    { label: 'Dream stage', value: dream.enabled ? 'on' : 'off' },
                    { label: 'Recording frames', value: dream.record ? 'on' : 'off' },
                    { label: 'Promotion gate', value: dream.promote ? 'on' : 'off' },
                    {
                      label: 'Slots it runs for',
                      value:
                        dream.slots && dream.slots.length > 0
                          ? dream.slots.map((slot) => SLOT_LABEL[slot] ?? slot).join(', ')
                          : 'none',
                    },
                  ]}
                />
              </div>
            ) : null}

            {nothingEverWritten ? (
              <div className="px-4 lg:px-6">
                <Card>
                  <CardContent>
                    <EmptyState
                      icon={BrainIcon}
                      title={
                        dream && !dream.enabled
                          ? 'The dream is switched off'
                          : 'The dream has written nothing yet'
                      }
                      description={
                        dream && !dream.enabled
                          ? 'memory.dream.enabled is false, which is the default. No night measures a retrieval policy, so there are no policy versions, no evaluations and no promotions to show. The counters in the table below stay at zero for the same reason.'
                          : 'No policy version exists for any slot yet. A night writes candidates only once it has enough recorded traces to measure them against; until then the configured defaults are in force.'
                      }
                      variant="plain"
                      size="sm"
                    />
                  </CardContent>
                </Card>
              </div>
            ) : null}

            {/*
              The curve: score by policy version, never by calendar day. Held
              back while the four reads are still in flight - an empty curve
              card during loading would say "nothing was measured", which is a
              claim, not a spinner.
            */}
            {!failed && !loading && !nothingEverWritten ? (
              <div className="px-4 lg:px-6">
                <VersionCurveCard
                  title="Score by policy version"
                  description={
                    'Holdout score of every measured version, with the incumbent it was measured against, from the latest ' +
                    formatNumber(HISTORY_LIMIT) +
                    ' versions per slot. ' +
                    formatNumber(measured) +
                    (measured === 1 ? ' version has been measured.' : ' versions have been measured.')
                  }
                  descriptionShort="Holdout score per version"
                  data={curve}
                  series={curveSeries}
                  {...cappedBadge(historyCapped)}
                  empty={
                    <EmptyState
                      icon={BrainIcon}
                      title="No version has been measured yet"
                      description="A version gets a score once a night has closed enough recorded traces over it."
                      variant="plain"
                      size="sm"
                    />
                  }
                />
              </div>
            ) : null}

            {/* The promotions themselves, each one a row that opens its diff sheet. */}
            {!failed && !nothingEverWritten ? (
              <DataTable
                data={promotions}
                columns={columns}
                getRowId={(version) => version.id}
                idPrefix="promotions"
                initialSorting={[{ id: 'promotedAt', desc: true }]}
                pageSize={10}
                columnLabels={PROMOTION_COLUMN_LABELS}
                initialColumnVisibility={{ auditCiLow: false }}
                rowLabel={{ singular: 'Promotion', plural: 'promotions' }}
                capped={historyCapped}
                loading={loading}
                onRowClick={setPromotion}
                rowClickIgnoreColumns={['actions']}
                rowClassName={(version) => (version.retiredAt ? 'opacity-70' : undefined)}
                empty={
                  <EmptyState
                    icon={BrainIcon}
                    title="Nothing has been promoted"
                    description="A measured version only goes into force once it clears the promotion gate, and memory.dream.promote is off by default."
                    variant="plain"
                    size="sm"
                  />
                }
              />
            ) : null}
          </div>
        </SectionHeading>
      </Fade>

      {/*
        One sheet for every promotion, the same way the nights table keeps one
        report drawer: a mounted vaul instance per row would bring its own
        portal and focus trap along.
      */}
      <DetailDrawer
        open={promotion !== null}
        onOpenChange={(open) => {
          if (!open) setPromotion(null);
        }}
        title="Diff sheet"
        description={
          sheet
            ? SLOT_LABEL[sheet.slot] +
              ' · v' +
              sheet.version +
              ' · promoted ' +
              formatDateTime(sheet.promotedAt)
            : undefined
        }
        footer={
          sheet && !sheet.retiredAt ? (
            <Button
              variant="outline"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={reverting === sheet.id}
              onClick={() => void revert(sheet)}
            >
              {reverting === sheet.id ? (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              ) : (
                <RotateCcwIcon data-icon="inline-start" />
              )}
              Revert this promotion
            </Button>
          ) : undefined
        }
      >
        {sheet ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{sheet.origin}</Badge>
              {sheet.retiredAt ? (
                <Badge variant="outline">retired {formatDateTime(sheet.retiredAt)}</Badge>
              ) : (
                <Badge variant="secondary">in force</Badge>
              )}
            </div>

            <SectionHeading
              title="What it was measured at"
              size="sm"
              level="h3"
              flush
              hint={
                sheetEval
                  ? 'From the evaluation of ' + formatDateTime(sheetEval.createdAt) + '.'
                  : evals === null
                    ? 'Loading the evaluation behind these numbers…'
                    : 'No evaluation is recorded for this version; only what the version itself stores is shown.'
              }
            >
              <MetaList
                columns={2}
                items={[
                  { label: 'Holdout score', value: score(sheet.replayScore) },
                  { label: 'Baseline', value: score(sheet.baselineScore) },
                  {
                    label: 'Delta (paired)',
                    value: sheetEval ? signed(sheetEval.delta) : EMPTY_CELL,
                  },
                  { label: 'ci_low', value: sheetEval ? signed(sheetEval.ciLow) : EMPTY_CELL },
                  {
                    label: 'audit_ci_low',
                    value: signed(sheet.auditCiLow ?? sheetEval?.auditCiLow),
                  },
                  { label: 'audit_delta', value: signed(sheet.auditDelta ?? sheetEval?.auditDelta) },
                  {
                    label: 'Traces closed',
                    value: sheetEval ? formatNumber(sheetEval.closed) : EMPTY_CELL,
                  },
                  {
                    label: 'Label coverage',
                    value: sheetEval ? score(sheetEval.labelCoverage) : EMPTY_CELL,
                  },
                ]}
              />
            </SectionHeading>

            <SectionHeading
              title="What changed"
              size="sm"
              level="h3"
              flush
              hint={
                previous
                  ? 'Against v' + previous.version + ', which was in force until this promotion.'
                  : 'Nothing was in force before this promotion, so the left column is the configured default and is not stored with the version.'
              }
            >
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Field</TableHead>
                      <TableHead>Before</TableHead>
                      <TableHead>After</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {diff.map((row) => (
                      <TableRow key={row.field} className={row.changed ? undefined : 'opacity-60'}>
                        <TableCell className="font-mono text-xs">{row.field}</TableCell>
                        <TableCell className="tabular-nums">
                          {previous ? paramText(row.before) : EMPTY_CELL}
                        </TableCell>
                        <TableCell className="tabular-nums">{paramText(row.after)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {previous && row.delta !== undefined && row.changed
                            ? signed(row.delta)
                            : EMPTY_CELL}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </SectionHeading>

            {sheet.rationale ? (
              <SectionHeading title="Reason" size="sm" level="h3" flush>
                <p className="whitespace-pre-wrap break-words text-muted-foreground">
                  {sheet.rationale}
                </p>
              </SectionHeading>
            ) : null}
          </>
        ) : null}
      </DetailDrawer>
    </>
  );
}
