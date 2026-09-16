import * as React from 'react';

import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { reportFailure } from '@/lib/errors';
import { formatNumber } from '@/lib/stats';
import type { IconComponent } from "@/components/icons";

import { BadgeAlertIcon as TriangleAlertIcon } from "@/components/icons";
/**
 * The question every irreversible action has to ask.
 *
 * Today nothing in this app asks it: agents, teams, projects, schedules,
 * tools, skills and conversations all delete on the first click. `useConfirm`
 * turns that into one `await` so a handler reads as prose:
 *
 * ```tsx
 * const { confirm, dialog } = useConfirm();
 * // ...
 * async function onDelete() {
 *   const ok = await confirm({
 *     title: 'Agent entlassen?',
 *     description: 'Die bisherigen Aufträge bleiben erhalten.',
 *     confirmLabel: 'Entlassen',
 *     destructive: true,
 *   });
 *   if (ok) await remove(agent.id);
 * }
 * // ...
 * return <>{dialog}{/* … *\/}</>;
 * ```
 *
 * `dialog` has to be rendered somewhere in the component that owns the handle
 * - it is a normal element, not a portal registration, so the promise only
 * resolves while it is mounted. On unmount a pending question resolves to
 * `false`, which is the safe answer.
 */

export interface ConfirmOptions {
  title: string;
  /** What actually happens, in one sentence. Not a repetition of the title. */
  description?: React.ReactNode;
  /** The affirmative button. Name the deed: "Löschen", "Entlassen", "Abbrechen". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Paints the affirmative button as destructive. Every deletion sets it. */
  destructive?: boolean;
  /** Shown in the dialog's media slot; falls back to a warning triangle. */
  icon?: IconComponent | null;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
  onCancel?(): void;
}

/**
 * The plain controlled dialog, for the rare case that a component already
 * owns its open state. Everything else goes through `useConfirm`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  icon,
}: ConfirmDialogProps) {
  // `null` deliberately switches the media slot off; `undefined` just means
  // "nothing chosen", which is where the warning triangle belongs.
  const Icon = icon === null ? null : (icon ?? TriangleAlertIcon);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel?.();
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          {Icon && (
            <AlertDialogMedia
              className={destructive ? 'bg-destructive/10 text-destructive' : undefined}
            >
              <Icon />
            </AlertDialogMedia>
          )}
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface ConfirmHandle {
  /** Ask, and resolve to `true` only when the affirmative button was pressed. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Render this once, anywhere inside the owning component. */
  dialog: React.ReactElement;
  /** True while a question is on screen - handy to disable the trigger. */
  open: boolean;
}

export function useConfirm(): ConfirmHandle {
  const [open, setOpen] = React.useState(false);
  // Kept past the close so the dialog can animate out with its own text
  // instead of blanking the moment the answer arrives.
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null);
  const pendingRef = React.useRef<((value: boolean) => void) | null>(null);

  const settle = React.useCallback((value: boolean) => {
    const resolve = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);

  const confirm = React.useCallback(
    (next: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        // A second question while one is open answers the first with "no"
        // rather than leaving its promise hanging forever.
        pendingRef.current?.(false);
        pendingRef.current = resolve;
        setOptions(next);
        setOpen(true);
      }),
    [],
  );

  React.useEffect(
    () => () => {
      const resolve = pendingRef.current;
      pendingRef.current = null;
      resolve?.(false);
    },
    [],
  );

  const dialog = (
    <ConfirmDialog
      {...(options ?? { title: '' })}
      open={open && options !== null}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
      onConfirm={() => settle(true)}
    />
  );

  return { confirm, dialog, open };
}

/* ------------------------------ bulk actions ------------------------------ */

export interface BulkActionSpec<T> {
  rows: readonly T[];
  /**
   * The thing being acted on, for the title of a multi-row question:
   * `{ singular: 'agent', plural: 'agents' }`.
   */
  noun: { singular: string; plural: string };
  /** Names one row, for the title of a single-row question. */
  nameOf(row: T): string;
  /** Action verb: "archive", "remove", "disband". */
  verb: string;
  /** Past participle for the success toast: "archived". */
  done: string;
  /** What actually happens, in one sentence. */
  description?: React.ReactNode;
  /** The affirmative button. Usually the capitalised `verb`. */
  confirmLabel: string;
  cancelLabel?: string;
  icon?: IconComponent | null;
  /** Defaults to `true`; a bulk action that is not destructive is rare. */
  destructive?: boolean;
  /** Runs for one row. Rejections are counted, not swallowed. */
  run(row: T): Promise<unknown>;
  /** Re-reads the list once, after every row was attempted. */
  after?(): Promise<unknown> | void;
  /** Empties the table's selection. The `clear` the bulk bar hands over. */
  clear?(): void;
}

export interface BulkActionHandle {
  /** Render this once inside the component that holds the handle. */
  dialog: React.ReactElement;
  /** Returns how many rows went through, or `null` when the reader said no. */
  run<T>(spec: BulkActionSpec<T>): Promise<number | null>;
}

/**
 * One question, then the whole selection.
 *
 * The three company lists each grew their own version of this - the same
 * pluralised title, the same `destructive: true`, the same toast pair. And all
 * three shared one hole: `Promise.all` let a single 500 swallow the outcome
 * for every other row, and because `clear()` stood behind it, the selection
 * then stayed checked as though nothing had happened.
 *
 * `allSettled` closes that. The selection is cleared and the list re-read in
 * every case, and a partial failure is finally allowed to say so: "2 von 9
 * nicht archiviert" instead of one flat error.
 */
export function useBulkAction(): BulkActionHandle {
  const { confirm, dialog } = useConfirm();

  const run = React.useCallback(
    async <T,>(spec: BulkActionSpec<T>): Promise<number | null> => {
      const { rows, noun, nameOf, verb, done } = spec;
      if (rows.length === 0) return null;

      const first = rows[0];
      const title =
        verb.charAt(0).toUpperCase() +
        verb.slice(1) +
        ' ' +
        (rows.length === 1 && first !== undefined
          ? '“' + nameOf(first) + '”'
          : formatNumber(rows.length) + ' ' + noun.plural.toLocaleLowerCase('en-GB')) +
        '?';

      const ok = await confirm({
        title,
        confirmLabel: spec.confirmLabel,
        destructive: spec.destructive ?? true,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        ...(spec.cancelLabel !== undefined ? { cancelLabel: spec.cancelLabel } : {}),
        ...(spec.icon !== undefined ? { icon: spec.icon } : {}),
      });
      if (!ok) return null;

      const results = await Promise.allSettled(rows.map((row) => spec.run(row)));
      const failures = results.filter(
        (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
      );
      const succeeded = rows.length - failures.length;

      spec.clear?.();
      try {
        await spec.after?.();
      } catch (caught) {
        reportFailure('Update', caught);
      }

      if (failures.length === 0) {
        toast(formatNumber(succeeded) + ' ' + done);
      } else if (succeeded === 0) {
        reportFailure(spec.confirmLabel, failures[0]?.reason);
      } else {
        toast.error(
          formatNumber(failures.length) +
            ' of ' +
            formatNumber(rows.length) +
            ' not ' +
            done,
          { description: formatNumber(succeeded) + ' ' + done + '.' },
        );
      }
      return succeeded;
    },
    [confirm],
  );

  return { dialog, run };
}
