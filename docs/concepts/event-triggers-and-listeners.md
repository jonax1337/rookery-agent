# Ereignisse feuern Zeitplaene, Listener warten statt zu fragen

Stand: 2026-09-17. **Umgesetzt.** Der Code liegt in
`packages/core/src/cron/scheduler.ts` (Annahme eines Ereignisses, Buendelung,
Ruhezeit, Webhook-Geheimnis), `packages/core/src/types.ts` und
`packages/core/src/config.ts` (Vertrag und Defaults fuer `triggerMode`,
`webhookToken`, `eventCooldownMs`, `listeners`),
`packages/core/src/cron/store.ts` und `packages/core/src/memory/db.ts`
(Schema 18: die drei Spalten auf `cron_jobs`, `source` auf `cron_runs`, ein
partieller Unique-Index auf dem Webhook-Token); der Transport in
`packages/server` – die Webhook-Route ausserhalb von `/api` und der
IMAP-Listener, der eine Verbindung offen haelt –, die Oberflaeche auf den
Schedules-Seiten unter `packages/web/src/pages/`.

## 1. Befund

Ein Zeitplan kannte bis hierher genau zwei Absender: die Uhr und einen
Menschen, der „Jetzt ausfuehren" drueckt. Alles, was auf etwas *reagieren*
soll, musste deshalb fragen. Das ist teuer und langsam zugleich, und beides
aus demselben Grund: Ein Mail-Waechter auf `*/5 * * * *` startet zwoelfmal pro
Stunde einen vollwertigen Lauf – eine Session, ein Modellaufruf, ein Eintrag
im Ledger – und die haeufigste Antwort dieses Laufs lautet, dass nichts
passiert ist. Wenn dann doch etwas passiert, liegt es im Mittel zweieinhalb
und im schlechtesten Fall fuenf Minuten zurueck. Man kann das Intervall
verkuerzen; dann steigen die Kosten linear und die Verspaetung sinkt nur
linear mit.

Dass diese Luecke bekannt war, steht im Repo schwarz auf weiss:
`packages/core/src/migration-cron.ts:143` ueberspringt beim Import aus
OpenClaw und Hermes jeden Job, der ein `trigger`-Feld traegt, mit der
Begruendung „conditional triggers and pacing require manual migration".
Nicht, weil solche Jobs unwichtig waeren, sondern weil Rookery keine Form
hatte, in die man sie haette schreiben koennen. Ein uebersprungener Import ist
die ehrlichste Art, ein fehlendes Konzept zu dokumentieren.

## 2. Entscheidungen

**E1 – Die Uhr und das Ereignis sind zwei verschiedene Fragen.**
`triggerMode` beantwortet genau eine davon: Feuert die Uhr diesen Job?
`'schedule'` heisst ja, `'event'` heisst nein – und dann darf `schedule` leer
bleiben, ein Ausdruck wird nicht verlangt und `nextRunAt` bleibt ungesetzt, so
dass weder `dueJobs` noch der Timer den Job je wieder ansieht. Die zweite
Frage – darf ein Ereignis diesen Job feuern? – wird vom Modus *nicht*
beantwortet: `runEvent` nimmt beide Arten an. Damit gibt es eine dritte
Sorte Job, und sie ist die eigentlich interessante: ein Zeitplan mit
Ausdruck *und* Webhook. Das Ereignis ist der schnelle Weg, der Ausdruck ist
die Rueckfallebene fuer das Ereignis, das nicht kam – ein Listener, der um
drei Uhr nachts still abgebrochen ist, kostet dann eine verspaetete Reaktion
und nicht eine ausgefallene. Konsequenterweise setzt auch ein Ereignis-Lauf
den naechsten Uhr-Termin neu: ein Lauf ist ein Lauf, gleich wer ihn bestellt
hat, und die Uhr faengt nur das ab, was sonst gar nicht passiert waere.

**E2 – Ereignisse werden nie verworfen, nur verzoegert.** Zwei Mechanismen,
und beide geben dasselbe Versprechen. Laeuft der Job gerade, wird das
Ereignis vermerkt (`coalesced`) und genau ein weiterer Lauf folgt, sobald der
erste fertig ist. Ruht der Job noch – `eventCooldownMs`, Standard 60 000 ms –,
wird es ebenfalls vermerkt, ein `unref`'ter Timer auf das Ende der Ruhe
gesetzt und `queued` mit der Restzeit zurueckgegeben. Wie viele Ereignisse in
diesem Fenster eintreffen, spielt keine Rolle: Der Vermerk ist einer pro Job
und behaelt nur den zuletzt genannten Absender, also fallen zehn Mails in
einer Minute zu einem Lauf zusammen.

Die naheliegende Alternative war, Ereignisse innerhalb der Ruhezeit einfach
wegzuwerfen. Sie ist verworfen, weil der verworfene Fall genau der teure ist:
Die zehnte Mail ist haeufig die, auf die es ankommt, und ein Waechter, der
sie stillschweigend verschluckt, ist schlimmer als einer, der pollt – beim
Poller weiss man wenigstens, wann er das naechste Mal hinsieht. Die andere
Richtung, ein Lauf pro Ereignis ohne Deckel, waere noch schlechter: Sie macht
die Kosten des Assistenten zu einer Groesse, die ein Absender von aussen
bestimmt, und aus einem Newsletter-Versand einen Sturm von Modellaufrufen.
Die Ruhezeit ist der Preis dafuer, dass beides nicht passiert; wer jedes
einzelne Ereignis will, setzt sie auf 0 und weiss, was er tut.

**E3 – Ein ausgeschalteter Zeitplan ignoriert Ereignisse.** `runEvent`
antwortet dann `ignored` mit Grund und tut nichts, ebenso bei aufgebrauchten
`remainingRuns` und bei einem importierten Skript, das noch nicht
freigegeben ist – dieselbe Pruefung, die ein Handlauf passieren muss. Der
Schalter ist das, wonach ein Mensch greift, wenn etwas aufhoeren soll, und er
muss halten, was er aussieht. Eine URL, die vor Wochen herausgegeben wurde
und einen abgeschalteten Job trotzdem weckt, waere die unangenehmste Art,
diese Geste zu entwerten.

**E4 – Das Webhook-Geheimnis gehoert dem Job, nicht dem Server.** Es ist eine
`randomUUID` pro Job, gespeichert in `cron_jobs.webhook_token` mit partiellem
Unique-Index, ausgestellt und rotiert von `enableWebhook` (was auch immer
vorher dort stand, hoert in derselben Sekunde auf zu funktionieren),
weggenommen von `disableWebhook`. `findByWebhookToken` oeffnet mit einem
leeren Token nichts. Vor allem aber sitzt die Route **ausserhalb von `/api`**:
Dort haengt der Bearer-Token-Hook vor jedem Handler, und eine Webhook-Route
unter `/api` waere entweder durch das geteilte Server-Token geschuetzt – dann
gaebe der Aufrufer, der einen einzelnen Job feuern soll, den Schluessel zum
ganzen Rookery in die Hand – oder sie waere eine Ausnahme im Auth-Hook, und
Ausnahmen in einem Auth-Hook sind die Sorte Code, die man in zwei Jahren
falsch liest. Ein eigener Pfad mit einem eigenen Geheimnis pro Job heisst:
Wer eine URL hat, hat genau diesen einen Job, kann ihn feuern und sonst
nichts, und ihm den Zugriff zu nehmen, kostet einen Klick und beruehrt
niemanden sonst.

**E5 – Ein Listener ist eine offen gehaltene Verbindung, und die liegt im
Server.** IMAP IDLE ist der erste: eine Verbindung zum Postfach, die nicht
fragt, sondern zuhoert, und bei der der Server von sich aus meldet, dass Post
da ist. Das ist die eigentliche Antwort auf den Befund – nicht seltener
fragen, sondern gar nicht. Der Preis ist ein Socket statt eines Modellaufrufs
alle fuenf Minuten. Er liegt in `packages/server`, weil `packages/core` kein
HTTP und keine Sockets kennt; `core` bekommt von dieser Stufe nur die
Konfigurationsform (`ListenersConfig`, `ImapListenerConfig`) und die
Entscheidung, was mit einem Ereignis geschieht. Was der Listener nach oben
gibt, ist ein einziger Satz: „bei `jobId` ist etwas passiert, Absender
`imap:<id>`". Er liest keine Mail, faellt kein Urteil und kennt den Prompt des
Jobs nicht – das ist Sache des Laufs, den er ausloest. Der Absender laeuft
als `CronRun.source` bis in den Lauf und in die Posteingangs-Notiz („fired by
imap:work"), damit im Nachhinein ohne Raten feststeht, warum gelaufen wurde.

## 3. Abgrenzung zum Telegram-Konzept

`telegram-channel.md:78` hat Webhooks ausdruecklich abgelehnt, und die
Begruendung war keine Geschmacksfrage: „Ein Webhook braucht eine oeffentlich
erreichbare HTTPS-Adresse und macht damit genau die Annahme kaputt, auf der
das gesamte Auth-Modell steht." In der Nicht-Ziel-Liste desselben Dokuments
steht derselbe Satz kuerzer: „Webhooks und damit ein oeffentlich erreichbarer
Rookery-Port."

Diese Entscheidung gilt unveraendert, und diese Stufe widerspricht ihr nicht.
Abgelehnt wurde, dass ein **fremder Dienst von aussen hereinruft**: Telegrams
Server stehen im Internet, und damit sie Rookery erreichen, muss Rookery im
Internet stehen. Genau deshalb holt der Kanal seine Nachrichten bis heute
selbst ab. Der Webhook dieser Stufe ist das Gegenteil: eine **lokale
Ausloeseflaeche**. Was ihn aufruft, laeuft auf demselben Rechner – ein Skript,
ein `curl` aus einem Task, der IMAP-Listener aus E5, ein anderes Programm auf
`127.0.0.1`. Er aendert an der Bindung des Ports nichts, verlangt kein TLS von
aussen und keine Domain; er ist eine zweite Tuer in demselben Haus, kein
zweiter Eingang von der Strasse.

Das Restrisiko wird trotzdem benannt, statt es mit dieser Unterscheidung
abzuraeumen: Wenn der Nutzer den Port doch nach aussen oeffnet – hinter einem
Reverse Proxy, ueber ein Tunnel-Werkzeug, aus welchem Grund auch immer –,
dann ist jede Job-URL von aussen erreichbar, und sie traegt ihre
Berechtigung im Pfad. Dagegen stehen drei Dinge, und sie sind der Grund,
warum E3 und E4 so aussehen, wie sie aussehen: Das Geheimnis ist nicht zu
raten, es gilt fuer genau einen Job, und es ist einzeln widerrufbar, ohne dass
irgendetwas anderes neu eingerichtet werden muesste. Dazu kommt der Schalter –
ein abgeschalteter Job ignoriert seine eigene URL. Was ein Angreifer mit
einer erratenen URL erreichen koennte, ist ausserdem begrenzt: Er startet
einen Lauf, den der Nutzer selbst geschrieben hat, er bestimmt seinen Inhalt
nicht, und die Ruhezeit aus E2 deckelt, wie oft.

## 4. Was sich nicht geaendert hat

Die Uhr ist dieselbe: ein Timer, ein `#arm`, ein Ledger, kein zweites
verstecktes Uhrwerk. Es bleibt bei **einem Lauf pro Job** – die `#running`-Map
ist unveraendert die Stelle, an der das entschieden wird, und ein Ereignis
umgeht sie nicht, sondern wird von ihr in die Warteschlange geschoben. Jeder
Lauf, gleich von wem bestellt, schreibt seine Zeile in `cron_runs` und seine
Notiz in den Posteingang; die Notiz sagt jetzt zusaetzlich, wer gefeuert hat,
und erfindet keinen Ausdruck mehr fuer einen Job, der keinen hat. `kind:
'sleep'` bleibt intern und taucht in keiner Nutzerliste auf – ein Ereignis
macht daraus keinen Job wie jeden anderen. Und die Regel aus
`night-intensity-and-cron-exclusion.md` gilt weiter: Aus dem Prompt eines
geplanten Laufs lernt das Gedaechtnis nichts, und ein Ereignis-Lauf ist
derselbe geplante Lauf mit einem anderen Absender.

## 5. Offene Punkte

- **Outlook bleibt vorerst ein Poller, und das ist kein Versehen.** Microsoft
  Graph kennt Push, aber Graph-Subscriptions rufen einen `notificationUrl`
  auf, den Microsoft erreichen kann – also eine oeffentlich erreichbare
  Adresse, genau das, was Abschnitt 3 ausschliesst. Auf einer rein lokalen
  Installation, und das ist der Fall des Nutzers, funktioniert das nicht;
  IMAP IDLE funktioniert dort, weil die Verbindung von innen nach aussen
  aufgebaut wird. Der ehrliche Ausweg fuer Graph ist deshalb keine Webhook-
  Bastelei, sondern die Delta-Abfrage auf einem engeren Intervall: weiterhin
  ein Zeitplan, aber einer, der billig feststellt, dass nichts passiert ist.
  Umgesetzt ist davon nichts.
- **Der Vermerk ueber ein wartendes Ereignis liegt im Speicher.** `#pending`
  ist eine Map im Scheduler; ein Neustart vergisst sie, und `stop()` raeumt
  sie ab. Verteidigbar ist das, weil der Vermerk nur sagt „hier hat etwas
  noch niemand angesehen", und nach einem Neustart sieht ohnehin jemand nach –
  der Listener verbindet sich neu und meldet, was inzwischen da ist, und ein
  uhrgestuetzter Job hat seinen Ausdruck. Verschwiegen werden soll es
  trotzdem nicht: Genau zwischen Absturz und Neuverbindung kann ein Ereignis
  verlorengehen, und das ist der einzige Fall, in dem das Versprechen aus E2
  nicht haelt.
- **Die Ruhezeit ist eine Zahl, die jemand verstehen muss.** 60 Sekunden sind
  ein Kompromiss und kein Naturgesetz; wer Mails im Minutentakt bekommt, will
  vielleicht 300 Sekunden, und wer auf einen Build wartet, will 0. Im Formular
  ist das ein Feld mit einer Einheit, und ein Feld mit einer Einheit erklaert
  sich nie von selbst. Ob daraus spaeter eine Auswahl mit Woertern („sofort",
  „gebuendelt", „hoechstens stuendlich") werden sollte, ist offen – erst
  sehen, wie oft der Wert ueberhaupt angefasst wird.
- **Es gibt nur eine Art Listener.** `ListenerKind` kennt heute `'imap'` und
  sonst nichts. Eine gemeinsame Abstraktion fuer „Verbindung, die wartet"
  waere mit einem einzigen Beispiel dieselbe Rateraterei, die in
  `telegram-channel.md` (E5) fuer den zweiten Gateway-Transport
  offengelassen wurde.
