# Rookery Agent

Persoenlicher KI-Assistent. Jeder Turn laeuft ueber das lokale `claude`-CLI; welches Modell
antwortet, entscheidet nur, wohin dieser Prozess zeigt (`ANTHROPIC_BASE_URL`). Anthropic
direkt ueber die Claude-Code-Anmeldung, ChatGPT ueber Rookerys eigene Bruecke auf der
`codex login`-Sitzung, weitere Anbieter ueber Provider-Profile mit eigenem Key.
Monorepo mit npm-Workspaces:

```
packages/core     Das Gehirn: Provider-Adapter, Gedaechtnis, Persona, Runtime, die
                  Organisation (org/: Store, Controller, Planner, MCP-Bruecke), die
                  Computer-Steuerung (computer/) und external/ — das Lesen der
                  Claude-Code- und Codex-Installation daneben. Kennt weder HTTP noch
                  Terminal.
packages/server   Fastify: REST + WebSocket + SSE, liefert die gebaute Web-UI aus,
                  dazu die Gateways (gateways/, z. B. Telegram) als weiterer Transport.
packages/cli      Terminal-Interface (Ink-TUI, REPL, OS-Sprachausgabe).
packages/web      React + Vite. Steht auf den shadcn-Blocks dashboard-01 und
                  sidebar-16: src/components/shell/ (Navigation, Kopf, Provider),
                  src/components/blocks/ (Seiten-Templates: StatCards, Kurve,
                  DataTable, Drawer, Formularrahmen), src/components/common/
                  (Leerzustand, Bestaetigung, Status-Badge, Zeilenmenue) und
                  src/pages/, die diese Templates benutzen statt sie nachzubauen.
```

Details, Schnellstart und Turn-Ablauf stehen in `README.md`. Design-Konzepte fuer
Ausbaustufen, die noch nicht oder nur teilweise umgesetzt sind, liegen unter
`docs/concepts/` (z. B. Agent-Leistungsbewertung, Gedaechtnis als Graph) — Konzept,
kein Code; im Zweifel gilt der Code.

## Wichtigste Regel

Der Assistent selbst laeuft immer in `~/.rookery/workspace`, **nie** im Repo, und sieht
nie das Verzeichnis, aus dem Rookery gestartet wurde. Nur Agenten (Auftraege der Firma)
arbeiten in Projektverzeichnissen wie diesem. Werkzeuge fuer den Assistenten kommen
ausschliesslich ueber den Rookery-MCP-Server (`packages/core/src/org/`), nie direkt.

## Build, Dev, Test

| Befehl | Zweck |
|---|---|
| `npm install` | Abhaengigkeiten fuer alle vier Workspaces |
| `npm run build` | alle vier Pakete bauen, in Abhaengigkeitsreihenfolge |
| `npm run build:core` | nur `@rookery/core` bauen |
| `npm run dev` | Server allein, mit Reload |
| `npm run dev:web` | nur der Vite-Dev-Server fuer `packages/web` |
| `npm run dev:all` | Server + Vite-Dev-Server zusammen; **setzt einen gebauten Server voraus** (`npm run build` zuerst) |
| `npm start` | gebauter Server, liefert auch die gebaute Web-UI aus |
| `npm run cli` | `packages/cli/dist/index.js` |
| `npm test` | Node-Test-Runner ueber `packages/core/test/*.test.js` — vor jedem Commit an `packages/core` laufen lassen |
| `npm run typecheck` | `tsc -b` ueber core, server, cli |
| `npm run doctor` | Provider-Diagnose (Anmeldungen und Bruecke), ohne Server |
| `npm run clean` | `scripts/clean.mjs` |

Node.js >= 22.5 ist Pflicht (`node:sqlite`, keine native Abhaengigkeit fuer die
Datenbank).

## Konventionen

- Identifier, Kommentare und Commit-Messages auf Englisch; UI-Strings und Nutzertexte
  auf Englisch.
- UI: Stock assistant-ui + shadcn (radix-vega), echte Seiten statt Modals, moeglichst
  kein Customizing. Eine Seite baut kein Template nach — fehlt etwas, bekommt das
  Template unter `src/components/blocks/` bzw. `/common/` eine rueckwaertskompatible
  Prop. `ButtonGroup` nur fuer Knoepfe **derselben** Variante; gefuellt neben Outline
  verschweisst zu einem Bauteil, dem sichtbar eine Kante fehlt.
- Keine erfundenen Zahlen: jede Kennzahl braucht eine belegte Quelle. Gesamtzahlen
  kommen aus `GET /api/stats`, nicht aus einer Liste, die der Server deckelt; wo nur
  eine gedeckelte Liste da ist, nennt die Karte ihre Basis.
- Keine API-Keys im Code oder in Beispielen. Die beiden eingebauten Provider authentifizieren
  ausschliesslich ueber OAuth-Sitzungen: `claude` ueber die Claude-Code-Anmeldung, `codex` ueber
  die von `codex login` angelegte Sitzung (`providers/codex-auth.ts` erneuert deren Tokens
  selbst). Fuer ChatGPT nie einen API-Key vorschlagen. Ein Key wird nur dort gespeichert, wo
  ein Anbieter keinen anderen Weg anbietet — als Provider-Profil, eingegeben in den
  Einstellungen. Optionale Sprachausgabe ueber OpenAI oder ElevenLabs liest ihren Key nur auf
  dem Server.
- Package-Grenzen respektieren: `packages/core` kennt weder HTTP noch Terminal. HTTP-
  und Terminal-spezifischer Code gehoert in `packages/server` bzw. `packages/cli`.
- `~/.claude` und `~/.codex` gehoeren den beiden CLIs. `packages/core/src/external/`
  liest sie — Skills, aktive Plugins, MCP-Server — und schreibt **nie** hinein. Was
  dort gefunden wird, ist nicht automatisch aktiv: ein Skill-Regal wird pro Quelle
  freigeschaltet (`external.skillSources`), ein MCP-Server einzeln und nur von einem
  Menschen (`external.servers`, `approvalRequired` im Hub). Fremde Skills stehen nie
  im Prompt-Index, sondern hinter `find_skill`; dafuer gibt es zu viele.
- Tests duerfen die Installation des Entwicklers nicht sehen: `packages/core/test/setup.mjs`
  setzt `CLAUDE_CONFIG_DIR`/`CODEX_HOME` auf ein leeres Verzeichnis, ein Test mit
  eigenen Fixtures zeigt sie auf seinen Temp-Ordner.
- Nach Aenderungen an `packages/core` betroffene Tests unter `packages/core/test`
  laufen lassen (`npm test`); bei API-Aenderungen `npm run typecheck` gegen core,
  server und cli.

## Lizenz

MIT, siehe `LICENSE`.
