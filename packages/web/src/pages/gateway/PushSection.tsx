import type { ReactNode } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup } from '@/components/ui/radio-group';
import type { TelegramGatewayConfig, TelegramPushConfig } from '@/lib/types';
import { NumberField, RadioOptionField, SwitchField } from '../settings/fields';

const MIN_MESSAGES_PER_HOUR = 1;
const MAX_MESSAGES_PER_HOUR = 1000;

/** Which agents' reports reach the phone, widest first. */
const AGENT_REPORT_LEVELS: TelegramPushConfig['agents'][] = ['leads', 'all', 'off'];

const AGENT_REPORT_LABEL: Record<TelegramPushConfig['agents'], string> = {
  leads: 'Leads',
  all: 'All',
  off: 'Off',
};

const AGENT_REPORT_HINT: Record<TelegramPushConfig['agents'], string> = {
  leads: 'Anyone leading a team or with agents reporting to them — a Head of without a team counts.',
  all: 'Every agent that reports to you.',
  off: 'Agent reports stay in the web notifications only.',
};

type PushEvent = 'assignments' | 'cron' | 'sleep' | 'activity' | 'tools' | 'tasks';

/** The notification kinds that sit below the agent reports, one switch each. */
const PUSH_EVENTS: { key: PushEvent; label: string; description: ReactNode }[] = [
  {
    key: 'assignments',
    label: 'Runs',
    description: 'One message per finished run. Off by default: results arrive as notifications.',
  },
  {
    key: 'cron',
    label: 'Every schedule run',
    description: 'A short line for runs that stay silent too. Results are covered by Schedules above.',
  },
  {
    key: 'sleep',
    label: 'Sleep',
    description: "The night's report and a promoted retrieval policy.",
  },
  {
    key: 'activity',
    label: 'Activity',
    description:
      'What the app shows as a toast, as it happens: a memory stored, a skill written, an agent or project saved. Collected for a few seconds and sent as one message.',
  },
  {
    key: 'tools',
    label: 'Tool calls',
    description: (
      <>
        Every tool the assistant reaches for, one short line each — <code>Read · package.json</code>. Loud by nature, and never held for later: during quiet hours these are dropped rather than delivered in the morning.
      </>
    ),
  },
  {
    key: 'tasks',
    label: 'Tasks',
    description: 'A task you asked for is done, failed or cancelled.',
  },
];

function eventPatch(key: PushEvent, on: boolean): Partial<TelegramPushConfig> {
  const patch: Partial<TelegramPushConfig> = {};
  patch[key] = on;
  return patch;
}

interface PushFieldProps {
  push: TelegramPushConfig;
  setPush(patch: Partial<TelegramPushConfig>): void;
}

export function PushSection({
  draft,
  setPush,
  onToggleRecipient,
}: {
  draft: TelegramGatewayConfig;
  setPush(patch: Partial<TelegramPushConfig>): void;
  onToggleRecipient(value: number, on: boolean): void;
}) {
  const { push } = draft;

  return (
    <FieldSet>
      <FieldLegend variant="label">Push</FieldLegend>
      <FieldDescription>
        Notifications the assistant sends outside an active conversation.
      </FieldDescription>

      <SwitchField
        id="gw-push-enabled"
        label="Push enabled"
        description="When off, all notification types below are disabled."
        checked={push.enabled}
        onChange={(on) => setPush({ enabled: on })}
      />

      <p className="text-sm text-muted-foreground">Questions from agents are always sent.</p>

      <SwitchField
        id="gw-push-schedules"
        label="Schedules"
        description="A schedule's result, agent jobs included, and what the board watcher reports."
        checked={push.schedules}
        onChange={(on) => setPush({ schedules: on })}
      />

      <AgentReportsGroup push={push} setPush={setPush} />

      {PUSH_EVENTS.map(({ key, label, description }) => (
        <SwitchField
          key={key}
          id={'gw-push-' + key}
          label={label}
          description={description}
          checked={push[key]}
          onChange={(on) => setPush(eventPatch(key, on))}
        />
      ))}

      <QuietHoursFields push={push} setPush={setPush} />

      <NumberField
        id="gw-max-per-hour"
        label="Hourly limit"
        value={push.maxPerHour}
        min={MIN_MESSAGES_PER_HOUR}
        max={MAX_MESSAGES_PER_HOUR}
        suffix="messages"
        onChange={(value) => setPush({ maxPerHour: value })}
      />

      <RecipientsField
        allowedUserIds={draft.allowedUserIds}
        recipients={push.recipients}
        onToggle={onToggleRecipient}
      />
    </FieldSet>
  );
}

function AgentReportsGroup({ push, setPush }: PushFieldProps) {
  return (
    <>
      <Field>
        <FieldLabel>Agent reports</FieldLabel>
        <FieldDescription>Which agents' reports to you are worth a push.</FieldDescription>
      </Field>
      <RadioGroup
        value={push.agents}
        onValueChange={(value) => setPush({ agents: value as TelegramPushConfig['agents'] })}
      >
        {AGENT_REPORT_LEVELS.map((level) => (
          <RadioOptionField
            key={level}
            id={'gw-push-agents-' + level}
            value={level}
            title={AGENT_REPORT_LABEL[level]}
            hint={AGENT_REPORT_HINT[level]}
          />
        ))}
      </RadioGroup>
    </>
  );
}

function QuietHoursFields({ push, setPush }: PushFieldProps) {
  return (
    <>
      <div className="grid gap-4 @md/main:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="gw-quiet-from">Quiet hours from</FieldLabel>
          <Input
            id="gw-quiet-from"
            type="time"
            value={push.quietFrom}
            onChange={(event) => setPush({ quietFrom: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="gw-quiet-until">Quiet hours until</FieldLabel>
          <Input
            id="gw-quiet-until"
            type="time"
            value={push.quietUntil}
            onChange={(event) => setPush({ quietUntil: event.target.value })}
          />
        </Field>
      </div>
      <FieldDescription>Leave both empty to disable quiet hours.</FieldDescription>
    </>
  );
}

function RecipientsField({
  allowedUserIds,
  recipients,
  onToggle,
}: {
  allowedUserIds: number[];
  recipients: number[];
  onToggle(value: number, on: boolean): void;
}) {
  return (
    <Field>
      <FieldLabel>Recipients</FieldLabel>
      <FieldDescription>
        Choose from the allowed IDs. Leave empty to use the first allowed ID.
      </FieldDescription>
      {allowedUserIds.length > 0 ? (
        <div className="flex flex-col gap-2">
          {allowedUserIds.map((value) => (
            <Label
              key={value}
              htmlFor={'gw-recipient-' + value}
              className="flex items-center gap-2 font-mono font-normal tabular-nums"
            >
              <Checkbox
                id={'gw-recipient-' + value}
                checked={recipients.includes(value)}
                onCheckedChange={(checked) => onToggle(value, checked === true)}
              />
              {value}
            </Label>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Add an allowed ID above before selecting a recipient.
        </p>
      )}
    </Field>
  );
}
