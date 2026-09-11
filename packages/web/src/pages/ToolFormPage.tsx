import { useId, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { TerminalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { AUDIENCE_CHOICES } from '@/lib/tools';
import type { ToolServerAudience } from '@/lib/types';
import { useTools } from '@/hooks/useTools';
import { PageBody } from '@/components/blocks/page-body';
import { FormPage } from '@/components/blocks/form-page';
import { usePageMeta } from '@/components/shell/page-meta';
import {
  ChoiceField,
  FormHeaderActions,
  useDraft,
  useFormSubmit,
} from '@/components/forms/form-kit';
import { Badge } from '@/components/ui/badge';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Textarea } from '@/components/ui/textarea';

/**
 * A server of the user's own: any stdio MCP command.
 *
 * Only creating - there is no `PATCH` for the command line of a custom
 * server, so editing one means removing it and adding it again, and this page
 * does not pretend otherwise.
 *
 * The arguments field is one text input because that is how a person copies a
 * command out of a README. What the server will actually receive is shown
 * underneath as the parsed list, so the split is visible before it matters.
 */

interface ToolDraft {
  name: string;
  command: string;
  args: string;
  hint: string;
  audience: ToolServerAudience;
}

const EMPTY: ToolDraft = {
  name: '',
  command: '',
  args: '',
  hint: '',
  audience: 'assistant',
};

const schema = z.object({
  name: z.string().trim().min(1, 'Ein Name ist Pflicht.'),
  command: z.string().trim().min(1, 'Ohne Befehl gibt es nichts zu starten.'),
});

/** Whitespace-separated, the way a shell would read it. */
function parseArgs(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function ToolFormPage() {
  const navigate = useNavigate();
  const { addCustom } = useTools();

  const formId = useId();
  const { draft, dirty, set, markSaved } = useDraft<ToolDraft>(EMPTY);

  const args = useMemo(() => parseArgs(draft.args), [draft.args]);

  const { errors, failure, saving, submit } = useFormSubmit(schema, draft, async () => {
    // `addCustom` refetches the catalogue itself - a new server changes
    // more than its own row, and nothing broadcasts that over the socket.
    const created = await addCustom({
      name: draft.name.trim(),
      command: draft.command.trim(),
      args,
      hint: draft.hint.trim(),
      audience: draft.audience,
    });
    markSaved();
    toast('Server angelegt', { description: created.name });
    void navigate('/tools/' + created.id);
  });

  usePageMeta(
    {
      breadcrumb: [{ label: 'Werkzeuge', to: '/tools' }, { label: 'Eigener Server' }],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo="/tools"
          submitLabel="Anlegen"
          submitting={saving}
          submitDisabled={!dirty || saving}
        />
      ),
    },
    [dirty, formId, saving],
  );

  return (
    <PageBody width="2xl">
      <FormPage
        formId={formId}
        showActions={false}
        onSubmit={submit}
        error={failure}
        description="Jeder stdio-MCP-Server geht. Schlüssel und Umgebungsvariablen lassen sich danach auf der Seite des Servers eintragen."
      >
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="tool-name">Name</FieldLabel>
            <Input
              id="tool-name"
              placeholder="z. B. Notion"
              value={draft.name}
              aria-invalid={Boolean(errors.name)}
              onChange={(event) => set({ name: event.target.value })}
            />
            <FieldError>{errors.name}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="tool-command">Befehl</FieldLabel>
            <InputGroup>
              <InputGroupAddon align="inline-start">
                <TerminalIcon />
              </InputGroupAddon>
              <InputGroupInput
                id="tool-command"
                className="font-mono"
                placeholder="npx"
                value={draft.command}
                aria-invalid={Boolean(errors.command)}
                onChange={(event) => set({ command: event.target.value })}
              />
            </InputGroup>
            <FieldDescription>
              Das Programm selbst, ohne Argumente — auf diesem Rechner ausführbar.
            </FieldDescription>
            <FieldError>{errors.command}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="tool-args">Argumente</FieldLabel>
            <Input
              id="tool-args"
              className="font-mono"
              placeholder="-y @notionhq/notion-mcp-server"
              value={draft.args}
              onChange={(event) => set({ args: event.target.value })}
            />
            <FieldDescription>Durch Leerzeichen getrennt.</FieldDescription>
            {args.length ? (
              <div className="flex flex-wrap gap-1.5">
                {args.map((arg, index) => (
                  <Badge key={index + '-' + arg} variant="secondary" className="font-mono text-xs">
                    {arg}
                  </Badge>
                ))}
              </div>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="tool-audience-assistant">Für wen</FieldLabel>
            <ChoiceField
              id="tool-audience"
              options={AUDIENCE_CHOICES}
              value={draft.audience}
              onChange={(audience) => set({ audience })}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="tool-hint">Hinweis</FieldLabel>
            <Textarea
              id="tool-hint"
              rows={3}
              placeholder="Wofür diese Werkzeuge gut sind und wann er sie nehmen soll."
              value={draft.hint}
              onChange={(event) => set({ hint: event.target.value })}
            />
            <FieldDescription>
              Steht im Systemprompt neben den Werkzeugnamen — daran entscheidet sich, ob der Server
              je benutzt wird.
            </FieldDescription>
          </Field>
        </FieldSet>
      </FormPage>
    </PageBody>
  );
}
