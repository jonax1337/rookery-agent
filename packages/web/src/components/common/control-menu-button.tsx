import type * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The pill that opens a turn control.
 *
 * `App.tsx` carries three of these copy-paste identical (`ComposerMenuButton`
 * for Projekt, Zugriff and Effort), `model-menu.tsx` a fourth with an icon in
 * front and `context-indicator.tsx` a fifth with a ring - the same seven
 * classes written out five times. One component, one look.
 *
 * It only draws the trigger; it never owns the menu. Wrap it the way the
 * primitive wants:
 *
 * ```tsx
 * <DropdownMenu>
 *   <DropdownMenuTrigger asChild>
 *     <ControlMenuButton label="Zugriff" value={PERMISSION_LABEL[permission]} />
 *   </DropdownMenuTrigger>
 *   …
 * ```
 *
 * Inside a `ButtonGroup` the pill squares itself off automatically, so the
 * same component works in the composer row and in a page's action bar.
 */

export interface ControlMenuButtonProps
  extends Omit<React.ComponentProps<typeof Button>, 'children' | 'value'> {
  /** What the control is called: "Projekt", "Zugriff", "Modell", "Effort". */
  label: string;
  /**
   * The current choice, which is what is actually printed. Falls back to the
   * label, the way an unset Effort pill reads "Effort".
   */
  value?: React.ReactNode;
  /** A glyph in front - the provider mark, the context ring. */
  icon?: React.ReactNode;
  /** Off for a control that opens a popover rather than a menu of choices. */
  chevron?: boolean;
}

export function ControlMenuButton({
  label,
  value,
  icon,
  chevron = true,
  className,
  variant = 'ghost',
  size = 'sm',
  ...props
}: ControlMenuButtonProps) {
  // The pill shows the choice, so the accessible name has to supply the
  // question it answers - "Mittel" alone says nothing out loud.
  const spoken = textOf(value);
  const ariaLabel = props['aria-label'] ?? (spoken ? label + ': ' + spoken : label);

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      {...props}
      aria-label={ariaLabel}
      className={cn(
        'h-7 gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground',
        'in-data-[slot=button-group]:rounded-md',
        className,
      )}
    >
      {icon}
      <span className="max-w-36 truncate">{value ?? label}</span>
      {chevron && <ChevronDownIcon className="size-3.5 opacity-60" />}
    </Button>
  );
}

/** Best effort at a spoken form of the pill's content. */
function textOf(value: React.ReactNode): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
