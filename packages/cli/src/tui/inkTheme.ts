/**
 * The Rookery skin for `@inkjs/ui`.
 *
 * The library ships its own palette - blues and magentas that have nothing to
 * do with this terminal. `extendTheme` deep-merges component styles, so this
 * module re-paints the components the TUI borrows (Spinner, Alert,
 * StatusMessage, and the two pickers the question surface is built from) onto
 * the semantic palette in `theme.ts`, and the app mounts the result in a
 * `ThemeProvider` at its root. Everything a component of ours draws keeps
 * reading its colour from `ui`, so the two sources cannot drift apart.
 *
 * `deepmerge` replaces a style function outright rather than merging it, so a
 * style named here is the whole style - what is not named keeps the library's
 * own, which is why only the colour-bearing ones appear below.
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

/**
 * `Select` and `MultiSelect` in Rookery colours.
 *
 * The row under the cursor takes the accent, the way everything the interface
 * points at does; a picked row is the success green, which is the one meaning
 * `ok` carries
 * everywhere else. The row's own indentation is kept as the library sets it,
 * so the pointer it draws in front of the focused row lands in the gutter
 * instead of shifting the whole list sideways.
 */
const SELECT_THEME = {
  styles: {
    option: ({ isFocused }: { isFocused?: boolean }) => ({
      gap: 1,
      paddingLeft: isFocused ? 0 : 2,
    }),
    focusIndicator: () => ({ color: ui.accent }),
    selectedIndicator: () => ({ color: ui.ok }),
    label: ({ isFocused, isSelected }: { isFocused?: boolean; isSelected?: boolean }) => ({
      color: isFocused ? ui.accentSoft : isSelected ? ui.ok : ui.frost,
    }),
    highlightedText: () => ({ bold: true }),
  },
};

export const inkUiTheme = extendTheme(defaultTheme, {
  components: {
    Spinner: {
      styles: {
        frame: () => ({ color: ui.accent }),
        label: () => ({ color: ui.frost }),
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
    Select: SELECT_THEME,
    // The two pickers draw identical rows, so they get identical paint: a
    // question that happens to allow several answers must not look like a
    // different interface from one that does not.
    MultiSelect: SELECT_THEME,
  },
});
