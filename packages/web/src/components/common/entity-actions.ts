import { useCallback } from 'react';
import { BanIcon, RotateCcwIcon } from 'lucide-react';
import { toast } from 'sonner';

import { useConfirm, type ConfirmHandle } from '@/components/common/confirm-dialog';
import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { formatNumber } from '@/lib/stats';
import type { Skill, ToolServer } from '@/lib/types';

/**
 * The confirmations that belonged to an entity rather than to a page.
 *
 * A list page and the matching detail page kept the same question twice, word
 * for word: the skill deletion in two places, the tool removal in two, the
 * assignment cancellation in three. Worse, it was not only copied but also
 * forgotten - the stop button of `LiveRunList` asked on the chat page and did
 * not ask on the agent and task pages, and the bulk cancel on the assignments
 * list cancelled any number of runs without a word. Same button, same
 * component, three behaviours.
 *
 * Each hook owns the wording, the call and both toasts, and returns whether it
 * ran, so a detail page can still navigate away afterwards:
 *
 * ```tsx
 * const { dialog, cancelAssignment } = useCancelAssignment();
 * // …
 * return <>{dialog}{/* … *\/}</>;
 * ```
 *
 * `dialog` must be rendered by the component that holds the handle - a second
 * one next to a page's own `useConfirm` dialog is harmless, both sit closed.
 */

/* ------------------------------ assignments ------------------------------ */

const CANCEL_ONE = {
  title: 'Auftrag abbrechen?',
  description:
    'Der Agent hört auf zu arbeiten. Was bis dahin entstanden ist, bleibt am Auftrag stehen.',
  confirmLabel: 'Abbrechen',
  cancelLabel: 'Weiterlaufen lassen',
  destructive: true,
  icon: BanIcon,
} as const;

export interface CancelAssignmentHandle {
  dialog: ConfirmHandle['dialog'];
  /** Asks, cancels, toasts. `true` only when the call actually went out. */
  cancelAssignment(id: string): Promise<boolean>;
  /**
   * The same question for a whole selection, asked once. Returns how many runs
   * were stopped, or `null` when the reader said no.
   */
  cancelAssignments(ids: readonly string[]): Promise<number | null>;
}

export function useCancelAssignment(): CancelAssignmentHandle {
  const { confirm, dialog } = useConfirm();

  const cancelAssignment = useCallback(
    async (id: string): Promise<boolean> => {
      const ok = await confirm(CANCEL_ONE);
      if (!ok) return false;
      try {
        await api.cancelAssignment(id);
        toast('Auftrag wird abgebrochen');
        return true;
      } catch (caught) {
        reportFailure('Abbrechen', caught);
        return false;
      }
    },
    [confirm],
  );

  const cancelAssignments = useCallback(
    async (ids: readonly string[]): Promise<number | null> => {
      if (ids.length === 0) return null;
      if (ids.length === 1) {
        const first = ids[0];
        if (first === undefined) return null;
        return (await cancelAssignment(first)) ? 1 : null;
      }
      const ok = await confirm({
        ...CANCEL_ONE,
        title: formatNumber(ids.length) + ' Aufträge abbrechen?',
      });
      if (!ok) return null;

      // `allSettled`, not `all`: one 500 must not hide what happened to the
      // other nineteen.
      const results = await Promise.allSettled(ids.map((id) => api.cancelAssignment(id)));
      const failed = results.filter((entry) => entry.status === 'rejected').length;
      const done = ids.length - failed;
      if (failed === 0) toast(formatNumber(done) + ' Aufträge werden abgebrochen');
      else {
        toast.error(formatNumber(failed) + ' von ' + formatNumber(ids.length) + ' nicht abgebrochen');
      }
      return done;
    },
    [cancelAssignment, confirm],
  );

  return { dialog, cancelAssignment, cancelAssignments };
}

/* --------------------------------- skills -------------------------------- */

export interface DeleteSkillHandle {
  dialog: ConfirmHandle['dialog'];
  deleteSkill(skill: Skill): Promise<boolean>;
}

/**
 * `remove` stays the caller's, because both pages already hold the `useSkills`
 * handle and its list has to drop the row afterwards.
 */
export function useDeleteSkill(remove: (name: string) => Promise<unknown>): DeleteSkillHandle {
  const { confirm, dialog } = useConfirm();

  const deleteSkill = useCallback(
    async (skill: Skill): Promise<boolean> => {
      const ok = await confirm({
        title: 'Skill löschen?',
        description:
          'Der Ordner von „' +
          skill.name +
          '“ wird samt SKILL.md und allen mitgelieferten Dateien gelöscht. Das lässt sich nicht rückgängig machen.',
        confirmLabel: 'Löschen',
        destructive: true,
      });
      if (!ok) return false;
      try {
        await remove(skill.name);
        toast('Skill gelöscht', { description: skill.name });
        return true;
      } catch (caught) {
        reportFailure('Löschen', caught);
        return false;
      }
    },
    [confirm, remove],
  );

  return { dialog, deleteSkill };
}

/* --------------------------------- tools --------------------------------- */

export interface RemoveToolHandle {
  dialog: ConfirmHandle['dialog'];
  removeTool(tool: ToolServer): Promise<boolean>;
}

/**
 * One call, two meanings: dropping an entry's override removes an own server
 * for good and puts a catalogue server back on its shipped defaults. The
 * second case is the only way back from a broken option or a mistyped key, so
 * it belongs in every row - hence the two wordings.
 *
 * `refresh` is only needed for the catalogue case, where the entry survives
 * and has to be read again with its defaults.
 */
export function useRemoveTool(
  remove: (id: string) => Promise<unknown>,
  refresh: () => Promise<unknown>,
): RemoveToolHandle {
  const { confirm, dialog } = useConfirm();

  const removeTool = useCallback(
    async (tool: ToolServer): Promise<boolean> => {
      const own = tool.install === 'custom';
      const ok = await confirm({
        title: own ? 'Server entfernen?' : 'Auf Standard zurücksetzen?',
        description: own
          ? 'Der eigene Server „' +
            tool.name +
            '“ verschwindet aus der Rookery-Config. Der Befehl selbst bleibt auf der Platte.'
          : 'Alle eigenen Einstellungen für „' +
            tool.name +
            '“ — Zugriff, Optionen und hinterlegte Schlüssel — werden verworfen. Der Eintrag bleibt im Katalog und gilt wieder mit seinen Vorgaben.',
        confirmLabel: own ? 'Entfernen' : 'Zurücksetzen',
        destructive: true,
        ...(own ? {} : { icon: RotateCcwIcon }),
      });
      if (!ok) return false;
      try {
        await remove(tool.id);
        if (own) {
          toast('Server entfernt', { description: tool.name });
          return true;
        }
        await refresh();
        toast('Auf Standard zurückgesetzt', { description: tool.name });
        return true;
      } catch (caught) {
        reportFailure(own ? 'Entfernen' : 'Zurücksetzen', caught);
        return false;
      }
    },
    [confirm, refresh, remove],
  );

  return { dialog, removeTool };
}
