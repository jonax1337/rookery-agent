# Leistungsbewertung fuer Agenten (HR-Modell)

Stand: 2026-09-10, Umsetzung nachgetragen am 2026-09-15. **Alle vier Phasen umgesetzt.** Code liegt in
`packages/core/src/memory/db.ts` (Schema 15), `packages/core/src/org/store.ts`, `org/controller.ts`,
`org/review.ts` (die Modellaufrufe), `org/tools.ts`; Server in `packages/server/src/routes/org.ts` und
`schemas.ts`; UI in `AssignmentDetailPage.tsx` (Sternleiste), `AgentDetailPage.tsx` (Leistung,
Personalakte, Uebergabe, Trennungs-Handlungspunkt), `OrgAgentsPage.tsx` (Stage-Spalte), `DashboardPage.tsx`
(Firma-Kachel). Zwei Seiten kamen ueber das Konzept hinaus hinzu, auf Nutzerwunsch:
`OrgPerformancePage.tsx` (`/org/performance`, firmenweite Uebersicht) und `OrgHierarchyPage.tsx` (`/org/hierarchy`, Organigramm nach
`Agent.managerId`) — beide unten in Abschnitt 9 dokumentiert, nicht Teil des urspruenglichen Konzepts.

Zwei Abweichungen vom Text unten, beide bewusst:

- **E5 (neu, 2026-09-15) — Jarvis' Bewertung laeuft nie auf dem kleinen Modell.** Der Text unten (Abschnitt
  2, "Wer bewertet wann") modelliert die automatische Bewertung auf `#learn` und damit auf
  `smallModelFor`. Jonas widersprach explizit: Eine Bewertung ist ein Urteil, keine Extraktion — dieselbe
  Begruendung wie E6 in `memory-graph-and-sleep.md` fuer den Schlaf. `org/review.ts` ruft deshalb nie
  `smallModelFor` auf; jeder Aufruf (Review, Note, Reconfig, Replacement-Vorschlag, Handover) laeuft auf
  dem Standardmodell des Providers, sofern kein anderes explizit gesetzt ist.
- **Stufe 3 vereinfacht: ein Reconfig statt zwei.** Abschnitt 4 unten erlaubt bis zu zwei Reconfigs
  innerhalb von 20 Auftraegen, bevor eine Ersetzung vorgeschlagen wird. Die Idempotenz-Regel in
  `#develop` (nur handeln, wenn die berechnete Stufe die Stufe der letzten Massnahme uebersteigt) kann
  "bleibe auf Stufe 2, aber fuehre eine zweite Reconfig aus" ohne zusaetzlichen gespeicherten Zustand
  nicht ausdruecken — genau das schliesst O1 aus. Ein Bewaehrungsfenster nach dem einen Reconfig
  entscheidet daher direkt: erholt (Stufe 0) oder Ersetzung vorgeschlagen (Stufe 3), nie ein zweiter
  automatischer Reconfig. Siehe Kommentar bei `stageFromReviews` in `org/store.ts`.

## 1. Zielsetzung

Agenten sind fest angestellte Datensaetze mit Rolle, Anweisungen und eigenem Gedaechtnis. Heute gibt es
keinerlei Rueckmeldung darueber, ob ein Agent seine Rolle gut ausfuellt: ein Auftrag ist `done` oder
`failed`, mehr nicht. Ziel ist ein Personalprozess, der genau das schliesst:

1. **Bewerten** – jeder abgeschlossene Auftrag bekommt eine Note, vom Nutzer und/oder von Jarvis.
2. **Historisieren** – Noten bleiben erhalten, pro Agent wird ein Verlauf und ein Trend sichtbar.
3. **Entwickeln** – bei schwachem Output wird zuerst die Rollen-/Konfigurationsbeschreibung nachgeschaerft.
4. **Trennen** – erst wenn Nachschaerfen ueber mehrere Iterationen nichts bringt, wird der Agent entlassen
   und durch einen neu eingestellten mit angepasster Konfiguration ersetzt. Der Nachfolger ist eine eigene Person mit eigenem Namen, eigenem Slug und eigener Historie; aus dem Gedaechtnis des Vorgaengers erbt er nur eine verdichtete Uebergabe.

Grundsatz: **Entlassen ist der letzte Schritt.** Jede Eskalationsstufe muss belegt sein durch Bewertungen, die vor der Massnahme entstanden sind, und jede Massnahme wird protokolliert. Selbstaendig handeln darf das System nur bis einschliesslich Stufe 2 (Nachschaerfung der Rolle): Jarvis fuehrt sie aus, aber ausschliesslich gegen vollstaendige Protokollierung mit Vorher/Nachher in `agent_actions` und mit Meldung an den Nutzer im selben Turn (Entscheidung E1). Ueber Trennung entscheidet ausschliesslich der Nutzer.

Nicht-Ziel: eine Metrik, die Agenten gegeneinander rankt. Bewertet wird immer ein Agent gegen seine
eigene Rolle.

## 2. Bewertungsmodell

### Dimensionen

Fuenf Dimensionen, jeweils 1–5, plus ein Gesamtwert. Alle Einzelwerte sind optional (`null` = nicht
beurteilbar); nur `overall` ist Pflicht.

| Dimension | Frage | Wer kann das beurteilen |
|---|---|---|
| `quality` | Ist das Ergebnis fachlich richtig und brauchbar? | Nutzer, Jarvis |
| `completeness` | Wurde der Auftrag vollstaendig erfuellt, nichts stillschweigend weggelassen? | Nutzer, Jarvis |
| `reliability` | Sind Behauptungen belegt, Verifiziertes von Angenommenem getrennt, keine Erfindungen? | Nutzer, Jarvis |
| `communication` | Ist der Bericht knapp, entscheidungsorientiert, im geforderten Format? | Nutzer, Jarvis |
| `efficiency` | Aufwand (Dauer, Umfang, Nacharbeit) im Verhaeltnis zum Auftrag? | System, Jarvis |

`overall` ist keine Formel, sondern ein eigenes Urteil (sonst mittelt sich jede Auffaelligkeit weg).
Aggregationen im Verlauf laufen ueber `overall`.

### Skala

Ganzzahlig 1–5 mit festen Ankern, damit Nutzer und Modell dieselbe Sprache sprechen:

- **5** – So abgeliefert, wie es ein guter Kollege in dieser Rolle taete. Nichts nachzuarbeiten.
- **4** – Brauchbar, kleine Nacharbeit oder Nachfrage noetig.
- **3** – Erfuellt den Auftrag im Kern, aber mit spuerbaren Luecken.
- **2** – Am Auftrag vorbei oder in Teilen unbrauchbar; wesentliche Nacharbeit.
- **1** – Unbrauchbar, irrefuehrend oder erfundene Ergebnisse.

Schwelle "schwach" = `overall <= 2`. Neutralzone 3. Alles ab 4 ist gut.

### Wer bewertet wann

| Quelle | Zeitpunkt | Aufwand |
|---|---|---|
| `system` | Sofort beim Abschluss jedes Auftrags, ohne Modell. Nur harte Signale: `failed`, Timeout, leerer Output, Abbruch. Setzt keine Note fuer Qualitaet, sondern markiert den Lauf als technisch gescheitert. | 0 Tokens |
| `assistant` (Jarvis) | Asynchron nach jedem Auftrag mit `status = done`, genau **ein** Aufruf eines kleinen Modells, das Auftragstext und Bericht liest und ein kleines JSON zurueckgibt. Analog zur bestehenden Gedaechtnis-Extraktion (`OrgController.#learn`, `memory/extractor.ts`, `smallModelFor`). | 1 kleiner Modellaufruf pro Auftrag |
| `user` | Freiwillig, jederzeit, ueber die UI: Sternleiste am Auftrag plus optional eine Zeile Kommentar. Kein Pflichtfeld, kein Dialog, keine Blockade. | < 5 Sekunden |

Zumutbarkeitsregel: die automatische Bewertung darf den Auftrag weder verlangsamen noch zum Scheitern
bringen. Sie laeuft nach `finish({status:'done'})` als `void`-Aufruf im Hintergrund, genau wie `#learn`
heute (`org/controller.ts:537-539`); schlaegt sie fehl, wird nur geloggt.

### Gewichtung

Bei mehreren Bewertungen desselben Auftrags gilt: **Nutzer schlaegt Jarvis schlaegt System.** Fuer
Aggregationen zaehlt pro Auftrag genau eine wirksame Bewertung (`effective review`). Technisch
gescheiterte Laeufe (`system`, Timeout/kein Provider/Verzeichnis fehlt) fliessen **nicht** in den
Qualitaetsschnitt, sondern in eine separate Fehlerquote – sonst bestraft man den Agenten fuer Infrastruktur.

## 3. Datenmodell

Bewertungen sind Organisationsdaten, keine Erinnerungen. Sie gehoeren **nicht** in die `memories`-Tabelle:
die ist Recall-Material mit `owner = agentId`, FTS-indiziert und wird in den Prompt des Agenten
eingespielt – ein Agent wuerde sonst seine eigenen Noten als Kontext lesen. Speicherort ist der
Org-Layer neben `assignments`.

### Neue Tabellen (`packages/core/src/memory/db.ts`, `SCHEMA_VERSION` 3 → 4)

`migrate()` ist idempotent (`CREATE TABLE IF NOT EXISTS`), beide Tabellen werden einfach im Org-Block
nach `tasks` ergaenzt.

```sql
CREATE TABLE IF NOT EXISTS agent_reviews (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,  -- NULL: periodische Bewertung
  task_id       TEXT,
  source        TEXT NOT NULL,          -- 'user' | 'assistant' | 'system'
  overall       INTEGER NOT NULL,       -- 1..5
  quality       INTEGER,
  completeness  INTEGER,
  reliability   INTEGER,
  communication INTEGER,
  efficiency    INTEGER,
  comment       TEXT,                   -- eine bis drei Saetze, was gut/schlecht war
  tags          TEXT NOT NULL DEFAULT '[]',  -- z.B. ["scope-miss","unverified-claim"]
  failed_run    INTEGER NOT NULL DEFAULT 0,  -- technisch gescheitert, zaehlt nicht in den Schnitt
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_reviews_agent
  ON agent_reviews(agent_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_reviews_once
  ON agent_reviews(assignment_id, source);   -- je Quelle eine Note pro Auftrag (UPSERT beim Nachbessern)

CREATE TABLE IF NOT EXISTS agent_actions (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,   -- 'note' | 'reconfig' | 'probation' | 'replace'
  stage            INTEGER NOT NULL DEFAULT 0,   -- Eskalationsstufe zum Zeitpunkt der Massnahme
  reason           TEXT NOT NULL,   -- interne Diagnose mit Belegen, sieht der Agent nie
  before_text      TEXT,            -- Anweisungen vor der Aenderung
  after_text       TEXT,            -- Anweisungen danach
  agent_note       TEXT,            -- an den Agenten gerichtete Entwicklungsnotiz (E2), ohne Zahlen und Noten
  handover_text    TEXT,            -- bei 'replace': verdichtete Uebergabe an den Nachfolger (E3)
  review_ids       TEXT NOT NULL DEFAULT '[]',   -- Belege: die Bewertungen, die die Massnahme ausloesten
  decided_by       TEXT NOT NULL,   -- 'user' | 'assistant'
  successor_agent_id TEXT,          -- bei 'replace': der neu eingestellte Agent
  created_at       INTEGER NOT NULL,
  CHECK (kind <> 'reconfig' OR (before_text IS NOT NULL AND after_text IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_agent
  ON agent_actions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_actions_successor
  ON agent_actions(successor_agent_id);
```

### Aenderung an `memories`

```sql
ALTER TABLE memories ADD COLUMN archived_at INTEGER;   -- gesetzt beim Ersetzen eines Agenten
```

Teil derselben Migration auf Version 4. `ALTER TABLE` ist nicht idempotent, also vorher `PRAGMA table_info(memories)` pruefen. Recall-Pfad und FTS-Join filtern ab dann `archived_at IS NULL`. Archivierte Memories werden nie geloescht und bleiben in der UI am archivierten Agenten lesbar (Entscheidung E3).

`agent_actions` ist die Personalakte. Sie ist genauso wichtig wie die Noten: `updateAgent` ueberschreibt
`instructions` heute spurlos (`org/store.ts:275-304`), damit ist keine Aussage moeglich, ob eine
Nachschaerfung etwas gebracht hat. Mit Entscheidung E1 ist sie zusaetzlich die Bedingung dafuer, dass Jarvis ueberhaupt selbst nachschaerfen darf: der `CHECK` erzwingt Vorher/Nachher auf Schemaebene, Aktenschreiben und `update_agent` laufen in einer Transaktion. `before_text` ist zugleich der Rueckweg - jede Nachschaerfung ist daraus zurueckrollbar.

### Typen und Store

- `packages/core/src/types.ts`: `ReviewSource`, `AgentReview`, `AgentAction`, `AgentPerformance`
  (aggregierte Sicht: `average`, `count`, `trend`, `stage`, `failureRate`, `lastReviewAt`) – im
  Abschnitt "Organisation" neben `Assignment`.
- `packages/core/src/org/store.ts`: `createReview`, `upsertReview`, `listReviews(agentId, {limit})`,
  `reviewsForAssignment(id)`, `createAction`, `listActions(agentId)`, `performance(agentId, window)`, `archiveMemories(agentId, at)`, `handoverFor(agentId)`, `agentNotesSince(agentId, since)`.
  Reines CRUD, wie der Rest der Klasse; die Regeln bleiben im Controller.
- Aggregation wird **berechnet, nicht materialisiert**: gleitender Schnitt ueber die letzten N wirksamen
  Bewertungen (`N = 10`), Trend = Schnitt der letzten 5 minus Schnitt der 5 davor. SQLite ist lokal,
  die Datenmengen sind winzig. Keine Score-Spalte auf `agents` (offene Frage O1).

## 4. Eskalationsstufen, Trigger und Schwellwerte

Die Stufe ist eine reine Funktion des Bewertungsverlaufs und der letzten Massnahme – nichts wird
zusaetzlich gespeichert.

| Stufe | Bedingung | Massnahme | Wer loest aus |
|---|---|---|---|
| **0 – normal** | Schnitt der letzten 10 `>= 3.5`, kein `overall <= 2` in den letzten 3 | keine | – |
| **1 – auffaellig** | 2 der letzten 3 wirksamen Bewertungen `<= 2`, **oder** eine Nutzerbewertung `= 1`, **oder** Schnitt der letzten 5 `< 3.0` | Jarvis legt eine `note` in `agent_actions` an, mit konkreter Diagnose (welche Dimension, welche Belege), und meldet es dem Nutzer im naechsten passenden Turn. Noch keine Aenderung am Agenten. | automatisch |
| **2 – Nachschaerfung** | Stufe 1 haelt an: noch eine Bewertung `<= 2` nach der `note`, oder Nutzer fordert es an | Jarvis formuliert praezisierte `instructions` (ggf. auch Titel, Provider, Modell, Permission), schreibt in einer Transaktion `reconfig` mit `before_text`, `after_text`, `reason` und `review_ids` und fuehrt `update_agent` aus; scheitert das Protokoll, unterbleibt die Aenderung. Dazu eine `agent_note` als Rueckmeldung an den Agenten. Meldung an den Nutzer im selben Turn inklusive Diff. Danach automatisch `probation`: Bewaehrungsfenster von **5** bewerteten Auftraegen. | Jarvis, selbstaendig und ohne Freigabe (Entscheidung E1) |
| **3 – wiederholt schwach** | Nach 2 `reconfig` innerhalb der letzten 20 Auftraege ist der Schnitt im letzten Bewaehrungsfenster weiterhin `< 3.0` | Jarvis schlaegt Ersetzung vor: Begruendung, was zweimal nicht gefruchtet hat, und ein Entwurf der neuen Rollenbeschreibung samt Name und Slug des Nachfolgers. **Nur Vorschlag.** | automatisch |
| **4 – Trennung** | Der Nutzer stimmt Stufe 3 zu | `update_agent(archived: true)` (nie `deleteAgent` - die Historie muss bleiben), Archivierung des Vorgaenger-Gedaechtnisses (`memories.archived_at`), Erzeugung der Uebergabe, danach `hire_agent` mit **neuem Namen und neuem Slug** (Entscheidung E4) und der neuen Konfiguration; Team, Vorgesetzter und Reports werden uebernommen, der Slug des Vorgaengers bleibt belegt. `agent_actions` bekommt `replace` mit `successor_agent_id` und `handover_text`. | nur Nutzer |

Schutzregeln:

- **Mindestdatenlage:** keine Stufe > 0 vor 3 wirksamen Bewertungen; keine Stufe > 2 vor 10.
- **Karenz:** nach einer `reconfig` zaehlen nur Auftraege, die danach begonnen wurden.
- **Infrastruktur zaehlt nicht:** `failed_run = 1` fliesst nur in die Fehlerquote. Eine hohe Fehlerquote
  bei sauberem Qualitaetsschnitt ist ein Hinweis auf Provider/Permission/Timeout, nicht auf den Agenten –
  Jarvis meldet das als eigene Diagnose ("Konfigurationsproblem", nicht "Leistungsproblem").
- **Nutzer sticht immer:** eine Nutzerbewertung von 4–5 nach einer schwachen Serie setzt die Stufe zurueck
  auf 0.
- **Protokoll vor Wirkung:** eine Aenderung an `instructions` durch Jarvis ohne geschriebene `reconfig`-Massnahme ist ein Fehler, keine Massnahme (Entscheidung E1).
- **Nachschaerfung ist gedeckelt:** hoechstens eine `reconfig` je Bewaehrungsfenster und hoechstens zwei innerhalb von 20 Auftraegen. Danach ist Stufe 3 erreicht und Jarvis handelt nicht mehr selbst, sondern schlaegt vor.

## 5. Einbettung in die bestehenden Mechanismen

**Auftragslauf** (`packages/core/src/org/controller.ts`)
- In `run()` direkt nach dem erfolgreichen `finish({status:'done'})` (Zeile ~533) neben `void this.#learn(...)`
  ein `void this.#review(agent, assignment, text, providerId)`. Gleiche Fehlertoleranz: nur loggen.
- Alle `fail(...)`-Pfade (Timeout, kein Provider, leerer Output, fataler Fehler) schreiben synchron eine
  `system`-Bewertung mit `failed_run = 1` und `overall = 1`, ohne Modellaufruf.
- Nach dem Schreiben einer Bewertung: Stufe neu berechnen. Steigt sie, `emit('changed', {kind:'agent'})`,
  damit UI und Assistent es mitbekommen.

**Tasks** (`runTask`, `#runSubtask`)
- Bewertet wird immer das Assignment, nie der Task. Ein Task mit Teilaufgaben erzeugt so automatisch
  eine Bewertung je beteiligtem Agenten – genau richtig, weil jeder nur fuer seinen Teil geradesteht.
- Der Task traegt bereits `assignmentId`; `agent_reviews.task_id` ist nur Bequemlichkeit fuer die UI.

**Werkzeuge** (`packages/core/src/org/tools.ts`, Handler in `controller.ts#handle`)
- `review_assignment` (assistant): Bewertung nachtragen oder korrigieren. Erlaubt Jarvis auch, eine
  Bewertung zu revidieren, nachdem der Nutzer widersprochen hat.
- `agent_performance` (assistant): Verlauf, Schnitt, Trend, Stufe, offene Massnahmen eines Agenten.
  Das ist das Werkzeug fuer das "Entwicklungsgespraech".
- `update_agent` bekommt ein optionales Feld `reason`. Ist es gesetzt und aendert der Patch
  `instructions`, wird automatisch eine `reconfig`-Massnahme geschrieben. Ohne `reason` bleibt das
  Verhalten wie heute (freie Umbauten der Firma sind keine Personalmassnahme). Ausgenommen sind Agenten auf Stufe >= 1: dort ist `reason` Pflicht, damit eine Nachschaerfung nicht unprotokolliert bleibt (Entscheidung E1).
- `hire_agent` bekommt ein optionales `replaces` (Slug des Vorgaengers): archiviert den Vorgaenger und dessen Gedaechtnis, uebernimmt Team, Vorgesetzten und Reports, erzeugt die Uebergabe und setzt `successor_agent_id`. Name und Slug des Nachfolgers sind Pflicht und muessen sich vom Vorgaenger unterscheiden - das validiert der Handler (Entscheidung E4). Der Slug des Vorgaengers wird nicht freigegeben und nicht umbenannt. Ein optionales `handover` ueberschreibt den generierten Uebergabetext.
- Agenten-Audience bekommt von Bewertungen, Stufen und Personalakte **nichts**. Die einzigen Ausnahmen sind die an ihn gerichtete Entwicklungsnotiz und, beim Nachfolger, die Uebergabe im eigenen Prompt (Entscheidungen E2 und E3). Niemand bewertet sich selbst oder seine Kollegen.

**Prompts** (`packages/core/src/org/prompts.ts`)
- `assistantOrgBlock`: eine Zeile je Agent mit Stufe >= 1 ("mara: 2 von 3 letzten Auftraegen schwach,
  Nachschaerfung faellig"), damit Jarvis das Thema von sich aus anspricht statt auf eine Frage zu warten.
- `buildAgentPrompt`: **keine Noten, keine Dimensionen, kein Schnitt, kein Trend, kein Verweis auf einzelne Bewertungen im Agentenprompt** (Entscheidung E2). Aufgenommen werden zwei Abschnitte:
  - "Rueckmeldung zu deiner Arbeit": die `agent_note`-Texte der Massnahmen seit der letzten `reconfig`, hoechstens zwei, juengste zuerst. Nach einer Nachschaerfung fallen aeltere Notizen weg - ab dann wirkt die Entwicklung ueber die geaenderten `instructions`. Die Notiz entsteht im selben kleinen Modellaufruf wie die Diagnose, beschreibt beobachtbares Verhalten und die Erwartung ("Belege fehlten in mehreren Berichten - trenne Verifiziertes von Angenommenem") und nennt nie Noten, Zaehlungen oder Bewertungsquellen. Ein Validierungsschritt beim Schreiben lehnt Notizen ab, die Ziffernnoten oder Dimensionsnamen enthalten.
  - "Uebergabe von <Vorgaenger>": nur beim Nachfolger, Text aus `agent_actions.handover_text` (Entscheidung E3), fest eingebunden statt ueber Recall.

**Gedaechtnis**
- Bewertungen erzeugen weiterhin keine Memories, `#learn` bleibt unveraendert.
- Beim Ersetzen (Stufe 4) wird das Gedaechtnis des Vorgaengers **nicht** uebertragen (Entscheidung E3). Stattdessen erzeugt der Controller in `#handover(predecessor)` genau einen kleinen Modellaufruf ueber die nicht archivierten Memories des Vorgaengers, begrenzt nach Wichtigkeit und Aktualitaet, plus dessen Rolle und `instructions`. Ergebnis ist ein Uebergabedokument von hoechstens rund 2000 Zeichen mit vier Abschnitten: laufende Vorhaben, getroffene Entscheidungen und ihre Begruendung, projektspezifische Fakten und Konventionen, offene Punkte und bekannte Fallen.
- Ausgeschlossen sind Bewertungen, Massnahmen, Personalakte und alles, woraus der Nachfolger die Noten des Vorgaengers ableiten koennte.
- Der Text wird in der `replace`-Massnahme (`handover_text`) gespeichert: eine Quelle, Teil der Akte, vom Nutzer vor der Bestaetigung der Trennung les- und editierbar. Er wird **nicht** als Memory beim Nachfolger angelegt - Recall ist FTS-basiert und wuerde die Uebergabe nur zufaellig treffen. `buildAgentPrompt` rendert sie stattdessen als festen Abschnitt.
- Das Alt-Gedaechtnis wird archiviert, nicht geloescht: beim Archivieren des Vorgaengers wird `memories.archived_at` gesetzt, Recall filtert `archived_at IS NULL`, die UI zeigt die Eintraege am archivierten Agenten weiter lesbar an. Unerreichbar waeren sie ohnehin, weil Recall auf `owner = agentId` filtert; das Flag macht es explizit und ueberlebt spaetere Aenderungen am Recall-Pfad.
- Der Nachfolger startet mit leerem eigenem Gedaechtnis und baut es ueber `#learn` neu auf; was aus der Uebergabe traegt, landet dort ueber die normale Extraktion.

**Server** (`packages/server/src/routes/org.ts`, Schemas in `schemas.ts`)
- `GET /api/org/agents/:id` liefert zusaetzlich `performance`, `actions` und die Identitaetskette (`predecessor`, `successor`, beim Nachfolger dazu `handover`) (die Route baut heute schon
  `agent`, `assignments`, `memories`, `reports` zusammen).
- `POST /api/org/assignments/:id/review` – Nutzerbewertung (Upsert, Quelle `user`).
- `GET /api/org/agents/:id/reviews?limit=` – Verlauf.
- `POST /api/org/agents/:id/actions` - Massnahme protokollieren. Freigaben betreffen nur noch Stufe 4; Stufe 2 fuehrt Jarvis selbst aus.

## 6. Auswirkungen auf Dashboard/UI

Alles in bestehende Seiten, keine Modals (Konvention aus `CLAUDE.md`).

- **`AssignmentDetailPage.tsx`** – Sternleiste 1–5 plus optionales Kommentarfeld unter dem Ergebnis.
  Ein Klick speichert. Daneben klein, was Jarvis vergeben hat, damit der Nutzer korrigieren kann statt
  neu zu urteilen.
- **`AgentDetailPage.tsx`** – neue Karte "Leistung" zwischen "Anweisungen" und "Letzte Auftraege":
  Schnitt der letzten 10, Trendpfeil, Stufen-Badge (normal / auffaellig / in Nachschaerfung / Bewaehrung /
  Ersetzung vorgeschlagen), Fehlerquote getrennt ausgewiesen, Sparkline der letzten 10 Noten. Darunter
  Karte "Personalakte": Massnahmen chronologisch, `reconfig` mit aufklappbarem Vorher/Nachher der
  Anweisungen; die an den Agenten ausgelieferte Entwicklungsnotiz wird als solche markiert ("sieht der Agent"). In "Letzte Auftraege" je Zeile die Note als kleines Badge. Kopfzeile zeigt die Identitaetskette: "Nachfolger von <Vorgaenger>" bzw. "ersetzt durch <Nachfolger>", jeweils verlinkt. Beim Nachfolger zusaetzlich die Karte "Uebergabe" mit dem Handover-Text. Beim archivierten Vorgaenger bleiben die Memories sichtbar, als "archiviert, nicht mehr recallbar" gekennzeichnet.
- **`DashboardPage.tsx`** – die bestehende Karte "Firma" bekommt eine Zeile "Leistung": Anzahl Agenten
  je Stufe und die schwaechsten zwei mit Link. Offene Vorschlaege (Stufe 3) erscheinen als Handlungs-
  punkt, nicht als Statistik.
- **`OrgPage.tsx`** – Score-Badge je Agent in der Liste.
- **Trennungs-Bestaetigung** - kein Modal (Konvention aus `CLAUDE.md`), sondern ein Handlungspunkt auf der Agentenseite: Begruendung, Entwurf der neuen Rolle, Name und Slug des Nachfolgers und der editierbare Uebergabetext, darunter die Freigabe.
- **CLI** – `rookery org perf [slug]` als Textausgabe des Verlaufs; niedrige Prioritaet.

## 7. Entscheidungen und offene Fragen

### 7.1 Entschieden am 2026-09-10 von Jonas

**E1 - Stufe 2 fuehrt Jarvis selbst aus.** Jarvis darf `instructions` und die uebrige Rollenkonfiguration auf Stufe 2 ohne vorherige Freigabe aendern, statt nur vorzuschlagen. Bedingung ist die vollstaendige Protokollierung: jede solche Aenderung schreibt eine `reconfig`-Massnahme mit `before_text`, `after_text`, `reason`, `review_ids` und `decided_by = 'assistant'`. Akte und `update_agent` laufen in einer Transaktion, der `CHECK` auf `agent_actions` erzwingt Vorher/Nachher auf Schemaebene; laesst sich das Protokoll nicht schreiben, unterbleibt die Aenderung. Jarvis meldet sie im selben Turn mit Diff, `before_text` erlaubt jederzeit ein Zurueckrollen. Stufe 3 und 4 bleiben Vorschlag und Nutzerentscheidung. Wirksam in Abschnitt 1, 3, 4 und 5.

**E2 - Der Agent sieht Entwicklungsnotizen, keine Noten.** Keine Zahl, keine Dimension, kein Schnitt, kein Trend und kein Verweis auf einzelne Bewertungen erreicht den Agentenprompt. Was ihn erreicht, ist eine ausformulierte qualitative Entwicklungsnotiz (`agent_actions.agent_note`), die beobachtbares Verhalten und die Erwartung benennt. Sie entsteht im selben kleinen Modellaufruf wie die Diagnose und wird beim Schreiben validiert. Wirksam in Abschnitt 3, 4, 5 und 6.

**E3 - Uebergabe statt Gedaechtnisuebernahme.** Kein roher Memory-Dump. Beim Ersetzen verdichtet ein Modellaufruf das Gedaechtnis des Vorgaengers zu einem Uebergabedokument, das in der `replace`-Massnahme (`handover_text`) liegt, vom Nutzer vor der Freigabe editierbar ist und dem Nachfolger als fester Prompt-Abschnitt zugaenglich gemacht wird - nicht ueber Recall. Das Alt-Gedaechtnis wird archiviert (`memories.archived_at`), bleibt lesbar und ist fuer keinen Agenten mehr recallbar. Wirksam in Abschnitt 3, 4, 5 und 6.

**E4 - Der Nachfolger bekommt einen neuen Namen und Slug.** Er erbt Rolle, Team, Vorgesetzten und Reports, aber nicht die Identitaet: eigener Name, eigener Slug, eigene Historie, eigene Personalakte ab Tag eins. Die Personifizierung ist ausdruecklich gewollt - Agenten sollen als Personen mit eigener Geschichte wahrgenommen werden, nicht als austauschbare Besetzung eines Rollennamens. Damit entfaellt die frueher erwogene Umbenennung des Vorgaenger-Slugs: `idx_agents_slug` wird nicht verletzt, der Vorgaenger behaelt seinen Slug, und `findAgent` ignoriert ihn ohnehin, weil er archiviert ist. Referenzen in Prompts stimmen automatisch, weil die Org-Bloecke aus dem Graph gebaut werden; historische Erwaehnungen des alten Namens in Auftraegen und in den Memories anderer Agenten bleiben stehen - das ist Historie, kein Fehler. Wirksam in Abschnitt 1, 4, 5 und 6.

### 7.2 Weiterhin offen

**O1 - Aggregat materialisieren?** Vorschlag: nein, on-the-fly berechnen. Erst wenn die Org-Seite spuerbar langsam wird, eine `perf_score`-Spalte auf `agents` nachziehen.

**O2 - Kosten der Auto-Bewertung.** Ein kleiner Modellaufruf je Auftrag zusaetzlich zur Gedaechtnis-Extraktion. Akzeptabel, oder nur bewerten, wenn der Auftrag laenger als X Sekunden lief bzw. der Nutzer nicht selbst bewertet hat?

**O3 - Fliesst Leistung in die Auswahl ein?** `planner.ts` waehlt Zustaendige heute allein nach Rolle. Vorschlag: vorerst nein - sonst verstaerkt sich eine schwache Bewertungsserie selbst. Spaeter moeglich als Tiebreak bei gleich passenden Rollen.

**O4 - Periodische Bewertung** (Bewertung ohne Auftrag, z.B. woechentliches "Entwicklungsgespraech")? Das Datenmodell laesst es zu (`assignment_id` nullbar). Vorschlag: erst bauen, wenn Bedarf da ist.

## 8. Umsetzung in Phasen

| Phase | Inhalt | Ergebnis | Test |
|---|---|---|---|
| **1 – Erfassung** | Schema (`db.ts`, Version 4: `agent_reviews`, `agent_actions` inklusive `agent_note`, `handover_text` und CHECK, `memories.archived_at`), Typen, `OrgStore`-CRUD, `system`-Bewertungen aus harten Signalen, `POST /api/org/assignments/:id/review`, Sternleiste in `AssignmentDetailPage` | Bewertungen entstehen und ueberleben Neustarts. Kein Modell im Spiel. | Store-Tests in `packages/core/test`: Upsert je Quelle, Unique-Index, Fehlerlaeufe zaehlen nicht in den Schnitt |
| **2 – Automatik und Sicht** | `#review` im Controller mit kleinem Modell, Aggregation `performance()`, Karte "Leistung" auf `AgentDetailPage`, Score in `GET /api/org/agents/:id` | Jeder Auftrag hat eine Note, Verlauf und Trend sind sichtbar | Aggregations-Tests mit festen Reviews; Extraktor-Test mit Fake-Provider |
| **3 – Entwicklung** | Stufenberechnung, `note`/`reconfig`/`probation` in `agent_actions`, `update_agent` mit `reason` (Pflicht ab Stufe 1), Werkzeuge `agent_performance` und `review_assignment`, Zeile im `assistantOrgBlock`, Personalakte-Karte, Ausfuehrung der Nachschaerfung durch Jarvis mit transaktionaler Akte, `agent_note` und Abschnitt "Rueckmeldung zu deiner Arbeit" im Agentenprompt | Schwache Agenten werden erkannt, von Jarvis nachgeschaerft und bekommen qualitative Rueckmeldung - mit lueckenlosem Vorher/Nachher | Stufen-Tests: Schwellwerte, Mindestdatenlage, Karenz nach `reconfig`, Reset durch gute Nutzerbewertung; `reconfig` ohne `before_text`/`after_text` schlaegt fehl und laesst `instructions` unveraendert; Notiz-Validierung lehnt Zahlen und Dimensionsnamen ab; Prompt-Test: kein Zahlenwert im Agentenprompt |
| **4 – Trennung** | `hire_agent(replaces)` mit neuem Namen und Slug, Archivierung von Vorgaenger und dessen Gedaechtnis, `#handover`-Erzeugung und Handover-Abschnitt im Prompt des Nachfolgers, Identitaetskette in der UI, Dashboard-Handlungspunkte | Der vollstaendige Zyklus inkl. Ersetzung, mit lueckenloser Akte | End-to-End-Test ueber den Store: schwache Serie → note → reconfig → weiter schwach → replace; Uebergabe erzeugt und frei von Bewertungsdaten; Memories des Vorgaengers archiviert und in keinem Recall; Nachfolger hat eigenen Slug, der Vorgaenger-Slug bleibt belegt |

Phase 1 und 2 sind unabhaengig nutzbar (reines Feedback-System). Erst Phase 3 aendert Agenten,
erst Phase 4 trennt sich von ihnen. Ab Phase 3 aendert Jarvis Agenten selbstaendig - deshalb gehoert die Personalakte in dieselbe Phase und nicht spaeter.

## 9. HR-Uebersicht und Organigramm (ueber das Konzept hinaus)

Zwei Seiten, die Jonas beim Umsetzen zusaetzlich wollte - nicht im urspruenglichen Konzept, hier
nachgetragen, damit sie nicht verwaist im Code stehen:

- **`GET /api/org/performance`** (neu): fuer jeden aktiven Agenten `{ agent, performance, pendingProposal }`
  in einem Aufruf - die eine Abfrage, auf der beide Seiten unten stehen, statt N+1 Aufrufen von
  `GET /api/org/agents/:id`.
- **`/org/performance`** (`OrgPerformancePage.tsx`, Reiter "Performance") - offene Ersetzungsvorschlaege oben als
  Handlungspunkte (verlinkt auf die Agentenseite, wo der Entwurf und die Freigabe liegen - keine
  Duplizierung der Freigabe-UI), darunter jeder aktive Agent nach Stufe und Schnitt sortiert,
  schwaechster zuerst.
- **`/org/hierarchy`** (`OrgHierarchyPage.tsx`, Reiter "Hierarchy") - das Organigramm. Zeigt genau `Agent.managerId` als Baum, mit dem
  Assistenten als synthetischer Wurzel fuer alle Agenten ohne Manager; ein Team ist im Datenmodell keine
  Baumebene (es nistet keine Agenten unter sich), sondern eine Zuordnung - taucht deshalb bewusst nicht
  als Ebene auf. Eingerueckte, verbundene Liste statt Kaesten-und-Linien-Diagramm: bei einer kleinen
  Firma genauso lesbar und bricht nicht auf schmalen Bildschirmen.

Beide sitzen als weitere Tabs unter `/org` (`OrgLayout.tsx`), neben Agents/Teams/Projects.
