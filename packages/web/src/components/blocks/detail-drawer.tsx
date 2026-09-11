import { useRef, type ComponentProps, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

/**
 * The row detail sheet from the `TableCellViewer` half of
 * `dashboard-01/components/data-table.tsx`.
 *
 * Direction is responsive the way the block does it - a side sheet on a wide
 * screen, a bottom sheet on a phone - and that is the whole reason this is a
 * template instead of four hand-built sheets.
 *
 * The block's demo chart in the header does not come along: it showed the
 * same six made-up months on every row. What goes inside is the calling
 * page's business; the frame only guarantees header, scrolling body and a
 * footer that always offers a way out.
 */

export interface DetailDrawerProps {
  /** The element that opens it, usually a `DetailDrawerTrigger` in a cell. */
  trigger?: ReactNode;
  /** Controlled open state, for drawers opened from a row menu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  /** One line under the title. Kept for screen readers when not given. */
  description?: ReactNode;
  children: ReactNode;
  /** Actions left of the close button - save, delete, "Bericht öffnen". */
  footer?: ReactNode;
  closeLabel?: string;
  /**
   * Pins the direction instead of letting the screen width decide.
   *
   * Only for a surface that is not a row detail: the hands-free screen has no
   * table beside the sheet to keep visible, so its settings come up from the
   * bottom edge on every screen.
   */
  direction?: 'bottom' | 'right' | 'left' | 'top';
  className?: string;
}

export function DetailDrawer({
  trigger,
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel = 'Schließen',
  direction,
  className,
}: DetailDrawerProps) {
  const isMobile = useIsMobile();

  return (
    <Drawer
      direction={direction ?? (isMobile ? 'bottom' : 'right')}
      open={open}
      onOpenChange={onOpenChange}
    >
      {trigger ? <DrawerTrigger asChild>{trigger}</DrawerTrigger> : null}
      <DrawerContent className={className}>
        <DrawerHeader className="gap-1">
          <DrawerTitle>{title}</DrawerTitle>
          {/*
            Radix warns - rightly - about a dialog without a description. When
            the page has nothing to say here, the line stays for screen
            readers instead of being invented into the visible layout.
          */}
          <DrawerDescription className={cn(!description && 'sr-only')}>
            {description ?? 'Einzelheiten zum gewählten Eintrag'}
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 text-sm">{children}</div>
        <DrawerFooter>
          {footer}
          <DrawerClose asChild>
            <Button variant="outline">{closeLabel}</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * Hält den zuletzt gezeigten Eintrag fest, solange die Schublade zufährt.
 *
 * Eine Schublade, deren Seite beim Schliessen `if (!row) return null` sagt,
 * verschwindet im selben Bild aus dem Baum: die Ausblendung von vaul fällt
 * aus, und die Fokusrückgabe hängt am Aufräumen des Unmounts statt am
 * geordneten Schliessen. Mit diesem Haken bleibt der Inhalt stehen, bis die
 * Bewegung durch ist - der Rückgabewert wird erst `null`, wenn noch nie etwas
 * gewählt war, und dann gibt es auch nichts zu animieren.
 */
export function useDrawerSubject<T>(subject: T | null | undefined): T | null {
  const last = useRef<T | null>(null);
  if (subject !== null && subject !== undefined) last.current = subject;
  return subject ?? last.current;
}

/**
 * The block's cell trigger: a link-looking button that keeps the foreground
 * colour, so a table row reads as text and still opens the drawer.
 */
export function DetailDrawerTrigger({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="link"
      className={cn('w-fit px-0 text-left text-foreground', className)}
      {...props}
    />
  );
}
