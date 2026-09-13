import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import {
  CheckIcon,
  ExternalLinkIcon,
  PackageIcon,
  PlugIcon,
  RotateCcwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UsersIcon,
  WrenchIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { FormPage } from '@/components/blocks/form-page';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { useRemoveTool } from '@/components/common/entity-actions';
import { MetaList } from '@/components/common/meta-list';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { FormField, FormFieldsSkeleton, useDraft } from '@/components/forms/form-kit';
import { failureMessage, reportFailure } from '@/lib/errors';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useTool } from '@/hooks/useTools';
import {
  AUDIENCE_HINT,
  AUDIENCE_LABEL,
  AUDIENCE_SHORT_LABEL,
  AUDIENCE_VALUES,
  INSTALL_LABEL,
  toolStatusLook,
} from '@/lib/tools';
import type { ToolServer, ToolServerAudience } from '@/lib/types';

/**
 * One MCP server: who may use it, how it is configured, which keys it needs.
 *
 * The page used to save on every `onBlur` with no feedback at all - a typo in
 * an API key was written to the config the moment the field lost focus, and
 * nothing on screen said whether it had arrived. Now the audience, the options
 * and the keys form one draft that is written by "Save", and the button
 * stays disabled until something has actually changed.
 *
 * The switch is the one exception: an on/off state is a single deliberate
 * click, it has its own optimistic rollback in `useTools`, and the same switch
 * on the list page behaves the same way.
 *
 * There is no `GET /api/tools/:id` - the record comes out of the shared
 * `useTools` cache (see serverGaps), which is also why the list page and this
 * page never disagree about a server's state.
 */

const FORM_ID = 'werkzeug-form';

interface Draft {
  audience: ToolServerAudience;
  /** One entry per `optionDef`, pre-filled from the entry's default. */
  options: Record<string, string>;
  /**
   * Only what has been typed. Values never travel to the browser, so an empty
   * field means "leave it alone" - and it has to, because the server deletes a
   * key whose value arrives empty (`withToolServer` in core).
   */
  env: Record<string, string>;
}

/** What a finished preparation had to say, held for the drawer. */
interface PrepareResult {
  ok: boolean;
  output: string;
}

function makeDraft(tool: ToolServer): Draft {
  return {
    audience: tool.audience,
    options: Object.fromEntries(
      tool.optionDefs.map((option) => [option.key, tool.options[option.key] ?? option.default]),
    ),
    env: {},
  };
}

export function ToolDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { tool, loading, error, refresh, setEnabled, update, remove, prepare } = useTool(id);
  const { dialog, removeTool: dropTool } = useRemoveTool(remove, refresh);

  const { draft, dirty, set, hydrate, markSaved } = useDraft<Draft>({
    audience: 'assistant',
    options: {},
    env: {},
  });

  // Bumped after a save so the draft refills from the record that came back -
  // which is what empties the key fields again and puts their "set" badge
  // back where it belongs.
  const [generation, setGeneration] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [result, setResult] = useState<PrepareResult | null>(null);
  // Dropping an override takes the entry out of the shared list at once, and
  // only the reload afterwards brings the catalogue's own version back. While
  // that round trip runs the page would otherwise flash "Diesen Server gibt es
  // nicht" for a server that is merely being put back on its defaults.
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!tool) return;
    hydrate(tool.id + '#' + generation, () => makeDraft(tool));
  }, [tool, generation, hydrate]);

  /* -------------------------------- Actions ------------------------------ */

  const save = useCallback(async (): Promise<void> => {
    if (!tool || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(draft.env)) {
        if (value.trim()) env[name] = value.trim();
      }
      await update(tool.id, { audience: draft.audience, options: draft.options, env });
      markSaved();
      setGeneration((current) => current + 1);
      toast('Saved', { description: 'Takes effect on the next turn.' });
    } catch (caught) {
      setSaveError(failureMessage(caught));
    } finally {
      setSaving(false);
    }
  }, [draft, markSaved, saving, tool, update]);

  const toggle = useCallback(
    async (on: boolean): Promise<void> => {
      if (!tool) return;
      try {
        await setEnabled(tool.id, on);
        toast(on ? tool.name + ' enabled' : tool.name + ' disabled');
      } catch (caught) {
        reportFailure('Update', caught);
      }
    },
    [setEnabled, tool],
  );

  const runPrepare = useCallback(async (): Promise<void> => {
    if (!tool) return;
    setPreparing(true);
    try {
      const outcome = await prepare(tool.id);
      setResult({ ok: outcome.ok, output: outcome.output });
    } catch (caught) {
      setResult({ ok: false, output: failureMessage(caught) });
    } finally {
      setPreparing(false);
    }
  }, [prepare, tool]);

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

  /* --------------------------------- Kopf -------------------------------- */

  usePageMeta(
    {
      ...(tool ? { title: tool.name } : {}),
      breadcrumb: [{ label: 'Tools', to: '/tools' }, { label: tool?.name ?? 'Tool' }],
      actions: tool ? (
        <div className="flex items-center gap-2">
          <Label htmlFor="werkzeug-aktiv" className="flex h-8 items-center gap-2 rounded-md border px-2 font-normal">
            <Switch
              id="werkzeug-aktiv"
              checked={tool.enabled}
              disabled={!tool.installed}
              onCheckedChange={(on) => void toggle(on)}
            />
            Active
          </Label>
          <Button size="sm" type="submit" form={FORM_ID} disabled={!dirty || saving}>
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
                  onSelect={() => void runPrepare()}
                  className="items-start whitespace-normal"
                >
                  {preparing ? <Spinner aria-label="Running" /> : <PackageIcon />}
                  {tool.prepare.label}
                </DropdownMenuItem>
              ) : null}
              {tool.install === 'custom' ? (
                <DropdownMenuItem variant="destructive" onSelect={() => void removeTool()}>
                  <Trash2Icon data-icon="inline-start" />
                  Remove
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => void removeTool()}>
                  <RotateCcwIcon data-icon="inline-start" />
                  Restore default
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : undefined,
    },
    [tool, dirty, saving, preparing, toggle, runPrepare, removeTool],
  );

  /* -------------------------------- Zustände ------------------------------ */

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

  const look = toolStatusLook(tool);

  return (
    <PageBody width="3xl">
      {dialog}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={look.variant} className="gap-1">
            {look.icon ? <look.icon className={look.iconClassName} aria-hidden="true" /> : null}
            {look.label}
          </Badge>
          <Badge variant="outline" className="font-mono font-normal">
            {tool.id}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{tool.description}</p>
      </div>

      <MetaList
        columns={2}
        items={[
          { label: 'Audience', value: AUDIENCE_LABEL[tool.audience], icon: UsersIcon },
          { label: 'Source', value: INSTALL_LABEL[tool.install], icon: PackageIcon },
          {
            label: 'Installed',
            value: tool.installed ? 'Yes' : 'Not downloaded yet',
            icon: PlugIcon,
          },
          {
            label: 'Active',
            value: tool.active
              ? 'Running with'
              : tool.enabled
                ? 'Enabled but not ready'
                : 'Off',
            icon: PlugIcon,
          },
          {
            label: 'Project page',
            // An external address, so a plain anchor - `MetaList.to` routes
            // inside the app and would swallow it.
            value: tool.homepage ? (
              <a
                href={tool.homepage}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                <span className="truncate">{tool.homepage.replace(/^https?:\/\//, '')}</span>
                <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              ''
            ),
            icon: ExternalLinkIcon,
          },
        ]}
      />

      {tool.missingEnv.length > 0 ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          Remains disabled until {tool.missingEnv.join(', ')} is provided.
        </p>
      ) : null}

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
              <Card>
                <CardHeader>
                  <CardTitle>Keys</CardTitle>
                  <CardDescription>
                    Stored in Rookery configuration and passed only to the server process. Saved
                    keys are never returned to the browser; enter a new value to update one.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <FieldSet>
                    <FieldLegend variant="label">Credentials</FieldLegend>
                    {tool.envDefs.map((item) => {
                      const isSet = tool.envSet[item.name] === true;
                      const typed = (draft.env[item.name] ?? '').trim();
                      const missing =
                        item.required && tool.missingEnv.includes(item.name) && typed === '';
                      return (
                        // FormField haengt Guidance und Meldung per
                        // `aria-describedby` an die Eingabe; `data-invalid`
                        // allein faerbte nur die Gruppe.
                        <FormField
                          key={item.name}
                          id={'env-' + item.name}
                          label={
                            <>
                              {item.label}
                              <Badge
                                variant={
                                  isSet ? 'outline' : item.required ? 'destructive' : 'secondary'
                                }
                                className="font-normal"
                              >
                                {isSet ? 'set' : 'missing'}
                              </Badge>
                            </>
                          }
                          error={missing ? 'Required' : null}
                          {...(item.hint ? { description: item.hint } : {})}
                        >
                          {(control) => (
                            <InputGroup>
                              <InputGroupInput
                                {...control}
                                type={item.secret ? 'password' : 'text'}
                                autoComplete="off"
                                placeholder={isSet ? '••••••••' : 'not set'}
                                value={draft.env[item.name] ?? ''}
                                onChange={(event) =>
                                  set({ env: { ...draft.env, [item.name]: event.target.value } })
                                }
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
                    })}
                  </FieldSet>
                </CardContent>
              </Card>
            ) : null}

            {tool.custom ? (
              <Card>
                <CardHeader>
                  <CardTitle>Command</CardTitle>
                  <CardDescription>
                    This is how the server starts. To change the command, remove this entry and
                    create another.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs">
                    {tool.custom.command + ' ' + tool.custom.args.join(' ')}
                  </pre>
                  {tool.custom.hint ? (
                    <p className="text-sm text-muted-foreground">{tool.custom.hint}</p>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}
          </>
        }
      >
        <FieldSet>
          <FieldLegend variant="label">Audience</FieldLegend>
          <FieldDescription>
            Determines who can see this server in their tools.
          </FieldDescription>
          <RadioGroup
            value={draft.audience}
            onValueChange={(value) => set({ audience: value as ToolServerAudience })}
          >
            {AUDIENCE_VALUES.map((value) => (
              <FieldLabel key={value} htmlFor={'audience-' + value}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{AUDIENCE_SHORT_LABEL[value]}</FieldTitle>
                    <FieldDescription>{AUDIENCE_HINT[value]}</FieldDescription>
                  </FieldContent>
                  <RadioGroupItem value={value} id={'audience-' + value} aria-label={AUDIENCE_SHORT_LABEL[value]} />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
        </FieldSet>

        {tool.optionDefs.map((option) => (
          <Field key={option.key}>
            <FieldLabel htmlFor={'opt-' + option.key}>{option.label}</FieldLabel>
            {option.type === 'select' ? (
              <Select
                value={draft.options[option.key] ?? option.default}
                onValueChange={(value) =>
                  set({ options: { ...draft.options, [option.key]: value } })
                }
              >
                <SelectTrigger id={'opt-' + option.key} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(option.choices ?? []).map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={'opt-' + option.key}
                value={draft.options[option.key] ?? ''}
                placeholder={option.default}
                onChange={(event) =>
                  set({ options: { ...draft.options, [option.key]: event.target.value } })
                }
              />
            )}
            {option.hint ? <FieldDescription>{option.hint}</FieldDescription> : null}
          </Field>
        ))}
      </FormPage>

      {!tool.installed ? (
        <p className="text-sm text-muted-foreground">
          Not installed yet.{' '}
          {tool.prepare
            ? '„' + tool.prepare.label + '” from the “More actions” menu downloads what is missing.'
            : 'The server is downloaded with npx on first launch.'}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        All tools are available under{' '}
        <NavLink to="/tools" className="underline underline-offset-2">
          Tools
        </NavLink>
        .
      </p>

      {/* The preparation can print a whole npm log; a toast would swallow it. */}
      <DetailDrawer
        open={result !== null}
        onOpenChange={(open) => {
          if (!open) setResult(null);
        }}
        title={tool.name + ' set up'}
        description={result ? (result.ok ? 'Completed.' : 'Failed.') : undefined}
      >
        <pre className="rounded-lg bg-muted/60 p-3 font-mono text-xs whitespace-pre-wrap">
          {result?.output.trim() || 'No output.'}
        </pre>
      </DetailDrawer>
    </PageBody>
  );
}
