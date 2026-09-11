import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, ApiError } from '../lib/api';
import type { Skill, SkillImportResult, SkillInput, SkillSourceEntry } from '../lib/types';

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

interface SkillsSnapshot {
  skills: Skill[];
  loading: boolean;
  error: ApiError | null;
  loaded: boolean;
  catalog: SkillSourceEntry[];
  catalogLoading: boolean;
  catalogError: ApiError | null;
  catalogLoaded: boolean;
}

let snapshot: SkillsSnapshot = {
  skills: [],
  loading: true,
  error: null,
  loaded: false,
  catalog: [],
  catalogLoading: false,
  catalogError: null,
  catalogLoaded: false,
};

const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let catalogInflight: Promise<void> | null = null;

function publish(next: Partial<SkillsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function asApiError(caught: unknown): ApiError {
  return caught instanceof ApiError ? caught : new ApiError(String(caught), 0);
}

function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const skills = await api.skills();
      publish({ skills, error: null, loading: false, loaded: true });
    } catch (caught) {
      publish({ error: asApiError(caught), loading: false, loaded: true });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function loadCatalog(force = false): Promise<void> {
  if (catalogInflight) return catalogInflight;
  if (snapshot.catalogLoaded && !force) return Promise.resolve();
  publish({ catalogLoading: true });
  catalogInflight = (async () => {
    try {
      const catalog = await api.skillCatalog();
      publish({ catalog, catalogError: null, catalogLoading: false, catalogLoaded: true });
    } catch (caught) {
      publish({ catalogError: asApiError(caught), catalogLoading: false, catalogLoaded: true });
    } finally {
      catalogInflight = null;
    }
  })();
  return catalogInflight;
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
  const state = useSyncExternalStore(subscribe, () => snapshot);

  useEffect(() => {
    if (!snapshot.loaded) void load();
  }, []);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return useMemo<SkillsState>(
    () => ({
      skills: state.skills,
      loading: state.loading,
      error: state.error,
      refresh: load,
      skillByName: (name) =>
        name ? state.skills.find((skill) => skill.name === name) : undefined,
      save: async (name, input) => {
        const skill = await api.saveSkill(name, input);
        publish({
          skills: state.skills.some((entry) => entry.name === name)
            ? state.skills.map((entry) => (entry.name === name ? skill : entry))
            : [...state.skills, skill],
        });
        return skill;
      },
      remove: async (name) => {
        await api.deleteSkill(name);
        publish({ skills: snapshot.skills.filter((skill) => skill.name !== name) });
      },
      importFrom: async (source) => {
        const result = await api.importSkill(source);
        // An import writes a folder; only a refetch knows what landed.
        await load();
        return result;
      },
      catalog: state.catalog,
      catalogLoading: state.catalogLoading,
      catalogError: state.catalogError,
      loadCatalog,
    }),
    [state],
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
