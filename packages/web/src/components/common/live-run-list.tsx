import * as React from 'react';
import { NavLink } from 'react-router';
import { XIcon } from 'lucide-react';
import { StatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDuration, PROVIDER_LABEL } from '@/lib/format';
import { formatNumber } from '@/lib/stats';
import type { AssignmentView } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The assignments a turn handed out, while it is happening.
 *
 * Successor to `AssignmentsView`, which drew the delegation chain with a
 * hand-computed `marginInlineStart` on a flat `<ul>` - it looked nested but
 * nothing actually was, so nothing could be collapsed, counted or styled per
 * branch. Here a sub-assignment is a real `ItemGroup` inside its parent's
 * row: the chain the assistant built is the structure of the markup.
 *
 * The point of the list is still who asked whom, so ordering follows the
 * chain rather than the clock, and every row can be cancelled while it runs.
 */

export interface LiveRunListProps {
  assignments: readonly AssignmentView[];
  /** Given: every running row gets an "Abbrechen" action. */
  onCancel?: (id: string) => void;
  /** `plain` drops the card frame for a page that already has one. */
  variant?: 'card' | 'plain';
  title?: string;
  className?: string;
}

interface RunNode {
  assignment: AssignmentView;
  children: RunNode[];
}

/**
 * Rebuilds the delegation tree from `parentId`.
 *
 * An assignment whose parent is not in this list is a root here even when its
 * `depth` says otherwise - a turn can show a sub-assignment without having
 * shipped the one above it, and hiding it would be worse than flattening it.
 */
function toTree(assignments: readonly AssignmentView[]): RunNode[] {
  const nodes = new Map<string, RunNode>();
  for (const assignment of assignments) nodes.set(assignment.id, { assignment, children: [] });

  const roots: RunNode[] = [];
  for (const assignment of assignments) {
    const node = nodes.get(assignment.id);
    if (!node) continue;
    const parent = assignment.parentId ? nodes.get(assignment.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function LiveRunList({
  assignments,
  onCancel,
  variant = 'card',
  title = 'Assignments',
  className,
}: LiveRunListProps) {
  const tree = React.useMemo(() => toTree(assignments), [assignments]);

  const running = assignments.filter((entry) => entry.status === 'running').length;
  const done = assignments.filter((entry) => entry.status === 'done').length;
  const failed = assignments.filter((entry) => entry.status === 'failed').length;

  const body = (
    <ItemGroup className="gap-2">
      {tree.map((node) => (
        <RunRow key={node.assignment.id} node={node} onCancel={onCancel} />
      ))}
    </ItemGroup>
  );

  if (variant === 'plain') return <div className={className}>{body}</div>;

  return (
    <Card className={cn('py-3', className)} aria-label="Assignments for this turn">
      <CardHeader className="flex flex-wrap items-center gap-2 border-b px-3!">
        <CardTitle className="text-sm">{title}</CardTitle>
        <Badge variant="secondary" className="tabular-nums">
          {assignments.length} {assignments.length === 1 ? 'assignment' : 'assignments'}
        </Badge>

        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {running > 0 ? running + ' running · ' + done + ' done' : done + ' done'}
          {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
        </span>
      </CardHeader>

      <CardContent className="px-3!">{body}</CardContent>
    </Card>
  );
}

function RunRow({ node, onCancel }: { node: RunNode; onCancel?: (id: string) => void }) {
  const { assignment, children } = node;
  const meta = [
    assignment.provider ? PROVIDER_LABEL[assignment.provider] : null,
    assignment.chars && assignment.chars > 0 ? formatNumber(assignment.chars) + ' chars' : null,
    assignment.durationMs && assignment.durationMs > 0
      ? formatDuration(assignment.durationMs)
      : null,
  ].filter((entry): entry is string => entry !== null);

  const cancellable = assignment.status === 'running' || assignment.status === 'pending';

  return (
    <Item variant="outline" size="sm" className="items-start">
      <ItemContent>
        <ItemTitle className="flex-wrap gap-1.5">
          <NavLink to={'/org/agents/' + assignment.agentId} className="hover:underline">
            {assignment.agentName}
          </NavLink>
          <Badge variant="outline" className="font-mono font-normal">
            {assignment.agentSlug}
          </Badge>
          <StatusBadge kind="assignment" status={assignment.status} />
        </ItemTitle>

        <ItemDescription className="line-clamp-1">{assignment.task}</ItemDescription>

        {meta.length > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">{meta.join(' · ')}</span>
        )}

        {assignment.status === 'running' && assignment.preview && (
          <span className="truncate font-mono text-xs text-muted-foreground/80">
            {assignment.preview}
          </span>
        )}

        {assignment.error && (
          <span className="text-xs leading-snug text-destructive">{assignment.error}</span>
        )}
      </ItemContent>

      {cancellable && onCancel && (
        <ItemActions>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Cancel assignment"
                onClick={() => onCancel(assignment.id)}
              >
                <XIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Cancel</TooltipContent>
          </Tooltip>
        </ItemActions>
      )}

      {children.length > 0 && (
        // The sub-assignments of this row, as their own group: the border is
        // the delegation edge, not a decoration.
        <ItemFooter className="mt-1 block border-l pl-3">
          <ItemGroup className="gap-2">
            {children.map((child) => (
              <RunRow key={child.assignment.id} node={child} onCancel={onCancel} />
            ))}
          </ItemGroup>
        </ItemFooter>
      )}
    </Item>
  );
}
