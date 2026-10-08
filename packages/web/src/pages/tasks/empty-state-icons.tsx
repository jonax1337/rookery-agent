import { ClipboardCheckIcon, SendIcon } from '@/components/icons';

/**
 * `EmptyState` renders its `icon` without props, so the size is fixed here
 * instead of at the call site.
 */
export function ClipboardEmptyIcon() {
  return <ClipboardCheckIcon size={24} />;
}

export function SendEmptyIcon() {
  return <SendIcon size={24} />;
}
