import { SendIcon } from '@/components/icons';

/**
 * The empty states' paper plane: the animated icon at the size `EmptyState`
 * expects. `EmptyState` renders its `icon` without props, so the size is fixed
 * in this shell instead of at the call site.
 */
export function SendEmptyIcon() {
  return <SendIcon size={24} />;
}
