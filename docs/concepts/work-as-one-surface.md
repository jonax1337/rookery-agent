# Die Karte ist der Vorgang: eine Oberflaeche fuer Arbeit

Stand: 2026-09-22. **Umgesetzt, alle vier Phasen**, O1 bis O3 entschieden —
siehe "Stand der Umsetzung". Der Rest ist der Entwurf, aus dem gebaut wurde;
weicht er vom Code ab, gilt der Code. Offen bleibt bewusst genau eine Sache,
am Ende von Abschnitt 5 benannt.

Das Board, die Laeufe und die Zeitplaene funktionieren einzeln und ergeben
zusammen kein Bild. Dieselbe Arbeit existiert fuer den Nutzer an vier Orten —
`/tasks` zeigt Karten, `/assignments` zeigt Laeufe, `/inbox` zeigt je einen
Thread pro Aufgabe, `/cron` zeigt Jobs, die wiederum Laeufe erzeugen. Auf die
Frage "was laeuft gerade in meinem Namen?" geben diese vier Orte drei
verschiedene Antworten, und keine davon ist vollstaendig.

Das ist keine Sammlung von Fehlern, es ist eine Geometrie. Dieses Dokument
fuehrt sie auf einen Gegenstand zurueck: **die Karte ist der Vorgang, alles
andere ist eine Ansicht davon oder haengt daran.**

Vorlaeufer: `mail-board-unification-and-roleplay.md` hat die Eingaenge
zusammengefuehrt (E9) und den Waechter eingefuehrt (E8). Dieses Dokument baut
darauf auf und korrigiert zwei Stellen, an denen jenes Konzept den Code
ueberholt hat.

Beruehrt wuerden `packages/core/src/org/store.ts`, `org/controller.ts`,
`packages/core/src/types.ts`, `packages/core/src/memory/db.ts` (eine Spalte,
`SCHEMA_VERSION` 24 nach 25), `packages/server/src/routes/org.ts` sowie in
`packages/web` die Task-, Assignment-, Cron- und Navigationsseiten.

---

## Stand der Umsetzung

**Vorarbeit, bereits im Code (2026-09-22):**

- Der Waechter beobachtet nur noch. Sein Werkzeugsatz ist eine Allowlist
  (`WATCH_TOOLS` in `org/tools.ts`), `blocked` weckt ihn nicht mehr, und ein
  deterministischer Vorab-Check (`Assistant.#boardAttention`) entscheidet vor
  jedem Modellaufruf, ob ueberhaupt etwas anliegt. Ein ruhiges Board kostet
  null Token. Die Wasserlinie steht in `meta` (`board-watch:seen:<jobId>`)
  und rueckt vor, sobald Funde uebergeben werden — nicht erst, wenn das
  Modell etwas sagt. Aus der Lauf-Historie rekonstruiert war sie dreifach
  falsch: nach genug stillen Laeufen fiel der sprechende aus dem Fenster,
  ein `[SILENT]`-Ausgang bewegte sie nie, und nach einem Upgrade gab es sie
  gar nicht.
- `Runtime.assign()` legt eine Karte an und laeuft ueber `runTask`. Damit ist
  der fuenfte Eingang zu — Web-UI, WebSocket, CLI und **jeder Agenten-Cronjob**
  hinterlassen jetzt eine Karte. Vorher liefen Nachtlaeufe Nacht fuer Nacht
  ohne jede Spur auf dem Board.
- Der Requester eines Laufs kommt aus `task.createdBy` statt aus der Audience
  (Korrektur zu Befund F7 des Audits).
- Der Brief eines Laufs wiederholt den Titel nicht mehr, wenn dieser aus dem
  Brief abgeleitet wurde (`briefFor` in `org/controller.ts`).

**Phase A (Herkunft), umgesetzt.** `tasks.schedule_id`, Schema 24 nach 25.
Gesetzt von `Runtime.assign` aus `AssignInput.scheduleId`, durchgereicht von
`#runScheduled` fuer Agenten-Jobs. In der UI ueber `taskOriginLabel`: eine
Karte aus einem Zeitplan sagt "By a schedule" und verlinkt ihn.

**Phase B (eine Oberflaeche), umgesetzt.** `/assignments` ist `hidden` mit
`parent: '/tasks'` — Route und alle Links bleiben, der Navigationseintrag ist
weg. Der Board-Waechter ist aus der Zeitplan-Liste gefiltert
(`isBoardWatch` in `web/src/lib/cron.ts`) und steht stattdessen als Zeile auf
der Work-Seite (`BoardWatchLine` in `TasksPage.tsx`), die auch sagt, wann
zuletzt geprueft wurde — und wenn er aus ist, dass niemand hinsieht.

**Phase C (ein Schreiber), umgesetzt — mit benannter Ausnahme.** Jeder Weg,
auf dem ein *Mensch oder ein Agent* einen Status setzt, laeuft durch
`OrgController.setTaskStatus`: Tool (`update_task`), HTTP-Route
(`PATCH /api/org/tasks/:id`), CLI (`tasks done`, `tasks cancel`) und der
Abschluss jedes Laufs (`fromRun: true`). Nicht dadurch laufen die
maschinellen Zwischenzustaende des Runners: `claimTaskForRun` (das atomare
`running`), die Teilaufgaben-Uebergaenge in `#runSubtaskBody`, die
`planned`-Zuweisungen des Planers und `failStaleTasks` beim Start. Sie haben
keinen Adressaten, der benachrichtigt werden muesste, und duerfen an keinem
Guard scheitern — ein Lauf, der seine eigene Welle nicht weiterschalten darf,
waere handlungsunfaehig. Ein
Wiedereroeffnen loescht `finishedAt`, `result` und `error`, und eine laufende
Karte laesst sich von aussen nur noch abbrechen. Dort sitzt auch O3: ein
Agent darf eine Karte des Nutzers nicht abschliessen.

**Phase D (die Reste), umgesetzt.** Siehe Abschnitt 5: keine eingefrorenen
Karten mehr, abbrechbare Teilaufgaben, ein ehrliches Journal, ein Turn-Timeout
und das geschlossene Sleep-Leck im WebSocket.

---

## 1. Warum es sich falsch anfuehlt

Vier Oberflaechen, ein Gegenstand:

| Oberflaeche | Zeigt | Ist in Wahrheit |
|---|---|---|
| `/tasks` | Karten | der Vorgang |
| `/assignments` | Laeufe | Versuche, einen Vorgang zu erledigen |
| `/inbox` | Threads | die Konversation eines Vorgangs |
| `/cron` | Jobs | die Wiederholung eines Vorgangs |

Ein Lauf ist nichts, was man durchblaettert. Man blaettert Arbeit durch und
steigt in Versuche ab. Ein Task-Thread ist keine Korrespondenz, sondern die
Verhandlung genau dieser Karte. Ein Agenten-Zeitplan ist keine dritte Art von
Sache, sondern eine Karte, die sich wiederholt.

Dazu kommt, dass die Herkunft einer Karte heute nicht ablesbar ist.
`RequesterKind` kennt `user | assistant | agent`, und eine Karte, die ein
Nachtlauf erzeugt hat, sieht exakt aus wie eine, um die der Nutzer im Chat
gebeten hat. Die Frage "warum gibt es das hier?" hat keine Antwort in der UI.

---

## 2. Phase A — Herkunft auf der Karte

**Problem.** `Task.createdBy` beantwortet "welche Art von Partei hat das
angelegt", nicht "was hat das ausgeloest". Ein Zeitplan ist keine vierte
Partei — er ist eine Einrichtung des Nutzers, die zu einer Zeit feuert.
`RequesterKind` um `schedule` zu erweitern waere falsch: der Typ adressiert
auch Mail, und eine Mail *von einem Zeitplan* gibt es nicht.

**Entscheidung E1.** Eine eigene, nullable Spalte `tasks.schedule_id`, gesetzt
wenn die Karte aus einem feuernden Zeitplan entstand. `createdBy` bleibt
`user` — der Mensch hat den Zeitplan eingerichtet, und die Karte gehoert ihm.
Die UI zeigt bei gesetztem `scheduleId` den Namen des Jobs und verlinkt ihn.

**Entscheidung E2.** Kein `startedBy` als zweite Spalte. Wer einen Lauf
gestartet hat, steht bereits auf dem Lauf (`assignments.requester_kind`), und
`task_assignments` verbindet beide. Eine zweite Wahrheit auf der Karte waere
genau die Sorte Dopplung, die dieses Dokument abschaffen soll.

**O1, entschieden: faellt weg.** Der Waechter kann keine Karte anlegen —
`WATCH_TOOLS` enthaelt weder `create_task` noch `assign`. Die Frage stellt
sich erst wieder, wenn er je wieder handeln darf, und dann gehoert sie zu
derselben Entscheidung. Kein Feld auf Vorrat.

## 3. Phase B — eine Oberflaeche fuer Arbeit

**Entscheidung E3.** `/assignments` verschwindet als eigener Eintrag in der
Navigation. Laeufe bleiben erreichbar: als Tab auf der Karte (existiert
bereits) und ueber die Karte selbst. Die Route bleibt bestehen, damit alte
Links und Lesezeichen nicht brechen.

**Entscheidung E4.** Die Work-Seite ist die heutige `TasksPage`. Sie
beantwortet die Frage "was laeuft gerade" jetzt zum ersten Mal vollstaendig —
nicht weil die Seite umgebaut wurde, sondern weil seit der Vorarbeit oben
jede Arbeit eine Karte hat; Statusspalte und `running`-Kachel zeigen es
bereits. **Nicht umgesetzt:** eine Live-Laufanzeige pro Zeile. Das waere
Komfort, kein Modellfehler, und lohnt erst, wenn sich zeigt, dass die
Statusspalte im Alltag nicht reicht.

**Entscheidung E5.** Der Board-Waechter verlaesst die Zeitplan-Liste. Ein
Cron-Eintrag behauptet "das hast du angelegt"; das stimmt nicht und hat den
Nutzer zu Recht gestoert. Die Job-Zeile bleibt in der Datenbank — nur die
Zeitplan-Seite zeigt sie nicht mehr, und die Work-Seite sagt stattdessen in
einer Zeile, dass das Board beobachtet wird und wann zuletzt.

**O2, entschieden: der Inbox behaelt Task-Threads, unveraendert.** Der
urspruengliche Vorschlag — eine Zeile, die auf die Karte springt statt sich
zu oeffnen — nimmt etwas weg (im Inbox lesen und antworten) und gibt nichts
dafuer: die Konversation steht bereits auf der Karte, `TaskDetailPage` hat
einen eigenen Thread-Tab mit `MailThreadView`. Beide Wege fuehren zum selben
Thread, und das ist keine Dopplung, sondern zwei Zugaenge zu einem Gegenstand
— genau wie ein Lauf sowohl unter `/assignments/:id` als auch im Runs-Tab
seiner Karte liegt. Ein Querverweis im Inbox waere nett, braucht aber
`task_id` pro Thread in der Mailbox-Antwort; das lohnt den Umbau nicht,
solange die Karte die Konversation ohnehin zeigt.

## 4. Phase C — ein Schreiber fuer den Status

**Problem.** `OrgStore.updateTask` ist ein Spaltensetter. Sechs Aufrufer
schreiben Status, jeder mit eigener Whitelist, und die Nebenwirkungen
unterscheiden sich pro Aufrufer: die HTTP-Route prueft Konflikte und schreibt
eine Statusnotiz, das Tool `update_task` tut beides nicht, das CLI erzeugt
nicht einmal ein Ereignis. Ob der Mail-Thread erfaehrt, dass eine Aufgabe
fertig ist, haengt davon ab, welcher Prozess sie geschlossen hat.

**Entscheidung E6.** Ein Pfad: `OrgController.setTaskStatus(task, to, by)`.
Er enthaelt den Uebergangs-Guard, den atomaren Claim
(`UPDATE ... WHERE status != 'running'`, nur bei `changes === 1` weiter), das
Nullen von `finishedAt`/`result`/`error` beim Eintritt in einen
nicht-terminalen Status, das Ereignis und `notifyTaskStatus`. Tool, Route, CLI
und Run-Loop rufen nur noch das.

**Entscheidung E7.** Keine ausgeschriebene Uebergangstabelle — bewusst.
`setTaskStatus` prueft drei Dinge und laesst sonst jeden Uebergang zu:
derselbe Status ist ein No-op, eine laufende Karte darf von aussen nur
abgebrochen werden, und ein Agent darf eine Nutzerkarte nicht abschliessen
(O3). Eine vollstaendige Matrix haette die wirklichen Fehler nicht gefangen
und dafuer legitime Wege verboten, die es heute gibt — eine Antwort im Thread
setzt eine `done`-Karte wieder in Gang, und genau das soll sie duerfen.

Was der Uebergang sehr wohl regelt, ist das Aufraeumen: `done -> open` ist
ein Wiedereroeffnen und loescht `finishedAt`, `result` und `error`, sonst
rechnet jede Dauer-Anzeige und die "laeuft zu lange"-Heuristik mit Zahlen aus
einem frueheren Leben. `blocked` ist davon ausgenommen — eine wartende Karte
traegt ihre Frage und ihr Zwischenergebnis weiter.

**O3, entschieden und umgesetzt: nein.** `setTaskStatus` weist `done` und
`cancelled` zurueck, wenn ein Agent sie auf eine Karte mit
`createdBy === 'user'` schreiben will. Ein Agent meldet, der Mensch
schliesst ab. `blocked` bleibt ihm offen — eine Frage zu stellen ist kein
Abschliessen —, und ein Lauf, der sein eigenes Ergebnis eintraegt, geht
ueber `fromRun` und ist nicht betroffen. Vorher konnte ein Agent eine Karte
des Nutzers abhaken oder verwerfen, und der Nutzer merkte es daran, dass sie
weg war.

---

## 5. Phase D — die Reste, aufgeraeumt

Was beim Umbau als "loest dieses Dokument nicht" notiert war, ist am
2026-09-22 nachgezogen worden:

- **Keine eingefrorene Karte mehr.** `#runTask` liegt vollstaendig in einem
  `try/catch` (der Rumpf in `#runTaskBody`): eine Ausnahme irgendwo zwischen
  Planung und Ergebnis beendet die Karte mit dem Grund, statt sie auf
  `running` stehen zu lassen — ein Zustand, in dem sie weder abbrechbar noch
  editierbar war und nur ein Neustart sie loeste. Schlaegt selbst der
  Statusschreiber fehl, wird die Spalte direkt gesetzt. `#runSubtask` hat
  dieselbe Klammer.
- **Teilaufgaben sind einzeln abbrechbar.** `#runSubtask` registriert einen
  eigenen `AbortController` in `#activeTasks`, so wie die Elternaufgabe. Ein
  haengendes Kind einer Fuenffach-Teilung liess sich vorher ueberhaupt nicht
  stoppen: `cancelTask(childId)` fand nichts, und alle drei Schreiber
  verweigern eine laufende Karte.
- **Das Journal sagt die Wahrheit.** `turns.settle` bekommt den echten
  Ausgang; `done` nur noch fuer einen Lauf, der auch `done` endete. Vorher
  las ein Client nach einem Reload einen sauberen Abschluss, waehrend die
  Assignment-Zeile `failed` sagte.
- **Turns haben eine Obergrenze.** `turns.timeoutMs`, Default eine Stunde.
  Lauf und Zeitplan hatten je einen Stopp, ein Gespraech keinen — und ueber
  `POST /api/chat`, das kein Signal durchreicht, war ein Turn in einer
  Tool-Schleife von aussen nicht zu beenden. Das Signal des Aufrufers gilt
  weiter und gewinnt; dies ist nur der Boden darunter.
- **Der Sleep-Job leckt nicht mehr.** `onCron` in `server.ts` filtert
  `kind === 'sleep'`, wie `gateways/push.ts` es an derselben Stelle laengst
  tat. Vorher wurde eine Zeile live in die Cron-Tabelle gemischt, die
  dieselbe API per 404 fuer nicht existent erklaert.

**Weiterhin offen, bewusst:** ein Token- oder Toolaufruf-Budget pro Turn. Die
Zeit ist gedeckelt, die Kosten sind es nicht. Das braucht eine Zaehlung im
Turn-Loop und eine Entscheidung, was beim Erreichen passiert (abbrechen oder
nur melden) — eine eigene Aenderung, kein Nachtrag zu dieser.

---

## 6. Was im selben Paket mitkam, aber nicht hierher gehoert

Drei Aenderungen aus derselben Sitzung gehoeren zu
`agent-performance-management.md` und sind dort noch nicht nachgetragen:

- **`org.autoReconfig`, Default aus.** Eine Eskalation der Stufe 2 schreibt
  die Standing Instructions eines Agenten nicht mehr selbst um, sondern legt
  sie als `reconfig-proposal` ab; `applyReconfig` und
  `POST /api/org/agents/:id/reconfig/:actionId` machen daraus eine echte
  `reconfig`, sobald ein Mensch zustimmt. **Nebenwirkung, die dort
  entschieden gehoert:** `stageFromReviews` oeffnet das Bewaehrungsfenster
  nur bei `kind === 'reconfig'`, also ist Stufe 3 (Ersetzungsvorschlag) ab
  jetzt nur noch ueber eine Zustimmung des Nutzers erreichbar. Vertretbar —
  ein Ersetzungsvorschlag nach einer Nachschaerfung, die nie stattfand, waere
  unfair — aber eine Entscheidung, keine Folge.
- **`org.maxTaskRuns`, Default 3.** Eine Decke fuer Neulaeufe, die die
  Maschine selbst anstoesst (heute nur die Antwort eines Agenten im
  Task-Thread). Ein Mensch wird nie dagegen gezaehlt.
- **`org.autoReview` ist schaltbar geworden.** Der Wert existierte nur als
  Code-Konstante und fehlte in `orgConfigSchema` wie in der Settings-Seite.
