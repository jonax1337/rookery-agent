import { useCallback, useEffect, useId, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { FileTextIcon, SparklesIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

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

/**
 * Write a skill: a name, the one sentence that decides when it is opened, and
 * the instructions themselves.
 *
 * The instructions are Markdown that a model reads, so the page now shows
 * them as Markdown too - "Schreiben" and "Vorschau" as two tabs over the same
 * text. Until now the only way to see whether a heading was actually a
 * heading was to save and open the skill elsewhere.
 */

const TEMPLATE = `## Wann
Wenn der Nutzer ... möchte.

## Schritte
1. ...
2. ...

## Woran man merkt, dass es fertig ist
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
    .min(1, 'Ein Name ist Pflicht.')
    .regex(
      /^[a-z0-9][a-z0-9-]{0,63}$/,
      'Kleinbuchstaben, Ziffern und Bindestriche, beginnend mit Buchstabe oder Ziffer.',
    ),
  description: z
    .string()
    .trim()
    .min(1, 'Ohne diesen Satz wird der Skill nie geöffnet.'),
});

function draftOf(skill: Skill): SkillDraft {
  return {
    name: skill.name,
    description: skill.description,
    audience: skill.audience,
    body: skill.body,
  };
}

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
    toast(editing ? 'Skill gespeichert' : 'Skill angelegt', { description: saved.name });
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
        { label: editing ? (skill?.name ?? 'Skill bearbeiten') : 'Skill anlegen' },
      ],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo={editing && name ? '/skills/' + name : '/skills'}
          submitting={saving}
          submitDisabled={!dirty || saving}
          menu={
            editing
              ? [
                  {
                    label: 'Löschen',
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
        <EmptyState
          icon={SparklesIcon}
          title="Diesen Skill gibt es nicht mehr"
          description="Der Ordner wurde gelöscht oder hat nie existiert."
          actionLabel="Zu den Skills"
          actionTo="/skills"
        />
      </PageBody>
    );
  }

  if (editing && !skill) {
    return (
      <PageBody width="3xl">
        <FormFieldsSkeleton fields={3} />
      </PageBody>
    );
  }

  return (
    <PageBody width="3xl">
      {dialog}
      <FormPage
        formId={formId}
        showActions={false}
        onSubmit={submit}
        error={failure}
        description="Die Beschreibung entscheidet, wann der Skill geöffnet wird: ein Satz, der die Aufgabe trifft."
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
                ? 'Der Name ist der Ordnername und lässt sich nicht ändern.'
                : 'Kleinbuchstaben, Ziffern, Bindestriche. Er wird zum Ordnernamen.'}
            </FieldDescription>
            <FieldError>{errors.name}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="skill-audience-assistant">Für wen</FieldLabel>
            <ChoiceField
              id="skill-audience"
              options={AUDIENCE_CHOICES}
              value={draft.audience}
              onChange={(audience) => set({ audience })}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="skill-description">Beschreibung</FieldLabel>
            <Input
              id="skill-description"
              placeholder="Wann dieser Skill gilt, in einem Satz."
              value={draft.description}
              aria-invalid={Boolean(errors.description)}
              onChange={(event) => set({ description: event.target.value })}
            />
            <FieldDescription>
              Ein Satz — danach entscheidet der Assistent, ob er den Skill öffnet.
            </FieldDescription>
            <FieldError>{errors.description}</FieldError>
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <Field>
            <FieldLabel htmlFor="skill-body">Inhalt</FieldLabel>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="schreiben">Schreiben</TabsTrigger>
                <TabsTrigger value="vorschau">Vorschau</TabsTrigger>
              </TabsList>
              <TabsContent value="schreiben">
                <Textarea
                  id="skill-body"
                  rows={18}
                  className="font-mono text-[13px]"
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
                      title="Noch nichts geschrieben"
                      description="Was im Reiter „Schreiben“ steht, erscheint hier als Markdown."
                      actionLabel="Zum Schreiben"
                      onAction={() => setTab('schreiben')}
                      variant="plain"
                      size="sm"
                    />
                  )}
                </div>
              </TabsContent>
            </Tabs>
            <FieldDescription>
              Markdown. Der Text wird wörtlich gelesen, wenn der Skill geöffnet wird.
            </FieldDescription>
          </Field>
        </FieldSet>
      </FormPage>
    </PageBody>
  );
}
