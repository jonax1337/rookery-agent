import { useId, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';

import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
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
import { TerminalIcon } from '@/components/icons';

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
  name: z.string().trim().min(1, 'A name is required.'),
  command: z.string().trim().min(1, 'A command is required.'),
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
    toast('Server created', { description: created.name });
    void navigate('/tools/' + created.id);
  });

  usePageMeta(
    {
      breadcrumb: [{ label: 'Tools', to: '/tools' }, { label: 'Custom server' }],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo="/tools"
          submitLabel="Create"
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
        description={
          <Blur>
            Any stdio MCP server works. Keys and environment variables can be added on the server
            page afterward.
          </Blur>
        }
      >
        <Fade>
          <FieldSet>
            <Field>
              <FieldLabel htmlFor="tool-name">Name</FieldLabel>
              <Input
                id="tool-name"
                placeholder="e.g. Notion"
                value={draft.name}
                aria-invalid={Boolean(errors.name)}
                onChange={(event) => set({ name: event.target.value })}
              />
              <FieldError>{errors.name}</FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="tool-command">Command</FieldLabel>
              <InputGroup>
                <InputGroupAddon align="inline-start">
                  <TerminalIcon className="size-4" />
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
                The program itself, without arguments, available as an executable on this machine.
              </FieldDescription>
              <FieldError>{errors.command}</FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="tool-args">Arguments</FieldLabel>
              <Input
                id="tool-args"
                className="font-mono"
                placeholder="-y @notionhq/notion-mcp-server"
                value={draft.args}
                onChange={(event) => set({ args: event.target.value })}
              />
              <FieldDescription>Separated by spaces.</FieldDescription>
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
              <FieldLabel htmlFor="tool-audience-assistant">Audience</FieldLabel>
              <ChoiceField
                id="tool-audience"
                options={AUDIENCE_CHOICES}
                value={draft.audience}
                onChange={(audience) => set({ audience })}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="tool-hint">Guidance</FieldLabel>
              <Textarea
                id="tool-hint"
                rows={3}
                placeholder="What these tools are useful for and when they should be used."
                value={draft.hint}
                onChange={(event) => set({ hint: event.target.value })}
              />
              <FieldDescription>
                Shown alongside tool names in the system prompt, helping the assistant decide when
                to use this server.
              </FieldDescription>
            </Field>
          </FieldSet>
        </Fade>
      </FormPage>
    </PageBody>
  );
}
