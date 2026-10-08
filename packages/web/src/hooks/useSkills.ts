import { useMemo } from 'react';
import { api, type ApiError } from '../lib/api';
import type { Skill, SkillImportResult, SkillInput, SkillSourceEntry } from '../lib/types';
import { createSharedList } from './shared-list';

/**
 * The skills, held once for the whole app - the same arrangement as
 * `useTools`, and for the same reason: skills hang on no socket broadcast, so
 * the list refetches after every mutation and whenever the tab becomes
 * visible again. A skill folder edited in an editor is otherwise invisible
 * until a reload.
 *
 * The public catalogue is fetched lazily: only the import page needs it, and
 * it is a network call to GitHub's side of the world.
 */

const skillList = createSharedList<Skill>(api.skills);
const catalogList = createSharedList<SkillSourceEntry>(api.skillCatalog, { lazy: true });

function loadCatalog(force = false): Promise<void> {
  return force || !catalogList.snapshot().loaded ? catalogList.load() : Promise.resolve();
}

export interface SkillsState {
  skills: Skill[];
  loading: boolean;
  error: ApiError | null;
  refresh(): Promise<void>;
  skillByName(name: string | undefined): Skill | undefined;
  /** Create or overwrite; the name is the identity, there is no rename. */
  save(name: string, input: SkillInput): Promise<Skill>;
  remove(name: string): Promise<void>;
  /** Pulls a skill folder off GitHub. Takes a few seconds. */
  importFrom(source: string): Promise<SkillImportResult>;
  /** The public shelf, fetched on first ask. */
  catalog: SkillSourceEntry[];
  catalogLoading: boolean;
  catalogError: ApiError | null;
  loadCatalog(force?: boolean): Promise<void>;
}

export function useSkills(): SkillsState {
  const state = skillList.use();
  const catalog = catalogList.use();

  return useMemo<SkillsState>(
    () => ({
      skills: state.items,
      loading: state.loading,
      error: state.error,
      refresh: skillList.load,
      skillByName: (name) =>
        name ? state.items.find((skill) => skill.name === name) : undefined,
      save: async (name, input) => {
        const skill = await api.saveSkill(name, input);
        const current = skillList.snapshot().items;
        skillList.setItems(
          current.some((entry) => entry.name === name)
            ? current.map((entry) => (entry.name === name ? skill : entry))
            : [...current, skill],
        );
        return skill;
      },
      remove: async (name) => {
        await api.deleteSkill(name);
        skillList.setItems(skillList.snapshot().items.filter((skill) => skill.name !== name));
      },
      importFrom: async (source) => {
        const result = await api.importSkill(source);
        // An import writes a folder; only a refetch knows what landed.
        await skillList.load();
        return result;
      },
      catalog: catalog.items,
      catalogLoading: catalog.loading,
      catalogError: catalog.error,
      loadCatalog,
    }),
    [state, catalog],
  );
}

export interface SkillState extends SkillsState {
  /** Undefined while loading, and for a name that no longer exists. */
  skill: Skill | undefined;
}

/** One skill out of the shared list, for the detail and form pages. */
export function useSkill(name: string | undefined): SkillState {
  const state = useSkills();
  return useMemo(() => ({ ...state, skill: state.skillByName(name) }), [state, name]);
}
