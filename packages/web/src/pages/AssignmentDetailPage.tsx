import { useCallback, useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import {
  ASSIGNMENT_STATUS_LABEL,
  ASSIGNMENT_STATUS_VARIANT,
  formatDuration,
  PROVIDER_LABEL,
  relativeTime,
  shorten,
} from '@/lib/format';
import { BanIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { AssignmentDetail } from '@/lib/types';
import type { OrgState } from '@/hooks/useOrg';
import { ResultMarkdown } from '@/components/result-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** One assignment: what was asked, who did it, what came back. */
export function AssignmentDetailPage({ org }: { org: OrgState }) {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      setDetail(await api.assignment(id));
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload while the socket says this one is still moving.
  useEffect(() => {
    if (!id) return;
    const view = org.live[id];
    if (view) void load();
  }, [id, org.live, load]);

  if (loading && !detail) return <Shell>Auftrag wird geladen …</Shell>;
  if (!detail) return <Shell>Diesen Auftrag gibt es nicht.</Shell>;

  const { assignment, agent, children } = detail;
  const status = org.live[assignment.id]?.status ?? assignment.status;
  const project = org.projects.find((entry) => entry.id === assignment.projectId);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={ASSIGNMENT_STATUS_VARIANT[status]} className="h-5">
              {ASSIGNMENT_STATUS_LABEL[status]}
            </Badge>
            {agent && (
              <NavLink
                to={'/org/agents/' + agent.id}
                className="text-sm font-medium hover:underline"
              >
                {agent.name}
              </NavLink>
            )}
            {agent && (
              <Badge variant="outline" className="font-mono text-[11px] font-normal">
                {agent.slug}
              </Badge>
            )}
            {(status === 'running' || status === 'pending') && (
              <Button
                variant="outline"
                size="sm"
                className="ms-auto"
                onClick={() => {
                  void api
                    .cancelAssignment(assignment.id)
                    .then(() => toast('Auftrag wird abgebrochen'))
                    .catch((caught: Error) =>
                      toast.error('Abbrechen fehlgeschlagen', { description: caught.message }),
                    );
                }}
              >
                <BanIcon />
                Abbrechen
              </Button>
            )}
          </div>
          <h1 className="text-xl font-semibold leading-snug tracking-tight">{assignment.task}</h1>
          <p className="tabular text-xs text-muted-foreground">
            {relativeTime(assignment.createdAt)}
            {assignment.durationMs ? ' · ' + formatDuration(assignment.durationMs) : ''}
            {assignment.provider ? ' · ' + PROVIDER_LABEL[assignment.provider] : ''}
            {assignment.model ? ' · ' + assignment.model : ''}
            {assignment.chars > 0 ? ' · ' + assignment.chars.toLocaleString('de-DE') + ' Z.' : ''}
            {project ? ' · Projekt ' + project.name : ''}
            {assignment.depth > 0 ? ' · Ebene ' + assignment.depth : ''}
          </p>
        </div>

        {assignment.error && (
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-destructive">Fehler</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-destructive">{assignment.error}</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Ergebnis</CardTitle>
          </CardHeader>
          <CardContent>
            {assignment.result ? (
              <ResultMarkdown text={assignment.result} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {status === 'running' || status === 'pending'
                  ? 'Der Auftrag läuft noch.'
                  : 'Kein Ergebnis.'}
              </p>
            )}
          </CardContent>
        </Card>

        {children.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Weitergegeben</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {children.map((child) => (
                  <li key={child.id}>
                    <NavLink
                      to={'/assignments/' + child.id}
                      className="-mx-2 flex flex-wrap items-center gap-3 rounded-md px-2 py-2.5 text-sm hover:bg-muted/60"
                    >
                      <Badge
                        variant={ASSIGNMENT_STATUS_VARIANT[child.status]}
                        className="h-5 shrink-0"
                      >
                        {ASSIGNMENT_STATUS_LABEL[child.status]}
                      </Badge>
                      <span className="w-36 shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                        {org.agentById(child.agentId)?.name ?? 'Unbekannt'}
                      </span>
                      <span className="min-w-0 flex-1 text-muted-foreground">
                        {shorten(child.task, 120)}
                      </span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Shell({ children }: { children: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-6">
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
