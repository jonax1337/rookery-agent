# Projektbezogene Skills und MCP-Server

Stand: 2026-09-11. Quick Concept, kein Code. Betrifft `packages/core/src/skills/store.ts`,
`packages/core/src/org/controller.ts`, `packages/core/src/types.ts` (`Project`, `ToolServerConfig`),
`packages/core/src/tools/catalog.ts`, `packages/core/src/providers/claude-code.ts`,
`packages/server/src/schemas.ts` und die Projektseite der Web-UI.

## 1. Zielsetzung

Ein Projekt hat heute zwei Ausstattungen, je nachdem wer darin arbeitet. Sitzt der Nutzer selbst in
einer eigenen Claude-Code-Sitzung im Projektordner, gelten dessen `.claude/skills/` und `.mcp.json`.
Laeuft derselbe Ordner als Rookery-Auftrag, gilt davon nichts. Wer zwischen beiden Arbeitsweisen
wechselt, pflegt zwei Wahrheiten.

1. **Eine Wahrheit pro Projekt** - was im Projektordner liegt, gilt fuer beide Seiten.
2. **Kein Abgleich** - keine Kopie, kein Export, kein Zustand, der auseinanderlaufen kann.
3. **Fremder Code bleibt eingesperrt** - ein geklontes Repo darf nicht dadurch Prozesse starten, dass
   ein Agent hineinschaut.

Nicht-Ziel: Rookery schreibt in ein Repo. Nicht-Ziel: `.claude/settings.json` und damit Hooks und
Rechte aus dem Projekt. Nicht-Ziel: ein projektbezogener Assistent - der Assistent laeuft im
Workspace, nicht im Projekt, und bleibt wie er ist.

## 2. Befund: was heute gilt

Alles hier ist am Code belegt.

1. **Der Projektordner ist bewusst ausgesperrt.** `providers/claude-code.ts:146-150` setzt
   `--setting-sources ''`, dazu `--mcp-config` mit `--strict-mcp-config`. Der Kommentar begruendet
   es mit "Rookery is the whole environment". Codex hat kein Gegenstueck dazu; dort werden die
   MCP-Server ohnehin nur als explizite Argumente uebergeben (`providers/codex.ts:201`).
2. **Eine Sorte Projektdatei kommt trotzdem durch.** Claude Code liest `CLAUDE.md` aus dem
   Arbeitsverzeichnis unabhaengig von den Setting-Sources; `config.ts:94-98` haelt das fest, und
   `WORKSPACE_NOTES` existiert nur deshalb. Die heutige Grenze ist also nicht "nichts aus dem
   Projekt", sondern "Projektregeln ja, Projektwerkzeuge nein" - und dafuer gibt es keinen Grund.
3. **Auftraege laufen bereits im Projektverzeichnis.** `org/controller.ts:768` setzt
   `cwd = project?.path ?? workspace`. Der Agent hat den Ordner also schon vor sich; er darf ihn
   lesen, sobald seine Rechtestufe Lesen erlaubt.
4. **Der Skill-Store kennt genau einen Wurzelordner.** `SkillStore` haelt ein `readonly dir`
   (`skills/store.ts:62-67`), und der Controller haelt genau eine Instanz. `use_skill`
   (`org/controller.ts:343`) loest gegen diese eine Instanz auf, nicht gegen den laufenden Auftrag.
5. **Werkzeuge kennen kein Projekt.** `ToolServerConfig` (`types.ts:880`) hat `enabled` und
   `audience`, sonst nichts. Ein Server ist global an oder aus; ein Notion-Server fuer ein einziges
   Projekt laeuft bei jedem Auftrag mit. `Project` (`types.ts:377`) traegt nur `path`.

## 3. Richtung: der Projektordner ist die Wahrheit

Rookery liest aus dem Projekt, statt in es zu schreiben. Das ist die einzige Richtung, in der
"synchron" nichts kostet: Die eigene Sitzung des Nutzers liest denselben Ordner nativ, es gibt also
gar keine zweite Kopie, die abgeglichen werden muesste.

Damit ergibt sich eine klare Teilung: `<home>/skills` ist projektuebergreifend - was der Assistent
und seine Agenten immer koennen. `<projekt>/.claude/skills/` ist projektbezogen und gilt nur in
Auftraegen, die in diesem Ordner laufen.

## 4. Die zwei Haelften sind unterschiedlich riskant

Das ist der Kern des Entwurfs, und der Grund, warum Skills und MCP nicht gleich behandelt werden.

**Skills sind Prosa und erweitern nichts.** Der Agent hat den Ordner laut Befund 3 ohnehin im `cwd`
und darf `.claude/skills/foo/SKILL.md` selbst oeffnen. Sie zu laden gibt ihm keine Faehigkeit, die er
nicht schon hat - es erspart ihm nur das Suchen. Also ungefragt laden, ohne Vertrauensfrage.

**`.mcp.json` startet Prozesse.** Das ist sehr wohl eine neue Faehigkeit, und sie kommt aus einem
Ordner, den der Nutzer vielleicht nur geklont hat. Also einmal pro Projekt fragen, mit sichtbarer
Liste der Server und ihrer Kommandozeilen, und die Entscheidung am `Project` merken. Bei eigenen
Projekten ist das ein Klick; bei fremden ist es die Frage, die man spaeter nicht bereut.

## 5. Ausbaustufen

1. **Projekt-Skills.** `SkillStore` nimmt statt eines Wurzelordners eine geordnete Liste; bei
   Namensgleichheit gewinnt das Projekt. Der Auftrag baut seinen Index aus `<home>/skills` plus
   `<projekt>/.claude/skills`. Offener Punkt: `use_skill` loest heute gegen die eine
   Controller-Instanz auf (Befund 4) und muss den laufenden Auftrag kennen, sonst findet der Agent
   den Skill in seinem Index, aber nicht ueber das Werkzeug. Traegt den groessten Teil des Nutzens.
2. **Projekt-MCP.** `Project` bekommt ein Feld fuer die getroffene Vertrauensentscheidung
   (Zustimmung plus ein Fingerabdruck der `.mcp.json`, damit eine spaetere Aenderung erneut fragt).
   Die Server aus der Datei kommen zu denen des Hubs dazu.
3. **Projekt-Scoping im Hub.** `ToolServerConfig` lernt, auf welche Projekte ein Server begrenzt
   ist. Groesster Brocken, unabhaengig von 1 und 2 nuetzlich, und die eigentliche Antwort auf
   "dieser Server gehoert nur zu diesem Projekt".

## 6. Verworfen

**`--setting-sources project` statt `''`.** Waere fast kein Code, weil die Plattform es selbst kann.
Dagegen spricht zweierlei: Damit kaeme auch `.claude/settings.json` und darueber Hooks und Rechte aus
dem Repo - genau das Loch, das der Kommentar in `claude-code.ts` zumachen wollte, und bei einem
Agenten mit `full` ein echtes. Und Codex hat kein Gegenstueck, die beiden Provider wuerden
auseinanderlaufen. Rookery rendert Skills laut `skills/store.ts:8-13` ohnehin selbst; der zweite
Wurzelordner ist deshalb der kleinere Eingriff.

**Export aus Rookery ins Projekt.** Rookery schreibt seine Skills als `.claude/skills/` ins Repo.
Das waere echte Synchronisation mit allem, was daran schiefgeht: Git-Rauschen, zwei Staende, die
Frage, wer bei Konflikten gewinnt. Lesen loest dasselbe Problem ohne davon etwas.
