# Traum — Bauplan Stufe 2 bis 6

Stand: 2026-09-18. Grundlage ist `dream-and-recursive-self-improvement.md`
(Fassung 2) und der erledigte `dream-stage1-buildplan.md`. Stufe 1 liegt in
`main` (Schema 23).

Dieser Plan deckt die Phasen 2 bis 6 des Konzepts §11 **in einer Lieferung**.
Er ist nach demselben Muster gebaut wie der Stufe-1-Plan: Arbeitspakete mit
disjunkten Dateimengen, Wellen, ein Gate je Welle.

---

## 0. Die Entscheidungen des Verantwortlichen, und wo sie landen

Nicht neu verhandeln. Jede Zeile muss in mindestens einem Paket
wiederzufinden sein.

| # | Entscheidung (Konzept) | Paket |
|---|---|---|
| S1 | `source` = `correction \| review \| merge \| user`; `usefulness`/`memory_touches` bleiben Merkmale (E9) | AP4 |
| S2 | Ein Etikett behauptet etwas ueber **diesen Turn**; Primaerquelle nach `user > correction > merge`; Widerspruch wird gezaehlt, nie still ueberschrieben (4.1) | AP4 |
| S3 | Korrekturetikett braucht Turnbezug ueber Zitatlokalisierung; mehrdeutig -> `turn_id = NULL` und `scope = 'session'`, nie raten (4.2a) | AP3, AP4, AP12 |
| S4 | Anachronismus-Sperre: `created_at` des Etikettenziels muss **vor** dem Turn liegen (4.2a) | AP4 |
| S5 | `user`-Etiketten nur auf dem HTTP-Pfad, mit Akteur-Parameter im Store; Zuordnung auf das Sitzungsfenster (4.2b) | AP3, AP13 |
| S6 | Die Chat-Hervorhebung wird ein Etikettenkanal mit echtem Turnbezug (4.2b) | AP13, AP15 |
| S7 | `merge` erzeugt **nur** negative Etiketten, hoechstens ein `supersedes`-Sprung (4.2c) | AP4, AP12 |
| S8 | `review` schreibt `target = '*'`, `relevance = (overall-1)/4`, geht **nie** in DCG ein (4.2d) | AP3, AP14 |
| S9 | `dead_at` statt Loeschen; die Etikettenhistorie bleibt stehen (8.3) | AP3 |
| S10 | Jede Bewertung berichtet `label_coverage` und `cost_only_share`; Delta ueberwiegend aus unetikettierten Positionen = ungueltig (4.4) | AP4, AP8 |
| S11 | Gepaart je Spur, Cluster-Bootstrap ueber **Sitzungen**, ausgewiesen als `genaehert` (5.3) | AP8 |
| S12 | Selektion auf dem Training, genau **eine** Pruefung auf dem Rueckhalt (E4) | AP8 |
| S13 | Der eingefrorene Pruefsatz wird je Befoerderung genau einmal angefasst (5.5d) | AP8, AP9 |
| S14 | Drei Sensoren, drei Namen: Frisch-Test, Etikettenabgleich, Wach-Test (E12) | AP8 (a,b), AP12 (c) |
| S15 | Kandidatenschreiber sieht nie Rohtext; Konstruktionstest ueber eine Struktur ohne Zeichenkettenfelder (E13) | AP6 |
| S16 | Kandidatenschreiber laeuft **nicht** auf `ask`s `effort: 'low'` (E14) | AP6 |
| S17 | Anti-Gaming ist **Zulassungspruefung vor** der Bewertung, keine Messung (E15) | AP5 |
| S18 | Ein Resolver je Slot ueber alle Aufrufstellen; Config-Abweichung vom Vorgabewert = `origin: 'user'` (E16, 9.3) | AP10, AP13, AP14 |
| S19 | Erkundung nur kostenlos; Erkundung und Befoerderung teilen sich nie eine Nacht im selben Slot (E17) | AP9 |
| S20 | Jede Befoerderung traegt ihre `run_id`, faellt unter das Nacht-Undo, speichert `prev_active_id` (E18) | AP3, AP9 |
| S21 | Zwei Aufbewahrungsuhren; kein Wortlaut ueberlebt seine Erinnerung (E19) | AP3, AP12 |
| S22 | Drei Schalter: `enabled`, `record`, `promote`; kein Schluessel ohne Leser (E20) | AP2 |
| S23 | Konfiguration wird beim **Lesen** geklemmt (E21) | AP2, AP10 |
| S24 | `keys = [...volume, ...judgement]`, Fehlerklasse unkonstruierbar, Quelltest (H4) | AP11 |
| S25 | Ruecknahme **in** der `undoSleepRun`-Transaktion, nach dem Kantenloeschen, vor dem `undone_at`-Stempel (10.4) | AP3 |
| S26 | Befoerderung ist sichtbar: Mail an den Nutzer, `describeSleep`, Zaehler, Diff-Blatt, Revert-Link (9.6) | AP12, AP14, AP16 |
| S27 | Kein vierter `/memory`-Kindpfad; der Traum ist ein Abschnitt der Naechte-Seite (9.6) | AP16 |
| S28 | Phase 6 nur mit Rekordertreue: `argsHash` + vollstaendiges Input-JSON + echter Name auf dem `end`-Ereignis | AP7 |
| S29 | Erst-Divergenz-Bewertung: vier Urteile, Beobachtungen auf `(step, args_hash)` geschluesselt, `trialEpisodes` standardmaessig 0 (7.2) | AP7 |
| S30 | Der Traum beruehrt nie (`touch: false`), liest nie ueber Besitzergrenzen, verwandelt nie einen degradierten Pfad in einen Fehler (10.5) | alle |

---

## 1. Was diese Stufe ist, und was sie ausdruecklich nicht ist

### 1.1 Umfang

1. **Phase 2 — Etiketten.** Vier Quellen mit je ihrer Abbildung auf `gain(m)`,
   `corrections.turn_id` mit Zitatlokalisierung, Akteur-Parameter auf dem
   HTTP-Pfad, die Chat-Hervorhebung als Klickziel, Kappa je Slot,
   `reachable_rate`, `label_coverage`, `cost_only_share`.
2. **Phase 3 — Traum fuer `recall`.** Kandidatenschreiber mit eigenem Aufrufer,
   Zulassungspruefung, Selektion auf Training, **eine** Rueckhaltepruefung, der
   eingefrorene Pruefsatz, `policy_versions`, `dream_slot_state`, `dream_evals`,
   Befoerderungstor, Ruecknahme in der Transaktion, `dream` in
   `SleepStage`/`SLEEP_PHASES`.
3. **Phase 4 — Sichtbarkeit und Wach-Test.** Traumabschnitt der Naechte-Seite,
   Versionskurve, Diff-Blatt je Befoerderung, `undoable()`-Kette, Mail an den
   Nutzer, Zaehler in Tabelle und Bericht, Kalibrierung mit Einfrieren.
4. **Phase 5 — Breite.** `budget`-Slot mit dem `allocateNightBudget`-
   Invariantentest und beobachteten Ertragsraten; `retry` einseitig.
5. **Phase 6 — Stufe 2, Divergenzprobe.** Rekordertreue zuerst, dann der
   praefixgeschlossene Simulator mit Erst-Divergenz-Bewertung. Standardmaessig
   aus (`trialEpisodes: 0`), mit dem Validierungstor aus dem Konzept.

### 1.2 Ausdruecklich nicht

* **Kein `gate`-Slot** (E22). Die Erst-Divergenz-Bewertung wird als Mechanismus
  gebaut (AP7), aber `gate` bekommt kein Messziel und bleibt draussen.
* **Kein `cluster`-Slot** (Offene Frage 7).
* **Keine Neuberechnung von `access_count`/`usefulness`** aus `memory_touches`
  (Offene Frage 3).
* **Kein vierter `/memory`-Kindpfad** (9.6) und keine Traumknoepfe auf der
  Einstellungsseite.
* **Keine Befoerderung fuer Agenten.** Bewertet und befoerdert wird nur
  `ASSISTANT_MEMORY_OWNER`; die Agentenpipeline wird an den Resolver
  angeschlossen (S18), aber nicht gerahmt und nicht bewertet.
* **Kein Default an.** `enabled`, `record`, `promote` bleiben `false`,
  `trialEpisodes` bleibt 0. Diese Stufe liefert die Maschine, nicht ihren
  Anlauf.

### 1.3 Die erklaerten Verhaltensaenderungen

Vier, jede in genau einem Paket, jede mit Test:

1. **`resolvePolicy` liest befoerderte Versionen** (AP10). Solange keine
   Version existiert, ist das ein Nullschritt.
2. **Der Agentenpfad geht ueber den Resolver** (AP14). Bei Vorgabewerten
   identisch; bei abweichender Konfiguration ist es die Behebung von E16.
3. **`PATCH`/`DELETE /api/memories/:id` nehmen einen Akteur** (AP13). Vorgabe
   auf dem HTTP-Pfad ist `'user'`; das Werkzeug des Modells geht weiter direkt
   an den Store und heisst dort `'model'`.
4. **`allocateNightBudget`s `keys` wird abgeleitet statt literal** (AP11). Bei
   heutigem Bestand identisch, aber die Fehlerklasse aus H4 wird
   unkonstruierbar.

---

## 2. Dateibesitz — die Karte

Ein Paket **schreibt** nur seine Zeile. Zwei Pakete derselben Welle teilen nie
eine Datei.

| Datei | Paket | Welle |
|---|---|---|
| `packages/core/src/memory/db.ts` | AP1 | 1 |
| `packages/core/src/types.ts` | AP2 | 1 |
| `packages/core/src/config.ts` | AP2 | 1 |
| `packages/server/src/schemas.ts` | AP2 | 1 |
| `packages/core/src/memory/store.ts` | AP3 | 2 |
| `packages/core/src/memory/dream/label.ts` (neu) | AP4 | 2 |
| `packages/core/src/memory/dream/admission.ts` (neu) | AP5 | 2 |
| `packages/core/src/memory/dream/candidate.ts` (neu) | AP6 | 2 |
| `packages/core/src/memory/dream/trajectory.ts` (neu) | AP7 | 2 |
| `packages/core/src/providers/claude-code.ts` | AP7 | 2 |
| `packages/core/src/memory/dream/evaluate.ts` (neu) | AP8 | 3 |
| `packages/core/src/memory/dream/promote.ts` (neu) | AP9 | 3 |
| `packages/core/src/memory/dream/policy.ts` | AP10 | 3 |
| `packages/core/src/memory/dream/slots.ts` (neu) | AP11 | 3 |
| `packages/core/src/memory/sleep.ts` | AP12 | 4 |
| `packages/server/src/routes/dream.ts` (neu), `routes/memories.ts` | AP13 | 5 |
| `packages/core/src/runtime.ts`, `org/controller.ts`, `org/store.ts` | AP14 | 5 |
| `packages/web` Chat-Hervorhebung | AP15 | 5 |
| `packages/web/src/pages/MemoryLayout.tsx` | AP17 | 5 |
| `packages/web/src/pages/MemorySleepPage.tsx` | AP16 | 6 |
| `packages/core/src/index.ts` | **der Verantwortliche**, nach jeder Welle | 2–5 |

### 2.1 Die geteilten Dateien und wie sie entschaerft sind

**`store.ts`** — Etiketten, Policy-Versionen, Slot-Zustand, Bewertungen,
Episoden, Akteur-Parameter und die Ruecknahme in der Transaktion sind **ein**
Paket (AP3), nicht fuenf. Die Datei hat in dieser Stufe genau einen Besitzer.

**`sleep.ts`** — dieselbe Regel, ein Besitzer (AP12), eine eigene Welle. Die
Datei ist der kritische Pfad; sie faengt erst an, wenn alle Bibliotheken
stehen.

**`packages/core/src/index.ts`** — sieben Pakete haengen je eine Exportzeile
an. Das ist die eine Datei, die kein Paket anfasst: der Verantwortliche
ergaenzt die Exporte nach jeder Welle, am Ende des Speicherblocks, nie
umsortiert.

---

## 3. Die Arbeitspakete

Gemeinsame Regeln fuer jedes Paket: nur die eigenen Dateien schreiben; keine
`packages/core/src/index.ts` anfassen; keine bestehenden Tests aendern, ausser
die Zeile nennt das Paket ausdruecklich; Bezeichner und Kommentare auf
Englisch; kein Build- und kein Testlauf im Paket (das Gate laeuft am
Wellenende beim Verantwortlichen).

### AP1 — Schema 24

**Schreibt:** `packages/core/src/memory/db.ts`, `packages/core/test/dream-schema.test.js`
**Welle 1.** Haengt von nichts ab.

* `SCHEMA_VERSION` 23 -> 24.
* Neuer `db.exec()`-Block hinter den Stufe-1-Traumtabellen, Hausstil
  `CREATE TABLE IF NOT EXISTS`: `policy_versions` und `dream_slot_state`
  (Konzept 8.5, woertlich), `dream_evals` (8.6, woertlich) mit
  `idx_dream_evals_run`.
* `dream_episodes` — der **Index** ueber das bestehende Turn-Journal, kein
  zweiter Wortlautspeicher. Die Schritte einer Episode stehen bereits in
  `turn_events` (`db.ts:892-910`); `dream_episodes` haelt nur, was das Journal
  nicht weiss:
  `id TEXT PRIMARY KEY` (= `turns.id` bzw. `assignments.id`), `owner`,
  `kind TEXT NOT NULL` (`turn | assignment`), `session_id`, `slot`,
  `steps INTEGER NOT NULL`, `outcome TEXT NOT NULL` (`success | failure |
  unknown`), `holdout`/`audit` `INTEGER NOT NULL DEFAULT 0`, `started_at`,
  `finished_at`, `created_at`. Index auf `(owner, created_at)`.
* Spalten hinter `hasColumn`:
  `corrections.turn_id TEXT`;
  `dream_labels.owner TEXT` und `dream_labels.session_id TEXT`;
  `messages.turn_id TEXT`;
  `sleep_runs.dream_promoted` und `sleep_runs.dream_labels_written`, beide
  `INTEGER NOT NULL DEFAULT 0`.
* Indizes: `idx_dream_labels_source` auf `(source, created_at)`,
  `idx_corrections_turn` auf `(turn_id)`, `idx_messages_turn` auf `(turn_id)`.
* **Kein** `DROP`, **keine** Datenmigration, **keine** Aenderung an bestehenden
  Tabellen ausser den genannten `ADD COLUMN`.

*Falle:* `dream_labels.turn_id` ist `NOT NULL` und Teil des Primaerschluessels.
Ein sitzungsweites Etikett (Konzept 4.2a) traegt deshalb die **Sitzungs-ID** in
`turn_id` und `scope = 'session'`; nur `scope = 'turn'` geht in DCG ein. Das
ist die Aufloesung des Widerspruchs im Konzept, und sie steht als Kommentar an
der Tabelle.

### AP2 — Vokabular, Vorgaben, Schema-Untermenge

**Schreibt:** `packages/core/src/types.ts`, `packages/core/src/config.ts`,
`packages/server/src/schemas.ts`, `packages/core/test/dream-config.test.js`
**Welle 1.** Haengt von nichts ab.

* `types.ts`
  * `SleepStage` bekommt `'dream'`.
  * `SleepRun` bekommt `dreamPromoted: number` und
    `dreamLabelsWritten: number`.
  * `Message` bekommt `turnId?: string`.
  * Das `'tool'`-Ereignis (`types.ts:193`) bekommt `argsHash?: string` und
    `input?: string` — die Vorbedingung von Phase 6 (S28).
  * Neue Typen: `DreamLabelSource = 'correction' | 'review' | 'merge' | 'user'`,
    `DreamLabelScope = 'turn' | 'session'`, `DreamLabel`,
    `DreamSlot = 'recall' | 'budget' | 'retry'`,
    `PolicyOrigin = 'default' | 'dream' | 'user'`, `PolicyVersion`,
    `DreamSlotFreezeReason = 'calibration' | 'staleness' | 'agreement' | 'manual'`,
    `DreamSlotState`, `DreamEval`, `DreamEpisode`, `DreamEpisodeStep`,
    `DreamVerdict = 'no-change' | 'may-avoid-failure' | 'regression-risk'`,
    `MemoryActor = 'user' | 'model' | 'sleep'`.
    Die Felder spiegeln 1:1 die Spalten aus AP1.
* `config.ts` — `memory.dream` waechst um die Schluessel unten. Die
  Kommentartabelle ueber dem Block nennt **fuer jeden** Schluessel seine
  Leserstelle (S22); ein Schluessel ohne Leser kommt nicht hinein.

  | Schluessel | Vorgabe | Leser |
  |---|---|---|
  | `promote` | `false` | AP9 |
  | `slots` | `['recall']` | AP12 |
  | `candidates` | `6` `geraten` | AP6 |
  | `model` | `'sonnet'` `geraten` | AP6 |
  | `minTraces` | `200` `geraten` | AP8 |
  | `margin` | `0.02` `geraten` | AP9 |
  | `coverageFloor` / `costOnlyCeiling` | `0.3` / `0.5` `geraten` | AP8 |
  | `abstainEps` / `abstainFloor` | `0.05` / `0.30` `geraten` | AP8 |
  | `reachableFloor` | `0.5` `geraten` | AP8 |
  | `correctionPrecisionFloor` | `0.6` `geraten` | AP12 |
  | `labelModelCalls` | `0` | AP12 |
  | `userLabelWindow` | 7 Tage in ms `geraten` | AP4, AP13 |
  | `agreementFloor` | `0.4` `geraten` | AP8 |
  | `calibrationTraces` / `tolerance` | `50` / `0.05` `geraten` | AP12 |
  | `cooldownNights` | `7` `geraten` | AP9 |
  | `maxPromotionsPerNight` | `1` | AP9 |
  | `explorationRate` | `0` | AP9 |
  | `trialEpisodes` | `0` | AP7, AP12 |

  Dazu: `maxCallsPerNight` steigt von `0` auf `6` `geraten` — ab Phase 3 gibt
  es einen Modellaufruf, den es zu deckeln gilt.
* `schemas.ts` — `dreamConfigSchema` bekommt fuer jeden neuen Schluessel seine
  Zod-Klammer mit demselben Bereich, den AP10 beim **Lesen** klemmt (S23).
  `slots` ist ein `z.array(z.enum([...]))` und wird als Ganzes ersetzt (E21).

### AP3 — Persistenz Stufe 2+

**Schreibt:** `packages/core/src/memory/store.ts`,
`packages/core/test/dream-store-stage2.test.js`
**Welle 2.** Haengt von AP1 (Tabellen) und AP2 (Typen) ab.

* **Etiketten:** `putLabel(label)` / `putLabels(labels)` (`INSERT OR REPLACE`,
  der Schluessel ist `(turn_id, target, source)`), `labelsForTurns(turnIds)`,
  `labelsForSessions(sessionIds)`, `markLabelsDead(memoryId, at)`,
  `labelCounts(owner, since)` je Quelle, `sweepDreamLabels(before)`.
* **Policy-Versionen:** `createPolicyVersion(input)`,
  `activePolicy(owner, slot)` (`promoted_at IS NOT NULL AND retired_at IS
  NULL`, hoechste `version`), `policyHistory(owner, slot, limit)`,
  `promotePolicyVersion(id, { prevActiveId, sleepRunId, at })`,
  `retirePolicyVersion(id, at)`, `reactivatePolicyVersion(id)`.
* **Slot-Zustand:** `slotState(owner, slot)`, `freezeSlot(owner, slot, reason)`,
  `thawSlot(owner, slot)`, `setSlotCooldown(owner, slot, until)`.
* **Bewertungen:** `recordDreamEval(eval)`, `listDreamEvals(filter)`,
  `lastPromotedTraceSetHash(owner, slot)`, `sweepDreamEvals(before)`.
* **Episoden:** `recordDreamEpisode(episode)`,
  `dreamEpisodes(owner, { holdout, audit, limit })`,
  `sweepDreamEpisodes(before)`.
* **Turnbezug:** `addCorrection` bekommt ein optionales `turnId`;
  `addMessage` bekommt ein optionales `turnId` und `getMessages` gibt es
  zurueck; `correctionsSince(owner, since)` als Leser fuer AP12, falls noch
  keiner existiert.
* **Akteur (S5):** `forgetMemory(id, actor)`, `deleteMemory(id, actor)`,
  `updateMemory(id, patch, actor)` — `actor` ist optional mit Vorgabe
  `'model'`, damit kein Aufrufer bricht. Nur bei `actor === 'user'` schreibt
  der Store ein `user`-Etikett (`relevance = 0` bei Vergessen/Loeschen/
  `forgotten: true`, `relevance = 1` bei `pinned: true`), `scope = 'session'`,
  `evidence` = Routenname + Akteur. Der Store ist der Trichter; die Route
  reicht nur den Akteur durch.
* **Ruecknahme (S25):** In `undoSleepRun`, **in** der Transaktion, nach
  `DELETE FROM memory_edges WHERE run_id = ?` und **vor** dem
  `undone_at`-Stempel: die `policy_versions` dieser `sleep_run_id` demotieren
  (`retired_at` setzen), ihr `prev_active_id` reaktivieren, die `dream_evals`
  der Nacht loeschen. `counts` und der Rueckgabetyp wachsen um `policies`.
  Die Unterscheidung "geschrieben von" gegen "beruehrt von" gilt hier genauso:
  nur Zeilen mit `created_at >= run.startedAt`.
* **Zaehler an vier Stellen im Gleichschritt** (Konzept 8.8):
  `createSleepRun`-Literal, `updateSleepRun`-Whitelist, `mapSleepRun`, und der
  Typ aus AP2 — fuer `dreamPromoted` und `dreamLabelsWritten`.
* `markLabelsDead` wird aus `forgetMemory`/`deleteMemory`/`archiveMemories`
  mitgerufen (S9): die Zeile bleibt, sie bekommt nur `dead_at`.

### AP4 — Von der Quelle zum Etikett

**Schreibt:** `packages/core/src/memory/dream/label.ts` (neu),
`packages/core/test/dream-label.test.js`
**Welle 2.** Haengt von AP2 ab. **Reine Funktionen, kein Store, keine Uhr** —
alle Eingaben werden uebergeben, `now` als Parameter.

* `locateTurn(messages, quote)` -> `{ turnId: string | null, scope }`. Genau
  ein Vorkommen in genau einer Nutzer-Nachricht: deren `turnId`. Null oder
  mehrere: `null` und `scope: 'session'`. **Nicht raten** (S3).
* `correctionLabels(input)` -> `DreamLabel[]`. Bildet die Korrektur ueber
  `similarity(normalizeTokens(text), normalizeTokens(content))` gegen die
  erreichbare Menge R ab. Treffer ueber `duplicateThreshold` auf einer Zeile,
  **die im Prompt stand** -> `relevance = 0`; Treffer auf einer Zeile, die zum
  Turnzeitpunkt existierte und **nicht** im Prompt stand -> `relevance = 1`.
  **Anachronismus-Sperre (S4):** `record.createdAt < turn.startedAt`, sonst
  kein Etikett.
* `mergeLabels(input)` -> `DreamLabel[]`. Standen in **einem** Turn zwei
  Zeilen im Prompt, die spaeter in dasselbe Verdichtungscluster fielen
  (gleiches `supersededBy`, **hoechstens ein Sprung**), bekommt die schlechter
  platzierte `relevance = 0`. Nur negative Etiketten (S7).
* `reviewLabel(review)` -> `DreamLabel` mit `target: '*'`,
  `relevance = (overall - 1) / 4`, `scope: 'session'`. Geht **nie** in DCG
  ein (S8) — das erzwingt `gainFrom`, nicht der Aufrufer.
* `userLabel(input)` -> `DreamLabel`.
* `gainFrom(labels)` -> `{ gain: GainFunction, conflicts: number }`.
  Primaerquelle nach `user > correction > merge`; `review` und
  `scope: 'session'` liefern nie ein `gain`. Ein Widerspruch auf demselben
  Ziel wird **gezaehlt**, nie still ueberschrieben (S2).
* `labelCoverage(positions, labelledUniverse)`, `costOnlyShare(deltaPositions)`,
  `cohensKappa(a, b)`, `pairwiseAgreement(a, b)` (S10).

*Test-Pflichtfaelle:* ein zweimal vorkommendes Zitat ergibt `NULL` und ein
sitzungsweites Etikett; ein Etikett auf eine Zeile, die zum Turnzeitpunkt noch
nicht existierte, entsteht nie; `review` hebt kein `gain`; zwei Quellen im
Widerspruch erhoehen `conflicts` und die Rangfolge entscheidet.

### AP5 — Zulassungspruefung

**Schreibt:** `packages/core/src/memory/dream/admission.ts` (neu),
`packages/core/test/dream-admission.test.js`
**Welle 2.** Haengt von AP2 ab; darf `dream/measure.ts` **lesen**
(`isScalarMultiple`, `normaliseWeights`).

`admit(candidate, incumbent, box, stats)` -> `{ ok, findings: string[] }`,
laeuft **vor** jeder Bewertung (S17):

* **H1** `coverage(cand) >= 0.5 * coverage(base)` — "verliere keine Deckung".
* **H3** Wiederbelebungsrate nicht ueber der des Amtsinhabers (gezaehlt, auch
  wenn erst der `gate`-Slot sie ausloest).
* **H9** ein Gewichtsvektor, der ein positives skalares Vielfaches des
  Amtsinhabervektors ist, wird abgelehnt.
* **Boxverstoss** ist ein **Erzeugungsfehler**, keine Enthaltung — eigener
  Befund, eigener Test.

*Falsifikationstest der Suite (Konzept 10.1):* jeder Weg muss unter dem naiven
Mass (nur nDCG, ohne Kostenterm, ohne Normierung) **hoeher** scoren und hier
**abgelehnt** werden. Laesst sich ein Weg nicht hoeher scoren, wird der
Mechanismus geloescht, nicht aus Symmetrie behalten.

### AP6 — Der Kandidatenschreiber

**Schreibt:** `packages/core/src/memory/dream/candidate.ts` (neu),
`packages/core/test/dream-candidate.test.js`
**Welle 2.** Haengt von AP2 ab.

* `CandidateAggregates` — eine typisierte Struktur **ohne ein einziges
  Zeichenkettenfeld** (S15). Inhalt nach Konzept 6.2: je Fehlfall die
  Mittelwerte von `relevance`, `importance`, `recency`, `usage`, `tagHit` der
  Zeilen, die haetten oben stehen sollen, gegen die, die oben standen;
  Rangposition des ersten relevanten Treffers; Anteil der Faelle, in denen das
  Zeichenbudget vor dem ersten relevanten Treffer riss; Anteil, in dem Hop 2
  den Treffer geliefert haette.
* `buildAggregates(frames, gain, policy)` -> `CandidateAggregates`.
* `renderCandidatePrompt(aggregates, box, policy)` -> `string`. **Kein**
  Anfragetext, **kein** Erinnerungsinhalt, **keine** Rueckhaltespur.
* `proposeCandidates(provider, input, signal)` -> `Promise<RecallPolicy[]>`.
  Eigener schmaler Aufrufer mit `effort` aus der Konfiguration, **nicht**
  `ask`s verdrahtetes `'low'` (S16). Wirft nie; eine leere Antwort ist ein
  gezaehlter Fehlschlag, kein Kandidat. Ausgabe streng als JSON, danach
  Boxvalidierung.
* `withIncumbent(candidates, incumbent)` — der Amtsinhaber ist immer Kandidat
  und laeuft im selben Durchgang mit (E2).

*Test:* ein **Konstruktionstest** ueber `CandidateAggregates` — jedes Feld ist
`number` oder `number[]`, rekursiv, geprueft an einer echten Instanz. Kein
Teilzeichenkettentest (E13).

### AP7 — Rekordertreue und Erst-Divergenz

**Schreibt:** `packages/core/src/memory/dream/trajectory.ts` (neu),
`packages/core/src/providers/claude-code.ts`,
`packages/core/test/dream-trajectory.test.js`
**Welle 2.** Haengt von AP2 ab (die zwei neuen Felder am `'tool'`-Ereignis).

* `claude-code.ts` — die Vorbedingung von Phase 6 (S28):
  * Das Start-Ereignis bekommt `argsHash = sha256(canonicalJson(input))` und
    `input` als kanonisches JSON bis zu einer Grenze. `detail` bleibt, wie es
    ist — die Oberflaeche haengt daran.
  * Das Ende-Ereignis traegt den **echten** Werkzeugnamen statt des Literals
    `'tool'`; die Korrelation ueber `id` bleibt.
* `trajectory.ts`:
  * `episodeFromEvents(id, events)` -> `{ episode, steps }` — liest das
    bestehende `turn_events`-Journal, legt keinen zweiten Speicher an.
  * `judgeEpisode(steps, decide)` -> `{ verdict, divergedAt }`. Beobachtungen
    sind auf `(step, argsHash)` geschluesselt; eine abweichende Aktion kann
    strukturell keine nachschlagen. Vier zulaessige Urteile (S29):
    `k = n` -> `no-change`; `k < n` und die Episode scheiterte ->
    `may-avoid-failure` (zaehlt fuer **nichts**); `k < n` und die Episode war
    erfolgreich -> `regression-risk` bei k; nach k wird nichts behauptet.
  * `divergenceProxyReport(samples)` -> das Validierungstor: stimmt der erste
    abweichende Schritt eines frei laufenden Laufs mit k ueberein? Faellt es
    durch, ist Phase 6 tot — die Funktion sagt das, sie umgeht es nicht.

### AP8 — Die Bewertungsmaschinerie

**Schreibt:** `packages/core/src/memory/dream/evaluate.ts` (neu),
`packages/core/test/dream-evaluate.test.js`
**Welle 3.** Haengt von AP4, AP5 ab; liest `dream/measure.ts` und
`dream/probe.ts` (`bootstrapCi`, `freshnessCheck`, `corpusDrifted`).

* `splitOf(sessionId, { holdoutRate, auditRate })` -> `'train' | 'holdout' |
  'audit'` — deterministisch aus einem Hash, **sitzungsweise** (E3). Dieselbe
  Funktion benutzt AP14 beim Rekorder.
* `evaluateCandidate(input)` -> `DreamEvalResult`:
  * gepaart je Spur, **nur auf der Schnittmenge** beider geschlossener
    Mengen (Gueltigkeitsregel 1);
  * Enthaltungshistogramm, `reachable_rate`, `label_coverage`,
    `cost_only_share`;
  * Cluster-Bootstrap ueber **Sitzungen** (B = 2000), Perzentilintervall
    2.5/97.5, ausgewiesen als `genaehert` (S11);
  * `trace_set_hash` = sha256 ueber die sortierten Spur-IDs;
  * `evidence_digest` — verdichtete Begruendung **ohne Wortlaut**;
  * die fuenf Gueltigkeitsregeln aus Konzept 5.4 als eigene, einzeln
    testbare Praedikate. `n_closed < minTraces` ist **ungueltig**, nicht
    "Kandidat verloren".
* `selectOnTraining(candidates, ...)` -> genau **ein** Kandidat geht auf den
  Rueckhalt (S12), und der Pruefsatz wird je Befoerderung genau **einmal**
  angefasst (S13).
* `agreementReport(labels)` -> Kappa je Quellenpaar, `user` privilegiert. Ein
  Delta, das auf den beeinflussbaren Quellen positiv und auf `user` flach oder
  negativ ist, wird markiert. Sind `user`-Etiketten zu duenn, ist **das** der
  Befund (5.5b).
* Frisch-Test: `freshnessCheck` liefert `delta_live` und `sign_agree`.

### AP9 — Das Befoerderungstor

**Schreibt:** `packages/core/src/memory/dream/promote.ts` (neu),
`packages/core/test/dream-promote.test.js`
**Welle 3.** Haengt von AP3, AP8 ab.

* `promotionDecision(input)` -> `{ promote: boolean, blockers: string[] }` —
  die neun Bedingungen aus Konzept 10.2, jede einzeln benannt und einzeln
  testbar. Insbesondere: ohne `ci_low > 0` **und** `audit_ci_low > 0` keine
  Befoerderung; `origin = 'user'` wird nie ueberschrieben; hoechstens eine
  Befoerderung je Nacht; `trace_set_hash` disjunkt zur letzten Befoerderung des
  Slots; `cooldown_until` abgelaufen; Slot nicht eingefroren; Erkundung und
  Befoerderung teilen sich nie eine Nacht im selben Slot (S19).
* `applyPromotion(store, input)` — schreibt die `policy_versions`-Zeile mit
  `prev_active_id`, `sleep_run_id`, `rationale`, den Bewertungszahlen, setzt
  `cooldown_until` und den Zaehler am Lauf (S20).
* `freezeFor(reason)` — die vier Ursachen aus 10.3.
* `revertPolicy(store, policyId)` — der spaetere, manuelle Weg ueber
  `prev_active_id`; das Nacht-Undo liegt in AP3.

### AP10 — Der Resolver

**Schreibt:** `packages/core/src/memory/dream/policy.ts`,
`packages/core/test/dream-policy.test.js`
**Welle 3.** Haengt von AP3 ab.

* `resolvePolicy` liest jetzt `store.activePolicy(owner, slot)` und legt sie
  ueber die Vorgaben. Existiert keine Version, ist es der heutige Nullschritt.
* **Kollision mit der Oberflaeche (9.3):** weicht ein Config-Wert vom
  Vorgabewert ab, gilt das Feld als `origin: 'user'` und die befoerderte
  Version darf es **nicht** ueberschreiben.
* Geklemmt wird beim **Lesen** (S23), mit denselben Bereichen wie AP2s Zod.
* `factoryPolicy()` — der Werksvorgabe-Parametersatz, gegen den der
  Pruefsatz in AP8 kumulativ vergleicht (Bedingung 2b).

### AP11 — Die Slots `budget` und `retry`

**Schreibt:** `packages/core/src/memory/dream/slots.ts` (neu),
`packages/core/test/dream-slots.test.js`
**Welle 3.** Haengt von AP2 ab.

* `budget`: `BudgetPolicy` = Phasenanteile; `applyBudgetPolicy(demand, policy)`;
  `yieldRates(runs)` — beobachtete Ertragsraten je Owner und Phase **mit
  Streuung**, `genaehert`, und **nie** ausserhalb des beobachteten Bereichs
  extrapoliert. Ein Replay, das extrapolieren muesste, enthaelt sich.
* `retry`: **einseitig exakt** — frueher stoppen ist replaybar, spaeter nicht.
  `judgeRetry(attempts, policy)` liefert nur fuer den frueheren Abbruch ein
  Urteil und sonst `enthalten`.
* **Quelltest zu H4 (S24):** `allocateNightBudget` leitet `keys` bereits aus
  `[...volume, ...judgement]` ab. Der Test sichert das gegen Rueckfall:
  `Object.keys(demand)` eines kanonischen `NightDemand` ist gleich
  `new Set(keys)`. Ein Eigenschaftstest ueber zufaellige Bedarfe kann den
  Fehler nicht finden — er liegt auf Quellebene.

### AP12 — Die Nacht

**Schreibt:** `packages/core/src/memory/sleep.ts`,
`packages/core/test/dream-night.test.js`
**Welle 4, allein.** Haengt von Welle 3 ab.

* **Etikettenschreiber.** In `#replay`: nach `confirmedBy` das Zitat ueber
  `locateTurn` im Transkript lokalisieren, `addCorrection` mit `turnId`,
  dann `correctionLabels` gegen die Rahmen dieser Sitzung. In `#condense`:
  `mergeLabels` ueber die frisch gesetzten `superseded_by`. Zaehler
  `dreamLabelsWritten`.
* **Die `dream`-Stufe.** Der modellfreie Teil (Gitterprobe, Bewertung,
  Frisch-Test, Etikettenabgleich) liegt weiter **vor** der Zyklusschleife und
  **ueber** dem Provider-Waechter; er meldet jetzt `#phase('dream')`. Eigene
  Wanduhr-Obergrenze `maxEvalMs`.
* **Der Kandidatenschreiber** liegt im **letzten** Zyklus, nach
  `counters.modelCalls += insight.calls` und vor `#revise`. Erste Zeile der
  Methode ist `if (budget <= 0 || signal.aborted) return ...`. Laufglobale
  Deckelung `maxCallsPerNight` ueber **alle** Owner.
* **Befoerderung** ueber AP9, hoechstens eine je Nacht, nur bei
  `dream.promote`. Ein Haken `onPromotion` in `SleepRunnerOptions` — die
  Mail schickt AP14, `sleep.ts` kennt den `OrgController` nicht und bekommt
  ihn auch nicht.
* **Wach-Test (5.5c)** nach `calibrationTraces` Spuren, gegen `tolerance`;
  ausdruecklich ein **Regressionsalarm**, und genau so im Bericht benannt.
  Ueberschreitung friert den Slot mit `calibration` ein.
* **Kehrbesen:** `dream_labels`, `dream_evals` nach `retainDays`;
  `dream_episodes` nach `frameRetainDays` (S21 — Episoden zeigen auf
  Wortlaut). Chargen mit `LIMIT 500`, eigene Klammer je Charge.
* `describeSleep` bekommt seine Klausel; `undo()` Rueckgabetyp und Logzeile
  wachsen um `policies`.

### AP13 — Server

**Schreibt:** `packages/server/src/routes/dream.ts` (neu),
`packages/server/src/routes/memories.ts`, `packages/server/src/server.ts`,
`packages/server/test/dream-routes.test.js`
**Welle 5.** Haengt von AP12 ab.

* `routes/dream.ts`: `GET /api/dream/policies`,
  `GET /api/dream/policies/:slot/history`,
  `POST /api/dream/policies/:id/promote`, `POST /api/dream/policies/:id/revert`,
  `GET /api/dream/evals`, `GET /api/dream/traces`, `POST /api/dream/run`.
  Registriert in `server.ts` **vor** `registerStatic`, literale Pfade vor
  parametrisierten Geschwistern. Querystrings werden von Hand geklemmt.
* `routes/memories.ts`: `PATCH` und `DELETE` reichen `actor: 'user'` durch
  (S5). Neu: `POST /api/memories/:id/feedback` mit `{ turnId, verdict }` —
  das Klickziel der Chat-Hervorhebung (S6), schreibt ein `user`-Etikett mit
  echtem Turnbezug.
* **Kein** vierter `/memory`-Kindpfad (S27).

### AP14 — Runtime und Organisation

**Schreibt:** `packages/core/src/runtime.ts`,
`packages/core/src/org/controller.ts`, `packages/core/src/org/store.ts`,
`packages/core/test/dream-wiring.test.js`
**Welle 5.** Haengt von AP12 ab.

* **Eine Turn-ID statt drei.** `#turnMemories` erzeugt heute ein eigenes
  `randomUUID()` fuer die Spur, waehrend das Journal bei `runtime.ts:645`
  bereits eines hat. Die Journal-ID wird durchgereicht; `addMessage` bekommt
  sie mit. Damit ist ein Korrekturetikett ueber `messages.turn_id` **exakt**
  auf seine Spur zielbar, statt ueber Indexarithmetik.
* `splitOf` aus AP8 setzt `holdout` und `audit` an `beginTrace` —
  sitzungsweise, nicht je Spur (E3).
* Das `'memory'`-Ereignis mit `action: 'recalled'` traegt jetzt die `turnId`,
  damit die Oberflaeche ein Etikett mit Turnbezug schreiben kann (S6).
* `onPromotion` wird verdrahtet: `runtime.ts` besitzt beide Instanzen und
  ruft `this.org.sendUserMail(...)` mit `rationale`, `delta`, `ci_low` und
  dem Revert-Link (S26).
* `org/controller.ts:3030` (Agentenabruf) geht ueber `resolvePolicy` (S18).
  Die beiden anderen `recall`-Aufrufe (Werkzeug, Extraktor) bleiben, wie sie
  sind — andere Population.
* `org/store.ts`: `upsertReview` schreibt zusaetzlich das `review`-Etikett
  (S8). Es ist der einzige Trichter aller vier Bewertungsquellen; ein
  Schreiber hier faengt alle, ohne vier Aufrufstellen anzufassen. Die Warnung
  aus 4.2d steht als Kommentar daneben: `upsertReview` **ersetzt** und kann
  eine Belohnung still widerrufen.

### AP15 — Die Chat-Hervorhebung als Etikettenkanal

**Schreibt:** `packages/web/src/hooks/useChat.ts`,
`packages/web/src/providers/rookery-provider.tsx`,
`packages/web/src/components/common/memory-columns.tsx`,
`packages/web/src/pages/MemoryListPage.tsx`,
`packages/web/test/memory-feedback.test.mjs`
**Welle 5.** Haengt von AP13 ab.

Die Hervorhebung ist heute rein transient (`highlighted: Set<string>`). Sie
bekommt die `turnId` aus dem `'memory'`-Ereignis und je hervorgehobener Zeile
ein Klickziel "was the point / was ballast", das
`POST /api/memories/:id/feedback` ruft. *Kosten:* eine Route, ein Klickziel.
*Trefferquote:* per Konstruktion 1, sofern geklickt wird — die offene Groesse
ist die **Menge**.

### AP16 — Der Traumabschnitt der Naechte-Seite

**Schreibt:** `packages/web/src/pages/MemorySleepPage.tsx`, neue Komponenten
unter `packages/web/src/components/`, `packages/web/test/dream-page.test.mjs`
**Welle 6.** Haengt von AP13 ab.

* Die drei Zaehler, die `sleep_runs` schon heute liefert und die die
  Oberflaeche ignoriert, kommen in `COLUMN_LABELS` und in die Report-Liste,
  dazu `dreamPromoted` und `dreamLabelsWritten`.
* **Versionskurve** als **neue** Komponente auf `ChartContainer` — nicht in
  `TrendChartCard`: die filtert gegen ein Kalenderfenster relativ zu
  `Date.now()` und stapelt Serien; versionsindizierte 0..1-Werte ergaeben dort
  eine leere Karte, keinen Fehler.
* **Diff-Blatt je Befoerderung** im `DetailDrawer`: Feld, alter Wert, neuer
  Wert, `delta`, `ci_low`, `audit_ci_low`, `rationale`, Revert-Knopf.
* `undoable()` bekommt die Traumzaehler in die ODER-Kette, sonst blendet die
  Oberflaeche den Undo-Knopf genau fuer die Naechte aus, die umkehrbar bleiben
  muessen (E18).
* Ein eingefrorener Slot erscheint als Handlungspunkt, wie ein Widerspruch
  (10.3).

### AP17 — `SLEEP_PHASES`

**Schreibt:** `packages/web/src/pages/MemoryLayout.tsx`,
`packages/web/test/sleep-phases.test.mjs`
**Welle 5.** Haengt von AP2 ab.

`SLEEP_PHASES` bekommt `'dream'` an seiner Stelle zwischen `'replay'` und
`'light'`. Der bestehende Test "jede `SleepStage` kommt in `SLEEP_PHASES` vor"
faengt das Weglassen.

---

## 4. Topologische Baureihenfolge

```
Welle 1  (2 parallel)
  AP1  db.ts                         Schema 24
  AP2  types.ts config.ts schemas.ts Vokabular, Konfigschluessel, Zod-Klammern

Welle 2  (5 parallel)                <- AP1, AP2
  AP3  store.ts                      Persistenz Stufe 2+
  AP4  dream/label.ts                Die vier Quellen -> gain(m)
  AP5  dream/admission.ts            H1-H9 vor der Bewertung
  AP6  dream/candidate.ts            Aggregate, Prompt, eigener Aufrufer
  AP7  dream/trajectory.ts + providers/claude-code.ts

Welle 3  (4 parallel)                <- Welle 2
  AP8  dream/evaluate.ts             Split, Delta, Bootstrap, Gueltigkeit
  AP9  dream/promote.ts              Bedingungen 1-9, Einfrieren, Revert
  AP10 dream/policy.ts               Resolver liest policy_versions
  AP11 dream/slots.ts                budget- und retry-Slot

Welle 4  (1, kritischer Pfad)        <- Welle 3
  AP12 sleep.ts                      Die Nacht

Welle 5  (4 parallel)                <- AP12
  AP13 server: routes/dream.ts, memories.ts
  AP14 core: runtime.ts, org/controller.ts, org/store.ts
  AP15 web: Chat-Hervorhebung als Etikettenkanal
  AP17 web: MemoryLayout SLEEP_PHASES += 'dream'

Welle 6  (1)                         <- AP13
  AP16 web: MemorySleepPage Traumabschnitt
```

**Kritischer Pfad:** AP1/AP2 -> AP3 -> AP8 -> AP12 -> AP13 -> AP16.

**Vor jedem Wellenwechsel:** `npm run build && npm run typecheck && npm test`,
dazu `npm test -w @rookery/server` und `npm test -w @rookery/web`.

---

## 5. Abnahmekriterien der Stufe

1. **`npm run build` gruen** ueber alle vier Arbeitsbereiche.
2. **`npm test` (core) nicht schlechter als die Grundlinie 439 von 440.** Der
   eine Fehlschlag ist der bekannt flackernde
   `packages/core/test/memory-owner.test.js:68`.
3. **`npm test -w @rookery/server` nicht schlechter als 37 von 40** (`cron`,
   `profile`, `migration` sind vorbestehend rot).
4. **`npm test -w @rookery/web` nicht schlechter als 36 von 37**
   (`page-navigation` ist vorbestehend rot).
5. **`npm run typecheck` gruen.**
6. Jede Zeile aus §0 ist in mindestens einem Paket wiederzufinden.
7. Mit `memory.dream.enabled = false` (Vorgabe) aendert sich **kein**
   beobachtbares Verhalten gegenueber `main`.

---

## 6. Was diese Stufe ausdruecklich offen laesst

* Die Trefferquote der Zitat- und Aehnlichkeitslokalisierung (Offene Frage 2)
  ist eine **Messung an echten Daten**, kein Bauteil. Der Plan liefert den
  Zaehler und den Bericht, nicht die Zahl.
* Der Kappa-Schwellwert (Offene Frage 1) bleibt `geraten` bei 0.4.
* `minTraces: 200` bleibt `geraten` (Offene Frage 4).
* Eine Policy je Besitzer (Offene Frage 5) bleibt unbeantwortet.
* Die Validierung der Erst-Divergenz-Bewertung (Phase 6) ist ein **Tor an
  echten Daten**. Der Plan baut den Mechanismus und das Tor; ob Phase 6 lebt,
  entscheidet erst eine Stichprobe.
