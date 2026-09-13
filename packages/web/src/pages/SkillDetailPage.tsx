import { useCallback, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import {
  BookOpenIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  FileIcon,
  FilesIcon,
  FolderIcon,
  PencilIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';

import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { useDeleteSkill } from '@/components/common/entity-actions';
import { MetaList, MetaListSkeleton } from '@/components/common/meta-list';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { ResultMarkdown } from '@/components/result-markdown';
import { usePageMeta } from '@/components/shell/page-meta';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroupButton } from '@/components/ui/input-group';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useSkill } from '@/hooks/useSkills';
import { timeAgo } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import { AUDIENCE_LABEL } from '@/lib/tools';

/**
 * One skill, read rather than edited.
 *
 * Skills were the only area of the app without a detail page: the list linked
 * straight into the edit form, so the instructions could only be seen as raw
 * Markdown in a textarea, and `path` and `files` - both in every payload since
 * the beginning - appeared nowhere at all. This page shows the rendered text,
 * says where the folder is, and lists what lies next to SKILL.md.
 *
 * The record comes out of the shared `useSkills` cache. `GET /api/skills`
 * already returns the whole skill including its body, so a second request for
 * one entry would fetch nothing new.
 */
export function SkillDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { skill, loading, error, refresh, remove } = useSkill(name);
  const { dialog, deleteSkill } = useDeleteSkill(remove);
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  const [view, setView] = useState<'preview' | 'source'>('preview');

  const removeSkill = useCallback(async (): Promise<void> => {
    if (!skill) return;
    if (await deleteSkill(skill)) void navigate('/skills');
  }, [deleteSkill, navigate, skill]);

  usePageMeta(
    {
      ...(skill ? { title: skill.name } : {}),
      breadcrumb: [{ label: 'Skills', to: '/skills' }, { label: skill?.name ?? 'Skill' }],
      actions: skill ? (
        <div className="flex items-center gap-2">
          <Button size="sm" asChild>
            <NavLink to={'/skills/' + skill.name + '/edit'}>
              <PencilIcon data-icon="inline-start" />
              Edit
            </NavLink>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton tone="header" label="More actions" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem variant="destructive" onSelect={() => void removeSkill()}>
                <Trash2Icon data-icon="inline-start" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : undefined,
    },
    [skill?.name, removeSkill],
  );

  /* -------------------------------- Zustände ------------------------------- */

  if (!skill && loading) return <SkillDetailSkeleton />;

  if (!skill) {
    return (
      <PageBody width="3xl">
        {error ? (
          <ServerOffline onRetry={() => void refresh()} />
        ) : (
          <EmptyState
            icon={BookOpenIcon}
            title="This skill does not exist"
            description="The folder was deleted or renamed, or the address is incorrect."
            actionLabel="View skills"
            actionTo="/skills"
          />
        )}
      </PageBody>
    );
  }

  const body = skill.body.trim();

  return (
    <PageBody width="3xl">
      {dialog}

      {skill.description ? (
        <p className="text-sm text-muted-foreground">{skill.description}</p>
      ) : null}

      <MetaList
        columns={2}
        items={[
          {
            label: 'Audience',
            value: (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {AUDIENCE_LABEL[skill.audience]}
              </Badge>
            ),
            icon: UsersIcon,
          },
          {
            label: 'Path',
            value: (
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono text-xs" title={skill.path}>
                  {skill.path}
                </span>
                {/* The folder is what a person needs in a terminal, and it is
                    too long to retype - so it travels by clipboard. */}
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Path kopieren"
                  onClick={() => copyToClipboard(skill.path)}
                >
                  {isCopied ? <CheckIcon /> : <CopyIcon />}
                </InputGroupButton>
              </span>
            ),
            icon: FolderIcon,
          },
          {
            label: 'Files',
            value:
              skill.files.length > 0
                ? formatNumber(skill.files.length) + ' neben SKILL.md'
                : 'SKILL.md only',
            icon: FilesIcon,
          },
          {
            label: 'Updated',
            value: timeAgo(skill.updatedAt),
            icon: ClockIcon,
          },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle>Instructions</CardTitle>
          <CardDescription>
            The text from SKILL.md that the assistant or an agent reads before starting.
          </CardDescription>
          <CardAction>
            {/* Rendered by default; the source is one click away, because a
                skill is a file someone else may have to edit by hand. */}
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={view}
              onValueChange={(value) => {
                if (value === 'preview' || value === 'source') setView(value);
              }}
            >
              <ToggleGroupItem value="preview">Preview</ToggleGroupItem>
              <ToggleGroupItem value="source">Source</ToggleGroupItem>
            </ToggleGroup>
          </CardAction>
        </CardHeader>
        <CardContent>
          {body === '' ? (
            <EmptyState
              icon={PencilIcon}
              title="No instructions provided"
              description="Without text below the front matter, the skill has no instructions to provide."
              actionLabel="Edit"
              actionTo={'/skills/' + skill.name + '/edit'}
              variant="plain"
              size="sm"
            />
          ) : view === 'preview' ? (
            <ResultMarkdown text={body} />
          ) : (
            <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs whitespace-pre-wrap">
              {body}
            </pre>
          )}
        </CardContent>
      </Card>

      <Accordion type="single" collapsible defaultValue={skill.files.length > 0 ? 'files' : ''}>
        <AccordionItem value="files" className="border-b-0">
          <AccordionTrigger>
            Files
            <Badge variant="outline" className="ms-2 font-normal">
              {formatNumber(skill.files.length)}
            </Badge>
          </AccordionTrigger>
          <AccordionContent>
            {skill.files.length === 0 ? (
              <EmptyState
                icon={FileIcon}
                title="No additional files"
                description="This folder contains nothing besides SKILL.md. Scripts and templates would appear here."
                variant="plain"
                size="sm"
              />
            ) : (
              <ItemGroup className="gap-2">
                {skill.files.map((file) => (
                  <Item key={file} variant="outline" size="sm">
                    <ItemMedia variant="icon">
                      <FileIcon className="text-muted-foreground" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="font-mono text-xs font-normal">{file}</ItemTitle>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <p className="text-xs text-muted-foreground">
        Last updated on {formatDateTime(skill.updatedAt)}.
      </p>
    </PageBody>
  );
}

/** The loading state in the geometry the loaded page will have. */
function SkillDetailSkeleton() {
  return (
    <PageBody width="3xl">
      <Skeleton className="h-4 w-2/3" />
      <MetaListSkeleton />
      <Skeleton className="h-80 w-full rounded-xl" />
    </PageBody>
  );
}
