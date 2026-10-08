import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel, FieldSet } from '@/components/ui/field';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { failureMessage, reportFailure } from '@/lib/errors';
import type { UpdateStatus, UpdatesConfig } from '@/lib/types';

const MODE_LABEL: Record<UpdatesConfig['mode'], string> = {
  off: 'Off',
  notify: 'Tell me',
  auto: 'Install automatically',
};

const MODE_HINT: Record<UpdatesConfig['mode'], string> = {
  off: 'Rookery never looks for new versions.',
  notify: 'Rookery looks every few hours and shows a new version here. You decide when to install it.',
  auto: 'Rookery installs a new version by itself, but only while no conversation, agent run, schedule or terminal is active.',
};

const CHANNEL_LABEL: Record<UpdatesConfig['channel'], string> = {
  latest: 'Stable releases',
  next: 'Pre-releases',
};

/** How long the page waits for the restarted server before giving up on it. */
const RESTART_TIMEOUT_MS = 5 * 60 * 1000;
const RESTART_POLL_MS = 2000;

interface RestartTarget {
  from: string;
  to: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

function statusLine(status: UpdateStatus | null, restarting: RestartTarget | null): string {
  if (restarting) {
    return `Installing ${restarting.to} and restarting. This page reloads when it is back.`;
  }
  if (status?.error) return `The last check failed: ${status.error}`;
  if (!status?.checkedAt) return 'Not checked since Rookery started.';
  return status.available
    ? `Last checked ${when(status.checkedAt)}.`
    : `Up to date as of ${when(status.checkedAt)}.`;
}

/**
 * Settings → Updates. The mode and channel are part of the settings draft
 * (saved with the dialog's Save); checking and installing act right away.
 */
export function AppUpdates({
  settings,
  onChange,
}: {
  settings: UpdatesConfig;
  onChange(patch: Partial<UpdatesConfig>): void;
}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState<{ from: string; to: string } | null>(null);
  const { confirm, dialog } = useConfirm();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    api.updates().then(setStatus, () => undefined);
    return () => {
      mounted.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const next = await api.checkUpdates();
      setStatus(next);
      if (next.error) toast.error('Update check failed', { description: next.error });
      else if (!next.available) toast.success('Rookery is up to date');
    } catch (caught) {
      reportFailure('Update check', caught);
    } finally {
      setChecking(false);
    }
  }, []);

  /**
   * Wait for the server to go away and come back. The old one answers for a
   * moment after accepting the install, so a version only counts once the
   * server has been unreachable in between.
   */
  const waitForRestart = useCallback(async (target: RestartTarget) => {
    const started = Date.now();
    let wentDown = false;
    while (mounted.current && Date.now() - started < RESTART_TIMEOUT_MS) {
      await sleep(RESTART_POLL_MS);
      try {
        const health = await api.health();
        if (!wentDown) continue;
        if (health.version === target.to) {
          toast.success(`Rookery ${target.to} is running`);
          window.location.reload();
          return;
        }
        // Back on the old version: the updater rolled back and says why.
        const next = await api.updates();
        setStatus(next);
        setRestarting(null);
        toast.error('Update failed', { description: next.lastResult?.error ?? `Still on ${health.version}.` });
        return;
      } catch {
        wentDown = true;
      }
    }
    if (mounted.current) {
      setRestarting(null);
      toast.error('Rookery did not come back', {
        description: 'Look at ~/.rookery/logs/update.log, or run rookery start.',
      });
    }
  }, []);

  const install = useCallback(async () => {
    if (!status?.latest) return;
    let force = false;
    if (status.busy.length) {
      const ok = await confirm({
        title: 'Update anyway?',
        description: `Installing restarts Rookery, and right now ${status.busy.join(', ')}. That work will be stopped.`,
        confirmLabel: 'Update and restart',
        destructive: true,
      });
      if (!ok) return;
      force = true;
    }
    try {
      const target = await api.installUpdate(force);
      setRestarting(target);
      void waitForRestart(target);
    } catch (caught) {
      toast.error('Update did not start', { description: failureMessage(caught) });
      api.updates().then(setStatus, () => undefined);
    }
  }, [confirm, status, waitForRestart]);

  const last = status?.lastResult;

  return (
    <FieldSet>
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>
            Rookery {status?.current ?? '…'}
            {status?.available ? <Badge>{status.latest} available</Badge> : null}
          </ItemTitle>
          <ItemDescription>
            {statusLine(status, restarting)}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {restarting ? (
            <Spinner aria-label="Restarting" />
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" disabled={checking} onClick={() => void check()}>
                {checking ? <Spinner aria-label="Checking" /> : null}
                Check now
              </Button>
              {status?.available && status.installable ? (
                <Button type="button" size="sm" onClick={() => void install()}>
                  Install {status.latest}
                </Button>
              ) : null}
            </>
          )}
        </ItemActions>
      </Item>

      {status?.available && status.releaseNotesUrl ? (
        <FieldDescription>
          <a href={status.releaseNotesUrl} target="_blank" rel="noreferrer">
            What is new in {status.latest}
          </a>
        </FieldDescription>
      ) : null}

      {status && !status.installable && status.reason ? <FieldDescription>{status.reason}</FieldDescription> : null}

      {last && !last.ok ? (
        <FieldDescription className="text-destructive">
          The update to {last.to} on {when(last.at)} failed{last.rolledBack ? ' and was rolled back' : ''}: {last.error}
        </FieldDescription>
      ) : null}

      <OptionField
        id="set-update-mode"
        label="Updates"
        hint={MODE_HINT[settings.mode]}
        value={settings.mode}
        labels={MODE_LABEL}
        onChange={(mode) => onChange({ mode })}
      />

      <OptionField
        id="set-update-channel"
        label="Channel"
        hint="Pre-releases arrive earlier and may still have rough edges."
        value={settings.channel}
        labels={CHANNEL_LABEL}
        onChange={(channel) => onChange({ channel })}
      />
      {dialog}
    </FieldSet>
  );
}

interface OptionFieldProps<T extends string> {
  id: string;
  label: string;
  hint: string;
  value: T;
  labels: Record<T, string>;
  onChange(value: T): void;
}

function OptionField<T extends string>({ id, label, hint, value, labels, onChange }: OptionFieldProps<T>) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{hint}</FieldDescription>
      </FieldContent>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id} className="w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(labels) as T[]).map((option) => (
            <SelectItem key={option} value={option}>
              {labels[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
