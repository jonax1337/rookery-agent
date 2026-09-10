import { NavLink } from 'react-router';
import { BanIcon, CheckIcon, LoaderIcon, XIcon } from 'lucide-react';
import {
  ASSIGNMENT_STATUS_LABEL,
  ASSIGNMENT_STATUS_VARIANT,
  formatDuration,
  PROVIDER_LABEL,
} from '@/lib/format';
import type { AssignmentStatus, AssignmentView } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The assignments this turn handed out, while it is happening.
 *
 * Rows are indented by delegation depth, because the thing worth seeing is who
 * asked whom: a flat list would hide the chain the assistant built.
 */
export function AssignmentsView({ assignments }: { assignments: AssignmentView[] }) {
  const running = assignments.filter((entry) => entry.status === 'running').length;
  const done = assignments.filter((entry) => entry.status === 'done').length;
  const failed = assignments.filter((entry) => entry.status === 'failed').length;

  return (
    <Card className="py-3" aria-label="Aufträge dieses Turns">
      <CardHeader className="flex flex-wrap items-center gap-2 border-b px-3!">
        <CardTitle className="text-sm">Aufträge</CardTitle>
        <Badge variant="secondary" className="tabular h-4 px-1.5 text-[10px]">
          {assignments.length} {assignments.length === 1 ? 'Auftrag' : 'Aufträge'}
        </Badge>

        <span className="tabular ml-auto text-[11px] text-muted-foreground">
          {running > 0 ? running + ' laufen · ' + done + ' fertig' : done + ' fertig'}
          {failed > 0 && <span className="text-destructive"> · {failed} fehlgeschlagen</span>}
        </span>
      </CardHeader>

      <CardContent className="space-y-1.5 px-3!">
        <ul className="space-y-1.5">
          {assignments.map((assignment) => (
            <AssignmentRow key={assignment.id} assignment={assignment} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function AssignmentRow({ assignment }: { assignment: AssignmentView }) {
  // Nesting is capped server-side, so a fixed step per level stays readable.
  const indent = Math.min(assignment.depth, 4) * 16;

  return (
    <li style={{ marginInlineStart: indent }} className="rounded-lg border bg-background/40 p-2">
      <div className="flex items-start gap-2">
        <StatusIcon status={assignment.status} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium leading-snug">
            <NavLink to={'/org/agents/' + assignment.agentId} className="hover:underline">
              {assignment.agentName}
            </NavLink>
            <Badge variant="outline" className="h-4 px-1.5 font-mono text-[10px] font-normal">
              {assignment.agentSlug}
            </Badge>
            <Badge
              variant={ASSIGNMENT_STATUS_VARIANT[assignment.status]}
              className="h-4 px-1.5 text-[10px]"
            >
              {ASSIGNMENT_STATUS_LABEL[assignment.status]}
            </Badge>
          </p>

          <p className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted-foreground">
            {assignment.task}
          </p>

          <p className="tabular mt-1 flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
            {assignment.provider && <span>{PROVIDER_LABEL[assignment.provider]}</span>}
            {typeof assignment.chars === 'number' && assignment.chars > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{assignment.chars.toLocaleString('de-DE')} Z.</span>
              </>
            )}
            {typeof assignment.durationMs === 'number' && assignment.durationMs > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatDuration(assignment.durationMs)}</span>
              </>
            )}
          </p>
        </div>
      </div>

      {assignment.status === 'running' && assignment.preview && (
        <p className="mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap pl-6 font-mono text-[10px] text-muted-foreground/80">
          {assignment.preview}
        </p>
      )}

      {assignment.error && (
        <p className="mt-1.5 pl-6 text-[11px] leading-snug text-destructive">{assignment.error}</p>
      )}
    </li>
  );
}

function StatusIcon({ status }: { status: AssignmentStatus }) {
  if (status === 'running') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <LoaderIcon className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
        </TooltipTrigger>
        <TooltipContent>läuft</TooltipContent>
      </Tooltip>
    );
  }
  if (status === 'done') {
    return <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-label="fertig" />;
  }
  if (status === 'failed') {
    return <XIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-label="fehlgeschlagen" />;
  }
  if (status === 'cancelled') {
    return (
      <BanIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label="abgebrochen" />
    );
  }
  return (
    <span
      className="mt-1 size-2.5 shrink-0 rounded-full border border-muted-foreground/40"
      aria-label="ausstehend"
    />
  );
}
