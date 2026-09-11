<p align="center">
  <img src="branding/logo-light.svg" alt="Rookery" width="260">
</p>

<p align="center">
  <b>Ein persönlicher KI-Assistent, der deine bestehenden Claude-Code- und Codex-Anmeldungen nutzt.</b><br>
  Keine API-Keys. Keine Cloud-Konten. Alles läuft lokal.
</p>

---

## Was das ist

Rookery ist eine Assistenz-Schicht über den CLIs, bei denen du ohnehin schon
angemeldet bist. Statt einen API-Key zu verlangen, startet Rookery
`claude -p` bzw. `codex exec` als Unterprozess und übernimmt deren
OAuth-Sitzung. Wenn `claude` und `codex` in deinem Terminal funktionieren,
funktioniert auch Rookery — dieselbe Abrechnung, dasselbe Abo, kein zusätzliches
Geheimnis auf der Platte.

Dazu kommt das, was die reinen CLIs nicht haben:

- **Dauerhaftes Gedächtnis** über alle Gespräche hinweg, mit Bewertung und Begründung
- **Ein fester Ansprechpartner** — eine Identität, die nie wechselt
- **Drei Oberflächen** auf einem gemeinsamen Kern: CLI, Web-Interface, Sprache
- **Sprachbetrieb** mit Aktivierungswort, Live-Pegel-Visualisierung und Vorlesen

## Schnellstart

```bash
npm install
npm run build
npm start          # API auf http://127.0.0.1:4317, liefert auch die Web-UI aus
```

Web-Interface unter <http://127.0.0.1:4317> öffnen — oder im Terminal bleiben.
Die Seitenleiste führt zu Chat, **Dashboard**, Firma (`/org`), Aufgaben,
Aufträge, Zeitpläne, **Gedächtnis** (Graph, Zeitachse, Liste), Werkzeuge,
Skills, Einstellungen und Sprechen.

```bash
node packages/cli/dist/index.js          # interaktives Terminal
node packages/cli/dist/index.js doctor   # prüft beide Anbieter
```

`packages/cli/package.json` deklariert die Kurzbefehle `rookery` und `rk`;
`npm install` verlinkt beide nach `node_modules/.bin/`. Damit laufen alle
`rookery …`-Beispiele in dieser README als `npx rookery …` bzw. `npm run cli --`.
Für den blanken Befehl `npm link -w @rookery/cli` einmalig ausführen.

Das Terminal ist eine Vollbild-Oberfläche: Verlauf mit gerenderten Code-Blöcken,
Live-Streaming, Statuszeile mit Name, Anbieter und Berechtigung, ein gerahmtes
Eingabefeld mit Verlauf über die Pfeiltasten, und eine Slash-Palette, die sich
beim Tippen von `/` öffnet. `/help` listet alle Befehle; dazu gehören u. a.
`/usage` (Abo-Kontingent), `/inbox`, `/permission`, `/project`, `/doctor`,
`/memory`, `/remember`, `/effort` und `/talk`. **Ctrl+C** bricht den laufenden
Turn ab und kehrt zur Eingabe zurück; am leeren Prompt beendet es die Sitzung.

Läuft die CLI nicht in einem echten Terminal — in einer Pipe, in CI, mit
`TERM=dumb` oder `ROOKERY_TUI=0` — schaltet sie automatisch auf den
zeilenbasierten Modus um. Mit `--plain` lässt sich das erzwingen.

Für die Entwicklung mit Hot Reload:

```bash
npm run build      # dev:all setzt einen gebauten Server voraus (packages/server/dist/main.js)
npm run dev:all    # Server + Vite-Dev-Server, UI auf http://localhost:5317
```

### Entwicklung

| Skript | Zweck |
|---|---|
| `npm run build` | alle vier Pakete bauen, in Abhängigkeitsreihenfolge |
| `npm run build:core` | nur `@rookery/core` bauen |
| `npm run dev` | Server allein, mit Reload |
| `npm run dev:web` | nur der Vite-Dev-Server für `packages/web` |
| `npm run dev:all` | Server + Vite-Dev-Server zusammen (`scripts/dev.mjs`) |
| `npm start` | gebauter Server, liefert auch die gebaute Web-UI aus |
| `npm run cli` | `packages/cli/dist/index.js` |
| `npm test` | Node-Test-Runner über `packages/core/test/*.test.js` |
| `npm run typecheck` | `tsc -b` über core, server, cli |
| `npm run doctor` | Anbieter-Diagnose, ohne den Server zu starten |
| `npm run clean` | `scripts/clean.mjs` |

### Voraussetzungen

| | |
|---|---|
| Node.js | 22.5 oder neuer (`node:sqlite` wird benötigt) |
| Claude Code | installiert und angemeldet — `claude`, dann `/login` |
| Codex CLI | installiert und angemeldet — `codex login` |

Mindestens einer der beiden reicht. `rookery doctor` sagt dir genau, was fehlt.

## Architektur

```
packages/core     Das Gehirn: Provider-Adapter, Gedächtnis, Persona, Runtime,
                  die Organisation (org/: Store, Controller, Planner, MCP-Bridge)
                  und die Computer-Steuerung (computer/). Kennt weder HTTP noch Terminal.
packages/server   Fastify: REST + WebSocket + SSE, liefert die gebaute Web-UI aus.
packages/cli      Das Terminal-Interface mit REPL und OS-Sprachausgabe.
packages/web      React + Vite. Der Assistenten-Bildschirm mit Orb und Sprachsteuerung.
```

Ein Turn durchläuft immer dieselben Schritte:

```
Eingabe → Recall (was weiß ich schon?) → Kontext bauen (inkl. Organigramm, Posteingang)
        → Provider-CLI streamen, dabei Aufträge an Agenten
        → (hat er ein Werkzeug dazugeschaltet: zweiter Durchgang mit diesem Werkzeug)
        → speichern → lernen
```

Der Lernschritt läuft **nach** der Antwort und blockiert dich nie.

Der zweite Durchgang ist die Ausnahme, nicht die Regel: Ein MCP-Server kann nur an
einen Prozess gehängt werden, der noch nicht läuft. Legt der Assistent mitten im Turn
einen Schalter um, weil ihm für die Aufgabe ein Werkzeug fehlt, würde die Arbeit sonst
liegen bleiben, bis du nochmal fragst. Stattdessen läuft der Turn ein zweites Mal an,
mit der Sitzung des Anbieters fortgesetzt und dem neuen Server dran; die beiden
Antworten werden zu einer. Mehr als zwei Durchgänge gibt es nie.

## Ohne API-Keys — wie genau

Beide Adapter starten die echte CLI und lesen deren JSON-Stream:

```bash
claude -p --output-format stream-json --verbose --include-partial-messages
codex exec [resume <id>] --json --skip-git-repo-check --color never -s <sandbox>
```

Rookery liest oder setzt weder `ANTHROPIC_API_KEY` noch `OPENAI_API_KEY` und
übergibt `--bare` bewusst **nicht** — dieses Flag würde Claude Code zur
API-Key-Authentifizierung zwingen statt die OAuth-Sitzung zu verwenden.
Sitzungen werden über die native Sitzungs-ID der jeweiligen CLI fortgesetzt
(`--resume` bzw. `codex exec resume`), sodass der Anbieter seinen eigenen
Kontext behält.

## Gedächtnis

Das ist der Teil, der Rookery von einem CLI-Wrapper unterscheidet.

**Gespeichert** wird in sechs Arten: `fact`, `preference`, `project`, `event`,
`summary` und `insight` — letztere entsteht ausschließlich im Schlaf. Nach
jedem Turn liest ein kleines Modell den Austausch und schlägt dauerhafte
Erinnerungen vor. Davor liegt ein **Tor** (`memory/gate.ts`): höchstens drei
Kandidaten pro Turn, nichts unter Wichtigkeit 0,4 ohne bekannte Entität, und
ein Fast-Duplikat verstärkt die vorhandene Erinnerung, statt eine zweite
anzulegen. Die Ähnlichkeit ist der Dice-Koeffizient über normalisierte
Token-Mengen; dieselbe Aussage anders formuliert erzeugt also keinen zweiten
Datensatz. Was das Modell als „bereits bekannt" sieht, sind die zum Turn
**passenden** Erinnerungen, nicht die insgesamt wichtigsten — das war der
Hauptgrund, aus dem die Datenbank früher immer weiter wuchs.

**Abgerufen** wird über eine Mischung aus vier Signalen, nicht nur Textsuche:

| Signal | Gewicht | Warum |
|---|---|---|
| BM25-Relevanz (SQLite FTS5) | 0,55 | Worüber wird gerade gesprochen |
| Wichtigkeit | 0,20 | Harte Rahmenbedingungen schlagen Nebensächliches |
| Aktualität (Halbwertszeit 30 Tage) | 0,15 | Neueres beschreibt dich meist besser |
| Nutzung (log-skaliert) | 0,10 | Was sich bewährt hat, bleibt oben |

Dazu kommt ein flacher **Tag-Treffer-Bonus** von +0,1, wenn ein Wort der
aktuellen Frage einem Tag der Erinnerung entspricht, sowie ein **Kernprofil**:
angeheftete Erinnerungen, Einsichten und bis zu fünf mit Wichtigkeit ≥ 0,7
liegen unabhängig von der Frage in jedem Turn.

Danach folgt ein **zweiter Sprung** über den Graphen. Aus den drei besten
Treffern werden Erinnerungen nachgezogen, die eine Entität mit ihnen teilen
(0,45 des Scores, gedämpft nach Häufigkeit der Entität) oder über eine
`refines`- bzw. `caused_by`-Kante an ihnen hängen (0,6). Das schließt die
Lücke, die reine Textsuche nicht schließen kann: die Frage nach einer
Kategorie („welche Sprache bevorzugst du?") trifft kein Wort der Erinnerung an
die Instanz („arbeitet mit TypeScript"), aber beide hängen an der Entität
`typescript`. Von einem Widerspruchspaar geht nur der neuere Satz in den
Prompt; der ältere bleibt sichtbar.

Jede abgerufene Erinnerung trägt eine lesbare, englische Begründung —
`strong text match`, `text match`, `high importance`, `recent`, `tag hit`
oder als Rückfall `weak match` —, die im Gedächtnis-Panel und in `rookery
memory search` sichtbar ist. Nichts passiert unsichtbar.

Gespeichert wird in `~/.rookery/rookery.db` — SQLite über das eingebaute
`node:sqlite`, also **ohne nativen Build-Schritt**. Vergessen ist ein
Soft-Delete: die Erinnerung verschwindet aus dem Recall, bleibt aber prüfbar,
bis du `--hard` verwendest.

```bash
rookery memory list
rookery memory add "Ich bevorzuge knappe Antworten." --kind preference --importance 0.9
rookery memory search deployment
rookery memory forget <id> [--hard]
rookery memory stats
```

### Der Graph

Erinnerungen stehen nicht mehr allein. Jede hängt an **Entitäten** (Person,
Projekt, Werkzeug, Ort, Organisation, Thema), und zwischen Erinnerungen gibt
es gerichtete **Kanten**: `refines`, `supersedes`, `contradicts`, `caused_by`,
`co_occurs`. Die Entitäten entstehen kostenlos aus den Tags, die die
Extraktion ohnehin liefert; die Kanten zieht der Schlaflauf.

Bewusst **ohne Embeddings**: die Provider-CLIs liefern Text, kein
Embedding-Modell, und ein lokales wäre genau der native Build-Schritt, den
`node:sqlite` vermeidet. Nähe kommt aus geteilten Entitäten, Duplikate aus
lexikalischer Ähnlichkeit, Bedeutung aus nachts gezogenen Kanten.

Die Web-UI zeigt das Gedächtnis unter **Gedächtnis** in drei Ansichten: das
**Netz** als Kraftgraph **im Raum** (Entitäten als beschriftete Knotenpunkte,
Erinnerungen als farbige Körper darum, Ziehen dreht, Rad zoomt), die
**Zeitachse** (was wann gelernt wurde, mit den Nächten dazwischen) und die
**Liste**. Ein Klick auf einen Knoten öffnet die Erinnerung mit ihren Themen,
ihren Verbindungen und den Aktionen Anheften, Aufwecken, Vergessen.

Der Graph nutzt `3d-force-graph` über WebGL und wird erst beim Öffnen des
Reiters geladen, liegt also in einem eigenen Bündel und kostet den Rest der
Anwendung nichts.

### Schlaf

Nachts um 03:30 räumt das Gedächtnis auf — als ganz normaler Zeitplan
(`cron_jobs.kind = 'sleep'`), also sichtbar, abschaltbar und von Hand
auslösbar wie jeder andere.

Eine Nacht ist keine gleichförmige Liste von Schritten, sondern läuft in
**Zyklen aus drei Phasen**, so wie Schlaf tatsächlich abläuft:

| Phase | Was passiert | Modellaufrufe |
|---|---|---|
| **Leichtschlaf** | Buchhaltung: `stärke = 0,5·Wichtigkeit + 0,3·Nutzen + 0,2·Aktualität`; zu schwach und lange ungenutzt wird weggeräumt. Entitätszählung frisch. | 0 |
| **Tiefschlaf** | Ablage: Bündel werden zu einem Satz, und Widersprüche werden **entschieden** — eine Seite gilt, die andere wird weggeräumt. | ≤ 12 + ≤ 5 |
| **Traumschlaf** | Das Assoziative: Verbindungen über Themen hinweg, und am Ende der Nacht die Einsichten. | ≤ 3 + 1 |

Die Phasen füttern einander, deshalb wiederholt sich der Zyklus (Standard
zweimal): der Traumschlaf findet die Widersprüche, die der nächste Tiefschlaf
entscheidet, und der Tiefschlaf hinterlässt ein aufgeräumteres Gedächtnis für
den nächsten Traumschlaf. Das Aufrufbudget ist für den Tiefschlaf nach vorn
und für den Traumschlaf nach hinten gewichtet.

Vier Regeln machen einen unbeaufsichtigten Nachtlauf zumutbar:

- **Nie gelöscht.** Erinnerungen werden weggeräumt (`dormant_at`): raus aus
  dem Recall, weiter in der Datenbank, weiter sichtbar, ein Klick zurück.
  Das gilt auch für die Verliererseite eines entschiedenen Widerspruchs.
- **Jede Nacht umkehrbar.** Alles, was ein Lauf schreibt, trägt seine
  `run_id`; „Rückgängig" ist eine Transaktion.
- **Was du geschrieben hast, ist unantastbar.** `origin = 'user'` und
  angeheftete Erinnerungen werden weder verdichtet noch weggeräumt. Im
  Widerspruch gewinnen sie **ohne** Modellaufruf: was du selbst gesagt hast,
  schlägt alles, was aus einem Gespräch abgeleitet wurde.
- **Nur ein Widerspruch unter zwei geschützten Sätzen bleibt offen.** Den
  entscheidest du, und der Bericht sagt es.

Das Modell dafür ist standardmäßig **Sonnet**, nicht das billigste: sechzehn
Aufrufe einmal pro Nacht sind günstig, ein falsch verschmolzenes Paar nicht.
Beides ist konfigurierbar (`memory.sleep.model`, `memory.sleep.insightModel`).

Das ausführliche Konzept steht in
[`docs/concepts/memory-graph-and-sleep.md`](docs/concepts/memory-graph-and-sleep.md).

## Ein Ansprechpartner

Rookery ist **ein** persönlicher Assistent, kein Umschaltpult. Es gibt genau
eine Identität — den Namen aus `assistantName` — und nichts kann sie
wechseln: kein Dropdown, kein `/agent`, keine `@rolle`, kein Routing nach
Stichworten. Wer dir antwortet, ist in jedem Turn dieselbe Instanz.

Das ist nicht nur eine Frage des Tons. Ein Rollenwechsel konnte früher auch
den Anbieter wechseln, und damit ging die `providerSessionId` verloren — der
Gesprächsfaden der laufenden CLI-Sitzung riss mitten im Gespräch ab. Der
Anbieter wechselt jetzt nur noch, wenn du es verlangst oder der aktuelle
abgemeldet ist.

Der Assistent läuft in einem eigenen Arbeitsraum, `~/.rookery/workspace`, mit
einer eigenen `CLAUDE.md`. Er sieht nie das Verzeichnis, aus dem du Rookery
gestartet hast. Für Projekte hat er Personal.

## Die Firma: Agenten, Teams, Projekte

Hinter dem Assistenten steht eine dauerhafte Organisation, die er selbst
führt. Du legst sie an — im Web unter **Firma**, per `rookery org` oder indem
du den Assistenten bittest, jemanden einzustellen:

| Begriff | Bedeutung |
|---|---|
| **Agent** | Fest angestellt: Name, Titel, Anweisungen, Anbieter, Modell, Berechtigung, Team, Vorgesetzter. Hat ein eigenes Gedächtnis. |
| **Team** | Gruppe von Agenten mit Zweck und optionaler Leitung. |
| **Projekt** | Vorhaben mit optionalem Verzeichnis. Aufträge dafür laufen in diesem Verzeichnis. |
| **Auftrag** | Ein Lauf eines Agenten: eigener CLI-Prozess, kalt gestartet, mit Anweisung, Ergebnis, Status und Dauer. |
| **Aufgabe** | Ein Eintrag auf dem Board: größeres Vorhaben, das geplant und dann als ein oder mehrere Aufträge ausgeführt wird. |
| **Nachricht** | Kurznachricht zwischen Agent, Vorgesetztem und Assistent, landet im Posteingang. |

"Dauerhaft" heißt: der Agent ist ein Datensatz mit Rolle und Gedächtnis, keine
laufende Sitzung. Jeder Auftrag startet einen frischen `claude -p`- bzw.
`codex exec`-Prozess. Nach dem Auftrag lernt der Agent aus seinem Bericht
dazu — in seinem eigenen Gedächtnis, getrennt von dem des Assistenten.

Die Hierarchie ist echt: Agenten ohne Vorgesetzten berichten an den
Assistenten. Ein Agent darf nur an seine direkten Mitarbeiter delegieren und
nur nach oben, ins Team oder an den Assistenten schreiben. Delegationstiefe
und gleichzeitige Prozesse sind begrenzt (`org.maxDelegationDepth`,
`org.maxConcurrentAssignments`).

```bash
rookery org                                   # Organigramm
rookery org hire --name Mara --title "Backend Engineer" --instructions "…"
rookery org projects add Rookery --path E:/DEV/rookery-agent
rookery assign mara "Beschreibe die Server-Routen"   # Auftrag direkt geben
rookery org assignments                       # was lief, wie lange, mit welchem Ergebnis
rookery --agent mara                          # direkt mit Mara chatten
```

Weitere Unterbefehle: `rookery org agents|teams|projects|messages|assignment
<id>`, `rookery sessions` / `rookery session <id>|rm`, `rookery config
get|set|path`, `rookery serve --port --host --open`. `rookery --help` bzw.
`<befehl> --help` listet alles.

### Direkt-Chat mit jedem Agenten

Die Firma hat einen internen Chat. Im Web steht links eine Kontaktliste: der
Assistent und jeder Agent, jeder mit eigenen Gesprächen. Schreibst du einen
Agenten direkt an, antwortet er in eigener Stimme, mit seinem Gedächtnis,
seinem Anbieter und Modell, und kann seinen eigenen Mitarbeitern Arbeit geben.
Der Assistent bleibt der Chef, aber er ist nicht mehr der einzige, mit dem du
reden kannst. In der CLI: `rookery --agent <slug>` oder `/talk <slug>`.

### Das Aufgabenboard

Größere Arbeit landet als **Aufgabe** auf dem Board, von dir (Seite Aufgaben,
`rookery tasks add`) oder vom Assistenten (`create_task`). Dann entscheidet
**Planen**: ein kleines Modell liest das Organigramm mit Titeln und Anweisungen
aller Agenten und schlägt vor, ob ein Agent die Aufgabe übernimmt oder ob sie in
Teilaufgaben für mehrere Agenten zerfällt, samt Abhängigkeiten. Die Teilaufgaben
liegen dann sichtbar auf dem Board und lassen sich noch umverteilen. **Ausführen**
startet die Aufträge: unabhängige Teilaufgaben parallel, abhängige danach mit den
Ergebnissen ihrer Vorgänger. Der Assistent macht dasselbe mit `plan_task` und
`run_task`, wenn er eine Bitte als größeres Vorhaben erkennt.

```bash
rookery tasks add "Release vorbereiten" --description "…" --project Rookery
rookery tasks plan <id>        # Vorschlag: ein Agent oder Aufteilung
rookery tasks run <id>         # ausführen, live mitverfolgen
rookery tasks                  # das Board
rookery tasks show <id>        # Details
rookery tasks done <id>        # manuell abschliessen
rookery tasks cancel <id>      # laufende Ausführung abbrechen
```

### Zeitpläne (Cron-Jobs)

Manches soll ohne Anstoß passieren: ein Morgenbriefing um acht, ein
Nachtlauf über die Builds, eine Erinnerung morgen um drei. Dafür gibt es
**Zeitpläne**: eine Anweisung plus ein Cron-Ausdruck mit fünf Feldern
(Minute, Stunde, Tag, Monat, Wochentag) in der lokalen Zeit des Rechners.
`0 8 * * 1-5` ist werktags um 08:00, `*/30 * * * *` alle dreißig Minuten,
`@daily` Mitternacht. Ein Zeitplan läuft, solange der Server läuft.

Wer ausführt, entscheidet der Zeitplan: **der Assistent selbst**, als eigener
Turn in einem Gespräch, das zum Zeitplan gehört und zwischen den Läufen
erhalten bleibt (mit all seinen Werkzeugen, also auch Delegation), oder **ein
Agent** als gewöhnlicher Auftrag im Projektverzeichnis. Jeder Lauf wird mit
Ergebnis, Fehler und Dauer festgehalten und als Nachricht in den Posteingang
des Assistenten gelegt, damit er im nächsten Gespräch weiß, was nachts
passiert ist. `once` macht aus einem Plan eine einmalige Erinnerung: nach dem
ersten Lauf schaltet er sich ab.

Angelegt wird ein Zeitplan auf der Seite **Zeitpläne** (mit Vorschau der
nächsten Läufe), per `POST /api/cron`, oder im Chat: „Jeden Morgen um 8 fass
mir zusammen, was ansteht.“ Der Assistent übersetzt das mit
`create_schedule` selbst in einen Cron-Ausdruck; `list_schedules`,
`update_schedule`, `delete_schedule` und `run_schedule` sind seine übrigen
Griffe daran. Ein Lauf, den der Server verpasst hat, weil er nicht lief, wird
nur nachgeholt, wenn er höchstens zehn Minuten zurückliegt; ältere werden
übersprungen. Läuft ein Zeitplan noch, wenn er erneut fällig wäre, startet er
nicht doppelt.

## Wie der Assistent delegiert

Der Assistent entscheidet selbst, wann er Arbeit abgibt. Jeder Provider-Prozess
bekommt Rookerys Werkzeuge über einen MCP-Server namens `rookery`
(`--mcp-config` bei Claude, `mcp_servers.*` bei Codex): `org_overview`,
`assign`, `assignment_status`, `list_assignments`, `cancel_assignment`,
`send_message`, `read_inbox`, das Aufgabenboard (`create_task`, `list_tasks`,
`update_task`, `plan_task`, `run_task`), die Firma (`hire_agent`, `update_agent`,
`create_team`, `update_team`, `create_project`, `update_project`), sein
Gedächtnis (`remember`, `forget`, `search_memory`), die Einstellungen
(`get_settings`, `update_settings`), den Werkzeug-Hub (`tool_servers`,
`set_tool_server`), die Skills (`use_skill`) und die Zeitpläne
(`create_schedule`, `list_schedules`, `update_schedule`, `delete_schedule`,
`run_schedule`). Der Assistent hat damit dieselbe Kontrolle
wie die Web-UI: er bricht festgefahrene Aufträge und laufende Aufgaben ab, liest
die Auftragshistorie, archiviert Projekte, pflegt Erinnerungen von Hand und
ändert Standard-Anbieter, Modell, Effort und die Firmenlimits. Agenten bekommen
die Mitarbeiter-Variante: delegieren, Nachrichten, Board, kein Einstellen, kein
Abbrechen, keine Einstellungen.

Der MCP-Server ist ein dünner stdio-Prozess (`packages/core/dist/org/mcp-bridge.js`), der
jeden Aufruf über eine lokale Pipe an den laufenden Rookery-Prozess reicht.
Ruft der Assistent mehrere `assign` in einer Nachricht auf, laufen die
Aufträge **gleichzeitig als eigene CLI-Prozesse**. Ihre Ereignisse werden in
den Ereignisstrom des laufenden Turns gemischt: im Web und in der CLI siehst
du live, wer gerade woran arbeitet, mit Zeichenzahl, Laufzeit und Vorschau.
Zusätzlich erreicht jede Auftragsänderung alle offenen Verbindungen, damit die
Seite **Aufträge** immer aktuell ist.

Erreichbar ist das auch direkt: `POST /api/org/assignments` (SSE) und ein
`{type:'assign'}`-WebSocket-Frame geben einem Agenten einen Auftrag, ohne den
Assistenten zu bemühen.

## Werkzeuge und Skills

Unter **Werkzeuge** (`/tools`, `rookery tools`) liegt der MCP-Hub: ein Katalog
von Servern, die der Assistent und seine Agenten in jedem Turn dazubekommen,
im Chat, in der CLI und im Sprachmodus gleich, weil alle drei durch dieselbe
`Assistant.chat` laufen. Pro Server: ein Schalter, für wen er gilt (Assistent,
Agenten, beide), seine Optionen und seine Schlüssel. Der Assistent bekommt pro
aktivem Server einen Absatz im Systemprompt, der ihm sagt, wofür die Werkzeuge
gut sind. Er darf Schalter selbst umlegen (`tool_servers`, `set_tool_server`),
aber nichts installieren und keine Schlüssel eintragen. Legt er selbst einen Schalter
um, gilt er sofort: der Turn läuft mit dem neuen Server ein zweites Mal an und die
Arbeit geht weiter. Ausserdem steht im Systemprompt, welche Server er noch dazuschalten
könnte und welche erst du auf der Werkzeuge-Seite freischalten musst — ein Schalter, von
dem er nichts weiss, ist für ihn eine Wand.

| Server | Was | Installation |
|---|---|---|
| **Computer-Steuerung** | Bildschirm sehen, Maus und Tastatur, Bedienelemente über den Windows-Accessibility-Baum lesen und per Namen klicken. Befugnis staffelbar von „sehen und bedienen“ bis „alles“. Audit-Log unter `~/.rookery/run/computer-audit.jsonl`. | mitgeliefert: [`@zavora-ai/computer-use-mcp`](https://github.com/zavora-ai/computer-use-mcp) als Abhängigkeit von `@rookery/core`; Fallback ist Rookerys PowerShell-Server `packages/core/dist/computer/mcp-server.js` |
| **Browser (Playwright)** | Ein echter Browser über den Accessibility-Baum der Seite: navigieren, lesen, Formulare, Klicks. Standard: Rookery startet Edge oder Chrome einmal mit eigenem Profil (`~/.rookery/browser-profile`, Debug-Port 9333), jeder Turn hängt sich per CDP daran, Tabs und Logins bleiben zwischen den Turns erhalten. Wahlweise frisch pro Turn, auch headless; Chromium per Vorbereitungsknopf. | mitgeliefert: [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) als Abhängigkeit von `@rookery/core` |
| **Dateisystem** | Lesen, schreiben, suchen in freigegebenen Verzeichnissen. | auf Abruf |
| **Context7** | Aktuelle Bibliotheks-Dokumentation nachschlagen. | auf Abruf |
| **GitHub** | Repositories, Issues, Pull Requests; braucht einen Personal Access Token. | auf Abruf |
| **Eigene** | Jeder stdio-MCP-Server: Befehl, Argumente, Hinweis für den Assistenten, Umgebungsvariablen. | eigene Sache |

Wer das Repo klont, bekommt Computer-Steuerung und Browser mit `npm install`
fertig mit, inklusive der nativen Binaries im Paket. Server „auf Abruf“ holt
`npx` beim ersten Start. Konfiguriert wird alles in `tools.servers` der Config.
Werkzeugaufrufe erscheinen im Web-Chat nicht, es sei denn, der Schalter
„Werkzeugaufrufe im Chat anzeigen“ unter Einstellungen ist an (gilt nur für
diesen Browser).

Stopp in allen Oberflächen: der Stopp-Knopf im Chat, Esc in der CLI, ein Tipp
auf den Orb im Sprachmodus. Das bricht den Turn samt Prozess ab. Der
Systemprompt hält den Assistenten dazu an, vor Unumkehrbarem (Löschen, Senden,
Bezahlen, ungespeichert schließen) eine Frage zu stellen.

**Skills** (`/skills`, `rookery skills`) sind geschriebene Anleitungen für
bestimmte Arten von Aufgaben: ein Ordner pro Skill unter `~/.rookery/skills`
mit einer `SKILL.md` (Frontmatter `name`, `description`, `audience`) und
beliebigen Dateien daneben. Rookery rendert sie selbst, unabhängig vom
Anbieter: der Systemprompt trägt die Liste mit Beschreibungen, `use_skill`
liefert die Anleitung samt Dateiliste. Der Assistent und die Agenten öffnen
den passenden Skill, bevor sie mit so einer Aufgabe anfangen. Anlegen und
bearbeiten geht auf der Seite Skills oder direkt im Ordner. Weil das Format
der offene Agent-Skills-Standard ist, lässt sich jeder Skill von GitHub
**importieren** (`/skills/import`): `owner/repo/pfad` oder die URL, etwa aus
[Anthropics Sammlung](https://github.com/anthropics/skills) (PDF, Word, Excel,
PowerPoint, Frontend-Design und mehr, als Regal vorausgewählt) oder aus dem
[skills.sh](https://skills.sh)-Verzeichnis, dessen Einträge GitHub-Repos sind.
Skills mit Skripten brauchen eine Shell und laufen damit nur in Aufträgen an
Agenten mit Berechtigung `full`; der Assistent selbst führt keine Skripte aus.

## Sprache

- **Sprechen** (`/voice`, Eintrag in der Seitenleiste): ein Vollbild mit nichts
  als dem Orb. Einmal tippen, dann einfach reden. Jede fertige Äußerung wird ein Turn,
  die Antwort wird Satz für Satz vorgelesen, während sie noch streamt, und das
  Mikrofon geht wieder auf, sobald die Stimme schweigt. Tippen auf den Orb oder
  Leertaste unterbricht, `M` schaltet das Mikrofon, Esc beendet. Die
  Steuerleiste blendet sich aus, sobald die Maus ruht, und kommt bei jeder
  Bewegung zurück. Das Aktivierungswort ist dort optional zuschaltbar.
  Gesprochen wird ab dem ersten Halbsatz der Antwort, nicht erst am Ende.
  Der Sprachmodus hat sein **eigenes Gespräch** mit dem Assistenten: eine
  Session der Art `voice` (Titel „Sprachgespräch · Datum“), die in der
  Seitenleiste im eingeklappten Ordner **Sprachgespräche** liegt statt in der
  Chatliste, und in der der Assistent immer im Sprech-Register antwortet, auch
  wenn man sie später im Chat öffnet. `GET /api/sessions?kind=voice|chat`
  filtert danach, getrennt von den Text-Chats und nie mit
  einem Agenten; der Reset-Knopf in der Leiste beginnt ein neues. Gesprochene
  Turns laufen mit Effort `low`, solange keine Stufe gepinnt ist. Mit
  **Reinreden** bleibt das Mikrofon offen, während die Stimme spricht: ein
  Zwischenruf bricht die Antwort ab, das eigene Echo wird erkannt und ignoriert.
  Delegiert der Assistent in einem gesprochenen Turn, nutzt er `assign` mit
  `wait=false`: der Auftrag läuft im Hintergrund weiter, der Turn endet sofort,
  und die Sprachseite sagt an, wenn ein Agent fertig ist. Fällt die
  Server-Stimme aus, springt die Browser-Stimme nur für die laufende Antwort
  ein; die nächste versucht es wieder. Ein älteres Sprachgespräch lässt sich
  aus dem Chat heraus mit „Im Sprachmodus fortsetzen“ wieder aufnehmen
  (`/voice?session=<id>`).
- **Der Orb** ist ein WebGL-Shader ohne Abhängigkeiten und zeigt echten
  Zustand: Mikrofonpegel beim Zuhören, rotierende Bögen beim Denken, Wellen im
  Takt der Stimme beim Sprechen.
- **Stimme**: Standard ist **Microsoft Edge Neural** über den Server
  (`msedge-tts`, kostenlos, kein Key; voreingestellt ist
  `de-DE-FlorianMultilingualNeural`). Optional **ElevenLabs**
  (`ELEVENLABS_API_KEY`) oder **OpenAI gpt-4o-mini-tts** (`OPENAI_API_KEY`) in
  der Umgebung des Servers oder in `~/.rookery/.env` bzw. `.env` im Repo;
  der Browser sieht nie einen Key. ElevenLabs ist die Stimme mit Aura: die
  vorgefertigten Stimmen (George, Daniel, Brian) stehen ohne Key im Picker,
  mit Key kommt die eigene Voice Library dazu. Die Browser-eigene
  `speechSynthesis` bleibt als Fallback und als vierte Engine.
- **Sprechstil**: `voice.style` `jarvis` (Standard) lässt gesprochene Antworten
  im Register eines gelassenen britischen Butlers formulieren; `neutral`
  schaltet das ab. Der Chat bleibt unberührt.
  Der **Jarvis-Effekt** (Präsenz-EQ, Kompression, kurzer Raum-Doppel) läuft im
  Browser über Web Audio und ist abschaltbar. Alles unter Einstellungen →
  Sprache, mit Probehören.
- **Push-to-Talk** im Chat: das Diktier-Symbol im Eingabefeld.

Schnittstelle: `POST /api/tts` mit `{ text }` liefert MP3,
`GET /api/tts/voices` die verfügbaren Engines und Edge-Stimmen.

Gesprochene Turns setzen `voice: true`. Der Assistent formuliert die Antwort
dann bewusst anders: kurz, ohne Markdown, ohne Codeblöcke, mit dem Hinweis,
dass Details auf dem Bildschirm stehen.

Spracherkennung gibt es praktisch nur in Chrome und Edge. In Firefox und Safari
zeigt Rookery das ehrlich an und bleibt per Tastatur voll bedienbar. Die
Sprachausgabe der CLI nutzt stattdessen die Stimme des Betriebssystems
(PowerShell `System.Speech` unter Windows, `say` unter macOS, `spd-say` unter Linux).

## Konfiguration

`~/.rookery/config.json`, überschreibbar per Umgebungsvariable (siehe
`.env.example`) und im Einstellungsdialog der Web-UI. Die Reihenfolge, in der
spätere Werte gewinnen: eingebaute Defaults → `config.json` → Umgebung →
explizite Aufruf-Overrides. Gelesen wird `~/.rookery/.env` und ein `.env` im
Repo-Root (Vorlage: `.env.example`); Werte, die die Shell schon gesetzt hat,
gewinnen.

Änderungen zur Laufzeit — der Einstellungsdialog, die Werkzeug-Schalter, das
`update_settings`-Werkzeug des Assistenten — gehen alle durch `applyConfig`:
geschrieben wird in `config.json`, aktualisiert wird das eine Konfigurations-
objekt, das Runtime, Firma und Server gemeinsam halten. Ein Aufruf-Override wie
`--port` überlebt das, ohne in der Datei zu landen; eine ausdrückliche Änderung
sticht ihn trotzdem. Auf „Standard" zurückgesetzte Werte verschwinden ganz,
statt als leerer String hängenzubleiben.

Vollständiges Beispiel — kommentiert sind Werte, die vom Default abweichen:

```jsonc
{
  "home": "~/.rookery",
  "workspace": "~/.rookery/workspace", // Arbeitsraum des Assistenten
  "port": 4317,
  "host": "127.0.0.1",
  "token": "",                     // Bearer-Secret; leer = nur localhost, keine Auth
  "logLevel": "info",              // debug | info | warn | error | silent
  "assistantName": "Rookery",
  "userName": "Jonas",
  "formalAddress": true,           // immer "Sie" (Default: false)
  "honorific": "Master",           // gelegentliche Anrede; leer = Name (Default: "")
  "defaultProvider": "claude",     // claude | codex
  "defaultModel": "",              // leer = Provider-Default
  "defaultEffort": "",             // low | medium | high | xhigh | max, leer = Provider-Default
  "defaultPermission": "read",     // chat | read | write | full
  "memory": {
    "enabled": true,
    "recallLimit": 8,              // Erinnerungen pro Turn
    "recallThreshold": 0.12,       // Mindest-Score für Injektion
    "autoExtract": true,           // nach jedem Turn dazulernen
    "workingWindow": 12,           // wörtlich behaltene Turns
    "contextBudget": 6000          // Zeichenbudget für den Kontextblock
  },
  "voice": {
    "enabled": true,
    "engine": "edge",              // edge | elevenlabs | openai | browser
    "edgeVoice": "de-DE-FlorianMultilingualNeural",
    "elevenLabsVoiceId": "", "elevenLabsModel": "eleven_multilingual_v2",
    "openaiVoice": "onyx",
    "voiceName": "",               // bevorzugte browsereigene Stimme; leer = beste lokale Wahl
    "lang": "de-DE", "wakeWord": "rookery", "rate": 1.02, "pitch": 0.95,
    "speakCleanText": true,        // Markdown/Codeblöcke vor dem Sprechen entfernen
    "jarvisEffect": true,
    "style": "jarvis"              // jarvis | neutral, siehe Abschnitt "Sprache"
  },
  "org": {
    "maxConcurrentAssignments": 4, // Agenten-Prozesse gleichzeitig
    "maxDelegationDepth": 3,       // wie tief Agenten weiterdelegieren dürfen
    "assignmentTimeoutMs": 2700000 // harte Grenze pro Auftrag (45 Minuten)
  },
  "tools": {                       // der MCP-Hub, siehe Abschnitt "Werkzeuge und Skills"
    "servers": [
      { "id": "computer", "enabled": true, "audience": "assistant", "options": { "profile": "ax" }, "env": {} }
    ]
  },
  "skillsDir": "~/.rookery/skills"
}
```

### Berechtigungsstufen

Die Stufe bestimmt, was die darunterliegende CLI anfassen darf:

| Stufe | Claude Code | Codex |
|---|---|---|
| `chat` | `--restricted`, zusätzlich `Read`/`Glob`/`Grep`/`WebSearch`/`WebFetch`/`Task` per `--disallowedTools` gesperrt — rein konversationell | Sandbox `read-only` |
| `read` | `--restricted --disallowedTools Edit,Write,NotebookEdit` — lesen und suchen, keine Änderungen | Sandbox `read-only` |
| `write` | `--restricted --permission-mode acceptEdits` — Dateien ja, **Shell weiterhin nein** | Sandbox `workspace-write` |
| `full` | `--dangerously-skip-permissions` | Sandbox `danger-full-access` |

Standard ist `read`. Erst `full` erlaubt der CLI, Befehle auszuführen — auf
jeder Stufe darunter bleibt `--restricted` gesetzt, ein Agent auf `write`
kann also Dateien ändern, aber keine Shell erreichen. Setze `full` bewusst
und nur für Agenten, deren Projekte du dafür freigeben willst. Jeder Agent
kann eine eigene Stufe haben; ohne Angabe gilt der Standard.

Beide CLIs laufen isoliert: Claude Code immer mit `--setting-sources ""`, also
ohne deine globalen Einstellungen, und sobald der Turn MCP-Server mitbekommt
zusätzlich mit `--mcp-config` und `--strict-mcp-config`, also ohne andere
MCP-Server als die von Rookery übergebenen. Der Assistent ersetzt außerdem
Claude Codes eigenen
Coding-Agent-Systemprompt komplett (`--system-prompt`); deshalb redet er mit
dir wie ein Mensch und nicht wie ein Werkzeug über Repositories. Agenten
behalten den Coding-Prompt, weil sie in Projekten arbeiten. Die `CLAUDE.md` im jeweiligen Arbeitsverzeichnis wird
weiterhin gelesen — im Arbeitsraum ist das Rookerys eigene, in einem
Projektverzeichnis die des Projekts.

### Fernzugriff

Standardmäßig lauscht der Server nur auf `127.0.0.1` und verlangt keine
Authentifizierung. Sobald du ihn ins Netz stellst, setze ein Token:

```bash
ROOKERY_TOKEN=ein-langes-zufaelliges-geheimnis ROOKERY_HOST=0.0.0.0 npm start
```

Ist ein Token gesetzt, verlangen alle `/api/*`-Aufrufe einen
`Authorization: Bearer`-Header und der WebSocket einen `?token=`-Parameter.

## Fehlersuche

| Symptom | Ursache und Behebung |
|---|---|
| `doctor` meldet „nicht angemeldet" | `claude` starten und `/login`, bzw. `codex login` |
| „No AI provider is ready" | Beide CLIs abgemeldet oder nicht im PATH |
| Web-UI zeigt Offline-Banner | Server läuft nicht — `npm start` |
| Erster Turn dauert lange | Kaltstart der CLI plus Prompt-Caching; Folgeturns sind schneller |
| Sprache reagiert nicht | Kein Chromium-Browser, oder Mikrofonzugriff abgelehnt |
| `dev:all` bricht sofort ab | Server noch nicht gebaut — erst `npm run build`, dann `npm run dev:all` |
| Web-UI fehlt, `/api/*` geht trotzdem | Kein `npm run build -w @rookery/web` gelaufen — der Server läuft bewusst auch ohne Web-Build im reinen API-Modus |

## Konzepte in Arbeit

`docs/concepts/` sammelt Designdokumente für Ausbaustufen, die noch nicht
oder nur teilweise umgesetzt sind — Konzept, kein Code, jeweils mit Stand und
betroffenen Dateien im Kopf:

- [`agent-performance-management.md`](docs/concepts/agent-performance-management.md) — Bewertung, Verlauf und Eskalationsstufen für Agenten
- [`memory-graph-and-sleep.md`](docs/concepts/memory-graph-and-sleep.md) — Gedächtnis als Graph mit nächtlicher Verdichtung

## Lizenz

MIT, siehe [`LICENSE`](LICENSE).
