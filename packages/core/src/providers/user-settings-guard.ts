import { watch, type FSWatcher } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Keeps Rookery's terminals from rewriting the person's own Claude Code
 * defaults.
 *
 * A terminal Rookery opens is not the `claude` somebody starts in a shell,
 * but it is the same program with the same configuration folder, and its
 * `/model` menu saves a pick with Enter as the *global* default - so picking
 * GPT in a Rookery terminal left the person's own `claude` asking GPT next
 * morning. A separate configuration folder would isolate it properly, and
 * would also split the login (a refreshed token in one copy logs the other
 * out) and the session transcripts the chat and the terminal share.
 *
 * So instead: while at least one Rookery terminal is open, the model keys of
 * `settings.json` are remembered as they were, and put back whenever a
 * terminal writes over them. The terminal keeps the model it switched to -
 * its own process holds that - and the person's defaults stay theirs.
 *
 * The cost, stated plainly: a default changed on purpose in a *separate*
 * `claude` while a Rookery terminal is open is reverted too. It can be set
 * again once Rookery's terminals are closed.
 */

/** The settings keys a model pick writes. Everything else is left alone. */
const GUARDED = ['model', 'effortLevel', 'modelSettings'] as const;

type Snapshot = Partial<Record<(typeof GUARDED)[number], unknown>>;

const DEBOUNCE_MS = 150;

class UserSettingsGuard {
  #holders = 0;
  #file = '';
  #baseline: Snapshot | null = null;
  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writing = false;

  /**
   * Hold the guard for as long as one terminal runs; the returned function
   * lets go. The first holder takes the snapshot, the last one stops
   * watching after one final check.
   */
  acquire(configDir: string): () => void {
    this.#holders += 1;
    if (this.#holders === 1) void this.#start(join(configDir, 'settings.json'));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holders -= 1;
      if (this.#holders === 0) void this.#stop();
    };
  }

  async #start(file: string): Promise<void> {
    this.#file = file;
    this.#baseline = pick(await readSettings(file));
    try {
      // The folder, not the file: an editor that saves by rename replaces
      // the file, and a watcher on the old one would go deaf.
      this.#watcher = watch(dirname(file), (_event, name) => {
        if (name && name.toString() !== basename(file)) return;
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => void this.#check(), DEBOUNCE_MS);
      });
      this.#watcher.unref?.();
    } catch {
      // No folder to watch: nothing can write a default there either.
    }
  }

  async #stop(): Promise<void> {
    clearTimeout(this.#timer);
    await this.#check();
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#baseline = null;
  }

  /** Put the remembered model keys back if a terminal wrote over them. */
  async #check(): Promise<void> {
    const baseline = this.#baseline;
    if (!baseline || this.#writing) return;
    const current = await readSettings(this.#file);
    if (!current) return;
    const changed = GUARDED.filter((key) => JSON.stringify(current[key]) !== JSON.stringify(baseline[key]));
    if (!changed.length) return;
    for (const key of changed) {
      if (key in baseline) current[key] = baseline[key];
      else delete current[key];
    }
    this.#writing = true;
    try {
      await writeFile(this.#file, JSON.stringify(current, null, 2) + '\n');
    } catch {
      // Locked for a moment by whoever wrote it: the next change event retries.
    } finally {
      // Our own write fires the watcher too; let it pass before listening again.
      setTimeout(() => {
        this.#writing = false;
      }, DEBOUNCE_MS * 2);
    }
  }
}

async function readSettings(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pick(settings: Record<string, unknown> | null): Snapshot {
  const snapshot: Snapshot = {};
  if (!settings) return snapshot;
  for (const key of GUARDED) if (key in settings) snapshot[key] = settings[key];
  return snapshot;
}

export const userSettingsGuard = new UserSettingsGuard();
