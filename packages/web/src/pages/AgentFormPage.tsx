import { useEffect, useId } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArchiveIcon, ArchiveIcon as ArchiveRestoreIcon, UsersRoundIcon } from '@/components/icons';
import { toast } from 'sonner';

import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { FormPage } from '@/components/blocks/form-page';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState } from '@/components/common/empty-state';
import {
  FormFieldsSkeleton,
  FormHeaderActions,
  useDraft,
  useFormSubmit,
} from '@/components/forms/form-kit';
import { usePageMeta } from '@/components/shell/page-meta';
import { FieldSeparator } from '@/components/ui/field';
import { api } from '@/lib/api';
import { useOrgState } from '@/providers/rookery-provider';

import { AgentBriefFields } from './agents/AgentBriefFields';
import { AgentIdentityFields } from './agents/AgentIdentityFields';
import { AgentModelFields } from './agents/AgentModelFields';
import { AgentOrganizationFields } from './agents/AgentOrganizationFields';
import {
  agentSchema,
  buildPatch,
  draftOf,
  EMPTY_DRAFT,
  toInput,
  type AgentDraft,
} from './agents/agentDraft';
import { useAgentArchiveActions } from './agents/useAgentArchiveActions';

/**
 * Hiring and re-briefing, as one page.
 *
 * Create and edit are the same form because the fields are identical; only
 * the starting point and the destination differ.
 */
export function AgentFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const org = useOrgState();
  const editing = Boolean(id);
  const agent = org.agents.find((entry) => entry.id === id);
  const { archive, restore, dialog } = useAgentArchiveActions(agent);

  const formId = useId();
  const { draft, dirty, set, hydrate, markSaved } = useDraft<AgentDraft>(EMPTY_DRAFT);

  // Filled once per agent: the company refetches on every socket broadcast,
  // and a refetch must not throw away what is being typed.
  useEffect(() => {
    if (!agent) return;
    hydrate(agent.id, () => draftOf(agent));
  }, [agent, hydrate]);

  const { errors, failure, saving, submit } = useFormSubmit(agentSchema, draft, async () => {
    const patch = buildPatch(draft);
    const saved = id ? await api.updateAgent(id, patch) : await api.createAgent(toInput(patch));
    markSaved();
    await org.refresh();
    toast(editing ? 'Agent saved' : saved.name + ' hired');
    void navigate('/org/agents/' + saved.id);
  });

  const leaf = editing ? (agent?.name ?? 'Edit agent') : 'Hire agent';

  usePageMeta(
    {
      breadcrumb: [
        { label: 'Organization', to: '/org/agents' },
        { label: 'Agents', to: '/org/agents' },
        { label: leaf },
      ],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo="/org/agents"
          submitting={saving}
          submitDisabled={!dirty || saving}
          menu={
            editing && agent
              ? [
                  agent.archived
                    ? {
                        label: 'Restore',
                        icon: ArchiveRestoreIcon,
                        onSelect: () => void restore(),
                      }
                    : {
                        label: 'Archive',
                        icon: ArchiveIcon,
                        destructive: true,
                        onSelect: () => void archive(),
                      },
                ]
              : []
          }
        />
      ),
    },
    [agent, archive, dirty, editing, formId, restore, saving],
  );

  if (editing && !agent && !org.loading) {
    return (
      <PageBody width="3xl">
        {/* The flex classes keep the empty state stretching the page the way
            it did as a direct child of the rhythm container. */}
        <Fade className="flex flex-1 flex-col">
          <EmptyState
            icon={UsersRoundIcon}
            title="This agent no longer exists"
            description="The agent was removed or never existed."
            actionLabel="View agents"
            actionTo="/org/agents"
          />
        </Fade>
      </PageBody>
    );
  }

  if (editing && !agent) {
    return (
      <PageBody width="3xl">
        <FormFieldsSkeleton fields={5} />
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
        description={
          <Blur>
            {editing
              ? 'Role, instructions, and Memory persist; every run still starts a fresh process.'
              : 'An agent is a permanent team member: role, instructions, and personal Memory persist.'}
          </Blur>
        }
      >
        <Fade>
          <AgentIdentityFields draft={draft} set={set} errors={errors} />
        </Fade>

        <FieldSeparator />

        <Fade delay={50}>
          <AgentOrganizationFields draft={draft} set={set} agentId={id} />
        </Fade>

        <FieldSeparator />

        <Fade delay={100}>
          <AgentModelFields draft={draft} set={set} />
        </Fade>

        <FieldSeparator />

        <Fade delay={150}>
          <AgentBriefFields draft={draft} set={set} errors={errors} />
        </Fade>
      </FormPage>
    </PageBody>
  );
}
