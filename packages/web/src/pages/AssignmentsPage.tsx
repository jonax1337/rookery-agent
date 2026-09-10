import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { api } from '@/lib/api';
import {
  ASSIGNMENT_STATUS_LABEL,
  ASSIGNMENT_STATUS_VARIANT,
  formatDuration,
  relativeTime,
} from '@/lib/format';
import type { Assignment, AssignmentStatus } from '@/lib/types';
import type { OrgState } from '@/hooks/useOrg';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL = '__all__';
const STATUSES: AssignmentStatus[] = ['pending', 'running', 'done', 'failed', 'cancelled'];

/**
 * Everything the company has been asked to do, newest first.
 *
 * The list reloads whenever the socket reports an assignment change, so a run
 * started in the chat, the CLI or from an agent's own page shows up here
 * without a refresh.
 */
export function AssignmentsPage({ org }: { org: OrgState }) {
  const [items, setItems] = useState<Assignment[]>([]);
  const [status, setStatus] = useState<string>(ALL);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setItems(
        await api.assignments({
          limit: 100,
          ...(status !== ALL ? { status: [status as AssignmentStatus] } : {}),
        }),
      );
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [status]);

  // `live` gets a new identity on every assignment broadcast, so depending on
  // it is what keeps the list current without a poll.
  useEffect(() => {
    void load();
  }, [load, org.live]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Aufträge</h1>
            <p className="text-sm text-muted-foreground">
              Jeder einzelne Lauf eines Agenten: ein Prozess, ein Ergebnis. Neueste zuerst.
            </p>
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-48" aria-label="Status filtern">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Alle Status</SelectItem>
              {STATUSES.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {ASSIGNMENT_STATUS_LABEL[entry]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Card>
          <CardContent>
            {loading && items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Wird geladen …</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Keine Aufträge in dieser Auswahl.</p>
            ) : (
              <ul className="divide-y">
                {items.map((assignment) => {
                  const agent = org.agentById(assignment.agentId);
                  return (
                    <li key={assignment.id}>
                      <NavLink
                        to={'/assignments/' + assignment.id}
                        className="-mx-2 flex flex-wrap items-center gap-3 rounded-md px-2 py-3 text-sm hover:bg-muted/60"
                      >
                        <Badge
                          variant={ASSIGNMENT_STATUS_VARIANT[assignment.status]}
                          className="h-5 shrink-0"
                        >
                          {ASSIGNMENT_STATUS_LABEL[assignment.status]}
                        </Badge>
                        <span className="w-36 shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                          {agent?.name ?? 'Unbekannt'}
                        </span>
                        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
                          {assignment.task}
                        </span>
                        <span className="tabular shrink-0 text-xs text-muted-foreground">
                          {formatDuration(assignment.durationMs) || '—'} ·{' '}
                          {relativeTime(assignment.createdAt)}
                        </span>
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
