import { forwardRef, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import {
  DownloadIcon,
  DownloadIcon as AnimatedDownloadIcon,
  FolderCogIcon as FolderSearchIcon,
  GitBranchIcon,
  SearchIcon as AnimatedSearchIcon,
  SparklesIcon,
  SparklesIcon as AnimatedSparklesIcon,
} from "@/components/icons";
import { toast } from 'sonner';

import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';

import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, NoResults } from '@/components/common/empty-state';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useSkills } from '@/hooks/useSkills';
import { reportFailure } from '@/lib/errors';
import type { IconComponent } from "@/components/icons";

/**
 * Pulling a skill folder off GitHub - the public shelf, or any owner/repo/path.
 *
 * The page used to be two `ul.divide-y` lists with a bare input next to a
 * button; the candidate list of a collection had no heading and an empty one
 * printed nothing at all, so a wrong path looked like a page that had simply
 * forgotten to answer. Both lists are `Item` rows now, every miss says what it
 * means, and the shelf marks what is already installed.
 */

/**
 * The folder name an import will most likely produce.
 *
 * The server takes it from the SKILL.md frontmatter and only falls back to the
 * last path segment (`skills/import.ts`), so this is a guess - but a guess the
 * shelf's own entries hit, and it is only used to grey out a second import.
 */
function guessName(source: string): string {
  const last = source.replace(/\/+$/, '').split('/').pop() ?? '';
  return last
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The collection-error empty state gets the animate-ui sparkles instead of the
 * lucide one: same silhouette and stroke, blinking in once when the state
 * enters the viewport. `EmptyState` types its `icon` as a `IconComponent` and
 * renders it without props, so the trigger rides along in this shell.
 */
const EmptySparklesIcon = forwardRef<SVGSVGElement>(function EmptySparklesIcon() {
  return <AnimatedSparklesIcon size={24} />;
});

export function SkillImportPage() {
  const navigate = useNavigate();
  const { skills, catalog, catalogLoading, catalogError, loadCatalog, importFrom } = useSkills();

  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  /** `null` before the first attempt; `[]` means "a collection with nothing in it". */
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [filter, setFilter] = useState('');

  usePageMeta({
    breadcrumb: [{ label: 'Skills', to: '/skills' }, { label: 'Import' }],
  });

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const installed = useMemo(() => new Set(skills.map((skill) => skill.name)), [skills]);

  const run = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(trimmed);
    setCandidates(null);
    try {
      const result = await importFrom(trimmed);
      if ('skill' in result) {
        const name = result.skill.name;
        toast('Skill „' + name + '“ importiert', {
          action: { label: 'Open', onClick: () => void navigate('/skills/' + name) },
        });
        setSource('');
      } else {
        // A collection, not a skill. The choice belongs on the page, not in a
        // toast that disappears while it is being read.
        setCandidates(result.candidates);
        toast('This is a collection. Select a skill from it.');
      }
    } catch (caught) {
      reportFailure('Import', caught);
    } finally {
      setBusy(null);
    }
  };

  const shelf = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return catalog;
    return catalog.filter((entry) =>
      (entry.name + ' ' + entry.description + ' ' + entry.source).toLowerCase().includes(needle),
    );
  }, [catalog, filter]);

  return (
    <PageBody width="3xl">
      <Blur>
        <p className="text-sm text-muted-foreground">
          Skills use an open format: a folder containing SKILL.md. Import compatible folders from
          Anthropic, skills.sh, or your own GitHub repository.
        </p>
      </Blur>

      {/* ------------------------------ GitHub ------------------------------ */}
      <Fade delay={50}>
      <Card>
        <CardHeader>
          <CardTitle>From GitHub</CardTitle>
          <CardDescription>
            Enter owner/repo, owner/repo/path/to/skill, or a GitHub URL. Collections appear below
            for selection.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <InputGroup>
            <InputGroupAddon align="inline-start">
              <GitBranchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={source}
              placeholder="owner/repo or URL"
              aria-label="Skill source"
              disabled={busy !== null}
              onChange={(event) => setSource(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void run(source);
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                variant="default"
                disabled={busy !== null || !source.trim()}
                onClick={() => void run(source)}
              >
                {busy === source.trim() ? (
                  <Spinner data-icon="inline-start" aria-label="Importing" />
                ) : (
                  /* size-3.5 keeps the rest-pose size: the xs button sizes only
                     direct svg children, and the animated icon sits in a span. */
                  <AnimatedDownloadIcon data-icon="inline-start" className="size-3.5" />
                )}
                Import
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>

          {candidates !== null && candidates.length > 0 ? (
            <Fade>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Multiple skills found</p>
              <ItemGroup className="gap-2">
                {candidates.map((candidate) => (
                  <Item key={candidate} variant="outline" size="sm">
                    <ItemContent>
                      <ItemTitle className="font-mono text-xs font-normal">{candidate}</ItemTitle>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void run(candidate)}
                      >
                        {busy === candidate ? <Spinner aria-label="Importing" /> : null}
                        Use this
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            </div>
            </Fade>
          ) : null}

          {candidates !== null && candidates.length === 0 ? (
            <Fade>
            <EmptyState
              icon={FolderSearchIcon}
              title="No skill found there"
              description="This address contains neither a SKILL.md file nor subfolders that could contain a skill."
              variant="plain"
              size="sm"
            />
            </Fade>
          ) : null}
        </CardContent>
      </Card>
      </Fade>

      {/* ------------------------------ Sammlung ---------------------------- */}
      <Fade delay={100}>
      <Card>
        <CardHeader>
          <CardTitle>Anthropic collection</CardTitle>
          <CardDescription>
            Public Anthropic skills. Scripts may require Python or Node and an execution tool with
            suitable permissions.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {catalogError ? (
            <Fade>
            <EmptyState
              icon={EmptySparklesIcon}
              title="The collection cannot be loaded right now"
              description="The list comes from GitHub. It remains empty without a network connection or during an outage there; a custom path above will still work."
              actionLabel="Try again"
              onAction={() => void loadCatalog(true)}
              variant="plain"
              size="sm"
            />
            </Fade>
          ) : catalogLoading && catalog.length === 0 ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : (
            <>
              <InputGroup>
                <InputGroupAddon align="inline-start">
                  {/* size-4 mirrors the addon's own svg sizing, which only
                     reaches direct svg children. */}
                  <AnimatedSearchIcon className="size-4" />
                </InputGroupAddon>
                <InputGroupInput
                  value={filter}
                  placeholder="Sammlung durchsuchen"
                  aria-label="Sammlung durchsuchen"
                  onChange={(event) => setFilter(event.target.value)}
                />
              </InputGroup>

              {shelf.length === 0 ? (
                <Fade>
                <NoResults
                  {...(filter.trim() ? { query: filter.trim() } : {})}
                  onReset={() => setFilter('')}
                />
                </Fade>
              ) : (
                <ItemGroup className="gap-2">
                  {shelf.map((entry) => {
                    const already = installed.has(guessName(entry.source));
                    return (
                      <Item key={entry.source} variant="outline" size="sm">
                        <ItemMedia variant="icon">
                          <SparklesIcon className="text-muted-foreground" />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>{entry.name}</ItemTitle>
                          <ItemDescription>{entry.description}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          {entry.needsShell ? (
                            <Badge variant="outline" className="font-normal text-muted-foreground">
                              Scripts
                            </Badge>
                          ) : null}
                          {already ? (
                            <Badge variant="secondary" className="font-normal">
                              Installed
                            </Badge>
                          ) : null}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy !== null || already}
                            onClick={() => void run(entry.source)}
                          >
                            {busy === entry.source ? (
                              <Spinner data-icon="inline-start" aria-label="Importing" />
                            ) : (
                              <DownloadIcon data-icon="inline-start" />
                            )}
                            Import
                          </Button>
                        </ItemActions>
                      </Item>
                    );
                  })}
                </ItemGroup>
              )}
            </>
          )}
        </CardContent>
      </Card>
      </Fade>
    </PageBody>
  );
}
