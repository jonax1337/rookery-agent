import { toolStatusLook } from '@/lib/tools';
import type { ToolServer } from '@/lib/types';
import { Badge } from '@/components/ui/badge';

/** The state of a server, spelled out - the list and the detail page draw the same badge. */
export function ToolStatusBadge({ tool }: { tool: ToolServer }) {
  const look = toolStatusLook(tool);
  return (
    <Badge variant={look.variant} className="gap-1">
      {look.icon ? <look.icon className={look.iconClassName} aria-hidden="true" /> : null}
      {look.label}
    </Badge>
  );
}
