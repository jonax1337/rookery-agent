import { useMemo, useState } from 'react';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useListeners } from '@/hooks/useListeners';
import { timeAgo } from '@/lib/format';
import { listenerStateLook } from '@/lib/listeners';
import type { ImapListenerConfig, ListenerStatus, PublicConfig } from '@/lib/types';
import { useCronState } from '@/providers/rookery-provider';
import { parseIntegerInRange } from './fields';

const MIN_PORT = 1;
const MAX_PORT = 65535;
const IMAP_TLS_PORT = 993;

/** What a new mailbox starts as: implicit TLS on 993, and off until it is finished. */
const NEW_LISTENER: ImapListenerConfig = {
  id: '',
  enabled: false,
  host: '',
  port: IMAP_TLS_PORT,
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
 * other section on this page, so the footer's "Save" writes them; only the
 * state beside each row comes from `GET /api/listeners`.
 */
export function MailboxesSection({
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

  const changeEntry = (index: number, change: Partial<ImapListenerConfig>): void =>
    setListeners(
      entries.map((current, position) => (position === index ? { ...current, ...change } : current)),
    );

  const removeEntry = (index: number): void =>
    setListeners(entries.filter((_, position) => position !== index));

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
          <MailboxRow
            key={index}
            entry={entry}
            index={index}
            status={live.find((candidate) => candidate.id === entry.id)}
            jobOptions={jobOptions}
            onChange={(change) => changeEntry(index, change)}
            onRemove={() => removeEntry(index)}
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
function MailboxRow({
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
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <MailboxHeader entry={entry} status={status} onChange={onChange} />

      <div className="grid gap-3 sm:grid-cols-2">
        <MailboxTextField
          id={'listener-id-' + index}
          label="Name"
          value={entry.id}
          placeholder="work"
          description={'Runs record it as imap:' + (entry.id || 'name') + '.'}
          onChange={(id) => onChange({ id })}
        />

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

        <MailboxTextField
          id={'listener-host-' + index}
          label="Server"
          value={entry.host}
          placeholder="imap.example.com"
          onChange={(host) => onChange({ host })}
        />

        <PortField id={'listener-port-' + index} port={entry.port} onChange={(port) => onChange({ port })} />

        <MailboxTextField
          id={'listener-user-' + index}
          label="User"
          value={entry.user}
          placeholder="name@example.com"
          onChange={(user) => onChange({ user })}
        />

        <MailboxTextField
          id={'listener-mailbox-' + index}
          label="Mailbox"
          value={entry.mailbox}
          placeholder="INBOX"
          onChange={(mailbox) => onChange({ mailbox })}
        />
      </div>

      <PasswordField
        id={'listener-password-' + index}
        password={entry.password}
        stored={Boolean(status?.configured)}
        onChange={(password) => onChange({ password })}
      />

      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove mailbox
        </Button>
      </div>
    </div>
  );
}

/** Name, live state and the on/off switch of one mailbox. */
function MailboxHeader({
  entry,
  status,
  onChange,
}: {
  entry: ImapListenerConfig;
  status: ListenerStatus | undefined;
  onChange(change: Partial<ImapListenerConfig>): void;
}) {
  const look = status ? listenerStateLook(status) : null;

  return (
    <>
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
    </>
  );
}

/** A plain text field of a mailbox: no autofill, no spellcheck. */
function MailboxTextField({
  id,
  label,
  value,
  placeholder,
  description,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  description?: string;
  onChange(value: string): void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

function PortField({
  id,
  port,
  onChange,
}: {
  id: string;
  port: number;
  onChange(port: number): void;
}) {
  // The typed port lives here until it parses, so clearing the field to type
  // a new one cannot put `NaN` or a stray `0` in the draft.
  const [rawPort, setRawPort] = useState<string | null>(null);
  const shownPort = rawPort ?? String(port);
  const invalidPort = parseIntegerInRange(shownPort, MIN_PORT, MAX_PORT) === null;

  const handleChange = (next: string): void => {
    setRawPort(next);
    const parsed = parseIntegerInRange(next, MIN_PORT, MAX_PORT);
    if (parsed !== null) onChange(parsed);
  };

  return (
    <Field data-invalid={invalidPort || undefined}>
      <FieldLabel htmlFor={id}>Port</FieldLabel>
      <Input
        id={id}
        inputMode="numeric"
        value={shownPort}
        aria-invalid={invalidPort || undefined}
        onChange={(event) => handleChange(event.target.value)}
        onBlur={() => setRawPort(null)}
      />
      <FieldError>
        {invalidPort ? `Enter a port between ${MIN_PORT} and ${MAX_PORT}.` : null}
      </FieldError>
    </Field>
  );
}

/**
 * `password` is null when the person asked to clear the stored one, an empty
 * string when the field is untouched, `stored` whether the server has one.
 */
function PasswordField({
  id,
  password,
  stored,
  onChange,
}: {
  id: string;
  password: string | null;
  stored: boolean;
  onChange(password: string | null): void;
}) {
  const clearing = password === null;
  const placeholder = clearing
    ? 'Will be removed when you save'
    : stored
      ? 'Saved — leave empty to keep it'
      : 'Mailbox password';

  return (
    <Field>
      <FieldLabel htmlFor={id}>Password</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          className="min-w-0 flex-1"
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={clearing}
          value={password ?? ''}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        {clearing ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange('')}>
            Keep it
          </Button>
        ) : stored ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            Clear
          </Button>
        ) : null}
      </div>
      <FieldDescription>
        The password stays on the server and is never sent back to this page.
      </FieldDescription>
    </Field>
  );
}
