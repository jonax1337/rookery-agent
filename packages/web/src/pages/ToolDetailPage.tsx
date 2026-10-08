import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';

import { BadgeAlertIcon as TriangleAlertIcon, BoxIcon as PackageIcon, WrenchIcon } from '@/components/icons';
import { toast } from 'sonner';

import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { FormPage } from '@/components/blocks/form-page';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { useRemoveTool } from '@/components/common/entity-actions';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { FormFieldsSkeleton, useDraft } from '@/components/forms/form-kit';
import { failureMessage } from '@/lib/errors';
import { useOrgState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useTool } from '@/hooks/useTools';
import type { ToolServer } from '@/lib/types';

import { PrepareOutputDrawer, RemoveToolMenuItem, usePrepareTool, useToggleTool } from './tools/tool-actions';
import { EMPTY_TOOL_DRAFT, toolDraftOf, typedEnv, type ToolDraft } from './tools/tool-draft';
import { ToolFacts } from './tools/ToolFacts';
import { ToolSettingsFields } from './tools/ToolSettingsFields';
import { ToolCommandCard, ToolKeysCard } from './tools/ToolSideCards';
import { ToolStatusBadge } from './tools/ToolStatusBadge';

/**
 * One MCP server: who may use it, how it is configured, which keys it needs.
 *
 * The audience, the options and the keys form one draft that is written by
 * "Save", and the button stays disabled until something has actually changed -
 * saving on every `onBlur` would write a typo in an API key to the config the
 * moment the field lost focus, with nothing on screen saying whether it had
 * arrived.
 *
 * The switch is the one exception: an on/off state is a single deliberate
 * click, it has its own optimistic rollback in `useTools`, and the same switch
 * on the list page behaves the same way.
 *
 * There is no `GET /api/tools/:id` - the record comes out of the shared
 * `useTools` cache, which is also why the list page and this page never
 * disagree about a server's state.
 */

const FORM_ID = 'tool-form';

export function ToolDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { tool, loading, error, refresh, setEnabled, update, remove, prepare } = useTool(id);
  const { dialog, removeTool: dropTool } = useRemoveTool(remove, refresh);
  const toggle = useToggleTool(setEnabled);
  const preparation = usePrepareTool(prepare);
  const org = useOrgState();

  const { draft, dirty, set, hydrate, markSaved } = useDraft<ToolDraft>(EMPTY_TOOL_DRAFT);

  // Bumped after a save so the draft refills from the record that came back -
  // which is what empties the key fields again and puts their "set" badge
  // back where it belongs.
  const [generation, setGeneration] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Dropping an override takes the entry out of the shared list at once, and
  // only the reload afterwards brings the catalogue's own version back. While
  // that round trip runs the page would otherwise flash "This server does not
  // exist" for a server that is merely being put back on its defaults.
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!tool) return;
    hydrate(tool.id + '#' + generation, () => toolDraftOf(tool));
  }, [tool, generation, hydrate]);

  const save = useCallback(async (): Promise<void> => {
    if (!tool || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await update(tool.id, {
        audience: draft.audience,
        options: draft.options,
        env: typedEnv(draft),
        projectIds: draft.projectIds,
      });
      markSaved();
      setGeneration((current) => current + 1);
      toast('Saved', { description: 'Takes effect on the next turn.' });
    } catch (caught) {
      setSaveError(failureMessage(caught));
    } finally {
      setSaving(false);
    }
  }, [draft, markSaved, saving, tool, update]);

  /**
   * `DELETE /api/tools/:id` drops the entry's override, and what that means
   * depends on where the entry came from: an own server is gone afterwards, a
   * catalogue server falls back to its shipped defaults. Both are the same
   * call - only the wording, and where the reader ends up, differ. Without
   * the second case a catalogue server with a broken option or a mistyped key
   * could never be put right again: the form can overwrite an override, never
   * delete it.
   */
  const removeTool = useCallback(async (): Promise<void> => {
    if (!tool) return;
    const own = tool.install === 'custom';
    // The hook asks, calls and - for a catalogue entry - reads the list again.
    // What stays here is where the reader ends up and the generation bump that
    // refills the draft from the record that came back.
    if (!own) setResetting(true);
    try {
      if (!(await dropTool(tool))) return;
      if (own) void navigate('/tools');
      else setGeneration((current) => current + 1);
    } finally {
      setResetting(false);
    }
  }, [dropTool, navigate, tool]);

  const preparing = tool !== undefined && preparation.preparingId === tool.id;

  usePageMeta(
    {
      ...(tool ? { title: tool.name } : {}),
      breadcrumb: [{ label: 'Tools', to: '/tools' }, { label: tool?.name ?? 'Tool' }],
      actions: tool ? (
        <HeaderActions
          tool={tool}
          saveDisabled={!dirty || saving}
          saving={saving}
          preparing={preparing}
          onToggle={(on) => void toggle(tool, on)}
          onPrepare={() => void preparation.run(tool)}
          onRemove={() => void removeTool()}
        />
      ) : undefined,
    },
    [tool, dirty, saving, preparing, toggle, preparation.run, removeTool],
  );

  if (!tool && (loading || resetting)) {
    return (
      <PageBody width="3xl">
        <Card>
          <CardHeader>
            <CardTitle>Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <FormFieldsSkeleton fields={5} />
          </CardContent>
        </Card>
      </PageBody>
    );
  }

  if (!tool) {
    return (
      <PageBody width="3xl">
        {error ? (
          <ServerOffline onRetry={() => void refresh()} />
        ) : (
          <EmptyState
            icon={WrenchIcon}
            title="This server does not exist"
            description="The entry was removed, or the address is incorrect."
            actionLabel="View tools"
            actionTo="/tools"
          />
        )}
      </PageBody>
    );
  }

  return (
    <PageBody width="3xl">
      {dialog}

      <div className="flex flex-col gap-3">
        <Fade>
          <div className="flex flex-wrap items-center gap-2">
            <ToolStatusBadge tool={tool} />
            <Badge variant="outline" className="font-mono font-normal">
              {tool.id}
            </Badge>
          </div>
        </Fade>
        <Blur delay={50}>
          <p className="text-sm text-muted-foreground">{tool.description}</p>
        </Blur>
      </div>

      <Fade delay={100}>
        <ToolFacts tool={tool} projects={org.projects} />
      </Fade>

      {tool.missingEnv.length > 0 ? (
        <Fade delay={150}>
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertDescription>
              Remains disabled until {tool.missingEnv.join(', ')} is provided.
            </AlertDescription>
          </Alert>
        </Fade>
      ) : null}

      <Fade delay={200}>
        <FormPage
          formId={FORM_ID}
          showActions={false}
          title="Settings"
          description="Saved with “Save” and takes effect on the next turn."
          error={saveError}
          onSubmit={save}
          aside={
            <>
              {tool.envDefs.length > 0 ? (
                <ToolKeysCard
                  tool={tool}
                  draft={draft}
                  onEnvChange={(name, value) => set({ env: { ...draft.env, [name]: value } })}
                />
              ) : null}
              {tool.custom ? <ToolCommandCard custom={tool.custom} /> : null}
            </>
          }
        >
          <ToolSettingsFields tool={tool} projects={org.projects} draft={draft} onChange={set} />
        </FormPage>
      </Fade>

      {!tool.installed ? (
        <Fade delay={250}>
          <p className="text-sm text-muted-foreground">
            Not installed yet.{' '}
            {tool.prepare
              ? '“' + tool.prepare.label + '” from the “More actions” menu downloads what is missing.'
              : 'The server is downloaded with npx on first launch.'}
          </p>
        </Fade>
      ) : null}

      <Fade delay={300}>
        <p className="text-xs text-muted-foreground">
          All tools are available under{' '}
          <Button
            asChild
            variant="link"
            className="h-auto gap-0 p-0 text-left align-baseline text-xs"
          >
            <NavLink to="/tools">Tools</NavLink>
          </Button>
          .
        </p>
      </Fade>

      <PrepareOutputDrawer result={preparation.result} onDismiss={preparation.dismiss} />
    </PageBody>
  );
}

interface HeaderActionsProps {
  tool: ToolServer;
  saving: boolean;
  saveDisabled: boolean;
  preparing: boolean;
  onToggle(on: boolean): void;
  onPrepare(): void;
  onRemove(): void;
}

function HeaderActions({
  tool,
  saving,
  saveDisabled,
  preparing,
  onToggle,
  onPrepare,
  onRemove,
}: HeaderActionsProps) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="tool-active" className="flex h-8 items-center gap-2 rounded-md border px-2 font-normal">
        <Switch
          id="tool-active"
          checked={tool.enabled}
          disabled={!tool.installed}
          onCheckedChange={onToggle}
        />
        Active
      </Label>
      <Button size="sm" type="submit" form={FORM_ID} disabled={saveDisabled}>
        {saving ? <Spinner aria-label="Saving" data-icon="inline-start" /> : null}
        Save
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton tone="header" label="More actions" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {tool.prepare ? (
            <DropdownMenuItem
              disabled={preparing}
              onSelect={onPrepare}
              className="items-start whitespace-normal"
            >
              {preparing ? <Spinner aria-label="Running" /> : <PackageIcon />}
              {tool.prepare.label}
            </DropdownMenuItem>
          ) : null}
          <RemoveToolMenuItem tool={tool} onRemove={onRemove} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
