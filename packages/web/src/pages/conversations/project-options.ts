import type { FilterOption } from '@/components/common/filter-combobox';
import { NO_PROJECT } from '@/lib/format';
import type { Project } from '@/lib/types';

export type ProjectSummary = Pick<Project, 'id' | 'name' | 'archived'>;

export function projectNameOf(
  projects: readonly ProjectSummary[],
  projectId: string | undefined,
): string | undefined {
  return projects.find((entry) => entry.id === projectId)?.name;
}

/**
 * The projects a conversation can be filed under. Archived ones drop out,
 * except the one it is already filed under - it has to stay visible to be
 * shown as the current choice.
 */
export function selectableProjects(
  projects: readonly ProjectSummary[],
  currentId: string | undefined,
): ProjectSummary[] {
  return projects.filter((entry) => !entry.archived || entry.id === currentId);
}

/** "No project" followed by the selectable projects, as combobox options. */
export function projectOptions(
  projects: readonly ProjectSummary[],
  currentId: string | undefined,
): FilterOption[] {
  return [
    { value: NO_PROJECT, label: 'No project' },
    ...selectableProjects(projects, currentId).map((entry) => ({
      value: entry.id,
      label: entry.name,
    })),
  ];
}
