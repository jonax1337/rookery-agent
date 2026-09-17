# Traum — Bauplan Stufe 1

Stand: 2026-09-17. **Bauplan, nicht Konzept.** Das Konzept ist
`docs/concepts/dream-and-recursive-self-improvement.md` (Fassung 2); dieses
Dokument uebersetzt genau die **erste Ausbaustufe** desselben in
Arbeitspakete, die mehrere Agenten parallel abarbeiten koennen, ohne
einander in dieselbe Datei zu schreiben.

Geprueft gegen den Arbeitsbaum `E:/DEV/rookery-dream` bei `SCHEMA_VERSION 18`.
Alle Zeilenangaben in diesem Dokument sind **selbst nachgelesen** und weichen
an mehreren Stellen vom Konzept ab. Wo sie abweichen, gilt dieses Dokument —
mit einer Warnung: Zeilennummern altern. Jedes Paket sucht vor dem Schnitt den
zitierten Wortlaut, nicht die Zahl.

**Zuordnung Stufe/Phase.** Das Konzept gliedert die Umsetzung in Phasen
(Abschnitt 11). "Stufe 1" in diesem Plan entspricht dort **Phase 1** samt der
vorgezogenen **Phase 0** (Zuflussmessung, siehe AP11). Wo dieser Plan von
"Phase N" spricht, ist immer die Konzept-Phase gemeint: Phase 2 = Etiketten,
Phase 3 = Kandidatenschreiber und Befoerderungstor, Phase 4 = Sichtbarkeit,
Phase 5 = `budget`/`retry`. Die Konzept-"Stufe 2" (Divergenzprobe) ist dort
**Phase 6** und liegt ausserhalb dieses Plans — die Form "Stufe 2" ohne
Zusatz kommt hier deshalb nicht vor.

Stufe 1 liefert Wert und **befoerdert nichts**. Kein Modellaufruf, keine
`policy_versions`-Tabelle, kein Kandidatenschreiber, kein Tor-Slot.

---

## 0. Die Entscheidungen des Verantwortlichen, und wo sie landen

Nicht neu verhandeln. Diese Tabelle ist die Abnahmeliste: jede Zeile muss in
mindestens einem Paket wiederzufinden sein.

| # | Entscheidung | Paket |
|---|---|---|
| R1 | `usefulness`/`memory_touches` sind keine Etikettenquellen; `source` = `correction \| review \| merge \| user`; bleiben Merkmale im Rahmen | AP4, AP6 |
| R2 | Der Schaetzer ist eine **untere Schranke**; Abdeckungsrate je Bewertung; Delta ueberwiegend aus unetikettierten Positionen = ungueltig | AP8, AP10 |
| R3 | Eingefrorener Pruefsatz; Befoerderungsbedingung kumulativ gegen den Werksvorgabe-Parametersatz | AP4 (Feld), AP7 (Spalte), sonst Phase 3 |
| R4 | "Umkehrbar in Parametern, nicht in Zaehlern"; `memory_touches` append-only mit `policy_id` | AP1, AP7 |
| R5 | `gate`-Slot faellt aus Stufe 1; Ersatz "Erst-Divergenz-Bewertung" erst mit eigenem Messziel | — (ausdruecklich ausgeschlossen, §1.2) |
| R6 | Jeder Lesezugriff des Traums hat `touch: false` fest verdrahtet, mit Test | AP6, AP9, AP10 |
| R7 | Frisch-Test **vor** der Zyklusschleife, direkt nach der Replay-Phase | AP10 |
| R8 | Modellfreie Bewertung **ueber** `if (!provider || !budgets) continue`, mit eigener Wanduhr-Obergrenze | AP10 |
| R9 | Rekorderschreibvorgaenge in `SAVEPOINT`/`RELEASE`, kein Waechter-Flag | AP7 |
| R10 | Korpus-Waechter ueber `fts5vocab`-Dokumentfrequenz der **Rahmen**-Tokens, einmal je Nacht in `meta` | AP1 (Tabelle), AP7 (Berechnung), AP10 (Aufruf) |
| R11 | Vier Gleichstandsbrecher + alle In-JS-Sortierungen auf `(score desc, id asc)` | AP2, AP3, AP9 |
| R12 | Profil an der permissivsten Ecke aufzeichnen, je Kandidat schneiden | AP6 |
| R13 | H9 (skalares Vielfaches), Gewichte in `scoreFrame` auf Summe 1, `coreProfile` auf derselben Skala mit Profilvorrang | AP2, AP6, AP8, AP11 |
| R14 | Das Ideal wird mit **demselben** Renderer gerendert wie P | AP8 |
| R15 | Nachbearbeitungskette ist ein Feld des Rahmens (`pipeline`), je Pipeline ein Aequivalenztest | AP6 |
| R16 | `dream.enabled` / `dream.record` / `dream.promote` getrennt; Schluesseltabelle mit Leserstelle; kein Schluessel ohne Leser | AP4 |
| R17 | Rahmen sind Wortlautspeicher: Loeschpfade erreichen sie; kein `pinned` (`dream_evals.evidence_digest` erfuellt die Begruendungspflicht ab Phase 3); Satz in `10.5` | AP1, AP7, AP9 |
| R18 | Stufe 1–4 nur `ASSISTANT_MEMORY_OWNER`, auch der Rekorder; `dream.maxCallsPerNight` laufglobal | AP4, AP9, AP10 |
| R19 | Spur = eine Zeile je **Aufruf**, `turn_id` gruppiert; Etiketten am `turn_id`; `site` bekommt `inspect`; Rekorder an der Aufrufstelle | AP1, AP7, AP9 |
| R20 | Drei Faktenfehler + `sumOf(keys)`-Fehler korrigiert; `keys = [...volume, ...judgement]` | AP10 |
| R21 | Leckage-Test ist ein **Konstruktionstest**; thematische Naehe als unvermessener Rest benannt | Phase 3 (hier nur §7 dokumentiert) |
| R22 | Vorgezogene Fremdarbeiten: `busy_timeout`, `meta.schema_version` lesen, `SLEEP_PHASES` um `replay` | AP1, AP5 |

R3, R21 und Teile von R4 betreffen Maschinerie, die Stufe 1 nicht baut. Sie
erscheinen hier nur, wo Stufe 1 die **Aufzeichnung** dafuer anlegen muss —
alles andere steht in §7 als ausdruecklich offen.

Zu R22: Das Konzept (9.7) verlangt fuer die vorgezogenen Fremdarbeiten eigene
Commits **vor Phase 1**. Der Plan loest das ohne zusaetzliche Welle: AP1 und
AP5 liegen in Welle 1, aber ihre Fremdarbeits-Commits werden **als erste**
der Stufe gereicht und gemergt, bevor irgendein anderes Paket der Welle 1
aufgegeben wird — der Commit ist vor Phase 1, auch wenn das Paket es baut.

---

## 1. Was Stufe 1 ist, und was sie ausdruecklich nicht ist

### 1.1 Umfang

1. Der `fetchFrame`/`scoreFrame`-Schnitt **ohne Verhaltensaenderung** an `recall`.
2. Die vier Gleichstandsbrecher plus alle In-JS-Sortierungen.
3. `entitiesForMany` und der partitionierte Nachbarabruf.
4. `resolvePolicy` als einzige Wahrheit ueber die `recall`-Parameter - geliefert fuer den Assistentenpfad (AP9); der Agentenaufruf in `org/controller.ts` bleibt in Stufe 1 bewusst roh, ihn umzuleiten waere bei abweichendem `memory.graph` eine Verhaltensaenderung (R15).
5. Schema 21: `dream_traces`, `dream_frames`, `memory_touches`, `dream_labels` (leer, ohne Schreiber) und drei `sleep_runs`-Zaehler.
6. Der gesampelte Rekorder in einer `SAVEPOINT`-Transaktion, nur `site='turn'`, nur Assistenten-Owner.
7. Das Blockmass aus Konzept 5.2 mit auf 1 normierten Gewichten.
8. Die Gitterprobe ueber 8–12 feste Belegungen.
9. Der Frisch-Test an der korrigierten Stelle (vor der Zyklusschleife).
10. Groessen- und Latenzmessung mit hartem Budgettor.
11. Die Aequivalenz-Testsuite **je Pipeline**.

### 1.2 Ausdruecklich nicht

* Kein `gate`-Slot (R5), also kein Tor-Rahmen, keine Praefix-Gueltigkeit.
* Keine `policy_versions`, kein `dream_slot_state`, kein `dream_evals`. Die Tabelle
  `dream_labels` wird als **leeres Schema** angelegt (Konzept 8.3), damit die
  Etikettenstufe Phase 2 kein Schema 20 braucht — aber sie hat in Stufe 1 keinen Schreiber.
* Kein Kandidatenschreiber, kein Modellaufruf, keine Befoerderung, keine Ruecknahme.
* Keine HTTP-Route, keine Web-Seite, kein Tab (Konzept 9.6: kein vierter `/memory`-Kindpfad).
* Kein Etikettenschreiber. Stufe 1 misst mit dem Gitter gegen den Amtsinhaber, nicht gegen Etiketten — die Abdeckungsrate (R2) wird **berichtet**, nicht erfuellt.
* `dream.promote` kommt erst mit Phase 3 in die Konfiguration: in Stufe 1 haette der Schluessel keinen Leser, und R16 verbietet das.

### 1.3 Die zwei erklaerten Verhaltensaenderungen

Stufe 1 ist "ohne Verhaltensaenderung" mit **genau zwei** benannten Ausnahmen,
beide in AP2, in je einem eigenen Commit mit eigenem Test und damit einzeln
umkehrbar:

1. **Profilskala (R13).** `coreProfile` gibt nicht mehr das Literal `1`
   zurueck, sondern einen Score auf der Abrufskala; die Gewichte werden in
   `scoreFrame` auf Summe 1 normiert (fuer den Amtsinhaber ein Nullschritt).
2. **Profilvorrang.** `PROFILE_LEAD = RECALL_CEILING` sorgt dafuer, dass keine
   Profilzeile mehr hinter einem Direkttreffer landet. Heute kann ein
   Direkttreffer (bis 1.1) eine Profilzeile (Literal 1) aus dem Kopf des
   Blocks verdraengen — danach nicht mehr. Das ist streng genommen eine zweite
   Verhaltensaenderung und wird als solche benannt und gemessen: AP11 faehrt
   dafuer einen dritten Lauf vorher/nachher (innerhalb und ausserhalb beider
   Commits), damit keine der beiden still bleibt.

Alles andere in Stufe 1 aendert hoechstens, **welche** von zwei bisher
gleichwertigen Zeilen gewaehlt wird — also eine bestehende
Nichtdeterminiertheit, kein neues Verhalten.

---

## 2. Dateibesitz — die Karte

Ein Paket **schreibt** nur seine Zeile. Zwei Pakete derselben Welle teilen nie
eine Datei.

| Datei | Paket | Welle |
|---|---|---|
| `packages/core/src/memory/db.ts` | AP1 | 1 |
| `packages/core/src/memory/recall.ts` | AP2, dann AP6 | 1, dann 2 |
| `packages/core/src/memory/store.ts` | AP3, dann AP7 | 1, dann 2 |
| `packages/core/src/types.ts` (inkl. der gemeinsamen Traum-Typen) | AP4 | 1 |
| `packages/core/src/config.ts` | AP4 | 1 |
| `packages/server/src/schemas.ts` | AP4 | 1 |
| `packages/web/src/pages/MemoryLayout.tsx` | AP5 | 1 |
| `packages/core/src/memory/dream/frame.ts` (neu) | AP6 | 2 |
| `packages/core/src/memory/dream/score.ts` (neu) | AP6 | 2 |
| `packages/core/src/memory/dream/policy.ts` (neu) | AP6 | 2 |
| `packages/core/src/memory/dream/measure.ts` (neu) | AP8 | 3 |
| `packages/core/src/memory/dream/probe.ts` (neu) | AP10 | 4 |
| `packages/core/src/index.ts` | AP6, dann AP8, dann AP10 | 2, 3, 4 |
| `packages/core/src/runtime.ts` | AP9 | 3 |
| `packages/core/src/org/controller.ts` | AP9 | 3 |
| `packages/server/src/server.ts` | AP9 | 3 |
| `packages/core/src/memory/sleep.ts` | AP10 | 4 |
| `scripts/dream-bench.mjs` (neu) | AP11 | 4 |

### 2.1 Die drei unvermeidbar geteilten Dateien

**`recall.ts`** — AP2 (Gleichstandsbrecher, Profilskala) und AP6 (der Schnitt)
brauchen beide die Datei. **Reihenfolge statt Parallelitaet:** AP2 ist in
Welle 1 fertig, bevor AP6 in Welle 2 anfaengt. AP6 darf keinen der
AP2-Gleichstandsbrecher beim Umbau verlieren; sein Aequivalenztest prueft das
mit, weil er die Ausgabeordnung als total voraussetzt.

**`store.ts`** — AP3 (SQL-Determinismus, `entitiesForMany`) und AP7
(Rekorder-Persistenz, `sleep_runs`-Zaehler). Ebenfalls sequenziell: AP3 in
Welle 1, AP7 in Welle 2. AP3 fasst **keine** Traum-Tabelle an, AP7 fasst
**keine** bestehende SQL an ausser `touchMemories` und den drei
Loeschmethoden `forgetMemory`/`deleteMemory`/`archiveMemories`, die je eine
Zeile fuer die Rahmenmitloeschung bekommen (R17) — beides in eigenen Commits.

**`packages/core/src/index.ts`** — drei Pakete haengen je eine Exportzeile an
(AP6, AP8, AP10). Sie liegen in drei **verschiedenen** Wellen, also nie
gleichzeitig. Regel: Exporte werden ans Ende des Speicherblocks angehaengt,
nie umsortiert. Kein Barrel unter `memory/dream/`: ein Sammel-`index.ts` waere
genau die Datei, an der sich drei Pakete treffen.

---

## 3. Die Arbeitspakete

### AP1 — Schema 21 und Verbindungshygiene

**Schreibt (exklusiv):** `packages/core/src/memory/db.ts`
**Liest:** `packages/core/src/memory/store.ts` (Hausstil), `packages/core/src/types.ts`
**Neue Testdatei:** `packages/core/test/dream-schema.test.js`
**Haengt ab von:** nichts. Welle 1.

**Einfuegepunkte**

* `db.ts:12` — `export const SCHEMA_VERSION = 18;` wird `19`.
* `db.ts:25` — hinter `db.exec('PRAGMA synchronous = NORMAL');` neu:
  `db.exec('PRAGMA busy_timeout = 5000');`. Vorgezogene Fremdarbeit (R22): die
  CLI oeffnet dieselbe Datei in einem eigenen Prozess, der Traum fuegt eine
  Transaktion je gerahmtem Turn hinzu. Eigener Commit, eigener Kommentar.
* `db.ts:26` — **vor** `migrate(db);` ein Aufruf `assertSchemaNotNewer(db);`.
  Die Funktion liest `meta.schema_version`, aber nur wenn `meta` in
  `sqlite_master` steht (eine frische Datei hat sie noch nicht), und wirft bei
  einem Wert `> SCHEMA_VERSION`. Vorgezogene Fremdarbeit (R22): heute wird die
  Zahl bei `db.ts:718-721` geschrieben und nirgends gelesen.
* `db.ts:318` — zwischen dem `skill_versions`-Block (`db.ts:309`) und dem
  `memories_fts`-Block (`db.ts:323`) ein neuer `db.exec()`-Block mit den drei
  Tabellen:

```sql
CREATE TABLE IF NOT EXISTS dream_traces (
  id            TEXT PRIMARY KEY,
  turn_id       TEXT NOT NULL,              -- gruppiert die Aufrufe eines Turns
  owner         TEXT NOT NULL,
  kind          TEXT NOT NULL,              -- turn | assignment | night
  site          TEXT NOT NULL,              -- turn | extract | tool | inspect
  pipeline      TEXT NOT NULL,              -- assistant | agent
  session_id    TEXT,
  session_kind  TEXT,                       -- chat | voice | mail | schedule
  assignment_id TEXT,
  sleep_run_id  TEXT,
  turn_index    INTEGER NOT NULL DEFAULT 0,
  policy_set    TEXT NOT NULL,              -- JSON: geltender Parametersatz je Slot
  framed        INTEGER NOT NULL DEFAULT 0,
  holdout       INTEGER NOT NULL DEFAULT 0,
  audit         INTEGER NOT NULL DEFAULT 0, -- eingefrorener Pruefsatz (R3)
  degraded      TEXT,                       -- NULL | no-tokens | fts-threw
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dream_traces_owner   ON dream_traces(owner, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dream_traces_session ON dream_traces(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_dream_traces_turn    ON dream_traces(turn_id);
CREATE INDEX IF NOT EXISTS idx_dream_traces_open    ON dream_traces(finished_at);

CREATE TABLE IF NOT EXISTS dream_frames (
  trace_id        TEXT NOT NULL REFERENCES dream_traces(id) ON DELETE CASCADE,
  slot            TEXT NOT NULL,            -- recall
  frame_v         INTEGER NOT NULL,
  owner           TEXT NOT NULL,            -- fuer die Loeschpfade, ohne payload zu lesen (R17)
  session_id      TEXT,                     -- dito
  box             TEXT NOT NULL,            -- JSON
  corpus_stamp_id TEXT NOT NULL,            -- verweist auf den df-Stempel der Nacht in meta (R10)
  payload         TEXT NOT NULL,            -- JSON: der ganze Rahmen
  bytes           INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (trace_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_dream_frames_age   ON dream_frames(created_at);
CREATE INDEX IF NOT EXISTS idx_dream_frames_owner ON dream_frames(owner, session_id);

CREATE TABLE IF NOT EXISTS dream_labels (
  turn_id    TEXT NOT NULL,
  target     TEXT NOT NULL,                 -- memory id oder '*' (Konzept 4.2d)
  source     TEXT NOT NULL,                 -- correction | review | merge | user
  relevance  REAL NOT NULL,                 -- 1 = belegt relevant, 0 = belegt irrelevant
  scope      TEXT NOT NULL,                 -- turn | session
  evidence   TEXT,
  dead_at    INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (turn_id, target, source)
);
CREATE INDEX IF NOT EXISTS idx_dream_labels_target ON dream_labels(target);

CREATE TABLE IF NOT EXISTS memory_touches (
  id        TEXT PRIMARY KEY,
  owner     TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  turn_id   TEXT,
  trace_id  TEXT REFERENCES dream_traces(id) ON DELETE CASCADE,
  policy_id TEXT,                           -- policy_versions.id, NULL bis Phase 3 (R4)
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_touches_memory ON memory_touches(memory_id, at);
CREATE INDEX IF NOT EXISTS idx_memory_touches_owner  ON memory_touches(owner, at);
CREATE INDEX IF NOT EXISTS idx_memory_touches_trace  ON memory_touches(trace_id);
```

* `db.ts:235` — in die `hasColumn`-Kette fuer `sleep_runs` (Hausstil wie
  `resolved_count` bei `db.ts:220`) drei Spalten, je mit Kommentar
  "Schema 18 -> 19":
  `dream_traces_seen`, `dream_frames_scored`, `dream_candidates`,
  alle `INTEGER NOT NULL DEFAULT 0`.
  **`dream_promoted` kommt nicht** — in Stufe 1 haette der Zaehler keinen
  Schreiber.
* `db.ts:842` — `reindex` setzt beim Ausfuehren
  `meta['dream.corpus_invalidated_at'] = now` (eine Zeile, eigener Commit);
  der Bulk-Importpfad schreibt denselben Schluessel. AP10 liest ihn als
  Invalidierungsgrund (Konzept 3.3: beide verschieben den Korpusstempel
  sprunghaft und muessen die Rahmen davor fuer ungueltig erklaeren).

**Bewusste Abweichungen vom Konzept (Fassung 2)**

* Die Zaehler weichen von Konzept 8.8 ab:
  `dream_frames_scored` ist **zusaetzlich** angelegt und traegt in Stufe 1 die
  Gitterbelegungen der Nachtprobe; `dream_candidates` bleibt dem Zaehler
  **modellgeschriebener Kandidaten** vorbehalten (Konzept 6.2) und steht in
  Stufe 1 auf 0 — sein Schreiber kommt mit Phase 3. So belegt die Spalte nicht
  in Stufe 1 eine Bedeutung, die Phase 3 still umschreibt. `dream_promoted`
  fehlt (kein Schreiber).
* `dream_labels` wird als leere Tabelle angelegt (Konzept 8.3), hat aber in
  Stufe 1 keinen Schreiber — sonst braeuchte Phase 2 ein Schema 20, das das
  Konzept nicht vorsieht.

**Tests** — `packages/core/test/dream-schema.test.js`

* `openDatabase(':memory:')`; `SELECT value FROM meta WHERE key='schema_version'` -> `'19'`.
* `SELECT name FROM sqlite_master WHERE type='table'` enthaelt alle vier Namen
  (inklusive `dream_labels`).
* `PRAGMA busy_timeout` -> `5000`.
* `PRAGMA table_info(sleep_runs)` enthaelt `dream_traces_seen`,
  `dream_frames_scored`, `dream_candidates`, jeweils `notnull === 1` und
  `dflt_value === '0'`.
* **Abwaertsbremse:** Datei in `mkdtempSync` anlegen, oeffnen, schliessen,
  `meta.schema_version` von Hand auf `'99'` setzen, erneut oeffnen ->
  `assert.throws(() => openDatabase(path), /newer/)`.
* **Frische Datei wirft nicht:** `assert.doesNotThrow` auf einem leeren Pfad.
* **Kaskade:** eine `dream_traces`-Zeile plus zwei `memory_touches`-Zeilen;
  `DELETE FROM dream_traces` -> `SELECT COUNT(*) FROM memory_touches` ist `0`
  (`PRAGMA foreign_keys = ON` steht bei `db.ts:24`).
* **Idempotenz:** zweimaliges `openDatabase` auf derselben Datei wirft nicht.

**Fallen**

* Die Nummer **19** kann mit dem Schwester-Arbeitsbaum `E:\DEV\rookery-agent`
  kollidieren, der derzeit nur das unversionierte Konzeptdokument selbst
  traegt (Konzept, offene Frage 12) — kollidieren kann die Nummer, sobald dort
  Aenderungen an `memory/db.ts` einlaufen. Vor dem Zusammenfuehren pruefen.
* `migration.test.js`, `migration-cron.test.js` und `migration-scripts.test.js`
  sind Bestand und muessen gruen bleiben.
* Kein `ALTER TABLE` ohne `hasColumn`-Waechter.
* `assertSchemaNotNewer` darf nicht selbst migrieren und nicht schreiben.

**Fertig heisst:** `npm run build:core` gruen, `dream-schema.test.js` gruen,
alle bestehenden Migrationstests gruen, `npm run typecheck` gruen.

---

### AP2 — Gleichstandsbrecher und Profilskala in `recall.ts`

**Schreibt (exklusiv):** `packages/core/src/memory/recall.ts`
**Liest:** `packages/core/src/memory/store.ts`, `packages/core/src/types.ts`
**Neue Testdatei:** `packages/core/test/recall-determinism.test.js`
**Haengt ab von:** nichts. Welle 1.
**Blockiert:** AP6 (gleiche Datei, Welle 2).

Zwei getrennte Commits fuer Determinismus und Skala, plus ein dritter fuer den
Vorrang — jeder einzeln zuruecknehmbar.

**Commit A — Determinismus (kein neues Verhalten, nur Festlegung bei Gleichstand)**

* `recall.ts:29` — neuer Helfer neben `RECENCY_HALF_LIFE_MS`:
  `const byScoreThenId = (a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);`
* `recall.ts:107` — `` ` ORDER BY relevance DESC LIMIT ?` `` wird
  `` ` ORDER BY relevance DESC, m.id LIMIT ?` `` (R11, Gleichstandsbrecher 1).
  Ohne ihn ist die Zeile am `limit * 4`-Rand bei gleichem bm25 nicht festgelegt.
* `recall.ts:146` — `.sort((a, b) => b.score - a.score)` auf `direct` wird
  `.sort(byScoreThenId)`.
* `recall.ts:161` — dieselbe Ersetzung auf `top`.
* `recall.ts:228` — `return [...out.values()];` in `expand` wird
  `return [...out.values()].sort(byScoreThenId);` (R11: `out` gibt heute
  Einfuegereihenfolge zurueck).
* `recall.ts:280` — `ORDER BY pinned DESC, (kind = 'insight') DESC, importance DESC, updated_at DESC`
  wird `..., updated_at DESC, id` (R11, Gleichstandsbrecher 3).
* `recall.ts:390` — `grouped.sort((a, b) => b.memories.length - a.memories.length)`
  bekommt `|| (a.entity.id < b.entity.id ? -1 : 1)`.
* `recall.ts:391` — `loose.sort((a, b) => b.score - a.score)` wird
  `loose.sort(byScoreThenId)`.

**Commit B — `coreProfile` auf der Abrufskala (R13, die erste erklaerte Verhaltensaenderung)**

* `recall.ts:28` — neben `WEIGHTS` die Konstante
  `const PROFILE_LEAD = 1;` — der untere Rand der Abrufskala; die Summe der
  vier Gewichte ist **genau 1.00** (`0.55 + 0.2 + 0.15 + 0.1`, nachgelesen bei
  `recall.ts:28`), plus der `tagHit`-Aufschlag von `0.1` bei `recall.ts:129`,
  also ist `1` das alte Literal und zugleich der Skalenfuss.
* `recall.ts:289` — `score: 1` wird
  `score: PROFILE_LEAD + (record.pinned ? 1 : 0) + (record.kind === 'insight' ? 0.5 : 0) + WEIGHTS.importance * record.importance + WEIGHTS.recency * recencyOf(record.updatedAt, now)`.

Warum: heute tragen **alle** Profilzeilen denselben Wert `1`. Der Merge in
`runtime.ts:472-477` ist ein stabiles `sort`, also entscheidet die
Einfuegereihenfolge der `Map` — und damit die SQL-Reihenfolge aus `recall.ts:280`,
die bis Commit A keinen eindeutigen Schluessel hatte — welche Profilzeile im
2400-Zeichen-Block oben steht. Das repariert Commit B mit einer Zahl.
Die Aufschlaege sind so gewaehlt, dass die Ordnung mit der SQL-Ordnung
uebereinstimmt: `pinned` (1.0) schlaegt jeden Insight-plus-Gewicht-Rest
(hoechstens 0.5 + 0.2 + 0.15 = 0.85).

**Commit C — Profilvorrang (die zweite erklaerte Verhaltensaenderung)**

* `recall.ts:28` — `const PROFILE_LEAD = RECALL_CEILING;` mit
  `const RECALL_CEILING = 1.1;` — der Direktmaximum-Score. Ab hier liegt jede
  Profilzeile auf oder ueber dem besten moeglichen Direkttreffer und keine
  kann mehr verdraengt werden.

Warum: Das Konzept (Fassung 2, Abschnitt 1.2) weist selbst nach, dass ein
Direkttreffer (bis 1.1) eine Profilzeile (Literal 1) aus dem Kopf des Blocks
druecken kann — der Kopf der Liste ist policyabhaengig, Angriffsweg H9. Commit C
entschaerft das, aendert damit aber bewusst das Merge-Ergebnis in den Turns, in
denen heute ein starker Direkttreffer vorne steht. Deshalb ist der Vorrang eine
**benannte** Verhaltensaenderung mit eigenem Commit, eigenem Test und der
Vorher/Nachher-Messung in AP11 — keine still erfahrene Folge der Skala.

**Tests** — `packages/core/test/recall-determinism.test.js`

* *Profil ist total geordnet:* zwei Erinnerungen mit gleicher `importance` und
  gleichem `updatedAt`; `coreProfile(store, { limit: 1 })` hundertmal ->
  `assert.equal(new Set(runs.map(r => r[0].id)).size, 1)`.
* *Hop-1-Rand ist festgelegt:* zwanzig Erinnerungen mit byte-gleichem Text
  (gleiche bm25); `recall(store, { text, limit: 4 })` zehnmal ->
  `assert.deepEqual(runs[0].map(h => h.id), runs[9].map(h => h.id))`.
* *Ausgabeordnung ist total:* fuer eine gemischte Bank
  `assert.deepEqual(hits.map(h => h.id), [...hits].sort(byScoreThenId).map(h => h.id))`.
* *Profilordnung folgt der SQL-Ordnung:* eine gepinnte Zeile mit
  `importance: 0.1`, ein Insight mit `importance: 0.9`, eine Normalzeile mit
  `importance: 1.0` -> `assert.deepEqual(profile.map(p => p.kind === 'insight' ? 'i' : p.pinned ? 'p' : 'n'), ['p','i','n'])`
  und `assert.ok(profile[0].score > profile[1].score && profile[1].score > profile[2].score)`.
* *Profilvorrang (Commit C):* eine getroffene Erinnerung mit `score >= 1.0` und eine
  Profilzeile; den Merge aus `runtime.ts:472-477` im Test nachbilden ->
  `assert.equal(merged[0].id, profileRow.id)`.
* *Keine Gruppierungs-Nichtdeterminiertheit:* zwei Entitaeten mit gleicher
  `mentions` an derselben Erinnerung; `renderMemoryBlock(list, 2000, 's', store)`
  zehnmal -> identische Zeichenkette. (Der zweite Teil dieses Falls liegt in
  AP3: `entitiesFor` braucht seinen eigenen Gleichstandsbrecher, sonst ist der
  Test flackernd statt gruen — AP2 und AP3 laufen in derselben Welle; wer
  zuerst fertig ist, darf den Test als `skip` einstellen und der andere hebt
  ihn auf. Besser: AP3 uebernimmt diesen einen Fall, siehe dort.)

**Fallen**

* `packages/core/test/memory.test.js:149-166` prueft `coreProfile` auf Laenge,
  `content`, `reason` und `importance` — **nicht** auf `score`. Nachgelesen:
  Commit B bricht sie nicht. Trotzdem vor dem Commit noch einmal `rg "\.score"`
  ueber `packages/core/test/`.
* `recall` darf sein Verhalten nicht aendern: Commit A legt nur fest, welche
  von zwei bisher austauschbaren Zeilen kommt. Wenn ein bestehender Test
  dadurch rot wird, hat er auf Nichtdeterminiertheit gebaut — dann wird der
  **Test** korrigiert, nicht der Gleichstandsbrecher.
* `byScoreThenId` nie auf `Array.prototype.sort` ohne Kopie anwenden, wo der
  Aufrufer die Eingabeordnung braucht.

**Fertig heisst:** `recall-determinism.test.js` gruen, `memory.test.js` und
`memory-owner.test.js` unveraendert gruen (ausser dem bekannten Flackerer),
`npm run typecheck` gruen.

---

### AP3 — Gleichstandsbrecher und Buendelung in `store.ts`

**Schreibt (exklusiv):** `packages/core/src/memory/store.ts`
**Liest:** `packages/core/src/memory/recall.ts`, `packages/core/src/types.ts`
**Neue Testdatei:** `packages/core/test/store-entities.test.js`
**Haengt ab von:** nichts. Welle 1.
**Blockiert:** AP7 (gleiche Datei, Welle 2), AP6 (braucht `entitiesForMany`).

**Einfuegepunkte**

* `store.ts:879` — in `entitiesFor` wird `ORDER BY e.mentions DESC` zu
  `ORDER BY e.mentions DESC, e.id` (R11, Gleichstandsbrecher 4). Das sitzt
  direkt auf dem Messziel: `groupByEntity` (`recall.ts:378`) nimmt
  `entities.reduce((a, b) => a.mentions <= b.mentions ? a : b)`, also **den
  ersten** der gleichstaendigen Minima.
* `store.ts:903` — in `memoriesForEntities` wird
  `' ORDER BY m.importance DESC LIMIT ?'` zu
  `' ORDER BY m.importance DESC, m.id LIMIT ?'` (R11, Gleichstandsbrecher 2).
  Beachten: die Abfrage benutzt `SELECT DISTINCT m.*` (`store.ts:897`), also
  eine breite Zeile plus instabilen Sortierschluessel.
* `store.ts:890` — `memoriesForEntities` bekommt eine dritte Option
  `perEntity?: boolean`. Ist sie gesetzt, laeuft statt des globalen `LIMIT` ein
  Fensterausdruck:

```sql
SELECT * FROM (
  SELECT m.*, l.entity_id AS hop_entity_id,
         ROW_NUMBER() OVER (PARTITION BY l.entity_id
                            ORDER BY m.importance DESC, m.id) AS rn
    FROM memories m
    JOIN memory_entity_links l ON l.memory_id = m.id
   WHERE l.entity_id IN (...) AND m.forgotten = 0
     AND m.dormant_at IS NULL AND m.archived_at IS NULL
     AND m.owner = ?
) WHERE rn <= ?
```

  Grund: `expand` ruft heute **je Entitaet** mit `limit: 8` auf
  (`recall.ts:207`), das `LIMIT` ist also pro Entitaet. Ein gebuendelter
  `IN (...)`-Aufruf mit einem einzigen `LIMIT` liefert die globalen Top-N und
  bricht damit genau das Exclude-Praefix-Lemma, dem er dienen soll. SQLite
  kann `ROW_NUMBER()` seit 3.25; `node:sqlite` bringt eine neuere mit.
  **Der Live-Pfad bleibt in Stufe 1 auf der Schleife** — `perEntity` ist
  ausschliesslich der Rekorderpfad, und AP6 prueft beide gegeneinander.
* `store.ts:890` — zweite neue Option `exclude` bleibt wie sie ist; der
  Rekorder ruft **ohne** `exclude` mit `limit + |seeds|` auf (Exclude-Praefix-Lemma).
* `store.ts:900` — der Filter laesst `superseded_by` durch und filtert
  `archived_at`. Das ist Absicht und wird als Kommentar festgehalten (R20;
  Konzept 3.4: die Asymmetrie ist genau die eine Spalte `superseded_by` —
  nicht dieselbe Form wie beim Tor, wo `similarMemories` weder `superseded_by`
  noch `archived_at` filtert).
* `store.ts:900` — neue Methode `entitiesForMany(memoryIds: string[]): Map<string, MemoryEntity[]>`
  direkt hinter `entitiesFor`: **eine** Abfrage mit
  `WHERE l.memory_id IN (...) ORDER BY l.memory_id, e.mentions DESC, e.id`,
  Ergebnis in eine Map gruppiert. Leere Eingabe -> leere Map.

**Tests** — `packages/core/test/store-entities.test.js`

* *`entitiesFor` ist total geordnet:* zwei Entitaeten mit gleicher `mentions`
  an derselben Erinnerung; hundert Aufrufe -> `assert.equal(new Set(runs.map(r => r[0].id)).size, 1)`.
* *`entitiesForMany` ist gleich der Schleife:* fuenfzehn Erinnerungen mit
  Entitaeten; `assert.deepEqual([...many.entries()].map(([id, es]) => [id, es.map(e => e.id)]), ids.map(id => [id, store.entitiesFor(id).map(e => e.id)]))`.
* *`entitiesForMany` mit leerer Eingabe:* `assert.equal(store.entitiesForMany([]).size, 0)`.
* *`perEntity` liefert acht **je** Entitaet:* zwei Entitaeten mit je zwoelf
  Erinnerungen; `memoriesForEntities([a, b], { owner, limit: 8, perEntity: true })`
  -> `assert.equal(rows.length, 16)` und je Entitaet acht, waehrend der alte
  Modus `assert.equal(rows.length, 8)` liefert.
* *`perEntity` ist gleich der Schleife:* fuer jede Entitaet einzeln abfragen
  und die Vereinigung mit dem Fensterergebnis vergleichen (IDs als Menge).
* *Owner-Grenze haelt:* eine Agentenzeile am selben Entitaets-Link ->
  `assert.ok(rows.every(r => r.owner === ASSISTANT_MEMORY_OWNER))`. Die
  Owner-Filterung ist zweimal noetig, in SQL **und** in JS, weil
  `memory_entity_links` keine Owner-Spalte hat (Konzept 10.5).
* *Gruppierung ist stabil:* der aus AP2 uebernommene Fall — zwei Entitaeten
  mit gleicher `mentions`, `renderMemoryBlock(..., store)` zehnmal identisch.

**Fallen**

* `memory-owner.test.js` haengt genau an dieser Owner-Filterung und flackert
  bereits (`memory-owner.test.js:68`). Ein neuer Fehlschlag **dort** ist nicht
  automatisch der bekannte Flackerer — vor dem Abhaken zehnmal laufen lassen.
* Der Fensterausdruck darf `SELECT DISTINCT` nicht verlieren, ohne dass eine
  Erinnerung, die an zwei der abgefragten Entitaeten haengt, doppelt kommt.
  In der `perEntity`-Form ist die Dopplung **gewollt** (je Entitaet eine
  Zeile) — der Rekorder braucht sie, um `entityNeighbours[entityId]` zu
  fuellen. Das muss im Kommentar stehen, sonst "repariert" es jemand.
* `mapMemory` erwartet bestimmte Spalten; die zusaetzliche `hop_entity_id`
  darf sie nicht stoeren.

**Fertig heisst:** `store-entities.test.js` gruen, alle Bestandstests gruen,
`npm run typecheck` gruen.

---

### AP4 — Vokabular, Vorgaben, Schema-Untermenge

**Schreibt (exklusiv):** `packages/core/src/types.ts`,
`packages/core/src/config.ts`, `packages/server/src/schemas.ts`
**Liest:** `packages/core/src/memory/recall.ts`, `packages/core/src/memory/sleep.ts`
**Neue Testdatei:** `packages/core/test/dream-config.test.js`
**Haengt ab von:** nichts. Welle 1.
**Blockiert:** AP6, AP7, AP9, AP10 (alle lesen diese Typen).

Dieses Paket definiert das Vokabular fuer alle spaeteren. Es schreibt **keine**
Logik. Es ist bewusst frueh und klein, damit vier Pakete parallel dagegen
bauen koennen.

**Einfuegepunkte**

* `types.ts:417-455` — `SleepRun` bekommt hinter `resolvedCount` drei Felder:
  `dreamTracesSeen?`, `dreamFramesScored?`, `dreamCandidates?` — **optional**,
  Doc-Kommentar je Feld "gesetzt ab AP7/Schema 21". Pflichtfelder wuerden das
  typecheck-Gate der Welle 1 brechen: die einzigen Stellen, die ein
  vollstaendiges `SleepRun`-Literal bzw. -Return bauen, liegen in `store.ts`
  (`createSleepRun` bei `store.ts:1314-1333`, `mapSleepRun` bei
  `store.ts:1599-1623`) und werden erst in Welle 2 von AP7 ergaenzt — AP4
  darf `store.ts` nicht anfassen (AP3 besitzt es in Welle 1).
  **Erste von sechs Stellen im Gleichschritt** — drei weitere liegen in AP7,
  zwei in AP10 (beide `sleep.ts`, siehe dort).
* `types.ts:1197-1215` — `MemoryConfig` bekommt hinter `graph` ein Feld
  `dream: DreamConfig;`.
* `types.ts:1236` — hinter `MemoryGraphConfig` das neue Interface:

```ts
export interface DreamConfig {
  /** Der ganze Traum. Aus heisst: kein Rekorder, keine Nachtprobe. */
  enabled: boolean;
  /** Nur der Rekorder. Getrennt, damit man ihn abschalten kann, ohne die Nacht zu verlieren. */
  record: boolean;
  /** Anteil der Sitzungen, die ueberhaupt gerahmt werden. Sitzungsweise gewuerfelt, nie je Spur. */
  frameRate: number;
  /** Die permissivste Ecke: bis zu welchem `limit` ein Rahmen replaybar sein soll. */
  limitMax: number;
  /** Das Gitter: feste Belegungen, die die Nacht gegen den Amtsinhaber misst. */
  gridSize: number;
  /** Gewicht des Kostenterms im Blockmass. */
  costWeight: number;
  /** Relative Aenderung der Dokumentfrequenz der Rahmen-Tokens, ab der sich eine Spur enthaelt. */
  corpusTolerance: number;
  /** Harte Deckelung der Rahmengroesse in Bytes; darueber wird nicht gerahmt. */
  maxFrameBytes: number;
  /** Wanduhr-Obergrenze der modellfreien Nachtbewertung in Millisekunden (Konzept 9.5: `dream.maxEvalMs`). */
  maxEvalMs: number;
  /** Aufbewahrung der Rahmen (gross, nur fuer den Replay). */
  frameRetainDays: number;
  /** Aufbewahrung von Spuren und Beruehrungen (klein, tragen die Kalibrierung). */
  retainDays: number;
  /** Laufglobale Deckelung ueber alle Owner. In Stufe 1 null Modellaufrufe; der Deckel steht trotzdem. */
  maxCallsPerNight: number;
}
```

* `types.ts` — dazu die **gemeinsamen Traum-Typen**, damit Welle 2 parallel
  bleiben kann: `DreamTrace` samt der Eingabe- und Patch-Typen fuer
  `beginTrace`/`finishTrace`, die Frame-Payload-Typen und die
  Rahmenschnittstelle (`RecallBox`, `RecallPolicy`, `RecallFrame`,
  `FrameCorpus`, `MemoryRecordSnapshot`,
  `ScoreResult = { ok: true, ranked } | { ok: false, reason }`, `AbstainReason`).
  AP6 und AP7 (beide Welle 2) importieren diese Typen aus `types.ts`; ein
  `dream/types.ts`, das AP6 erst in derselben Welle anlegen wuerde, haette
  AP7 hinter AP6 serialisiert, weil `beginTrace(input): DreamTrace` und
  `saveFrame(traceId, slot, frame)` sie brauchen. `dream/types.ts` entfaellt
  deshalb ganz.
* `config.ts:58` — im `memory`-Block hinter `graph` und vor `sleep` der
  `dream:`-Block mit **einer Begruendung je Zahl**, im Register des
  `sleep`-Blocks (`config.ts:59-105`). Vorschlagswerte:
  `enabled: false`, `record: false`, `frameRate: 0.25`, `limitMax: 16`,
  `gridSize: 10`, `costWeight: 0.05`, `corpusTolerance: 0.25`,
  `maxFrameBytes: 120000`, `maxEvalMs: 20000`, `frameRetainDays: 45`,
  `retainDays: 365`, `maxCallsPerNight: 0`.
  `maxEvalMs` uebernimmt Wert und Name aus dem Konzept (9.5); die fruehere
  2000-ms-Zahl lebt als **innere Teildeckelung** der Gitterprobe weiter (AP10),
  nicht als Konfigurationsschluessel.
  `enabled` und `record` stehen auf `false`, bis AP11 gemessen hat.
* `schemas.ts:258` — hinter `sleepConfigSchema` ein `dreamConfigSchema` mit
  denselben Feldern und geklemmten Bereichen.
* `schemas.ts:289` — **die tragende Zeile**: `dream: dreamConfigSchema,`
  **innerhalb** von `memoryConfigSchema`. Ohne sie wird jeder
  `memory.dream`-PATCH still verworfen und mit 200 beantwortet, weil zod
  unbekannte Schluessel entfernt. Der Beweis, dass das heute schon beisst:
  `memory.gate` und `memory.graph` stehen nicht in `memoryConfigSchema`
  (`schemas.ts:281-291`, nachgelesen) und sind ueber HTTP nicht aenderbar.

**Die Schluesseltabelle (R16)** gehoert als Kommentarblock ueber den
`dream:`-Block in `config.ts` **und** in dieses Dokument:

| Schluessel | Wer liest ihn | Paket |
|---|---|---|
| `dream.enabled` | `runtime.ts` (Rekorder-Aufrufstelle), `sleep.ts` (Nachtprobe) | AP9, AP10 |
| `dream.record` | `runtime.ts` (Rekorder-Aufrufstelle) | AP9 |
| `dream.frameRate` | `runtime.ts`, sitzungsweiser Hash | AP9 |
| `dream.limitMax` | `dream/frame.ts` (`fetchFrame`, Front `max(limit, limitMax) * 4`) | AP6 |
| `dream.gridSize` | `dream/probe.ts` (Gitteraufbau) | AP10 |
| `dream.costWeight` | `dream/measure.ts` (`score = nDCG - lambda * chars`) | AP8 |
| `dream.corpusTolerance` | `dream/probe.ts` (Enthaltungsgrund `corpus-drifted`) | AP10 |
| `dream.maxFrameBytes` | `store.ts` (`saveFrame` lehnt darueber ab) | AP7 |
| `dream.maxEvalMs` | `dream/probe.ts` (Wanduhr, R8) | AP10 |
| `dream.frameRetainDays` | `store.ts` (`sweepDreamFrames`) | AP7 |
| `dream.retainDays` | `store.ts` (`sweepDreamTraces`) | AP7 |
| `dream.maxCallsPerNight` | `sleep.ts` (Deckel ueber alle Owner, R18) | AP10 |

`dream.promote` steht **nicht** in der Tabelle und deshalb nicht in der
Konfiguration: in Stufe 1 hat es keinen Leser (R16).

**Tests** — `packages/core/test/dream-config.test.js`

* `assert.ok(DEFAULT_CONFIG.memory.dream)` und
  `assert.equal(DEFAULT_CONFIG.memory.dream.enabled, false)`,
  `assert.equal(DEFAULT_CONFIG.memory.dream.record, false)`.
* *Kein Schluessel ohne Leser:* die Schluesselliste aus `DEFAULT_CONFIG.memory.dream`
  gegen ein im Test gepflegtes Literal
  `assert.deepEqual(Object.keys(DEFAULT_CONFIG.memory.dream).sort(), EXPECTED.sort())`
  — und `assert.ok(!('promote' in DEFAULT_CONFIG.memory.dream))`.
* *`applyConfig` behaelt einen Teilpatch:* `applyConfig(base, { memory: { dream: { frameRate: 0.5 } } })`
  -> `frameRate === 0.5` und `limitMax` unveraendert.
* *Der Zaehler ist im Typ:* `assert.equal(typeof run.dreamTracesSeen, 'number')`
  auf einem frischen `createSleepRun` — **haengt an AP7**, darum in Stufe 1
  hier als `todo` markiert und von AP7 aufgehoben. Die Optionalitaet der
  Felder bricht ihn nicht: AP7 setzt sie im `createSleepRun`-Literal auf `0`.

Zusaetzlich ein Server-Test (nicht in `npm test`, laeuft per
`npm test -w @rookery/server`, sofern vorhanden — sonst als Anmerkung im PR):
ein PATCH auf `memory.dream.frameRate` kommt beim Lesen zurueck.

**Fallen**

* `schemas.ts:289` ist die tragende Zeile. Wird sie vergessen, faellt nichts
  um, nichts loggt, und die Einrichtung ueber HTTP ist still kaputt. Der Test
  dafuer liegt im Server-Paket; wenn er dort nicht laufen kann, gehoert
  mindestens eine Zeile in die PR-Beschreibung.
* `rookery config set` umgeht zod vollstaendig
  (`packages/cli/src/commands/config.ts`) und prueft nur, dass der gepunktete
  Schluessel existiert. Werte werden deshalb **beim Lesen** geklemmt, nicht
  beim Schreiben vertraut (E21). In Stufe 1 heisst das: jeder Leser
  aus der Tabelle klemmt selbst.
* `SettingsPage.tsx:130-133` haelt schriftlich fest, dass
  `memory.gate`/`graph`/`sleep` nicht auf die Einrichtungsseite gehoeren.
  Dasselbe gilt fuer `memory.dream`. AP4 fasst die Web-Einrichtung **nicht** an.

**Fertig heisst:** `dream-config.test.js` gruen (bis auf den einen `todo`),
`npm run build` gruen, `npm run typecheck` gruen (core **und** server).

---

### AP5 — Vorgezogene Fremdarbeit: `SLEEP_PHASES`

**Schreibt (exklusiv):** `packages/web/src/pages/MemoryLayout.tsx`,
`packages/web/test/sleep-phases.test.mjs` (neu)
**Liest:** `packages/core/src/types.ts`
**Haengt ab von:** nichts. Welle 1.

Das ist ein **bestehender Fehler**, kein Traum-Fehler (R22;
Konzept 9.7): `MemoryLayout.tsx:107` listet
`['started', 'light', 'deep', 'rem', 'finished']`, aber `SleepStage`
(`types.ts:411`) ist `'replay' | 'light' | 'deep' | 'rem'`. Meldet sich die
Replay-Phase, liefert `indexOf` bei `MemoryLayout.tsx:131` `-1` und der
Fortschrittsbalken springt auf 0 %. Stufe 1 behebt das mit demselben Schnitt,
statt spaeter einen zweiten Fehler danebenzulegen.

**Einfuegepunkte**

* `MemoryLayout.tsx:107` — `'replay'` zwischen `'started'` und `'light'`.
* `MemoryLayout.tsx:131-133` — unveraendert; die Prozentrechnung passt sich
  ueber `SLEEP_PHASES.length` selbst an.

**Test** — `packages/web/test/sleep-phases.test.mjs`

* *Jede `SleepStage` kommt vor:* das Literal aus `MemoryLayout.tsx` und die
  Vereinigung aus `types.ts` im Test spiegeln und
  `assert.ok(STAGES.every(s => PHASES.includes(s)))`.
* *Kein Sprung auf null:* `progressFor('replay')` ist `> 0` und `< 100`.

**Fallen**

* `npm test` auf der Wurzel laeuft **nur** `packages/core/test/*.test.js`
  (nachgelesen in `package.json`). Dieser Test laeuft ueber
  `npm test -w @rookery/web` und geht in der Wurzelmessung nicht mit — in der
  PR-Beschreibung nennen.
* `packages/web/test/page-navigation.test.mjs` ist aus einem anderen Grund
  bereits rot (`routeMeta` existiert nicht in `src/lib/nav.ts`). AP5 darf das
  nicht "mitreparieren" und nicht dadurch verdecken.
* Keine neue Route, kein vierter `/memory`-Kindpfad — `page-navigation.test.mjs:21`
  behauptet genau drei Kinder.

**Fertig heisst:** `npm test -w @rookery/web` nicht schlechter als vorher
(`page-navigation` bleibt rot, `sleep-phases` ist gruen),
`npm run build -w @rookery/web` gruen.

---

### AP6 — Der Schnitt: `fetchFrame`, `scoreFrame`, `resolvePolicy`

**Schreibt (exklusiv):** `packages/core/src/memory/dream/frame.ts` (neu),
`packages/core/src/memory/dream/score.ts` (neu),
`packages/core/src/memory/dream/policy.ts` (neu),
`packages/core/src/memory/recall.ts`, `packages/core/src/index.ts`
**Liest:** `packages/core/src/memory/store.ts`, `packages/core/src/runtime.ts`,
`packages/core/src/org/controller.ts`, `packages/core/src/agents/persona.ts`,
`packages/core/src/org/prompts.ts`, `packages/core/src/types.ts`
**Neue Testdatei:** `packages/core/test/dream-frame.test.js`
**Haengt ab von:** AP2 (dieselbe Datei), AP3 (`entitiesForMany`, `perEntity`), AP4 (Typen). Welle 2.
**Blockiert:** AP8, AP9, AP10.

Das ist das grosse Paket und der kritische Pfad. Es aendert **kein** Verhalten:
`recall` bleibt byte-gleich in seiner Ausgabe, nur zerlegt.

**Einfuegepunkte**

* Rahmentypen — liegen in `packages/core/src/types.ts` und werden von **AP4**
  angelegt (Welle 1, siehe dort): `RecallBox`, `RecallPolicy`, `RecallFrame`,
  `FrameCorpus`, `MemoryRecordSnapshot`, `ScoreResult = { ok: true, ranked } | { ok: false, reason }`,
  `AbstainReason`, dazu `DreamTrace` und die Frame-Payload-Typen fuer AP7.
  AP6 importiert sie aus `types.ts`; ein eigenes `dream/types.ts` entfaellt,
  sonst muesste AP7 (gleiche Welle) auf AP6 warten. Inhalt des Rahmens nach
  Konzept 3.4: `pipeline` als Feld
  (R15), `profile` an der permissivsten Ecke (R12), `corpusStampId` statt im
  Rahmen mitgerechneter Korpuswerte (R10, Konzept 3.3), `budgetChars` und
  `subject` fuer den Enthaltungsgrund `budget-changed` (Konzept 5.4).
* `dream/policy.ts` (neu) — `resolvePolicy(store, config, owner, slot): RecallPolicy`.
  In Stufe 1 gibt es keine befoerderte Version, also liefert er immer
  `origin: 'default'` aus `config.memory` und den Literalen — mit einer
  Ausnahme, die das Konzept (9.3) verlangt: **ein Config-Wert, der vom
  Vorgabewert abweicht, wird als `origin: 'user'` klassifiziert** (die
  Nutzer-Regler `memory.recallLimit`/`recallThreshold` liegen in derselben
  Flaeche). `retired_at` auf der aktiven Version und der Regler-Hinweis
  bleiben Phase 3. Der Resolver ist trotzdem jetzt noetig: heute existieren
  **zwei** effektive Policies fuer eine Funktion, weil `runtime.ts:465-466`
  `hopEntity`/`hopEdge` uebergibt und `org/controller.ts:2458-2463` nicht —
  gleiche Werte, also unsichtbar, bis jemand `config.memory.graph` aendert.
  `resolvePolicy` klemmt jeden Wert beim Lesen (E21).
* `dream/frame.ts` (neu) — `fetchFrame(store, options): RecallFrame` — die
  Signatur wie im Konzept (1.1); die Box liegt in `options`, nicht in einem
  dritten Parameter. Die Front ist `Math.max(limit, box.limitMax) * 4`
  (heute `limit * 4` bei `recall.ts:113`). `possibleSeeds` per
  Intervallarithmetik ueber die Box.
  `entityNeighbours` **ohne** `exclude` mit `limit + |possibleSeeds|` und
  `perEntity: true` (AP3). `entities` ueber die **ganze** erreichbare Menge R
  per `entitiesForMany` (AP3). `profile` per `coreProfile` mit
  `limit = max(3, floor(box.limitMax / 2))` (R12).
  **`touch: false` ist hier keine Option, sondern abwesend** (R6): `fetchFrame`
  ruft `touchMemories` nie.
  Harte Deckelung: uebersteigt `|possibleSeeds|` einen Grenzwert, wird der
  Rahmen mit `seeds-capped` verworfen statt aufgeblaeht (Konzept 3.1).
* `dream/score.ts` (neu) — `scoreFrame(frame, policy): ScoreResult`,
  `renderFromFrame(frame, list, budget, subject)`, `groupFromFrame`,
  `mergeProfile(frame.profile, ranked, limit)`, `dropContradictedFromFrame`,
  und **zwei Ketten** (R15):
  `pipelineAssistant`: `merge(profile mit max(3, floor(limit/2))) -> dropContradicted -> sort -> renderFromFrame(gruppiert)`
  `pipelineAgent`: `merge(profile mit festem 3) -> sort -> renderFromFrame(flach)` — **ohne** `dropContradicted`,
  weil `org/controller.ts:2458-2468` es nicht aufruft (nachgelesen).
  Gewichte werden hier auf Summe 1 normiert und `threshold` mit demselben
  Faktor skaliert (R13). Fuer den Amtsinhaber ist das ein Nullschritt: die
  Summe ist **genau 1.00**.
* `recall.ts:83-167` — `recall` wird
  `const frame = fetchFrame(...); const r = scoreFrame(frame, policy); if (touch) store.touchMemories(ids, touchContext); return r.ranked;`
  Der einzige Schreibzugriff bleibt aussen. Dafuer bekommt `RecallOptions` ein
  optionales Touch-Kontext-Feld
  (`touchContext?: { traceId: string; owner: string; policyId?: string }`),
  das `recall()` an `store.touchMemories(ids, ctx)` weiterreicht (AP7). Ohne
  das Feld waere AP7s `ctx`-Parameter toter Code: der einzige
  `touchMemories`-Aufruf im Recall-Pfad liegt in `recall()` selbst
  (`recall.ts:163-165`), nicht an der Aufrufstelle. AP9 liefert den Kontext,
  sobald der Rekorder dort steht.
* `index.ts` — eine Exportzeile je neuem Modul, angehaengt hinter dem
  `recall`-Block (`index.ts:16-25`).

**Tests** — `packages/core/test/dream-frame.test.js`

* **Aequivalenz je Pipeline (R15).** Fuer 200 zufaellige
  `(query, limit 4..16, threshold, hopEntity, hopEdge)` auf einer Bank aus
  60 Erinnerungen, je Ziehung mit **verengter Box**:
  `assert.deepEqual(recall(store, o), scoreFrame(fetchFrame(store, { ...o, box: { ...box, limitMax: o.limit } }), o).ranked)`
  — Element fuer Element **inklusive** `score`, `hop` und `reason`.
  Zweimal: einmal `pipeline: 'assistant'`, einmal `'agent'`.
  Warum die Verengung: Live-`recall` ohne offene Spur holt `limit * 4` Zeilen,
  der Rahmen `max(limit, limitMax) * 4` — bei `limitMax: 16` auf 60
  Erinnerungen die ganze Bank. Zeilen ausserhalb der Live-Front koennen
  problemlos `score >= threshold` erreichen (Importance/Recency allein tragen
  bis 0.45) und in `top` bzw. `direct.slice(0, 3)` survived Zeilen verdraengen;
  `deepEqual` faellt dann spaetestens bei einer der 200 Ziehungen. Mit
  `limitMax: o.limit` ist die Rahmenfront `o.limit * 4` und exakt die
  Live-Front. Der Profilschliessungs-Test unten (bei `limitMax: 16`) bleibt
  davon unberuehrt.
* **Eingefrorene Uhr.** Der Aequivalenztest braucht ein festes `Date.now()`,
  sonst driftet `recency` (`recall.ts:126`) zwischen Live- und Replaylauf.
  Im Repo gibt es dafuer kein Muster: AP6 legt es an
  (`const realNow = Date.now; Date.now = () => FIXED; try { ... } finally { Date.now = realNow; }`)
  und beschreibt es im Kopfkommentar der Testdatei.
* **Saatschliessung.** Die tatsaechlich benutzten Saat-IDs sind Teilmenge von
  `frame.possibleSeeds`:
  `assert.ok(usedSeeds.every(id => frame.possibleSeeds.includes(id)))`.
* **Profilschliessung (R12).** Ein Rahmen bei `limitMax: 16` reproduziert
  **jedes** `limit` von 4 bis 16 (Konzept 11, Phase-1-Tests): Schleife ueber
  `limit` in `[4..16]`, je
  `assert.equal(mergeProfile(frame.profile, ranked, limit).filter(isProfile).length, Math.max(3, Math.floor(limit / 2)))`.
* **Renderer-Gleichheit.**
  `assert.equal(renderFromFrame(frame, list, 2400, 'this user'), renderMemoryBlock(list, 2400, 'this user', store))`
  — und ohne Store fuer die Agentenkette.
* **Kein Schreibzugriff (R6).** Vor und nach einem vollstaendigen
  `fetchFrame` + `scoreFrame`-Durchgang:
  `assert.deepEqual(snapshotCounters(store), before)` ueber `access_count`
  und `usefulness` **aller** Zeilen.
* **Kein degradierter Pfad wird zum Fehler.** Eine Anfrage nur aus
  Stoppwoertern (`recall.ts:87`, `toMatchQuery` liefert `''`) ->
  `frame.degraded === 'no-tokens'`; eine Anfrage mit kaputtem MATCH ->
  `'fts-threw'`; eine Anfrage mit Treffern, die alle unter `threshold` fallen,
  -> `degraded === null` und eine **leere, gueltige** Rangfolge (R20;
  Konzept 3.4: das sind drei Welten, nicht zwei).
* **Box-Verletzung ist eine Zusicherung, keine Enthaltung.**
  `scoreFrame(frame, { ...policy, limit: 32 })` -> `{ ok: false, reason: 'limit-out-of-box' }`,
  und der Test nennt das einen **Rekorderfehler**.
* **Der Resolver hat eine Wahrheit.** `resolvePolicy(store, config, owner, 'recall')`
  liefert fuer den Assistenten- und den Agentenpfad denselben Wert, auch wenn
  `config.memory.graph.hopEntity` vom Literal `0.45` abweicht:
  `assert.equal(resolved.hopEntity, config.memory.graph.hopEntity)`.
* **Herkunft `user` bei Abweichung (Konzept 9.3).** Weicht
  `config.memory.recallThreshold` vom Literal ab, klassifiziert der Resolver
  das Feld als `origin: 'user'` statt `'default'` — sonst luegen spaeter
  Regler oder Befoerderung.

**Fallen**

* **`recall` darf sein Verhalten NICHT aendern.** Das ist die Abnahme dieses
  Pakets, nicht eine Nebenbedingung. Faellt der Aequivalenztest an einer
  einzigen der 200 Ziehungen durch, ist der Schnitt falsch — nicht der Test.
* Die `Math.max(..., 1)`-Klammer bei `recall.ts:120` gehoert **in** den Rahmen,
  und zwar der Wert **nach** der Klammer. Ohne sie blaeht ein Replay Anfragen
  mit niedrigem bm25 um einen plausibel aussehenden Faktor auf.
* `now` (`recall.ts:119`) gehoert in den Rahmen. Wer `recency` mit dem
  `Date.now()` des Replays rechnet, laesst alle Zeilen gemeinsam zerfallen —
  die Streuung schrumpft und ein Kandidat, der `recency` hebt, sieht neutral
  aus, wo er entscheidend gewesen waere.
* `entityNeighbours` muss **abgeloeste** Zeilen mitzeichnen: `memoriesForEntities`
  filtert `superseded_by` nicht (`store.ts:900`, nachgelesen), `offer`
  (`recall.ts:194`) schon. Das `LIMIT` beisst also **vor** dem Filter.
* Welche Entitaeten ueberhaupt Nachbarn liefern, entscheidet die **permissivste**
  Ecke der Box (`hopEntity` maximal, `threshold` minimal), nicht der
  realisierte Punkt.
* Die Front ist `max(limit, limitMax) * 4` **nur, wenn eine Spur offen ist**.
  Auf ungespurten Turns bleibt es bei `limit * 4`, sonst zahlt jeder Turn fuer
  den Traum.

**Fertig heisst:** `dream-frame.test.js` gruen mit 200 Ziehungen je Pipeline,
alle Bestandstests gruen, `npm run build` gruen, `npm run typecheck` gruen.

---

### AP7 — Rekorder-Persistenz: Spuren, Rahmen, Beruehrungen, Zaehler

**Schreibt (exklusiv):** `packages/core/src/memory/store.ts`
**Liest:** `packages/core/src/memory/db.ts`, `packages/core/src/types.ts`
(inklusive `DreamTrace` und der Frame-Payload-Typen aus AP4)
**Neue Testdatei:** `packages/core/test/dream-recorder-store.test.js`
**Haengt ab von:** AP1 (Tabellen), AP3 (dieselbe Datei), AP4 (Typen, inklusive
der Traum-Typen). Welle 2, parallel zu AP6 — kein Import aus `dream/`.
**Blockiert:** AP9, AP10.

**Einfuegepunkte**

* `store.ts:550-561` — `touchMemories(ids)` bekommt einen zweiten,
  **optionalen** Parameter `ctx?: { traceId: string; owner: string; policyId?: string }`.
  Ist er da, wird je ID zusaetzlich eine `memory_touches`-Zeile geschrieben.
  Ohne ihn aendert sich nichts — null Kosten auf ungespurten Turns, keine
  Aenderung an der Zaehlersemantik.
* `store.ts` — **innerhalb der `Store`-Klasse**, hinter dem
  `/* ------ sleep runs ------ */`-Abschnitt (beginnt bei `store.ts:1312`,
  endet mit der Klasse bei `store.ts:1507`; ab `store.ts:1509` stehen nur
  Modul-Funktionen wie `mapSession` — ans Dateiende angehaengte
  Klassenmethoden waeren ein Syntaxfehler): ein neuer Abschnitt
  `/* ------------------------------ dream ------------------------------ */`
  mit:
  * `beginTrace(input): DreamTrace`
  * `finishTrace(id, patch): void`
  * `failStaleTraces(reason): number` — beim Start, Vorbild
    `failStaleSleepRuns` (`store.ts:1400`).
  * `openTraces(): DreamTrace[]` — die Spuren ohne `finished_at`; der Test
    unten prueft ueber sie, dass `failStaleTraces` keines uebrig laesst.
  * `saveFrame(traceId, slot, frame): boolean` — serialisiert, misst `bytes`,
    lehnt oberhalb `dream.maxFrameBytes` ab statt zu werfen.
  * `recordTouches(traceId, owner, ids, policyId?): void`
  * `framesFor(owner, options): { trace, frame }[]` — Lesepfad fuer die Nacht.
  * `sweepDreamFrames(before)` / `sweepDreamTraces(before)` — in Schleifen mit
    `LIMIT 500` und eigenem `BEGIN` je Charge, danach
    `PRAGMA wal_checkpoint(TRUNCATE)`.
  * `dropDreamFramesForOwner(owner)` und `dropDreamFramesForSession(sessionId)` —
    die Loeschpfade aus R17. Verdrahtet werden **alle vier** Stellen aus
    Konzept 8.7: `Assistant.deleteSession` ruft die Session-Variante (AP9),
    und die drei Store-Methoden `forgetMemory` (`store.ts:522`),
    `deleteMemory` (`store.ts:541`) und `archiveMemories` (`store.ts:534`)
    rufen `dropDreamFramesForOwner(owner)` — Owner- bzw. Sitzungsebene, ohne
    den `payload` zu lesen; dafuer stehen die Spalten aus AP1. Jede der drei
    Zeilen ist ein eigener Commit.
  * `corpusFingerprint(owner, tokens): FrameCorpus` — ueber
    `fts5vocab`-Dokumentfrequenz der **Rahmen**-Tokens (R10). Die Berechnung
    ist ein Scan und darf nie im Turn laufen: das Ergebnis wird in `meta`
    zwischengespeichert, mit Zeitstempel, und der Turn stempelt nur die
    `corpus_stamp_id` dieses Stempels auf den Rahmen (Konzept 3.3 — nicht die
    df-Werte selbst und nicht ihr Alter).
    Die dafuer noetige virtuelle Tabelle
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_v USING fts5vocab(memories_fts, 'row')`
    legt **AP1** an, nicht AP7 (`db.ts` gehoert AP1) — AP7 liest sie nur.
* **Die `SAVEPOINT`-Transaktion (R9).** Alle Schreibvorgaenge eines gerahmten
  Turns laufen in einer Klammer:

```ts
this.db.exec('SAVEPOINT dream_rec');
try { /* trace, frame, touches */ this.db.exec('RELEASE dream_rec'); }
catch (error) { this.db.exec('ROLLBACK TO dream_rec'); this.db.exec('RELEASE dream_rec'); }
```

  `SAVEPOINT` ist eine SQLite-Eigenschaft, kein Treibermerkmal; `store.ts`
  fuehrt Transaktionen ohnehin per `this.db.exec('BEGIN')` (`store.ts:853`,
  `store.ts:1435`). Damit braucht der Rekorder **kein** von Hand gepflegtes
  "ich bin drin"-Flag, das beim naechsten transaktionalen Verfahren still
  veraltet.
* **`sleep_runs`-Zaehler — drei weitere Stellen im Gleichschritt:**
  * `store.ts:1314-1333` — das `createSleepRun`-Literal bekommt
    `dreamTracesSeen: 0, dreamFramesScored: 0, dreamCandidates: 0`. Erst hier
    sind die optionalen Felder aus AP4 gesetzt; damit laeuft der `todo`-Test
    aus AP4.
  * `store.ts:1344-1362` — die `columns`-Whitelist in `updateSleepRun` bekommt
    `dreamTracesSeen: 'dream_traces_seen'` usw. **Ein nicht gelisteter
    Schluessel wird ohne Fehler, ohne Log und ohne Typfehler uebersprungen** —
    das ist die Stelle, an der der Zaehler still wegfaellt.
  * `store.ts:1599-1623` — `mapSleepRun` liest die drei Spalten mit `?? 0`,
    damit auch Zeilen ohne Werte (und der optionale Typ aus AP4) eine Zahl
    liefern.
  (Die erste Stelle, `types.ts:417`, gehoert AP4; die letzten zwei — das
  counters-Literal und die `describeSleep`-Signatur, beide `sleep.ts` —
  AP10.)

**Tests** — `packages/core/test/dream-recorder-store.test.js`

* *Der Zaehler ueberlebt den Rundlauf:*
  `const run = store.createSleepRun(...); store.updateSleepRun(run.id, { dreamFramesScored: 7 }); assert.equal(store.getSleepRun(run.id).dreamFramesScored, 7);`
  — das ist der Test, der die `updateSleepRun`-Whitelist absichert.
* *Alle Traumzaehler im Gleichschritt am Lauf:*
  `assert.deepEqual(Object.keys(run).filter(k => k.startsWith('dream')).sort(), ['dreamCandidates','dreamFramesScored','dreamTracesSeen'])`.
* *`SAVEPOINT` ueberlebt eine offene Transaktion (R9):*
  `store.db.exec('BEGIN')`, dann der Rekorderpfad, dann `COMMIT` ->
  `assert.doesNotThrow` und die Rahmenzeile ist da. Das ist die Umkehrung des
  Konzept-Tests aus 8.7 ("lehnt ab statt zu werfen"): mit `SAVEPOINT` darf er
  **schreiben**, nicht ablehnen.
* *Rollback laesst nichts halb Geschriebenes zurueck:* `saveFrame` mit einem
  Nutzlast-Objekt, das beim Serialisieren wirft ->
  `assert.equal(count('dream_traces'), 0)`.
* *Groessendeckel:* ein Rahmen ueber `maxFrameBytes` ->
  `assert.equal(store.saveFrame(...), false)` und keine Zeile.
* *`touchMemories` ohne Kontext schreibt nichts Neues:*
  `store.touchMemories([id]); assert.equal(count('memory_touches'), 0);`
  und `access_count` ist trotzdem gestiegen.
* *`touchMemories` mit Kontext ist append-only:* zweimal derselbe
  `(traceId, memoryId)` -> `assert.equal(count('memory_touches'), 2)` (R4).
* *Loeschpfade erreichen die Rahmen (R17):* `store.archiveMemories(owner)`,
  `store.forgetMemory(id)` und `store.deleteMemory(id)` jeweils gefolgt von
  `assert.equal(count('dream_frames'), 0)` — alle drei Store-Methoden sind
  verdrahtet, nicht nur `deleteSession` (AP9).
* *Verwaiste Spuren:* eine Spur ohne `finished_at`, dann
  `failStaleTraces('restart')` -> `assert.equal(store.openTraces().length, 0)`.
* *Kehrbesen raeumt in Chargen:* 1200 Spuren, `sweepDreamTraces(now)` ->
  alle weg, und `memory_touches` kaskadiert mit.

**Fallen**

* **Kein Schreiben aus offener Transaktion** war die alte Regel; mit
  `SAVEPOINT` wird daraus "kein blankes `BEGIN`". Wer den Rekorder spaeter um
  ein `BEGIN` erweitert, bricht genau den Pfad, den er protokollieren wollte.
* `undoSleepRun` (`store.ts:1425`) gibt `null` zurueck, wenn `undoneAt` schon
  gesetzt ist. Traum-Buchfuehrung darf sich nicht darauf stuetzen, `undo()`
  ein zweites Mal aufzurufen.
* `failStaleSleepRuns` (`store.ts:1400`) kippt beim Start **jeden** laufenden
  Lauf ohne Owner- oder PID-Filter. `failStaleTraces` erbt das Muster
  bewusst — und den Vorbehalt.
* Der `sweep` darf nie unbegrenzt laufen: `PRAGMA foreign_keys = ON`
  (`db.ts:24`) macht aus einem Spurenloeschen ein Kaskadenloeschen im selben
  Statement, und ein unbegrenzter Sweep waere eine lange exklusive
  Schreibsperre auf der einzigen Verbindung.
* `SUM(LENGTH(content))` ist **kein** billiger Fingerabdruck — es ist ein
  Vollscan (Konzept 3.3). Wer ihn aus Bequemlichkeit doch in den Turn
  legt, macht den Rekorder teurer als alles andere, was er tut.

**Fertig heisst:** `dream-recorder-store.test.js` gruen, der `todo` aus AP4
aufgehoben und gruen, alle Bestandstests gruen, `npm run typecheck` gruen.

---

### AP8 — Das Blockmass

**Schreibt (exklusiv):** `packages/core/src/memory/dream/measure.ts` (neu),
`packages/core/src/index.ts`
**Liest:** `packages/core/src/types.ts` (Rahmentypen, AP4),
`packages/core/src/memory/dream/{score,frame}.ts`,
`packages/core/src/memory/recall.ts`
**Neue Testdatei:** `packages/core/test/dream-measure.test.js`
**Haengt ab von:** AP6. Welle 3.
**Blockiert:** AP10.

**Inhalt** — genau Konzept 5.2, mit R2, R13, R14.

```
P            = pipeline(frame, policy).lines
gain(m)      = aus den Etiketten; in Stufe 1 gibt es keine, also ist
               gain() ein Parameter der Funktion und der Aufrufer liefert ihn
DCG(P)       = sum_i gain(P_i) / log2(i + 1)
R            = erreichbare Menge des Rahmens
Ideal        = { m in R : gain(m) > 0 }, nach gain absteigend, abgeschnitten
               mit demselben Zeichenbudget und DEMSELBEN Renderer wie P (R14)
nDCG         = DCG(P) / DCG(Ideal)        (DCG(Ideal) = 0 -> Enthaltung)
chars        = benutzte Zeichen / frame.budgetChars
score        = nDCG - costWeight * chars
coverage     = |{ Positionen in P, fuer die ueberhaupt ein Etikett existieren
                  koennte }| / |P|                                        (R2)
```

**Einfuegepunkte**

* `dream/measure.ts` (neu) — `measure(frame, policy, gain): MeasureResult`
  mit `{ ok, score, ndcg, chars, coverage, reachableRate, abstain }`.
* `dream/measure.ts` — `normaliseWeights(w)`: Summe auf 1, `threshold`
  mitskaliert (R13). Fuer die Werksvorgabe ein Nullschritt.
* `dream/measure.ts` — `isScalarMultiple(a, b, eps)`: das H9-Praedikat (R13).
  In Stufe 1 hat es keinen Kandidaten abzulehnen; es ist eine reine Funktion
  mit einem Test, damit Phase 3 sie nur noch aufruft.
* `dream/measure.ts` — `deltaIsLabelBacked(positions)`: liefert `false`, wenn
  das Delta ueberwiegend aus unetikettierten Positionen stammt (R2). In
  Stufe 1 wird das **berichtet**, nicht durchgesetzt.
* `index.ts` — eine Exportzeile, angehaengt.

**Der Satz, der an die Definition gehoert (R2)**, woertlich in den
Kopfkommentar von `measure.ts` und in §7 dieses Dokuments:

> Dieses Mass ist eine **untere Schranke**, kein Punktschaetzer. Eine
> Erinnerung bekommt nur ueber Kanaele ein Etikett, die voraussetzen, dass der
> Amtsinhaber sie hochgespuelt hat. Ein Kandidat, der eine andere, wirklich
> bessere Erinnerung holt, bekommt dafuer `gain = 0`, weil sie nie jemand
> etikettiert hat. Die Abdeckungsrate wird je Bewertung berichtet, und ein
> Delta, das ueberwiegend aus unetikettierten Positionen stammt, ist ungueltig.

**Tests** — `packages/core/test/dream-measure.test.js`

* **Blockmass schlaegt Rueckgabewertmass.** Bank mit einer relevanten kurzen
  Erinnerung A (`gain 1`) und einer irrelevanten 1800-Zeichen-Erinnerung B
  (`gain 0`); ein Kandidat, der B ueber A stellt, ist auf `recall`s
  Rueckgabewert gleichauf und auf dem Block strikt schlechter:
  `assert.equal(ndcgOnReturn(candidate), ndcgOnReturn(base))` und
  `assert.ok(measure(frame, candidate, gain).score < measure(frame, base, gain).score)`.
  **Faellt das durch, war das alte Mass ausreichend und dieser Teil des
  Konzepts ist widerlegt.** Der Test ist der Falsifikationstest der Stufe.
* **Keine Skaleninvarianz (H8).** Treffer und Zeichen halbieren muss den Wert
  aendern: `assert.notEqual(score(half), score(full))`.
* **H9 (R13).** `assert.equal(isScalarMultiple({r:1.1,i:0.4,c:0.3,u:0.2}, {r:0.55,i:0.2,c:0.15,u:0.1}), true)`
  und `false` fuer einen nicht proportionalen Vektor.
* **Normierung ist fuer den Amtsinhaber ein Nullschritt.**
  `assert.deepEqual(normaliseWeights(WEIGHTS), WEIGHTS)` — die Summe ist
  genau 1.00.
* **Das Ideal benutzt denselben Renderer (R14).** Ein Rahmen, dessen Treffer
  alle an derselben Entitaet haengen, gegen einen mit gestreuten Entitaeten:
  `assert.ok(Math.abs(ndcg(concentrated) - ndcg(spread)) < eps)` bei gleicher
  Trefferlage. Mit flachem Ideal waere die Differenz systematisch.
* **Abdeckungsrate wird berichtet.** `assert.equal(typeof result.coverage, 'number')`
  und bei leerem Etikettensatz `assert.equal(result.abstain, 'no-reachable-label')`.
* **Drei Welten, nicht zwei.** Ein Rahmen mit `degraded: null` und leerem P
  wird **gescored** (legitimer Fehlschlag), ein Rahmen mit
  `degraded: 'no-tokens'` enthaelt sich (R20).

**Fallen**

* Nie ein Verhaeltnis ("Treffer je Zeichen") — das gewinnt man mit einer
  garantiert relevanten Profilzeile und sonst nichts.
* Das Ideal ist **rahmenrelativ**: ein Etikettenziel, das die Hop-1-SQL hart
  ausschliesst (`superseded_by`, `recall.ts:103`), faellt aus dem Ideal und
  die Spur meldet `reachableRate`. Wuerde es eingehen, druckte es alle Werte
  gleichermassen und komprimierte genau die Deltas, die spaeter das Tor testet.
* `gain` ist in Stufe 1 ein **Parameter**, keine Datenbankabfrage. Es gibt
  keinen Etikettenschreiber, und es soll keinen geben, bevor Phase 2 die
  Etikettenquellen baut (`dream_labels` steht als leere Tabelle bereit, siehe
  AP1).

**Fertig heisst:** `dream-measure.test.js` gruen, insbesondere der
Falsifikationstest, `npm run typecheck` gruen.

---

### AP9 — Der Rekorder an der Aufrufstelle

**Schreibt (exklusiv):** `packages/core/src/runtime.ts`,
`packages/core/src/org/controller.ts`, `packages/server/src/server.ts`
**Liest:** `packages/core/src/memory/dream/*`, `packages/core/src/memory/store.ts`,
`packages/core/src/org/controller.ts`
**Neue Testdatei:** `packages/core/test/dream-recorder-turn.test.js`
**Haengt ab von:** AP6, AP7. Welle 3.
**Blockiert:** AP10, AP11.

**Einfuegepunkte**

* `runtime.ts:459` — vor `const matched = recall(...)` die Spur oeffnen, aber
  nur wenn **alle** Bedingungen halten:
  `config.memory.dream.enabled && config.memory.dream.record && owner === ASSISTANT_MEMORY_OWNER`
  (R18) und die Sitzung faellt ueber einen **sitzungsweisen** Hash in die
  Stichprobe (`hash(sessionId + salt) < frameRate`) — nie je Spur gewuerfelt,
  weil aufeinanderfolgende Turns einer Sitzung Thema, Bankausschnitt und
  Entitaetennachbarschaft teilen.
  Ausserdem: `session.kind` muss in `chat | voice | mail` liegen. Ein
  `kind: 'schedule'`-Lauf durchlaeuft `chat()` und damit `recall`, lernt aber
  bewusst nichts und kann nie ein Etikett bekommen (Konzept 3.5) —
  er wird **nie** gerahmt.
* `runtime.ts:460-467` — der `recall`-Aufruf bekommt die Parameter aus
  `resolvePolicy(...)` statt direkt aus `this.config.memory`, und den
  Rekorderkontext: das Touch-Kontext-Feld aus `RecallOptions` (AP6), das
  `recall()` an `store.touchMemories(ids, ctx)` weiterreicht, hier gefuellt
  mit `traceId`, `owner` und `policyId`. `site: 'turn'`,
  `pipeline: 'assistant'`, `turn_id` = die
  laufende Turn-Kennung, `turn_index` aus der Sitzung (R19).
* `runtime.ts:468-471` — `coreProfile` bekommt `limit` aus der **permissivsten
  Ecke** fuer die Aufzeichnung (R12), liefert dem Prompt aber weiter
  `max(3, floor(recallLimit / 2))`. Zwei Aufrufe waeren eine zweite Abfrage;
  besser ist ein Aufruf mit dem groesseren `limit` und ein `slice` fuer den
  Prompt — das ist praefix-invariant, sobald `coreProfile` seinen
  Gleichstandsbrecher hat (AP2).
* `runtime.ts:478` — nach dem Merge die Spur schliessen: gerenderter Block,
  `budgetChars`, `contextBudget`, `degraded` eintragen.
* `runtime.ts:477` — der Merge-Sort `.sort((a, b) => b.score - a.score)` wird
  `byScoreThenId` (R11, In-JS-Sortierung; der Helfer aus AP2 wird exportiert
  oder als identischer lokaler Zwilling angelegt). Ohne ihn entscheidet bei
  Gleichstand die Einfuegereihenfolge der `Map` — ausgerechnet an der Stelle,
  an der Commit B/C aus AP2 die Profilwerte auf die Skala hebt.
* `org/controller.ts:2467` — dieselbe Ersetzung im Agenten-Merge (R11, letzte
  der fuenf In-JS-Sortierungen aus Konzept 3.2). Eigener Commit, zwei Zeilen.
* `runtime.ts:1119` — **nicht anfassen.** Das ist die Extraktor-Population
  (`limit: 20`, `threshold: 0.05`, `touch: false`, `expand: false`); Stufe 1
  scored nur `site='turn'`. Ein Kommentar dort haelt fest, warum sie
  ausgelassen ist.
* `runtime.ts:329` — **nicht anfassen.** Werkzeug/Inspektor, `site: 'inspect'`,
  nie gerahmt.
* `runtime.ts:314` — `deleteSession` ruft `dropDreamFramesForSession(id)`
  (R17): nie einen Wortlaut laenger aufbewahren als die Erinnerung bzw. die
  Sitzung, aus der er stammt.
* `server.ts:246` — beim Start, neben dem dortigen `failStaleSleepRuns`-Aufruf,
  zusaetzlich `failStaleTraces('restart')`. `server.ts` gehoert deshalb mit in
  AP9s Schreibt-Liste und der Besitzkarte (kein anderes Paket besitzt sie).

**Tests** — `packages/core/test/dream-recorder-turn.test.js`

* *Nur der Assistenten-Owner (R18):* ein Agenten-Turn erzeugt keine Spur:
  `assert.equal(count('dream_traces'), 0)`.
* *Nur `chat|voice|mail`:* ein `kind: 'schedule'`-Lauf erzeugt keine Spur.
* *Sitzungsweise, nicht je Spur:* zehn Turns derselben Sitzung ->
  `assert.ok(framed === 0 || framed === 10)`.
* *`site` ist `turn`:* `assert.equal(trace.site, 'turn')`, und
  `assert.equal(trace.pipeline, 'assistant')`.
* *`turn_id` gruppiert (R19):* zwei Aufrufe desselben Turns tragen dieselbe
  `turn_id` und verschiedene `id`.
* *Der Prompt ist unveraendert:* derselbe Turn mit `record: true` und
  `record: false` ergibt **denselben** gerenderten Memory-Block:
  `assert.equal(blockWithRecorder, blockWithout)`. Das ist der Test, der
  "`recall` darf sein Verhalten nicht aendern" auf der Aufrufstelle absichert.
* *Deep-Link der Loeschung (R17):* `deleteSession(id)` ->
  `assert.equal(count('dream_frames'), 0)`.
* *Ausschalter greift:* `dream.enabled = false` -> keine Spur, auch wenn
  `record: true`.
* *Merge ist total geordnet (R11):* eine Direktzeile und eine Profilzeile mit
  byte-gleichem Score; zehnmal denselben Merge aus `runtime.ts:472-477`
  nachbilden -> `assert.equal(new Set(runs.map(r => r[0].id)).size, 1)`;
  dito einmal auf dem Agenten-Merge aus `org/controller.ts:2467`.

**Fallen**

* `runtime.ts:940-947` iteriert die Owner sequenziell fuer den Nachtlauf. Der
  Rekorder darf dort nichts anhaengen — Stufe 1 rahmt nur den Tagpfad.
* `GET /api/memories?q=` (`packages/server/src/routes/memories.ts:37`) ruft
  `recall` mit `limit` bis 500 und **`owner` frei aus dem Querystring**, also
  ueber Besitzergrenzen hinweg; `packages/cli/src/commands/memory.ts:111` ruft
  mit `threshold` 0. Ein Rekorder, der generisch **in** `recall` saesse, wuerde
  Browser-Suchen und CLI-Aufrufe mit Fremd-Owner rahmen. Deshalb sitzt er an
  der **Aufrufstelle** (R19), nie per Vorgabe in `recall`.
* Der Rekorder darf nie aus einer offenen Transaktion heraus ein blankes
  `BEGIN` absetzen — AP7 hat dafuer `SAVEPOINT`.

**Fertig heisst:** `dream-recorder-turn.test.js` gruen, alle Bestandstests
gruen, und der Turn-Block byte-gleich mit und ohne Rekorder.

---

### AP10 — Gitterprobe und Frisch-Test in der Nacht

**Schreibt (exklusiv):** `packages/core/src/memory/dream/probe.ts` (neu),
`packages/core/src/memory/sleep.ts`, `packages/core/src/index.ts`
**Liest:** `packages/core/src/memory/dream/{measure,score,frame,policy}.ts`,
`packages/core/src/memory/store.ts`, `packages/core/src/types.ts`
**Neue Testdatei:** `packages/core/test/dream-probe.test.js`
**Haengt ab von:** AP7, AP8, AP9. Welle 4.

**Einfuegepunkte**

* `sleep.ts:295` — **zwischen** dem Budget-Block (endet mit
  `this.#log.info('Night measured', ...)` bei `sleep.ts:293`) und
  `for (let cycle = 1; cycle <= cycles; cycle += 1) {` bei `sleep.ts:296`.
  Das ist die von R7 und R8 verlangte Stelle:
  * **vor** der Zyklusschleife, also bevor `#condense` `superseded_by` und
    `dormant_at` auf genau den Beinah-Duplikat-Clustern setzt, die der Tag am
    meisten abgerufen hat — sonst misst der Frisch-Test die Nacht selbst,
    nicht die Rahmenveralterung (R7);
  * **oberhalb** von `if (!provider || !budgets) continue;` (`sleep.ts:311`),
    also laeuft die modellfreie Bewertung auch in einer Nacht ohne Provider —
    der einen Nacht, in der sie das Einzige waere, was laufen koennte (R8).
* `sleep.ts:295` — der Aufruf ist
  `const probe = runGridProbe(this.#store, config, owner, run.id, controller.signal);`
  mit **eigener Wanduhr-Obergrenze** `dream.maxEvalMs` (Vorgabe 20000, wie im
  Konzept 9.5), die wie `modelCalls`
  berichtet wird (R8). Die Probe liest Rahmen von 40–90 KB, `JSON.parse`t sie
  und faehrt 8–12 Policies dagegen — auf derselben synchronen Verbindung, die
  der Server benutzt. "Null Modellaufrufe" ist nicht "null Kosten", und die
  Obergrenze steht deshalb im Bericht. **Innere Teildeckelung:** zusaetzlich
  bricht die Probe die Bearbeitung eines einzelnen Rahmens nach 2000 ms ab und
  fuehrt ihn als enthalten — kein monsteroeser Rahmen darf die gemeinsame
  Obergrenze allein aufessen.
* `sleep.ts:295` — Zaehler: `counters.dreamTracesSeen` und
  `counters.dreamFramesScored`; letzteres traegt die **Gitterbelegungen**
  (Abweichung von Konzept 8.8, siehe AP1). `dreamCandidates` bleibt in Stufe 1
  unberuehrt — sein Schreiber ist der Kandidatenzaehler der Phase 3.
* `sleep.ts:210-223` — das counters-Literal ist untypisiert
  (`const counters = { readCount: 0, ... }`). Die drei Traumschluessel muessen
  hier mit `0` initialisiert werden, sonst ist `counters.dreamFramesScored`
  ein TS-Fehler, noch bevor inkrementiert wird (Eigenschaft existiert auf dem
  inferierten Typ nicht) — die **fuenfte Stelle im Gleichschritt**.
* `sleep.ts:1835-1847` — die `describeSleep`-Signatur bekommt die
  Traumzaehler als optionale Parameter (`dreamFramesScored?: number` usw.) —
  die **sechste Stelle**. Ohne sie bleibt der Zaehler in der Berichtszeile
  unsichtbar, auch wo er stimmt.
* `sleep.ts:1835-1875` — `describeSleep` bekommt vor dem `return` (bei
  `sleep.ts:1874`) eine `if (counters.dreamFramesScored) parts.push(...)`-Klausel.
* `sleep.ts:1952` — **R20, der `keys`-Fehler:**
  `const keys = ['condense','resolve','link','reflect','revise','practise'] as const;`
  wird `const keys = [...volume, ...judgement] as const;` — und `volume`
  (`sleep.ts:1963`) und `judgement` (`sleep.ts:1964`) wandern **vor** die
  `keys`-Zeile. Damit wird die Fehlerklasse unkonstruierbar: ein Schluessel in
  `keys`, der in keiner Unterliste steht, kann nicht mehr entstehen.
  Das ist Aufraeumarbeit fuer Phase 5 (`budget`-Slot), aber sie gehoert hier
  hin, weil Stufe 1 die einzige Gelegenheit ist, die Datei ohne
  Traum-Budgetlogik anzufassen.
* `sleep.ts` — **am Nachtende**, nach der letzten Zeile der Zyklusschleife
  und vor dem Laufabschluss: `sweepDreamFrames(now - dream.frameRetainDays * 86400000)`
  und `sweepDreamTraces(now - dream.retainDays * 86400000)` (Konzept 8.7 —
  der Kehrbesen laeuft in der Nacht, in Chargen mit `LIMIT 500` und eigener
  Klammer je Charge; die Methoden selbst definiert AP7).
* `sleep.ts` — Invalidierungsbericht: die Probe behandelt Rahmen mit
  `created_at` aelter als `meta['dream.corpus_invalidated_at']` (gesetzt von
  `reindex` und dem Bulk-Import, siehe AP1) als **enthalten** mit Grund
  `corpus-invalidated` — nicht als `corpus-drifted` erraten — und der
  Nachtbericht schreibt die Zeile "X von Y Rahmen unbrauchbar seit dem
  Import/reindex am ..." (Konzept 3.3).
* `dream/probe.ts` (neu) —
  * `buildGrid(policy, box, size)`: 8–12 feste Belegungen — Gewichte an den
    Boxraendern, `threshold` in drei Stufen, `hopEntity`/`hopEdge` in zwei.
    Deterministisch, in der Datei deklariert, nicht gewuerfelt.
  * `runGridProbe(...)`: laedt Rahmen ueber `framesFor`, scored je Belegung
    mit `measure`, aggregiert gepaart je Spur, Cluster-Bootstrap ueber
    **Sitzungen** (nicht ueber Spuren), Perzentilintervall 2.5/97.5,
    B = 2000. Berichtet je Belegung `delta`, `ci_low`, `ci_high`,
    `abstainReasons`, `coverage` (R2).
  * `freshnessCheck(...)`: Grundlinie und Kandidat zweimal — gegen die
    eingefrorenen Rahmen und gegen einen **frischen** `fetchFrame` mit
    gleichem Anfragetext, gleichem Owner, gleicher Box.
    **`touch: false` ist fest verdrahtet** (R6), und ein Test prueft das.
    Der Bericht weist zusaetzlich den **Anteil der Rahmen aus, deren Zeilen
    sich von live unterscheiden** (Konzept, offene Frage 11): bei ruhiger Bank
    sind eingefroren und live identisch und der Test ist gegenstandslos —
    diese Teststaerke muss sichtbar sein, nicht verschwiegen werden.
  * `corpusDrifted(frame, today, tolerance)`: maximale relative Aenderung der
    Dokumentfrequenz ueber die **Tokens des Rahmens** (R10), gegen den einmal
    je Nacht in `meta` berechneten Wert (Konzept 3.3).

**Was die Probe ausdruecklich nicht tut:** befoerdern. Es gibt keine
`policy_versions`, kein `dream_slot_state`, keine Bedingungsliste. Das
Ergebnis ist eine Zahl je Belegung im Bericht und in den drei `sleep_runs`-Zaehlern.

**Tests** — `packages/core/test/dream-probe.test.js`

* *Die Probe laeuft ohne Provider (R8):* ein `SleepRunner`-Lauf mit
  `provider = null` -> `assert.ok(run.dreamFramesScored > 0)`.
* *Die Probe laeuft vor den Zyklen (R7):* eine Erinnerung, die `#condense` im
  ersten Zyklus abloesen wuerde, ist im Frisch-Test **noch da**:
  `assert.ok(freshFrame.hop1.some(r => r.id === victim.id))`.
* *Kein Schreibzugriff (R6):* `access_count` und `usefulness` aller Zeilen vor
  und nach einer vollstaendigen Probe identisch —
  `assert.deepEqual(after, before)`. Das ist der Test, der den `touch: false`-Vertrag
  haelt.
* *Wanduhr greift:* `dream.maxEvalMs = 0` -> die Probe bricht ab, berichtet
  `dreamFramesScored: 0` und **wirft nicht**; die Nacht laeuft weiter.
* *Der Amtsinhaber ist immer im Gitter:*
  `assert.ok(grid.some(p => deepEqual(p, incumbent)))`.
* *Das Gitter ist deterministisch:* `assert.deepEqual(buildGrid(p, b, 10), buildGrid(p, b, 10))`.
* *Bootstrap clustert ueber Sitzungen:* zwei Sitzungen mit je zehn
  Beinah-Duplikatspuren -> das Intervall ist breiter als bei Bootstrap ueber
  Spuren: `assert.ok(ciWidth(sessionBootstrap) > ciWidth(traceBootstrap))`.
* *`keys` ist abgeleitet (R20):*
  `assert.deepEqual([...keys].sort(), [...volume, ...judgement].sort())` und
  `assert.deepEqual(Object.keys(canonicalDemand()).sort(), [...keys].sort())`.
* *Enthaltungsgruende werden gezaehlt, nicht verschluckt:*
  `assert.ok(result.abstainReasons['corpus-drifted'] >= 0)` und
  `assert.ok(result.abstainReasons['corpus-invalidated'] >= 0)` — ein Rahmen,
  der aelter als `meta['dream.corpus_invalidated_at']` ist, zaehlt dort, nicht
  unter `corpus-drifted`.
* *Der Kehrbesen laeuft in der Nacht (Konzept 8.7):* eine Nacht mit einem
  Rahmen, der aelter als `frameRetainDays` ist -> danach ist er weg, ohne dass
  die Nacht darueber wirft.

**Fallen**

* **Erste Zeile der Probe muss der Abbruchwaechter sein.** Zwischen
  `sleep.ts:296` und `sleep.ts:310` gibt es kein `#throwIfAborted`; Abbruch
  wird nur bei 269, 310, 344 und 402 geprueft.
* `ask` (`sleep.ts:1789`) wirft nie. Eine Phase, die etwas anderes einbaut,
  fuegt dem Block seine erste echte Wurfstelle zu. Die Probe faengt darum
  **alles** und berichtet, statt die Nacht zu brechen.
* Der Doc-Kommentar bei `sleep.ts:272-278` behauptet, das Messen koste nichts.
  `#demand` ruft heute schon `#cluster`, das O(n²) ueber alle lebenden
  Erinnerungen laeuft. Die Probe macht diese Behauptung messbar falscher —
  entweder der Kommentar wird korrigiert oder die Probe bleibt unterhalb
  `maxEvalMs`. Stufe 1 waehlt beides: Kommentar korrigieren **und** Deckel.
* `dream.maxCallsPerNight` hat in Stufe 1 den Wert 0 und wird trotzdem
  gelesen — als Zusicherung, dass die Probe keinen Modellaufruf macht (R18).
* `MemorySleepPage.tsx:101` `undoable()` blendet den Undo-Knopf ueber eine
  ODER-Kette der Zaehler aus. Stufe 1 befoerdert nichts, also gibt es keine
  Nacht, deren **einzige** Wirkung eine Traumaenderung waere — die Kette
  bleibt unangetastet. Das aendert sich mit Phase 3; hier nur als Notiz.

**Fertig heisst:** `dream-probe.test.js` gruen, `sleep.test.js` und
`night-and-cron.test.js` unveraendert gruen, `npm run build` gruen.

---

### AP11 — Groessen- und Latenztor

**Schreibt (exklusiv):** `scripts/dream-bench.mjs` (neu),
`packages/core/test/dream-budget.test.js` (neu)
**Liest:** alles, schreibt nichts im Quelltext.
**Haengt ab von:** AP9 (der Rekorder muss laufen). Welle 4, parallel zu AP10.

Dies ist die **Lieferung**, an der Stufe 1 haengt: eine Kostenaussage ohne
Messpunkt ist in diesem Vorhaben nicht zulaessig.

**Inhalt**

`scripts/dream-bench.mjs` baut eine synthetische Bank fester Groesse
(Vorschlag: 2000 Erinnerungen, 400 Entitaeten, 800 Kanten), faehrt N = 200
Turns **zweimal** — einmal mit `dream.record = false`, einmal mit `true` — und
berichtet:

| Messwert | Budget | Woher |
|---|---|---|
| p95 Rahmengroesse | 120 KB | `dream_frames.bytes` |
| p50 / p95 zusaetzliche Turn-Latenz | 25 ms (p95) | Differenz der beiden Laeufe |
| zusaetzliche Lesevorgaenge je Turn | 40 | Zaehler um `store.db.prepare` |
| p95 `|possibleSeeds|` | 12 | `frame.possibleSeeds.length` |
| Bytes je Nacht bei `frameRate 0.25` | 1 MB | Hochrechnung aus p50 |

**Vorher und nachher auf demselben Korpus** (Konzept 8.7): `touchMemories`
loescht und schreibt heute schon bis zu acht FTS-Zeilenpaare pro Turn, weil
`memories_au` (`db.ts:341`) bei **jedem** UPDATE auf `memories` feuert. Ohne
die Vorher-Messung wird der Rekorder fuer etwas verantwortlich gemacht, was
schon da war — oder sein Anteil unterschaetzt.

**Dritter Lauf — die zwei Verhaltensaenderungen aus §1.3, vorher/nachher.**
Dieselben 200 Turns noch einmal auf **drei** Staenden: vor AP2 Commit B
(Literal `score: 1`), nach Commit B (Skala, ohne Vorrang) und nach Commit C
(Vorrang). Berichtet wird je Stand, in wievielen Turns sich der Kopf des
gerenderten Blocks aendert (Profilzeile vor Direkttreffer statt dahinter) und
um wie viele Zeilen der Block sich verschiebt. So ist keine der beiden
benannten Aenderungen heimlich; die Zahl gehoert in die PR-Beschreibung.

**Phase 0 — Zufluss messen (Konzept 4.5/11).** Reine Abfrage ueber den
Bestand, kein Produktionscode: wie viele etikettierbare Spuren wuerden pro
Nacht entstehen, je Quelle — `corrections` je Nacht, `upsertReview`-Daten je
Nacht, `superseded_by`-Spruenge je Nacht, Nutzerbearbeitungen an
`/api/memories` je Nacht. Ohne diese Zahl bleiben `minTraces`,
`calibrationTraces` und `cooldownNights` des Konzepts Zeremonie; sie gehoert
in dieselbe PR-Beschreibung wie die Budgetzahlen.

**Das Tor:** reisst ein Wert sein Budget, sinkt `dream.frameRate`, **bevor**
Phase 2 beginnt. Der gemessene Wert und das Datum gehen in den Kopf von
`dream/frame.ts` als Kommentar.

**Tests** — `packages/core/test/dream-budget.test.js`

* *Der Rahmen bleibt unter dem Deckel:* eine Bank mit 500 Erinnerungen, eine
  breite Box -> `assert.ok(frameBytes < config.memory.dream.maxFrameBytes)`.
* *`|possibleSeeds|` ist gedeckelt (Konzept 3.1):* eine Box, deren untere
  Gewichtsgrenzen gegen 0 gehen -> `assert.ok(frame.possibleSeeds.length <= CAP)`
  und bei Ueberschreitung `assert.equal(result.reason, 'seeds-capped')`.
* *Der Rekorder kostet begrenzt:* `assert.ok(readsWithRecorder - readsWithout <= 40)`
  auf einem festen Korpus. Der Test ist absichtlich grosszuegig und hart: er
  faengt eine Regression um eine Groessenordnung, nicht um zehn Prozent.
* *Ungespurte Turns kosten nichts:* `assert.equal(readsWithRecorderOff, readsBaseline)`.

**Fallen**

* Latenzmessungen in `node:test` flackern. Der **Test** prueft nur Lesevorgaenge
  und Bytes (deterministisch); die Zeitmessung liegt im Skript und geht in die
  PR-Beschreibung, nicht in die Testsuite.
* Der Bench darf nicht gegen die echte Datenbank des Nutzers laufen:
  `mkdtempSync` wie in `packages/core/test/setup.mjs`.

**Fertig heisst:** das Skript laeuft, die fuenf Zahlen stehen in der
PR-Beschreibung und im Kopfkommentar von `dream/frame.ts`, der
Vorher/Nachher-Bericht beider Verhaltensaenderungen und die Phase-0-Zuflusszahl
liegen vor, `dream-budget.test.js` gruen, und `dream.frameRate` ist auf einen Wert
gesetzt, der alle fuenf Budgets haelt.

---

## 4. Topologische Baureihenfolge

```
Welle 1  (5 parallel, keine gemeinsame Datei)
  AP1  db.ts                      Schema 21, busy_timeout, Abwaertsbremse, fts5vocab
  AP2  recall.ts                  Gleichstandsbrecher 1+3, In-JS-Sortierungen, Profilskala
  AP3  store.ts                   Gleichstandsbrecher 2+4, entitiesForMany, perEntity
  AP4  types.ts config.ts schemas.ts   Vokabular (inkl. Traum-Typen), Vorgaben, Schema-Untermenge
  AP5  MemoryLayout.tsx           SLEEP_PHASES += 'replay'

Welle 2  (2 parallel)
  AP6  dream/{frame,score,policy}.ts + recall.ts + index.ts
       <- AP2 (Datei), AP3 (entitiesForMany), AP4 (Typen inkl. Rahmentypen)
  AP7  store.ts
       <- AP1 (Tabellen), AP3 (Datei), AP4 (Typen inkl. Traum-Typen)

Welle 3  (2 parallel)
  AP8  dream/measure.ts + index.ts        <- AP6
  AP9  runtime.ts + org/controller.ts     <- AP6, AP7

Welle 4  (2 parallel)
  AP10 dream/probe.ts + sleep.ts + index.ts   <- AP7, AP8, AP9
  AP11 scripts/dream-bench.mjs + Testdatei    <- AP9
```

**Kritischer Pfad:** AP2/AP3/AP4 -> AP6 -> AP8 -> AP10. AP6 ist das groesste
Paket und sollte zuerst besetzt werden.

**Was auf nichts wartet:** AP1, AP2, AP3, AP4, AP5 — fuenf Agenten koennen
sofort anfangen.

**Was auf AP4 wartet, aber nur auf die Typen:** AP6, AP7, AP9, AP10. Wenn
AP4 schnell ist (es schreibt keine Logik), verkuerzt sich die Kette merklich.
Darum ist AP4 absichtlich klein geschnitten.

**Vor jedem Wellenwechsel:** `npm run build && npm run typecheck && npm test`
auf dem zusammengefuehrten Stand. Eine Welle gilt erst als abgeschlossen, wenn
die Grundlinie aus §5 wieder erreicht ist.

---

## 5. Abnahmekriterien der Stufe

1. **`npm run build` gruen** — alle vier Arbeitsbereiche (`core`, `server`,
   `cli`, `web`).
2. **`npm test` nicht schlechter als die Grundlinie.** Grundlinie ist
   **288 von 289**; der eine Fehlschlag ist der bekannt flackernde
   `packages/core/test/memory-owner.test.js:68`. Jeder weitere rote Test ist
   eine Regression dieser Stufe, bis das Gegenteil gezeigt ist — und "das
   flackert doch immer" ist erst dann eine Antwort, wenn derselbe Test zehnmal
   in Folge gelaufen ist.
   Mit den neuen Testdateien steigt die Gesamtzahl; die **Zahl der
   Fehlschlaege** bleibt bei eins.
3. **`npm run typecheck` gruen** — `tsc -b packages/core packages/server packages/cli`.
4. **`npm test -w @rookery/web` nicht schlechter:** `page-navigation.test.mjs`
   bleibt rot (Bestand, `routeMeta` fehlt), alles andere gruen, plus der neue
   `sleep-phases.test.mjs`.
5. **Die Messwerte des Budgettors** aus AP11 liegen vor und halten ihre
   Budgets, oder `dream.frameRate` ist gesenkt, bis sie halten:
   * p95 Rahmengroesse <= 120 KB
   * p95 zusaetzliche Turn-Latenz <= 25 ms
   * zusaetzliche Lesevorgaenge je Turn <= 40
   * p95 `|possibleSeeds|` <= 12
   * Hochrechnung <= 1 MB je Nacht bei der gewaehlten `frameRate`
6. **Der Aequivalenztest laeuft je Pipeline** (AP6) und faellt an keiner der
   200 Ziehungen durch.
7. **Der Falsifikationstest** aus AP8 ist gruen: das Blockmass trennt, wo das
   Rueckgabewertmass nicht trennt. Ist er rot, ist Stufe 1 fachlich
   gescheitert, auch wenn alles andere gruen ist.
8. **Der Turn-Block ist byte-gleich mit und ohne Rekorder** (AP9).
9. **`dream.enabled` und `dream.record` stehen in der ausgelieferten
   Vorgabe auf `false`.** Stufe 1 liefert die Faehigkeit, nicht den Betrieb.

---

## 6. Fallenregister — je Paket angeheftet

| Falle | Wo sie zuschlaegt | Paket |
|---|---|---|
| **Die sechs Stellen im Gleichschritt.** `types.ts:417` (`SleepRun`, optional), `store.ts:1314-1333` (`createSleepRun`-Literal), `store.ts:1344-1362` (`updateSleepRun`-Whitelist), `store.ts:1599-1623` (`mapSleepRun`), `sleep.ts:210-223` (counters-Literal, untypisiert — ein neuer Schluessel ist dort ein Compilefehler), `sleep.ts:1835-1847` (`describeSleep`-Signatur). Ein nicht gelisteter Schluessel in der Whitelist wird **ohne Fehler, ohne Log, ohne Typfehler** uebersprungen. | AP4 (eine Stelle), AP7 (drei Stellen), AP10 (zwei Stellen) | AP4, AP7, AP10 |
| **`schemas.ts` ist eine Untermenge.** Fehlt `dream: dreamConfigSchema` bei `schemas.ts:289`, entfernt zod den Zweig und der PATCH antwortet mit 200. Beweis, dass das heute schon beisst: `memory.gate` und `memory.graph` stehen nicht drin. | AP4 | AP4 |
| **Kein Schreiben aus offener Transaktion.** Ein blankes `BEGIN` waehrend `mergeEntities` (`store.ts:853`) oder `undoSleepRun` (`store.ts:1435`) wirft und bricht genau den Pfad, den es protokollieren wollte. `SAVEPOINT`/`RELEASE` statt Waechter-Flag. | AP7 | AP7 |
| **`recall` darf sein Verhalten NICHT aendern.** Das ist die Abnahme von AP6, nicht eine Nebenbedingung. | AP2, AP6, AP9 | AP2, AP6, AP9 |
| **`dream_frames` ist ein Wortlautspeicher.** `frame.query.text` ist die woertliche Nutzeranfrage, `frame.records` traegt `content` und `evidence`. Kein bestehender Loeschpfad erreicht ihn heute. | AP1 (`owner`/`session_id`-Spalten, kein `pinned`), AP7 (Loeschmethoden), AP9 (`deleteSession`) | AP1, AP7, AP9 |
| **Schema-Nummer 21 kann kollidieren** mit dem Schwesterbaum `E:\DEV\rookery-agent`. | AP1 | AP1 |
| **`SUM(LENGTH(content))` ist kein billiger Fingerabdruck**, sondern ein Vollscan im Turn. Einmal je Nacht in `meta`, nie im Turn. | AP7, AP10 | AP7, AP10 |
| **Kein `#throwIfAborted` zwischen `sleep.ts:296` und `sleep.ts:310`.** Die erste Zeile der Probe muss der Abbruchwaechter sein. | AP10 | AP10 |
| **`ask` wirft nie** (`sleep.ts:1789`). Eine neue Phase, die wirft, ist die erste echte Wurfstelle im Block. | AP10 | AP10 |
| **`memory-owner.test.js:68` flackert.** Ein Fehlschlag dort ist nicht automatisch der bekannte. Zehnmal laufen lassen. | AP3, alle | alle |
| **`page-navigation.test.mjs` ist bereits rot.** Nicht mitreparieren, nicht verdecken, keine neue `/memory`-Route. | AP5 | AP5 |
| **`rookery config set` umgeht zod.** Werte werden beim Lesen geklemmt, nicht beim Schreiben vertraut. | AP4 und jeder Leser aus der Schluesseltabelle | AP4 |
| **Owner-Filterung ist zweimal noetig**, in SQL und in JS, weil `memory_entity_links` keine Owner-Spalte hat und `edgesFrom` die vorhandene `memory_edges.owner`-Spalte nicht filtert. Jeder neue Lesepfad wiederholt beides. | AP3, AP6 | AP3, AP6 |
| **Drei degradierte Welten, nicht zwei.** `!match` (`recall.ts:87`), verschluckte MATCH-Ausnahme (`recall.ts:114-116`), und "Treffer, aber alle unter `threshold`" — letzteres ist ein **legitimer** Fehlschlag und muss gescored werden. Ein Rekorder, der `degraded` aus `top.length === 0` schliesst, ist falsch. | AP6, AP8 | AP6, AP8 |

---

## 7. Was Stufe 1 ausdruecklich offen laesst

Diese Punkte sind **nicht** Versaeumnisse des Bauplans, sondern benannte
Grenzen. Sie gehoeren in jede Bewertung, die auf Stufe 1 aufsetzt.

1. **Der Schaetzer ist eine untere Schranke (R2).** Der Missing-Label-Bias ist
   nicht schliessbar: eine Erinnerung bekommt nur ueber Kanaele ein Etikett,
   die voraussetzen, dass der Amtsinhaber sie hochgespuelt hat. Die
   Abdeckungsrate wird berichtet; ein Delta, das ueberwiegend aus
   unetikettierten Positionen stammt, ist ungueltig. Stufe 1 hat noch gar
   keine Etiketten — die Gitterprobe misst gegen einen vom Aufrufer
   gelieferten `gain`. Ohne Phase 2 sagt sie nichts ueber Abrufguete, sondern
   nur ueber Stabilitaet und Kosten.
2. **Umkehrbar in Parametern, nicht in Zaehlern (R4).** `touchMemories` ist
   ein monotones `access_count + 1` und `usefulness = MIN(1.0, usefulness + 0.03)`
   ohne Historie; `usefulness` traegt 30 % der Stilllegungsentscheidung
   (`sleep.ts:684`). Stufe 1 legt mit `memory_touches` die Aufzeichnung an,
   aus der sich beide **grundsaetzlich** nachrechnen liessen. Ob daraus
   wirklich neu gerechnet wird, ist offen. Der Satz "nie unumkehrbar" ist
   gestrichen.
3. **Der eingefrorene Pruefsatz (R3)** hat in Stufe 1 nur seine Spalte
   (`dream_traces.audit`). Die kumulative Befoerderungsbedingung — Delta des
   Kandidaten gegen den **Werksvorgabe**-Parametersatz auf dem Pruefsatz mit
   `ci_low > 0` — kommt mit Phase 3, und der Pruefsatz wird je Befoerderung
   genau einmal angefasst.
4. **Der `gate`-Slot (R5)** ist draussen: Praefix-Gueltigkeit erzeugt dort ein
   identisch nulles Delta. Der Ersatz — Erst-Divergenz-Bewertung, durch die
   erste Divergenz hindurch bewerten und danach aufhoeren — kommt erst, wenn
   dafuer ein eigenes Messziel definiert ist.
5. **Leckage (R21).** Der Leckage-Test wird in Phase 3 ein
   **Konstruktionstest**: der Prompt wird aus einer typisierten Struktur rein
   numerischer Aggregate gebaut, ohne jedes Zeichenkettenfeld. Die thematische
   Naehe zwischen Trainings- und Rueckhaltesitzungen bleibt ein **akzeptierter,
   unvermessener Rest**. Das ist keine Loesung, sondern eine Offenlegung.
6. **Nie einen Wortlaut laenger aufbewahren als die Erinnerung, aus der er
   stammt (R17).** Stufe 1 setzt das fuer Sitzung und Owner um. Der harte Fall
   — `DELETE FROM memories` ueber `?hard` und `archiveMemories` beim
   Agentenwechsel — loescht Etikettenziele wirklich und bleibt offen.
7. **`#demand`s Kostenversprechen.** Der Doc-Kommentar bei `sleep.ts:272-278`
   sagt, eine Nacht, die sich selbst vermisst, koste nichts. `#cluster` ist
   schon heute O(n²) ueber alle lebenden Erinnerungen. Stufe 1 korrigiert den
   Kommentar und deckelt die Probe; ob `#demand` insgesamt zu teuer geworden
   ist, bleibt eine eigene Frage.
