# Die Nacht wird tiefer, Cron-Laeufe werden gedaechtnisdicht

Stand: 2026-09-16. **Umgesetzt.** Baut auf
[`memory-graph-and-sleep.md`](memory-graph-and-sleep.md) und
[`confirmed-memory-and-self-written-skills.md`](confirmed-memory-and-self-written-skills.md)
auf. Der Code liegt in `packages/core/src/memory/sleep.ts` (Bedarf, Budget,
Replay, Reflexion, Entitaeten-Merge), `packages/core/src/runtime.ts` und
`packages/core/src/org/controller.ts` (Cron-Abgrenzung, Agenten-Werkzeuge),
`packages/core/src/cron/scheduler.ts`, `packages/server/src/routes/sleep.ts`
und `packages/web/src/pages/MemorySleepPage.tsx`.

## 1. Befund

Vier Beobachtungen aus dem laufenden Betrieb, alle am Code belegt:

1. **Cron-Laeufe lernten mit.** `Runtime.#learn` lief nach jeder Antwort ohne
   Blick auf `session.kind`: ein Schedule-Lauf legte seine `kind: 'schedule'`-
   Session an und extrahierte trotzdem. Belegpflicht schuetzt nur halb –
   zitiert werden kann der Job-Prompt, den der Nutzer einmal geschrieben hat,
   und der stand dann bei jedem Feuern wieder in der Bank. Agent-Jobs lernten
   ebenfalls bei jedem Feuern (`OrgController.#learn` kannte keinen Trigger),
   und `write_skill` war waehrend automatischer Laeufe frei verfuegbar.
2. **Die Nacht war ein Kompaktnapf mit fester Portion.** Zwoelf Deep-Replays
   (Scan ueber 50 Sessions), zwoelf Merge-Aufrufe, fuenf Entscheidungen,
   hart verdrahtete drei Link-Aufrufe, ein Insight-Aufruf ueber ein
   Sieben-Tage-Fenster mit vierzig Saetzen. Der Bedarf, den der Tag
   hinterliess, spielte keine Rolle – ein ruhiger Monat bekam dasselbe Budget
   wie ein lauter Tag.
3. **Agenten hatten keinen Live-Zugriff aufs eigene Fach.** Alle
   Gedaechtnis-Werkzeuge waren `ASSISTANT_ONLY`; ein Agent bekam beim
   Assignment-Start einen injizierten Block und danach nie wieder etwas.
4. **Der Schlaf hing als User-Cron in der Liste.** Der Systemjob `kind:
   'sleep'` erschien auf der Schedules-Seite und im `list_schedules`-Tool,
   als haette der Nutzer ihn angelegt – dabei ist er Rookerys eigene
   Uhrwerk, kein Nutzer-Cron.

## 2. Entscheidungen

**E9 – Aus Cron-Prompts wird nichts.** Ein Lauf, den der Scheduler gestartet
hat, arbeitet, aber er schreibt nichts zurueck: `#learn` ueberspringt
`kind: 'schedule'`-Sessions, geplante Agent-Assignments tragen ein
`scheduled`-Flag bis in den Controller, und `write_skill` verweigert im
geplanten Kontext mit Begruendung. Nicht das Modell wird begrenzt, sondern
die Herkunft: der "Nutzer"-Turn eines Cron-Laufs ist Rookerys eigener
Boilerplate plus Job-Prompt, und dessen Worte gehoeren nicht jede Nacht neu
in die Bank. **Mail bleibt bewusst ausserhalb dieser Regel** (Entscheidung
von Jonas, 2026-09-16): eine Mail ist von einem Menschen geschrieben, und was
er schreibt, zaehlt.

**E10 – Die Nacht misst sich selbst (adaptiver Deckel).** Nach dem Replay –
denn was der Replay erntet, ist Teil der Arbeit – misst jede Phase rein per
Datenbank ihren Bedarf: Cluster, offene Widersprueche, Portionen frischer
Memories, verdachtige Skills. `allocateNightBudget` verteilt davon, bis zu
`memory.sleep.nightBudget` (Standard 70) teuren Aufrufen. Passt der Bedarf
unters Dach, wird er voll finanziert: eine ruhige Woche schlaeft flach und
billig. Laeuft er ueber, weichen zuerst die Volumen-Phasen (Verdichten,
Entscheiden, Verknuepfen) – was heute nicht mehr schafft, wartet auf morgen,
dafuer ist morgen da. Die Urteils-Phasen (Einsicht, Reparatur, Destillation)
behalten ihren kleinen Etat bis zuletzt, denn eine Einsicht, die nie
passiert, ist keine vertagte Arbeit, sondern nie welche. Der Replay lebt
ausserhalb der Brieftasche: seine Deep-Leseungen deckelt `replaySessions`
(jetzt 36), sein Scan reicht 150 Sessions zurueck, und sein Triage laeuft auf
dem billigen Modell. Zugleich hochgesetzt: Merge 24, Entscheidungen 8,
Verknuepfen 8 (statt hart 3), Einsichten 3 ueber ein 14-Tage-Fenster (jetzt
konfigurierbar, `insightWindowDays`) aus bis zu 80 Saetzen – in **zwei**
Durchgaengen, einem ueber den Nutzer und einem ueber die Arbeit; derselbe
Pool in einem einzigen Prompt liefert immer nur die laute Sorte. Ein Satz,
der schon als Insight auf dem Papier steht, wird im zweiten Durchgang
uebersprungen, nicht doppelt gezaehlt.

**E11 – Agenten lesen in der eigenen Bank.** `remember` und `search_memory`
gehoeren jetzt beiden; der Executor loest den Besitzer nach Aufrufer auf –
der Assistent schreibt ueber den Nutzer, ein Agent ueber die eigene Arbeit,
und gelesen wird strikt im eigenen Fach. `forget` und `sleep_now` bleiben
beim Assistenten: Loeschen und Nachtkontrolle sind keine Agentensache.

**E12 – Der Schlaf ist interner.** `cron.list` filtert `kind: 'sleep'`
heraus, `recentRuns` ebenso; die Cron-Routen antworten auf den internen Job
mit 404, und das `run_schedule`-Tool verweist auf die Memory-Seite.
Verwaltet wird er nur dort: Die Schlafkarte zeigt Zeitplan und Schalter, und
`PATCH /api/sleep/schedule` schreibt Cron-Zeile und Config im selben Zug –
nur die Zeile zu aendern wuerde beim naechsten Start die Config zurueckholen.
An der Scheduler-Mechanik ist nichts gedreht: ein Timer, ein Ledger, kein
zweites verstecktes Uhrwerk.

Dazu der Abschluss eines Rests aus dem Graph-Konzept: Phase 4 versprach
„zusammengelegte Schreibweisen" fuer Entitaeten, der Code kannte nur die
Kind-Korrektur. Der Verknuepf-Durchgang darf jetzt Alias-Merges vorschlagen,
und `Store.mergeEntities` haengt Links in einer Transaktion auf das
ueberlebende Ziel um, bevor die Quelle verschwindet.

## 3. Was sich nicht geaendert hat

Nichts wird geloescht, keine Nacht ist nicht rueckgaengig zu machen, und
`origin = 'user'`/`pinned` bleibt unantastbar – E1, E3 und E4 des
Graph-Konzepts gelten unveraendert. Ein geplanter Lauf, der nichts schreibt,
macht die Ruecknahme einfacher, nicht schwieriger. Und die Nacht darf weiter
Skills schreiben: aus *Erinnerungen*, nicht aus Cron-Prompts – mit E9 hoert
genau der Nachschub auf, der solche Skills sonst gefuellt haette.

## 4. Offene Punkte

- **Manuelles „Jetzt ausfuehren" eines Schedules lernt ebenfalls nicht.** Das
  ist konsistent (derselbe Prompt, derselbe Absender), aber es ist eine
  Nuance, die man dem Nutzer irgendwann erklaeren koennen muss.
- **Ein Mail-Verkehr kann ein Dritter sein.** E9 schliesst Mail bewusst aus;
  was ein Absender ueber den Nutzer verrät, landet in dessen Bank – das
  Zitat stammt dann aus der Mail, nicht aus dem Chat.
- **Die Budget-Verteilung liegt nur im Log.** Die Schlafkarte zeigt den
  Deckel („Night budget"), nicht die Verteilung der Nacht. Sichtbar machen,
  wenn jemand danach fragt – nicht vorher.
