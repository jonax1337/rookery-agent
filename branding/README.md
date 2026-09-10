# Rookery: das kleine Logo-Set

Konzept 01, bereinigte Bildmarke und **Manrope 700** als sauber gesetzte Wortmarke. Die beiden Randartefakte der automatischen Vektorisierung sind entfernt. Alle SVGs bestehen aus echten Pfaden; die Wortmarke stammt direkt aus den Schriftkonturen.

| Verwendung | Datei |
|---|---|
| Logo auf hellem Hintergrund | [logo.svg](logo.svg) / [logo.png](logo.png) |
| Logo auf dunklem Hintergrund | [logo-light.svg](logo-light.svg) / [logo-light.png](logo-light.png) |
| Bildmarke allein | [mark.svg](mark.svg) / [mark-light.svg](mark-light.svg) |
| Browser | [favicon.svg](favicon.svg) / [favicon.ico](favicon.ico) |
| Apple Home Screen | [apple-touch-icon.png](apple-touch-icon.png) |
| Farben | [colors.css](colors.css) / [colors.json](colors.json) |
| Übersicht | [preview.png](preview.png) |

**Farben:** Ink `#171A1D`, Ivory `#F2F0EA`, Amber `#D9A65C`. Für lesbaren Akzenttext auf hellem Grund: Amber Text `#80551D`. Auf einer Amber-Fläche Ink als Textfarbe verwenden.

Proportional skalieren, etwas freien Raum rundherum lassen. Das horizontale Logo ab etwa 140 px Breite, die Bildmarke ab 24 px Höhe einsetzen; darunter die vorbereiteten Favicons nutzen. Das ICO enthält 16, 32, 48 und 256 px. PNG-Logos sind 1600 px breit und transparent.

Für die Nutzung der Logo-SVGs muss keine Schrift installiert sein. Die Wortmarke wurde mit [Manrope](https://github.com/google/fonts/tree/main/ofl/manrope), Gewicht 700, gesetzt und anschließend aus den Fontdaten in Pfade umgewandelt.

Das ZIP enthält die sofort nutzbaren Dateien. Im Projekt liegen zusätzlich Quellen, Font mit unveränderter OFL-Lizenz und Generator unter `branding/source/` und `branding/scripts/`. Dort lassen sich die Exporte mit `npm ci --ignore-scripts` und `npm run build` reproduzieren.
