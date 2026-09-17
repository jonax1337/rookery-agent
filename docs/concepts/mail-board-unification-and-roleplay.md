# Der Thread ist der Vorgang: Mail, Board und Rollenspiel zusammengefuehrt

Stand: 2026-09-17. **Konzept, nicht umgesetzt.**

Die Organisationsstruktur funktioniert einzeln und scheitert im Zusammenspiel.
Ein Auftrag an einen Agenten entsteht heute auf vier Wegen, und jeder Weg
hinterlaesst ein anderes Ergebnis: manchmal eine Karte auf dem Board, manchmal
nur einen Lauf, manchmal einen Mail-Thread ohne Karte. Antwortet man in einen
solchen Thread, startet ein zweiter Lauf neben dem Task, den niemand mehr dem
Task zuordnet. Niemand beobachtet das Board, weil die einzige Stelle, die eine
Statusnotiz schreibt, eine HTTP-Route ist, die nur der Nutzer selbst ausloest.
Und die Mails klingen wie Changelogs, weil sie welche sind: derselbe Text geht
als `assignment.result` in die Datenbank und als Mail-Body an einen Menschen.

Dieses Dokument fuehrt die drei Begriffe auf einen zusammen, macht den Eingang
aus der Adresszeile ableitbar statt waehlbar, gibt dem Zustand "wartet auf
Antwort" eine Zeile in der Datenbank, stellt Jarvis einen sichtbaren Waechter
auf das Board, gibt Task und Lauf einen echten Namen statt des Prompts, raeumt
auf, wo etwas gerendert wird und wo etwas laeuft — und trennt zum Schluss den
Ton vom Inhalt, damit Kollegen einander Briefe schreiben statt Release Notes.

Beruehrt wuerden vor allem `packages/core/src/org/controller.ts`,
`org/store.ts`, `org/prompts.ts`, `org/tools.ts`, `packages/core/src/types.ts`,
`packages/core/src/memory/db.ts` (zwei Spalten, `SCHEMA_VERSION` 21 nach 23),
`packages/core/src/cron/scheduler.ts` (der Waechter als Ereignis-Job),
`packages/server/src/routes/org.ts` sowie in `packages/web` die Inbox-, Task-
und Agenten-Seiten.

Verwandte Konzepte: `event-triggers-and-listeners.md` (umgesetzt; der Waechter
in Abschnitt 5 laeuft vollstaendig auf dieser Maschinerie),
`agent-performance-management.md` (umgesetzt; E4 dort entscheidet, dass ein
Nachfolger eine eigene Identitaet bekommt — Abschnitt 6.4 hier schliesst daran
an), `telegram-channel.md` (der Weg, auf dem eine Mail an den Nutzer wirklich
einen Menschen erreicht).

---

## 1. Befund

Fuenf Befunde, alle am Code belegt. Zwei sind Defekte, drei sind
Modellfehler.

### 1.1 Vier Eingaenge, vier verschiedene Ergebnisse

Was entsteht, haengt nicht davon ab, was der Nutzer will, sondern davon, wo er
hineingeht:

| Eingang | Task | Thread | Lauf |
| --- | --- | --- | --- |
| Compose-Schalter "Task" (`web/src/pages/InboxPage.tsx:88`) auf `sendTaskMail` | ja, verlinkt | `assignment` | `runTask` |
| Compose-Schalter "Mail" an einen Agenten, To-Trigger | **nein** | `chat` | nacktes `run()` |
| Jarvis' `assign`-Tool (`org/tools.ts:73`) | **nein** | **keiner** | nacktes `run()` |
| `create_task` + `run_task` | ja | **keiner** | `runTask` |

Das ist der Kern der Klage "mal wird ein Task angelegt, dann mal nur ein
Assignment". Es ist kein Fehler in einer dieser Zeilen, sondern vier Pfade, die
nie zusammengefuehrt wurden. Dass der Nutzer den Unterschied im
Compose-Fenster selbst waehlen muss, macht ihn nicht transparenter, sondern
verlagert eine Modellentscheidung in einen Schalter.

### 1.2 Die Trigger-Entscheidung liest den falschen Wert (Defekt)

`controller.ts:1481` entscheidet ueber den To-Trigger so:

```
if (!params.autoReply && params.kind !== 'assignment' && params.depth < ...)
```

`params.kind` ist der Aufrufparameter, nicht die Wahrheit ueber den Thread.
Die Wahrheit steht in `mail_threads.kind`, wird beim ersten Mail eines Threads
per `INSERT OR IGNORE` festgeschrieben (`store.ts:601`) und liegt dem Aufrufer
unmittelbar vor: `store.sendMail` gibt sie als `mail.threadKind` zurueck.

`sendUserMail` uebergibt kein `kind`. Antwortet der Nutzer also in einen
Assignment-Thread, ist `params.kind === undefined`, die Bedingung greift, und
der To-Trigger startet einen **zweiten Lauf neben dem Task**. Dieser Lauf
haengt an keinem Task und taucht auf keiner Karte auf. Die Antwort des Agenten
kommt zurueck — `sourceMail` ist gesetzt, der Thread liest sich plausibel —,
aber der Task bewegt sich nicht mehr. Genau das ist "es geht nicht wieder
zurueck": es kommt eine Antwort zurueck, nur eben nicht der Vorgang.

### 1.3 "Wartet auf Antwort" existiert nicht

`TaskStatus` (`types.ts:1181`) kennt `open`, `planned`, `running`, `done`,
`failed`, `cancelled`. Ein Agent, der eine Rueckfrage stellt, hat davon keinen
passenden Zustand. Sein Lauf endet `done`, die Frage steht im `result`, und die
Karte ist erledigt, obwohl nichts erledigt ist. Dazu passt, dass jede
automatische Antwort `autoReply: true` traegt und deshalb niemanden weckt —
richtig gegen Endlosschleifen, aber es heisst, dass eine Rueckfrage in einer
Mailbox liegt und sonst nirgends.

### 1.4 Niemand schaut auf das Board (Defekt der Zustaendigkeit)

`notifyTaskStatus` hat genau einen Aufrufer:
`packages/server/src/routes/org.ts:455` — der `PATCH` auf einen Task, also der
Nutzer, der im UI einen Status umstellt. Ein Task, den ein Lauf selbst
abschliesst, schreibt **keine** Statusnotiz in seinen Thread. Ein Task, der
`failed` endet, schreibt gar nichts; der Thread schweigt, und der Nutzer
erfaehrt vom Scheitern nur, wenn er das Board oeffnet.

Jarvis selbst wird wach, wenn (a) der Nutzer schreibt, (b) eine Mail ihn auf To
hat (`controller.ts:1484`), (c) ein Zeitplan feuert. Es gibt keinen Wach-Grund
"auf dem Board stimmt etwas nicht". Die Maschinerie dafuer ist seit
`event-triggers-and-listeners.md` vorhanden und ungenutzt.

### 1.5 Rollenspiel ist im Prompt ausdruecklich verboten

`org/prompts.ts`, im Agentenprompt, woertlich:

> "Your output is a report to whoever assigned it, not a chat with the user:
> lead with the result, then what you changed or found, then open questions.
> No preamble, no restating the task."

> "What it is not for is thinking out loud or saying thank you - every mail you
> send costs somebody a run."

Und in `run()` (`controller.ts:2108`–2125) geht derselbe `text` als
`assignment.result` in die Datenbank **und** als `body` in die Mail. Die Mails
sind also keine Mails, sondern Berichte mit einem Briefkopf. Dazu fehlt dem
Datenmodell die Voraussetzung fuer alles andere: `Agent` (`types.ts:927`) hat
`name`, `title`, `instructions` — keine Stimme, kein Register, keine Beziehung
zu Kollegen.

---

## 2. Kontrolliertes Vokabular

Die Klage "sehr un transparent" ist zu einem guten Teil eine Klage ueber
Woerter. Der Assistentenprompt gibt das heute selbst zu, indem er dem Nutzer
den Unterschied erklaeren muss:

> "Two words to keep apart when you talk to the user: an assignment is one
> agent running one brief, with a result; a task is an item on the board that
> gets planned and then executed as one or more assignments."

Ein Satz, der zwei Woerter auseinanderhalten muss, ist ein Symptom. Nach
diesem Konzept gilt:

| Wort | Bedeutung | Im Code | Sichtbar fuer den Nutzer |
| --- | --- | --- | --- |
| **Task** | Ein Vorgang. Eine Karte auf dem Board *und* der Mail-Thread, in dem er verhandelt wird. Untrennbar. | `tasks`-Zeile + `mail_threads`-Zeile mit `task_id` | ja, ueberall |
| **Lauf** | Ein Prozess, der einmal gestartet wird und einmal endet. Ein Task hat einen oder mehrere. | `Assignment` | nur in der Historie eines Tasks |
| **Gespraech** | Ein Mail-Thread ohne Task. Fragen, Absprachen, Hinweise. | `mail_threads.kind = 'chat'` | ja, als Ordner "Inbox" |
| **Bericht** | Ein Thread, den ein Lauf oder ein Zeitplan von selbst eroeffnet hat. | `mail_threads.kind = 'report'` | ja, als Ordner "Reports" |

Der Typname `Assignment` bleibt im Code; ihn umzubenennen betrifft Schema, API
und UI und kauft nichts. Was verschwindet, ist das Wort **auf jeder
Oberflaeche und in jedem Prompt**: Jarvis spricht nur noch von Tasks, und ein
Lauf ist ein Detail, das im Task-Detail sichtbar wird. Der zitierte Absatz aus
dem Assistentenprompt wird geloescht, nicht praezisiert.

---

## 3. Ein Eingang

### 3.1 Die Adresszeile entscheidet, nicht ein Schalter

Eine Regel, in einem Satz: **Genau ein Agent auf To eroeffnet einen Task.
Alles andere ist ein Gespraech.**

Daraus folgt alles Weitere ohne weitere Fallunterscheidung:

- Ein Agent auf To (Cc beliebig) → Thread `assignment`, Task angelegt,
  verlinkt, Ausfuehrung ueber `runTask`. Das ist heute `sendTaskMail`.
- `assistant` auf To → Gespraech mit Jarvis, wie heute (`#runAssistantMail`).
- `user` auf To → Gespraech.
- Mehrere Empfaenger auf To → Gespraech. Die Agenten darunter werden geweckt
  wie heute, aber es entsteht keine Karte.

Der Schalter `composeMode` in `InboxPage.tsx:88` und das Feld `mode` im Schema
von `POST /api/org/mail` (`routes/org.ts:525`) entfallen beide. An ihre Stelle
tritt ein abgeleiteter Hinweis unter der To-Zeile, der mitlaeuft, waehrend man
Empfaenger hinzufuegt:

- "This opens a task for @backend-dev." — ein Agent auf To
- "This is a conversation with 3 people. No task is created." — sonst

Das ist der Transparenzgewinn: der Nutzer sieht, was passieren wird, bevor er
sendet, statt es zu waehlen und sich danach zu erinnern, was er gewaehlt hat.

Warum kein Fan-out bei mehreren Agenten auf To: Aufteilen ist die Aufgabe des
Planers. `plan_task` erzeugt dafuer einen Eltern-Task mit Kindern,
Abhaengigkeiten und Wellen — ein Board-Konstrukt mit Zusammenfassung am Ende.
Drei Karten aus einer Adresszeile zu erzeugen waere ein zweiter, schwaecherer
Aufteilungsmechanismus neben einem guten.

### 3.2 Die Thread-Zeile ist die Wahrheit

`#deliverMail` entscheidet den To-Trigger nicht mehr ueber `params.kind`,
sondern ueber `mail.threadKind` — den Wert, den `store.sendMail` ohnehin
zurueckgibt (Befund 1.2). Damit ist ein Thread, der als Task eroeffnet wurde,
fuer immer ein Task-Thread, egal wer und mit welchen Parametern
hineinschreibt.

### 3.3 Eine Antwort setzt fort, sie startet nie neu

Trifft eine Mail in einem Thread mit `kind = 'assignment'` und gesetzter
`task_id` ein, entscheidet der Status des Tasks:

| Task-Status | Was passiert |
| --- | --- |
| `running` | Nur zustellen. Der laufende Lauf sieht die Mail nicht mehr; sie liegt in der Inbox des Agenten und geht per `renderMail` in den Prompt des naechsten Laufs ein. |
| `blocked`, `done`, `failed`, `cancelled` | Fortsetzen: Status zurueck auf `running`, ein neuer Lauf desselben Zustaendigen mit dieser Mail als `sourceMail`, per `linkTaskAssignment` an **denselben** Task gehaengt. `result` wird erst ueberschrieben, wenn der neue Lauf fertig ist. |
| `open`, `planned` | Fortsetzen wie oben; faktisch der normale Start. |

`task_assignments` ist bereits eine n:m-Tabelle mit
`PRIMARY KEY (task_id, assignment_id)` und einem Index auf
`(task_id, created_at DESC)` — die Kette mehrerer Laeufe an einem Task ist also
schon vorgesehen und wird hier erstmals wirklich benutzt.

Was damit verschwindet: der board-lose Parallellauf aus Befund 1.2. Eine
Antwort kann keinen Lauf mehr erzeugen, der keinem Task gehoert.

---

## 4. `blocked`: der Zustand, der fehlt

`TaskStatus` bekommt den Wert `'blocked'`. Die Spalte ist
`status TEXT NOT NULL DEFAULT 'open'` ohne `CHECK` (`db.ts:601`), es ist also
eine reine Typ- und Prompt-Aenderung, keine Schema-Aenderung.

**Gesetzt wird er vom Controller, nicht vom Agenten.** Die Regel ist
deterministisch und braucht keine Kooperation des Modells: Endet der Lauf eines
Task-Blatts und hat der Agent **waehrend** dieses Laufs eine Mail an seinen
Auftraggeber auf die To-Zeile geschrieben, endet der Task `blocked` statt
`done`.

Der Detektor dafuer existiert: `#answeredDuringTurn` (`controller.ts:1391`)
prueft genau das und wird heute schon benutzt, um die doppelte automatische
Antwort zu unterdruecken. Zwei Praezisierungen sind noetig:

1. Er prueft heute alle Empfaenger einer gesendeten Mail, also auch Cc. Fuer
   `blocked` zaehlt nur To: ein Cc an den Auftraggeber ist eine Information,
   keine Frage.
2. Mail an **Kollegen** zaehlt nicht — der Detektor vergleicht ohnehin nur
   gegen den Auftraggeber, Delegation bleibt also unberuehrt.

Warum das trotz seiner Grobheit richtig ist: Der Agentenprompt verbietet Mails,
die nur aus Hoeflichkeit oder Nachdenken bestehen. Der uebrige Grund, mitten im
Lauf an den Auftraggeber zu schreiben, ist eine Frage oder eine Uebergabe —
beides Gruende, den Task sichtbar wartend stehen zu lassen. Und der Fehler
faellt in die sichere Richtung: ein faelschlich `blocked` markierter Task steht
auf dem Board und wird von der naechsten Antwort weitergefuehrt (3.3),
waehrend ein faelschlich `done` markierter Task verschwindet. Genau das
passiert heute.

Zusaetzlich darf ein Agent `blocked` selbst setzen: `update_task` hat schon
`audience: BOTH` (`tools.ts:493`). Der Prompt erwaehnt es als Moeglichkeit,
verlaesst sich aber nicht darauf.

**Kein Grund-Feld.** Der Grund ist die Mail. Eine zweite Kopie in
`tasks.blocked_reason` koennte veralten; das Board zeigt stattdessen die letzte
Mail des Threads. Deshalb kommt in diesem Konzept genau eine Spalte neu hinzu,
und die gehoert zum Rollenspiel (Abschnitt 6.2).

### 4.1 Statusnotizen entstehen im Lauf, nicht in der Route

`notifyTaskStatus` wandert aus `routes/org.ts` in das `finish()` von
`#runTask` und nimmt `'done' | 'failed' | 'cancelled' | 'blocked'`. Die Route
ruft es weiterhin fuer die Handaenderung des Nutzers.

Die Notiz wird nur geschrieben, **wenn der Thread sonst nichts von diesem
Abschluss gehoert hat**. Ein Satz, der alle Faelle abdeckt:

- `done` mit Ergebnis-Antwort → die Antwort ist die Nachricht, keine Notiz.
- `blocked` → die Rueckfrage des Agenten ist die Nachricht, keine Notiz.
- `failed`, `cancelled` → heute schweigt der Thread, ab hier steht die Notiz
  drin. Das ist die Luecke aus Befund 1.4.

---

## 5. Wer schaut hin: der Waechter

Jarvis bekommt das Board als stehenden Auftrag — und zwar **als sichtbaren
Zeitplan, nicht als versteckte Schleife.** Beim ersten Start einer
Organisation wird eine `cron_jobs`-Zeile geseedet:

- `id`: `'board-watch:' + orgId`, damit sie wiederfindbar ist (Cron-Ids sind
  sonst Zufallswerte, `types.ts:1259`)
- `kind: 'assistant'`, `triggerMode: 'schedule'` mit einem weiten Ausdruck
  (Vorschlag: alle 30 Minuten) und zugleich ereignisfaehig — genau die dritte
  Sorte Job, die E1 von `event-triggers-and-listeners.md` als die interessante
  beschreibt: das Ereignis ist der schnelle Weg, die Uhr die Rueckfallebene
  fuer das Ereignis, das nicht kam.
- `eventCooldownMs`: Standard (60 000 ms), damit zehn Task-Ereignisse in einer
  Minute einen Lauf ergeben und nicht zehn.
- `prompt`: was zu tun ist, in Jarvis' eigenen Worten formuliert.

Gefeuert wird per `scheduler.runEvent(id, source)` aus einem Abonnenten der
`task`-Ereignisse, die `#announceTask` (`controller.ts:2668`) ohnehin emittiert
— und zwar nur bei den Uebergaengen, die Aufmerksamkeit verdienen: nach
`failed` und nach `blocked`. Die Uhr faengt den Rest: Tasks, die laenger als
`org.assignmentTimeoutMs` `running` sind, und Tasks, die laenger als eine
gesetzte Frist `blocked` stehen.

Was der Lauf darf: umverteilen, nachfassen, einen Task neu starten, den Nutzer
**einmal** anmailen. Was er nicht darf: berichten, dass alles in Ordnung ist.
Dafuer gibt es das Sentinel `[SILENT]`, das der Zeitplan-Pfad schon kennt — und
zwar per Trailing-Token, nicht per Exact-Match auf die ganze Antwort, weil
Modelle die Begruendung davorstellen.

Das Abschalten des Waechters ist das Abschalten des Zeitplans, im selben UI wie
bei jedem anderen. Deshalb braucht er keinen Konfigurationsschluessel.

---

## 6. Rollenspiel

### 6.1 Warum die Mails Changelogs sind

Nicht weil die Agenten unfaehig sind, Briefe zu schreiben, sondern weil zwei
Dinge zusammenfallen, die verschiedene Leser haben: `assignment.result` liest
eine Maschine (und Jarvis, der zusammenfasst), den Mail-Body liest ein Mensch.
Heute ist es ein Feld (Befund 1.5), und der Prompt optimiert es fuer den
ersten Leser.

### 6.2 `voice` als eigenes Feld

`agents` bekommt eine Spalte `voice TEXT` (nullable), `Agent` das entsprechende
Feld. Migration nach dem bestehenden Muster: `hasColumn` plus `ALTER TABLE`,
`SCHEMA_VERSION` 21 nach 22.

Inhalt: zwei bis vier Saetze darueber, **wie** diese Person schreibt — nicht,
was sie kann. Das gehoert nicht in `instructions`, weil `instructions` in jedem
Lauf die Arbeit steuert, die Stimme aber nur die Ausgabe faerbt; in einem Feld
vermischt wuerde das eine das andere verwaessern.

Gesetzt wird sie bei `hire_agent` — Jarvis erfindet sie, wenn der Nutzer nichts
sagt — und ist im Agenten-Formular editierbar. Leer heisst neutral, also das
heutige Verhalten.

### 6.3 Ein Lauf, zwei Register

`buildAgentPrompt` verzweigt bereits ueber `input.sourceMailSubject`. Diese
Verzweigung bekommt Gewicht:

- **Als Mail geboren** (`sourceMailSubject` gesetzt): Die Ausgabe *ist* ein
  Brief an einen Kollegen. Anrede, ein Satz Kontext, das Ergebnis, eine Haltung
  dazu, Grussformel. In der eigenen Stimme.
- **Per `assign` geboren**: Der heutige Absatz bleibt unveraendert. Ein
  Werkzeugaufruf, dessen Rueckgabe Jarvis weiterverarbeitet, braucht keine
  Anrede.

Derselbe Text bleibt `assignment.result`. **Es gibt keinen zweiten
Modellaufruf**, keine Umformulierung, keinen Trennmarker im Text, den man
parsen muesste — Marker in Modellausgaben sind fehleranfaellig, und hier
braucht es keinen.

Der Absatz "every mail you send costs somebody a run" bleibt, wird aber auf
das gerichtet, was er meint: eine Mail, deren **ganzer Inhalt** Hoeflichkeit
ist, wird nicht gesendet. Ueber den Ton einer Mail, die etwas zu sagen hat,
sagt er nichts mehr.

### 6.4 Kollegen kennen einander

Ein Agent bekommt die `voice` **seines Teams und seines Vorgesetzten** in den
Prompt, nicht die der ganzen Firma: eine Firma mit zwanzig Agenten wuerde sonst
zwanzig Stimmbeschreibungen in jeden Lauf tragen, von denen neunzehn nichts zur
Sache tun.

Zum HR-Konzept: Nach E4 dort bekommt ein Nachfolger einen eigenen Namen und
Slug, weil Agenten als Personen mit eigener Geschichte wahrgenommen werden
sollen. Konsequent erbt er die Stimme des Vorgaengers **nicht**. Er bekommt
eine neue, und das Uebergabedokument (E3 dort) sagt ihm, mit wem er es zu tun
hat.

### 6.5 Was Rollenspiel nicht heisst

Die Grenze gehoert in den Prompt, sonst wird aus Ton Theater:

- Keine erfundenen Privatleben, keine Wochenenden, keine Kaffeepausen.
- Keine gespielte Verzoegerung, kein "ich schaue mir das gleich an" ohne Arbeit
  dahinter. Ein Lauf arbeitet oder er antwortet.
- Das Ergebnis steht im ersten Absatz. Hoeflichkeit rahmt, sie verzoegert
  nicht. Ein Brief, in dem man das Ergebnis suchen muss, ist schlechter als der
  Bericht, den er ersetzt.
- Keine Behauptung ueber Arbeit, die nicht stattgefunden hat. Der bestehende
  Absatz gegen unverdiente Sackgassen und unbelegte Ergebnisse bleibt
  wortgleich.

---

## 7. Namen, Vorschauen und Live-Output

### 7.1 Der Prompt ist kein Name

`Task` hat ein `title`, und bei einem als Mail geborenen Task ist es das
Betreff — ein Mensch hat es geschrieben, das ist ein echter Name. Ueberall
sonst faellt der Name aus:

- `Assignment` hat **gar kein** Titelfeld (`types.ts:953`–967). Was so
  aussieht, heisst `task` und ist der vollstaendige Auftragstext. Deshalb
  steht in jeder Liste der Prompt: `renderOrgOverview` schreibt
  `clip(assignment.task, 120)` in den Assistentenprompt,
  `AssignmentsPage.tsx:1017` rendert `{row.task}` als Absatz, und
  `describeAssignment` zeigt `clip(assignment.task, 400)`.
- Nach E9 legt jedes `assign` einen Task an. Ohne Regel waere dessen Titel
  ebenfalls der Prompt — der vierte Eingang waere geschlossen und der
  Namensfehler dafuer verdreifacht.

Ein Prompt als Name ist in jeder Liste unlesbar und in keiner Liste
unterscheidbar: drei Auftraege an denselben Agenten beginnen mit denselben
zwanzig Woertern, und die Karte, die sie auseinanderhalten soll, zeigt genau
diese zwanzig Woerter.

### 7.2 Beide bekommen einen echten Namen

`assignments` bekommt eine Spalte `title TEXT`. Im Typ ist `Assignment.title`
Pflicht, in der Spalte nicht — Altbestand hat keinen und bekommt ihn nach der
Regel unten beim Lesen.

Wer den Namen schreibt, in dieser Reihenfolge; die erste Quelle, die etwas
liefert, gewinnt:

1. **Der Aufrufer.** `assign` und `create_task` bekommen `title` als
   verpflichtenden Parameter. Jarvis und jeder delegierende Agent kennen den
   Auftrag in dem Moment, in dem sie ihn formulieren; sie sind die richtigen
   Autoren, und es kostet keinen zusaetzlichen Aufruf.
2. **Das Mail-Betreff** bei einem als Mail geborenen Task. Schon ein Name, von
   einem Menschen geschrieben, und derselbe Text, unter dem der Thread laeuft.
3. **Der Name des Zeitplans** (`CronJob.name`) bei einem geplanten Lauf. Ein
   wiederkehrender Job heisst jede Nacht gleich, und das ist richtig so.
4. **Die erste Zeile des Auftrags**, von fuehrenden Auszeichnungszeichen
   befreit (`#`, `-`, `>`, `*`) und auf 60 Zeichen geklemmt. Notnagel, und nie
   der ganze Prompt. Das ist eine lokale Regel fuer diesen einen Fall, keine
   allgemeine Flach-Funktion — ein Titel ist die einzige Stelle, an der
   Markdown wirklich stoert (siehe 7.3).

**Kein Modellaufruf zur Titelfindung.** Ein Name, fuer den man ein Modell
fragen muss, ist ein Name, den der Aufrufer nicht wusste — und dann stimmt
etwas mit dem Aufruf nicht, nicht mit dem Titel.

Stilregel, als Beschreibung am Tool-Parameter und im Prompt: drei bis acht
Woerter, kein Punkt am Ende, Substantiv- oder Befehlsform, in der Sprache des
Auftrags. "Login-Bug im Passwort-Reset" ja; "Bitte schau dir mal an, warum der
Login manchmal" nein.

Ein Lauf, der zu einem Task gehoert, **erbt dessen Namen** und wird in Listen
mit seiner Stelle in der Kette gezeigt ("Run 2"), statt einen eigenen zu
erfinden. Sonst heissen Task und Lauf verschieden, und niemand sieht, dass sie
dasselbe Ding sind — genau der Effekt, den Abschnitt 2 abschaffen soll.

### 7.3 Vorschauen werden als Markdown gerendert

Der Text, den ein Task oder ein Lauf traegt, **ist** Markdown: Agenten
schreiben Ueberschriften, Listen und Codespannen, und ein Auftragstext, den ein
Mensch tippt, sieht genauso aus. Wo dieser Text roh angezeigt wird, sieht man
`##` und `**` statt dessen, was sie bedeuten. **Jede Anzeige eines Task- oder
Lauftextes geht deshalb durch `ResultMarkdown`, die Vorschau eingeschlossen.**

Heute ist das uneinheitlich, und zwar andersherum, als man vermuten wuerde:
`TasksPage.tsx:728` rendert die Beschreibung einer Karte bereits als Markdown,
`AssignmentsPage.tsx:1017` und `AssignmentDetailPage.tsx:322` zeigen denselben
Sachverhalt als `whitespace-pre-wrap`, also roh. Das Problem ist nicht, dass zu
viel gerendert wird, sondern dass die Haelfte es nicht wird.

Zu klaeren bleibt, was "Vorschau" fuer einen Block-Renderer heisst: ein `<h1>`
sprengt eine Listenzeile, ein Codezaun sprengt eine Karte. Die Loesung ist
**ein Renderer mit einem kompakten Preset**, keine zweite Komponente.
`ResultMarkdown` nimmt bereits ein `className`-Override und formatiert ueber
Attributselektoren (`[&_h1]:...`, `[&_pre]:...`); genau dort setzt das Preset
an:

- Ueberschriften auf Fliesstextgroesse, nur die Auszeichnung bleibt — eine
  Ueberschrift in einer Karte ist eine fette Zeile, keine Schlagzeile.
- Blockabstaende zusammengezogen: kein `my-3` in etwas, das drei Zeilen hoch
  sein darf.
- Codezaeune bleiben Codezaeune, aber mit Hoehenbegrenzung.
- **Geklemmt wird das gerenderte Ergebnis, nicht der Text davor.** Eine
  Hoehenklemme mit weichem Auslauf auf dem Container; ein Markdown-Text, den
  man vorher mitten im Codezaun abschneidet, rendert den Rest der Karte als
  Code.

Damit faellt jede Sonderbehandlung weg: **kein eigenes Vorschaufeld** in der
API, keine Flach-Funktion im Kern, keine zweite Textquelle, die veralten kann.
Die Oberflaeche rendert das Feld, das sie ohnehin bekommt.

Die Prompts sind nicht betroffen. `renderBoard` und die Zeile "Running
assignments" in `renderOrgOverview` erzeugen Text fuer ein Modell, und ein
Modell liest Markdown ohnehin; dort wird weiterhin nur geklemmt.

Betroffen sind also ausschliesslich Stellen in `packages/web`:
Assignment-Liste und -Schublade (`AssignmentsPage.tsx:1017` und 1023), die
Auftragszeile der Detailseite (`AssignmentDetailPage.tsx:322`), `live-run-list`
mit `assignment.preview` — und die Task-Karten, die von vollem Markdown auf das
kompakte Preset wechseln.

### 7.4 Der Live-Output gehoert dem Lauf, nicht dem Agenten

Die Agentenseite zeigt heute zwei laufende Stroeme, die ihr nicht gehoeren:
einen Abschnitt "Live now" mit der Aktivitaetshistorie des gerade laufenden
Auftrags (`AgentDetailPage.tsx:615`–633) und eine `LiveRunList` in der
Schublade (`AgentDetailPage.tsx:850`–853).

Beide verschwinden. Ein Agent ist eine **Person mit einer Akte** — Rolle, Team,
Vorgesetzter, Stimme, Leistung, Historie. Was gerade durch die Leitung laeuft,
ist keine Eigenschaft der Person, sondern eines Vorgangs, und ein Vorgang hat
seit Abschnitt 2 genau eine Seite, auf der er stattfindet. Ein zweiter Ort, an
dem derselbe Strom laeuft, ist wieder die Frage "wo schaue ich eigentlich hin",
die dieses Dokument abschaffen soll.

Was auf der Agentenseite **bleibt**, ist der Zeiger: eine ruhige Zeile "works
on <Taskname>", verlinkt auf den Task. Man sieht, dass jemand beschaeftigt ist,
und man geht dorthin, wo die Arbeit ist. Kein Strom, keine Aktivitaetsliste,
kein Abbrechen-Knopf aus der Ferne.

Bei mehreren gleichzeitigen Tasks wird daraus eine kurze Liste, eine Zeile je
Task — und es braucht **keine erfundene Kuerzungsgrenze**, weil es schon eine
echte gibt: `org.maxConcurrentAssignments` (Standard 4, `config.ts:192`)
begrenzt, wie viele Laeufe ueberhaupt gleichzeitig existieren. Die Liste ist
also von sich aus kurz. Erst wenn jemand die Einstellung hochdreht, fasst sie
ab der fuenften Zeile zu "+N more" mit Link auf das nach diesem Agenten
gefilterte Board zusammen. Laeuft nichts, **fehlt die Zeile ganz** — eine
Seite, die "idle" behauptet, sagt weniger als eine, die schweigt.

Daneben gehoert, still und einzeilig, die Zahl der auf diesen Agenten
wartenden `blocked` Tasks, verlinkt auf dasselbe gefilterte Board. Auf einer
Personenseite ist "woran haengt hier etwas" die Frage, die man wirklich hat.

Der Live-Output lebt danach in `AssignmentDetailPage`, `AssignmentsPage` und
`TaskDetailPage` — dort steht `AssignmentTerminal` bereits. Eine bewusste
Ausnahme bleibt `ChatPage.tsx:410`: wer in diesem Gespraech gerade delegiert
hat, darf den Lauf im selben Gespraech mitlesen, ohne die Seite zu wechseln.
Das ist kein zweiter Ort fuer fremde Vorgaenge, sondern die Quittung auf die
eigene Anweisung.

### 7.5 Das Terminal ist ein Terminal

`AssignmentTerminal` heisst so, sieht aber nicht so aus. Es ist eine `Card` mit
`CardHeader` und `CardTitle`, in zwei `Fade`-Effekte gewickelt, mit
`RunningBadge`, mit den aufklappbaren `ToolCall`-Elementen des Chats und mit
`ResultMarkdown` fuer jeden Textblock — ausdruecklich "the visual language of
the chat", wie der Kommentar der Komponente selbst sagt.

Das soll ein Terminal werden, und Terminal heisst hier woertlich:

- **Monospace, eine Spalte, chronologisch.** Keine Karte, kein Rahmen, keine
  Ueberschrift, keine Badges, keine Ein- und Ausblendeffekte. Ein dunkler
  Block mit Text darin.
- **Kein Markdown im Transkript.** Das ist die eine Ausnahme zu E18, und sie
  ist keine: E18 gilt fuer Task- und Lauf*texte* — den Auftrag, die
  Beschreibung, das Ergebnis. Das Live-Transkript ist kein Dokument, sondern
  ein Mitschnitt von Ereignissen. Ein Mitschnitt wird nicht gesetzt, er wird
  ausgegeben. Das fertige Ergebnis derselben Arbeit bleibt Markdown, an seinem
  Platz auf der Detailseite.
- **Werkzeugaufrufe bleiben sichtbar, als Zeile statt als Widget.** Ein Aufruf
  ist eine Zeile mit Name und Argument; sein Ergebnis oeffnet sich darunter im
  selben Monospace-Block. Was verschwindet, ist das `ToolCall`-Element des
  Chats mit Karte und Rahmen, nicht die Information — ein Terminal, in dem man
  nicht sieht, was das Werkzeug zurueckgegeben hat, ist ein Fortschrittsbalken.
- **Es scrollt mit und man kann es anhalten.** Ein Terminal, das beim Lesen
  wegspringt, ist unbrauchbar; das ist die einzige Bequemlichkeit, die bleibt.

Nebenbefund, der hier mitgeht: die Komponente enthaelt deutsche UI-Strings
("Warte auf den ersten Output …", "Der Lauf ist beendet.",
`assignment-terminal.tsx:145`–149). Alle UI-Texte des Projekts sind englisch;
bei dieser Gelegenheit werden sie es auch.

---

## 8. Datenmodell

Zwei Spalten, in zwei verschiedenen Phasen:

```
-- packages/core/src/memory/db.ts, nach dem bestehenden hasColumn-Muster
if (!hasColumn(db, 'assignments', 'title')) {     -- Phase 2, Abschnitt 7.2
  db.exec("ALTER TABLE assignments ADD COLUMN title TEXT");
}
if (!hasColumn(db, 'agents', 'voice')) {          -- Phase 4, Abschnitt 6.2
  db.exec("ALTER TABLE agents ADD COLUMN voice TEXT");
}
```

`SCHEMA_VERSION` steigt zweimal um eins (21 nach 22 nach 23), je einmal pro
Phase und in der Reihenfolge, in der die Phasen landen.

Ohne Schema-Aenderung, nur als Typ und Verhalten:

- `TaskStatus` bekommt `'blocked'`. Die Spalte hat kein `CHECK`.
- `mail_threads` unveraendert; `kind` und `task_id` tragen bereits alles.
- `task_assignments` unveraendert; die Mehrfachkette ist schon moeglich.
- `ToolContext` bekommt ein optionales `taskId`, damit `assign` weiss, unter
  welchem Task es haengt (Abschnitt 9).
- `AssignmentView` bekommt `title`. Ein Vorschaufeld kommt **nicht** dazu:
  `preview` gibt es dort schon (`types.ts:994`), und gerendert wird nach 7.3
  der Text selbst.
- Der Waechter ist eine `cron_jobs`-Zeile, kein Schema.

---

## 9. Tools, Prompts, API, Web

**Tools** (`org/tools.ts`)

- `assign` legt ab jetzt ebenfalls einen Task an und bleibt synchron: der
  Aufrufer bekommt weiterhin den Bericht zurueck. Laeuft der Aufruf innerhalb
  eines Tasks (neues `ToolContext.taskId`, gesetzt von `#runTaskLeaf`), wird
  der neue Task ein **Kind** davon. Damit ist auch eine Delegationskette auf
  dem Board sichtbar, als Baum statt als Rauschen — und der vierte Eingang aus
  Befund 1.1 ist geschlossen.
- `assign` und `create_task` bekommen `title` als verpflichtenden Parameter,
  mit der Stilregel aus 7.2 als Beschreibung.
- `update_task` nimmt `blocked` als Status an.
- `send_mail`, `read_mail`, `read_mail_thread`: Form unveraendert.

**Prompts** (`org/prompts.ts`)

- Der Absatz "Two words to keep apart" wird geloescht (Abschnitt 2).
- Der Mail-Absatz des Assistentenprompts erklaert nicht mehr den Unterschied
  zwischen `assign` und Mail-an-To, weil es keinen mehr gibt.
- Der Mail-Absatz des Agentenprompts bekommt die Regel aus 6.3 und die Grenzen
  aus 6.5.
- `renderBoard` zeigt `blocked` und, bei wartenden Tasks, das Betreff der
  letzten Mail des Threads.
- `renderOrgOverview` zeigt laufende Auftraege mit ihrem Namen statt mit
  `clip(assignment.task, 120)` (7.2); die Stimmen kommen als eigener, eng
  gefasster Abschnitt dazu (6.4).
- `describeAssignment` fuehrt mit dem Namen und behaelt den Auftragstext
  darunter — der Name ersetzt den Prompt in Listen, nicht in der Akte.

**API** (`packages/server/src/routes/org.ts`)

- `POST /api/org/mail` verliert `mode`. Die Antwort enthaelt den erzeugten
  Task, wenn einer erzeugt wurde, damit die UI direkt verlinken kann.
- `PATCH` auf einen Task akzeptiert `blocked`.
- `GET` auf einen Task liefert den Thread schon mit (`routes/org.ts:417`).
- Sonst nichts. Vorschauen brauchen kein eigenes Feld: die Oberflaeche rendert
  den Text, den sie ohnehin bekommt (7.3).

**Web**

- Inbox-Compose: Schalter weg, abgeleiteter Hinweis unter der To-Zeile (3.1).
- Task-Detail: der Thread inline, statt nur verlinkt — der Vorgang ist eine
  Seite, nicht zwei.
- Board: `blocked` als eigene Spalte oder Abzeichen, mit "waiting for you" und
  der letzten Mail als Zeile.
- Karten und Listen zeigen den Namen als Ueberschrift und darunter die
  Vorschau, gerendert mit dem kompakten `ResultMarkdown`-Preset (7.3).
- Assignment-Liste, -Schublade und -Detailseite verlieren ihre rohen
  `whitespace-pre-wrap`-Bloecke; der volle Auftragstext bleibt in der
  Schublade stehen, nur eben gerendert.
- `AgentDetailPage` verliert "Live now" und die `LiveRunList` und bekommt die
  verlinkte "works on"-Zeile (7.4).
- `AssignmentTerminal` wird ein Terminal: keine `Card`, kein `Fade`, kein
  `RunningBadge`, kein `ResultMarkdown`, englische Strings (7.5).
- Agenten-Formular: `voice` als Feld neben `instructions`, mit dem Hinweis,
  dass hier steht, *wie* jemand schreibt.
- Mail-Ordner "Tasks" filtert bereits auf `kind = 'assignment'`
  (`store.ts:728`) und wird ohne Aenderung korrekt, weil ab jetzt jeder
  Arbeits-Thread einen Task hat.

Alle UI-Texte bleiben englisch, wie im ganzen Projekt.

---

## 10. Konfiguration

Ein neuer Schluessel:

- `org.roleplay` (bool, Standard `true`). Aus heisst: 6.3 faellt weg, jede
  Ausgabe ist ein Bericht wie heute. Der Schluessel existiert, weil der Ton
  jede Mail betrifft und ein Nutzer ihn knapp haben darf.

Keine weiteren. Der Waechter ist ein Zeitplan und wird dort abgeschaltet
(Abschnitt 5); `blocked` ist ein Zustand und kein Schalter; die Ableitung aus
der Adresszeile ist die Regel und keine Option.

---

## 11. Umsetzung in Phasen

Jede Phase ist einzeln lieferbar und einzeln testbar. Phase 1 nimmt den
Schmerz, ohne dass sich fuer den Nutzer etwas umstellt.

**Phase 1 — Reparatur.** `mail.threadKind` statt `params.kind` (3.2);
`notifyTaskStatus` in `finish()` mit der "sonst nichts gehoert"-Regel (4.1);
`blocked` als Status samt Controller-Regel (4); Fortsetzung statt Neustart
(3.3). Danach laufen Board und Thread nicht mehr auseinander.
Tests: eine Nutzerantwort in einem Task-Thread erzeugt keinen zweiten Lauf,
sondern einen zweiten Eintrag in `task_assignments` am selben Task; ein
`failed` Task hinterlaesst eine Notiz in seinem Thread; ein Agent, der
zurueckfragt, hinterlaesst einen `blocked` Task.

**Phase 2 — Ein Eingang und echte Namen.** `mode` entfernen, Ableitung aus To,
`assign` legt einen (Kind-)Task an, `ToolContext.taskId`, Compose-Hinweis in
der UI; dazu `assignments.title`, `title` als Pflichtparameter von `assign` und
`create_task`, die Quellenreihenfolge aus 7.2 und der geerbte Name fuer Laeufe
eines Tasks.
Tests: alle vier Eingaenge aus Befund 1.1 hinterlassen denselben Satz Zeilen;
kein Titel in Liste oder Prompt ist laenger als eine Zeile oder mit dem
Auftragstext identisch.

**Phase 3 — Der Waechter.** Geseedeter Zeitplan, Abonnent auf
`task`-Ereignisse fuer `failed` und `blocked`, Uhr als Rueckfallebene,
`[SILENT]` per Trailing-Token.
Tests: zehn Ereignisse in einer Minute ergeben einen Lauf; ein gesundes Board
ergibt keine Mail.

**Phase 4 — Rollenspiel.** `voice` (Spalte, Typ, Formular, `hire_agent`), die
beiden Register in `buildAgentPrompt`, Team- und Vorgesetzten-Stimmen,
`org.roleplay`.
Tests: ein per Mail geborener Lauf antwortet mit Anrede und Grussformel und
nennt das Ergebnis im ersten Absatz; ein per `assign` geborener Lauf nicht.

**Phase 5 — Vorschauen, Live-Output und Terminal.** Das kompakte Preset fuer
`ResultMarkdown` und die Umstellung der rohen `whitespace-pre-wrap`-Stellen
(7.3); die beiden Live-Flaechen raus aus `AgentDetailPage`, dafuer die
verlinkte "works on"-Zeile (7.4); `AssignmentTerminal` von Karte und
Chat-Bildsprache auf ein echtes Terminal, englische Strings (7.5).
Reine Weboberflaeche, haengt an keiner anderen Phase und kann jederzeit
vorgezogen werden.
Tests: eine Beschreibung mit Ueberschrift, Liste und Codezaun zeigt auf der
Karte keine rohen Markdown-Zeichen und sprengt die Kartenhoehe nicht; dieselbe
Beschreibung rendert auf der Detailseite unveraendert in voller Groesse; die
Agentenseite zeigt waehrend eines laufenden Auftrags keinen Strom, sondern
einen Link; im Terminal steht kein deutscher String und kein gerendertes
Markdown.

---

## 12. Entscheidungen

**E1 — Es gibt nur noch ein Wort.** "Task" ist der Vorgang, auf dem Board und
im Mail-Thread. "Assignment" bleibt ein Typname im Code und verschwindet von
jeder Oberflaeche und aus jedem Prompt; ein Lauf ist ein Detail eines Tasks.
Der erklaerende Absatz im Assistentenprompt wird geloescht, nicht
umformuliert. Wirksam in Abschnitt 2, 9.

**E2 — Die Adresszeile entscheidet, kein Schalter.** Der Nutzer waehlt nicht
mehr zwischen Mail und Task; er waehlt Empfaenger, und die UI sagt ihm vorher,
was daraus wird. Wirksam in Abschnitt 3.1, 9.

**E3 — Genau ein Agent auf To eroeffnet einen Task, alles andere ist ein
Gespraech.** Kein Fan-out aus der Adresszeile: Aufteilen ist die Aufgabe von
`plan_task`, das Abhaengigkeiten, Wellen und eine Zusammenfassung mitbringt.
Wirksam in Abschnitt 3.1.

**E4 — Die Thread-Zeile ist die Wahrheit ueber den Trigger, nicht der
Aufrufparameter.** Behebt Befund 1.2. Wirksam in Abschnitt 3.2.

**E5 — Eine Antwort setzt fort, sie startet nie neu.** Ein Task kann mehrere
Laeufe haben; `task_assignments` ist dafuer gebaut. Ein Lauf ohne Task kann in
einem Task-Thread nicht mehr entstehen. Wirksam in Abschnitt 3.3.

**E6 — `blocked` setzt der Controller, nicht der Agent.** Eine Mail an den
Auftraggeber auf To waehrend eines Task-Laufs heisst: der Task wartet. Der
Detektor existiert (`#answeredDuringTurn`), die Regel braucht keine Kooperation
des Modells, und ihr Fehler faellt in die sichere Richtung — sichtbar wartend
statt still erledigt. Ein Agent darf `blocked` zusaetzlich selbst setzen.
Wirksam in Abschnitt 4.

**E7 — Eine Statusnotiz nur, wenn der Thread sonst nichts gehoert hat.** Eine
Ergebnis-Antwort und eine Rueckfrage sind selbst die Nachricht; `failed` und
`cancelled` sind es nicht und bekommen sie. Wirksam in Abschnitt 4.1.

**E8 — Der Waechter ist ein sichtbarer Zeitplan, keine versteckte Schleife.**
Er steht als `cron_jobs`-Zeile im UI, ist editierbar und abschaltbar, und er
nutzt Ereignis plus Uhr genau so, wie das Trigger-Konzept es vorsieht. Wirksam
in Abschnitt 5, 10.

**E9 — `assign` landet auf dem Board.** Als Kind des laufenden Tasks, wenn es
einen gibt. Eine Delegationskette, die man nicht sieht, ist der Grund, warum
die Org-Struktur sich heute unkontrolliert anfuehlt. Wirksam in Abschnitt 9.

**E10 — Ein Lauf, zwei Register, kein zweiter Modellaufruf.** Als Mail geboren
heisst Brief, per `assign` geboren heisst Bericht. Derselbe Text bleibt
`assignment.result`; es gibt keinen Trennmarker, den irgendwer parsen muesste.
Wirksam in Abschnitt 6.3.

**E11 — `voice` ist ein eigenes Feld.** Nicht ein Satz in `instructions`:
`instructions` steuert die Arbeit in jedem Lauf, die Stimme faerbt nur die
Ausgabe. Wirksam in Abschnitt 6.2, 8.

**E12 — Rollenspiel heisst Ton, nicht Umschweife.** Das Ergebnis steht im
ersten Absatz; kein erfundenes Privatleben, keine gespielte Verzoegerung, keine
Behauptung ueber Arbeit, die nicht stattgefunden hat. Wirksam in Abschnitt 6.5.

**E13 — Ein Agent sieht die Stimmen seines Teams und seines Vorgesetzten,
nicht die der ganzen Firma.** Wirksam in Abschnitt 6.4.

**E14 — Ein einziger neuer Konfigurationsschluessel, `org.roleplay`.** Alles
andere ist Regel oder Zeitplan. Wirksam in Abschnitt 10.

**E15 — Ein Task und ein Lauf haben einen Namen, und der Prompt ist keiner.**
`assignments` bekommt `title`; `assign` und `create_task` verlangen ihn.
Geschrieben wird er vom Aufrufer, sonst vom Mail-Betreff, sonst vom Namen des
Zeitplans, sonst aus der ersten Zeile. Wirksam in Abschnitt 7.2, 8, 9.

**E16 — Kein Modellaufruf zur Titelfindung.** Wer einen Auftrag formuliert,
kann ihn benennen; wer ihn nicht benennen kann, hat ihn nicht verstanden. Der
Notnagel ist die bereinigte erste Zeile, nicht ein zweiter Aufruf. Wirksam in
Abschnitt 7.2.

**E17 — Ein Lauf erbt den Namen seines Tasks.** Listen zeigen dazu seine
Stelle in der Kette ("Run 2"). Zwei Namen fuer dasselbe Ding waeren genau der
Fehler, den E1 beseitigt. Wirksam in Abschnitt 7.2.

**E18 — Jeder Task- und Lauftext wird als Markdown gerendert, die Vorschau
eingeschlossen.** Er ist Markdown, also wird er als solches gezeigt; `##` und
`**` im Klartext sind ein Anzeigefehler, keine Information. Die rohen
`whitespace-pre-wrap`-Stellen der Assignment-Ansichten werden auf
`ResultMarkdown` umgestellt. Gilt fuer Texte — Auftrag, Beschreibung, Ergebnis
—, nicht fuer das Live-Transkript (E21). Wirksam in Abschnitt 7.3, 9.

**E19 — Ein Renderer mit einem kompakten Preset, keine zweite Komponente.**
`ResultMarkdown` nimmt schon ein `className`-Override; Vorschau heisst engere
Abstaende, Ueberschriften auf Fliesstextgroesse, begrenzte Codehoehe und eine
Hoehenklemme auf dem **gerenderten** Container. Kein Vorschaufeld in der API,
keine Flach-Funktion im Kern, keine zweite Textquelle. Wirksam in
Abschnitt 7.3, 9.

**E20 — Der Live-Output gehoert dem Vorgang, nicht dem Agenten.** Die beiden
Live-Flaechen der Agentenseite entfallen; es bleibt eine verlinkte Zeile "works
on <Taskname>". Ein Agent hat eine Akte, ein Vorgang hat einen Strom, und zwei
Orte fuer denselben Strom sind wieder die Frage, wo man hinschaut. Ausnahme:
das Gespraech, in dem man selbst delegiert hat. Wirksam in Abschnitt 7.4, 9.

**E21 — Das Transkript ist ein Terminal, kein Chat.** Monospace, eine Spalte,
chronologisch; keine Karte, keine Ueberschrift, keine Badges, keine
Ein-/Ausblendeffekte, kein Markdown. Ein Mitschnitt wird ausgegeben, nicht
gesetzt — das fertige Ergebnis derselben Arbeit bleibt Markdown an seinem Platz
(E18). Wirksam in Abschnitt 7.5, 9.

**E22 — Werkzeugaufrufe bleiben im Terminal sichtbar und aufklappbar.**
Zeile mit Name und Argument, Ergebnis oeffnet sich darunter im selben
Monospace-Block. Weg faellt das Chat-Widget, nicht die Information: ein
Terminal ohne Werkzeugergebnisse waere ein Fortschrittsbalken. Wirksam in
Abschnitt 7.5.

**E23 — "works on" listet laufende Tasks, und die Nebenlaeufigkeitsgrenze ist
die Obergrenze.** Eine Zeile je laufendem Task, verlinkt; keine erfundene
Kuerzungsregel, weil `org.maxConcurrentAssignments` die Zahl bereits begrenzt,
und erst oberhalb dieser Grenze ein "+N more" aufs gefilterte Board. Laeuft
nichts, fehlt die Zeile, statt "idle" zu behaupten. Daneben einzeilig die Zahl
der wartenden `blocked` Tasks. Wirksam in Abschnitt 7.4.

---

## 13. Offene Fragen

**F1 — Mail, die eintrifft, waehrend ein Task laeuft.** Abschnitt 3.3
schlaegt "nur zustellen" vor, weil der laufende Prozess seinen Prompt schon
hat. Die Alternative — den Lauf abbrechen und mit der neuen Information neu
starten — ist reaktiver und verbrennt angefangene Arbeit. Entscheidung offen;
"nur zustellen" ist der Vorschlag.

**F2 — Gespraechs-Threads mit mehreren Agenten auf To** wecken heute N Laeufe.
Das bleibt nach E3 so, erzeugt aber N Laeufe ohne Karte — genau die Sorte
Unsichtbarkeit, die E9 fuer `assign` beseitigt. Soll ein Gespraech Agenten
ueberhaupt wecken duerfen, oder nur Jarvis?

**F3 — Verfallsfrist fuer `blocked`.** Ein Task, der drei Wochen auf eine
Antwort wartet, ist praktisch abgebrochen. Soll der Waechter ihn nach einer
Frist schliessen, oder bleibt er stehen, bis jemand entscheidet?

**F4 — Wie viel Thread bekommt ein fortgesetzter Lauf?** Heute geht ein Index
der Betreffzeilen in den Prompt und der Volltext nur auf Abruf
(`read_mail_thread`). Bei einer Fortsetzung ist die letzte Mail fast immer
notwendig; zwei Mails im Volltext plus Index waeren ein moeglicher Kompromiss.

**F5 — Wer schreibt die Stimme?** Vorschlag: Jarvis bei `hire_agent`, Nutzer
kann ueberschreiben. Offen, ob eine leere Stimme auf dem Agenten-Formular
angemahnt werden soll oder still neutral bleibt.

**F6 — `org.roleplay` global oder je Agent?** Global ist einfacher; je Agent
waere konsequenter, weil die Stimme schon am Agenten haengt. Vorschlag:
zunaechst global, weil der Ton eine Eigenschaft der Firma ist.

**F7 — Kopf oder Schwanz?** Eine Vorschau auf eine Beschreibung zeigt sinnvoll
den Anfang, eine Vorschau auf ein laufendes Ergebnis den Schluss — `preview` in
`AssignmentView` ist heute ausdruecklich der Ausgabe-Schwanz
(`tail(text, 160)`). Bleiben das zwei Vorschauarten mit zwei Namen, oder
entscheidet ein Feld, welches Ende gezeigt wird?

**F8 — Altbestand ohne Titel.** `assignments.title` ist fuer bestehende Zeilen
leer. Vorschlag: beim Lesen aus der ersten Zeile fuellen und nicht
zurueckschreiben — eine Migration, die tausend alte Prompts anfasst, ist teurer
als die Regel, und ein alter Lauf wird selten wieder angesehen. Alternative:
einmalig beim Schema-Schritt fuellen.

*(Zwei weitere Fragen zum Terminal und zur "works on"-Zeile wurden am
2026-09-17 entschieden und stehen jetzt als E22 und E23.)*
