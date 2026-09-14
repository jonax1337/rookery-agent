# Projektbezogene Skills und MCP-Server

Stand: 2026-09-13, Provider-Aussagen nachgezogen am 2026-09-14. Alle drei Ausbaustufen aus
Abschnitt 5 sind umgesetzt:
`packages/core/src/skills/store.ts` (`SkillStore` nimmt eine geordnete Liste von Verzeichnissen),
`packages/core/src/org/project-mcp.ts` (liest `.mcp.json` und bildet den Vertrauensstatus),
`packages/core/src/org/controller.ts` (`#agentSkills`, `use_skill`, `project_mcp_servers`,
`trust_project_mcp`, die Zusammenfuehrung in `run()`), `packages/core/src/org/store.ts` und
`packages/core/src/types.ts` (`Project.mcpTrust`, `ToolServerConfig.projectIds`),
`packages/core/src/memory/db.ts` (Schema 9), `packages/core/src/tools/hub.ts`
(`toolServersFor`/`ensureToolServers`/`dormantToolsHint` kennen jetzt `projectId`), dazu die
Projektseite und die Werkzeug-Detailseite der Web-UI (`ProjectFormPage.tsx`,
`ToolDetailPage.tsx`) und die drei neuen Routen unter `/api/org/projects/:id/mcp*`.

Nachtrag 2026-09-14: Das Dokument entstand, als Rookery zwei CLIs fuhr. Seitdem laeuft jeder
Turn ueber dieselbe `claude`-Binary und die Provider-ID sagt nur noch, wohin dieser Prozess
zeigt; `providers/codex.ts` gibt es nicht mehr. Die Stellen, die sich darauf beriefen, sind
unten korrigiert - das Argument der Abschnitte 4a und 6 wird dadurch staerker, nicht schwaecher.

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
   es mit "Rookery is the whole environment". Das gilt fuer jeden Turn, weil jeder Turn denselben
   Harness startet - welches Backend dahinter antwortet, aendert daran nichts.
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

## 4a. Egal mit welchem Provider - warum das kein Extra-Aufwand ist

Rookery faehrt heute jedes Modell ueber denselben Claude-Code-Harness; ein weiteres Backend kommt
als Provider-Profil dazu, nicht als zweite CLI. Beide Haelften dieses Konzepts sind ohnehin
provider-agnostisch von Natur aus, weil Rookery die Arbeit zentral macht statt sich auf einen
provider-eigenen Mechanismus zu verlassen:

- **Skills** liest kein Provider je selbst. `SkillStore` rendert `SKILL.md`-Prosa in den
  `systemPrompt`-String, den jeder `Provider.run()` sowieso schon entgegennimmt; der Harness
  haengt ihn per `--append-system-prompt` an. Eine Aenderung an `SkillStore` gilt deshalb
  automatisch fuer jeden Provider, ohne eine Zeile provider-spezifischen Code.
- **MCP-Server** laufen bereits heute providerweit ueber `ProviderTurnOptions.mcp` /
  `mcpExtra: McpServerSpec[]` (`types.ts:679`). Der Harness serialisiert das nach `--mcp-config`-JSON
  (`claude-code.ts:mcpConfig`). Ein Provider, der eines Tages nicht mehr ueber diesen Harness
  liefe, braeuchte nur seinen eigenen kleinen Serializer, keinen eigenen Weg, `.mcp.json` zu lesen. `project-mcp.ts` liest die Datei genau einmal, zentral, in `McpServerSpec[]`
  um - `.mcp.json` ist damit Rookerys eine Wahrheit fuer Projekt-MCP, unabhaengig davon, womit
  ein Mensch dieselbe Datei in seiner eigenen Sitzung lesen wuerde.

Die Regel fuer neuen Code an dieser Stelle: was ein Projekt bekommt, entscheidet sich in
`org/controller.ts` bzw. `skills/store.ts`, nie in `providers/<name>.ts`. Ein Provider bekommt nur
noch die schon aufbereitete Form (Prompt-Text, `McpServerSpec[]`) und muss nichts vom Projekt
selbst wissen.

## 5. Ausbaustufen

1. **Projekt-Skills.** ✅ Umgesetzt. `SkillStore` nimmt statt eines Wurzelordners eine geordnete
   Liste (`SkillStore.dirs`); bei Namensgleichheit gewinnt das Projekt. Der Auftrag baut seinen
   Index in `OrgController#agentSkills` aus `<home>/skills` plus `<projekt>/.claude/skills`
   (`skills/store.ts:projectSkillsDir`). Der offene Punkt aus Befund 4 ist geloest: `use_skill`
   kennt jetzt `context.projectId` und loest gegen den laufenden Auftrag auf, nicht mehr gegen die
   eine Controller-Instanz.
2. **Projekt-MCP.** ✅ Umgesetzt. `Project.mcpTrust` (`{ fingerprint, approvedAt }`) haelt die
   getroffene Vertrauensentscheidung; `org/project-mcp.ts` liest `.mcp.json`, bildet den
   Fingerabdruck und den Status (`none | pending | trusted | changed`). Zwei Wege dorthin: die
   Assistenten-Tools `project_mcp_servers` / `trust_project_mcp` im Chat, und auf der Projektseite
   (`ProjectFormPage.tsx`) eine Karte mit Serverliste, Status-Badge und Trust-/Revoke-Knopf, die
   `GET`/`POST`/`DELETE /api/org/projects/:id/mcp*` traegt. Ein Auftrag bekommt die Server aus der
   Datei nur bei Status `trusted`, sonst bleibt es beim Hub allein und der Agent bekommt einen
   Hinweis im Prompt statt eines stillen Lochs.
3. **Projekt-Scoping im Hub.** ✅ Umgesetzt. `ToolServerConfig.projectIds` begrenzt einen Server auf
   bestimmte Projekte; leer bleibt das alte Verhalten (ueberall verfuegbar). `toolServersFor`,
   `ensureToolServers` und `dormantToolsHint` (`tools/hub.ts`) nehmen dafuer ein optionales
   `projectId` an - ein Server, der zu einem anderen Projekt gehoert, taucht weder als angehaengt
   noch als "koenntest du noch anhaengen" auf, er ist fuer dieses Gespraech schlicht nicht da. Die
   Werkzeug-Detailseite (`ToolDetailPage.tsx`) traegt dafuer eine Checkliste der Projekte.

## 6. Verworfen

**`--setting-sources project` statt `''`.** Waere fast kein Code, weil die Plattform es selbst kann.
Dagegen spricht zweierlei: Damit kaeme auch `.claude/settings.json` und darueber Hooks und Rechte aus
dem Repo - genau das Loch, das der Kommentar in `claude-code.ts` zumachen wollte, und bei einem
Agenten mit `full` ein echtes. Und es gaelte fuer jeden Turn zugleich, weil alle denselben Harness
starten. Rookery rendert Skills laut `skills/store.ts:8-13` ohnehin selbst; der zweite
Wurzelordner ist deshalb der kleinere Eingriff.

**Export aus Rookery ins Projekt.** Rookery schreibt seine Skills als `.claude/skills/` ins Repo.
Das waere echte Synchronisation mit allem, was daran schiefgeht: Git-Rauschen, zwei Staende, die
Frage, wer bei Konflikten gewinnt. Lesen loest dasselbe Problem ohne davon etwas.
