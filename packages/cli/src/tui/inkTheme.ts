/**
 * The Rookery skin for `@inkjs/ui`.
 *
 * The library ships its own palette - blues and magentas that have nothing to
 * do with this terminal. `extendTheme` deep-merges component styles, so this
 * module re-paints the components the TUI borrows (Spinner, Alert,
 * StatusMessage) onto the semantic palette in `theme.ts`, and the app mounts
 * the result in a `ThemeProvider` at its root. Everything a component of ours
 * draws keeps reading its colour from `ui`, so the two sources cannot drift
 * apart.
 */

import { defaultTheme, extendTheme } from '@inkjs/ui';
import { ui } from './theme.js';

/** StatusMessage / Alert variants -> the semantic colour of the same meaning. */
const VARIANT_COLOR: Record<string, string> = {
  success: ui.ok,
  error: ui.danger,
  warning: ui.warn,
  info: ui.info,
};

export const inkUiTheme = extendTheme(defaultTheme, {
  components: {
    Spinner: {
      styles: {
        frame: () => ({ color: ui.amber }),
        label: () => ({ color: ui.ivory }),
      },
    },
    StatusMessage: {
      styles: {
        icon: ({ variant }: { variant?: string }) => ({
          color: (variant && VARIANT_COLOR[variant]) || ui.muted,
        }),
      },
    },
    Alert: {
      styles: {
        container: ({ variant }: { variant?: string }) => ({
          borderColor: (variant && VARIANT_COLOR[variant]) || ui.faint,
        }),
        icon: ({ variant }: { variant?: string }) => ({
          color: (variant && VARIANT_COLOR[variant]) || ui.muted,
        }),
      },
    },
  },
});
