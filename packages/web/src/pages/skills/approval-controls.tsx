import { AUDIENCE_SHORT_LABEL, AUDIENCE_VALUES } from '@/lib/tools';
import type { ToolServerAudience } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * The audience picker that sits beside every approval switch.
 *
 * A hook set is approved per source *and* per audience, and the two are not
 * interchangeable: the assistant runs with somebody watching, an agent does
 * not. Small and inline rather than a dialog, because it is the second half
 * of one decision, not a separate one.
 */
export function AudienceSelect({
  value,
  label,
  onChange,
}: {
  value: ToolServerAudience;
  label: string;
  onChange(next: ToolServerAudience): void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ToolServerAudience)}>
      <SelectTrigger size="sm" className="w-[9.5rem]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {AUDIENCE_VALUES.map((audience) => (
          <SelectItem key={audience} value={audience}>
            {AUDIENCE_SHORT_LABEL[audience]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Approved once, but the file moved on since: the approval stands, nothing is handed over. */
export function ChangedBadge() {
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      Changed
    </Badge>
  );
}
