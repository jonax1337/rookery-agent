# Wer delegiert, hoert zurueck — und der Chat ist das Terminal

Stand: 2026-09-29. **Umgesetzt** (R1–R5, T1–T5), siehe "Stand der Umsetzung";
offen ist bewusst nur Abschnitt 4. Weicht der Code ab, gilt der Code.
Vorlaeufer: `work-as-one-surface.md` (die Karte ist der Vorgang) und
`mail-board-unification-and-roleplay.md` (Aufgaben als Mail-Threads).

## Stand der Umsetzung

- **Rueckmeldekette:** `tasks.requester_session_id` (Schema 26),
  `OrgController.runTask` meldet im `finally` ueber `#reportBack`
  (Event `report-back`, Text aus `reportBackNotice`). `#runAwaited` fuer
  `assign(wait=true)` und `run_task`; `#detached` + `#awaitDelegated` fuer
  Agenten, die innerhalb eines Tasks mit `wait=false` delegieren
  (`MAX_DELEGATION_ROUNDS = 2`, dazu `org.maxTaskRuns`).
- **Folge-Turn:** `Assistant.followUp` → `chat({ origin: 'system' })`,
  gespeichert als `role: 'system'`, kein Titel, kein Memory. Sperre pro
  Session (`#takeTurn`). Event `follow-up` fuer Kanaele.
- **Server:** `assistant.turnRunner` → `TurnHub.start`; der Hub merkt sich,
  wer ein Gespraech offen hat, und meldet neue Turns mit `attached`. Das Web
  puffert Frames noch nicht uebernommener Turns (`#unclaimed` in
  `lib/socket.ts`) und laedt nach einem beigetretenen Turn die gespeicherten
  Nachrichten neu; Systemzeilen rendert `SystemMessage` in `thread.aui.tsx`.
- **Telegram:** jede Session, in der Telegram einen Turn faehrt, merkt sich
  den Chat (`meta telegram:session:<id>`); `follow-up` geht dorthin, als
  Antwort dieser Session abgelegt.
- **Chat = Terminal:** `ConversationTerminal` in `providers/claude-tui.ts`
  (`submit`, Bracketed Paste falls die TUI ihn einschaltet, zweites Enter nach
  7,5 s, `/`- und `!`-Eingaben enden auf ruhigem Bildschirm), Kontext-Hook
  `promptContextHookCommand`. In `assistant/`: `TerminalTurn` (`terminal-turn.ts`),
  `ConversationTerminals.canTakeTurn`/`.ensure` in `terminals.ts` (Signatur = Modell, Effort, Rechte,
  Projekt, Tool-Server). Rueckmelde-Turns uebernehmen ein laufendes Terminal
  unveraendert, statt es auf Defaults neu zu starten. Schalter
  `turns.terminal` unter Settings → Behavior → Conversations.
- **Verifiziert** mit echter TUI (Durchstich: mehrzeilige Nachricht, Recall
  nur ueber den Hook, Esc-Abbruch, Folge-Turn nach Abbruch; ~7 s kalt, ~5 s
  warm) und in der Dev-Instanz: Rueckmeldung erscheint live im offenen Chat
  und im Terminal derselben Session. **Nicht live getestet:** Telegram.
- **Bekannter Preis:** Text kommt im Terminal-Pfad blockweise statt
  tokenweise (das Transkript kennt nur fertige Bloecke).
- **Nach dem adversarischen Prueflauf nachgezogen:** Der Terminal-Kontext
  bekommt pro Turn auch das Abort-Signal (Stop bricht ein wartendes `assign`
  ab); Teilaufgaben eines Splits warten ebenfalls auf ihre Hintergrund-Kinder;
  ein waehrend des Wartens abgebrochener Task endet `cancelled`; vom
  Neustart-Sweep beendete Tasks melden sich zurueck (`reportEnded`); ein
  Neustart wegen geaenderter Einstellungen wartet, bis das Terminal frei ist
  (`whenIdle`); Rueckmelde-Turns laufen mit den zuletzt benutzten Rechten des
  Gespraechs (`meta session:permission:<id>`); ein Tab meldet das Verlassen
  eines Gespraechs (`detach`).
- **Aus dem Durchtest in der Dev-Instanz (2026-09-29) nachgezogen:** Getippt
  wird erst, wenn der Spiegel Claude Codes Fusszeile unter dem Eingabefeld
  zeigt (ein frisches Terminal verschluckte sonst die erste Nachricht
  waehrend seiner Startup-Hooks); eine nicht angekommene Nachricht bekommt
  Enter oder wird neu getippt. `/`-Befehle liefern ihren Bildschirm als
  Antwort (Codeblock) und ein offenes Panel wird mit Esc geschlossen. Das
  Terminal kennt alle Namen seines Modells (Alias und volle ID) - vorher
  startete es jeden zweiten Turn neu. Der Chat springt nicht mehr von selbst
  in die Terminal-Ansicht. Die Groesse eines Terminals bestimmt, wer es
  zuletzt oeffnet oder hineintippt; alle anderen Zuschauer uebernehmen sie.
  Der Spiegel stellt Groessenwechsel hinter noch nicht geparste Bytes.
- **Bildschirm-Spiegel:** Neben jedem pty laeuft ein `@xterm/headless` mit
  Serialize-Addon; ein spaeter Zuschauer bekommt den serialisierten
  Bildschirm statt des rohen Byte-Verlaufs, und der Client misst sich, bevor
  er ihn anfordert. Vorher war das Terminal nach Verlassen und Zurueckkehren
  verzogen (doppelte Prompt-Leisten, abgebrochene Farbflaechen).

## 1. Befund

Der Assistent sagt "ich melde mich, wenn der Agent fertig ist" — und meldet
sich nie. Das ist kein Modellfehler, der Code gibt es nicht her:

- `assign(wait=false)` an einen **anderen** Agenten startete `runTask` und
  verwarf das Ergebnis (`if (!isSelf) return undefined`). Der Tool-Text
  behauptete trotzdem "the user is told when it finishes".
- Die Selbst-Zuweisung versprach "follow up in this chat" und schickte eine
  Mail in die Inbox.
- Der Board-Waechter meldet nur `failed` und haengende Laeufe; ein
  erfolgreiches Ende ist fuer ihn keine Neuigkeit.
- Die Karte kennt ihren Eltern-Task (`parentId`), aber nicht das Gespraech,
  aus dem sie kam. Ein fertiger Task wusste nicht, wohin er zurueckgehoert.
- Ein Agent, der innerhalb seines Tasks mit `wait=false` delegiert, beendete
  seinen Task, ohne auf die Kinder zu warten; deren Ergebnis erreichte ihn
  nie.

Claude Code loest dasselbe Problem mit einer festen Regel: wer im
Hintergrund delegiert, bekommt **garantiert** eine Benachrichtigung, und die
startet beim Auftraggeber einen neuen Turn. Diese Regel uebernimmt Rookery.

## 2. Die Rueckmeldekette

**R1 — Jede Karte kennt ihren Auftraggeber.** `tasks.requester_session_id`
(Schema 25 → 26): das Gespraech, aus dem die Arbeit kam. Gesetzt von `assign`
und `create_task`, wenn der Aufruf aus einem Gespraech kommt (Assistent im
Chat, oder ein Agent, dessen Lauf aus einem Chat stammt — `ToolContext.sessionId`
wird die Kette hinunter durchgereicht). Der Eltern-Task bleibt `parentId`.

**R2 — Genau eine Rueckmeldung pro Ende.** Jeder Endzustand eines Laufs
(`done`, `failed`, `blocked`, `cancelled`, Timeout) laeuft durch
`OrgController.setTaskStatus` mit `fromRun: true`. Dort entscheidet
`#reportBack`, wer es erfahren muss:

| Auftraggeber | Wartet synchron? | Rueckmeldung |
|---|---|---|
| Gespraech (`requesterSessionId`) | nein | `report-back`-Event → neuer Turn im selben Gespraech |
| Gespraech | ja (`wait=true`) | keine — das Tool-Ergebnis *ist* die Rueckmeldung |
| Eltern-Task (Agent delegierte mit `wait=false`) | — | Eltern-Lauf wartet auf offene Kinder und laeuft mit deren Ergebnissen als Fortsetzung weiter |
| niemand (Board, Zeitplan) | — | wie bisher: Task-Thread + Push |

Synchrones Warten wird im Prozess gemerkt (`#awaited`). Nach einem Neustart
wartet niemand mehr, also meldet sich jeder Lauf dann asynchron — lieber
einmal zu viel als nie.

**R3 — Der Auftraggeber reagiert wirklich.** `Assistant.followUp(sessionId,
notice)` fuehrt einen Turn im Gespraech aus. Die Notiz ist als
Systemnachricht markiert (`role: 'system'`), der Assistent formuliert daraus
seine Antwort an den Nutzer. Turns eines Gespraechs laufen nacheinander
(Sperre pro Session), eine Rueckmeldung platzt also nie in eine laufende
Antwort. Der Server faehrt den Turn durch den `TurnHub`, damit jeder offene
Tab ihn live sieht (`turn-started` an alle Sockets, der Chat haengt sich an),
und Telegram sendet die Antwort in den Chat, dem das Gespraech gehoert.

**R4 — Agenten warten auf ihre Kinder.** Delegiert ein Agent innerhalb eines
Tasks mit `wait=false`, merkt sich der Controller das Kind am Eltern-Task.
Endet der Lauf des Eltern-Tasks, bevor alle Kinder fertig sind, wartet
`#runTaskBody` auf sie und startet den Blatt-Lauf einmal neu, mit den
Ergebnissen als `taskNote`. Der Eltern-Task wird erst `done`, wenn seine
Kinder fertig sind. Begrenzt durch `org.maxTaskRuns` und die Timeouts der
Kinder.

**R5 — Die Tool-Texte versprechen nur, was passiert.**

## 3. Der Chat ist das Terminal

Bisher gab es pro Chat zwei Wege: den Headless-Lauf (`claude -p`) pro Turn
und — seit 2026-09-28 — ein Terminal mit `--resume` auf derselben Session.
Beide schrieben in dieselbe JSONL, waren aber zwei Prozesse. Jetzt gibt es
**einen**:

**T1 — Ein Prozess pro Chat.** Fuer Gespraeche der Art `chat` (Web und
Telegram) laeuft jeder Turn in der Claude-Code-TUI des Gespraechs
(`turns.terminal`, Default an). Der Chat tippt die Nachricht ins Terminal
(Bracketed Paste + Enter), liest die Antwort aus dem Transkript und erkennt
das Ende am Stop-Hook — wie ein Agentenlauf. Was im Terminal getippt wird,
landet ebenso im Gespraech. `/`-Befehle, Hintergrund-Agenten und die eigenen
Benachrichtigungen von Claude Code verhalten sich im Chat damit genau wie im
Terminal.

**T2 — Kontext pro Turn ueber einen Hook.** Das Terminal hat einen
Systemprompt fuer seine ganze Lebenszeit. Was ein Chat-Turn pro Turn neu
baut (erinnerte Memories, ungelesene Mail), schreibt Rookery vor dem Tippen
in eine Datei; ein `UserPromptSubmit`-Hook reicht sie als
`additionalContext` an Claude Code und leert sie. Direkt im Terminal
getippte Nachrichten bekommen keinen Recall — wie vorher.

**T3 — Konfigurationswechsel starten neu, der Kontext bleibt.** Aendern
sich Modell, Effort, Rechte, Projekt oder die angehaengten Tool-Server, wird
das Terminal beendet und mit `--resume` derselben Session neu gestartet.
Damit ist auch die "Continuation" (Tool-Server mitten im Turn eingeschaltet)
abgedeckt: nach dem Turn Neustart mit den neuen Servern, dann der
Fortsetzungsprompt.

**T4 — Abbrechen ist Esc.** Das Abort-Signal eines Turns (Stop-Knopf,
Turn-Timeout, Telegram `/stop`) schickt Esc ins Terminal und beendet den Turn.

**T5 — Was headless bleibt.** Sprach-Sessions (Latenz), Zeitplan- und
Mail-Sessions (niemand schaut zu, eigene Session pro Lauf), der Waechter,
Provider hinter einem Router (das Gateway erreicht sie nicht) und Systeme
ohne pty. Ein Provider-Wechsel wegen Quota findet im Terminal nicht statt;
dort waehlt man per `/model`.

## 4. Mail

Mit R2–R4 ist Mail nicht mehr der Transportweg fuer Ergebnisse zwischen
Auftraggeber und Agent. Was bleibt: die Task-Threads als Protokoll, Rueckfragen
von Agenten (`blocked`) und Mail von aussen (IMAP). **Offen, bewusst nicht in
diesem Paket:** ob die interne Mail ganz verschwindet und Rueckfragen
ebenfalls als Turn beim Auftraggeber landen. Das ist ein Rueckbau mit eigener
Entscheidung (Inbox-Seite, Task-Threads, Roleplay-Stimme), kein Nachtrag.
