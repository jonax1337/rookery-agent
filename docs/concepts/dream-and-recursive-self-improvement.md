# Traum und rekursive Selbstverbesserung

Stand: 2026-09-18. **Phase 1 bis 6 sind gebaut** (Schema 24). Der Traum ist vollstaendig
verdrahtet und **standardmaessig aus**.

## Stand der Umsetzung - hier anknuepfen

**Gebaut.** `packages/core/src/memory/dream/` traegt jetzt zehn Module: `frame.ts`, `score.ts`,
`policy.ts`, `measure.ts`, `probe.ts` (Stufe 1) sowie `label.ts` (die vier Quellen aus Abschnitt 4,
rein, ohne Store und ohne Uhr), `admission.ts` (H1/H3/H9 und der Boxverstoss als Erzeugungsfehler),
`candidate.ts` (Aggregate ohne ein einziges Zeichenkettenfeld, eigener Aufrufer mit eigenem Effort),
`evaluate.ts` (sitzungsweiser Split, gepaartes Delta auf der Schnittmenge, Cluster-Bootstrap, die
fuenf Gueltigkeitsregeln, Etikettenabgleich), `promote.ts` (die neun Bedingungen aus 10.2 als je
einzeln testbare Blocker), `slots.ts` (`budget` und `retry`) und `trajectory.ts` (Erst-Divergenz mit
den vier Urteilen). Dazu: Schema 24 mit `policy_versions`, `dream_slot_state`, `dream_evals` und
`dream_episodes`; die Persistenz in `store.ts`; die Verdrahtung in `sleep.ts`; der Resolver an allen
Aufrufstellen; `server/src/routes/dream.ts`; der Traumabschnitt der Naechte-Seite mit Versionskurve,
Diff-Blatt und Revert; die Chat-Hervorhebung als Etikettenkanal; und die Rekordertreue aus Phase 6
(`argsHash` ueber kanonisches JSON, echter Werkzeugname am `end`-Ereignis).

Der Bauplan dazu ist `dream-stage2plus-buildplan.md` (siebzehn Arbeitspakete, sechs Wellen).

**Immer noch aus.** `memory.dream.enabled`, `record`, `promote` und `trialEpisodes` stehen auf
`false` beziehungsweise 0. Diese Stufe liefert die Maschine, nicht ihren Anlauf.

**Angeschaltet wird im Traumabschnitt der Naechte-Seite**, nicht auf der Einstellungsseite: 9.6
verbietet die Knoepfe dort, weil die Seite keine ehrlichen Beschriftungen fuer Zahlen hat, deren
Wirkung nur im Nachtlauf sichtbar ist. Der Traumabschnitt hat sie — er kann je Schalter sagen, was
er kostet und was ihm noch fehlt. Genau das ist die Bedingung, unter der sich `promote` ueberhaupt
anbieten laesst: der Schalter fragt vorher nach und nennt dabei, dass die Handpruefung der
Korrekturetiketten noch aussteht. "Nicht auf der Einstellungsseite" heisst nicht "nirgends".

**Was jetzt fehlt, ist keine Mechanik mehr, sondern Messung.** Vier Zahlen dieses Dokuments sind
weiter `geraten` und lassen sich nur an echten Daten ersetzen:

1. Die **Trefferquote der Zitat- und Aehnlichkeitslokalisierung** (Offene Frage 2). Der Zaehler und
   sein Boden (`correctionPrecisionFloor`) stehen und werden berichtet; die Handpruefung an
   mindestens 50 Korrekturen hat nicht stattgefunden. **Vor Phase 3 im Betrieb** verlangt dieses
   Dokument sie, und ein Durchfallen ist ein Stopp, kein Umweg.
2. Der **Kappa-Schwellwert** (Offene Frage 1), `agreementFloor: 0.4`.
3. **`minTraces: 200`** (Offene Frage 4).
4. Das **Validierungstor der Erst-Divergenz-Bewertung** (Phase 6). `divergenceProxyReport` misst es
   und beschoenigt nichts; gelaufen ist es nie. Faellt es durch, ist Phase 6 tot.

**Entscheidungen, die beim Bauen fielen und hier nachgetragen sind, weil der Code sie traegt:**

* **Ein heute geschriebener Kandidat wird morgen gemessen.** Der Bauplan setzt die Bewertung vor die
  Zyklusschleife und den Kandidatenschreiber in den letzten Zyklus; beides zusammen heisst, dass ein
  Vorschlag eine Nacht liegen bleibt. Das ist die Stelle, an der der Befoerderungspfad modellfrei
  bleibt: eine Nacht ohne Provider schlaegt nichts vor und befoerdert trotzdem, was die letzte
  vorgeschlagen hat. Zurueckgezogen wird ein Vorschlag erst, wenn ueber ihn entschieden wurde.
* **Ein sitzungsweites Etikett traegt die Sitzungs-ID in `turn_id`.** Abschnitt 8.3 legt die Spalte
  `NOT NULL` und in den Primaerschluessel und verlangt zugleich `NULL` bei Mehrdeutigkeit; das ist
  ein Widerspruch im Dokument. Aufgeloest ueber `scope`: nur `scope = 'turn'` geht in DCG ein.
* **H9 lehnt den Faktor eins nicht ab.** Ein identischer Gewichtsvektor ist kein Rescale - er ist,
  was jeder Kandidat traegt, der nur `threshold` oder die Hop-Gewichte bewegt, und der Amtsinhaber
  selbst waere das erste Opfer gewesen.
* **`dream.effort` ist ein Konfigurationsschluessel geworden.** E14 verlangt, dass der
  Kandidatenschreiber nicht auf `ask`s verdrahtetem `'low'` laeuft; der Typ laesst `'low'` gar nicht
  zu.
* **Der Wach-Test schreibt keine `dream_evals`-Zeile.** Diese Tabelle ist gepaart; ein Arm gegen sich
  selbst bewegt auf keiner Spur eine etikettierte Position. Er misst direkt mit demselben Schaetzer
  und denselben Etiketten, und sein Befund steht im Bericht und im Einfrieren. Er friert nicht ein,
  wenn er nicht genug Rahmen schliessen konnte - die Zahl der Enthaltungen steht daneben.
* **`holdoutRate` und `auditRate` sind Modulkonstanten**, kein Konfigurationsschluessel: Rekorder und
  Nacht muessen dieselbe Rate lesen, sonst wechselt eine Sitzung zwischen Stempel und Bewertung die
  Seite. Ebenso `PROXY_AGREEMENT_FLOOR` und `PROXY_MIN_SAMPLES` (Phase 6) - E20 verbietet einen
  Schluessel ohne Leser, und einen Leser in der Konfiguration haetten sie nicht.
* **Die manuelle Befoerderung ueber `POST /api/dream/policies/:id/promote` setzt
  `dream_evals.promoted` nicht nach.** Eine von Hand befoerderte Spurenmenge sieht die
  H6-Disjunktheitspruefung darum weiter als unverbraucht.

Beruehrt sind heute `packages/core/src/memory/` (`db.ts`, `store.ts`, `sleep.ts`, `recall.ts`,
`dream/*`), `config.ts`, `types.ts`, `runtime.ts`, `org/{controller,store}.ts`,
`providers/claude-code.ts`, `packages/server/src/{schemas.ts,server.ts,routes/{dream,memories}.ts}`
und in `packages/web` die Naechte-Seite, die Gedaechtnisliste und der Chat-Haken.

Verwandte Konzepte: `dream-stage2plus-buildplan.md` (der Bauplan dieser Stufe),
`dream-stage1-buildplan.md` (Phase 1, erledigt), `memory-graph-and-sleep.md` (der bestehende
Schlaf), `confirmed-memory-and-self-written-skills.md` (Skills als Artefakt),
`agent-performance-management.md` (die Bewertungsrubrik), `night-intensity-and-cron-exclusion.md`
(welche Sitzungen nachts ueberhaupt zaehlen).

Diese Fassung aendert nicht das Ziel von Fassung 1, sondern die **Beweislast**. Fassung 1 behauptete,
`recall` sei exakt replaybar, weil es eine reine Funktion sei. Das ist eine Eigenschaft des Codes.
Replay-Treue ist aber eine Eigenschaft der **Aufzeichnung**: ein Replay ist genau dann ehrlich, wenn die
aufgezeichnete Flaeche unter der deklarierten Parameterbox geschlossen ist, und in dem Moment
kontrafaktisch, in dem sie es nicht ist. Wer eine Zahl nennt, muss also zweierlei belegen: dass die
Arithmetik stimmt, und dass die Eingaben dieser Arithmetik zur Aufzeichnungszeit wirklich festlagen. Fuer
jede Zahl in diesem Dokument steht deshalb dabei, unter welchem der fuenf Woerter aus Abschnitt 2 sie
gilt; eine Zahl ohne dieses Wort ist ein Fehler im Dokument, nicht bloss eine Nachlaessigkeit. Und die
zweite Haelfte der Beweislast, die Fassung 1 gar nicht gesehen hat, liegt bei den Etiketten: ohne einen
benannten Schreiber fuer `dream_labels.relevance` misst der ganze Apparat nichts. Abschnitt 4 schreibt
diesen Schreiber aus, mitsamt dem, was er nicht kann.

---

## 1. Was sich gegenueber Fassung 1 aendert, und warum

### 1.1 Die erste Verschiebung: vom Log zum Rahmen

Fassung 1 zeichnet die **realisierten** Optionen einer Entscheidung auf und scored Kandidaten dagegen.
Das schliesst den ersten Hop und sonst nichts:

* Die Saat des zweiten Hops ist `direct.slice(0, 3)` (`recall.ts:151-152`) — berechnet **nach** Gewichten
  und Schwelle des Amtsinhabers. Ein Kandidat, der die Top-3 umsortiert, braucht die Nachbarschaft einer
  Saat, die nie ausgefuehrt wurde. Die realisierte Expansion ist dafuer keine Antwort, sondern eine
  falsche.
* `limit` steht im Policy-Raum mit 4 bis 16, verbreitert aber die **SQL**, nicht die Ausgabe: die Front
  ist `limit * 4` (`recall.ts:113`), die Lieferung `slice(0, limit)` (`recall.ts:161`). Eine bei
  `limit: 8` aufgezeichnete Spur haelt 32 Zeilen; `limit: 16` braucht 64. Die halbe deklarierte Spanne
  ist aus einer Standardaufzeichnung nicht replaybar — und scheitert **still**, indem sie mehr von den 32
  zurueckgibt.

Fassung 2 ersetzt das Log durch den **Rahmen** (`RecallFrame`): aufgezeichnet wird nicht der gegangene
Weg, sondern die **permissivste Ecke der deklarierten Box**. Dazu wird `recall` (`recall.ts:83`) in zwei
Funktionen zerlegt, ohne Verhaltensaenderung:

```
fetchFrame(store, options) -> RecallFrame     // jeder lebende Lesezugriff
scoreFrame(frame, policy)  -> ScoredMemory[]  // rein, kein Store-Parameter
recall = touch(scoreFrame(fetchFrame(...)))   // der einzige Schreibzugriff bleibt aussen
```

Drei Saetze machen den Rahmen geschlossen, alle drei am Code geprueft — Abschnitt 3 fuehrt sie aus.

### 1.2 Die zweite Verschiebung: gemessen wird, was das Modell gelesen hat

Fassung 1 misst nDCG ueber den Rueckgabewert von `recall`. Zwischen diesem Rueckgabewert und dem Prompt
liegen vier ungeloggte Transformationen, und eine davon macht die Messung weitgehend blind:

* `runtime.ts:468-477` mischt `coreProfile`-Zeilen mit **flachem `score: 1`** (`recall.ts:289`) in
  dieselbe Map, danach `dropContradicted`, danach `.sort((a, b) => b.score - a.score)`. Bei
  `recallLimit: 8` (`config.ts:41`) sind das `max(3, floor(8 / 2)) = 4` Profilzeilen
  (`runtime.ts:468-471`). Die vereinigte Liste hat also bis zu zwoelf Eintraege, und sie wird **nicht**
  auf `limit` gekuerzt.
* `renderMemoryBlock` (`recall.ts:314`) bekommt auf dem Assistentenpfad
  `Math.floor(contextBudget * 0.4)` (`agents/persona.ts:173, 178`), bei `contextBudget: 6000`
  (`config.ts:45`) also 2400 Zeichen, und den Store. `push` liefert `false` und die Schleife macht
  **`break`, nicht `continue`** (`recall.ts:323-345`). Eine lange Erinnerung auf Platz 1 loescht alles
  dahinter.
* `groupByEntity` (`recall.ts:365-393`) sortiert nach **seltenster Entitaet** um und liest `mentions`
  dafuer live (`recall.ts:373`).
* Der Agentenpfad ist ein anderer: `org/prompts.ts:366` ruft `renderMemoryBlock` **ohne Store** auf —
  keine Gruppierung, flache Liste — und `org/controller.ts:2458-2463` uebergibt `hopEntity`/`hopEdge` gar
  nicht, bekommt also still die Literale `0.45`/`0.6` aus `recall.ts:184-185` statt `config.memory.graph`
  (`config.ts:54-56`).

Fassung 2 misst deshalb die **gerenderte Blockzeilenmenge**. Das beantwortet nebenbei die offene Frage 5
aus Fassung 1 (Kollision mit `contextBudget`) durch Konstruktion: das Budget ist Teil des Masses, nicht
eine Nebenbedingung daneben.

Eine Behauptung des Vorentwurfs faellt hier: "keine Abruf-Policy kann die Profilzeilen verdraengen" ist
**falsch**. Mit den Amtsinhabergewichten (`recall.ts:28`) ist die Obergrenze eines direkten Treffers
`0.55 + 0.2 + 0.15 + 0.1` plus `tagHit` von `0.1` (`recall.ts:129`), also `1.1 > 1`. Der Kopf der Liste
ist policyabhaengig, und das ist ein Angriffsweg (H9, Abschnitt 10.1), kein Randfall.

### 1.3 Gestrichen — je eine Zeile, warum

| Aus | Idee | Warum gestrichen |
|---|---|---|
| F1 §3.6, §4 | "`recall` ist exakt replaybar" | bm25 laeuft ueber `memories_fts`, external content ueber **alle** `memories`-Zeilen mit ungefilterten Triggern (`db.ts:322-347`); dieselbe Anfrage liefert morgen eine andere `relevance`. Ersetzt durch das Vokabular in Abschnitt 2. |
| F1 §5.2 | `dream_nodes` als Fan-out je Entscheidung | N implizite Transaktionen und N WAL-Rahmen pro Turn auf der einzigen Verbindung (`db.ts:22-25`); keine Abfrage braucht Knotengranularitaet. Ersetzt durch **eine** `dream_frames`-Zeile je (Spur, Slot). |
| F1 §5.3 | `PRIMARY KEY (trace_id, target)` | verbietet zwei Quellen fuer dasselbe Ziel — genau der Vergleich, an dem das Konzept haengt. Ersetzt durch `(turn_id, target, source)`. |
| F1 §5.1, E3 | `holdout` je Spur gewuerfelt | aufeinanderfolgende Turns einer Sitzung teilen Thema, Bankausschnitt und Entitaetennachbarschaft; per-Spur-Teilung legt Beinah-Duplikate auf beide Seiten und laesst `ci_low > 0` auf Leckage feuern. Einheit ist die **Sitzung**. |
| F1 §5.3 | `usefulness` als Etikettenquelle | der einzige Schreiber ist `touchMemories` (`store.ts:550-561`), gerufen ausschliesslich aus `recall` (`recall.ts:163-165`). Das Signal heisst "wurde geliefert", nicht "hat geholfen" (E9). |
| F1 §8 | `minImportance`, `kinds` im Policy-Raum von `recall` | sind SQL-Filter (`recall.ts:91, 105`), keine Scoring-Terme. Lockern laesst Zeilen zu, die nie geholt wurden; die Aufzeichnung ist in dieser Richtung Teilmenge, nicht Obermenge. |
| F1 §4 | Slot `cluster` in Stufe 1 | `#cluster` (`sleep.ts:702`) ist deterministisch, aber sein **Ertrag** ist, was `#condense` (`sleep.ts:772`) mit dem Buendel macht — ein Modellaufruf je Cluster. Replaybar und unbewertbar zugleich. |
| F1 §4 | Slot `gate` in Stufe 1 | Praefix-Gueltigkeit erzeugt dort ein identisch nulles Delta (Abschnitt 7.2). Der Slot kehrt zurueck, wenn er ein eigenes Messziel hat. |
| F1 §7 Schritt 3 | Kandidatenprompt bekommt "die schlechtesten zwanzig Spuren mit Kontext" | woertliche Nutzergespraeche als naechtliches Trainingsmaterial: Leckagekanal in sitzungsverwandte Rueckhaltespuren und eine ungenannte Datenschutzentscheidung. Ersetzt durch aggregierte Komponentenvektoren (E13). |
| F1 §7 Schritt 5 | sechs Kandidaten auf der Rueckhaltemenge testen | sechsfaches Testen mit einem 95-Prozent-Intervall. Ersetzt durch Selektion auf Training, genau eine Pruefung auf Rueckhalt (E4). |
| F1 E10 | Spuren werden nach `retainDays` geloescht | zerstoert planmaessig die Begruendung jeder Befoerderung, die die Kalibrierung spaeter zurueckzunehmen verlangt. Ersetzt durch zwei Aufbewahrungsuhren plus `evidence_digest` (E19). |
| F1 §10 | Wach-Test als *der* Sensor | misst Replay- und Onlinewert mit demselben Schaetzer aus denselben Etiketten. Sind die Etiketten falsch, sind sich beide einig. Degradiert zum Regressionsalarm; zwei andere Sensoren daneben (Abschnitt 5.5). |
| F1 §11 | "Nie unumkehrbar" | `touchMemories` ist ein monotoner Zaehler ohne Historie (`store.ts:550-561`), und `usefulness` traegt 0.3 der Stilllegungsentscheidung (`sleep.ts:684`). Ersetzt durch "umkehrbar in Parametern, nicht in Zaehlern" (E11). |

### 1.4 Aufgeloeste Widersprueche

1. **Tor exakt vs. nur je Kandidat exakt.** Aufgeloest durch Streichung des Slots aus Stufe 1
   (Abschnitt 7.2). Was bleibt, ist der Mechanismus **Erst-Divergenz-Bewertung**, und er wird dort
   definiert, wo er wirklich gebraucht wird: in Stufe 2.
2. **Alles ueberzeichnen vs. Schreibvolumen.** Ueberzeichnet wird **innerhalb der Box**, aber nur ein
   Bruchteil der Sitzungen bekommt ueberhaupt Rahmen (`dream.frameRate`, Vorschlag 0.25, geraten,
   **sitzungsweise** abgeleitet). Jede Spur traegt trotzdem Etiketten, also speisen auch rahmenlose
   Spuren den Etikettenabgleich.
3. **Frisch-Test vs. Wach-Test.** Beide, mit verschiedenen Namen fuer verschiedene Fehler (E12).
4. **Erkundung vs. eine Befoerderung pro Nacht.** In einer Nacht mit `explorationRate > 0` fuer einen
   Slot wird in diesem Slot **nicht** befoerdert. Invariante mit Test, nicht Satz (E17).

---

## 2. Kontrolliertes Vokabular

Jede Zahl, die dieses Dokument als Messergebnis oder als Eingabe einer Messung nennt, traegt genau eines
dieser fuenf Woerter. Keine zwei duerfen denselben Namen tragen (E6).

| Wort | Bedeutung |
|---|---|
| **exakt** | Arithmetik ueber zum Aufzeichnungszeitpunkt eingefrorene Eingaben. Nur ein Fehler kann eine Abweichung erzeugen. |
| **eingefroren** | Eine Zahl aus der Aufzeichnung, die zur Replayzeit **nie** nachgerechnet oder validiert werden kann. Als Eingabe legitim, als Beleg fuer die Gueltigkeit der Aufzeichnung niemals. |
| **praefixgueltig** | Exakt bis zum ersten Divergenzpunkt, danach undefiniert. Was danach kommt, darf nichts behaupten. |
| **genaehert** | Beobachtete Rate oder Stichprobe, mit angegebenem Fehlerterm. Nie ausserhalb des beobachteten Bereichs extrapoliert. |
| **enthalten** | Wird nicht gescored. Zaehlt weder fuer noch gegen einen Kandidaten. |

Ausdruecklich **nicht** Teil dieser fuenf: das Wort `geraten`. Es markiert einen
Konfigurationsvorschlag, der noch keine Messung hinter sich hat. Ein `geraten`-Wert darf in einer
Konfiguration stehen, aber nie in einer Bewertung als Ergebnis auftauchen; Phase 1 ersetzt die
`geraten`-Werte durch **genaehert**e.

---

## 3. Der Rahmen

### 3.1 Die drei Schliessungssaetze

**1. Praefix-Invarianz der Normierung.** Die Hop-1-SQL endet auf `ORDER BY relevance DESC LIMIT ?`
(`recall.ts:107`), und `maxRelevance` ist `Math.max(...rows.map(relevance), 1)` (`recall.ts:120`) ueber
ein negiertes bm25 (`recall.ts:96`), das positiv ist. Das Maximum ueber jedes Praefix ist damit gleich
dem Maximum ueber die ganze Menge. Ein einmal bei `limitMax = 16` aufgezeichneter Rahmen (64 Zeilen)
reproduziert **jedes** `limit` von 4 bis 16 **exakt**. *Vorbedingung:* die Hop-1-SQL braucht einen
Gleichstandsbrecher, sonst ist die Zeile am 32/64-Rand bei gleichem bm25 nicht festgelegt.

**2. Exclude-Praefix-Lemma.** `memoriesForEntities` ist
`... AND m.id NOT IN (seedIds) ORDER BY m.importance DESC LIMIT ?` (`store.ts:890-910`), aufgerufen mit
`limit: 8` **je Entitaet** (`recall.ts:207`). Zeichnet man `8 + |seeds|` Zeilen **ohne** `exclude` auf,
laesst sich jede Saatmenge **exakt** nachbilden, weil hoechstens drei IDs aus einem Praefix von elf
entfernt werden. *Vorbedingung:* auch hier ein Gleichstandsbrecher; heute steht keiner da
(`store.ts:903`), der **Live**-Pfad ist also selbst nicht deterministisch.

*Warnung fuer den Baumeister:* die naheliegende Buendelung auf einen Aufruf mit `entity_id IN (...)`
bricht dieses Lemma. `memoriesForEntities` hat ein einziges `LIMIT ?` ueber die Vereinigung
(`store.ts:903`), liefert gebuendelt also die global besten N statt acht je Entitaet. Wer buendeln will,
braucht `ROW_NUMBER() OVER (PARTITION BY l.entity_id ORDER BY m.importance DESC, m.id)` mit einem
aeusseren `WHERE rn <= ?` — und dann steht neben dem Live-Pfad ein zweiter Codepfad, fuer den Phase 1
einen Aequivalenztest braucht. Andernfalls bleibt die Schleife und die Kostenaussage "drei bis fuenf
Statements" wird zurueckgenommen.

**3. Moegliche Saaten statt realisierter.** `possibleSeeds` wird per Intervallarithmetik ueber die Box
bestimmt: `scoreMax(row)` mit jedem Gewicht am oberen Rand, `scoreMin(row)` am unteren; eine Zeile ist
moegliche Saat genau dann, wenn `scoreMax(row) >= drittgroesstes scoreMin`. Das ist eine **Obermenge**
der wahren Saaten, und ein Fehler in der Schranke degradiert zur Enthaltung, nicht zu einer plausiblen
falschen Zahl.

Die Groesse von `possibleSeeds` ist **kein** beobachteter Wert, sondern eine Funktion der Boxbreite:
naehert sich die untere Schranke irgendeines Gewichts der Null, faellt `scoreMin` fuer jede Zeile gegen
Null, das drittgroesste `scoreMin` kollabiert, und **alle 64** Zeilen qualifizieren sich. Daraus folgen
zwei Pflichten: die Boxbreite ist Teil der Phase-1-Messung (durchfahren, `|possibleSeeds|` als p95
berichten, dann **genaehert**), und der Rahmen bekommt eine harte Obergrenze mit eigenem
Enthaltungsgrund `seeds-capped`, statt zu wachsen.

### 3.2 Vier Gleichstandsbrecher, nicht zwei

Alle vier sind Behebungen einer **bestehenden** Nichtdeterminiertheit im Live-Pfad, nicht nur
Replayfragen:

| Stelle | Heute | Neu |
|---|---|---|
| `recall.ts:107` | `ORDER BY relevance DESC LIMIT ?` | `ORDER BY relevance DESC, m.id` |
| `store.ts:903` | `ORDER BY m.importance DESC LIMIT ?`, dazu `SELECT DISTINCT m.*` (`store.ts:897`) | `ORDER BY m.importance DESC, m.id` |
| `recall.ts:280` | `ORDER BY pinned DESC, (kind = 'insight') DESC, importance DESC, updated_at DESC` | `..., id` |
| `store.ts:879` | `ORDER BY e.mentions DESC` in `entitiesFor` | `ORDER BY e.mentions DESC, e.id` |

Der vierte sitzt direkt auf dem Messziel: `groupByEntity` waehlt
`entities.reduce((a, b) => (a.mentions <= b.mentions ? a : b))` (`recall.ts:378`), also das **erste** der
gleichstehenden Minima — welches das ist, entscheidet heute die Rueckgabereihenfolge von SQLite.

Dazu alle In-JS-Sortierungen auf `(score desc, id asc)`: `recall.ts:146`, `recall.ts:161`,
`recall.ts:391`, `runtime.ts:477`, `org/controller.ts:2467`. Und `grouped.sort` (`recall.ts:390`)
sortiert nach Gruppengroesse, braucht also ebenfalls einen zweiten Schluessel.

### 3.3 Der eine Term, der nie exakt wird

`relevance` ist **eingefroren** und traegt mit `WEIGHTS.relevance = 0.55` (`recall.ts:28`) mehr als die
Haelfte des Scores. `memories_fts` ist external-content FTS5 ueber die ganze `memories`-Tabelle, und die
Trigger feuern ungefiltert (`db.ts:322-347`): `memories_au` (`db.ts:341-346`) loescht und schreibt bei
**jedem** UPDATE auf `memories`. Also gehen vergessene, schlafende, abgeloeste und archivierte Zeilen
jedes Owners in Dokumentfrequenz und mittlere Laenge ein. Dieselbe Anfrage gegen dieselbe ueberlebende
Zeile liefert morgen eine andere Zahl.

Daraus folgen zwei harte Regeln:

1. Die aufgezeichnete `relevance` wird uebernommen und **nie** nachgerechnet. Ein Replay, das die
   Hop-1-SQL neu ausfuehrt, misst eine Welt, die es nie gab — mit lauter endlichen, plausiblen Zahlen.
2. Weil man den Term nicht pruefen kann, muss man den **Korpus** pruefen. Und zwar an der Groesse, die
   bm25 wirklich liest: der Dokumentfrequenz der Tokens **dieses Rahmens**. Zeilenzahl und
   `SUM(LENGTH(content))` sind dafuer untauglich — ein `UPDATE`, das Inhalt gleicher Laenge tauscht,
   laesst beide unveraendert und schreibt die FTS-Zeile trotzdem neu (`db.ts:341-346`), und 25 Prozent
   neue Zeilen ueber fremde Themen bewegen die df der Anfragetokens kaum. `SUM(LENGTH(content))` ist
   ausserdem ein voller Scan und darf schon deshalb nie im Turn laufen.

Der Korpusstempel:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_v USING fts5vocab(memories_fts, 'row');
-- einmal je Nacht, nie im Turn: ueber die distinkten Tokens der Rahmen dieser Nacht
SELECT term, doc FROM memories_fts_v WHERE term IN (...);
```

Das Ergebnis liegt als eine `meta`-Zeile je Nacht (`store.ts:1495-1500` hat den Zugriff schon), und jeder
Rahmen traegt nur die `corpus_stamp_id`. Zur Bewertungszeit wird die maximale relative df-Aenderung ueber
die Tokens des Rahmens gebildet; ueber `dream.corpusTolerance` enthaelt sich die Spur mit
`corpus-drifted`. Der Stempel ist bis zu 24 Stunden juenger als der Rahmen — diese Unschaerfe ist
**genaehert** und wird berichtet, nicht wegdefiniert. Und der Stempel beweist nichts: er ist die
beobachtbare Groesse, die mit der Ungueltigkeit korreliert, und er wird genau so bezeichnet.

`reindex` (`db.ts:842`) und der Bulk-Importpfad verschieben den Stempel sprunghaft. Beide erklaeren die
Rahmen davor ausdruecklich fuer ungueltig und schreiben das in den Nachtbericht ("X von Y Rahmen
unbrauchbar seit dem Import am ..."), statt es jede Nacht neu erraten zu lassen.

### 3.4 Der Inhalt des Rahmens

```
RecallFrame {
  v: 1,
  site, pipeline, owner,
  box: { limitMax, w: {relevance:[lo,hi], importance:[lo,hi], recency:[lo,hi], usage:[lo,hi]},
         threshold:[lo,hi], hopEntity:[lo,hi], hopEdge:[lo,hi],
         kinds, minImportance },            // die letzten beiden als Literale, nicht als Spanne
  query: { text, matchQuery, tokens[] },    // recall.ts:45-60
  now,                                      // recall.ts:119
  corpusStampId,                            // Abschnitt 3.3
  maxRelevanceClamped,                      // recall.ts:120, NACH Math.max(..., 1)
  budgetChars, subject,                     // persona.ts:178 bzw. prompts.ts:366
  records: { [id]: MemoryRecordSnapshot },  // EIN Vorrat, alles andere referenziert per id
  hop1: [ { id, relevance } ] x limitMax*4, // in SQL-Reihenfolge
  possibleSeeds: [id],
  entities: { [memoryId]: [ {entityId, name, mentions} ] },        // fuer JEDE erreichbare Zeile
  entityNeighbours: { [entityId]: [id] x (8 + |possibleSeeds|) },  // OHNE exclude
  edges: [ {id, srcId, dstId, relation, weight} ],                 // refines|caused_by ab possibleSeeds
  contradicts: [ {srcId, dstId} ],                                 // ueber die erreichbare Menge
  profile: [ {id, reason} ],                // coreProfile an der permissivsten Ecke
  degraded: null | 'no-tokens' | 'fts-threw'
}
```

Die **erreichbare Menge** R ist `hop1 + profile + alle entityNeighbours + {edge.dstId}`. `entities` muss
ueber ganz R gehen, nicht nur ueber die Saaten — sonst ist das Messziel nicht geschlossen, weil
`groupByEntity` fuer **jede** gelieferte Erinnerung `entitiesFor` ruft (`recall.ts:373`). Dafuer bekommt
`Store` eine gebuendelte Methode `entitiesForMany(ids)`, eine Abfrage statt |R|.

Vier Feinheiten, die leicht verlorengehen:

* **Das Profil ist ueber `limit` nicht geschlossen, wenn man es realisiert aufzeichnet.**
  `runtime.ts:468-471` waehlt `limit: Math.max(3, Math.floor(recallLimit / 2))`, und `recallLimit` **ist**
  das `limit` der Box. Bei `limit: 8` haelt der Rahmen vier Profilzeilen, ein Kandidat mit `limit: 16`
  braucht acht. Aufgezeichnet wird deshalb an der permissivsten Ecke (`max(3, floor(limitMax / 2))`),
  und `mergeProfile` schneidet je Kandidat auf `max(3, floor(limit / 2))` ab. Die SQL von `coreProfile`
  (`recall.ts:274-283`) ist bezueglich dieses Abschneidens praefix-invariant, sobald sie den
  Gleichstandsbrecher aus Abschnitt 3.2 hat. Auf der Agentenpipeline ist der Wert das Literal 3
  (`org/controller.ts:2464`) und damit ohnehin geschlossen.
* **`entityNeighbours` muss die abgeloesten Zeilen mitzeichnen.** `memoriesForEntities` filtert
  `forgotten`, `dormant_at` und `archived_at` (`store.ts:900`), aber **nicht** `superseded_by`; `offer`
  filtert es (`recall.ts:194`). Das `LIMIT` beisst also vor dem Filter, und eine abgeloeste Zeile kann
  eine lebende aus den acht draengen. Die Asymmetrie ist genau diese eine Spalte — nicht dieselbe Form
  wie beim Tor, wo `similarMemories` weder `superseded_by` noch `archived_at` filtert
  (`gate.ts:298-304`).
* **Welche Entitaeten ueberhaupt Nachbarn liefern**, wird an der permissivsten Ecke entschieden
  (`hopEntity` maximal, `threshold` minimal), nicht am realisierten Punkt — `expand` verwirft eine
  Entitaet bei `mentions <= 1` (`recall.ts:203`) und bei `inherited < threshold * 0.5`
  (`recall.ts:206`).
* **`degraded` hat drei Welten, nicht zwei.** `recall` gibt `[]` zurueck bei unsuchbarer Anfrage
  (`recall.ts:88`), bei verschluckter MATCH-Ausnahme (`recall.ts:114-117`) — und drittens, wenn Zeilen
  kamen, aber alle unter der Schwelle blieben (`recall.ts:146`, `recall.ts:161`). Der dritte Fall ist ein
  **legitimer** Fehlschlag und muss gescored werden. Die Aufzaehlung `no-tokens | fts-threw` ist richtig;
  die Gefahr ist ein Rekorder, der `degraded` aus `top.length === 0` erschliesst.

### 3.5 Populationsreinheit: acht Aufrufstellen, vier Populationen

| Population | Stellen | Optionen | Im Traum |
|---|---|---|---|
| Turn (Assistent) | `runtime.ts:460-467` | touch AN, Hop AN, `limit` 8, Schwelle 0.12 | gescored |
| Turn (Agent) | `org/controller.ts:2458-2463` | touch AN, **kein Hop uebergeben**, Profil-Literal 3, **kein** `dropContradicted` | gescored, eigene Pipeline |
| Extraktor-Vorpruefung | `runtime.ts:1119`, `org/controller.ts:2476-2483`, `sleep.ts:656` | touch AUS, **`expand: false`**, `limit` 20/25, Schwelle 0.05 | nicht gescored |
| Werkzeug und Inspektor | `runtime.ts:328-336`, `org/controller.ts:555`, `routes/memories.ts:37-45`, `cli/commands/memory.ts:111-118` | touch AUS, `limit` bis 100 bzw. 500 (`routes/memories.ts:32`), `owner` frei aus dem Querystring (`routes/memories.ts:41`), Schwelle default 0 (`cli/commands/memory.ts:108`) | **nie gerahmt** |

Die Optionsmengen unterscheiden sich um einen Faktor drei bis sechzig in der Breite, und der zweite Hop
ist in der Extraktor-Population abgeschaltet. Daraus folgen zwei Regeln:

1. Der Rekorder wird **an der Aufrufstelle** eingeschaltet, nie per Vorgabe in `recall`. Ein generisch in
   `recall` sitzender Rekorder wuerde Browser-Suchen mit fremdem Owner und CLI-Aufrufe rahmen.
2. `dream_traces.site` kennt `turn | extract | tool | inspect`; gescored wird in Phase 1 bis 4 nur
   `site = 'turn'`, und darin getrennt nach `pipeline`.

Dazu eine fuenfte, stumme Population: ein Lauf mit `kind: 'schedule'` (`types.ts:116`) durchlaeuft den
normalen Turn-Pfad, kann aber **nie** ein Korrekturetikett bekommen, weil `sessionsActiveSince`
`kind NOT IN ('mail', 'schedule')` filtert (`store.ts:1104`). Solche Turns werden nicht gerahmt:
`dream_traces.session_kind` wird mitgeschrieben, `frameRate` gilt nur fuer `chat | voice | mail`.

### 3.6 Die Nachbearbeitungskette ist ein Feld des Rahmens

Es gibt zwei Ketten, nicht eine Kette mit einem Renderer-Schalter:

```
pipeline = 'assistant'                       pipeline = 'agent'
  ranked  = scoreFrame(frame, policy)          ranked  = scoreFrame(frame, policy)
  merged  = mergeProfile(profile, ranked)      merged  = mergeProfile(profile[0..3], ranked)
  kept    = dropContradictedFromFrame(merged)  kept    = merged      // controller.ts:2456-2468
  sorted  = kept.sort(score desc, id asc)      sorted  = kept.sort(score desc, id asc)
  P       = renderFromFrame(sorted, grouped)   P       = renderFromFrame(sorted, flach)
```

Der Agentenpfad ruft `dropContradicted` nicht (`org/controller.ts:2456-2468`) und rendert ohne Store
(`org/prompts.ts:366`). Wer die Assistentenkette auf Agentenspuren anwendet, scored einen Prompt, den es
nie gab. `frame.pipeline` waehlt die Kette, und Phase 1 braucht **je Pipeline** einen eigenen
Aequivalenztest.

### 3.7 Die sieben Arten, falsch zu replayen und dabei richtig auszusehen

Jede Zeile ist ein Fehler, den ein Test fangen muss:

(a) Hop-1-SQL live neu ausfuehren — anderer Korpus, andere bm25, andere Zeilen, alle Zahlen endlich und
vernuenftig.
(b) `recency` mit dem `Date.now()` des Replays rechnen statt mit `frame.now` (`recall.ts:119, 126`) — alle
Zeilen zerfallen gemeinsam, die Streuung schrumpft, ein Kandidat, der `recency` hebt, sieht neutral aus,
wo er entscheidend gewesen waere.
(c) `access_count` live lesen (`recall.ts:127`) statt aus dem Rahmen — Abschnitt 9.3.
(d) nur die gelieferten Top-8 aufzeichnen — jeder Kandidat kann dann nur umsortieren, was der Amtsinhaber
schon gewaehlt hat; Deltas werden klein, Intervalle eng, und "kein Kandidat schlaegt den Standard" wird
ein Fixpunkt der Messung statt eines Befunds.
(e) `expand()` gegen die heutige Bank — `recountEntities` (`store.ts:821-834`) zaehlt nur lebende Links,
also senkt jede Stilllegung `mentions` und **hebt** damit `damping = 3 / mentions` (`recall.ts:204`);
nachtgeschriebene `refines`/`caused_by`-Kanten feuern (`recall.ts:213`). Grundlinie und Kandidat wandern
gemeinsam, das Delta bleibt stabil, beide messen eine Welt, die es nie gab.
(f) die realisierte Expansion einfrieren und Gewichte variieren — der Kandidat wird auf einem Hop
bewertet, den er nicht gemacht haette.
(g) die `Math.max(..., 1)`-Klammer beim Renormieren vergessen (`recall.ts:120`) — blaeht Anfragen mit
niedrigem bm25 um einen plausibel aussehenden Faktor auf.

---

## 4. Von der Quelle zum Etikett

Ohne diesen Abschnitt hat `dream_labels.relevance` keinen Schreiber, und dann misst der ganze Apparat
nichts. Fassung 1 fuehrte fuenf Quellen in einer Tabelle auf, ohne fuer eine einzige die Abbildung auf
`gain(m)` je (Turn, Erinnerung) anzugeben. Das wird hier nachgeholt — mitsamt den Kosten und der
Trefferquote, die jede Quelle erst noch beweisen muss.

### 4.1 Was ein Etikett behaupten muss

Ein Etikett ist ein Tupel `(turn_id, memory_id, relevance in {0, 1}, source, evidence)`. Es behauptet
etwas ueber **diesen Turn**: "diese Erinnerung haette in diesem Prompt stehen muessen" (1) oder "diese
Erinnerung stand in diesem Prompt und hat dort nichts verloren" (0). Ein Etikett, das nur sagt "diese
Erinnerung ist generell gut", ist kein Abrufetikett: ein nDCG darueber misst, ob der Abruf die global
beliebten Zeilen geholt hat, und genau diese Zeilen liefert `coreProfile` (`recall.ts:279`:
`importance >= ? OR pinned = 1`) ohnehin in jedem Turn, ohne Zutun einer Abruf-Policy.

`gain(m)` fuer einen Turn ist der Wert der **Primaerquelle** nach dieser Rangfolge:
`user > correction > merge`. Widersprechen sich zwei Quellen auf demselben Ziel, entscheidet die
Rangfolge den Wert, aber der Widerspruch wird gezaehlt und geht in den Etikettenabgleich
(Abschnitt 5.5b) ein — nie still ueberschrieben. `review` liefert kein `gain`; siehe unten.

### 4.2 Die vier Quellen

**(a) `correction` — die einzige Quelle, die eine *nicht* gelieferte Erinnerung etikettieren kann.**

Korrekturen entstehen ausschliesslich in `#replay` (`sleep.ts:631-641`): das Nachtmodell liefert
`{text, quote}`, das Zitat muss aus dem zusammengeklebten Nutzertext der Sitzung belegbar sein
(`confirmedBy(quote, [said])`, `sleep.ts:638`, `said` aus `sleep.ts:579`), dann schreibt
`addCorrection` eine Zeile mit `session_id` und dem `Date.now()` der **Nacht** (`store.ts:1122-1128`).
Zwei Schritte fehlen also bis zu einem Etikett:

1. *Vom Sitzungs- zum Turnbezug.* Das Zitat wird im Transkript lokalisiert. Genau ein Vorkommen: der
   `turn_id` dieser Nachricht. Mehrere oder keines: `turn_id` bleibt `NULL` und das Etikett wird
   ausdruecklich als **sitzungsweit** markiert — es zaehlt dann fuer den Etikettenabgleich und die
   Kalibrierung, aber nie fuer ein `gain`. Nicht raten.
2. *Von der Korrektur zur Erinnerung.* Die Korrektur nennt keine `memory_id`. Der billige Weg ist die
   Arithmetik, die das Tor ohnehin hat: `similarity(normalizeTokens(text), normalizeTokens(content))`
   (`gate.ts:209-211`) gegen die erreichbare Menge R des Turns. Ein Treffer ueber
   `gate.duplicateThreshold` (`config.ts:51`) auf einer Zeile, die **im Prompt stand**, ergibt
   `relevance = 0` (sie war da und war falsch); ein Treffer auf einer Zeile, die zum Zeitpunkt des Turns
   existierte und **nicht** im Prompt stand, ergibt `relevance = 1`.

Der zweite Fall ist der wertvollste im ganzen Konzept: er etikettiert ein Ziel, das der Amtsinhaber
nicht geliefert hat. Pflicht dabei: `created_at` der Kandidatenzeile muss **vor** dem Turn liegen —
`#replay` schreibt in derselben Nacht selbst Erinnerungen (`sleep.ts:613-621`), und ein Etikett auf eine
Zeile, die es im Turn noch gar nicht gab, ist ein Anachronismus, keine Evidenz.

*Kosten:* null Modellaufrufe; eine Dice-Rechnung ueber |R| Zeilen je Korrektur. *Trefferquote:*
**zu messen** in Phase 2 an mindestens 50 von Hand beurteilten Korrekturen; erwartet niedrig, weil viele
Korrekturen eine Aussage des Assistenten betreffen, hinter der nie eine Erinnerung stand. Faellt die
Quote unter `dream.correctionPrecisionFloor` (Vorschlag 0.6, geraten), ist diese Quelle keine Quelle, und
die Alternative ist ein Modellaufruf je Korrektur — dann ist die Bewertung nicht mehr modellfrei und der
Posten steht als `dream.labelModelCalls` (Vorgabe 0) im Nachtbericht.

**(b) `user` — die einzige Quelle, auf die die Abruf-Policy keinen kausalen Weg hat.**

Nutzer bearbeitet, heftet an, entpinnt oder vergisst eine Erinnerung: `PATCH /api/memories/:id`
(`routes/memories.ts:130-150`), `DELETE /api/memories/:id` (`routes/memories.ts:152-163`). Der **Wert**
des Etiketts ist unabhaengig vom Abruf. Seine **Zuordnung** ist es nicht: um daraus ein `(turn, memory)`
zu machen, muss man einen Turn waehlen, und die einzige verfuegbare Regel waere "die Turns, die diese
Erinnerung hochgespuelt haben" — eine Funktion der Policy. Deshalb gilt:

* Zugeordnet wird auf das **Sitzungsfenster**, nicht auf einen Turn: alle Spuren der Sitzungen im
  Zeitraum `[T' - dream.userLabelWindow, T']`.
* Das Ziel muss fuer **jeden** verglichenen Kandidaten in R gelegen haben. War es das nicht, enthaelt
  sich die Spur fuer alle Arme.
* Zwei Loecher sind heute offen: der Store nimmt keinen Akteur entgegen (`forgetMemory(id)`,
  `store.ts:522`; `updateMemory`), das Werkzeug des Modells erreicht dieselben Methoden, und der
  Unterschied "Nutzer" gegen "Modell" ist im Store nicht einmal darstellbar. Beide Routen bekommen
  deshalb einen Akteur-Parameter, und ein `user`-Etikett entsteht **nur** auf dem HTTP-Pfad.

Zusaetzlich, und das ist die einzige anfrage**abhaengige**, vom Abruf kausal unabhaengige Quelle, die
Rookery ueberhaupt haben kann: die Chat-Oberflaeche hebt die in diesem Turn abgerufenen Erinnerungen
bereits hervor (`providers/rookery-provider.tsx:112, 391`; `hooks/useChat.ts:50, 226`) — rein transient,
nirgends persistiert. An dieser Hervorhebung ein "war der Punkt / war Ballast" je Erinnerung schreibt ein
`user`-Etikett mit echtem Turnbezug. *Kosten:* eine Route, ein Klickziel. *Trefferquote:* per
Konstruktion 1, sofern der Nutzer klickt — die offene Groesse ist die **Menge**, und die misst Phase 2.

**(c) `merge` — billig, reichlich, und nur in einer Richtung gueltig.**

`#condense` schreibt eine verdichtete Zeile und setzt auf den Quellen `superseded_by` (Schlafkonzept
§4.3). Das sagt "redundant", nicht "relevant fuer diese Frage". Daraus folgt eine Regel, die nur
negative Etiketten erzeugt: standen in **einem** Turn zwei Zeilen im Prompt, die spaeter in dasselbe
Verdichtungscluster fielen, dann ist die schlechter platzierte der beiden **belegt redundant**,
`relevance = 0`. Hoechstens ein `supersedes`-Sprung, sonst wandert das Etikett ueber Wochen weg von dem,
was es beobachtet hat.

*Kosten:* null Modellaufrufe, eine Abfrage ueber `memories.superseded_by` je Rahmen. *Trefferquote:*
**zu messen**; die Behauptung ist stark, weil das Zeichenbudget knapp ist — 2400 Zeichen auf dem
Assistentenpfad (`persona.ts:173, 178` mit `config.ts:45`), und `push` bricht die Schleife ab, statt sie
fortzusetzen (`recall.ts:323-345`). Eine redundante Zeile kostet also nicht nur Platz, sie kostet die
Zeile dahinter.

**(d) `review` — ein Spurgewicht, kein `gain`.**

`upsertReview` (`org/store.ts:1084-1120`) ist der einzige Trichter aller Bewertungsquellen, bewertet aber
ein **Assignment** mit `overall` 1 bis 5, nicht eine Erinnerung. Es gibt keinen beobachtbaren Weg von
"der Auftrag war gut" zu "diese Erinnerung gehoerte in den Prompt". `review` schreibt deshalb eine Zeile
mit dem Sentinel-Ziel `'*'` und `relevance = (overall - 1) / 4`, und diese Zeile geht **nie** in DCG ein.
Sie dient dem Etikettenabgleich als Kontrollgroesse und Stufe 2 als Belohnung. Zwei Warnungen:
`upsertReview` **ersetzt** die Zeile fuer dasselbe `(assignment_id, source)` und setzt `created_at` neu
(`org/store.ts:1100-1120`) — eine einmal angehaengte Belohnung kann spaeter still widerrufen werden; und
ein Agent bekommt ueber `#replay` nie eine Korrektur (`sleep.ts:563`), sein Etikettenzufluss haengt also
fast vollstaendig an dieser einen, unscharfen Quelle.

### 4.3 Warum `usefulness` und `memory_touches` keine Quellen sind

`grep usefulness` ueber `packages/core/src` und `packages/server/src` ergibt genau einen Schreiber:
`touchMemories` (`store.ts:550-561`, `usefulness = MIN(1.0, usefulness + 0.03)` in Zeile 557), und
`touchMemories` wird genau einmal gerufen: aus `recall` selbst, auf den Zeilen, die `recall` gerade
zurueckgegeben hat (`recall.ts:163-165`). `usefulness` ist damit ein Zaehler fuer "wurde geliefert",
bitgleich mit `access_count` (`store.ts:556`). Ein Etikett aus dieser Quelle belohnt jeden Kandidaten
dafuer, dass er holt, was der Amtsinhaber schon geholt hat — und die naheliegende Reparatur ("nur
Beruehrungen **nach** dem Turn zaehlen") verschiebt die Rueckkopplung um genau eine Spur, statt sie zu
brechen: befoerdern, X haeufiger liefern, X's Beruehrungen steigen, naechste Nacht traegt X ein Etikett,
die Policy, die X liefert, gewinnt wieder.

Die Quelle wird deshalb gestrichen, nicht repariert (E9). `source` ist
`correction | review | merge | user`. `usefulness`, `access_count` und `memory_touches` bleiben
**Merkmale**: sie sind Eingaben des Scores (`recall.ts:127`) und werden im Rahmen eingefroren; sie sind
nie Wahrheit.

Der Vollstaendigkeit halber der Kostenposten, der damit sichtbar wird: ueber `sleep.ts:684`
(`strength = 0.5 * importance + 0.3 * usefulness + 0.2 * recency`, Stilllegung bei
`strength < minStrength`, `sleep.ts:685`) entscheidet `usefulness` mit, was schlafen gelegt wird, und
`dormant_at` ist ein harter Filter im Abruf (`recall.ts:102`). Eine befoerderte Abruf-Policy veraendert
also dauerhaft die **Zusammensetzung der Bank** fuer alle kuenftigen Rahmen. Das ist kein Etikettenfehler
mehr, sondern ein Wirkungsweg, und er steht in Abschnitt 10.4.

### 4.4 Abdeckung, und warum der Schaetzer eine untere Schranke bleibt

Jede Bewertung berichtet zwei Raten:

* `label_coverage` — Anteil der Positionen in der Vereinigung der Top-k aller verglichenen Arme, fuer die
  ueberhaupt ein Etikett **existieren koennte**: das Ziel liegt im etikettierten Universum des
  Sitzungsfensters. Unter `dream.coverageFloor` (Vorschlag 0.3, geraten) ist die Bewertung ungueltig.
* `cost_only_share` — Anteil der Spuren, deren `d_t` ausschliesslich aus dem Kostenterm stammt, weil beide
  Arme dieselbe (oder gar keine) etikettierte Position getroffen haben. Solche Spuren sind **enthalten**
  (`no-labelled-move`); liegt ihr Anteil ueber `dream.costOnlyCeiling` (Vorschlag 0.5, geraten), ist die
  Bewertung ungueltig. Ein Delta, das ueberwiegend aus unetikettierten Positionen stammt, ist kein Delta.

Der Grund fuer beide Raten ist nicht schliessbar und heisst Missing-Label-Bias: eine Erinnerung bekommt
ein Etikett nur ueber Kanaele, die voraussetzen, dass der Amtsinhaber sie hochgespuelt hat — mit der
einen Ausnahme von Abschnitt 4.2(a), Fall zwei. Ein Kandidat, der eine **andere, tatsaechlich bessere**
Erinnerung holt, bekommt dafuer `gain = 0`, weil niemand sie je etikettiert hat. Das rahmenrelative Ideal
korrigiert das nicht: es wird aus derselben etikettierten Menge gebildet, IDCG schrumpft im Gleichschritt,
und das Verhaeltnis normiert nur die Treffer des Amtsinhabers auf 1.0. Deshalb gilt E8: der Schaetzer ist
fuer jeden Kandidaten, dessen Trefferliste von der des Amtsinhabers abweicht, eine **untere Schranke** des
wahren Deltas, nie ein Punktschaetzer. Er kann belegen, dass ein Kandidat besser ist. Er kann nicht
belegen, dass einer schlechter ist.

### 4.5 Die Angebotsseite: wie viele Etiketten entstehen ueberhaupt

`minTraces`, `calibrationTraces` und `cooldownNights` sind Zahlen ohne Bezug, solange niemand den Zufluss
gemessen hat. Die Decke ist eng: Korrekturen entstehen nur in `#replay`, der laeuft nur fuer
`owner === ASSISTANT_MEMORY_OWNER` (`sleep.ts:563`), nur ueber `#replayCandidates` mit
`replaySessions = 36` als Obergrenze (`sleep.ts:487-489`, `config.ts:88`), nur fuer Sitzungen mit
mindestens zwei echten Nutzerzuegen (`sleep.ts:498`), und nur wenn die Triage `worth === true` liefert
(`sleep.ts:592`). Phase 0 der Umsetzung ist deshalb eine reine Messung: wie viele etikettierte Spuren
entstehen pro Nacht, je Quelle. Alles Weitere haengt an dieser Zahl, und sie ist heute unbekannt.

---

## 5. Die Bewertungsmaschinerie

### 5.1 Das Messziel

Gemessen wird `P(trace, policy)` — die geordnete Liste der Erinnerungen, **deren Zeilen in den Block
gepasst haben**, in Promptreihenfolge, hergestellt ueber die Kette der zum Rahmen gehoerenden Pipeline
(Abschnitt 3.6). `renderFromFrame` ist eine Kopie von `renderMemoryBlock`/`groupByEntity`
(`recall.ts:314-393`) **ohne Store**, gespeist aus `frame.entities`. Sie muss zeichengleich zur
Originalfunktion sein; das ist ein Test, keine Behauptung.

### 5.2 Der Schaetzer

Fuer eine Spur `t` und eine Policy `p`:

```
gain(m)      = Etikettenwert der Primaerquelle, in [0,1]   (Abschnitt 4.1)
DCG(P)       = Summe ueber i von gain(P_i) / log2(i + 1)
R            = die erreichbare Menge des Rahmens
Ideal        = { m in R : gain(m) > 0 }, nach gain absteigend,
               gerendert mit DEMSELBEN Renderer wie P und demselben Zeichenbudget
IDCG         = DCG(Ideal)
nDCG(t,p)    = DCG(P) / IDCG                  (IDCG = 0  -> Spur enthaelt sich)
chars(t,p)   = benutzte Zeichen / frame.budgetChars  in [0,1]
score(t,p)   = nDCG(t,p) - lambda * chars(t,p)       lambda = dream.costWeight, 0.05 geraten
```

Vier Entscheidungen im Mass:

* **Das Ideal ist rahmenrelativ.** Ein Etikett, dessen Ziel inzwischen `superseded_by` traegt und deshalb
  von der Hop-1-SQL hart ausgeschlossen wird (`recall.ts:103`), ist fuer *jeden* Kandidaten unerreichbar.
  Wuerde es ins Ideal eingehen, druckte es alle Werte gleichermassen und komprimierte genau die Deltas,
  die das Tor testet. Stattdessen faellt es aus dem Ideal, und die Spur meldet `reachable_rate`.
* **Das Ideal wird mit demselben Renderer gerendert wie P.** Die frueher vorgesehene flache Darstellung
  des Ideals war falsch begruendet: die Policy waehlt, **welche** Erinnerungen hineinkommen, und damit die
  Entitaetsverteilung, auf die `groupByEntity` buckets bildet. Der gruppierte Renderer schreibt je Gruppe
  eine zusaetzliche Kopfzeile und zwei Zeichen Einrueckung je Eintrag (`recall.ts:333, 336`); ein flacher
  Nenner gaebe entitaetskonzentrierten Kandidaten einen Vorteil, der mit Relevanz nichts zu tun hat.
* **Summe, nie Verhaeltnis.** Ein Verhaeltnis ("Treffer je Zeichen") gewinnt man mit einer garantiert
  relevanten Profilzeile und sonst nichts. Der Test dafuer: das Mass darf **nicht** skaleninvariant sein —
  Treffer und Zeichen halbieren muss den Wert aendern.
* **Das Ergebnis ist eine untere Schranke** (Abschnitt 4.4, E8). Diese Eigenschaft steht in jedem Bericht
  neben der Zahl, nicht in einer Fussnote.

### 5.3 Aggregation und Intervall

* **Gepaart je Spur:** `d_t = score(t, cand) - score(t, base)`, nur ueber Spuren, wo **beide** geschlossen
  haben (Schnittmenge, nie jede Seite auf ihrer eigenen Menge).
* **Cluster-Bootstrap ueber Sitzungen**, nicht ueber Spuren: B = 2000 Ziehungen von Sitzungen mit
  Zuruecklegen, je Ziehung Mittelwert aller `d_t` der gezogenen Sitzungen, Perzentilintervall 2.5/97.5,
  ausgewiesen als **genaehert**. Bei den erwarteten 10 bis 25 Clustern ist die Ueberdeckung eines
  Perzentilintervalls auf einer schiefen gepaarten Mittelwertverteilung merklich unter dem Nominalwert;
  das ist der Grund, warum Bedingung 2 in Abschnitt 10.2 zusaetzlich kumulativ gegen die Werksvorgabe
  prueft, und nicht der Grund, das Intervall wegzulassen.
* **Multiplizitaet:** die `dream.candidates` Kandidaten werden auf der **Trainingshaelfte** gerankt; auf
  die Rueckhaltemenge geht genau **einer**.
* **Wiederholtes Testen ueber Naechte:** `dream_evals.trace_set_hash`; die Spurenmenge einer Befoerderung
  muss disjunkt zu der der vorigen Befoerderung desselben Slots sein, dazu `dream.cooldownNights`
  (Vorschlag 7, geraten).

### 5.4 Gueltigkeitsbedingungen — das Zertifikat

Jeder Rahmen traegt seine `box`. `scoreFrame` liefert `{ ok: true, ranked }` oder `{ ok: false, reason }`.
Box-Verletzungen koennen nach Abschnitt 3.1 nicht mehr auftreten; sie bleiben als Zusicherung mit Test
stehen — ein Feuern ist ein Rekorderfehler, kein Messergebnis. Real eintretende Enthaltungsgruende:

| Grund | Bedeutung | Tritt ein, wenn |
|---|---|---|
| `frame-missing` | nicht gerahmt | Sitzung war nicht in der Stichprobe |
| `corpus-drifted` | df der Rahmentokens hat sich zu weit bewegt | ueber `dream.corpusTolerance` (Abschnitt 3.3) |
| `budget-changed` | Nenner des Kostenterms verschoben | `config.memory.contextBudget` (`config.ts:45`, ueber `SettingsPage` frei einstellbar, `schemas.ts:288`) weicht ueber eine Toleranz ab |
| `no-reachable-label` | `IDCG = 0` | jedes Etikettenziel ist tot oder war nie im Rahmen |
| `no-labelled-move` | Delta nur aus dem Kostenterm | Abschnitt 4.4 |
| `seeds-capped` | Rahmen unvollstaendig | `|possibleSeeds|` ueber der harten Grenze (Abschnitt 3.1) |
| `degraded-turn` | kein legitimer Fehlschlag | `recall.ts:88` oder `recall.ts:114-117`; **nicht** der Fall "alles unter der Schwelle" |
| `pipeline-mismatch` | Rahmen aus einer anderen Kette | `assistant` gegen `agent` (Abschnitt 3.6) |
| `no-label-source` | Owner ohne Etikettenzufluss | Agenten: `#replay` laeuft nur fuer den Assistenten (`sleep.ts:563`) |
| `unfinished` | Spur ohne `finished_at` | abgebrochener Stream, Prozessende; `failStaleTraces` beim Start, nach dem Muster von `failStaleSleepRuns` (`store.ts:1400-1408`) |

Regeln, im Tor durchgesetzt und in `dream_evals` gespeichert:

1. Grundlinie und Kandidat werden auf der **Schnittmenge** bewertet.
2. `abstain_rate(cand) <= abstain_rate(base) + dream.abstainEps` **und** beide unter
   `dream.abstainFloor` (0.05 / 0.30, geraten). Ein Kandidat, der gewinnt, weil er nur dort geprueft
   wurde, wo es ihm bequem ist, wird abgelehnt.
3. `n_closed` nach Schnittmenge unter `minTraces` — Bewertung **ungueltig**, nicht "Kandidat verloren".
4. `reachable_rate` im Mittel unter `dream.reachableFloor` (0.5, geraten) — ungueltig.
5. `label_coverage` und `cost_only_share` nach Abschnitt 4.4.

### 5.5 Drei Sensoren, drei Fehler

**(a) Frisch-Test — Rahmenveralterung. Null Modellaufrufe.**
Grundlinie und Kandidat laufen zweimal: gegen die eingefrorenen Rahmen (`delta_frozen`) und gegen die
**lebende** Bank (frischer `fetchFrame` mit gleichem Anfragetext, Owner und Box; `delta_live`). Stimmen
die Vorzeichen nicht ueberein und ist `|delta_frozen| > margin`, ist die Bewertung ungueltig und der Slot
bekommt einen `staleness`-Vorfall.

Zwei Dinge machen den Test kaputt, wenn man ihn falsch platziert, und beide sind am Code belegt:

* **Er darf nicht im Zyklus laufen.** Der naheliegende Einfuegepunkt (letzter Zyklus, nach `#reflect`)
  liegt **hinter** `#condense`, `#resolve`, `#link` und hinter `recountEntities` am Kopf jedes Zyklus
  (`sleep.ts:309`). `#condense` setzt `superseded_by`/`dormant_at` genau auf den Fast-Duplikat-Clustern,
  die der Tag am haeufigsten geholt hat, und `recall.ts:103` filtert `superseded_by IS NULL` hart. Das
  ist eine grosse, einmalige, **abrufkorrelierte** Mutation, keine stationaere Drift. Der Frisch-Test
  laeuft deshalb **vor** der Zyklusschleife, direkt nach der Replay-Phase und der Budgetmessung, also
  zwischen `sleep.ts:294` und `sleep.ts:296`.
* **Er darf die Bank nicht anfassen.** `recall`s Vorgabe ist `touch: true` (`recall.ts:163`). Jeder
  Lesezugriff des Traums hat `touch: false` fest verdrahtet, mit einem Test, der genau das zusichert —
  sonst fuettert der Waechter die Rueckkopplung, gegen die er waecht.

Der Test behauptet ausdruecklich **nicht**, der Live-Lauf sei richtig. Er ist in fuenf bekannten
Richtungen verschmutzt: `recountEntities` senkt `mentions` (`store.ts:821-834`) und hebt damit die
Daempfung des zweiten Hops (`recall.ts:204`); die Nacht schreibt Kanten, die dem Turn nachdatiert sind;
`importance` driftet je Verstaerkung um +0.02 und hebt `updated_at` mit (`store.ts:288, 303`);
`forgotten`/`dormant_at`/`superseded_by`/`archived_at` kippen und sind harte Filter (`recall.ts:101-104`).
Der Punkt ist, dass diese Verschmutzung Grundlinie und Kandidat **in dieselbe Richtung** schiebt — ein
Vorzeichenwechsel heisst also, dass die Ordnung der beiden Policies gegen Bankbewegung nicht robust ist.
Genau das sieht der Bootstrap nicht, weil er Spuren neu zieht und die Bank festhaelt. Eine bekannt
verschmutzte Zahl darf als **Vergleicher** dienen und nie als Messung.

**(b) Etikettenabgleich — Gueltigkeit des Stellvertreters. Null Modellaufrufe, fortlaufend.**
Je Slot Cohens Kappa (oder blosse paarweise Uebereinstimmung) zwischen den Etikettenquellen auf ihren
gemeinsamen Zielen. Privilegiert ist `user` (Abschnitt 4.2b). Ein Delta, das auf den beeinflussbaren
Quellen positiv und auf `user` flach oder negativ ist, wird markiert und abgelehnt. Sind `user`-Etiketten
zu duenn fuer einen Abgleich, ist **das** der Befund: das Mass ist unvalidiert, und der Slot bleibt
unbefoerdert.

**(c) Wach-Test — Verteilungsdrift. Buchhaltung, nach `calibrationTraces` Spuren.**
Ausdruecklich ein **Regressionsalarm**, keine Kalibrierung: Replay- und Onlinewert kommen aus demselben
Schaetzer und denselben Etiketten; sind die Etiketten falsch, sind sich beide einig. Er faengt, dass sich
die Spurenverteilung nach der Befoerderung verschiebt — mehr nicht, und das steht so im Bericht.

**(d) Der eingefrorene Pruefsatz.** Kein Sensor, sondern der Boden, auf dem die drei stehen: eine Menge
Sitzungen, die **nie** fuer Selektion und **nie** als Rueckhalt einer Befoerderung dient. Er wird je
Befoerderung genau einmal angefasst (Abschnitt 10.2, Bedingung 2b). Ohne ihn ist eine Kette lokal
signifikanter Einzelvergleiche, jeder auf frischen Daten und jeder nur gegen den jeweiligen Amtsinhaber,
eine Irrfahrt mit Sperrklinke: kein einzelner Schritt muss nachweisbar falsch sein, damit die Kette weit
von der Vorgabe entfernt endet.

---

## 6. Die Kandidatensuche

### 6.1 Phase 1 braucht gar keine

Der erste ausgelieferte Wert ist die **Gitterprobe**: ein fest deklariertes Gitter von 8 bis 12
Parameterbelegungen (Gewichte an ihren Boxraendern, Schwelle in drei Stufen, `hopEntity`/`hopEdge` in
zwei), gegen den Amtsinhaber gescored. Null Modellaufrufe, kein Kandidatenschreiber, keine Befoerderung,
keine `policy_versions`-Tabelle. Ergebnis ist eine Zahl je Belegung mit Intervall und die erste Antwort
auf "arbeitet unser Abruf gut?".

Null Modellaufrufe heisst nicht null Kosten: die Probe liest N Rahmen, `JSON.parse`t sie und faehrt
8 bis 12 Policies ueber sie, auf demselben synchronen Handle, den der Server benutzt (`db.ts:22-25`, eine
Verbindung). Sie bekommt deshalb eine eigene Wanduhr-Obergrenze `dream.maxEvalMs`, die wie `modelCalls`
gezaehlt und berichtet wird.

### 6.2 Der Kandidatenschreiber (ab Phase 3)

Ein Modellaufruf je Kandidat auf `dream.model` (Vorschlag `sonnet`, geraten), **nie** `smallModelFor`.
Achtung: `ask` (`sleep.ts:1789`) verdrahtet `effort: 'low'` (`sleep.ts:1801`) — der Kandidatenschreiber
darf `ask` daher nicht unveraendert benutzen; entweder bekommt `ask` einen Effort-Parameter, oder der
Traum bekommt seinen eigenen schmalen Aufrufer (E14). Zu beachten ist ausserdem, dass `ask` nie wirft
(`sleep.ts:1809-1811`): ein Modellfehler bricht die Nacht nicht ab, aber eine leere Antwort muss als
solche behandelt werden.

Eingabe, und **nur** diese: der geltende Parametersatz und seine Grundlinie; die Box je Feld; aggregierte
Komponentenvektoren der schlechten Faelle (je Fehlfall die Mittelwerte von `relevance`, `importance`,
`recency`, `usage`, `tagHit` der Zeilen, die haetten oben stehen sollen, gegen die, die oben standen;
Rangposition des ersten relevanten Treffers; Anteil der Faelle, in denen das Zeichenbudget vor dem ersten
relevanten Treffer riss; Anteil, in dem Hop 2 den Treffer geliefert haette). **Kein** Anfragetext, **kein**
Erinnerungsinhalt, **keine** Rueckhaltespur.

Der Test dazu ist ein **Konstruktionstest**, kein Teilzeichenkettentest: der Prompt wird aus einer
typisierten Struktur rein numerischer Aggregate gebaut, die kein einziges Zeichenkettenfeld hat, und der
Test prueft genau diese Struktur. Ein Test der Form "keine Teilzeichenkette einer Spur ueber N Tokens
kommt im Prompt vor" kann bei so gebautem Prompt nicht fehlschlagen und belegt deshalb nichts. Was er
ohnehin nicht faengt: die Aggregate werden ueber Trainingssitzungen gebildet, die zu
Rueckhaltesitzungen thematisch benachbart sind. Diese statistische Naehe ist ein **akzeptierter,
unvermessener Rest** (Abschnitt 12).

Ausgabe streng als JSON ueber `parseObject` (`sleep.ts:1816`), dann **Zulassungspruefung vor jeder
Bewertung** (Abschnitt 10.1). Ein boxverletzender Kandidat ist ein Validierungsfehler zur Erzeugungszeit,
keine Enthaltung zur Bewertungszeit.

### 6.3 Der Amtsinhaber ist immer Kandidat

Und er laeuft im selben Durchgang mit, sonst vergleicht man gegen eine Zahl von gestern (E2).

---

## 7. Die Slots

### 7.1 Slot-Tabelle, mit dem Vokabular aus Abschnitt 2

| Slot | Was die Policy steuert | Hop 1 | Hop 2 | Messziel | Gesamturteil |
|---|---|---|---|---|---|
| `recall` | Gewichte, `threshold`, `hopEntity`, `hopEdge`, `limit` | **exakt**, ausser `relevance` = **eingefroren** | **exakt** ueber `possibleSeeds`; `mentions`, `importance`, `edge.weight` **eingefroren** | **exakt** ueber den Rahmen | exakt mit einem eingefrorenen Term, unter Korpuswache |
| `budget` | Phasenanteile in `allocateNightBudget` (`sleep.ts:1947`) | Zuteilung **exakt** | — | Ertrag je Aufruf **genaehert** aus beobachteten Raten je Owner und Phase, mit Streuung, nie extrapoliert | genaehert |
| `retry` | Abbruchpunkt ueber realisierte Versuche | — | — | **einseitig exakt**: frueher stoppen ist replaybar, spaeter nicht (der dritte Versuch existiert nicht) | einseitig exakt |
| ~~`gate`~~ | `duplicateThreshold`, `clusterThreshold`, `minImportance`, `maxPerTurn` | — | — | — | **nicht in Stufe 1** (7.2) |
| ~~`cluster`~~ | Buendelbildung | — | — | — | replaybar, aber der Ertrag ist ein Modellaufruf |

Stufe 1 beginnt mit `recall` allein. `budget` und `retry` kommen in Phase 5, wenn das Mass getragen hat.

### 7.2 Warum der `gate`-Slot Stufe 1 verlaesst

Die Idee war: `admitCandidates` (`gate.ts:178-279`) sequentiell simulieren und den Turn ab der ersten
Entscheidungsdivergenz als `praefixgueltig` fuehren, also nur das Praefix bewerten. Das erzeugt ein
identisch nulles Delta. Das Praefix ist per Definition die Folge der Kandidaten, auf denen Amtsinhaber und
Herausforderer **dieselbe** Entscheidung getroffen haben; die Schleife hat je Kandidat keine anderen
Ausgaben als die Store-Schreibvorgaenge und `result.{stored, reinforced, rejected, queued}`
(`gate.ts:181, 187, 197, 205, 212, 220, 241, 258, 274`). Gleiche Entscheidungen ergeben gleiche Ausgaben
ergeben gleichen Score. Die eine Stelle, an der eine Tor-Policy je Wirkung zeigen koennte — die erste
abweichende Entscheidung — ist genau der Schritt, den die Regel wegwirft. Dazu kommt, dass fuer `gate`
gar kein Messziel definiert ist: das natuerliche ("hilft die gespeicherte Erinnerung spaeter?") braucht
eine spurenuebergreifende Zuordnung, die das Schema nicht traegt.

Was bleibt, ist der Mechanismus, und er bekommt seinen richtigen Namen: **Erst-Divergenz-Bewertung** —
durch die erste Divergenz hindurch bewerten, danach aufhoeren. An der ersten Divergenz ist die simulierte
Bank noch identisch, die Entscheidung dort ist also **exakt** bewertbar; alles danach ist undefiniert.
Der Slot kehrt zurueck, wenn ein eigenes Messziel dafuer definiert ist, nicht vorher. Damit entfaellt
auch die Bedingung "`Summe verified / Summe total >= prefixFloor`" aus dem Vorentwurf: sie mass die
Position in einer Schleife, nicht Evidenz.

Der Vollstaendigkeit halber, damit der spaetere Bauer es nicht neu herausfinden muss: ein Tor-Rahmen
braeuchte mehr, als der Vorentwurf aufzaehlte. `richer(twin.memory.content, content)` schreibt bei einem
Zwillingsfund den **Inhalt** der Zeile um (`gate.ts:230, 240`), also aendern sich unter einer anderen
`duplicateThreshold` die `normalizeTokens` fuer Kandidat N+1 — der Rahmen braucht `content`, `tags`,
`importance` und `kind` **jedes** Nachbarn. `knownEntity` (`gate.ts:216`) wird zwei Zeilen spaeter
benutzt (`gate.ts:219`: `candidate.importance < gate.minImportance && !knownEntity`) und ist damit der
Fluchtweg fuer schwache Kandidaten — es gehoert aus einem staerkeren Grund in den Rahmen als dem
genannten, und weil `linkEntities` Entitaeten **in** der Schleife anlegt (`gate.ts:242, 259`), braucht es
die Form "existierte diese Entitaet bei Turn-Beginn". Und `similarMemories` hat **kein** `ORDER BY` bei
`LIMIT 15` (`gate.ts:298-304`): welche fuenfzehn kommen, haengt an der internen Reihenfolge.

---

## 8. Datenmodell (`SCHEMA_VERSION` 18 nach 19)

Hausstil wie in `migrate()` (`db.ts:35`): `CREATE TABLE IF NOT EXISTS`, neue Spalten hinter
`hasColumn`-Waechtern (`db.ts:30-33`), `id TEXT PRIMARY KEY` aus `randomUUID`, Zeitstempel
`INTEGER NOT NULL` in ms, Aufzaehlungen als blankes TEXT mit `-- a | b | c`-Kommentar.

### 8.1 Spuren — eine Zeile je Aufruf

```sql
CREATE TABLE IF NOT EXISTS dream_traces (
  id            TEXT PRIMARY KEY,
  turn_id       TEXT NOT NULL,            -- gruppiert die Aufrufe eines Turns
  owner         TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- turn | assignment | night
  site          TEXT NOT NULL,            -- turn | extract | tool | inspect
  pipeline      TEXT NOT NULL,            -- assistant | agent
  session_id    TEXT,
  session_kind  TEXT,                     -- chat | voice | mail | schedule (types.ts:116)
  assignment_id TEXT,
  sleep_run_id  TEXT,
  turn_index    INTEGER NOT NULL DEFAULT 0,
  policy_set    TEXT NOT NULL,            -- JSON: welche Policy-Version je Slot galt
  framed        INTEGER NOT NULL DEFAULT 0,
  holdout       INTEGER NOT NULL DEFAULT 0,
  audit         INTEGER NOT NULL DEFAULT 0,  -- eingefrorener Pruefsatz (5.5d)
  degraded      TEXT,                     -- NULL | no-tokens | fts-threw
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dream_traces_owner ON dream_traces(owner, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dream_traces_turn  ON dream_traces(turn_id);
```

Ein Assistenten-Turn ruft `recall` zweimal (`runtime.ts:460` mit Beruehrung, `runtime.ts:1119` ueber
`relevantKnown` ohne), dazu `coreProfile` und `admitCandidates`. Jeder Aufruf bekommt seine eigene Zeile
mit eigener `site`; `turn_id` haelt sie zusammen. `holdout`, `framed` und `audit` werden **sitzungsweise**
aus einem Hash abgeleitet, nicht je Spur gewuerfelt: eine Sitzung ist ganz drin oder ganz draussen (E3).

### 8.2 Rahmen — eine Zeile, kein Fan-out

```sql
CREATE TABLE IF NOT EXISTS dream_frames (
  trace_id        TEXT NOT NULL REFERENCES dream_traces(id) ON DELETE CASCADE,
  slot            TEXT NOT NULL,          -- recall
  frame_v         INTEGER NOT NULL,
  owner           TEXT NOT NULL,          -- fuer die Loeschpfade, ohne payload zu lesen
  session_id      TEXT,                   -- dito
  box             TEXT NOT NULL,          -- JSON: die Box, unter der aufgezeichnet wurde
  corpus_stamp_id TEXT NOT NULL,
  payload         TEXT NOT NULL,          -- JSON: der ganze Rahmen
  bytes           INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (trace_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_dream_frames_age   ON dream_frames(created_at);
CREATE INDEX IF NOT EXISTS idx_dream_frames_owner ON dream_frames(owner, session_id);
```

`owner` und `session_id` stehen als eigene Spalten da, weil `payload` nicht indizierbar ist und die
Loeschpfade (Abschnitt 8.7) sie brauchen. Kein `pinned`: die Begruendungspflicht erfuellt
`dream_evals.evidence_digest`, das keine Wortlaute traegt.

### 8.3 Etiketten

```sql
CREATE TABLE IF NOT EXISTS dream_labels (
  turn_id    TEXT NOT NULL,
  target     TEXT NOT NULL,          -- memory id, oder '*' fuer ein Spurgewicht (4.2d)
  source     TEXT NOT NULL,          -- correction | review | merge | user
  relevance  REAL NOT NULL,          -- 1 = belegt relevant, 0 = belegt irrelevant
  scope      TEXT NOT NULL,          -- turn | session
  evidence   TEXT,                   -- correction id / review id / route + actor
  dead_at    INTEGER,                -- Ziel nachtraeglich entfernt, Zeile bleibt
  created_at INTEGER NOT NULL,
  PRIMARY KEY (turn_id, target, source)
);
CREATE INDEX IF NOT EXISTS idx_dream_labels_target ON dream_labels(target);
```

`source` gehoert in den Schluessel, sonst ist der Etikettenabgleich durch das Schema verboten. `scope`
trennt die Turn-Etiketten von den sitzungsweiten aus Abschnitt 4.2(a); nur `scope = 'turn'` geht in DCG.
`dead_at` statt Loeschen: `undoSleepRun` entfernt Erinnerungen wirklich (`store.ts:1472-1475`), und
`routes/memories.ts:156-157` loescht auf `?hard` hart — ohne diese Spalte sinkt `reachable_rate` aus einem
Grund, der mit den Etiketten nichts zu tun hat, und die Bewertung wird aus dem falschen Grund ungueltig.
Die Etikettenhistorie ist Kalibrierungsmaterial und bleibt stehen.

Dazu eine Spalte an einer bestehenden Tabelle — ohne sie ist ein Korrekturetikett auf keinen Turn
zielbar, weil `addCorrection` nur `session_id` kennt (`store.ts:1122-1128`):

```sql
if (!hasColumn(db, 'corrections', 'turn_id'))
  ALTER TABLE corrections ADD COLUMN turn_id TEXT;
```

### 8.4 Beruehrungen — append-only, mit der Policy, die sie verursacht hat

```sql
CREATE TABLE IF NOT EXISTS memory_touches (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  memory_id  TEXT NOT NULL,
  turn_id    TEXT,
  trace_id   TEXT REFERENCES dream_traces(id) ON DELETE CASCADE,
  policy_id  TEXT,                    -- policy_versions.id, die die Beruehrung verursacht hat
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_touches_memory ON memory_touches(memory_id, at);
CREATE INDEX IF NOT EXISTS idx_memory_touches_owner  ON memory_touches(owner, at);
```

Diese Tabelle ist **kein** Etikettenspeicher (E9). Sie existiert aus einem anderen Grund: `access_count`
und `usefulness` sind heute monotone Zaehler ohne jede Historie (`store.ts:550-561`), und `usefulness`
traegt 0.3 der Stilllegungsentscheidung (`sleep.ts:684`). Eine zurueckgenommene Policy laesst ihre
Zaehlerspuren also stehen. Mit `policy_id` je Beruehrung sind beide Zaehler **grundsaetzlich**
nachrechenbar. Ob daraus wirklich neu berechnet wird, ist eine offene Frage (Abschnitt 14); die
Aufzeichnung dafuer wird jetzt angelegt, weil sie sich spaeter nicht nachholen laesst.

`owner` und der Fremdschluessel sind Pflicht: `PRAGMA foreign_keys = ON` steht (`db.ts:24`), also raeumt
die Kaskade beim Loeschen einer Spur mit; ohne `owner` liesse sich die Tabelle beim Stilllegen eines
Agenten (`store.ts:534-539`) nicht saeubern.

### 8.5 Policy-Versionen und Slot-Zustand

```sql
CREATE TABLE IF NOT EXISTS policy_versions (
  id             TEXT PRIMARY KEY,
  owner          TEXT NOT NULL,
  slot           TEXT NOT NULL,
  version        INTEGER NOT NULL,
  params         TEXT NOT NULL,      -- JSON, vollstaendiger Parametersatz
  box            TEXT NOT NULL,      -- JSON, die Box, gegen die validiert wurde
  origin         TEXT NOT NULL,      -- default | dream | user
  parent_id      TEXT,
  prev_active_id TEXT,               -- was beim Befoerdern aktiv WAR
  sleep_run_id   TEXT,
  rationale      TEXT,
  replay_score   REAL,
  replay_n       INTEGER,
  baseline_score REAL,
  audit_delta    REAL,               -- gegen die Werksvorgabe, auf dem Pruefsatz
  audit_ci_low   REAL,
  online_score   REAL,
  promoted_at    INTEGER,
  retired_at     INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_slot_version ON policy_versions(owner, slot, version);
CREATE INDEX IF NOT EXISTS idx_policy_active ON policy_versions(owner, slot, promoted_at DESC);

CREATE TABLE IF NOT EXISTS dream_slot_state (
  owner          TEXT NOT NULL,
  slot           TEXT NOT NULL,
  frozen_at      INTEGER,
  frozen_reason  TEXT,               -- calibration | staleness | agreement | manual
  cooldown_until INTEGER,
  last_promoted  INTEGER,
  PRIMARY KEY (owner, slot)
);
```

`prev_active_id` ist der Punkt, an dem Fassung 1 zu kurz griff: `undoSleepRun` (`store.ts:1425-1488`)
kann loeschen (`store.ts:1473`) oder auf NULL setzen (`store.ts:1467`) — "setz den vorigen Wert zurueck"
kennt es nicht. Der Praezedenzfall dafuer ist `snapshotSkill` (`store.ts:1271-1277`): den Vorzustand
mitschnappschussen, mit `NULL` als "gab es nicht".

### 8.6 Bewertungen

```sql
CREATE TABLE IF NOT EXISTS dream_evals (
  id               TEXT PRIMARY KEY,
  sleep_run_id     TEXT NOT NULL,
  policy_id        TEXT NOT NULL REFERENCES policy_versions(id) ON DELETE CASCADE,
  slot             TEXT NOT NULL,
  traces           INTEGER NOT NULL,   -- angeboten
  closed           INTEGER NOT NULL,   -- geschlossen und gescored
  abstained        INTEGER NOT NULL,
  abstain_reasons  TEXT NOT NULL,      -- JSON-Histogramm
  reachable_rate   REAL NOT NULL,
  label_coverage   REAL NOT NULL,
  cost_only_share  REAL NOT NULL,
  score            REAL NOT NULL,
  baseline         REAL NOT NULL,
  delta            REAL NOT NULL,
  ci_low           REAL NOT NULL,      -- Cluster-Bootstrap ueber Sitzungen, 95 Prozent
  ci_high          REAL NOT NULL,
  audit_delta      REAL,               -- gegen die Werksvorgabe, auf dem Pruefsatz
  audit_ci_low     REAL,
  delta_live       REAL,               -- Frisch-Test
  sign_agree       INTEGER,            -- 1 | 0 | NULL = unbestimmt (|delta| <= margin)
  eval_ms          INTEGER NOT NULL,
  trace_set_hash   TEXT NOT NULL,
  evidence_digest  TEXT,               -- verdichtete Begruendung, ohne Wortlaut
  promoted         INTEGER NOT NULL DEFAULT 0,
  detail           TEXT,               -- JSON: Score je Etikettenquelle, Gaming-Zaehler
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dream_evals_run ON dream_evals(sleep_run_id);
```

### 8.7 Schreibvolumen, Transaktionen, Aufbewahrung, Loeschen

**Pro gerahmtem Turn:** ein `dream_traces`-INSERT, ein `dream_frames`-INSERT, k `memory_touches`-INSERTs
(k = Zahl der gelieferten Zeilen, typisch 8 bis 12) — **alles in einer Klammer**. Ohne sie waeren das
rund vierzehn implizite Transaktionen und ebenso viele WAL-Rahmen auf der einzigen synchronen Verbindung,
mitten im Request.

Die Klammer ist `SAVEPOINT dream_rec` / `RELEASE` / `ROLLBACK TO`, nicht `BEGIN`. `store.ts` fuehrt
Transaktionen ueber rohes SQL (`this.db.exec('BEGIN')` in `store.ts:853` und `store.ts:1435`), und `exec`
nimmt beliebiges SQL — SAVEPOINT ist eine SQLite-Eigenschaft, kein Treibermerkmal. Nur ein blankes
verschachteltes `BEGIN` wirft. Damit entfaellt der handgepflegte "ich bin drin"-Waechter, der beim ersten
neuen transaktionalen Verfahren auseinanderlaeuft; SAVEPOINT ist per Konstruktion richtig.

**Groesse:** dedupliziert ueber `records` sind 40 bis 90 KB rohes JSON je `recall`-Rahmen zu erwarten
(64 Hop-1-Zeilen, Entitaetsverweise, Nachbarlisten, IDs statt Kopien). Das ist eine **Schaetzung, nicht
gemessen**, und sie haengt zusaetzlich an `|possibleSeeds|`, also an der Boxbreite (Abschnitt 3.1).
Deshalb ist die Messung eine Lieferung von Phase 1 mit hartem Tor: p95 Rahmengroesse, p95 zusaetzliche
Turn-Latenz, zusaetzliche Lesevorgaenge je Turn. Vorschlag 120 KB / 25 ms / 40 Reads, alle drei
`geraten`. Gemessen wird **vorher und nachher auf demselben Korpus**, denn ein Teil der Last ist schon da:
`memories_au` feuert bei jedem UPDATE (`db.ts:341-346`), `touchMemories` schreibt also heute pro Turn bis
zu acht FTS-Zeilenpaare (`store.ts:550-561`). Reisst ein Wert sein Budget, sinkt `frameRate`, und zwar
bevor Phase 2 beginnt.

Auch die Lesekosten waren im Vorentwurf zu optimistisch: `expand` laeuft ueber **alle** Entitaeten einer
Saat mit `mentions > 1` (`recall.ts:200-211`), nicht ueber eine. Mit 3 bis 8 Saaten und 2 bis 5 Entitaeten
je Saat sind das 6 bis 40 `memoriesForEntities`-Aufrufe — und die Buendelung ist nicht gratis
(Abschnitt 3.1).

**Zwei Aufbewahrungsuhren** statt einer:

| Was | Frist | Warum |
|---|---|---|
| `dream_frames` | `dream.frameRetainDays` (45, geraten) | gross, und nur fuer den Replay noetig |
| `dream_traces`, `dream_labels`, `dream_evals`, `memory_touches` | `dream.retainDays` (365, geraten) | klein, und sie tragen Kalibrierung und Nachvollziehbarkeit |

Der Kehrbesen laeuft in der Nacht, in Schleifen mit `LIMIT 500` und eigener Klammer je Charge — ein
unbegrenzter Sweep waere eine lange exklusive Schreibsperre auf der einzigen Verbindung, und
`PRAGMA foreign_keys = ON` (`db.ts:24`) macht aus einem Spurenloeschen ein Kaskadenloeschen im selben
Statement. Danach `PRAGMA wal_checkpoint(TRUNCATE)`.

**Die Rahmen sind ein Wortlautspeicher, und das ist der unangenehmste Satz in diesem Dokument.**
`frame.query.text` ist die woertliche Nutzeranfrage, `frame.records` sind volle Schnappschuesse samt
`content` und `evidence` — und `evidence` ist das Originalzitat des Nutzers. Abschnitt 6.2 verbietet
Wortlaut im **Prompt**; der Speicher braucht seine eigene Regel. Keiner der bestehenden Loeschpfade
erreicht ihn heute: `forgetMemory` (`store.ts:522`), `deleteMemory` (`store.ts:541`), `archiveMemories`
(`store.ts:534`), `Assistant.deleteSession` (`runtime.ts:314`). Alle vier bekommen ein Mitloeschen der
betroffenen Rahmen auf Owner- beziehungsweise Sitzungsebene — dafuer stehen die zwei Spalten in
Abschnitt 8.2. Und die Regel, die in Abschnitt 10.5 steht und hier ihren Grund hat: **Nie einen Wortlaut
laenger aufbewahren als die Erinnerung, aus der er stammt.**

Ehrlich zur Datei: die Datenbank oeffnet ohne `auto_vacuum` (`db.ts:22-25`), also mit der Vorgabe `NONE`.
Geloeschte Seiten werden wiederverwendet, die Datei schrumpft nie. `VACUUM` braucht eine exklusive Sperre
und wird deshalb **nur** ueber die CLI bei gestopptem Server angeboten, nie von der Nachtseite.

### 8.8 Zaehler am Lauf

`sleep_runs` bekommt `dream_traces_seen`, `dream_candidates`, `dream_promoted`, je
`INTEGER NOT NULL DEFAULT 0` hinter `hasColumn`. **Vier Stellen im Gleichschritt, sonst faellt der
Zaehler still weg:** `types.ts:417` (`SleepRun`), das `createSleepRun`-Literal (`store.ts:1314`), die
`columns`-Whitelist in `updateSleepRun` (`store.ts:1344-1363` — ein nicht gelisteter Schluessel wird ohne
Fehler, ohne Log und ohne Typfehler uebersprungen) und `mapSleepRun` (`store.ts:1599`).

---

## 9. Integrationspunkte

### 9.1 Kern — Abruf

| Stelle | Aenderung |
|---|---|
| `recall.ts:83` | `recall` wird `touch(scoreFrame(fetchFrame(...)))`. Keine Verhaltensaenderung; der Aequivalenztest ist die Abnahme. |
| `recall.ts:107` | `ORDER BY relevance DESC` nach `ORDER BY relevance DESC, m.id`. |
| `recall.ts:113` | Frontier `limit * 4` nach `max(limit, box.limitMax) * 4`, **nur** wenn eine Spur offen ist. |
| `recall.ts:119, 120` | `now` und `maxRelevanceClamped` in den Rahmen (nach der Klammer, nicht davor). |
| `recall.ts:131-136` | Gewichte auf Summe 1 normieren. Fuer den Amtsinhaber ist das ein Nulleingriff (0.55 + 0.2 + 0.15 + 0.1 = 1.0), fuer jeden Kandidaten schliesst es H9. |
| `recall.ts:151-152` | Saaten: `possibleSeeds` fuer den Rekorder; die Lieferung bleibt `direct.slice(0, 3)`. |
| `recall.ts:163-165` | `touchMemories` bekommt optional `traceId` und `policyId` fuer `memory_touches`. |
| `recall.ts:184-185` | `hopEntity ?? 0.45` / `hopEdge ?? 0.6`: die Literale bleiben Vorgabe, aber alle Aufrufer gehen ueber **einen** Resolver (9.4). |
| `recall.ts:280` | `, id` an das `ORDER BY` von `coreProfile`. |
| `recall.ts:289` | `score: 1` faellt: eine Profilzeile bekommt einen Score auf derselben Skala (Abschnitt 10.1, H9). **Das ist die eine bewusste Verhaltensaenderung in Phase 1** und wird als solche vorher/nachher gemessen. |
| `recall.ts:314, 365` | storefreie Zwillinge `renderFromFrame` / `groupFromFrame`, gespeist aus `frame.entities`. |
| `store.ts:879` | `ORDER BY e.mentions DESC, e.id`. |
| `store.ts:903` | `ORDER BY m.importance DESC, m.id`; neuer Aufrufmodus ohne `exclude` mit `limit + |seeds|`. |
| `store.ts` neu | `entitiesForMany(ids)` — eine Abfrage statt |R|. |

### 9.2 Kern — Belohnungssignale

* `store.ts:550-561` `touchMemories`: schreibt zusaetzlich `memory_touches` (8.4). Die Zaehlersemantik
  bleibt unveraendert.
* `sleep.ts:639` `addCorrection`: `turn_id` beim Schreiben aufloesen, indem das Zitat im Transkript
  lokalisiert wird (4.2a). Heute ist `corrections.session_id` die wiedergespielte Sitzung und
  `created_at` das `Date.now()` der Nacht (`store.ts:1122-1128`), und die Belegpruefung laeuft gegen den
  zusammengeklebten Nutzertext der ganzen Sitzung (`sleep.ts:638`, `said` aus `sleep.ts:579`). Ist das
  Zitat nicht eindeutig lokalisierbar: `NULL` und ein ausdruecklich sitzungsweites Etikett.
* `org/store.ts:1084` `upsertReview`: der einzige Trichter aller Bewertungsquellen; ein Etikettenschreiber
  hier faengt alle, ohne vier Aufrufstellen anzufassen.
* `routes/memories.ts:130-150, 152-163`: Nutzerbearbeitung, -anheftung, -vergessen, dazu der Akteur-
  Parameter (4.2b). Heute schreiben diese Routen nichts ausser der Erinnerungszeile.

### 9.3 Der Policy-Resolver — eine Wahrheit statt zwei

Heute liegen die Parameter, die das Konzept "Slot" nennt, in drei Heimaten: `gate` liest `config.gate`
(`gate.ts:180`); `recall`s Hop-Gewichte kommen aus `config.memory.graph` **nur, wenn ein Aufrufer sie
uebergibt** (`recall.ts:184-185`); `WEIGHTS` und `RECENCY_HALF_LIFE_MS` (`recall.ts:28-29`) sind
Modulkonstanten ohne jeden Einspeisepunkt. Das erzeugt heute schon zwei effektive Policies fuer eine
Funktion: `runtime.ts:465-466` uebergibt die Hop-Gewichte, `org/controller.ts:2458-2463` nicht — gleiche
Werte, also unsichtbar, bis eine Befoerderung `config` aendert und der Agentenpfad still auf den
Literalen bleibt.

Phase 1 fuehrt deshalb **vor** allem anderen `resolvePolicy(store, config, owner, 'recall')` ein.
`recall`, `scoreFrame` und der Replay lesen denselben Typ, mit `origin: 'default'` aus den Literalen,
solange keine befoerderte Version existiert.

Hier sitzt auch die Kollision mit der Oberflaeche: `recallLimit` und `recallThreshold` sind heute
Nutzer-Einstellungen (`SettingsPage.tsx:1473, 1484`, durchgelassen von `schemas.ts:284-285`) und liegen
gleichzeitig in der Policy-Box. Config-Werte tragen keine Herkunft. Regel: `resolvePolicy` behandelt einen
Config-Wert als `origin: 'user'`, sobald er vom Vorgabewert abweicht; ein PATCH auf `memory.recallLimit`
oder `memory.recallThreshold` setzt `retired_at` auf der aktiven `recall`-Version; und beide Regler
bekommen den Hinweis "vom Traum gesetzt, weicht vom Vorgabewert ab". Sonst luegen entweder die Regler oder
die Befoerderung.

Zur Hausregel "die Datei ist die versionierte Wahrheit": die Konstanten bleiben stehen und ihre Kommentare
beschreiben weiterhin die **Vorgabe**. Eine befoerderte Version ist Daten mit `rationale`, sichtbar
beschriftet. Damit widerspricht keine Befoerderung einem Kommentar; sie steht daneben.

### 9.4 Nacht

* **Der modellfreie Teil laeuft vor der Zyklusschleife**, zwischen der Budgetmessung (`sleep.ts:279-294`)
  und `for (let cycle = 1; ...)` (`sleep.ts:296`), also **ueber** dem Waechter
  `if (!provider || !budgets) continue;` (`sleep.ts:311`). Dort liegen Gitterprobe, Bewertung und
  Frisch-Test; sie laufen auch in einer Nacht ohne Provider — genau der Nacht, in der sie das einzige
  sind, was laufen kann. Eigene Wanduhr-Obergrenze `dream.maxEvalMs`, gezaehlt und berichtet wie
  `modelCalls`.
* **Der Kandidatenschreiber** liegt im letzten Zyklus, nach `counters.modelCalls += insight.calls;`
  (`sleep.ts:373`) und vor dem Kommentarblock zu `#revise` (`sleep.ts:375-378`). Die Reihenfolge ist
  Absicht: erst soll feststehen, wie gut die Suchsteuerung arbeitet, dann wird an Prozeduren geschrieben.
* **Erste Zeile der Methode muss `if (budget <= 0 || signal.aborted) return {...}` sein** — zwischen
  `sleep.ts:344` und `sleep.ts:402` gibt es kein `#throwIfAborted`.
* `sleep.ts:1899` `NightDemand` und `sleep.ts:1918` `NightCeilings` (zwei Interfaces, die von Hand
  mitwachsen muessen), dazu `sleep.ts:1952` das `keys`-Tupel und `sleep.ts:1963-1964` `volume`/
  `judgement` — siehe H4 in Abschnitt 10.1.
* `sleep.ts:448-476` `#demand`: die Traum-Sonde (etikettierte Spuren seit der letzten Befoerderung, je
  aktivem Slot) kommt daneben. **Aber:** der Doc-Kommentar bei `sleep.ts:438-446` behauptet, `#demand`
  koste nichts; er ruft heute schon `#cluster` (`sleep.ts:452`), das ueber alle lebenden Erinnerungen
  paarweise laeuft (`sleep.ts:733-745`) und je Erinnerung `entitiesFor` abfragt (`sleep.ts:731`).
  Entweder ist die Sonde ein reiner Index-`COUNT(*)`, oder der Kommentar wird korrigiert.
* `types.ts:411` `SleepStage` um `'dream'` erweitern, sonst Compilefehler in `#phase` (`sleep.ts:1555`).
* `sleep.ts:1835-1875` `describeSleep`: eine `if (counters.x) parts.push(...)`-Klausel vor dem `return`.
* `sleep.ts:163-186` `undo()`: Rueckgabetyp und Logzeile erweitern; die eigentliche Ruecknahme gehoert
  **in** die Transaktion (10.4), nicht hierher.
* **Stufe 1 bis 4 laufen ausschliesslich auf `ASSISTANT_MEMORY_OWNER`, auch der Rekorder.** Mit der
  Vorgabe `sleep.scope: 'assistant'` (`config.ts:64`) schlaeft ohnehin nur ein Owner
  (`sleep.ts:131-147`, `runtime.ts:941-942`); Agentenrahmen waeren reine Kosten ohne eine Nacht, die sie
  bewertet. Und bei `scope: 'all'` laeuft die Nacht je Owner sequenziell (`runtime.ts:945-949`), die
  Kandidatenaufrufe multiplizierten sich also mit der Owner-Zahl. Deshalb zusaetzlich eine laufglobale
  Deckelung `dream.maxCallsPerNight` ueber **alle** Owner, nicht nur `maxPromotionsPerNight`.

### 9.5 Konfiguration: jeder Schluessel mit seinem Leser

Unter `memory.dream`, neben `memory.sleep` (`config.ts:59`). Ein Schluessel ohne Leser kommt nicht in die
Konfiguration.

| Schluessel | Vorgabe | Wer liest ihn |
|---|---|---|
| `enabled` | `false` | der Einstiegspunkt in `sleep.ts`, vor allem anderen |
| `record` | `false` | der Rekorder an den `site = 'turn'`-Aufrufstellen (`runtime.ts:460`, `org/controller.ts:2458`) |
| `promote` | `false` | das Befoerderungstor (10.2) — hat einen Leser erst ab Phase 3; bis dahin bleibt der Schluessel aus der Konfiguration (kein Schluessel ohne Leser, E20) |
| `slots` | `['recall']` | Kandidatenschleife und Slot-Zustand |
| `frameRate` | 0.25, geraten | die sitzungsweise Ableitung von `dream_traces.framed` |
| `candidates` | 6, geraten | der Kandidatenschreiber (6.2) |
| `model` | `sonnet`, geraten | derselbe |
| `maxCallsPerNight` | 6, geraten | die laufglobale Deckelung (9.4) |
| `maxEvalMs` | 20000, geraten | die modellfreie Bewertung (6.1) |
| `minTraces` | 200, geraten | Gueltigkeitsregel 3 (5.4) |
| `margin` | 0.02, geraten | Befoerderungsbedingung 2 |
| `costWeight` | 0.05, geraten | der Schaetzer (5.2) |
| `corpusTolerance` | 0.25, geraten | der Korpusstempel (3.3) |
| `coverageFloor` / `costOnlyCeiling` | 0.3 / 0.5, geraten | Abdeckung (4.4) |
| `abstainEps` / `abstainFloor` | 0.05 / 0.30, geraten | Gueltigkeitsregel 2 |
| `reachableFloor` | 0.5, geraten | Gueltigkeitsregel 4 |
| `correctionPrecisionFloor` | 0.6, geraten | die Etikettenquelle `correction` (4.2a) |
| `labelModelCalls` | 0 | dieselbe, als Ausweg |
| `userLabelWindow` | 7 Tage, geraten | die Etikettenquelle `user` (4.2b) |
| `agreementFloor` | 0.4, geraten | der Etikettenabgleich (5.5b) |
| `calibrationTraces` / `tolerance` | 50 / 0.05, geraten | der Wach-Test (5.5c) |
| `cooldownNights` | 7, geraten | Befoerderungsbedingung 6 |
| `maxPromotionsPerNight` | 1 | Befoerderungsbedingung 8 |
| `explorationRate` | 0 | Erkundung (E17) |
| `frameRetainDays` / `retainDays` | 45 / 365, geraten | der Kehrbesen (8.7) |
| `trialEpisodes` | 0 | Stufe 2 (Abschnitt 11, Phase 6) |

**Die tragende Zeile bei der Anbindung:** `dream: dreamConfigSchema` muss **innerhalb**
`memoryConfigSchema` stehen (`schemas.ts:281-291`). Ohne sie wird jeder `memory.dream`-PATCH still
verworfen und mit 200 beantwortet. Der Beweis, dass das schon heute beisst: `memory.gate` und
`memory.graph` stehen dort nicht (`schemas.ts:281-291`, obwohl beide in `MemoryConfig` existieren,
`types.ts:1209-1212`), `memory.gate.maxPerTurn` ist also ueber HTTP nicht aenderbar und scheitert
lautlos.

Ausserdem: `rookery config set` umgeht Zod vollstaendig (`cli/commands/config.ts:61-80`) und prueft nur,
dass der gepunktete Schluessel existiert (`cli/commands/config.ts:68`). `memory.dream.margin -5` wird
akzeptiert und geschrieben. Deshalb E21: geklemmt wird beim **Lesen**.

### 9.6 Server und Web

* Neue Datei `server/src/routes/dream.ts`, registriert **vor** der statischen Rueckfallroute, sonst
  liefert die SPA `index.html` statt JSON; literale Pfade vor parametrisierten Geschwistern, wie es
  `routes/memories.ts:22-27` vormacht. Querystrings werden nirgends schemavalidiert und werden von Hand
  geklemmt.
* Routen: `GET /api/dream/policies`, `GET /api/dream/policies/:slot/history`,
  `POST /api/dream/policies/:id/promote`, `POST /api/dream/policies/:id/revert`, `GET /api/dream/evals`,
  `GET /api/dream/traces`, `POST /api/dream/run`.
* **Keine neue Route und kein vierter Tab** unter `/memory`: `web/test/page-navigation.test.mjs:20`
  behauptet genau drei Kinder, und der Test ist aus einem anderen Grund bereits rot (er importiert
  `routeMeta`, `page-navigation.test.mjs:15`) — ein Bruch saehe vorbestehend aus und verdeckte eine echte
  Regression. Der Traum ist ein Abschnitt der Naechte-Seite.
* `MemorySleepPage.tsx:101-116` `undoable()` muss die Traumzaehler in die ODER-Kette bekommen, sonst
  blendet die Oberflaeche den Undo-Knopf genau fuer die Naechte aus, die laut E18 umkehrbar bleiben
  muessen.
* `MemoryLayout.tsx:107` `SLEEP_PHASES` um `'dream'` erweitern — und im selben Zug um `'replay'`, das dort
  heute schon fehlt, obwohl `SleepStage` es kennt (`types.ts:411`). Dazu ein Test "jede `SleepStage` kommt
  in `SLEEP_PHASES` vor".
* Die Versionskurve ist eine **neue** Komponente auf `ChartContainer`; die bestehende Trendkarte filtert
  gegen ein Kalenderfenster relativ zu `Date.now()` und stapelt Serien — versionsindizierte 0..1-Werte
  ergaeben dort eine leere Karte, keinen Fehler.
* Eine Befoerderung ist heute unsichtbar, obwohl sie das Verhalten des Assistenten aendert. Sie schreibt
  deshalb eine Mail an den Nutzer — die Hausregel fuer "das zaehlt" — mit `rationale`, `delta`, `ci_low`
  und dem Revert-Link, und `describeSleep` nennt sie in der Zeile, die im Cron-Bericht landet
  (`runtime.ts:947`).
* Die Traumknoepfe gehoeren **nicht** auf die Einstellungsseite: `SettingsPage.tsx:130-133` haelt
  schriftlich fest, dass `memory.gate`, `memory.graph` und `memory.sleep` dort nicht hingehoeren, weil die
  Seite "keine ehrlichen Beschriftungen fuer Zahlen hat, deren Wirkung nur im Nachtlauf sichtbar ist".
  Dasselbe Argument gilt hier.

### 9.7 Vorgezogene Fremdarbeiten

Drei Dinge, die der Traum braucht, aber nicht besitzt. Sie gehoeren in eigene Commits, vor Phase 1:

1. **`PRAGMA busy_timeout = 5000` in `openDatabase`** (`db.ts:22-25` setzt heute nur `journal_mode`,
   `foreign_keys`, `synchronous`). Die CLI oeffnet dieselbe Datei in einem eigenen Prozess, es gibt real
   zwei Schreiber. Heute harmlos, weil es genau zwei kurze Transaktionen gibt (`store.ts:853`,
   `store.ts:1435`); der Traum fuegt eine Klammer je gerahmtem Turn und einen naechtlichen Sweep hinzu.
2. **`meta.schema_version` beim Oeffnen lesen und bei hoeherem Wert abbrechen.** Der Wert wird
   geschrieben (`db.ts:718-721`) und im ganzen Repo nirgends gelesen. Eine Datenbank, die einmal von einer
   v19-Binaerdatei geoeffnet wurde, oeffnet danach klaglos unter v18 weiter — und v18 schreibt in
   `memories`, waehrend `dream_frames` Rahmen aus einer anderen Welt haelt.
3. **`SLEEP_PHASES` um `'replay'` ergaenzen** (`MemoryLayout.tsx:107`). Der Fortschrittsbalken springt
   heute auf 0 Prozent, sobald die Replay-Phase sich meldet.

---

## 10. Sicherheit, Befoerderung, Ruecknahme

### 10.1 Zulassungspruefung **vor** der Bewertung

Jeder Weg, das Mass zu spielen, bekommt einen Praedikattest, der laeuft, **bevor** der Kandidat eine Zahl
bekommt. Der Grund ist strukturell: all diese Wege liegen innerhalb der Sandbox und innerhalb der Verbote
— es sind legale Parameterwerte. Gegen einen legalen, entarteten Kandidaten hilft kein Vergleich, weil
seine Zahl wirklich hoeher sein kann (E15).

| # | Weg | Mechanismus |
|---|---|---|
| H1 | **Nichts abrufen und gewinnen.** `coreProfile` waehlt auf `importance >= ? OR pinned = 1` (`recall.ts:279`); genau diese Zeilen sind die meistetikettierten. Ein Kandidat, der `threshold` hochzieht, bis `direct` leer ist (`recall.ts:146`), liefert nur Profilzeilen. | Deckungsuntergrenze **relativ zum Amtsinhaber**: `coverage(cand) >= 0.5 * coverage(base)`. Die Regel heisst "verliere keine Deckung", nicht "erreiche X". |
| H2 | **`usage`-Sperrklinke.** `usage` traegt 0.1 des Scores (`recall.ts:28, 127`), und `access_count` ist post-treatment zum Amtsinhaber. | `accessCount` ist im Rahmen **eingefroren**; `usefulness` ist keine Etikettenquelle mehr (E9). Damit ist der Kanal geschlossen, nicht nur verschoben. |
| H3 | **Das Tor belebt, was die Nacht stillgelegt hat.** Der Verstaerkungszweig von `upsertMemory` setzt `dormant_at = NULL, superseded_by = NULL` (`store.ts:303-305`). | Wiederbelebungen als expliziter Kostenposten; Ablehnung, wenn die Rate ueber der des Amtsinhabers liegt. Betrifft erst den `gate`-Slot, wird aber schon jetzt gezaehlt. |
| H4 | **Budgetkaperung.** `allocateNightBudget`s `keys` ist ein hartes Literal (`sleep.ts:1952`), und der Ueberlaufsplit ruft `distribute` nur auf `volume` oder `judgement` (`sleep.ts:1963-1974`). Ein Schluessel in `keys`, aber in keiner der beiden Unterlisten, behaelt seine ungekappte Zuteilung, waehrend die Volumenphasen gequetscht werden. Und ein Bedarfsschluessel, der in `keys` **fehlt**, erreicht `funded` nie (`sleep.ts:1954-1956`) — `budgets.x` ist `undefined`, und `undefined <= 0` ist `false`, der Phasenwaechter laesst sie durch und sie laeuft **unbudgetiert**. *(Korrektur gegenueber dem Vorentwurf: `sumOf(keys)` (`sleep.ts:1958-1961`) summiert ausschliesslich ueber `funded` und sieht einen fehlenden Schluessel folglich **nicht**. Die Schlussfolgerung bleibt, die Begruendung war falsch.)* | `const keys = [...volume, ...judgement] as const;` — damit ist die Fehlerklasse unkonstruierbar. Dazu ein Test, dass `Object.keys(demand)` eines kanonischen `NightDemand` gleich `new Set(keys)` ist. Ein Eigenschaftstest ueber zufaellige Bedarfe kann den Fehler nicht finden: er ist auf Quellebene, nicht auf Werteebene. |
| H5 | **Leckage durch den Prompt** | Konstruktionstest statt Teilzeichenkettentest (6.2, E13). |
| H6 | **Wiederholtes Testen** | `trace_set_hash`-Disjunktheit plus `cooldownNights`. Test: zwei Naechte ohne neue etikettierte Spuren ergeben in der zweiten null Befoerderungen, egal wie gut der Kandidat ist. |
| H7 | **Den Etikettierer optimieren.** Eine Abruf-Policy aendert, was der Assistent wusste, was aendert, was der Nutzer korrigiert, was die Etiketten aendert. | **Nicht schliessbar** (Abschnitt 12). Offengelegt statt wegdefiniert: `detail` traegt den Score je Etikettenquelle, `user`-Etiketten werden getrennt ausgewiesen, und ein Delta, das nur auf den beeinflussbaren Quellen positiv ist, wird abgelehnt. |
| H8 | **Kostenterm spielen** | Summe mit Untergrenze, nie Verhaeltnis; Test auf fehlende Skaleninvarianz. |
| H9 | **Reine Skalierung der Gewichte.** Alle vier Gewichte mit einer Konstanten zu multiplizieren laesst die relative Ordnung der abgerufenen Zeilen unveraendert, hebt sie aber ueber den festen Profilscore von 1 (`recall.ts:289`) und laesst bei niedriger Schwelle strikt mehr Zeilen durch (`recall.ts:146`). Ein freier Tausch von `chars` gegen `nDCG` ohne jeden Informationsgehalt. | Ein Kandidat, dessen Gewichtsvektor ein positives skalares Vielfaches des Amtsinhabervektors ist, wird abgelehnt. Zusaetzlich: Gewichte werden in `scoreFrame` auf Summe 1 normiert, und `coreProfile` bekommt einen Score auf derselben Skala statt des Literals 1. |

Der Falsifikationstest der ganzen Suite: jeder dieser Wege muss unter dem **naiven** Mass aus Fassung 1
eine *hoehere* Zahl erzeugen und unter diesem Mass eine *Ablehnung*. Laesst sich ein Weg nicht hoeher
scoren, ist er keine echte Gefahr und der Mechanismus wird geloescht, nicht aus Symmetrie behalten.

### 10.2 Befoerderungsbedingungen

Alle muessen halten:

1. Bewertung **gueltig** (5.4: Schnittmenge, Enthaltungsquote, `n_closed >= minTraces`,
   `reachable_rate`, `label_coverage`, `cost_only_share`).
2. **Kumulativ, zwei Vergleiche, nicht einer:**
   a) `delta > dream.margin` **und** `ci_low > 0` gegen den Amtsinhaber, auf der Rueckhaltemenge;
   b) `audit_ci_low > 0` gegen den **Werksvorgabe-Parametersatz**, auf dem eingefrorenen Pruefsatz
   (5.5d). Der Pruefsatz wird je Befoerderung genau einmal angefasst. Ohne (b) ist eine Kette von je
   einzeln signifikanten Schritten eine Irrfahrt mit Sperrklinke.
3. Genau **ein** Kandidat wurde auf der Rueckhaltemenge geprueft; die Selektion lief auf dem Training.
4. Frisch-Test: `sign_agree = 1`, oder `|delta_frozen| <= margin` (dann greift ohnehin Bedingung 2a
   nicht).
5. Etikettenabgleich ueber `agreementFloor`; Delta nicht ausschliesslich auf beeinflussbaren Quellen
   positiv.
6. Zulassungspruefung (10.1) ohne Befund; `trace_set_hash` disjunkt zur letzten Befoerderung des Slots;
   `cooldown_until` abgelaufen.
7. Slot nicht eingefroren; kein `origin = 'user'`-Feld wuerde ueberschrieben (9.3).
8. Hoechstens `dream.maxPromotionsPerNight` ueber alle Slots; `dream.promote` ist an.
9. In dieser Nacht lief fuer diesen Slot keine kostenpflichtige Erkundung.

### 10.3 Einfrieren

`dream_slot_state.frozen_reason` kennt vier Ursachen: `calibration` (Wach-Test ueber `tolerance`),
`staleness` (Frisch-Test, Vorzeichen uneinig), `agreement` (Etikettenabgleich unter der Untergrenze),
`manual`. Ein eingefrorener Slot befoerdert nicht mehr, misst aber weiter — und erscheint als
Handlungspunkt in der Oberflaeche, wie ein Widerspruch.

### 10.4 Ruecknahme — und was sie nicht erreicht

Die Ruecknahmestatements gehoeren **in** die Transaktion von `undoSleepRun`, nach
`DELETE FROM memory_edges WHERE run_id = ?` (`store.ts:1476`) und **vor** dem `undone_at`-Stempel
(`store.ts:1478-1480`): die `policy_versions` dieser `sleep_run_id` demotieren, die `dream_evals` der
Nacht loeschen, `prev_active_id` wieder aktivieren. Alles ausserhalb dieses Blocks ist nicht Teil des
Nacht-Undo.

Fuenf Dinge, die dabei schiefgehen:

* `counts` (`store.ts:1429`) und der Rueckgabetyp (`store.ts:1425`) muessen um `policies` wachsen, und das
  propagiert nach `sleep.ts:163-186` und in jede Route, die das Ergebnis rendert.
* Die Klausel `created_at >= run.startedAt` (`store.ts:1452`) wiederholt einen echten Bugfix: eine Zeile,
  die die Lauf-ID traegt und den Lauf vordatiert, wurde wiederbelebt, nicht erzeugt. Jede neue Tabelle mit
  `sleep_run_id` braucht dieselbe Unterscheidung zwischen "geschrieben von" und "beruehrt von".
* `undoSleepRun` gibt `null` zurueck und tut nichts, wenn `undoneAt` bereits gesetzt ist
  (`store.ts:1427`). Undo ist einmalig je Lauf; eine spaetere Ruecknahme laeuft ueber
  `POST /api/dream/policies/:id/revert` und `prev_active_id`.
* Ein Wurf in der Traumphase wird genau einmal gefangen (`sleep.ts:406-408`) und ueberspringt **alles**
  danach, einschliesslich `recountEntities` (`sleep.ts:405`). Und der Catch kann Absturz nicht von
  Abbruch unterscheiden.
* `failStaleSleepRuns` (`store.ts:1400-1408`) kippt beim Start **jeden** laufenden Lauf auf `failed`, ohne
  Owner- oder PID-Filter. Traum-Buchfuehrung, die an "dem laufenden Lauf" haengt, ist nach einem Neustart
  still verwaist.

**Und die Grenze, die bleibt:** eine Ruecknahme stellt **Parameter** wieder her, keine **Zaehler**.
`touchMemories` ist ein monotones `access_count + 1` und `usefulness = MIN(1.0, usefulness + 0.03)` ohne
jede Historie (`store.ts:550-561`), und `usefulness` traegt 0.3 der Stilllegungsentscheidung
(`sleep.ts:684`). Eine schlechte Abruf-Policy hebt also dauerhaft `usefulness` auf den falschen Zeilen,
schuetzt sie damit dauerhaft vor `#decay` und drueckt die Zeilen, die sie nicht mehr geholt hat — und
kein Revert erreicht das. Deshalb faellt der Satz "nie unumkehrbar" ersatzlos und heisst stattdessen
**umkehrbar in Parametern, nicht in Zaehlern** (E11). `memory_touches` (8.4) legt die Aufzeichnung an, aus
der eine echte Neuberechnung moeglich waere; ob sie kommt, ist offene Frage 3.

### 10.5 Was der Traum niemals tut

* **Nie ausserhalb der Slots schreiben.** Kein Dateizugriff, kein Prompt, keine Modellwahl, kein Budget.
* **Nie ohne Rueckhaltemenge befoerdern**, und nie ohne den eingefrorenen Pruefsatz.
* **Nie mehr als eine Befoerderung pro Nacht.**
* **Nie ueber Besitzergrenzen lesen.** Owner-Filterung ist zweimal noetig, in SQL und in JS
  (`recall.ts:190-194`, `store.ts:901`), weil `memory_entity_links` keine
  Owner-Spalte hat und `edgesFrom` (`store.ts:976-983`) die vorhandene
  `memory_edges.owner`-Spalte nicht filtert. Jeder neue Lesepfad wiederholt beides.
* **Nie etwas anfassen, das der Nutzer gesetzt hat.**
* **Nie beruehren.** Jeder Lesezugriff des Traums hat `touch: false` fest verdrahtet, mit Test
  (`recall.ts:163` ist die Vorgabe, die dabei nie greifen darf).
* **Nie einen degradierten Pfad in einen Fehler verwandeln.** `recall.ts:114-117` und `gate.ts:307-309`
  verschlucken ein fehlerhaftes MATCH mit einem Kommentar, der sagt, der Turn duerfe nicht brechen. Der
  Rekorder haelt sich daran und markiert `degraded`, statt zu werfen.
* **Nie im Turn ueber MCP erreichbar.** Der Assistent bekommt kein Werkzeug; seine eigene Suchsteuerung
  aendert der Lauf, mit Protokoll und Rueckhaltemenge.
* **Nie einen Wortlaut laenger aufbewahren als die Erinnerung, aus der er stammt** (8.7).

---

## 11. Umsetzung in Phasen

**Phase 0 — Zufluss messen.** Wie viele etikettierbare Spuren entstehen pro Nacht, je Quelle
(Abschnitt 4.5)? Reine Abfrage ueber den Bestand. Ohne diese Zahl sind `minTraces`, `calibrationTraces`
und `cooldownNights` Zeremonie.

**Phase 1 — Rahmen und Grundlinie. Null Modellaufrufe, null Befoerderungen, kein Kandidatenschreiber.**
Inhalt: der `fetchFrame`/`scoreFrame`-Schnitt; die vier Gleichstandsbrecher; `entitiesForMany`;
`resolvePolicy`; Schema 21 mit `dream_traces`, `dream_frames`, `memory_touches`, `dream_labels` und den
drei `sleep_runs`-Spalten; der gesampelte Rekorder auf `site = 'turn'` in einer SAVEPOINT-Klammer; der
Korpusstempel; das Mass aus 5.2; die Gitterprobe; der Frisch-Test; das Groessen- und Latenzprotokoll mit
dem Budgettor aus 8.7. Dazu die drei vorgezogenen Fremdarbeiten (9.7).

Ergebnis, das fuer sich steht: (i) zum ersten Mal eine Zahl fuer die Abrufguete, mit Intervall und mit
dem Wort "untere Schranke" daneben; (ii) ein Selbsttest, der sagt, ob die Zahl ueberhaupt etwas bedeutet;
(iii) eine Aequivalenz-Testsuite fuer `recall`, die es heute nicht gibt und die den heissesten Lesepfad
des Projekts gegen Regressionen absichert; (iv) vier behobene Nichtdeterminiertheiten im Live-Pfad. Wer
hier aufhoert, hat trotzdem gewonnen.

Tests in `packages/core/test/dream-frame.test.js`, im Stil der bestehenden `memory.test.js` und
`sleep.test.js` (node:test, `setup.mjs`) — mit **eingefrorenem `Date.now()`**, weil `recency`
(`recall.ts:126`) sonst zwischen Live- und Replaylauf driftet; ein Muster dafuer gibt es im Repo noch
nicht:

* **Aequivalenz, je Pipeline:** fuer 200 zufaellige `(query, limit 4..16, threshold, hopEntity, hopEdge)`
  gilt `recall(store, o)` deep-equal `scoreFrame(fetchFrame(store, {...o, limit: 16}), o)`, Element fuer
  Element inklusive `score`, `hop`, `reason`. Jeder ungeschlossene Lesezugriff faellt hier sofort durch.
* **Saatschliessung:** die tatsaechlich benutzten Saat-IDs sind Teilmenge von `frame.possibleSeeds`.
* **Renderer-Gleichheit:** `renderFromFrame` ist zeichengleich zu `renderMemoryBlock` (`recall.ts:314`),
  mit und ohne Gruppierung.
* **Blockmass schlaegt Rueckgabewertmass:** Bank mit relevanter kurzer Erinnerung A und irrelevanter
  1800-Zeichen-Erinnerung B; ein Kandidat, der B ueber A stellt, ist auf `recall`s Rueckgabewert
  gleichauf und auf dem Block strikt schlechter. Faellt das durch, war das Mass aus Fassung 1 ausreichend
  und dieser Teil des Konzepts ist widerlegt.
* **Kein Schreibzugriff:** ein Replaydurchgang aendert `access_count`/`usefulness` an keiner Zeile.
* **Transaktionssicherheit:** der Rekorder laeuft aus einem offenen `BEGIN` heraus per SAVEPOINT durch,
  ohne den umgebenden Pfad zu brechen.
* **Profilschliessung:** ein bei `limitMax = 16` aufgezeichneter Rahmen reproduziert die Profilzeilen fuer
  jedes `limit` von 4 bis 16.

**Phase 2 — Etiketten und ihr Abgleich.** `corrections.turn_id` mit Zitatlokalisierung, Nutzeretiketten
aus `routes/memories.ts` samt Akteur-Parameter und der Rueckmeldung an der Chat-Hervorhebung,
Verdichtungsetiketten ueber `supersedes` (hoechstens ein Sprung), `dream_labels` mit Quellschluessel,
Kappa je Slot, `reachable_rate`, `label_coverage`. Ergebnis: die offene Frage 1 aus Fassung 1 wird von
einer Handpruefung zu einer stehenden, blockierenden Zahl. Tests: Korrektur landet auf dem richtigen
Turn; ein zweimal vorkommendes Zitat ergibt `NULL` und ein sitzungsweites Etikett, keine Rateentscheidung;
ein Etikett auf eine Zeile, die zum Turnzeitpunkt noch nicht existierte, wird nie geschrieben; das Tor
lehnt bei Uneinigkeit der Quellen ab, nicht bei Delta.

**Phase 3 — Traum fuer `recall`.** Kandidatenschreiber mit eigenem Aufrufer, Zulassungspruefung,
Selektion auf Training, eine Rueckhaltpruefung, der Pruefsatz, `policy_versions`, `dream_slot_state`,
Befoerderungstor, Ruecknahme in der Transaktion, die `dream`-Stufe in `SleepStage`/`SLEEP_PHASES`. Tests:
Amtsinhaber ist immer Kandidat; ohne `ci_low > 0` **und** `audit_ci_low > 0` keine Befoerderung;
`origin = 'user'` wird nie ueberschrieben; hoechstens eine Befoerderung; Ruecknahme stellt
`prev_active_id` wieder her; ein Boxverstoss ist ein Erzeugungsfehler, keine Enthaltung; ein Kandidat, der
ein skalares Vielfaches ist, wird abgelehnt.

**Phase 4 — Sichtbarkeit und Wach-Test.** Traumabschnitt auf der Naechte-Seite, Versionskurve, Diff-Blatt
je Befoerderung, `undoable()`-Kette, Mail an den Nutzer, Zaehler in Tabelle und Bericht, Kalibrierung mit
Einfrieren. Test: die Kurve rendert mit leerem Pool; eine Nacht, deren einzige Wirkung eine Befoerderung
war, bietet Undo an.

**Phase 5 — Breite.** `budget` mit dem `allocateNightBudget`-Invariantentest und beobachteten
Ertragsraten; `retry` einseitig. Test: Budget-Replay extrapoliert nie ueber beobachtete Raten hinaus;
`sum(allocate(...)) <= cap` ueber Zufallsbedarfe — als Ergaenzung zum Quelltest aus H4, nicht als Ersatz.

**Phase 6 — Stufe 2, Divergenzprobe (optional, standardmaessig aus).**
*Vorbedingung, sonst gar nicht:* der Rekorder ist heute verlustbehaftet. `summariseInput`
(`providers/claude-code.ts:416-423`) waehlt **eines** von `file_path | command | pattern | query | path`
und kuerzt auf 120 Zeichen; nur wenn keines davon eine Zeichenkette ist, faellt es auf das volle JSON bis
4000 Zeichen zurueck. Ein `Edit(file_path, old_string, new_string)` wird also als Pfad allein
aufgezeichnet. Das `end`-Ereignis traegt ausserdem den Literalnamen `'tool'`
(`providers/claude-code.ts:340`). Man kann keine Divergenz auf Argumenten erkennen, die man nie
aufgezeichnet hat. Fix: `argsHash = sha256(canonicalJson(input))` plus vollstaendiges Input-JSON bis zu
einer Grenze, und der echte Name auf dem `end`-Ereignis.

Danach ist eine aufgezeichnete Trajektorie ein praefixgeschlossener Simulator, bewertet per
**Erst-Divergenz-Bewertung** (7.2): bei Schritt k bekommt die Kandidaten-Policy das aufgezeichnete Praefix
plus ihren Skilltext und nennt nur Schritt k. Stimmt `(tool_name, args_hash)` ueberein, wird die
aufgezeichnete Beobachtung serviert; stimmt sie nicht, wird die Entscheidung bei k noch bewertet und
danach ist Schluss. **Beobachtungen sind auf `(step, args_hash)` geschluesselt** — eine abweichende
Aktion kann strukturell keine nachschlagen, was die klassische Off-Policy-Erfindung unmoeglich macht.
Vier zulaessige Urteile: `k = n` ist **no-change** (der billigste und wertvollste Fall); `k < n` und die
Episode scheiterte ist **may-avoid-failure, unverifiziert** und zaehlt fuer nichts; `k < n` und die
Episode war erfolgreich ist **regression-risk bei k**; nach k wird nichts behauptet.

Ehrliche Vorbehalte: die Schritt-k-Abfrage ist eine andere Promptform als ein echter Turn,
Divergenzerkennung ist also ein **Stellvertreter fuer** Divergenz. Die Validierung dafuer ist ein Tor:
fuer eine Stichprobe frei laufen lassen und pruefen, ob der erste abweichende Schritt mit k
uebereinstimmt. Faellt das durch, ist Phase 6 tot, und der einzige ehrliche Weg zurueck ist der
vollstaendige Doppellauf aus Fassung 1 §9.

---

## 12. Was dieses Dokument nicht beweisen kann

Vier Dinge. Keines davon ist durch mehr Sorgfalt an der Mechanik zu schliessen, und keines darf im
Bericht verschwiegen werden.

**1. Missing-Label-Bias.** Eine Erinnerung bekommt nur ueber Kanaele ein Etikett, die voraussetzen, dass
der Amtsinhaber sie hochgespuelt hat — mit der einen Ausnahme aus 4.2(a), Fall zwei, deren Trefferquote
noch niemand gemessen hat. Ein Kandidat, der eine andere, tatsaechlich bessere Erinnerung holt, bekommt
dafuer `gain = 0`. Das rahmenrelative Ideal korrigiert das nicht, weil es aus derselben etikettierten
Menge gebildet wird. Konsequenz: der Schaetzer ist eine **untere Schranke** (E8). Er kann belegen, dass
ein Kandidat besser ist; er kann nicht belegen, dass einer schlechter ist. Berichtet wird das ueber
`label_coverage` und `cost_only_share` (4.4), und ein Delta, das ueberwiegend aus unetikettierten
Positionen stammt, ist ungueltig. Das ist Schadensbegrenzung, kein Beweis.

**2. H7: der Etikettierer liegt stromabwaerts der gemessenen Sache.** Eine Abruf-Policy aendert, was der
Assistent wusste; das aendert, was er antwortete; das aendert, was der Nutzer korrigierte; das aendert
die Etiketten. Die Trainingsverteilung des Masses liegt hinter der gemessenen Sache. Es gibt keine
Konstruktion innerhalb dieses Systems, die das aufloest — die einzige Quelle, die dem entkommt, ist
`user` (4.2b), und sie ist duenn. Deshalb: Score je Etikettenquelle in `detail`, `user` getrennt
ausgewiesen, Ablehnung, wenn das Delta nur auf den beeinflussbaren Quellen positiv ist. Auch das ist
Offenlegung, keine Loesung.

**3. Thematische Naehe zwischen Training und Rueckhalt.** Die Rueckhalteeinheit ist die Sitzung (E3), was
Turn-Duplikate ueber die Grenze verhindert. Es verhindert nicht, dass zwei Sitzungen derselben Woche
dieselben Themen, denselben Bankausschnitt und dieselbe Entitaetennachbarschaft haben. Der
Kandidatenschreiber sieht nur numerische Aggregate (6.2), aber diese Aggregate sind ueber die
Trainingssitzungen gebildet, und statistische Leckage ist keine Teilzeichenketteneigenschaft. Das ist ein
**akzeptierter, unvermessener Rest**. Ihn zu messen hiesse, eine Themenaehnlichkeit zwischen Sitzungen zu
definieren — dasselbe Problem, das dieses Konzept an anderer Stelle bewusst nicht loest.

**4. `usefulness` ist heute kein Nuetzlichkeitssignal.** Der Name ist eine Behauptung, die der Code nicht
einloest: der einzige Schreiber ist `touchMemories` (`store.ts:550-561`), gerufen ausschliesslich aus
`recall` auf den Zeilen, die `recall` gerade geliefert hat (`recall.ts:163-165`). Es misst "wurde
geliefert". Es geht trotzdem mit 0.3 in die Stilllegungsentscheidung ein (`sleep.ts:684`), und
`dormant_at` ist ein harter Abruffilter (`recall.ts:102`). Solange kein zweiter, echter Kanal existiert,
formt jede Abruf-Policy ueber diesen Weg die Bank, in der ihre Nachfolger gemessen werden. Dieses
Dokument streicht `usefulness` als Etikettenquelle (E9) und legt mit `memory_touches` die Aufzeichnung
an, aus der ein echter Kanal gebaut werden koennte. Es behauptet nicht, das Problem geloest zu haben.

---

## 13. Entscheidungen

**E1 — Der Traum aendert nur deklarierte Slots.** Parametersaetze mit geprueften Bereichen, kein
Dateizugriff, kein freier Code. Ein System, das nachts unbeaufsichtigt seine Suchsteuerung nachzieht, ist
vertretbar; eines, das seinen Quelltext umschreibt, ist es nicht.

**E2 — Der Amtsinhaber ist immer Kandidat, und ohne Vorsprung ueber das Rauschen wird nicht
befoerdert.** Das Rauschen wird ueber **Sitzungen** geschaetzt, nicht ueber Spuren.

**E3 — Die Rueckhalteeinheit ist die Sitzung.** Aufeinanderfolgende Turns teilen Thema, Bankausschnitt
und Entitaetennachbarschaft; per-Spur-Teilung unterschaetzt die Varianz und laesst `ci_low > 0` auf
Leckage feuern.

**E4 — Selektion auf dem Training, genau eine Pruefung auf dem Rueckhalt.** Sechs Kandidaten gegen ein
95-Prozent-Intervall zu testen ist sechsfaches Testen. Das ist billiger und sauberer als jede Korrektur.

**E5 — Replay-Treue ist eine Eigenschaft der Aufzeichnung und wird zertifiziert, nicht angenommen.** Der
Rahmen traegt seine Box; was die Box nicht schliesst, wird **enthalten**, nicht geschaetzt.

**E6 — Fuenf Woerter, fuenf Bedeutungen.** `exakt` / `eingefroren` / `praefixgueltig` / `genaehert` /
`enthalten`. Wer zwei davon vermengt, verliert die Unterscheidung, an der dieses Konzept haengt.
`geraten` steht ausdruecklich daneben und ist kein Messwort.

**E7 — Gemessen wird der gerenderte Block, nicht `recall`s Rueckgabewert.** Zwischen beiden liegen vier
Transformationen (1.2), und das Zeichenbudget ist Teil des Masses statt eine Nebenbedingung daneben.

**E8 — Der Schaetzer ist eine untere Schranke, kein Punktschaetzer.** Der Missing-Label-Bias ist nicht
schliessbar (Abschnitt 12.1). Jede Bewertung berichtet ihre Abdeckungsrate, und ein Delta, das
ueberwiegend aus unetikettierten Positionen stammt, ist ungueltig.

**E9 — `usefulness` und `memory_touches` sind keine Etikettenquellen.** Der einzige Schreiber ist
`recall` selbst. Das Signal heisst "wurde geliefert", nicht "hat geholfen". Beide bleiben **Merkmale**.
`source` ist `correction | review | merge | user`.

**E10 — Jede Etikettenquelle nennt ihre Abbildung, ihre Kosten und ihre Trefferquote.** Eine Quelle, die
nicht sagen kann, wie aus ihr ein `(turn, memory, relevance)` wird, ist keine Quelle, sondern ein Name in
einer Tabelle (Abschnitt 4).

**E11 — Umkehrbar in Parametern, nicht in Zaehlern.** "Nie unumkehrbar" war falsch: `touchMemories` ist
monoton und historienlos, und `usefulness` entscheidet ueber Stilllegung mit. `memory_touches` wird
append-only mit der verursachenden `policy_versions.id` gefuehrt, damit eine echte Neuberechnung
ueberhaupt moeglich wird.

**E12 — Drei Sensoren, drei Namen.** Frisch-Test misst Rahmenveralterung, Etikettenabgleich misst
Stellvertretergueltigkeit, Wach-Test ist ein Regressionsalarm. Fassung 1 hatte ein Instrument, und es hat
sich selbst gemessen.

**E13 — Der Kandidatenschreiber sieht nie Rohtext.** Leckage und Datenschutz; er bekommt
Komponentenvektoren, und der Test dafuer ist ein Konstruktionstest ueber eine typisierte Struktur ohne
Zeichenkettenfelder.

**E14 — Der Kandidatenschreiber laeuft auf dem Standardmodell und nicht auf `ask`s `effort: 'low'`.**
Eine Policy zu entwerfen heisst, aus Fehlfaellen auf eine Ursache zu schliessen: Urteil, keine
Extraktion. `ask` verdrahtet `low` (`sleep.ts:1801`) — dieser Widerspruch wird aufgeloest, nicht geerbt.

**E15 — Anti-Gaming ist Zulassungspruefung, keine Messung.** Gegen einen legalen, entarteten Kandidaten
hilft kein Vergleich; seine Zahl kann wirklich hoeher sein.

**E16 — Ein Resolver je Slot, ueber alle Aufrufstellen.** Heute existieren fuer `recall` zwei effektive
Policies (`runtime.ts:465-466` gegen `org/controller.ts:2458-2463`), unsichtbar nur, weil die Werte
zufaellig gleich sind.

**E17 — Erkundung ist auf kostenlose Entscheidungen beschraenkt, und Erkundung und Befoerderung teilen
sich nie eine Nacht im selben Slot.** `explorationRate: 0`, und die zweite Haelfte ist eine Invariante mit
Test, kein Satz.

**E18 — Jede Befoerderung traegt ihre `run_id`, faellt unter das Nacht-Undo und speichert ihren
Vorgaengerzustand.** `undoSleepRun` kann loeschen und nullen, aber nicht wiederherstellen; `snapshotSkill`
(`store.ts:1271-1277`) ist der Praezedenzfall.

**E19 — Zwei Aufbewahrungsuhren, und die Rahmen sind ein Wortlautspeicher.** Telemetrie ist keine
Erinnerung, aber eine Begruendung, die geloescht wird, bevor die Kalibrierung sie braucht, macht die
vorgeschriebene Ruecknahme unpruefbar — dafuer `evidence_digest` ohne Wortlaut. Und kein Wortlaut
ueberlebt die Erinnerung, aus der er stammt.

**E20 — Drei Schalter, nicht einer.** `dream.enabled`, `dream.record`, `dream.promote`. Ohne getrennten
Rekorderschalter gibt es keinen Weg, die Latenz zu entlasten, ohne gleich die Etikettenschreiber
mitzustoppen. Und jeder Konfigurationsschluessel nennt in einer Tabelle die Stelle, die ihn liest; ein
Schluessel ohne Leser kommt nicht in die Konfiguration.

**E21 — Konfiguration wird beim Lesen geklemmt, nicht beim Schreiben vertraut.** `rookery config set`
umgeht Zod vollstaendig (`cli/commands/config.ts:61-80`). Und `merge` ersetzt Arrays ganz: `slots` kann
nur ersetzt, nie ergaenzt werden.

**E22 — Der `gate`-Slot verlaesst Stufe 1.** Praefix-Gueltigkeit erzeugt dort ein identisch nulles Delta
(7.2). Was bleibt, ist die **Erst-Divergenz-Bewertung** als Mechanismus fuer Stufe 2. Der Slot kehrt
zurueck, wenn er ein eigenes Messziel hat.

---

## 14. Offene Fragen

1. **Wie gut sind die Etiketten wirklich?** In eine stehende Zahl ueberfuehrt (5.5b), aber der Schwellwert
   ist geraten: ab welchem Kappa darf befoerdert werden? Vorschlag 0.4. Und: was tun, wenn `user`-Etiketten
   dauerhaft zu duenn fuer einen Abgleich sind? Der ehrliche Ausgang waere "das Mass bleibt unvalidiert
   und der Slot unbefoerdert", was faktisch das Ende von Stufe 1 waere.
2. **Wie hoch ist die Trefferquote der Zitat- und Aehnlichkeitslokalisierung** (4.2a)? Sie entscheidet, ob
   die einzige Quelle, die eine nicht gelieferte Erinnerung etikettieren kann, ueberhaupt traegt. Wenn
   nicht: Modellaufrufe je Korrektur, und damit ist Stufe 1 nicht mehr modellfrei.
3. **Wird aus `memory_touches` wirklich neu berechnet?** Die Aufzeichnung wird jetzt angelegt (8.4). Ob
   `access_count` und `usefulness` je daraus abgeleitet statt fortgeschrieben werden, ist ungeklaert — es
   waere ein Eingriff in `#decay` (`sleep.ts:671-690`) und in die Bedeutung zweier Spalten, von denen
   `usefulness` seit Schema 5 existiert und `access_count` seit der Basistabelle (Schema 1).
4. **Ab wann sagt der Traum etwas?** `minTraces: 200` ist geraten. Phase 0 und 1 liefern die Daten; mit
   `frameRate: 0.25` dauert es vierfach laenger, bis der Replay-Pool traegt, waehrend der Etikettenpool
   voll laeuft.
5. **Eine Policy je Besitzer oder eine fuer alle?** Vorschlag: gemeinsamer Bewertungspool, Befoerderung
   nur fuer den Assistenten, Agenten erben. Offen ist, wie das mit der Pipeline-Reinheit (3.6)
   zusammengeht — Agentenspuren rendern ohne Gruppierung, ihr Blockmass ist also mit dem des Assistenten
   nicht vergleichbar.
6. **Wie breit darf die Box sein?** `|possibleSeeds|` ist eine Funktion der Boxbreite (3.1), und
   Rahmengroesse, Latenz und Lesekosten haengen daran. Die Breite ist damit kein Komfortparameter, sondern
   ein Kostenparameter, und die Grenze, ab der ein Rahmen mit `seeds-capped` abbricht, ist geraten.
7. **Kann `cluster` je bewertet werden?** Ein Kandidatenetikett waere "das verdichtete Ergebnis wurde
   spaeter korrigiert oder erneut abgeloest". Das ist Wochen langsam und moeglicherweise zu duenn. Bis
   dahin: kein Slot.
8. **Bekommt `gate` ein eigenes Messziel?** Die Frage ist nicht "wie simuliert man die Schleife", sondern
   "woran erkennt man eine bessere Torentscheidung". Ohne eine Antwort darauf bleibt der Slot draussen
   (E22).
9. **`#demand`s Kostenversprechen.** Der Doc-Kommentar bei `sleep.ts:438-446` sagt, eine Nacht, die sich
   selbst vermisst, koste nichts; `#cluster` ist schon heute paarweise ueber alle lebenden Erinnerungen
   (`sleep.ts:733-745`). Wird die Traum-Sonde mehr als ein Index-`COUNT(*)`, muss der Kommentar geaendert
   werden — und dann steht die Frage, ob `#demand` insgesamt zu teuer geworden ist.
10. **Was passiert bei einem harten Loeschen am Gedaechtnis?** Teilweise geloest (rahmenrelatives Ideal,
    ein `supersedes`-Sprung, `reachable_rate`, `dead_at`). Ungeloest bleibt, dass `DELETE ... ?hard`
    (`routes/memories.ts:156-157`) und `archiveMemories` beim Agentenwechsel (`org/controller.ts:2695`)
    Etikettenziele wirklich entfernen.
11. **Reicht der Frisch-Test bei ruhiger Bank?** Dann sind eingefroren und live identisch und der Test ist
    gegenstandslos. Der Bericht muss den Anteil der Rahmen ausweisen, deren Zeilen sich von live
    unterscheiden, damit die Teststaerke selbst sichtbar ist.
12. **Schema-Nummer 21 - die Kollision ist eingetreten und aufgeloest.** Waehrend Stufe 1 gebaut
    wurde, hat `main` die Nummern 19 (Turn-Journal) und 20 (Sitzungsspalte ohne NOT NULL) belegt.
    Der Traum ist beim Zusammenfuehren auf **21** umnummeriert worden; das war folgenlos, weil die
    Traum-Migration ausschliesslich aus `CREATE TABLE IF NOT EXISTS` und `hasColumn`-gewachten
    `ALTER TABLE` besteht, also idempotent und reihenfolgeunabhaengig ist. Die Lehre bleibt: wer
    eine Nummer im Voraus beansprucht, haelt sie nicht - nur die Idempotenz der Bloecke haelt.
