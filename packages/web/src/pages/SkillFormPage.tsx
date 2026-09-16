import { forwardRef, useCallback, useEffect, useId, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { DeleteIcon as Trash2Icon, FileTextIcon, SparklesIcon as AnimatedSparklesIcon } from "@/components/icons";
import { toast } from 'sonner';
import { z } from 'zod';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { AUDIENCE_CHOICES } from '@/lib/tools';
import type { Skill, ToolServerAudience } from '@/lib/types';
import { useSkill } from '@/hooks/useSkills';
import { PageBody } from '@/components/blocks/page-body';
import { FormPage } from '@/components/blocks/form-page';
import { usePageMeta } from '@/components/shell/page-meta';
import { EmptyState } from '@/components/common/empty-state';
import { useDeleteSkill } from '@/components/common/entity-actions';
import {
  ChoiceField,
  FormFieldsSkeleton,
  FormHeaderActions,
  useDraft,
  useFormSubmit,
} from '@/components/forms/form-kit';
import { ResultMarkdown } from '@/components/result-markdown';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import type { IconComponent } from "@/components/icons";

/**
 * Write a skill: a name, the one sentence that decides when it is opened, and
 * the instructions themselves.
 *
 * The instructions are Markdown that a model reads, so the page now shows
 * them as Markdown too - "Schreiben" and "Vorschau" as two tabs over the same
 * text. Until now the only way to see whether a heading was actually a
 * heading was to save and open the skill elsewhere.
 */

const TEMPLATE = `## When to use
When the user wants to ...

## Steps
1. ...
2. ...

## How to know it is complete
- ...
`;

interface SkillDraft {
  name: string;
  description: string;
  audience: ToolServerAudience;
  body: string;
}

const EMPTY: SkillDraft = {
  name: '',
  description: '',
  audience: 'both',
  body: TEMPLATE,
};

/** The server's own folder rule - a skill's name is its directory. */
const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'A name is required.')
    .regex(
      /^[a-z0-9][a-z0-9-]{0,63}$/,
      'Lowercase letters, numbers, and hyphens, starting with a letter or number.',
    ),
  description: z
    .string()
    .trim()
    .min(1, 'Without this sentence, the skill will never be opened.'),
});

function draftOf(skill: Skill): SkillDraft {
  return {
    name: skill.name,
    description: skill.description,
    audience: skill.audience,
    body: skill.body,
  };
}

/**
 * The empty-state icon as an animate-ui version. `EmptyState` takes a
 * `IconComponent` and renders it without props, so the animated icon sits in a
 * forwardRef shell that carries its `animateOnView` trigger along.
 */
const EmptySparklesIcon = forwardRef<SVGSVGElement>(function EmptySparklesIcon() {
  return <AnimatedSparklesIcon />;
});

export function SkillFormPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { skill, loading, save: saveSkill, remove: removeSkill } = useSkill(name);
  const { dialog, deleteSkill } = useDeleteSkill(removeSkill);

  const editing = Boolean(name);

  const formId = useId();
  const { draft, dirty, set, hydrate, markSaved } = useDraft<SkillDraft>(EMPTY);
  const [tab, setTab] = useState('schreiben');

  // The shared list refetches on every tab focus, so the fill is guarded the
  // same way as everywhere else: once per skill, and never over an edit.
  useEffect(() => {
    if (!skill) return;
    hydrate(skill.name, () => draftOf(skill));
  }, [hydrate, skill]);

  const { errors, failure, saving, submit } = useFormSubmit(schema, draft, async () => {
    const saved = await saveSkill(draft.name.trim(), {
      description: draft.description.trim(),
      audience: draft.audience,
      body: draft.body,
    });
    markSaved();
    toast(editing ? 'Skill saved' : 'Skill created', { description: saved.name });
    void navigate('/skills/' + saved.name);
  });

  const remove = useCallback(async (): Promise<void> => {
    if (!skill) return;
    if (await deleteSkill(skill)) void navigate('/skills');
  }, [deleteSkill, navigate, skill]);

  usePageMeta(
    {
      breadcrumb: [
        { label: 'Skills', to: '/skills' },
        { label: editing ? (skill?.name ?? 'Edit skill') : 'Create skill' },
      ],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo={editing && name ? '/skills/' + name : '/skills'}
          submitting={saving}
          submitDisabled={!dirty || saving}
          menu={
            // A shipped skill has no folder: what this form does with one is
            // write your own copy, so there is nothing to offer deleting.
            editing && skill?.origin !== 'builtin'
              ? [
                  {
                    label: 'Delete',
                    icon: Trash2Icon,
                    destructive: true,
                    onSelect: () => void remove(),
                  },
                ]
              : []
          }
        />
      ),
    },
    [dirty, editing, formId, name, remove, saving, skill],
  );

  /* ------------------------------- Zustände ------------------------------- */

  if (editing && !skill && !loading) {
    return (
      <PageBody width="3xl">
        <Fade>
          <EmptyState
            icon={EmptySparklesIcon}
            title="This skill no longer exists"
            description="The folder was deleted or never existed."
            actionLabel="View skills"
            actionTo="/skills"
          />
        </Fade>
      </PageBody>
    );
  }

  if (editing && !skill) {
    return (
      <PageBody width="3xl">
        <Fade>
          <FormFieldsSkeleton fields={3} />
        </Fade>
      </PageBody>
    );
  }

  return (
    <PageBody width="3xl">
      {dialog}
      <Fade>
        <FormPage
          formId={formId}
          showActions={false}
          onSubmit={submit}
          error={failure}
          description={
            skill?.origin === 'builtin'
              ? 'This skill ships with Rookery. Saving does not change it: your version is written to the skills folder and takes precedence from then on.'
              : 'The description determines when the skill is opened: one sentence that matches the task.'
          }
        >
          <FieldSet>
            <Field>
              <FieldLabel htmlFor="skill-name">Name</FieldLabel>
              <Input
                id="skill-name"
                className="font-mono"
                placeholder="z. B. wochenbericht"
                value={draft.name}
                disabled={editing}
                aria-invalid={Boolean(errors.name)}
                onChange={(event) => set({ name: event.target.value })}
              />
              <FieldDescription>
                {editing
                  ? 'The name is also the folder name and cannot be changed.'
                  : 'Lowercase letters, numbers, and hyphens. It becomes the folder name.'}
              </FieldDescription>
              <FieldError>{errors.name}</FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="skill-audience-assistant">Audience</FieldLabel>
              <ChoiceField
                id="skill-audience"
                options={AUDIENCE_CHOICES}
                value={draft.audience}
                onChange={(audience) => set({ audience })}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="skill-description">Description</FieldLabel>
              <Input
                id="skill-description"
                placeholder="When this skill applies, in one sentence."
                value={draft.description}
                aria-invalid={Boolean(errors.description)}
                onChange={(event) => set({ description: event.target.value })}
              />
              <FieldDescription>
                One sentence that helps the assistant decide whether to open the skill.
              </FieldDescription>
              <FieldError>{errors.description}</FieldError>
            </Field>
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <Field>
              <FieldLabel htmlFor="skill-body">Content</FieldLabel>
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                  <TabsTrigger value="schreiben">Write</TabsTrigger>
                  <TabsTrigger value="vorschau">Preview</TabsTrigger>
                </TabsList>
                <TabsContent value="schreiben">
                  <Textarea
                    id="skill-body"
                    rows={18}
                    className="font-mono text-code"
                    value={draft.body}
                    onChange={(event) => set({ body: event.target.value })}
                  />
                </TabsContent>
                <TabsContent value="vorschau">
                  <div className="min-h-[24rem] rounded-md border p-4">
                    {draft.body.trim() ? (
                      <ResultMarkdown text={draft.body} />
                    ) : (
                      <EmptyState
                        icon={FileTextIcon}
                        title="Nothing written yet"
                        description="The text in the “Write” tab appears here as Markdown."
                        actionLabel="Started writing"
                        onAction={() => setTab('schreiben')}
                        variant="plain"
                        size="sm"
                      />
                    )}
                  </div>
                </TabsContent>
              </Tabs>
              <FieldDescription>
                Markdown. This text is read verbatim when the skill is opened.
              </FieldDescription>
            </Field>
          </FieldSet>
        </FormPage>
      </Fade>
    </PageBody>
  );
}
