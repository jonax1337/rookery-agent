import { BadgeAlertIcon as TriangleAlertIcon, CheckIcon } from '@/components/icons';

import type { ToolCatalogEnv, ToolServer } from '@/lib/types';
import { FormField } from '@/components/forms/form-kit';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldLegend, FieldSet } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';

import type { ToolDraft } from './tool-draft';

interface KeysCardProps {
  tool: ToolServer;
  draft: ToolDraft;
  onEnvChange(name: string, value: string): void;
}

/** The credentials a server needs, one write-only field each. */
export function ToolKeysCard({ tool, draft, onEnvChange }: KeysCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Keys</CardTitle>
        <CardDescription>
          Stored in Rookery configuration and passed only to the server process. Saved keys are
          never returned to the browser; enter a new value to update one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldSet>
          <FieldLegend variant="label">Credentials</FieldLegend>
          {tool.envDefs.map((item) => (
            <KeyField
              key={item.name}
              item={item}
              isSet={tool.envSet[item.name] === true}
              stillMissing={tool.missingEnv.includes(item.name)}
              value={draft.env[item.name] ?? ''}
              onChange={(value) => onEnvChange(item.name, value)}
            />
          ))}
        </FieldSet>
      </CardContent>
    </Card>
  );
}

function KeyField({
  item,
  isSet,
  stillMissing,
  value,
  onChange,
}: {
  item: ToolCatalogEnv;
  isSet: boolean;
  /** The server reports this key as still missing. */
  stillMissing: boolean;
  value: string;
  onChange(value: string): void;
}) {
  const showRequired = item.required && stillMissing && value.trim() === '';

  return (
    // FormField attaches the guidance and the message to the input through
    // `aria-describedby`; `data-invalid` alone only coloured the group.
    <FormField
      id={'env-' + item.name}
      label={
        <>
          {item.label}
          <Badge
            variant={isSet ? 'outline' : item.required ? 'destructive' : 'secondary'}
            className="font-normal"
          >
            {isSet ? 'set' : 'missing'}
          </Badge>
        </>
      }
      error={showRequired ? 'Required' : null}
      {...(item.hint ? { description: item.hint } : {})}
    >
      {(control) => (
        <InputGroup>
          <InputGroupInput
            {...control}
            type={item.secret ? 'password' : 'text'}
            autoComplete="off"
            placeholder={isSet ? '••••••••' : 'not set'}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <InputGroupAddon align="inline-end">
            {isSet ? (
              <CheckIcon className="text-status-ok" aria-hidden="true" />
            ) : (
              <TriangleAlertIcon
                className={item.required ? 'text-destructive' : undefined}
                aria-hidden="true"
              />
            )}
          </InputGroupAddon>
        </InputGroup>
      )}
    </FormField>
  );
}

/** How a custom server starts. Read-only: there is no `PATCH` for the command line. */
export function ToolCommandCard({ custom }: { custom: NonNullable<ToolServer['custom']> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Command</CardTitle>
        <CardDescription>
          This is how the server starts. To change the command, remove this entry and create
          another.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs">
          {custom.command + ' ' + custom.args.join(' ')}
        </pre>
        {custom.hint ? <p className="text-sm text-muted-foreground">{custom.hint}</p> : null}
      </CardContent>
    </Card>
  );
}
