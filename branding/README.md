# Rookery / Atrium

Atrium, concept 13, is Rookery's main identity. Two offset corners create an open room: a personal place for thinking, memory and work. The production mark preserves the selected concept's exact contours and spacing.

## Colour

| Colour | Hex | Use |
| --- | --- | --- |
| Evergreen | `#253A3B` | Primary logo, light-theme text and actions |
| Eucalyptus | `#6A9185` | Supporting accents and charts |
| Celadon | `#CCDDD1` | Selected surfaces, dark-theme primary actions |
| Frost | `#EFF4F0` | Light background, inverse logo and dark-theme text |
| White | `#FFFFFF` | Light cards and popovers |

The UI derives its surfaces, borders and muted text from this palette. Dark mode uses a deep green background (`#142321`) and elevated surfaces (`#1B2D2A`). Error and warning colours retain their meaning; memory-graph categories remain distinguishable. `colors.json` and `colors.css` are generated from `source/atrium.json`; the web app imports the CSS directly.

## Typography and shape

The wordmark is **rookery**, in Manrope Medium with close, balanced lowercase spacing, exported as vector outlines. The app also uses locally bundled Manrope Variable; Geist Mono remains the code font. No font provider is contacted at runtime. The Manrope OFL licence is included beside the font.

The interface uses 2 px small details, 4 px buttons and fields, 6 px containers, and 8 px cards and chat composers. Badges and chips use capsule shapes. Composer controls follow the standard 4 px button radius. Composer menus share a 4 px corner radius, including the model picker. Radio buttons, switches and status dots retain their functional circular forms. The logo's 45-degree cuts belong to the artwork rather than clipping controls or focus rings.

## Assets

| Use | Files |
| --- | --- |
| Horizontal | `logo.svg`, `logo-light.svg`, transparent `logo.png`, `logo-light.png` |
| Stacked | `logo-stacked.svg`, `logo-stacked-light.svg` |
| Mark | `mark.svg`, `mark-light.svg` |
| Small mark | `mark-small.svg`, `mark-small-light.svg` - the same tested silhouette |
| Monochrome / white | `logo-mono.svg`, `mark-mono.svg`, `logo-white.svg`, `mark-white.svg` |
| Wordmark | `wordmark.svg`, `wordmark-light.svg` |
| App icons | `app-icon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` |
| Browser | `favicon.svg`, `favicon.ico`, `favicon-16.png`, `favicon-32.png`, `favicon-48.png` |
| Overview | `preview.png`, `colors.css`, `colors.json` |

Use the regular logo on light surfaces and the Frost inverse on dark surfaces. Monochrome SVGs inherit `currentColor` when embedded inline. Keep proportions and openings intact, with at least a quarter of the mark canvas width as clear space. Use the horizontal logo at 160 px or wider. Marks are checked at 16, 24, 32 and 48 px. Avoid gradients, shadows, outlines or repositioned corners.

## Build and verification

`source/atrium.json` contains the geometry, outlined wordmark and palette. `source/atrium-approved.svg` preserves the selected mark for regression checks. `source/Manrope-Variable.ttf` and `source/Manrope-OFL.txt` supply the interface font.

The repository tracks the current brand source, generated assets and verification scripts. Local design explorations (`concepts/`), superseded artwork (`archive/`) and ZIP handoffs are kept outside version control.

From `branding/`, run `npm ci --ignore-scripts`, `npm run build`, then `npm test`. The build copies logos, icons, the manifest and the local font to `packages/web/public/`. Run `npm run build -w @rookery/web` from the repository root to update the served UI.

Checks cover vector rendering, exact agreement with the approved Atrium silhouette at multiple sizes, unclipped edges, matching public copies, platform icons, the bundled font and accessible text/control contrast in both themes.
