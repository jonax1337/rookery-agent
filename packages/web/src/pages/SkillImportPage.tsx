import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  DownloadIcon,
  FolderSearchIcon,
  GitBranchIcon,
  SearchIcon,
  SparklesIcon,
} from 'lucide-react';
import { toast } from 'sonner';

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

export function SkillImportPage() {
  const navigate = useNavigate();
  const { skills, catalog, catalogLoading, catalogError, loadCatalog, importFrom } = useSkills();

  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  /** `null` before the first attempt; `[]` means "a collection with nothing in it". */
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [filter, setFilter] = useState('');

  usePageMeta({
    breadcrumb: [{ label: 'Skills', to: '/skills' }, { label: 'Importieren' }],
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
          action: { label: 'Öffnen', onClick: () => void navigate('/skills/' + name) },
        });
        setSource('');
      } else {
        // A collection, not a skill. The choice belongs on the page, not in a
        // toast that disappears while it is being read.
        setCandidates(result.candidates);
        toast('Das ist eine Sammlung. Bitte einen Skill daraus wählen.');
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
      <p className="text-sm text-muted-foreground">
        Skills sind ein offenes Format: ein Ordner mit SKILL.md. Alles, was auf GitHub in diesem
        Format liegt, lässt sich hier holen — aus Anthropics Sammlung, von skills.sh oder aus einem
        eigenen Repo.
      </p>

      {/* ------------------------------ GitHub ------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle>Aus GitHub</CardTitle>
          <CardDescription>
            owner/repo, owner/repo/pfad/zum/skill oder die GitHub-URL. Bei einer Sammlung erscheint
            die Auswahl darunter.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <InputGroup>
            <InputGroupAddon align="inline-start">
              <GitBranchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={source}
              placeholder="owner/repo oder URL"
              aria-label="Quelle des Skills"
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
                  <Spinner data-icon="inline-start" aria-label="Wird geholt" />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                Importieren
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>

          {candidates !== null && candidates.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Mehrere Skills gefunden</p>
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
                        {busy === candidate ? <Spinner aria-label="Wird geholt" /> : null}
                        Diesen nehmen
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            </div>
          ) : null}

          {candidates !== null && candidates.length === 0 ? (
            <EmptyState
              icon={FolderSearchIcon}
              title="Dort liegt kein Skill"
              description="Unter dieser Adresse gibt es weder eine SKILL.md noch Unterordner, die einen Skill enthalten könnten."
              variant="plain"
              size="sm"
            />
          ) : null}
        </CardContent>
      </Card>

      {/* ------------------------------ Sammlung ---------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Anthropics Sammlung</CardTitle>
          <CardDescription>
            Öffentliche Skills von Anthropic. Skills mit Skripten brauchen Python oder Node und eine
            Shell, also Agenten mit Berechtigung „voll“; der Assistent selbst führt keine Skripte
            aus.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {catalogError ? (
            <EmptyState
              icon={SparklesIcon}
              title="Die Sammlung lässt sich gerade nicht laden"
              description="Die Liste kommt von GitHub. Ohne Netz oder mit einem Ausfall dort bleibt sie leer; ein eigener Pfad oben funktioniert trotzdem."
              actionLabel="Erneut versuchen"
              onAction={() => void loadCatalog(true)}
              variant="plain"
              size="sm"
            />
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
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  value={filter}
                  placeholder="Sammlung durchsuchen"
                  aria-label="Sammlung durchsuchen"
                  onChange={(event) => setFilter(event.target.value)}
                />
              </InputGroup>

              {shelf.length === 0 ? (
                <NoResults
                  {...(filter.trim() ? { query: filter.trim() } : {})}
                  onReset={() => setFilter('')}
                />
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
                              Skripte
                            </Badge>
                          ) : null}
                          {already ? (
                            <Badge variant="secondary" className="font-normal">
                              vorhanden
                            </Badge>
                          ) : null}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy !== null || already}
                            onClick={() => void run(entry.source)}
                          >
                            {busy === entry.source ? (
                              <Spinner data-icon="inline-start" aria-label="Wird geholt" />
                            ) : (
                              <DownloadIcon data-icon="inline-start" />
                            )}
                            Importieren
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
    </PageBody>
  );
}
