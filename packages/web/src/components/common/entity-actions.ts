import { BanIcon, RotateCcwIcon } from "@/components/icons";
import { useCallback } from 'react';

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
  title: 'Stop this run?',
  description:
    'The agent will stop working. Anything produced so far stays on the run.',
  confirmLabel: 'Stop the run',
  cancelLabel: 'Keep running',
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
        toast('The run is being stopped');
        return true;
      } catch (caught) {
        reportFailure('Cancellation', caught);
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
        title: 'Stop ' + formatNumber(ids.length) + ' runs?',
      });
      if (!ok) return null;

      // `allSettled`, not `all`: one 500 must not hide what happened to the
      // other nineteen.
      const results = await Promise.allSettled(ids.map((id) => api.cancelAssignment(id)));
      const failed = results.filter((entry) => entry.status === 'rejected').length;
      const done = ids.length - failed;
      if (failed === 0) toast(formatNumber(done) + ' runs are being stopped');
      else {
        toast.error(formatNumber(failed) + ' of ' + formatNumber(ids.length) + ' could not be cancelled');
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
        title: 'Delete skill?',
        description:
          'The folder for “' +
          skill.name +
          '” will be deleted along with its SKILL.md and all bundled files. This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return false;
      try {
        await remove(skill.name);
        toast('Skill deleted', { description: skill.name });
        return true;
      } catch (caught) {
        reportFailure('Deletion', caught);
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
        title: own ? 'Remove server?' : 'Reset to default?',
        description: own
          ? 'The custom server “' +
            tool.name +
            '” will be removed from the Rookery config. The command itself will remain on disk.'
          : 'All custom settings for “' +
            tool.name +
            '” — access, options, and stored keys — will be discarded. The catalogue entry will remain and use its defaults again.',
        confirmLabel: own ? 'Remove' : 'Reset',
        destructive: true,
        ...(own ? {} : { icon: RotateCcwIcon }),
      });
      if (!ok) return false;
      try {
        await remove(tool.id);
        if (own) {
          toast('Server removed', { description: tool.name });
          return true;
        }
        await refresh();
        toast('Reset to default', { description: tool.name });
        return true;
      } catch (caught) {
        reportFailure(own ? 'Removal' : 'Reset', caught);
        return false;
      }
    },
    [confirm, refresh, remove],
  );

  return { dialog, removeTool };
}
