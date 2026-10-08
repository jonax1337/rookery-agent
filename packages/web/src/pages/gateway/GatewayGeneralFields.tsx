import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup } from '@/components/ui/radio-group';
import { PERMISSION_HINT, PERMISSION_LABEL } from '@/lib/format';
import type { GatewayStatus, PermissionLevel, TelegramGatewayConfig } from '@/lib/types';
import { RadioOptionField, SwitchField } from '../settings/fields';

const PERMISSION_LEVELS: PermissionLevel[] = ['chat', 'read', 'write', 'full'];

interface DraftFieldProps {
  draft: TelegramGatewayConfig;
  set(patch: Partial<TelegramGatewayConfig>): void;
}

export function EnabledField({ draft, set }: DraftFieldProps) {
  return (
    <FieldSet>
      <SwitchField
        id="gw-enabled"
        label="Gateway enabled"
        description="When off, the bot stops regardless of how many IDs are allowed."
        checked={draft.enabled}
        onChange={(on) => set({ enabled: on })}
      />
    </FieldSet>
  );
}

export function BotTokenField({
  gateway,
  draft,
  set,
}: DraftFieldProps & { gateway: GatewayStatus }) {
  return (
    <Field>
      <FieldLabel htmlFor="gw-token">Bot token</FieldLabel>
      <Input
        id="gw-token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        disabled={gateway.tokenSource === 'env'}
        value={draft.token ?? ''}
        placeholder={gateway.configured ? 'Configured — leave empty to keep it' : 'From @BotFather'}
        onChange={(event) => set({ token: event.target.value })}
      />
      <FieldDescription>
        {gateway.tokenSource === 'env' ? (
          <>
            Provided by environment variable <code>TELEGRAM_BOT_TOKEN</code> which takes precedence here. Remove the variable and restart the server to edit the token here.
          </>
        ) : (
          <>
            The saved token is never returned. Leave this field empty to keep it, or enter a new value to replace it.
            {gateway.configured ? (
              <>
                {' '}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto gap-0 p-0 text-left align-baseline hover:text-destructive"
                  onClick={() => set({ token: null })}
                >
                  Remove token
                </Button>
                {draft.token === null ? ' — removed when you save.' : null}
              </>
            ) : null}
          </>
        )}
      </FieldDescription>
    </Field>
  );
}

export function PermissionSection({ draft, set }: DraftFieldProps) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Permissions</FieldLegend>
      <FieldDescription>Permissions for turns from this gateway.</FieldDescription>
      <RadioGroup
        value={draft.permission}
        onValueChange={(value) => set({ permission: value as PermissionLevel })}
      >
        {PERMISSION_LEVELS.map((level) => (
          <RadioOptionField
            key={level}
            id={'gw-permission-' + level}
            value={level}
            title={PERMISSION_LABEL[level]}
            hint={PERMISSION_HINT[level]}
          />
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

export function ModelField({ draft, set }: DraftFieldProps) {
  return (
    <Field>
      <FieldLabel htmlFor="gw-model">Model</FieldLabel>
      <Input
        id="gw-model"
        value={draft.model ?? ''}
        placeholder="Assistant default"
        onChange={(event) => set({ model: event.target.value })}
      />
      <FieldDescription>Leave empty to use the default model.</FieldDescription>
    </Field>
  );
}

export function ChatSection({ draft, set }: DraftFieldProps) {
  return (
    <FieldSet>
      <FieldLegend variant="label">In the chat</FieldLegend>
      <FieldDescription>How an answer arrives on the phone.</FieldDescription>
      <SwitchField
        id="gw-stream"
        label="Write as it is produced"
        description="One message, rewritten while the answer is written, instead of a wall of text at the end. Telegram has no streaming of its own, so this is an edit every second and a half — switch it off on a slow line or a rate-limited account."
        checked={draft.stream}
        onChange={(on) => set({ stream: on })}
      />
    </FieldSet>
  );
}
