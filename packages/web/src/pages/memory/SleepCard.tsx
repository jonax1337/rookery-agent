import { useCallback, useEffect, useState } from 'react';

import { MoonIcon, SunIcon } from '@/components/icons';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { SLEEP_PHASE_DETAIL, SLEEP_PHASE_LABEL } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { MemoryState } from '@/providers/rookery-provider';
import {
  RotatingText,
  RotatingTextContainer,
} from '@/components/animate-ui/primitives/texts/rotating';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { MetaList } from '@/components/common/meta-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';

type Sleep = MemoryState['sleep'];

/** The night's state, its controls and its own clock. */
export function SleepCard({ sleep, onStart }: { sleep: Sleep; onStart(): void }) {
  const running = sleep.status?.running ?? false;
  const config = sleep.status?.config ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {/* size keeps the resting pose: the card title has no CSS
              sizing for svgs, and lucide's default was 24. */}
          <MoonIcon
            size={24}
            className={running ? 'animate-pulse text-primary' : 'text-muted-foreground'}
            aria-hidden="true"
          />
          Sleep
          {running ? <RunningIndicators sleep={sleep} /> : null}
        </CardTitle>
        <CardDescription>
          {running
            ? (SLEEP_PHASE_DETAIL[sleep.phase] ?? 'Memory is being reorganized.')
            : 'Light sleep cleans up, deep sleep consolidates and resolves conflicts, and dream sleep creates connections and insights. Nothing is deleted.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button variant="outline" onClick={() => void sleep.cancel()}>
              {/* Animates on hover of its wrapper span - the button base `[&_svg]:pointer-events-none` mutes only the svg, not the span. */}
              <SunIcon data-icon="inline-start" />
              Wake
            </Button>
          ) : (
            <Button disabled={sleep.busy} onClick={onStart}>
              {sleep.busy ? (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              ) : (
                <MoonIcon data-icon="inline-start" />
              )}
              Run memory sleep now
            </Button>
          )}
          <span className="text-sm text-muted-foreground">{nextRunText(sleep)}</span>
        </div>

        <NightlySchedule sleep={sleep} />

        {config ? (
          <MetaList
            columns={3}
            items={[
              {
                label: 'Scope',
                value: config.scope === 'all' ? 'Assistant and agents' : 'assistant only',
              },
              { label: 'Cycles per night', value: formatNumber(config.cycles) },
              { label: 'Consolidate with', value: config.model || 'Default model' },
              {
                label: 'Generate insights with',
                value: config.insightModel || config.model || 'Default model',
              },
              {
                label: 'Put to sleep after',
                value: formatNumber(config.dormantAfterDays) + ' days without recall',
              },
              {
                label: 'Night budget',
                value: formatNumber(config.nightBudget) + ' model calls at most',
              },
            ]}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RunningIndicators({ sleep }: { sleep: Sleep }) {
  return (
    <>
      {/* The one label here that changes on its own; RotatingText
          slides it over whenever the sleep phase flips. */}
      <Badge variant="secondary">
        <RotatingTextContainer text={SLEEP_PHASE_LABEL[sleep.phase] ?? 'is running'}>
          <RotatingText />
        </RotatingTextContainer>
      </Badge>
      {sleep.cycle > 0 ? (
        <span className="text-sm font-normal text-muted-foreground tabular-nums">
          Cycle <SlidingNumber number={sleep.cycle} thousandSeparator="," />
        </span>
      ) : null}
      <Spinner aria-label="Running" />
    </>
  );
}

function nextRunText({ status }: Sleep): string {
  const schedule = status?.schedule;
  if (schedule?.enabled && schedule.nextRunAt) {
    return 'Next run ' + formatDateTime(schedule.nextRunAt);
  }
  return status?.config?.enabled === false
    ? 'The nightly run is disabled.'
    : 'No schedule configured.';
}

/**
 * The nightly run's own clock: hidden from the schedules page, so this row is
 * where it is read and changed.
 */
function NightlySchedule({ sleep }: { sleep: Sleep }) {
  const { status } = sleep;
  const { draft, edit, dirty, saving, saveEnabled, saveDraft } = useScheduleEditor(sleep);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <Switch
          id="sleep-enabled"
          checked={status?.schedule?.enabled ?? status?.config?.enabled ?? true}
          onCheckedChange={(checked) => void saveEnabled(checked)}
          disabled={saving}
        />
        <Label htmlFor="sleep-enabled" className="text-sm font-normal text-muted-foreground">
          Nightly run
        </Label>
      </div>
      <Input
        value={draft}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void saveDraft();
        }}
        placeholder="30 3 * * *"
        className="w-44 font-mono text-sm"
        aria-label="Cron expression for the nightly run"
      />
      <Button
        variant="outline"
        size="sm"
        disabled={!dirty || saving || !draft.trim()}
        onClick={() => void saveDraft()}
      >
        {saving ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
        Save schedule
      </Button>
    </div>
  );
}

/**
 * The draft follows the server until the user types into it, so a schedule
 * changed elsewhere (or by the server normalising the expression) shows up
 * without a reload. Once dirty, the page stops overwriting what is typed.
 */
function useScheduleEditor(sleep: Sleep) {
  const serverSchedule = sleep.status?.schedule?.schedule ?? sleep.status?.config?.schedule ?? '';
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(serverSchedule);
  }, [dirty, serverSchedule]);

  const edit = useCallback((value: string) => {
    setDraft(value);
    setDirty(true);
  }, []);

  const saveEnabled = async (enabled: boolean): Promise<void> => {
    setSaving(true);
    const ok = await sleep.saveSchedule({ enabled });
    setSaving(false);
    if (ok) toast(enabled ? 'The nightly run is on' : 'The nightly run is off');
    else toast.error('The nightly schedule could not be saved');
  };

  const saveDraft = async (): Promise<void> => {
    const expression = draft.trim();
    if (!expression) return;
    setSaving(true);
    try {
      // Validate and normalise through the same endpoint the schedules page
      // uses, so the description shown is the server's own reading.
      const check = await api.cronPreview(expression);
      if (!check.ok) {
        toast.error(check.error || 'That is not a valid cron expression.');
        return;
      }
      const ok = await sleep.saveSchedule({ schedule: check.schedule });
      if (!ok) {
        toast.error('The nightly schedule could not be saved');
        return;
      }
      setDirty(false);
      toast('Nightly schedule saved: ' + check.description);
    } catch (caught) {
      reportFailure('Save schedule', caught);
    } finally {
      setSaving(false);
    }
  };

  return { draft, edit, dirty, saving, saveEnabled, saveDraft };
}
