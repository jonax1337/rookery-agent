import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, letting later Tailwind utilities win over earlier ones.
 *
 * This used to re-export the `cn` package, which is exactly this two-line
 * composition; inlining it drops a dependency and lets every `ui/` primitive
 * import from one place (`@/lib/utils`) instead of a bare package name.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
