# Belegpflicht im Gedaechtnis, und Skills, die sich der Agent selbst schreibt

Stand: 2026-09-14. **Umgesetzt**, in zwei Schritten: Belegpflicht und selbstgeschriebene Skills,
danach die automatische Ueberarbeitung. Der Code liegt in `packages/core/src/memory/gate.ts`,
`extractor.ts`, `sleep.ts`, `store.ts`, `db.ts`, in `packages/core/src/skills/store.ts`,
`packages/core/src/org/tools.ts` und `controller.ts`, die Oberflaeche in
`packages/web/src/pages/MemoryListPage.tsx` und `SkillsPage.tsx`. Baut auf
[`memory-graph-and-sleep.md`](memory-graph-and-sleep.md) auf und schliesst dessen Befund 1
und 2 endgueltig.

## 1. Befund

Drei Beobachtungen aus dem laufenden Betrieb, alle am Code belegt.

1. **Das Tor prueft Aehnlichkeit, aber nicht Wahrheit.** `admitCandidates` konnte einen
   Kandidaten als schwach, zu kurz, doppelt oder ueber Budget abweisen — nie aber mit der
   Begruendung, dass ihn niemand gesagt hat. Der Extraktor bekommt Frage *und* Antwort zu
   sehen, und ein Modell, das nach Fakten gefragt wird, findet Fakten: es liest die eigene
   Assistentenantwort oder die Frage selbst und schreibt eine Schlussfolgerung auf, die nie
   jemand geaeussert hat.
2. **Eine Frage, zwei Erinnerungen.** `gate.maxPerTurn` steht auf 3 und `parseCandidates`
   laesst bis zu acht Kandidaten durch. Auf eine einzelne Nutzerfrage wurden damit
   regelmaessig zwei Saetze geschrieben — formal korrekt, inhaltlich Rauschen.
3. **Der doppelte Toast war kein Gedaechtnisproblem.** `RookerySocket.close()` hing die
   Handler des alten WebSockets nicht ab, und `onclose` prueft nicht, ob der schliessende
   Socket noch der aktuelle ist. Nach `close()` → `connect()` (StrictMode-Remount oder
   Reconnect) setzte das verspaetete `onclose` des alten Sockets `#ws = null` und rief
   `#scheduleReconnect()` auf, weil `#closedByUs` inzwischen wieder `false` war. Ergebnis:
   zwei lebende Sockets, beide auf `#handleFrame` verdrahtet, also **jede** Rundsendung
   doppelt — Memory-Toast, Mail-Toast, Cron-Toast gleichermassen.

## 2. Entscheidung

**Nur Belegtes wird gespeichert, ohne Rueckfrage.** Kein Vorschlagskorb, keine
Freigabeoberflaeche: Was sich nicht belegen laesst, verschwindet, statt Pruefarbeit zu
erzeugen.

- Jeder Kandidat traegt ein Feld `evidence`: eine woertlich kopierte Spanne aus dem, was
  der Nutzer selbst geschrieben hat. Fuer Agenten: aus Auftrag oder Report.
- Das Tor prueft den Beleg gegen den Quelltext (`confirmedBy`). Haelt er nicht, wird der
  Kandidat mit dem Grund `unconfirmed` verworfen — vor jeder Aehnlichkeitsrechnung.
- Fuer das Assistenten-Gedaechtnis zaehlt **ausschliesslich** die Nutzernachricht als
  Quelle. Die Assistentenantwort geht weiterhin in den Extraktionsprompt, damit das Modell
  den Zusammenhang versteht, aber ein Fakt, den der Assistent selbst produziert hat, ist
  kein Fakt, den der Nutzer bestaetigt hat.
- Der Beleg wird mitgespeichert (`memories.evidence`) und im Inspektor angezeigt. „Der
  Assistent behauptet, ich haette das gesagt" ist damit in einer Sekunde pruefbar.

`confirmedBy` vergleicht auf normalisierten Woertern (klein, ohne Diakritika, ohne
Satzzeichen), aber **nicht** mit der Tokenisierung des Abrufs: die wirft Stoppwoerter weg,
und „ich nutze Docker nicht" faellt damit mit „ich nutze Docker" zusammen. Jedes durch
Auslassungspunkte getrennte Fragment muss als ununterbrochene Wortfolge vorkommen — das
laesst ein geglaettetes Zitat durch und ein zusammengesetztes nicht.

Bewusst **nicht** geaendert: `maxPerTurn` bleibt bei 3. Eine Nachricht kann zwei echte
Fakten enthalten; das Problem war nie die Zahl, sondern die Herkunft. Die Belegpflicht
schneidet genau die Kandidaten weg, die den Eindruck „zwei Memories fuer eine Frage"
erzeugt haben.

**Der Agent schreibt sich eigene Skills — auf zwei Wegen.**

- `write_skill` (Audience `both`) fuer den Moment, in dem Assistent oder Agent merkt, dass
  eine Prozedur wiederkehrt. Sofort wirksam: der Skill steht ab dem naechsten Turn im
  Index.
- Eine sechste Nachtphase (`SleepRunner.#practise`, am Ende des letzten Zyklus in der
  `rem`-Stufe) destilliert aus dem aufgeraeumten Gedaechtnis, was sich wiederholt, zu einem
  Skill. Ein Modellaufruf pro Nacht, `memory.sleep.skills` deckelt die Zahl auf 1.

Begruendung fuer beide statt nur eines: Der Tool-Weg hat die kurze Rueckkopplung, sieht
aber nur einen Turn. Der Nachtlauf sieht die ganze Bank und erkennt Muster ueber Wochen —
kann aber nicht reagieren, wenn heute Nachmittag etwas gelernt wurde, das morgen frueh
wieder gebraucht wird.

## 2a. Skills, die sich selbst nachziehen

Ein Skill wird einmal geschrieben und danach monatelang befolgt. Das macht einen veralteten
schlimmer als gar keinen: er hilft nicht nur nicht, er schickt denjenigen, der ihn oeffnet,
mit voller Ueberzeugung einen Weg entlang, den es nicht mehr gibt. Deshalb faengt die Nacht
nicht bei „was koennte ich noch aufschreiben" an, sondern bei „was von dem, was ich schon
aufgeschrieben habe, stimmt nicht mehr" — `SleepRunner.#revise` laeuft **vor**
`#practise`.

**Was Hermes dabei beisteuert und was nicht.** Belastbar ist an
[`hermes-agent-self-evolution`](https://github.com/NousResearch/hermes-agent-self-evolution)
zweierlei: die Eingabe sind **Execution Traces** — warum etwas scheiterte, nicht nur dass —
und **jede Variante muss durch ein hartes Tor**, bei Hermes bis hin zum menschlichen
PR-Review. Der automatische Ausloeser dagegen existiert dort nicht: die Skill-Evolution wird
von Hand angestossen (`--skill X --iterations 10`), der kontinuierliche Loop steht im Repo
als „Phase 5, geplant". Den Teil bauen wir selbst, und wir koennen es, weil der Nachtlauf
schon da ist.

Zwei Ausloeser, beide aus Daten, die ohnehin gespeichert werden:

1. **Die Quelle hat sich bewegt.** `skill_sources` haelt fest, auf welchen Erinnerungen ein
   destillierter Skill steht. Wird eine davon eingeschlaefert, in einem Widerspruch
   ueberstimmt oder von Hand geaendert, ist der Skill verdaechtig. Dem Modell werden Skill,
   alte Fassung und Ersatz nebeneinander gezeigt.
2. **Ein Lauf ist damit gescheitert.** `use_skill` schreibt seit dieser Stufe eine Zeile nach
   `skill_uses`. Der Join auf `assignments` macht daraus „der Lauf, der diesen Skill offen
   hatte, ist gescheitert" — **mit dem echten Fehlertext**. Das ist Hermes' Trace-Eingabe,
   nur aus Daten, die hier schon lagen und die bisher niemand verknuepft hat. „Der Lauf ist
   gescheitert" lokalisiert nichts; `npm error Missing script: "build:core"` zeigt auf genau
   die Zeile, die luegt.

**Der Ausloeser ist durch Hinsehen verbraucht.** Das ist die unauffaelligste und wichtigste
Regel der Phase. Eine eingeschlafene Erinnerung bleibt eingeschlafen — ohne diese Regel
zerrte sie denselben Skill jede Nacht aufs Neue vor das Modell, und eine Nacht, die „liest
sich noch richtig" entschieden hat, entschiede das morgen zum gleichen Preis noch einmal.
Deshalb hinterlaesst **jede** Pruefung einen Eintrag in `skill_versions`, auch die, die
nichts geaendert hat, und `lastSkillReviewAt` oeffnet das Fenster der naechsten Nacht erst
ab diesem Zeitpunkt. Zusaetzlich zieht `#settleSources` die Quellen nach: ein ueberholter
Beleg wird auf seinen Nachfolger umgehaengt, ein eingeschlafener faellt weg. Die Kette
ueberlebt damit eine Verdichtung, statt an ihr zu reissen.

**Uebernahme: still, aber umkehrbar.** Vor jedem unbeaufsichtigten Schreiben wandert der
komplette bisherige `SKILL.md`-Text nach `skill_versions` — `SkillStore.raw` liest ihn
unparsed, damit auch ein unbekannter Frontmatter-Schluessel oder eine eigene Formatierung
die Ruecknahme ueberlebt. `content = NULL` heisst „gab es vorher nicht", und die Ruecknahme
loescht den Ordner dann wieder, statt Text zurueckzuschreiben.

## 2b. Die Nacht liest den Tag noch einmal

Bis hierher arbeitete die Nacht ausschliesslich auf der Erinnerungsbank. Die Gespraeche selbst
wurden genau einmal gelesen — direkt nach jedem Turn, vom schwaechsten Glied der Kette: kleinstes
Modell, `effort: low`, beide Seiten auf 4000 Zeichen beschnitten, hoechstens drei Kandidaten, seit
dieser Stufe zusaetzlich die Belegpflicht. Dieser Durchgang sieht **einen Austausch**, nie den
Bogen eines Gespraechs. Alles, was erst ueber eine ganze Unterhaltung hinweg sichtbar wird, war
damit strukturell unerreichbar: eine beilaeufig genannte Praeferenz, die erst dreissig Turns
spaeter zaehlt; eine Entscheidung, die sich herausschaelt statt in einem Satz zu stehen; und vor
allem eine **Korrektur**.

Die neue Phase `replay` laeuft **einmal, vor den Zyklen**. Die Reihenfolge ist der Punkt: was die
Nacht aus dem Tag holt, wird noch in derselben Nacht verdichtet, statt einen Tag darauf zu warten.

**Billig vorsortieren, teuer nur wo es lohnt.** Ein kleines Modell bekommt ausschliesslich die
Nutzer-Turns, stark gekuerzt, und beantwortet eine einzige Frage: koennte hier etwas Dauerhaftes
drinstecken? Die meisten Gespraeche sind an dieser Stelle vorbei. Nur was durchkommt, wird vom
starken Modell vollstaendig gelesen. Gespraeche mit weniger als zwei Nutzer-Turns kosten gar
keinen Aufruf — „danke" und „gern geschehen" braucht kein Urteil.

Die Belegpflicht wird dabei **nicht** gelockert. Auch die Nacht muss woertlich zitieren, und auch
hier zaehlt nur, was der Nutzer selbst geschrieben hat. Ein besseres Modell darf mehr *finden*,
nicht mehr *erfinden*.

**Korrekturen sind der dritte Ausloeser.** Sagt der Nutzer „nein, so nicht", ist etwas
Aufgeschriebenes falsch — das staerkste Signal, das das System ueberhaupt bekommen kann, und bis
hierher hat es niemand erfasst. Gefundene Korrekturen landen in `corrections` und treten in der
Ueberarbeitungsphase neben „Quelle hat sich bewegt" und „Lauf ist gescheitert". Sie kommen ohne
Skill-Bezug an, werden also lexikalisch zugeordnet — **ueber Name und Beschreibung, nie ueber den
Rumpf**. Das war eine Korrektur am eigenen Entwurf, die erst der Test zutage foerderte: eine
Korrektur teilt mit der Prozedur, die sie betrifft, naturgemaess kaum Woerter — sie bringt ja
gerade etwas ein, das dort fehlt — und jede weitere Zeile Rumpf verwaessert die Aehnlichkeit
weiter, bis nichts mehr passt. Der Gegenstand eines Skills steht in seiner Betreffzeile.

Auch hier gilt: **Hinsehen verbraucht den Ausloeser.** Eine gewogene Korrektur wird als verbraucht
markiert statt geloescht — sie bleibt als Tatsache stehen, kann die Nacht aber nicht mehr
beschaeftigen.

Was die Nacht so erntet, haengt am Lauf und faellt bei einer Ruecknahme mit. Das ist bewusst so:
eine Nacht zurueckzunehmen heisst, alles zurueckzunehmen, was sie getan hat — auch das, was sie
gelernt hat.

## 3. Schutzmassnahmen

Ein Prozess, der unbeaufsichtigt Anweisungen schreibt, die spaeter befolgt werden, braucht
harte Grenzen. Es sind vier:

1. **Herkunft steht im Frontmatter.** `origin: user | agent | sleep`. Alles ohne Angabe
   gilt als `user`.
2. **Was ein Mensch geschrieben hat, wird nie ueberschrieben.** `SkillStore.save` weist
   jeden nicht-menschlichen Schreibversuch auf einen `user`-Skill ab. Die Nacht
   protokolliert die Ablehnung und geht weiter; einen Umweg gibt es nicht.
3. **Belegpflicht auch hier.** Die Nacht schreibt keinen Skill auf weniger als drei
   Erinnerungen und keinen Rumpf unter 120 Zeichen.
4. **Nie ins Projekt.** `save` schreibt immer nur in das erste Verzeichnis, also den
   Home-Ordner. Ein Skill, der mitten in einem Assignment entsteht, landet nie im
   Repository des Kunden.
5. **Jede unbeaufsichtigte Fassung ist umkehrbar.** Vorgaengerversion vorher weggeschrieben,
   an den Sleep-Run gehaengt, und `SleepRunner.undo` stellt sie mit her.

Zu Punkt 5 gehoert ein Fehler, der in der ersten Fassung dieser Stufe drinsteckte:
`undoSleepRun` setzte ausschliesslich `memories` und `memory_edges` zurueck. Solange die
Nacht nur neue Skills anlegte, war das unvollstaendig; sobald sie anfaengt zu
**ueberschreiben**, waere daraus Datenverlust geworden — die Vorfassung unwiederbringlich
weg. Die Ruecknahme laeuft deshalb jetzt zweistufig: erst die Bank in einer Transaktion,
danach die Dateien aus den Schnappschuessen. Die Reihenfolge ist Absicht. Scheitert das
Zurueckschreiben einer Datei, ist die Bank bereits konsistent und der Skill das einzige,
was noch steht; umgekehrt bliebe ein Skill uebrig, der auf Erinnerungen zeigt, die nicht
mehr das sagen, wofuer er umgeschrieben wurde.

Wer einen von der Nacht geschriebenen Skill in der UI bearbeitet, macht ihn damit zu seinem
eigenen (`origin: user`) — und schuetzt ihn kuenftig vor genau dieser Nacht.

## 4. Was sich am Datenbestand aendert

Schema 11 → 14, alles additiv ueber das bestehende `hasColumn`- und
`CREATE TABLE IF NOT EXISTS`-Muster:

| Tabelle          | Spalte / Zweck                                                       | Typ                          |
| ---------------- | -------------------------------------------------------------------- | ---------------------------- |
| `memories`       | `evidence`                                                            | `TEXT`, NULL erlaubt         |
| `sleep_runs`     | `skill_count`                                                         | `INTEGER NOT NULL DEFAULT 0` |
| `sleep_runs`     | `skill_revised_count`                                                 | `INTEGER NOT NULL DEFAULT 0` |
| `skill_uses`     | jede `use_skill`-Oeffnung, mit `assignment_id` / `session_id`         | neue Tabelle                 |
| `skill_sources`  | worauf ein destillierter Skill steht                                  | neue Tabelle                 |
| `skill_versions` | der `SKILL.md`-Text vor einem unbeaufsichtigten Schreiben             | neue Tabelle                 |
| `sleep_runs`     | `replayed_count`, `learned_count`                                     | `INTEGER NOT NULL DEFAULT 0` |
| `corrections`    | was der Nutzer richtiggestellt hat, bis eine Nacht es gewogen hat     | neue Tabelle                 |

Die drei neuen Tabellen sind ueber den **Skill-Namen** verschluesselt, nicht ueber einen
Fremdschluessel: die Datei kann komplett ausserhalb von Rookery geloescht werden, und eine
verwaiste Zeile ist billiger als eine Bedingung, die sich nicht einhalten laesst.

Bestandszeilen behalten `evidence = NULL`: sie wurden unter den alten Regeln geschrieben
und werden weder nachtraeglich geprueft noch entwertet. Wird eine solche Erinnerung spaeter
erneut belegt bestaetigt, fuellt `upsertMemory` den Beleg nach — ersetzt ihn aber nie, denn
die ersten Worte, die einen Fakt bestaetigt haben, sind die aufhebenswerten.

## 5. Offene Punkte

- **Ein Nein bleibt unsichtbar.** „Ich nutze Docker nicht mehr" erzeugt weiterhin eine neue
  Erinnerung neben der alten; erst die Nacht entscheidet den Widerspruch. Die Belegpflicht
  aendert daran nichts.
- **Ein Teilzitat kehrt die Bedeutung um.** `confirmedBy` prueft, ob der Beleg als
  ununterbrochene Wortfolge in der Quelle steht — nie, ob die Behauptung dasselbe sagt wie
  der Beleg. Dass die Wortnormalisierung Stoppwoerter haelt, zaehlt nur, solange das Zitat
  die Verneinung mitfuehrt: „ich nutze Docker nicht" passt als Beleg nicht auf „ich nutze
  Docker" — aber nichts zwingt das Modell, sie ueberhaupt zu zitieren. „nutze Docker"
  erfuellt das Minimum von zwei Woertern, liegt als ununterbrochene Folge in „ich nutze
  Docker nicht" und passiert zusammen mit der Behauptung „Der Nutzer nutzt Docker" das
  Tor: Der Beleg belegt dann Woerter, keine Aussage, und die Aussage steht allein im
  `content`, den das Tor nie ansieht. Anders als beim unsichtbaren Nein braucht es dazu
  keinen Widerspruch, den die Nacht entscheiden koennte — die Erinnerung ist von Geburt an
  falsch, und nichts widerspricht ihr. Der Inspektor zeigt Beleg und Behauptung
  nebeneinander, die Umkehrung ist also von Hand pruefbar; automatisch gefangen wird sie
  nicht. Zwei denkbare Gegenmassnahmen, keine entschieden: den Beleg die Kernbegriffe der
  Behauptung abdecken lassen — das verengt den Umweg, sieht aber weiterhin keine
  Verneinung —, oder Behauptung und Beleg von einem Modell auf Konsistenz pruefen lassen,
  als eigene Stufe nach dem Tor; das Tor selbst bleibt bewusst synchron, lokal und ohne
  Modellaufruf.
- **Belege verwaisen.** Verdichtet die Nacht zwei Erinnerungen, hat die entstehende keinen
  eigenen Beleg. Die Kanten zu den Ausgangserinnerungen bleiben, die Spur ist also
  verfolgbar, aber der Inspektor zeigt fuer verdichtete Zeilen kein Zitat.
- **Kein Skill-Verfall.** Bewusst offen gelassen: ein Skill, den monatelang niemand
  oeffnet, faellt nicht aus dem Index. `skill_uses` haelt die Daten dafuer inzwischen
  bereit — es fehlt nur die Entscheidung, ab wann ein Ruhestand vorgeschlagen wird.
- **Nur der Assistent bekommt Ausloeser aus Fehlschlaegen.** Ein Turn hat, anders als ein
  Assignment, keinen Status: es gibt kein Feld, das sagt, ob die Unterhaltung gut ausging.
  Fehlerbasierte Ueberarbeitung greift deshalb praktisch nur bei Skills, die Agenten in
  Assignments oeffnen. Der Quellen-Ausloeser gilt fuer beide.
- **Korrekturen greifen nur, wenn die Worte passen.** Die Zuordnung einer Korrektur zu einem
  Skill ist lexikalisch. Wer etwas richtigstellt, ohne den Gegenstand des Skills zu benennen,
  loest nichts aus. Ein Fehlschlag kostet eine verzoegerte Reparatur, kein Schaden — aber
  lautlos ist er trotzdem.
- **Die Herkunft nach einer Reparatur ist grob.** Ueberarbeitet die Nacht einen Skill, den
  ein Agent geschrieben hatte, steht danach `origin: sleep` darin. Das stimmt fuer den
  aktuellen Text, verliert aber die Spur, wer ihn urspruenglich angelegt hat.
- **Die Versionen sind nicht sichtbar.** `skill_versions` fuellt sich, aber die UI zeigt
  weder eine Historie noch einen Vergleich. Wer wissen will, was die Nacht geaendert hat,
  sieht nur die Zahl im Bericht.
