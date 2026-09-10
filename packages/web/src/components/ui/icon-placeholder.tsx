import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, XIcon } from 'lucide-react';
import type { LucideProps } from 'lucide-react';

/**
 * Icon resolver for the shadcn registry components.
 *
 * Registry sources call <IconPlaceholder lucide="CheckIcon" tabler="..." .../>
 * so one file can serve every icon library. Rookery uses lucide, and the
 * icons are imported by name rather than looked up on the library namespace,
 * so the bundle only carries the five that are actually referenced.
 */
const ICONS = {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  XIcon,
} as const;

interface IconPlaceholderProps extends LucideProps {
  lucide: keyof typeof ICONS | (string & {});
  /* Accepted and ignored: the registry passes one name per icon library. */
  tabler?: string;
  hugeicons?: string;
  phosphor?: string;
  remixicon?: string;
}

export function IconPlaceholder({
  lucide,
  tabler: _tabler,
  hugeicons: _hugeicons,
  phosphor: _phosphor,
  remixicon: _remixicon,
  ...props
}: IconPlaceholderProps) {
  const Icon = ICONS[lucide as keyof typeof ICONS] ?? ChevronRightIcon;
  return <Icon {...props} />;
}
