import type { MemoryKind } from '@/lib/types';

/** Everything `PATCH /api/memories/:id` accepts from the memory pages. */
export interface MemoryPatch {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  pinned?: boolean;
  dormant?: boolean;
  forgotten?: boolean;
}

/** One edit together with the sentence the toast says when it went through. */
export interface MemoryChange {
  patch: MemoryPatch;
  message: string;
}

export type ApplyChange = (id: string, change: MemoryChange) => Promise<void>;

export const RESTORE_CHANGE: MemoryChange = { patch: { forgotten: false }, message: 'Restored' };

export function pinChange(pinned: boolean): MemoryChange {
  return { patch: { pinned }, message: pinned ? 'Pinned' : 'Unpinned' };
}

export function sleepChange(dormant: boolean): MemoryChange {
  return { patch: { dormant }, message: dormant ? 'Sleeping' : 'Awake' };
}
