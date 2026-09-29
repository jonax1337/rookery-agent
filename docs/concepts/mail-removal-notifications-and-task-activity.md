# Interne Mail raus: Benachrichtigungen, Kartenverlauf, answer_task

Stand: 2026-09-29. Bauplan, freigegeben von Jonas mit der harten Bedingung:
**nichts, was ihn heute erreicht (Web, Telegram), darf verloren gehen.**
Vorlaeufer: `delegation-report-back-and-chat-terminal.md` (Rueckmeldekette),
`mail-board-unification-and-roleplay.md` (hat Mail zum Rueckgrat gemacht -
das wird hier zurueckgebaut). Weicht der Code ab, gilt der Code.

## 1. Zielbild

Mail war drei Dinge in einem: Transport zwischen Agenten, Protokoll einer
Aufgabe, und der Kanal zum Nutzer. Das wird getrennt:

| Heute (Mail) | Danach |
|---|---|
| Transport Agent ↔ Agent / Assistent | `assign`, Rueckmeldekette (R1–R4), `ask_requester`, `answer_task` |
| Task-Mail-Thread (Protokoll) | **Kartenverlauf** `task_events` auf der Karte |
| Mail an den Nutzer (Inbox, Telegram) | **Benachrichtigung** `notifications` – gespeichert, ungelesen/gelesen, Telegram-Push, Antwort routet zurueck |
| Externe Mail (IMAP-Listener) | bleibt unveraendert (feuert Zeitplaene) |

Die Tabellen `mail`, `mail_recipients`, `mail_threads` bleiben in der
Datenbank (nicht geloescht, nur nicht mehr beschrieben); ihr Inhalt wird
einmalig migriert (Abschnitt 6).

## 2. Neue Bausteine

**Benachrichtigung** (`notifications`, Schema 27):
`id, org_id, kind, title, body, from_kind ('assistant'|'agent'|'system'),
from_agent_id, task_id, cron_job_id, cron_run_id, session_id, read_at,
archived_at, created_at`.
`kind` ∈ `schedule | watch | task | question | agent | sleep | system`.
Store: `createNotification`, `listNotifications({unread, kind, archived,
limit})`, `markNotificationsRead(ids | all)`, `archiveNotification`,
`unreadNotificationCount`. Controller: `notifyUser(input)` schreibt, emittiert
`{type:'notification', notification}` (neues `AgentEvent`) und ist der
**einzige** Weg zum Nutzer.

**Kartenverlauf** (`task_events`, Schema 27):
`id, task_id, at, kind, actor_kind ('user'|'assistant'|'agent'|'system'),
actor_agent_id, text, assignment_id`.
`kind` ∈ `created | run-started | run-ended | question | answer | note |
status`. Store: `addTaskEvent`, `listTaskEvents(taskId)`,
`lastTaskEvent(taskId, kind)`. Emittiert `{type:'task-event'}`.

**Tools** (`org/tools.ts`):
- `ask_requester(question)` – nur Agenten, nur innerhalb eines Tasks.
  Schreibt `question`-Event, setzt fuer den Lauf `askedRequester` (→ Status
  `blocked`). Ersetzt "Rueckfrage per send_mail". Fuer Agenten bleibt
  `ask_user` weiter gesperrt.
- `answer_task(id, answer)` – Assistent und Agenten (Agenten nur fuer Tasks,
  deren Auftraggeber sie sind). Schreibt `answer`-Event und setzt den Task mit
  `taskNote = "<wer> answered: …"` fort (heutiges `#continueTask` ohne Mail;
  `org.maxTaskRuns` gilt fuer Nicht-Nutzer wie bisher).
- `report_to_user(title, body)` – Agenten (ersetzt Agent→Nutzer-Mail) und der
  Board-Waechter (ersetzt dessen `send_mail`). Erzeugt Benachrichtigung
  `agent` bzw. `watch`.
- `task_activity(id)` – liest den Kartenverlauf (ersetzt `read_mail_thread`).
- **Entfaellt:** `send_mail`, `read_mail`, `read_mail_thread`.
- `notify` (nur Push, kein Speicher) bleibt, schreibt aber zusaetzlich eine
  Benachrichtigung `system`, damit auch das im Web nachlesbar ist.

**HTTP:** `GET /api/notifications`, `POST /api/notifications/read`,
`POST /api/notifications/archive`, `GET /api/org/tasks/:id` liefert `events`
statt `thread`, `POST /api/org/tasks/:id/answer` (Nutzer beantwortet eine
Rueckfrage → `answer_task` als `user`, ohne Cap).

## 3. Jede Meldung an den Nutzer: heute → danach

| # | Heute | Danach | Telegram |
|---|---|---|---|
| P11 | Zeitplan-Ergebnis als Mail `Schedule "X" completed/failed` (`CronScheduler.#postToInbox`) | Benachrichtigung `schedule` mit `cron_job_id`, `cron_run_id`, `session_id` – gleicher Titel/Text, `[SILENT]` und stille Laeufe wie bisher | ja (`push.schedules`, Default an) – **auch Agenten-Jobs von Nicht-Leads** (heute verloren) |
| P12 | Waechter `send_mail` an Nutzer | `report_to_user` → `watch` | ja (`push.schedules`) |
| P7 | Statusnotiz "Task X done/failed/cancelled" an Auftraggeber | Kartenverlauf `status`; ist der Auftraggeber der Nutzer → Benachrichtigung `task`; ist es ein Gespraech → Rueckmelde-Turn (R3) | ja (`push.tasks`, Default an fuer Nutzer-Karten) |
| blocked | Agent mailt Rueckfrage, Karte "Waiting for you" | `ask_requester` → Verlauf `question`; Auftraggeber Nutzer → Benachrichtigung `question`; Gespraech → Rueckmelde-Turn; Agent → dessen Task-Fortsetzung (R4) | ja, **immer** (Fragen sind nie stumm), Antwort per Telegram-Reply → `answer_task` |
| P5/P6 | Ergebnis-Mail an Absender | Verlauf `run-ended`/`status` + Rueckmeldekette; Nutzer-Karte → `task` | wie P7 |
| P13 | Schlaf-Promotion als Mail vom Nutzer an sich selbst (nie gepusht – Bug) | Benachrichtigung `sleep` | ja (`push.sleep`) |
| P1 Agent→Nutzer | `send_mail` an Nutzer (nur Leads gepusht) | `report_to_user` → `agent` | per `push.agents` (`leads` Default, `all`, `off`) |
| P14 | `notify` | unveraendert + gespeichert als `system` | ja |
| P8 | Mail an Assistent → Antwort-Mail | entfaellt (der Assistent ist per Chat/Telegram erreichbar) | – |
| P2/P3 | Nutzer schreibt Mail / Auftrag per Mail | Auftrag ueber Board ("New task") oder Chat; Antworten ueber `answer_task`-Feld auf der Karte oder die Benachrichtigung | – |
| IMAP | feuert Zeitplan | unveraendert → P11 | ja |

Telegram-**Antworten**: Ursprung `notification` (neue `OriginKind`). Antwort
auf eine `question` → `answer_task` als `user` (Task laeuft weiter; Quittung
im Chat). Antwort auf alle anderen → wie heute ein Thread-Gespraech mit dem
Text der Benachrichtigung als Kontext; `schedule` mit `session_id` →
direkt dieses Gespraech (heutiges Verhalten fuer Cron). "Als gelesen"-Knopf
bleibt (Callback `mail:read:<id>` wird auf Benachrichtigungs-Ids umgestellt,
alte Knoepfe antworten "already handled"). `/mail` → `/inbox`
(ungelesene Benachrichtigungen).

## 4. Web

- `/inbox` wird **Benachrichtigungen** (gleiche Route, neuer Inhalt): Liste
  mit Art-Filter, ungelesen/gelesen, Archiv, Detail mit Markdown, Link zur
  Quelle (Task, Zeitplan-Lauf, Gespraech), bei `question` ein Antwortfeld.
  Badge = ungelesene Benachrichtigungen. Toast bei `notification`.
- Task-Detail: Tab "Thread" → **Activity** (Kartenverlauf) mit Antwortfeld,
  solange die Karte `blocked` ist. Board: "Waiting for you" aus dem letzten
  `question`-Event.
- Entfaellt: Compose, "View mailbox"/"Write mail" auf Agentenseiten,
  Schalter "Roleplay in mail". Push-Einstellungen: "Mail" → pro Art
  (Schedules, Tasks, Questions immer, Agents leads/all/off, Sleep).

## 5. Prompts

- Assistent: Abschnitte ueber Mail/Inbox raus; stattdessen: offene Fragen
  von Agenten kommen als Rueckmelde-Turn und werden mit `answer_task`
  beantwortet; der Nutzer wird ueber `notify`/Antwort im Gespraech erreicht;
  Zeitplan-Ergebnisse landen als Benachrichtigung.
- Agent: Mail-Etikette, "Mail waiting for you", Roleplay-Brief raus;
  stattdessen: Rueckfrage an den Auftraggeber nur mit `ask_requester`,
  Nutzer informieren nur mit `report_to_user` (sparsam), Ergebnis ist die
  Antwort des Laufs.
- `org.roleplay` entfaellt (Schluessel wird ignoriert).

## 6. Migration (Schema 26 → 27)

- Jede Mail mit dem Nutzer als To/Cc → Benachrichtigung (Art aus
  `mail_threads.kind`: `report` → `schedule`, `assignment` → `task`, sonst
  `agent`), `read_at` aus dem Lesestatus.
- Jeder Task mit verlinktem Thread → dessen Mails als `note`-Events (erste
  als `created`), Absender als Akteur. Nichts wird geloescht.

## 7. Tests

Mail-Tests in `org.test.js`, `cron.test.js`, `board-watch.test.js`,
`gateway.test.js`, `server/test/gateways.test.js` werden auf die neuen
Wege umgeschrieben – gleiche Garantien (Kette, keine Doppelmeldung, Status
landet genau einmal, stille Laeufe bleiben still, Push-Filter, Antwort
routet zurueck), neue Traeger.

## 8. Umsetzung Phase 1 (Core)

Stand: 2026-09-29, nur `packages/core`. Server, Web und CLI folgen gegen die
API unten. Wo der Plan schweigt, gilt die einfachste Loesung - hier notiert.

**Schema 27** (`memory/db.ts`): Tabellen `notifications` und `task_events`
wie in Abschnitt 2, `task_events` mit `ON DELETE CASCADE` auf `tasks`,
`notifications` ohne FKs (ueberlebt Task, Zeitplan, Gespraech). Die Migration
(`migrateMailToNotifications`, Flag `mail_to_notifications_v1`, in einer
Transaktion) uebernimmt die **Mail-Id als Id** der Benachrichtigung bzw. des
Events - dadurch idempotent, und alte Telegram-Knoepfe `mail:read:<id>`
treffen die migrierte Benachrichtigung. Ergaenzungen: die Schlaf-Promotion
(Mail Nutzer an Nutzer, Betreff `Retrieval policy ...`) wird `sleep`, nicht
`agent`; `from_kind` `user` wird `system`; gelesen nur, wenn alle
Nutzer-Kopien gelesen waren; `archived_at` aus dem Thread. Kartenverlauf nur
fuer Threads, deren Task noch existiert, Reihenfolge nach `created_at, rowid`.

**Store** (`OrgStore`): `createNotification`, `getNotification`,
`listNotifications({orgId?, unread?, kind? (einzeln oder Liste), archived?, limit?})`
(`archived` waehlt das Regal: live oder Archiv), `markNotificationsRead(ids | 'all', {read?, orgId?})`
(gibt die Zahl geaenderter Zeilen zurueck, `read: false` = ungelesen),
`archiveNotification(id, archived = true)` (Archivieren markiert gelesen),
`unreadNotificationCount(orgId?)`, `addTaskEvent`, `listTaskEvents`,
`lastTaskEvent(taskId, kind?)`. `createTask` schreibt selbst das
`created`-Event mit dem Brief (Beschreibung, sonst Titel) - damit auch jede
Karte, die der Server direkt anlegt. Mail-Methoden bleiben lesbar, der
Runtime-Pfad schreibt keine Mail mehr.

**Controller:** `notifyUser(input)` ist der einzige Weg zum Nutzer (speichert,
emittiert `notification`, wirft nie). `answerTask({taskId, answer, by?, orgId?})`
fuer Route und Telegram (`by` default `user`, ohne Cap). Wer ein Ende hoert,
entscheidet `#deliverEnding` (aufgerufen aus `setTaskStatus`, aus dem
Subtask-Pfad und aus `reportEnded`):

| Karte | done/failed/cancelled | blocked (nur aus einem Lauf) |
|---|---|---|
| Nutzer-Karte (`createdBy user`, kein Gespraech, kein Parent) | `task` (auch wenn der Assistent per `run_task` wartet) | `question` |
| aus einem Gespraech | Rueckmelde-Turn (R3) | Rueckmelde-Turn |
| jemand wartet synchron (`#awaited`) | Tool-Ergebnis | Tool-Ergebnis mit Frage + `answer_task`-Hinweis |
| Kind eines Agenten-Tasks | Eltern-Lauf (R4) | Eltern-Lauf (R4), sonst `question` |
| Assistenten-Karte ohne Gespraech | `task` | `question` |
| Teilaufgabe eines Splits | Eltern-Ergebnis | `question` |
| Agenten-Karte ohne Parent | nur Kartenverlauf | `question` |

Stille wie bisher: Zeitplan-Karten und der eigene Abbruch des Nutzers -
aber **Fragen sind nie still**, auch nicht auf Zeitplan-Karten. Zusaetzlich:
Kann ein Rueckmelde-Turn nicht laufen (Session ist `schedule` oder weg),
macht die Runtime daraus eine Benachrichtigung (`taskNotification`), statt
das Ende zu verwerfen. `reportEnded` (Neustart-Sweep) meldet jetzt auch
Nutzer-Karten per Benachrichtigung.

**Tools:** `ask_requester` setzt eine Marke am Lauf (`#askedRequester`, pro
Assignment), die ersetzt die Outbox-Suche (`#answeredDuringTurn`).
`answer_task` schreibt das `answer`-Event immer zuerst und verweigert dann nur
den Lauf: laufender Task (keine Antwort in einen laufenden Lauf), Cap
`org.maxTaskRuns` fuer Nicht-Nutzer, Delegationstiefe. Die Fortsetzung bekommt
als `taskNote` die Frage und `<wer> answered: ...`. `report_to_user` ist fuer
den Assistenten nur im Waechter-Lauf sichtbar (`assistantOnlyWhenWatching`)
und schreibt bei einem Task zusaetzlich eine `note`. `notify` speichert immer
eine `system`-Benachrichtigung, auch wenn kein Kanal pushen kann (dann kein
Fehler mehr, sondern "gespeichert"); gepusht wird weiter ueber das
`notify`-Event.

**R4 + Rueckfrage:** `#awaitDelegated` nimmt blockierte Kinder mit Frage und
`answer_task("<id>", ...)`-Hinweis in die Fortsetzungsnotiz. Beantwortet der
Eltern-Agent aus seinem Task heraus, haengt die Fortsetzung wieder an
`#detached` und der Eltern-Task wartet erneut - begrenzt durch
`MAX_DELEGATION_ROUNDS` und `maxTaskRuns`. Kann nicht mehr fortgesetzt
werden, gehen offene Fragen der Kinder als `question` an den Nutzer.

**Kartenverlauf:** `created` (Store), `run-started`/`run-ended` pro Blatt-Lauf
(mit `assignmentId`, Lauf-Nummer, Ergebnis gekuerzt auf 4000 Zeichen),
`question`, `answer`, `status` (Text aus `statusNote`, Akteur `system` bei
einem Lauf, sonst wer es tat), `note` (`report_to_user`). Neues Event
`task-event` am Controller, von der Runtime weitergereicht.

**Zeitplan:** `CronScheduler` bekommt `notify` (die Runtime reicht
`org.notifyUser` durch); ohne Hook schreibt er selbst und emittiert
`notification`. Titel/Text wie die alte Mail, dazu `cronJobId`, `cronRunId`,
`sessionId`; `fromKind` `agent` bei Agenten-Jobs.

**Push** (`config.ts`): neue Schluessel `schedules` (auch `watch`),
`questions` (immer true), `agents` (`leads`|`all`|`off`); `tasks` jetzt
Default an. `upgradePushConfig` liest alte Dateien ohne die neuen Schluessel:
`schedules <- mail`, `tasks <- tasks || mail`, `agents <- mail ? mailFrom : off`
(`assistant` -> `off`). Nur gelesen, nie zurueckgeschrieben.
`notificationPushAllowed(push, notification, isLead)` ist der Filter fuer
den Server; `system` gibt er nie frei (sonst Doppel-Push mit `notify`).
Abweichung vom Wort "immer": der Hauptschalter `enabled` gilt auch fuer
Fragen - so hielt es der `ask_user`-Push schon immer. Telegram:
`notificationReadCallbackData` (`notif:read:<id>`) und
`notificationReadDoneCallbackData`, alte `mail:read:`-Knoepfe werden weiter
gelesen.

**Prompts:** Assistent ohne Mail-Abschnitt und ohne "Mail waiting for you";
Agent ohne Mail-Etikette, Thread-Index und Roleplay-Brief, `ask_requester`
nur mit `taskId`. `org.roleplay` bleibt im Typ, wird von nichts gelesen.
Der Waechter-Prompt nennt `report_to_user` und danach `[SILENT]`.

**Fuer Server/Web - entfernt oder geaendert:**
`OrgController.sendUserMail`, `sendTaskMail`, `notifyTaskStatus`, Option
`runAssistantMail`, `SourceMailRef` und `ToolContext.sourceMail`,
`RunAssignmentInput.sourceMail`; `renderMail`, `mailSender`;
`assistantOrgBlock(config, snapshot, activeProject?, schedules?, store?)`
(ohne `mail`); `AgentPromptInput` ohne `mail`/`sourceMail*`, dafuer `taskId`;
`reportBackNotice(task, agent, question?)`. Es wird kein `mail`-Event mehr
emittiert. Neu: `notification`- und `task-event`-Events am `Assistant`,
`Assistant.announcePromotion` oeffentlich. Die Mail-Typen sind `@deprecated`,
aber exportiert. Nach Phase 1 bricht im Server nur `routes/org.ts`
(`sendUserMail`); die Mail-Routen, Push (`onMail`, `mailFrom`) und
`/mail` in Telegram lesen noch die alten Tabellen und muessen umziehen.
