# Telegram als Fernsteuerung

Stand: 2026-09-11. **Umgesetzt**; dieses Dokument bleibt als Begruendung stehen. Der Code liegt in
`packages/core/src/gateway/policy.ts` (Wache, Nachrichtenaufteilung, Ruhezeit - die reine
Entscheidungslogik, siehe Abschnitt 3), `packages/core/src/types.ts`, `packages/core/src/config.ts`,
`packages/core/src/memory/store.ts` und `packages/core/src/org/tools.ts` bzw. `org/controller.ts`
(das `notify`-Werkzeug); der Transport in `packages/server/src/gateways/telegram.ts`,
`telegram-api.ts` und `push.ts` sowie `routes/gateways.ts`; die Oberflaeche unter `/gateways` in
`packages/web/src/pages/GatewaysPage.tsx` und `GatewayDetailPage.tsx`. Telegram ist darin das erste
von mehreren Gateways (Abschnitt 3, E5) – der Einstellungsbereich heisst deshalb durchgaengig
"Gateway", nicht "Telegram".

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

Beim Bauen hat sich diese Grenze noch einmal geteilt, und zwar innerhalb dessen, was "kein HTTP"
bedeutet: Die Wache (4.1), das Aufteilen langer Nachrichten (6.3) und das Ruhezeit-Fenster (7.2)
sind reine Entscheidungen ueber Werte – kein Netz, keine Uhr, kein Socket. Die liegen deshalb in
`packages/core/src/gateway/policy.ts`, nicht im Transport, und genau deshalb ohne Mock-Server unter
`packages/core/test/gateway.test.js` testbar. `packages/server/src/gateways/telegram.ts` ruft diese
Funktionen nur noch auf; was dort steht, ist Langabruf, Turn-Bruecke und Versand – der Teil, der
tatsaechlich einen Socket braucht und deshalb nicht anders als gegen `api.telegram.org` selbst
pruefbar ist.

**Long Polling, kein Webhook.** Rookery bleibt an `127.0.0.1` gebunden und holt seine Nachrichten
selbst ab. Ein Webhook braucht eine oeffentlich erreichbare HTTPS-Adresse und macht damit genau die
Annahme kaputt, auf der das gesamte Auth-Modell steht. Der Preis ist eine offene ausgehende
Verbindung, die alle 50 Sekunden erneuert wird – tragbar.

**Fail closed.** Beim HTTP-Token heisst leer "offen", weil Loopback schuetzt. Beim Bot heisst leer
**"aus"**. Ohne Bot-Token startet der Kanal nicht, ohne mindestens eine erlaubte Telegram-ID startet
er auch nicht, und er sagt beim Start ins Log, welche Bedingung gefehlt hat. Es gibt keine
Einstellung, die "jeder darf" bedeutet.

Die eine Ausnahme ist die **Kopplung** (`gateways.telegram.pairing`), und sie ist eine Ausnahme vom
Start, nicht von der Wache. Ohne sie ist die Ersteinrichtung ein geschlossener Kreis: Die Allowlist
braucht eine Nummer, die Nummer kommt aus `/id`, und `/id` antwortet nur, wenn der Kanal laeuft –
was er ohne Eintrag in der Allowlist nicht tut. Eingeschaltet pollt der Kanal mit leerer Liste;
jede Nachricht faellt weiterhin als `not_allowed` durch, und das Einzige, was zurueckkommt, ist die
eigene Absender-ID. Bezahlt wird dafuer mit dem Schweigen: Wer den Bot findet, erfaehrt, dass er
lebt. Deshalb ein Schalter, den der Nutzer bewusst umlegt, standardmaessig aus, und der sich beim
Eintragen der ersten ID selbst wieder schliesst.

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
| Bot-Token geraet nach aussen | Token in `~/.rookery/config.json` neben dem Bearer-Token, nie in `publicConfig()`, nie in einer API-Antwort, nie in einer Logzeile. Bei Telegram steht der Token im Pfad der URL, also maskiert `telegram-api.ts` jeden String, der das Modul verlaesst – auch fetch-eigene Fehlertexte |
| Zwei Rookery-Instanzen pollen denselben Bot | Telegram antwortet mit `409 Conflict`; der Kanal haelt an und meldet es, statt in eine Schleife zu laufen (6.1) |
| Ungueltiger Token laeuft ewig gegen die Wand | `401` haelt den Kanal genauso an wie `409`, statt ihn im Minutentakt weiterprobieren zu lassen (6.1) |
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
/** Welchem Gateway ein Konfigurationsabschnitt gehoert. Bisher nur Telegram. */
export type GatewayId = 'telegram';

export interface GatewaysConfig {
  telegram: TelegramGatewayConfig;
}

export interface TelegramGatewayConfig {
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

Konfiguriert liegt der Abschnitt unter `gateways.telegram`, nicht unter `telegram` – auch das ein
Rest des Umbaus auf mehrere Gateways: `GatewaysConfig` ist der Container, `GatewayId` benennt heute
genau einen moeglichen Eintrag.

- **Bot-Token**: `gateways.telegram.token`, eingetragen auf der Gateway-Seite, gespeichert in
  `~/.rookery/config.json`. Der erste Entwurf legte ihn nach `~/.rookery/.env`, mit Verweis auf die
  Regel "keine API-Keys im Code". Die Regel meint Code und Beispiele und zielt auf Provider-Auth;
  `config.json` ist keins von beidem, sondern lokaler Nutzerzustand. Vor allem aber steht
  `RookeryConfig.token` – das Bearer-Token fuer den ganzen Server – laengst dort: dasselbe
  Verzeichnis, dieselben Dateirechte, derselbe Umgang. Ein zweiter Ort haette keinen
  Sicherheitsgewinn gebracht, sondern Funktion gekostet: `.env` wird einmal beim Prozessstart
  gelesen, also waere genau die Live-Einrichtung unmoeglich geblieben, fuer die die Seite da ist.
  Der Schutz liegt woanders – `publicConfig` leert das Feld beim Ausliefern (wie beim Bearer-Token),
  das Patch-Schema nimmt es nur entgegen, und `GatewayStatus` meldet bloss, *ob* einer gesetzt ist
  und *woher* er kommt. Auf einem PATCH heisst leer "unveraendert lassen" und `null` "loeschen";
  ein Formular, dem der echte Wert nie gezeigt wird, sendet sonst bei jedem Speichern eine Leerung.
  `TELEGRAM_BOT_TOKEN` bleibt als vorrangige Quelle fuer kopflose Installationen; die Seite sagt
  dann, dass die Variable gewinnt, statt das Feld heimlich wirkungslos zu machen.
- **Default** in `DEFAULT_CONFIG`: `gateways.telegram = { enabled: false, allowedUserIds: [],
  permission: 'full', push: … }`. Der Default ist aus; `permission: 'full'` wirkt erst, wenn der
  Nutzer den Kanal bewusst einschaltet (E1).
- `publicConfig()` gibt `gateways` weiter; der Token steht dort ohnehin nicht. Die Allowlist selbst
  muss die Oberflaeche sehen, sonst laesst sie sich nicht verwalten.
- `patchConfigSchema` bekommt `gateways: gatewaysConfigSchema`, die ihrerseits
  `telegram: telegramConfigSchema` traegt, mit `allowedUserIds` als
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
- `409` (zweiter Prozess am selben Bot) und `401` (Telegram kennt den Token nicht) halten den
  Kanal **an**. Beide heilen nicht von selbst, und ein Backoff waere hier nur ein Log voll
  derselben Zeile. Angehalten ist aber nicht endgueltig: Vermerkt wird der Token, mit dem es
  schiefging – ein neuer hebt die Sperre auf, und den Kanal aus- und wieder einzuschalten
  ebenfalls, weil das die Geste fuer "nochmal von vorn" ist. Ohne diese beiden Ausnahmen haette
  ein korrigierter Token einen Serverneustart gebraucht. Die Gateway-Seite zeigt den Zustand als
  eigenes Wort ("Angehalten"), nicht als "Fehler" – "Fehler" liest sich wie etwas, das vergeht.
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

Fotos, Dokumente, Sprachnachrichten und Sticker werden stillschweigend verworfen und nur geloggt.
Der erste Entwurf sah hier eine kurze deutsche Absage vor; das widersprach 4.1, und 4.1 gewinnt:
eine Antwort ist eine Antwort, auch wenn sie ablehnt. Wer ein Foto schickt und "kann ich nicht"
zurueckbekommt, weiss, dass hinter dem Bot etwas laeuft – und genau diese Auskunft soll kein
Unbefugter bekommen. Sprachnachrichten sind der naheliegende naechste Schritt (Phase 3) – dafuer
braucht es eine Spracherkennung, die Rookery heute nicht hat; die vorhandene Sprachbedienung
laeuft im Browser.

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
| `task` | Eine Aufgabe geht auf `failed` | Welche Aufgabe gescheitert ist. Der Entwurf sagte `blocked` – den Zustand fuehrt das Board nicht, und ein Zweig, der nie feuert, ist schlimmer als keiner |
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
| `packages/core/src/gateway/policy.ts` | neu | Wache (4.1), Aufteilung langer Nachrichten, Ruhezeit-Fenster, Push-Empfaenger – reine Entscheidungslogik ohne HTTP (Abschnitt 3) |
| `packages/core/test/gateway.test.js` | neu | Tests fuer `policy.ts` |
| `packages/core/src/types.ts` | geaendert | `GatewayId`, `GatewaysConfig`, `TelegramGatewayConfig`, `TelegramPushConfig`, `NotifyEvent` |
| `packages/core/src/config.ts` | geaendert | Defaults unter `gateways.telegram`; `TELEGRAM_BOT_TOKEN` als vorrangige Quelle in `envOverrides` |
| `packages/core/src/memory/store.ts` | geaendert | `getMeta` / `setMeta` |
| `packages/core/src/org/tools.ts` | geaendert | `notify` |
| `packages/core/src/org/controller.ts` | geaendert | Handler fuer `notify`, emittiert das Ereignis |
| `packages/server/src/gateways/telegram.ts` | neu | Poller, Aufruf der Wache aus `policy.ts`, Turn-Bruecke, Versand |
| `packages/server/src/gateways/telegram-api.ts` | neu | Duenne Huelle um `api.telegram.org` mit Timeout, Backoff und Token-Maskierung |
| `packages/server/src/gateways/push.ts` | neu | Ereignis-Abonnent, Ruhezeiten, Drosselung, Zusammenfassung |
| `packages/server/src/routes/gateways.ts` | neu | `GET /api/gateways`, `POST /api/gateways/:id/test` |
| `packages/server/src/server.ts` | geaendert | Kanal starten neben `cron.start()`, Routen registrieren, im `onClose` stoppen |
| `packages/server/src/schemas.ts` | geaendert | `gatewaysConfigSchema` (mit `telegramConfigSchema`) in `patchConfigSchema` |
| `packages/web/src/pages/GatewaysPage.tsx` | neu | Tabelle aller Gateways unter `/gateways` – heute eine Zeile, aber ohne das im Code anzunehmen |
| `packages/web/src/pages/GatewayDetailPage.tsx` | neu | Detailseite unter `/gateways/:id`: an/aus, Allowlist, Push-Schalter, Ruhezeit, Testversand |
| `packages/web/src/hooks/useGateways.ts` | neu | Datenzugriff fuer beide Seiten |
| `packages/web/src/lib/gateways.ts` | neu | Statusdarstellung (Badges, Zustandstexte) |
| `packages/web/src/lib/nav.ts` | geaendert | Eigener Sidebar-Eintrag "Gateway" unter `/gateways`, Gruppe "Betrieb" |
| `packages/web/src/lib/api.ts` | geaendert | `getGateways`, `testGateway` |
| `packages/web/src/lib/types.ts` | geaendert | `GatewayId`, `GatewaysConfig`, `TelegramGatewayConfig`, `GatewayStatus`, `GatewayTestResult` |

Keine neue Abhaengigkeit: Node 22 bringt `fetch` mit, die Telegram-Bot-API ist JSON ueber HTTPS. Eine
Bot-Bibliothek waere fuer sechs Endpunkte (`getMe`, `getUpdates`, `deleteWebhook`, `sendMessage`,
`sendChatAction`, `getFile`) mehr Abhaengigkeit als Nutzen.

## 9. Einrichtung (wie es sich fuer den Nutzer anfuehlt)

1. Bei **@BotFather** einen Bot anlegen, Token kopieren. Dort ausserdem: Allow Groups -> off,
   Privacy -> on.
2. Unter **Gateway** (`/gateways`) den Token einfuegen, **Kopplung** einschalten, speichern. Der
   Kanal laeuft damit mit leerer Allowlist: jede Nachricht faellt weiterhin durch die Wache,
   einzig `/id` antwortet.
3. Den eigenen Bot anschreiben mit `/id` -> er antwortet mit der Nummer.
4. Nummer eintragen. Die Kopplung schaltet sich dabei selbst ab; Kanal einschalten, fertig -
   alles ohne Neustart.
5. Beim Telegram-Konto Zwei-Faktor-Anmeldung setzen, falls nicht geschehen. Ab hier ist dieses Konto
   ein Schluessel zum Rechner.

## 10. Phasen

**Phase 1 – Eingang (erledigt).** Konfiguration, Poller, Wache, Session-Zuordnung, Turn, Antwort mit
Aufteilung, Befehle, Audit-Log, Tests fuer die Wache. Der Kanal ist benutzbar.

**Phase 2 – Ausgang (erledigt).** `push.ts`, Ereignis-Abonnements, Ruhezeit und Drosselung,
`notify`-Werkzeug samt `notify`-Ereignis in `core`.

**Phase 3 – Oberflaeche (erledigt).** Eigener Bereich **Gateway** unter `/gateways`:
Uebersichtstabelle (`GatewaysPage.tsx`) und Detailseite (`GatewayDetailPage.tsx`) mit an/aus,
Allowlist, Push-Schaltern, Ruhezeit und Testversand.

**Naechste Stufe – offen.** Sprachnachrichten per Spracherkennung, Fotos an Turns mit sehendem
Modell, `/agent <slug>` fuer Direktchats mit einem Agenten.

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
- **E5 – teilweise entschieden:** Die Huelle fuer mehrere Gateways ist beim Bauen schon entstanden –
  `GatewayId`, `GatewaysConfig`, `GatewayStatus` und die generische Tabelle unter `/gateways` nehmen
  keinen zweiten Eintrag an, sondern zeichnen, was `GET /api/gateways` liefert. Offen bleibt der
  eigentliche zweite Transport (Signal, Matrix): `packages/server/src/gateways/` haelt bisher nur
  `telegram.ts`, `telegram-api.ts` und `push.ts`, und eine gemeinsame Transport-Schnittstelle fuer den
  Poller/Versand-Teil zu ziehen, waere mit nur einem Beispiel weiterhin Rateraterei.
