# Telegram als Fernsteuerung

Stand: 2026-09-11. Konzept, kein Code. Betrifft `packages/server/src/channels/` (neu),
`packages/server/src/server.ts`, `packages/server/src/schemas.ts`, `packages/core/src/types.ts`,
`packages/core/src/config.ts`, `packages/core/src/memory/store.ts`, `packages/core/src/org/tools.ts`,
`packages/core/src/org/controller.ts` und die Einstellungsseite der Web-UI.

## 1. Zielsetzung

Rookery laeuft auf einem Rechner zu Hause und ist genau dort bedienbar: im Browser auf `127.0.0.1`,
im Terminal, per Sprache vor dem Geraet. Sobald der Nutzer nicht davor sitzt, ist der Assistent weg.
Ziel ist ein zweiter Eingang, der vom Handy aus funktioniert, ohne dass dafuer ein Port ins Internet
zeigt:

1. **Steuern** – eine Nachricht an den Bot ist ein vollwertiger Turn: dasselbe Gedaechtnis, dieselbe
   Firma, dieselben Werkzeuge wie im Web. Kein zweiter, duemmerer Assistent.
2. **Gemeldet werden** – fertige Auftraege, Zeitplan-Ergebnisse und der Schlafbericht kommen von
   sich aus aufs Handy. Jarvis darf ausserdem ungefragt schreiben, wenn er etwas zu melden hat.
3. **Verschlossen bleiben** – der Kanal ist oeffentlich erreichbar (jeder, der den Bot-Namen kennt,
   kann ihn anschreiben) und muss trotzdem exakt einem Menschen gehoeren.

Nicht-Ziel: ein Mehrbenutzer-Bot. Nicht-Ziel: ein zweites Bedienkonzept mit Knoepfen, Menues und
Inline-Tastaturen – der Kanal ist ein Chat, nichts weiter. Nicht-Ziel: Webhooks und damit ein
oeffentlich erreichbarer Rookery-Port.

## 2. Befund: was heute da ist

Alles hier ist am Code belegt.

1. **Es gibt keinen Kanalbegriff.** Es gibt drei Transporte auf dieselbe Pipeline: `/ws`
   (`routes/ws.ts`, der primaere), `/api/chat` als SSE-Rueckfallebene (`routes/chat.ts`) und die
   CLI. Alle drei rufen `Assistant.chat()` und lesen dieselben `AgentEvent`s. Ein vierter Transport
   fuegt sich also ohne Umbau ein – aber es gibt keine Stelle, an der "Kanal" als Konzept schon
   existiert und an der Rechte pro Kanal haengen koennten.
2. **Authentifizierung ist genau ein geteiltes Bearer-Token** (`server/src/auth.ts`). Leeres Token
   heisst bewusst "alles erlaubt", weil `config.host` auf `127.0.0.1` steht und Loopback selbst die
   Grenze ist. Telegram kehrt diese Annahme um: Der Bot ist von aussen erreichbar, bevor irgendein
   Rookery-Port es waere.
3. **Der Fan-out fuer Hintergrundereignisse steht schon.** `buildServer` haengt sich an `memory`,
   `assignment`, `message`, `changed`, `task`, `cron` und `sleep` des Assistenten und verteilt sie an
   alle offenen Websockets. Push nach Telegram ist ein weiterer Abonnent derselben Ereignisse, kein
   neuer Erzeugungsweg.
4. **Sitzungen sind persistent und transportunabhaengig.** `Session` traegt `providerSessionId`, der
   Store fuehrt sie in SQLite. Eine Telegram-Unterhaltung kann deshalb dieselbe Session sein, die im
   Browser in der Seitenleiste steht.
5. **Es gibt eine `meta`-Tabelle** (`memory/db.ts`, Schluessel/Wert), heute nur fuer die
   Schemaversion. Sie ist der richtige Platz fuer die Zuordnung Chat -> Session, ohne dafuer eine
   Tabelle anzulegen.
6. **Abbruch ist geloest.** `routes/ws.ts` haelt pro Turn einen `AbortController`; `chat()` nimmt ein
   `signal`. `/stop` im Bot ist dasselbe Muster mit einem anderen Schluessel.

## 3. Leitgedanke: ein Kanal, kein Assistent

Der Adapter liegt in `packages/server`, nicht in `packages/core`. Die Paketgrenze aus `AGENTS.md`
ist hier keine Formalie: `core` kennt kein HTTP, und der Telegram-Adapter ist zu neunzig Prozent
HTTP-Klempnerei. Was `core` bekommt, ist ausschliesslich die Konfigurationsform und ein abstraktes
Ausgangsereignis (Abschnitt 7.3) – nichts, was `api.telegram.org` kennt.

**Long Polling, kein Webhook.** Rookery bleibt an `127.0.0.1` gebunden und holt seine Nachrichten
selbst ab. Ein Webhook braucht eine oeffentlich erreichbare HTTPS-Adresse und macht damit genau die
Annahme kaputt, auf der das gesamte Auth-Modell steht. Der Preis ist eine offene ausgehende
Verbindung, die alle 50 Sekunden erneuert wird – tragbar.

**Fail closed.** Beim HTTP-Token heisst leer "offen", weil Loopback schuetzt. Beim Bot heisst leer
**"aus"**. Ohne Bot-Token startet der Kanal nicht, ohne mindestens eine erlaubte Telegram-ID startet
er auch nicht, und er sagt beim Start ins Log, welche der beiden Bedingungen gefehlt hat. Es gibt
keine Einstellung, die "jeder darf" bedeutet.

## 4. Sicherheitsmodell

Das ist der Teil, der die Sorgfalt verdient, weil an diesem Kanal (Entscheidung E1) volle Rechte
haengen.

### 4.1 Die Wache

Jedes eingehende Update durchlaeuft dieselbe Kette, in dieser Reihenfolge, und faellt beim ersten
Nein durch:

| # | Pruefung | Warum |
|---|---|---|
| 1 | `allowed_updates: ["message"]` beim Abruf | Telegram liefert bearbeitete Nachrichten, Callback-Queries und Kanal-Posts gar nicht erst aus. Filtern, was nie ankommt, kann man nicht vergessen. |
| 2 | `update.message` vorhanden, `from` vorhanden | Alles andere ist nicht klassifizierbar und wird verworfen. |
| 3 | `from.is_bot === false` | Kein Bot-zu-Bot-Verkehr. |
| 4 | `from.id` steht in `allowedUserIds` | Die eigentliche Wache. Numerische ID, nie `username`: Usernames sind frei wechselbar und werden nach Freigabe neu vergeben. |
| 5 | `chat.type === 'private'` **und** `chat.id === from.id` | Schliesst Gruppen, Supergruppen und Kanaele aus, auch wenn der Bot dort hineingezogen wird. Die zweite Haelfte der Bedingung schliesst aus, dass der Bot als Sprachrohr in einem fremden Chat landet. |
| 6 | kein `forward_origin`, kein `via_bot` | Eine weitergeleitete Nachricht ist fremder Text in der Hand des Besitzers – siehe 4.3. |
| 7 | `text` vorhanden und <= 4000 Zeichen | Medien werden in Phase 1 abgelehnt (Abschnitt 6.4). |

Faellt ein Update bei 3–7 durch, **antwortet der Bot nicht**. Es entsteht eine Warnzeile im Log mit
`from.id`, `username` und den ersten 80 Zeichen. Wer den Bot findet, bekommt nicht einmal bestaetigt,
dass hinter ihm etwas laeuft.

### 4.2 Bedrohungen und Gegengewichte

| Bedrohung | Gegengewicht |
|---|---|
| Fremder findet den Bot und schreibt ihn an | Allowlist auf numerische IDs, stilles Verwerfen, Log-Eintrag |
| Jemand legt einen Account mit dem gleichen `@username` an | Es wird nie ein Username geprueft |
| Bot wird in eine Gruppe gezogen | Nur `chat.type === 'private'`; zusaetzlich Gruppenbeitritt in BotFather abschalten (Bot Settings -> Allow Groups? -> off) |
| Bot-Token geraet nach aussen | Token nur in `~/.rookery/.env`, nie in `config.json`, nie in `publicConfig()`, nie in einer Logzeile. Bei Telegram steht der Token im Pfad der URL, also muss jede geloggte URL maskiert werden |
| Zwei Rookery-Instanzen pollen denselben Bot | Telegram antwortet mit `409 Conflict`; der Kanal schaltet sich ab und meldet es, statt in eine Schleife zu laufen |
| Nach Neustart wird ein alter Befehl nachgeholt | Beim Start `deleteWebhook(drop_pending_updates=true)`, dann `getUpdates(offset=-1, limit=1)`, um den Offset hinter das letzte Update zu setzen. Der Rueckstand wird bewusst verworfen |
| Nachrichtenflut startet viele Provider-Prozesse | Serielle Queue je Absender, Tiefe max. 3; darueber hinaus eine kurze Absage |
| Telegram-Konto des Besitzers uebernommen | **Das ist das Restrisiko bei vollen Rechten.** Gegengewichte: Zwei-Faktor-Anmeldung beim Telegram-Konto ist Pflicht, `/stop` bricht laufende Turns ab, `/aus` legt den Kanal bis zum Neustart still, jede Nachricht steht mit Absender-ID im Audit-Log |

### 4.3 Prompt-Injection bei vollen Rechten

Der Text aus Telegram ist Nutzereingabe und wird wie jede Nutzereingabe als Turn ausgefuehrt. Mit
`permission: 'full'` heisst das: Was in der Nachricht steht, kann Befehle auf dem Rechner ausloesen.
Die Allowlist stellt sicher, dass **der Besitzer** schreibt – sie stellt nicht sicher, dass der Text
vom Besitzer **stammt**. Kopiert er eine Fehlermeldung, eine Webseite oder eine fremde Nachricht
hinein, kommt fremder Text in einen Turn mit vollen Rechten.

Deshalb Pruefung 6: weitergeleitete Nachrichten werden abgelehnt, mit dem deutschen Hinweis, den
Inhalt bei Bedarf selbst zu tippen. Das ist kein Schutz gegen Einfuegen von Hand – so etwas gibt es
nicht – aber es schliesst den einen Weg, auf dem fremder Text mit einem Fingertipp und ohne Hinsehen
in den Kanal geraet. Dass der Rest Vertrauenssache bleibt, ist die bewusst getragene Konsequenz
von E1.

### 4.4 Audit

Jede angenommene Nachricht schreibt eine Zeile ins bestehende Log (`logger.ts`, `scope: 'telegram'`):
Zeitstempel, `from.id`, Session-Id, die ersten 120 Zeichen, Permission-Stufe. Jede abgelehnte
ebenfalls, mit Grund. Das ist die einzige Stelle, an der nachvollziehbar ist, was ueber den Kanal
befohlen wurde; ohne sie ist "volle Rechte" nicht verantwortbar.

## 5. Konfiguration

```ts
// packages/core/src/types.ts
export interface TelegramConfig {
  /** Der Kanal laeuft nur, wenn dies an ist UND Token und Allowlist gefuellt sind. */
  enabled: boolean;
  /**
   * Numerische Telegram-Nutzer-IDs, die den Bot bedienen duerfen.
   * Leer heisst aus. Es gibt kein "alle".
   */
  allowedUserIds: number[];
  /** Rechte fuer Turns aus diesem Kanal. Bewusst getrennt vom Web-Default. */
  permission: PermissionLevel;
  /** Modell fuer Telegram-Turns; leer = Config-Default. */
  model?: string;
  push: TelegramPushConfig;
}
```

- **Bot-Token**: ausschliesslich `TELEGRAM_BOT_TOKEN` aus `~/.rookery/.env` bzw. der Umgebung –
  derselbe Weg wie die Sprachschluessel (`main.ts: loadDotEnv`). Nicht in `config.json`, damit eine
  versehentlich weitergegebene Konfigurationsdatei keinen Fernzugriff verschenkt, und damit die
  Regel "keine API-Keys im Code" auch fuer Kanalgeheimnisse gilt.
- **Default** in `DEFAULT_CONFIG`: `{ enabled: false, allowedUserIds: [], permission: 'full', push: … }`.
  Der Default ist aus; `permission: 'full'` wirkt erst, wenn der Nutzer den Kanal bewusst einschaltet
  (E1).
- `publicConfig()` gibt `telegram` weiter; der Token steht dort ohnehin nicht. Die Allowlist selbst
  muss die UI sehen, sonst laesst sie sich nicht verwalten.
- `patchConfigSchema` bekommt `telegram: telegramConfigSchema`, mit `allowedUserIds` als
  `z.array(z.number().int().positive()).max(8)`.
- Aenderungen greifen wie ueberall ueber `applyConfig` ohne Neustart: Der Kanal beobachtet seine
  eigene Konfiguration und startet oder stoppt den Poller, wenn `enabled` oder die Allowlist sich
  aendert.

## 6. Der eingehende Weg

### 6.1 Abrufschleife

```
deleteWebhook(drop_pending_updates=true)
getMe()                        -> Token pruefen, Botnamen ins Log
getUpdates(offset=-1, limit=1) -> Rueckstand ueberspringen
loop:
  getUpdates(offset, timeout=50, allowed_updates=["message"])
```

- Netzfehler: exponentielles Warten 1 s -> 2 s -> 4 s … gedeckelt bei 60 s, Zaehler zurueck beim
  ersten Erfolg. Ein WLAN-Abriss darf keine Fehlerlawine ins Log schreiben.
- `429` mit `parameters.retry_after` wird respektiert.
- `409` beendet den Kanal (Abschnitt 4.2).
- `offset` wird erst nach der Klassifikation eines Updates hochgesetzt, nicht davor. Ein Absturz
  mitten im Turn verliert damit hoechstens eine Antwort, nie die Zuordnung.
- Der Poller haelt den Prozess nicht am Leben (`unref` auf allen Timern) und wird im
  `onClose`-Hook von `buildServer` sauber abgebrochen.

### 6.2 Chat zu Sitzung

`meta['telegram:chat:<chatId>']` -> `sessionId`. Fehlt der Eintrag oder ist die Session geloescht,
wird eine neue angelegt. Dafuer bekommt `Store` ein Paar `getMeta(key)` / `setMeta(key, value)` –
generisch, klein, und genau dafuer ist die Tabelle da.

Die Session ist eine gewoehnliche `kind: 'chat'`-Sitzung mit Titel "Telegram". **Bewusst kein
eigener `SessionKind`**: So steht die Unterhaltung vom Handy in derselben Seitenleiste wie alles
andere, und was unterwegs angefangen wurde, laesst sich am Schreibtisch weiterfuehren. Der Preis
ist, dass die Herkunft in der UI nicht unterscheidbar ist – dafuer reicht der Titel.

### 6.3 Turn und Antwort

```
sendChatAction(typing)   alle 4 s, solange der Turn laeuft (Telegram vergisst es nach 5 s)
for await (event of assistant.chat({ text, sessionId, permission, signal })) …
```

Gestreamt wird nicht. Telegram kennt kein stueckweises Nachliefern, und `editMessageText` im
Sekundentakt laeuft in die Ratenbegrenzung. Also: Tipp-Anzeige waehrend des Laufs, am Ende der Text
aus dem `done`-Ereignis.

- **Laenge**: Aufteilen bei 4096 Zeichen, bevorzugt an Absatz-, sonst an Zeilengrenzen, Codebloecke
  nicht mittendrin trennen.
- **Formatierung**: `parse_mode: 'HTML'` mit vollstaendigem Escaping von `&`, `<`, `>`, Codebloecke
  als `<pre>`. MarkdownV2 verlangt das Maskieren von siebzehn Zeichen und zerbricht an jeder zweiten
  Modellantwort; HTML hat drei.
- **Lange Laeufe**: Meldet der Turn nach 20 Sekunden noch nichts, geht eine Zwischenzeile raus
  ("Arbeite daran …"), danach hoechstens alle 60 Sekunden eine weitere aus `status`-Ereignissen.
  Werkzeugaufrufe einzeln zu melden waere auf dem Handy Laerm.
- **Fehler**: Ein `error`-Ereignis wird als Nachricht zugestellt, nicht verschluckt. Ein
  abgebrochener Turn meldet "Abgebrochen."

### 6.4 Was nicht angenommen wird

Fotos, Dokumente, Sprachnachrichten und Sticker werden in Phase 1 mit einer kurzen deutschen Absage
beantwortet. Sprachnachrichten sind der naheliegende naechste Schritt (Phase 3) – dafuer braucht es
eine Spracherkennung, die Rookery heute nicht hat; die vorhandene Sprachbedienung laeuft im Browser.

### 6.5 Befehle

| Befehl | Wirkung |
|---|---|
| `/start` | Begruessung. Fuer nicht Erlaubte: keine Antwort |
| `/neu` | Neue Session fuer diesen Chat; die alte bleibt im Verlauf |
| `/stop` | Bricht den laufenden Turn ab (`AbortController`) |
| `/status` | Provider, Kontingent, laufende Auftraege, letzter Schlaflauf |
| `/id` | Zeigt die eigene numerische ID – der Weg, sie in die Allowlist zu bekommen |
| `/aus` | Legt den Kanal bis zum Neustart still. Der Notaus fuer den Fall, dass das Telefon weg ist |

`/id` antwortet **jedem**, auch nicht Erlaubten, und zwar ausschliesslich mit der eigenen ID. Das ist
die einzige Ausnahme vom stillen Verwerfen: Ohne sie kommt man beim Einrichten nicht an die eigene
Nummer, und die Antwort verraet nichts, was der Absender nicht ohnehin weiss. Sie wird pro ID auf
eine Antwort pro Stunde gedrosselt.

## 7. Der ausgehende Weg: Push

### 7.1 Quellen

Dieselben Ereignisse, die `buildServer` heute an die Websockets verteilt:

| Ereignis | Wird gemeldet, wenn | Form |
|---|---|---|
| `assignment` | Status wechselt auf `done`, `failed` oder `cancelled` | Agent, Auftrag in einer Zeile, Dauer, die ersten 600 Zeichen des Ergebnisses |
| `cron` | Ein Lauf endet, und der Job ist als meldepflichtig markiert | Jobname, Ergebnis oder Fehler |
| `sleep` | Ein Schlaflauf endet | Verdichtet, gelinkt, eingeschlafen, Einsichten – der Bericht, den die Merkseite zeigt |
| `task` | Eine Aufgabe geht auf `blocked` | Was haengt und woran |
| `notify` | Jarvis ruft das Werkzeug (7.3) | Sein Text, unveraendert |

`message`, `memory` und `changed` werden **nicht** gepusht. Sie sind Oberflaechen-Ereignisse; auf dem
Handy waeren sie Dauerfeuer.

### 7.2 Drosselung, Ruhezeiten, Empfaenger

```ts
export interface TelegramPushConfig {
  enabled: boolean;
  assignments: boolean;   // default true
  cron: boolean;          // default true
  sleep: boolean;         // default true
  tasks: boolean;         // default false
  /** Nachtruhe, lokale Zeit. Leer = keine. */
  quietFrom?: string;     // "22:00"
  quietUntil?: string;    // "08:00"
  /** Obergrenze pro Stunde, danach wird zusammengefasst. */
  maxPerHour: number;     // default 12
  /** Wer bekommt Push. Leer = die erste erlaubte ID. */
  recipients: number[];
}
```

- **Ruhezeit**: Meldungen werden gesammelt und beim Ende der Ruhezeit als eine Zusammenfassung
  zugestellt ("3 Auftraege fertig, 1 fehlgeschlagen"). Ausgenommen sind Meldungen des
  `notify`-Werkzeugs mit `urgency: 'high'` – wenn Jarvis nachts weckt, hat er es so gemeint.
- **Obergrenze**: Ueber `maxPerHour` hinaus wird zusammengefasst statt weggeworfen. Nichts
  verschwindet still.
- **Entprellung**: Gleiche Auftrags-Id innerhalb von 10 Sekunden nur einmal – ein Lauf kann mehrere
  Ereignisse desselben Endzustands ausloesen.
- **Empfaenger**: `recipients` sind eine Teilmenge von `allowedUserIds`; eine ID, die nicht in der
  Allowlist steht, bekommt nichts, auch wenn sie hier eingetragen ist. Eine Liste kann nicht zur
  Hintertuer der anderen werden.
- **Zustellfehler**: Blockiert der Empfaenger den Bot (`403`), wird der Push fuer diese ID
  abgeschaltet und es entsteht eine Warnzeile – nicht endlos weiterversuchen.

### 7.3 Das `notify`-Werkzeug

Damit Jarvis von sich aus schreiben kann, kommt ein Werkzeug in `ORG_TOOLS` hinzu:

```
notify(text: string, urgency?: 'normal' | 'high')
```

Sichtbarkeit: `ASSISTANT_ONLY`. Ein Agent, der den Nutzer direkt anpiept, umgeht die Firma; er
schreibt an seinen Manager, und der Assistent entscheidet, ob das aufs Handy gehoert.

**Paketgrenze**: Der Handler in `org/controller.ts` kennt Telegram nicht. Er stellt fest, ob
ueberhaupt ein Ausgangskanal angemeldet ist, und gibt andernfalls einen klaren Fehler an das Modell
zurueck – kein stilles Verschlucken, sonst glaubt Jarvis, er haette Bescheid gegeben. Ist einer da,
emittiert der Assistent ein Ereignis:

```ts
assistant.emit('notify', { text, urgency, at });
```

`buildServer` abonniert es wie schon `cron` und `sleep`, und der Telegram-Kanal ist der Transport.
Damit bleibt `core` frei von HTTP, und ein zweiter Kanal (Signal, Matrix, E-Mail) haengt sich spaeter
an dieselbe Stelle, ohne dass `core` davon erfaehrt.

## 8. Struktur

| Datei | Art | Inhalt |
|---|---|---|
| `packages/server/src/channels/telegram.ts` | neu | Poller, Wache, Turn-Bruecke, Versand |
| `packages/server/src/channels/telegram-api.ts` | neu | Duenne Huelle um `api.telegram.org` mit Timeout, Backoff und Token-Maskierung |
| `packages/server/src/channels/push.ts` | neu | Ereignis-Abonnent, Ruhezeiten, Drosselung, Zusammenfassung |
| `packages/server/src/server.ts` | geaendert | Kanal starten neben `cron.start()`, im `onClose` stoppen |
| `packages/server/src/schemas.ts` | geaendert | `telegramConfigSchema` in `patchConfigSchema` |
| `packages/core/src/types.ts` | geaendert | `TelegramConfig`, `TelegramPushConfig`, `RookeryConfig.telegram` |
| `packages/core/src/config.ts` | geaendert | Defaults; `TELEGRAM_BOT_TOKEN` bleibt Umgebung, nicht Config |
| `packages/core/src/memory/store.ts` | geaendert | `getMeta` / `setMeta` |
| `packages/core/src/org/tools.ts` | geaendert | `notify` |
| `packages/core/src/org/controller.ts` | geaendert | Handler fuer `notify`, emittiert das Ereignis |
| `packages/web/src/pages/SettingsPage.tsx` | geaendert | Kanal an/aus, Allowlist, Push-Schalter, Ruhezeit |
| `packages/core/test/telegram.test.js` | neu | Die Wache (Abschnitt 4.1), Aufteilung langer Nachrichten, Ruhezeit-Fenster |

Keine neue Abhaengigkeit: Node 22 bringt `fetch` mit, die Telegram-Bot-API ist JSON ueber HTTPS. Eine
Bot-Bibliothek waere fuer sechs Endpunkte (`getMe`, `getUpdates`, `deleteWebhook`, `sendMessage`,
`sendChatAction`, `getFile`) mehr Abhaengigkeit als Nutzen.

## 9. Einrichtung (wie es sich fuer den Nutzer anfuehlt)

1. Bei **@BotFather** einen Bot anlegen, Token kopieren. Dort ausserdem: Allow Groups -> off,
   Privacy -> on.
2. `TELEGRAM_BOT_TOKEN=…` in `~/.rookery/.env`.
3. Server starten, den eigenen Bot anschreiben mit `/id` -> er antwortet mit der Nummer.
4. Nummer in den Einstellungen eintragen, Kanal einschalten.
5. Beim Telegram-Konto Zwei-Faktor-Anmeldung setzen, falls nicht geschehen. Ab hier ist dieses Konto
   ein Schluessel zum Rechner.

## 10. Phasen

**Phase 1 – Eingang.** Konfiguration, Poller, Wache, Session-Zuordnung, Turn, Antwort mit
Aufteilung, Befehle, Audit-Log, Tests fuer die Wache. Danach ist der Kanal benutzbar.

**Phase 2 – Ausgang.** `push.ts`, Ereignis-Abonnements, Ruhezeit und Drosselung, `notify`-Werkzeug
samt `notify`-Ereignis in `core`.

**Phase 3 – Oberflaeche und Komfort.** Einstellungsseite, Sprachnachrichten per Spracherkennung,
Fotos an Turns mit sehendem Modell, `/agent <slug>` fuer Direktchats mit einem Agenten.

## 11. Entscheidungen

- **E1 – Rechte (entschieden, 2026-09-11):** `permission: 'full'` fuer Telegram-Turns. Der Kanal ist
  damit gleichwertig zum lokalen Browser. Getragen wird das durch Abschnitt 4: Allowlist auf
  numerische IDs, nur private Chats, keine Weiterleitungen, Audit-Log, `/stop` und `/aus`. Die
  Einstellung bleibt trotzdem konfigurierbar, damit die Stufe ohne Codeaenderung sinken kann.
- **E2 – Push (entschieden, 2026-09-11):** Die Gegenrichtung ist Teil des Vorhabens, in Phase 2.
- **E3 – offen:** Soll `/neu` die alte Session archivieren oder stehen lassen? Vorschlag: stehen
  lassen, `archived` bleibt eine Nutzerentscheidung in der Web-UI.
- **E4 – offen:** Soll eine fehlgeschlagene Zustellung den Text in die Warteschlange zuruecklegen
  und beim naechsten erfolgreichen Versand nachliefern? Vorschlag: ja fuer `notify`, nein fuer
  Statusmeldungen – eine zwanzig Minuten alte Tipp-Anzeige hilft niemandem.
- **E5 – offen:** Zweiter Kanal (Signal, Matrix) spaeter – dann lohnt es, `channels/` um eine
  gemeinsame Schnittstelle zu ergaenzen. Solange es einer ist, waere die Abstraktion Rateraterei.
