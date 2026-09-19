# Gedaechtnis als Graph, mit Schlaf

Stand: 2026-09-10. **Umgesetzt** in allen fuenf Phasen; dieses Dokument bleibt als Begruendung stehen.
Der Code liegt in `packages/core/src/memory/gate.ts`, `sleep.ts`, `recall.ts`, `store.ts` und `db.ts`,
die Oberflaeche in `packages/web/src/components/Memory*.tsx` und `SleepCard.tsx`. Beruehrt ausserdem
`packages/core/src/cron/`, `packages/core/src/runtime.ts`, `packages/core/src/org/controller.ts` und
`packages/server/src/routes/`.

## 1. Zielsetzung

Das Gedaechtnis funktioniert, aber es waechst unkontrolliert und es weiss nichts ueber sich selbst. Jede
Erinnerung ist ein alleinstehender Satz; zwischen zwei Saetzen gibt es keine Beziehung, keinen Widerspruch,
keine Ablauffolge. Drei Ziele:

1. **Weniger schreiben, besser schreiben** – ein Tor vor dem Schreibpfad, das Fast-Duplikate erkennt und
   Belanglosigkeiten abweist, statt sie erst im Abruf zu daempfen.
2. **Zusammenhaenge fuehren** – Erinnerungen bekommen benannte Entitaeten (Personen, Projekte, Werkzeuge)
   und gerichtete Kanten (`verfeinert`, `widerspricht`, `ersetzt`). Der Abruf laeuft danach ueber zwei
   Spruenge statt ueber einen Volltexttreffer.
3. **Nachts aufraeumen** – ein Schlaflauf ueber den bestehenden Cron-Scheduler verdichtet Buendel,
   legt Ungenutztes schlafen, zieht Kanten und formuliert hoechstens ein bis zwei Einsichten pro Nacht.

Dazu kommt die Sichtbarkeit: Das Gedaechtnis wird in der Web-UI als Graph, als Zeitachse und weiterhin als
Liste dargestellt, zusammen mit einem Schlafbericht.

Nicht-Ziel: eine Vektordatenbank. Nicht-Ziel: automatisches Loeschen. Nicht-Ziel: ein Gedaechtnis, das
ueber Besitzergrenzen hinweg liest – die Trennung zwischen Assistenten-Bank und Agenten-Bank bleibt
unangetastet.

## 2. Befund: warum heute zu viel hineingeht

Alles hier ist am Code belegt, nicht vermutet.

1. **Extraktion nach jedem Turn.** `Runtime.#learn` laeuft nach jeder Antwort, `parseCandidates` laesst bis
   zu **acht** Kandidaten durch, fehlende Wichtigkeit faellt auf **0.5**. Auch ein Turn ohne jeden
   dauerhaften Inhalt liefert also regelmaessig Eintraege.
2. **Das Modell sieht die falschen "bereits bekannten" Erinnerungen.** `#learn` uebergibt
   `store.listMemories({ owner, limit: 40 })`. Das sortiert nach `importance DESC, updated_at DESC` – also
   die **wichtigsten** vierzig, nicht die zum aktuellen Turn **passendsten**. Genau die Erinnerung, die
   das Modell gerade im Begriff ist zu wiederholen, steht typischerweise nicht in dieser Liste.
3. **Duplikatschutz nur exakt.** `idx_memories_unique_owner(owner, kind, content)` greift bei
   zeichengenauer Gleichheit. "Der Nutzer nutzt TypeScript." und "Der Nutzer arbeitet hauptsaechlich mit
   TypeScript." sind zwei Datensaetze. Derselbe Satz unter anderem `kind` ebenfalls.
4. **Nichts stirbt.** `forgotten` wird ausschliesslich von Hand gesetzt (`forgetMemory`). Die
   Recency-Komponente im Score daempft alte Eintraege nur, sie entfernt sie nie aus der Tabelle und auch
   nicht aus `coreProfile`.
5. **Die Verstaerkung belohnt Wiederholung, nicht Nutzen.** `upsertMemory` hebt bei jedem erneuten Treffer
   die Wichtigkeit um `+0.05`. Erneut extrahiert wird aber, was das Extraktionsmodell gern sagt – nicht,
   was im Abruf tatsaechlich geholfen hat. Ueber Wochen wandert damit an die Spitze des `coreProfile`, was
   der Extraktor am liebsten formuliert. Der Nutzungssignalpfad existiert (`touchMemories`,
   `access_count`), fliesst aber nur mit Gewicht 0.1 in den Score und nie in die Wichtigkeit zurueck.

Punkt 2, 3 und 5 zusammen erklaeren das Wachstum vollstaendig. Sie werden in Phase 1 geschlossen, ohne dass
dafuer der Graph oder der Schlaf schon stehen muss.

## 3. Leitgedanke: Struktur statt Vektoren

Rookery spricht ueber das abonnementauthentifizierte `claude`-CLI - gleich, auf welches Backend der
Prozess zeigt. Es liefert Text, keine Embeddings. Ein lokales Embedding-Modell waere ein natives Build-Artefakt und damit genau das, was
`memory/db.ts` mit `node:sqlite` bewusst vermeidet.

Die Antwort darauf ist nicht "dann bleibt es dumm", sondern: Die Intelligenz kommt aus **Struktur**, die
das kleine Modell einmalig nachts erzeugt, und nicht aus Aehnlichkeit, die zur Abfragezeit berechnet wird.

- Semantische Naehe wird durch **geteilte Entitaeten** angenaehert. Zwei Saetze ueber "Rookery" sind
  verwandt, auch wenn sie kein Wort teilen.
- Fast-Duplikate werden **lexikalisch** erkannt (normalisierte Token-Menge, Dice-Koeffizient). Das ist fuer
  Saetze, die dasselbe kleine Modell aus derselben Vorlage erzeugt hat, ueberraschend zuverlaessig.
- Widerspruch und Ablauffolge kann Aehnlichkeit ohnehin nicht: "Der Nutzer ist auf Linux umgestiegen"
  ist zu "Der Nutzer arbeitet unter Windows" hochgradig aehnlich und trotzdem dessen Gegenteil. Das muss
  ein Modell einmal lesen und als Kante festhalten.

## 4. Datenmodell (`SCHEMA_VERSION` 4 nach 5)

### 4.1 Aenderungen an `memories`

```sql
ALTER TABLE memories ADD COLUMN origin        TEXT NOT NULL DEFAULT 'extract';  -- extract | user | sleep
ALTER TABLE memories ADD COLUMN pinned        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN dormant_at    INTEGER;      -- schlaeft: nicht im Abruf, weiter sichtbar
ALTER TABLE memories ADD COLUMN superseded_by TEXT;         -- id der verdichteten Nachfolge-Erinnerung
ALTER TABLE memories ADD COLUMN sleep_run_id  TEXT;         -- welcher Lauf hat diesen Satz geschrieben
ALTER TABLE memories ADD COLUMN usefulness    REAL NOT NULL DEFAULT 0;  -- aus echtem Abruf, nicht aus Wiederholung
```

`ALTER TABLE` ist nicht idempotent; wie in `migrate()` bereits ueblich vorher `hasColumn` pruefen.

`dormant_at` ist die zentrale Neuerung. Eine schlafende Erinnerung ist aus dem Abruf und aus dem
`coreProfile` verschwunden, bleibt aber in der Tabelle, in der Suche und in der UI. Sie ist kein Muell,
sondern Bodensatz. `forgotten` bleibt daneben bestehen und heisst weiterhin "der Nutzer hat das verworfen".

`usefulness` trennt endlich Nutzen von Wiederholung: `touchMemories` erhoeht es gedaempft (`+= 0.03`,
gedeckelt auf 1), `upsertMemory` fasst es nicht an. Die Verstaerkung bei erneuter Extraktion faellt von
`+0.05` auf `+0.02` und entfaellt ab `importance >= 0.8` ganz.

### 4.2 Entitaeten

```sql
CREATE TABLE memory_entities (
  id            TEXT PRIMARY KEY,
  owner         TEXT NOT NULL,
  name          TEXT NOT NULL,     -- Anzeigename, so wie der Nutzer ihn sagt
  slug          TEXT NOT NULL,     -- normalisiert, Kleinschreibung, ohne Diakritika
  kind          TEXT NOT NULL,     -- person | project | tool | place | org | topic
  mentions      INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_entities_slug ON memory_entities(owner, slug);

CREATE TABLE memory_entity_links (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  weight    REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX idx_entity_links_entity ON memory_entity_links(entity_id);
```

Startbefuellung ohne jeden Modellaufruf: Die `tags`, die `parseCandidates` heute schon liefert, werden
normalisiert zu Entitaeten vom `kind` `topic`. Der Schlaflauf hebt sie spaeter auf den richtigen Typ und
fuehrt Schreibweisen zusammen ("rookery", "Rookery-Agent" zu einer Entitaet). Damit ist die Graph-Ansicht
ab Tag eins nicht leer.

### 4.3 Kanten

```sql
CREATE TABLE memory_edges (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  src_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  dst_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL,   -- refines | contradicts | supersedes | caused_by | co_occurs
  weight     REAL NOT NULL DEFAULT 0.5,
  origin     TEXT NOT NULL,   -- sleep | user
  run_id     TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_edges_triple ON memory_edges(src_id, dst_id, relation);
CREATE INDEX idx_edges_src ON memory_edges(owner, src_id);
CREATE INDEX idx_edges_dst ON memory_edges(owner, dst_id);
```

Die fuenf Relationen und was sie im Abruf bewirken:

| Relation | Bedeutung | Wirkung |
| --- | --- | --- |
| `refines` | B praezisiert A | B erbt im zweiten Sprung 0.6 des Scores von A |
| `supersedes` | B loest A ab | A wird schlafen gelegt, `superseded_by = B` |
| `contradicts` | A und B koennen nicht beide stimmen | beide bleiben, der Konflikt wird im Dashboard gezeigt und dem Nutzer zur Entscheidung vorgelegt |
| `caused_by` | A ist wegen B so | reine Erklaerung, im Detail-Panel sichtbar |
| `co_occurs` | treten zusammen auf | schwaechste Kante, nur Graph-Layout |

`supersedes` ist der eigentliche Hebel gegen das Wachstum: Statt zwei halbrichtige Saetze fuer immer
nebeneinander zu halten, entsteht einer und die Vorgaenger schlafen – nachvollziehbar und umkehrbar.

### 4.4 Schlaflaeufe

```sql
CREATE TABLE sleep_runs (
  id             TEXT PRIMARY KEY,
  owner          TEXT NOT NULL,
  trigger        TEXT NOT NULL,   -- cron | manual
  status         TEXT NOT NULL,   -- running | done | failed
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  duration_ms    INTEGER,
  read_count     INTEGER NOT NULL DEFAULT 0,
  merged_count   INTEGER NOT NULL DEFAULT 0,
  dormant_count  INTEGER NOT NULL DEFAULT 0,
  edge_count     INTEGER NOT NULL DEFAULT 0,
  insight_count  INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  model_calls    INTEGER NOT NULL DEFAULT 0,
  report         TEXT,            -- zwei bis drei Saetze in Alltagssprache
  error          TEXT,
  undone_at      INTEGER
);
CREATE INDEX idx_sleep_runs_owner ON sleep_runs(owner, started_at DESC);
```

Alles, was ein Lauf schreibt, traegt seine `run_id`: in `memories.sleep_run_id`, in `memory_edges.run_id`
und implizit ueber `dormant_at`, das im selben Lauf gesetzt wurde. Damit ist eine Nacht in einer
Transaktion rueckgaengig zu machen (Entscheidung E3).

### 4.5 Neue Erinnerungsart

`MemoryKind` bekommt `insight` neben `fact | preference | project | event | summary`. `MEMORY_KINDS` in
`recall.ts`, die Validierung in `parseCandidates` und `MEMORY_KIND_LABEL` in `packages/web/src/lib/format.ts`
ziehen nach. `insight` entsteht ausschliesslich im Schlaf, nie im Turn.

## 5. Schreibpfad: das Tor

Neu: `packages/core/src/memory/gate.ts`. Zwischen `extractMemories` und `upsertMemory` gehaengt, in
`Runtime.#learn` und in `OrgController.#learn` identisch.

**Schritt 1 – Kontext richtig stellen.** `#learn` uebergibt als `known` kuenftig nicht die wichtigsten
vierzig, sondern die **passenden**: `recall(store, { text: userText + ' ' + assistantText, owner, limit: 20,
touch: false })` plus `coreProfile(store, { owner, limit: 5 })`. Das ist ein Einzeiler und wirkt sofort.

**Schritt 2 – Schwelle.** Kandidaten unter `importance < 0.4` werden verworfen, ausser sie nennen eine
bereits bekannte Entitaet. Pro Turn hoechstens **drei** Kandidaten statt acht.

**Schritt 3 – Fast-Duplikat.** Fuer jeden Kandidaten laeuft ein FTS-Treffersatz ueber seinen eigenen
Inhalt (dieselbe `toMatchQuery`), begrenzt auf 15 Kandidaten, ueber alle `kind` hinweg. Aehnlichkeit ist
der Dice-Koeffizient ueber die normalisierte Token-Menge (Kleinschreibung, NFKD, ohne Satzzeichen, ohne
`STOP_WORDS` aus `recall.ts`):

| Aehnlichkeit | Ergebnis |
| --- | --- |
| ab 0.82 | kein neuer Datensatz. Bestehende Erinnerung wird verstaerkt, Tags werden verschmolzen, `updated_at` neu. Der laengere, spezifischere Satz gewinnt den Inhalt. |
| 0.55 bis 0.82 | wird geschrieben, aber fuer die Nacht als Verdichtungs-Kandidat vorgemerkt (`co_occurs`-Kante mit `weight` gleich der Aehnlichkeit) |
| unter 0.55 | normaler Neuschrieb |

**Schritt 4 – Entitaeten.** Tags des Kandidaten werden zu Entitaeten normalisiert und verlinkt.

Erwartete Wirkung allein aus Schritt 1 bis 3: deutlich weniger Neuschriebe pro Tag, ohne dass eine einzige
Information verloren geht – Verstaerkung ist kein Verlust.

## 6. Abruf: zwei Spruenge

`recall()` behaelt seine vier Signale und seine Gewichte. Davor und danach kommt je ein Schritt.

**Davor:** `AND m.dormant_at IS NULL AND m.superseded_by IS NULL` in die Filterbedingung; ebenso in
`coreProfile`.

**Danach, der zweite Sprung.** Aus den besten drei Treffern des ersten Sprungs:

1. **Ueber Entitaeten:** alle Erinnerungen, die eine Entitaet mit einem Treffer teilen, mit
   `score = 0.45 * score(Treffer) * min(1, 3 / mentions(Entitaet))`. Der letzte Faktor daempft
   Allerweltsentitaeten; eine Entitaet, die an achtzig Erinnerungen haengt, sagt nichts aus.
2. **Ueber Kanten:** Ziele von `refines` und `caused_by` mit `0.6 * score(Treffer) * weight`.

Beides wird mit dem ersten Sprung zusammengefuehrt (Maximum je Erinnerung, keine Summe), neu sortiert und
auf `recallLimit` geschnitten. Der zweite Sprung ist reine SQL-Arbeit auf zwei indizierten Joins.

Damit schliesst sich die Luecke, die `coreProfile` heute notduerftig zuklebt: Die Frage "welche Sprache
nehme ich am liebsten?" trifft lexikalisch nichts, aber sie trifft die Entitaet `typescript`, und darueber
den Satz, der die Vorliebe formuliert.

**Ausgabe.** `renderMemoryBlock` gruppiert kuenftig nach Entitaet statt eine flache Strichliste zu
liefern, und markiert Einsichten. Widersprueche werden nie beide injiziert: Von einem `contradicts`-Paar
geht nur der neuere Satz in den Prompt, mit dem Zusatz, dass es dazu eine aeltere, abweichende Notiz gibt.

## 7. Schlaf

### 7.1 Einbettung

Kein neuer Scheduler. `CronJobKind` bekommt `sleep` neben `assistant` und `agent`; der Runner in
`cron/scheduler.ts` ruft fuer diese Art `sleep.run({ owner })` statt einen Assistenten-Turn. Damit erbt der
Schlaf Historie (`cron_runs`), Fehlerbehandlung, Ein/Aus und die bestehende Cron-Seite der UI. Beim ersten
Start wird ein Systemjob `30 3 * * *` mit Geltungsbereich `assistant` angelegt.

Der Lauf ist abbrechbar (`AbortSignal`) und laeuft nie zwei Mal gleichzeitig fuer denselben Besitzer.
Faellt der Rechner nachts aus, holt der naechste Lauf die Zeit einfach mit – es gibt kein Nachholen und
keine Warteschlange.

### 7.2 Die Phasen

Jede Phase ist fuer sich abgeschlossen; ein Fehler in Phase 4 laesst die Ergebnisse aus Phase 1 bis 3
stehen und schreibt trotzdem einen Bericht.

**Phase 1 – Abklingen. Null Modellaufrufe.**
Fuer jede lebende Erinnerung: `staerke = 0.5 * importance + 0.3 * usefulness + 0.2 * recency`. Wer unter
`minStrength` (Standard 0.25) liegt, seit `dormantAfterDays` (Standard 45) nicht abgerufen wurde, nicht
`pinned` ist und nicht `origin = 'user'` hat, bekommt `dormant_at`. Reine SQL-Arbeit.

**Phase 2 – Buendeln. Null Modellaufrufe.**
Kandidatenpaare aus zwei Quellen: die `co_occurs`-Vormerkungen des Tores, und Paare, die mindestens zwei
Entitaeten teilen. Daraus werden ueber eine Union-Find-Struktur Buendel von zwei bis acht Erinnerungen.
Buendel, die nur `pinned` oder `origin = 'user'` enthalten, fallen raus.

**Phase 3 – Verdichten. Bis zu `maxMergeCalls` (Standard 12) Aufrufe.**
Buendel absteigend nach Groesse, ein Modellaufruf je Buendel (`effort: 'low'`, `permission: 'chat'`).
Das Modell ist **nicht** das billigste (Entscheidung E6). Eingabe: die Saetze mit Datum und Wichtigkeit. Ausgabe streng als JSON:

```json
{"merge": true, "content": "...", "kind": "fact", "importance": 0.7, "tags": ["..."], "supersedes": ["id", "id"]}
{"merge": false, "reason": "verschiedene Sachverhalte"}
```

Bei `merge` entsteht **eine** neue Erinnerung mit `origin = 'sleep'` und der `run_id`; jede unter
`supersedes` genannte bekommt `dormant_at` und `superseded_by`, dazu eine `supersedes`-Kante. Ein Satz,
den das Modell nicht ausdruecklich nennt, bleibt unangetastet – Schweigen loescht nie.

**Phase 4 – Verknuepfen. Bis zu 3 Aufrufe.**
Eingabe: die seit dem letzten Lauf neuen Erinnerungen plus deren Entitaets-Nachbarn, in bis zu drei
Portionen. Das Modell liefert Kanten (`refines`, `contradicts`, `caused_by`) und raeumt die Entitaeten auf:
richtiger `kind`, zusammengelegte Schreibweisen. Widersprueche erhoehen `conflict_count` und erscheinen im
Dashboard als Handlungspunkt fuer den Nutzer – automatisch entschieden wird ein Widerspruch nie.

**Phase 5 – Einsicht. Genau 1 Aufruf, hoechstens 2 Ergebnisse.**
Eingabe: die Ereignisse und Projekte der letzten sieben Tage plus die staerksten Entitaeten. Frage: Was
faellt ueber die Einzelsaetze hinaus auf? Ergebnis sind bis zu zwei Saetze vom `kind` `insight`, jeweils
mit `refines`-Kanten auf die Belege, aus denen sie stammen. Eine Einsicht ohne mindestens zwei Belege wird
verworfen. Das ist der Teil, der aus einer Ablage ein Gedaechtnis macht, und deshalb der Teil, der am
striktesten begrenzt gehoert.

**Phase 6 – Bericht. Null Modellaufrufe.**
`sleep_runs` wird abgeschlossen, `report` aus den Zaehlern zusammengesetzt: "42 Erinnerungen gelesen, 6 zu
2 verdichtet, 9 schlafen gelegt, 14 Verbindungen gezogen, 1 Widerspruch gefunden, 1 Einsicht."

Gesamtbudget pro Nacht und Besitzer: hoechstens 16 Aufrufe. Das ist weniger, als ein mittlerer
Arbeits-Turn kostet.

### 7.3 Was der Schlaf niemals tut

- **Nie loeschen.** Er setzt `dormant_at`. Ein `DELETE` passiert ausschliesslich auf ausdrueckliche
  Anweisung des Nutzers (Entscheidung E1).
- **Nie Nutzer-Erinnerungen anfassen.** `origin = 'user'` und `pinned = 1` sind fuer Phase 1 und 3 tabu.
  Sie duerfen Kanten bekommen, sonst nichts (Entscheidung E4).
- **Nie ueber Besitzergrenzen lesen.** Ein Lauf sieht genau einen `owner`. Die Assistenten-Bank und die
  Agenten-Baenke bleiben getrennt, so wie `recall` sie heute trennt.
- **Nie einen Widerspruch entscheiden.** Er meldet ihn.

## 8. Web: das Gehirn sichtbar machen

Die Gedaechtnis-Seite bekommt drei Ansichten und eine Schlafkarte. `MemoryPanel` bleibt als Listenansicht
unveraendert bestehen – sie ist der schnellste Weg, einen Fakt tatsaechlich zu finden.

**Graph.** Entitaeten als grosse Knoten, Erinnerungen als kleine, Kanten als Linien. Groesse nach Staerke,
Farbe nach `kind` ueber die vorhandenen shadcn-Tokens, Schlafende bei 25 Prozent Deckkraft, `contradicts`
in `destructive`. Klick auf einen Knoten oeffnet ein `Sheet` mit dem vollen Satz, seinen Kanten, seiner
Quellsitzung und den Aktionen Anheften, Vergessen, Wecken.

Technisch: **`d3-force` als einzige neue Abhaengigkeit** (nur das Teilpaket, kein volles d3), Simulation in
einem `useEffect`, gerendert als schlichtes SVG von React. Kein `reactflow`: das ist fuer editierbare
Ablaufdiagramme gebaut, bringt eigenes Styling mit und widerspricht der UI-Regel "stock shadcn, moeglichst
kein Customizing". Ein Kraftgraph ist rund 120 Zeilen eigener Code und bleibt damit vollstaendig in
unserer Designsprache.

Gegen den Wollknaeuel: harte Obergrenze von 300 Knoten, Vorauswahl nach Entitaet, `kind` und Zeitraum,
Standardansicht sind die 40 staerksten Entitaeten mit ihren jeweils besten Erinnerungen.

**Zeitachse.** Was wann gelernt wurde, mit den Schlaflaeufen als Markierungen dazwischen. Das macht
sichtbar, was die Nacht getan hat, und ist die ehrlichste Darstellung eines Gedaechtnisses, das waechst.

**Schlafkarte.** Letzter Lauf mit seinem Bericht, naechster Termin, Schalter "Jetzt schlafen" und pro Lauf
"Diese Nacht rueckgaengig machen". Verdichtungen sind einzeln aufklappbar: neuer Satz oben, die ersetzten
darunter.

**Orb.** Waehrend ein Lauf aktiv ist, zeigt der Orb auf dem Assistenten-Bildschirm einen ruhigen
Schlafzustand. Eine Zeile Zustandsanbindung, mehr nicht – aber es ist der Moment, in dem das Konzept fuer
den Nutzer greifbar wird.

## 9. API

Bestehende Routen in `packages/server/src/routes/memories.ts` bleiben unveraendert.

| Route | Zweck |
| --- | --- |
| `GET /api/memories/graph` | Knoten und Kanten fuer die Graph-Ansicht. Parameter `owner`, `entity`, `kind`, `since`, `limit`. |
| `GET /api/memories/:id/edges` | Nachbarschaft einer Erinnerung fuer das Detail-Sheet. |
| `GET /api/entities` | Entitaeten mit Erwaehnungszahl, fuer Filter und Autovervollstaendigung. |
| `PATCH /api/memories/:id` | `pinned`, `importance`, `content`, Wecken (`dormant_at` zurueck auf `null`). |
| `GET /api/sleep/runs` | Verlauf der Schlaflaeufe eines Besitzers. |
| `POST /api/sleep/run` | Lauf von Hand ausloesen. |
| `POST /api/sleep/runs/:id/undo` | Eine Nacht zuruecknehmen. |

Der Assistent selbst bekommt ueber den Rookery-MCP-Server nur ein einziges neues Werkzeug: `sleep_now`.
Verdichten, Kanten ziehen und Einsichten schreiben darf er nicht von Hand – das ist Aufgabe des Laufs, mit
Protokoll.

## 10. Konfiguration

Unter `memory` in `packages/core/src/config.ts`:

```
gate:  { maxPerTurn: 3, minImportance: 0.4, duplicateThreshold: 0.82, clusterThreshold: 0.55 }
graph: { hopEntity: 0.45, hopEdge: 0.6, maxNodes: 300 }
sleep: { enabled: true, schedule: '30 3 * * *', scope: 'assistant',
         maxMergeCalls: 12, dormantAfterDays: 45, minStrength: 0.25, insights: 2 }
```

Alles ueber `rookery config set` erreichbar, wie `memory.recallLimit` heute. `sleep.enabled: false` schaltet
den Nachtlauf ab, ohne den Rest zu beruehren.

## 11. Umsetzung in Phasen

| Phase | Inhalt | Ergebnis | Tests in `packages/core/test` |
| --- | --- | --- | --- |
| **1 – Tor** | `memory/gate.ts` mit Normalisierung und Dice-Aehnlichkeit, passende statt wichtigste `known` in beiden `#learn`, `maxPerTurn` und `minImportance`, `usefulness`-Spalte, gedaempfte Verstaerkung | Das Wachstum hoert auf, ohne Schema-Umbau und ohne UI-Arbeit | Dice-Schwellen; "gleicher Satz anders formuliert erzeugt keinen zweiten Datensatz"; "Verstaerkung hebt `usefulness` nicht" |
| **2 – Struktur** | Schema 5, `memory_entities`, `memory_entity_links`, `memory_edges`, Tags werden zu Entitaeten, zweiter Sprung in `recall`, `dormant_at`-Filter, `GET /api/memories/graph` | Der Abruf findet Verwandtes ohne Wortgleichheit | Zwei-Sprung-Abruf findet den Satz, den der erste Sprung nicht trifft; haeufige Entitaet zieht nicht alles hoch; Schlafende tauchen nie auf |
| **3 – Schlaf** | `memory/sleep.ts` mit allen sechs Phasen, `sleep_runs`, `CronJobKind` `sleep`, Systemjob, Undo in einer Transaktion | Die Nacht raeumt auf, jede Nacht ist umkehrbar | Lauf gegen eine Testbank: verdichtet, legt schlafen, loescht nichts; Undo stellt exakt den Vorzustand her; `origin = 'user'` bleibt unberuehrt; Budget wird nie ueberschritten |
| **4 – Sichtbarkeit** | Graph mit `d3-force`, Zeitachse, Schlafkarte mit Undo, Detail-Sheet, Orb-Zustand | Der Nutzer sieht, was der Assistent weiss und was die Nacht getan hat | Render-Pruefungen im Stil von `tui-render-check.mjs`; Graph mit 300 Knoten bleibt bedienbar |
| **5 – Einsicht** | Phase 5 des Laufs, `insight` als `kind`, Widerspruchs-Handlungspunkte im Dashboard, Schlaf fuer Agenten-Baenke | Das Gedaechtnis zieht eigene Schluesse, nachvollziehbar belegt | Einsicht ohne zwei Belege wird verworfen; Widerspruch wird gemeldet, nie entschieden |

Phase 1 ist unabhaengig und sollte vor allem anderen laufen: Sie loest die Beschwerde, mit der dieses
Konzept angefangen hat, und sie macht jede spaetere Phase billiger, weil weniger Datensaetze zu verdichten
sind.

## 12. Entscheidungen und offene Fragen

### Vorgeschlagen

**E1 – Automatisch wird nie geloescht.** Der Schlaf legt schlafen (`dormant_at`), er entfernt nichts. Ein
`DELETE` gibt es nur, wenn der Nutzer es ausloest. Ein Prozess, der nachts unbeaufsichtigt am Gedaechtnis
arbeitet, darf keine unwiederbringlichen Schritte tun.

**E2 – Keine Embeddings.** Naehe kommt aus geteilten Entitaeten, Duplikate aus lexikalischer Aehnlichkeit,
Bedeutung aus nachts gezogenen Kanten. Das haelt Rookery frei von nativen Abhaengigkeiten und passt zu
`node:sqlite` mit FTS5.

**E3 – Jede Nacht ist rueckgaengig zu machen.** Alles, was ein Lauf schreibt, traegt seine `run_id`; Undo
ist eine Transaktion. Ohne das ist ein selbstaendig arbeitender Nachtlauf nicht zumutbar.

**E4 – Was der Nutzer geschrieben hat, ist unantastbar.** `origin = 'user'` und `pinned = 1` werden weder
schlafen gelegt noch verdichtet.

**E6 – Der Schlaf laeuft nicht auf dem billigsten Modell.** Standard ist Sonnet fuer alle drei
Modellphasen (`memory.sleep.model`, `memory.sleep.insightModel`). Verdichten heisst entscheiden, ob zwei
Saetze denselben Sachverhalt meinen, Verknuepfen heisst Widersprueche erkennen, und die Einsicht ist die
schwerste Aufgabe im System. Ein zu schwaches Modell verschmilzt Unzusammengehoeriges oder schreibt
Plattitueden. Das Kostenargument traegt hier nicht: sechzehn Aufrufe einmal pro Nacht sind billig, ein
falsch verschmolzenes Paar ist es nicht. Entschieden am 2026-09-10 von Jonas.

**E5 – Widersprueche werden entschieden, nicht nur gemeldet.** *Geaendert am 2026-09-11 auf Wunsch von
Jonas; die urspruengliche Fassung meldete nur.* Zwei Saetze, die nicht beide stimmen koennen, sind kein
Kuriosum, sondern ein Defekt: je nachdem, welchen der Abruf hochspuelt, liegt der Assistent die Haelfte
der Zeit falsch. Der Tiefschlaf entscheidet daher im Modellaufruf, welche Seite gilt; die andere wird
weggeraeumt (`dormant_at` plus `superseded_by`), nicht geloescht, und die Nacht bleibt umkehrbar. Zwei
Faelle erreichen nie ein Modell: sind beide Seiten geschuetzt, bleibt der Widerspruch beim Nutzer; ist
genau eine geschuetzt, gewinnt sie, weil eine eigene Aussage des Nutzers jede Ableitung schlaegt.

**E7 – Der Schlaf hat Phasen, keine Schrittliste.** Leichtschlaf raeumt ohne Modell auf, Tiefschlaf
verdichtet und entscheidet, Traumschlaf verknuepft und zieht Schluesse. Der Zyklus wiederholt sich
(Standard zweimal), weil die Phasen einander fuettern: der Traumschlaf findet die Widersprueche, die der
naechste Tiefschlaf entscheidet. Entschieden am 2026-09-11 von Jonas.

**E8 – Der Graph wird dreidimensional dargestellt.** Die flache SVG-Zeichnung wurde ab etwa dreissig
Knoten zum Knaeuel. `3d-force-graph` ueber WebGL, per dynamischem Import in ein eigenes Buendel gelegt.
Entschieden am 2026-09-11 von Jonas.

**E9 – Der Graph ist ein Cortex, kein Federmodell.** Das Kraeftelayout aus E8 wurde auch in drei
Dimensionen zur Kugel aus Draht und sah bei jedem Laden anders aus. Seit 2026-09-19 liegt eine feste
Gehirnform zugrunde (`packages/web/src/components/memory-cortex/layout.ts`: zwei Hemisphaeren, Fissur,
flache Unterseite, Kleinhirn, Windungen): Entitaeten sind Regionen der Rinde und ziehen einander an,
wenn dieselbe Erinnerung sie nennt; Erinnerungen sind Neuronen auf der Oberflaeche nahe ihren Themen,
ohne Thema liegen sie im Inneren, schlafend sinken sie unter die Oberflaeche. Jede Position ist aus der
Zeilen-ID gehasht, ein Filter verschiebt darum nichts, was sich nicht geaendert hat. Gezeichnet wird mit
eigenem three.js-Code (`scene.ts`: ein verformtes, beleuchtetes Mesh der Gehirnform als Gewebe, das die
Rueckseite verdeckt; additive Glow-Punkte darauf, Erinnerungen ohne Thema als eigene Wolke im Inneren
ohne Tiefentest; ein einziger `LineSegments`-Puffer fuer alle Fasern als Boegen ueber der Oberflaeche;
Signale, die an den Fasern entlanglaufen; wenig Bloom). Laeuft eine Nacht, feuert die Rinde staerker und in der Traumfarbe
(`--graph-dream`). Die Buehne ist in beiden Themes dunkel. `3d-force-graph` und `three-spritetext` sind
entfallen, `three` ist direkte Abhaengigkeit. Vorlagen, mit Dank: der fuenflappige Punkt-Glow und der
verschmolzene Faserpuffer aus pratapchoudharys Brain-Portfolio, die Faden-Partikel aus SahilK-027s
Digital Brain (beide MIT); keines ist Abhaengigkeit. Entschieden am 2026-09-19 von Jonas.

### Offen

1. **Schema-Nummer.** Dieses Konzept braucht Version 5, das HR-Konzept in
   `docs/concepts/agent-performance-management.md` beansprucht ebenfalls die naechste Nummer (dort noch als
   3 nach 4 notiert, waehrend `SCHEMA_VERSION` bereits auf 4 steht). Wer zuerst gebaut wird, nimmt die 5.
   Beruehrungspunkt ist `memories`: dort will das HR-Konzept `archived_at`, dieses hier `dormant_at`. Zwei
   verschiedene Sachverhalte, beide Spalten werden gebraucht.
2. **Wie oft schlafen Agenten?** Vorschlag: der Assistent jede Nacht, ein Agent erst, wenn er seit dem
   letzten Lauf 20 neue Erinnerungen hat, hoechstens einmal pro Woche. Sonst laufen bei zehn Agenten zehn
   Naechte parallel.
3. **Schlafen, waehrend jemand redet?** Vorschlag: ein laufender Chat verschiebt den Start um 15 Minuten,
   hoechstens drei Mal. Danach laeuft er trotzdem – die Schreibvorgaenge sind kurz und transaktional.
4. **Sitzungsverlaeufe als Quelle.** Heute liest die Extraktion nur den einzelnen Turn. Der Schlaf koennte
   zusaetzlich ganze Sitzungen des Tages lesen und daraus Verlaufserinnerungen ziehen. Reizvoll, aber
   deutlich teurer; bewusst nicht Teil dieses Konzepts.
5. **Zwei Baenke, ein Bild?** Ob die Graph-Ansicht zwischen Assistenten- und Agenten-Baenken umschaltet
   oder alle nebeneinander zeigt, ist eine reine UI-Frage – die Trennung im Abruf bleibt davon unberuehrt.
