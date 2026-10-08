import { useState } from 'react';
import { PlusIcon } from '@/components/icons';
import { RemovableChip } from '@/components/common/removable-chip';
import { Field, FieldDescription, FieldLegend, FieldSet } from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import type { TelegramGatewayConfig } from '@/lib/types';
import { SwitchField } from '../settings/fields';

type NewIdCheck = { id: number } | { error: string };

function checkNewId(text: string, allowed: number[]): NewIdCheck {
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { error: 'Enter a positive whole-number Telegram ID.' };
  }
  if (allowed.includes(parsed)) return { error: 'This ID is already in the list.' };
  return { id: parsed };
}

export function AllowedIdsSection({
  draft,
  onAdd,
  onRemove,
  onPairingChange,
}: {
  draft: TelegramGatewayConfig;
  onAdd(value: number): void;
  onRemove(value: number): void;
  onPairingChange(on: boolean): void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Allowed controller IDs</FieldLegend>
      <FieldDescription>
        An empty list allows no control access. To find your own ID, enable the gateway and pairing, save, then send <code>/id</code> to the bot in a private chat.
      </FieldDescription>
      {draft.allowedUserIds.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {draft.allowedUserIds.map((value) => (
            <RemovableChip
              key={value}
              label={value}
              removeLabel={'Remove ' + value}
              onRemove={() => onRemove(value)}
              className="font-mono tabular-nums"
            />
          ))}
        </div>
      ) : null}
      <NewIdField allowed={draft.allowedUserIds} onAdd={onAdd} />
      <SwitchField
        id="gw-pairing"
        label="Pairing"
        description={
          <>
            Allows an enabled gateway to run with an empty allowlist so <code>/id</code> can reply. Only <code>/id</code> replies with the sender ID; all other messages are rejected. Adding the first allowed ID turns pairing off.
          </>
        }
        checked={draft.pairing}
        onChange={onPairingChange}
      />
    </FieldSet>
  );
}

function NewIdField({ allowed, onAdd }: { allowed: number[]; onAdd(value: number): void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = (): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const check = checkNewId(trimmed, allowed);
    if ('error' in check) {
      setError(check.error);
      return;
    }
    onAdd(check.id);
    setText('');
    setError(null);
  };

  return (
    <Field data-invalid={error ? true : undefined}>
      <InputGroup>
        <InputGroupInput
          id="gw-new-id"
          aria-label="Controller user ID"
          inputMode="numeric"
          placeholder="Telegram ID, e.g. 123456789"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton onClick={add}>
            <PlusIcon data-icon="inline-start" />
            Add
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </Field>
  );
}
