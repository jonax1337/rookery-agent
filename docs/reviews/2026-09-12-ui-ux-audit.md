# UI- und UX-Prüfung vom 12. September 2026

Die vorhandene shadcn-Oberfläche wurde im Browser durchgegangen und gezielt korrigiert. Farben, Schrift, Seitenstruktur und Komponentenbibliothek bleiben erhalten.

## Behobene Befunde

| Bereich | Vorher | Jetzt / Nachweis |
| --- | --- | --- |
| Kennzahlen | Bei 1280 × 720 belegten vier Karten zwei hohe Zeilen und schoben Listen nach unten. | Kompakte Karten in einer Zeile; bei schmaleren Inhaltsbereichen weiterhin weniger Spalten. Zahlenbasis bleibt benannt. Im Browser geprüft. |
| Navigation | Einstellungen verschwanden im scrollenden Menü; aktive Unterbereiche klappten beim Routenwechsel nicht auf. | Einstellungen stehen im festen Fußbereich. Aktive Bereiche öffnen sich; manuelles Zuklappen bleibt möglich. |
| Mobile Navigation | Das Menü blieb nach Auswahl eines Ziels offen. | Links und „Neues Gespräch“ schließen es, auch beim erneuten Öffnen derselben Route. Im Browser geprüft. |
| Firmentabs | Nach Klick auf Teams oder Projekte verschwand die Tab-Leiste. Hauptaktion blieb „Agent einstellen“. | Alle drei Tabs bleiben stehen; Hauptaktion passt zum Bereich. Browserprüfung mit Team- und Projektwechsel. |
| Gedächtnistabs | Netz und Nächte verloren ebenfalls die Tab-Leiste. | Wechsel zwischen allen drei Ansichten bleibt direkt möglich. |
| Tabellen | Die erste Spalte wurde unabhängig vom Inhalt auf Auswahlbreite gedrückt. Gateway-Zahl und Überschrift waren unterschiedlich ausgerichtet. | Nur Auswahl und Aktionen reservieren eine schmale Spalte; Gateway-Zahlen stehen rechtsbündig. |
| Sortierung | TanStack meldete fehlende Text-/Alphanumerik-Vergleiche; die Sortieraktion konnte wirkungslos bleiben. | Vergleichsfunktionen zentral registriert. Absteigende Agentenliste im Browser bestätigt; Regressionen für Text, nummerierte Namen, Zahlen und Datum. |
| Globale Suche | Nur die acht jüngsten Einträge je begrenzter Gruppe wurden überhaupt durchsucht. | Suchtext berücksichtigt alle bereits geladenen Einträge. Ein älteres Gespräch außerhalb der ersten acht wurde im Browser gefunden. API-Limits bleiben bestehen. |
| Speichern | Ein abgefangener Fehler wirkte für Einstellungen/Gateway wie Erfolg; Telegram zeigte zusätzlich eine Erfolgsmeldung. | Erfolg wird ausdrücklich zurückgegeben. Fehler und Änderungen während einer Anfrage behalten den Entwurf. Isolierte Regressionen prüfen die Fälle ohne Live-Konfiguration zu ändern. |
| Formulare | Gleichzeitige Submit-Aufrufe konnten doppelt schreiben; Fokus blieb nach Validierungsfehlern beim Speichern-Knopf. | Gemeinsamer Schutz gegen parallele Submits und Fokus auf das erste ungültige Feld. Im Aufgabenformular mit leerer Beschreibung im Browser bestätigt, ohne Datensatz anzulegen. |
| Mobiler Chat | Einstellungszeile lief horizontal aus dem Bildschirm; Senden war nicht erreichbar. Vorschläge zerfielen in schmale Textspalten. | Einstellungszeile bricht um, Senden bleibt sichtbar; Vorschlagstexte fließen zusammen. Bei 320 und 390 Pixel Breite geprüft. |
| Mobile Kopfzeile / Netz | Lange Titel drängten Aktionen und Suche hinaus; Graph-Werkzeugleiste war zu breit. | Kopfzeile kann umbrechen; Graph-Steuerung passt sich an. Keine Seitenüberbreite bei den geprüften Ansichten. |
| Sprachmodus | Die vollflächige Startansicht lag über dem sichtbaren Beenden-Knopf. | Kopfzeile liegt darüber. Der Knopf führt auch vor Mikrofonaktivierung zurück zu den Sprachgesprächen, im Entwicklungs- und Produktionsbuild geprüft. |
| Beschriftungen | Einige Radiofelder und Symbolknöpfe hatten keinen oder einen englischen zugänglichen Namen. | Explizite Optionsnamen und deutsche Beschriftungen für Auswahl, Anhänge, Navigation und Schließen. |
| Metadaten | Lange Pfade konnten aus ihrer Detailkarte ragen. | Gemeinsame Metadatenkomponente begrenzt den Inhalt auf die Kartenbreite. |
| Frontend nach Neubau | Der Server registrierte Asset-Dateinamen nur beim Start. Ein neuer Build führte zu fehlenden JS-Dateien und einer leeren App. | Dateien werden pro Anfrage aufgelöst. Isolierter Fastify-Test prüft neue/entfernte Assets, Deep Links, MIME-Typen und die Trennung zu API/WebSocket-Pfaden. |

## Prüfabdeckung

Im Browser angesehen: Chat mit bestehendem Gespräch, Gesprächsliste und Drawer, Übersicht, Aufgabenliste und Formular, Auftragshistorie, Zeitpläne mit Detail und Formular, Gateway mit Telegram-Einstellungen, Firma mit Agenten/Teams/Projekten und Drawern, Agentendetails samt Tabs, Anlegeformulare, Projektbearbeitung, Erinnerungen/Netz/Nächte, Werkzeuge mit Detail und Anlegeformular, Skills mit Detail/Quelltext/Bearbeitung/Import sowie sämtliche Einstellungsbereiche und der Einstieg/Ausstieg des Sprachmodus.

Interaktionen umfassten Navigation, Menüs, Tabs, Suche und Rücksetzen, Sortierung, Tabellen-Seitenwechsel, Formularvalidierung, Bearbeiten/Abbrechen und die Fehlerseiten für fehlende Aufgaben, Aufträge und unbekannte Routen. Desktopprüfung bei 1280 × 720, gezielte Mobilprüfungen bei 390 × 844 und 320 × 740. Der Produktionsbuild wurde über eine separate Vite-Vorschau gegen die bestehende API geprüft; deren Konsole blieb bei den geprüften Abläufen ohne Warnungen und Fehler.

## Automatische Prüfungen

- `npm run build`: alle vier Workspaces erfolgreich; Web nach der letzten UI-Änderung nochmals gebaut.
- `npm run typecheck`: erfolgreich.
- `npm test`: 112 Core-Tests erfolgreich.
- `npm run test -w @rookery/web`: 18 Web-Regressionschecks erfolgreich.
- `npm run build -w @rookery/server` und `npm run test -w @rookery/server`: Build und ein isolierter Integrationstest erfolgreich.
- `git diff --check`: erfolgreich.

## Grenzen und Inbetriebnahme

Keine echten Agentenaufträge, Telegram-Nachrichten, Löschungen, Skill-Installationen oder Mikrofonaufnahmen wurden ausgelöst. Die vorhandenen Aufgaben-/Auftragslisten waren leer; gefüllte und laufende Detailzustände sind deshalb keine vollständige Browser-End-to-End-Abnahme. Speichernfehler wurden isoliert getestet. Die Prüfung deckt keine vollständige Barrierefreiheitszertifizierung und keinen vollständigen visuellen Durchlauf der hellen Palette ab. Die bestehende Vite-Warnung zur Bundlegröße bleibt offen.

Die Web-Vorschau läuft unter `http://127.0.0.1:5417`, die Entwicklungsoberfläche unter `http://localhost:5317`. Der bereits laufende Server verwendet noch den alten Static-Handler und braucht einmal einen Neustart, um die Serverkorrektur zu übernehmen; weitere Frontend-Neubauten benötigen danach keinen Neustart. Sein Telegram-Betrieb wurde während der Prüfung nicht unterbrochen. Fremde Änderungen unter `.claude/worktrees/` wurden nicht angefasst.

## Zweiter Durchgang: Scrollen und Rückwege

Auf erneute Bitte wurden die vorhandenen Bereiche gezielt bis zum Ende gescrollt und ihre Ausgänge betätigt. Die Prüfung nutzte 1280 × 800 sowie mobile Fenster von 390 × 640; Kopfaktionen wurden zusätzlich bei 320 und 768 Pixel Breite kontrolliert. Eine helle Systemdarstellung wurde nur vorübergehend im Testbrowser emuliert und anschließend zurückgesetzt.

| Neuer Befund | Korrektur und Nachweis |
| --- | --- |
| „Etwas merken“ war bei 390 × 640 nicht scrollbar: Dialoghöhe 885 px, Oberkante −122,5 px; Schließen und Abbrechen lagen außerhalb des Fensters. | Dialoge sind auf die dynamische Fensterhöhe begrenzt und scrollbar. Nach Scrollen lässt sich Abbrechen anklicken. Die Erinnerungsarten passen ohne überlaufende Beschriftungen. |
| Mobile Detailseiten verloren mit den ausgeblendeten Brotkrümeln ihren unmittelbaren Rückweg. | Ein Zurück-Pfeil führt zur nächstgelegenen übergeordneten Route, auch bei direkt geöffneten Seiten. Selbstverweise werden ausgelassen. |
| Die Gateway-Aktionen verdrängten die Suche; lange Werkzeugaktionen verdrängten Speichern. | Suche und Seitentitel bleiben in der ersten Zeile, weitere Aktionen dürfen umbrechen. Die Werkzeugvorbereitung steht mit vollständiger Beschriftung im Menü. Zeitplanaktionen sind getrennte, umbrechende Bedienelemente. Alle geprüften Kopfaktionen liegen bei 320, 768 und 1280 px innerhalb des Fensters. |
| Ein einzelnes Symbolmenü erzeugte eine weitgehend leere zweite Kopfzeile. | Ein alleinstehendes Symbolmenü bleibt neben Titel und Suche. |
| Suchpalette und mobile Navigation hatten keinen sichtbaren Schließen-Knopf. | Beide besitzen einen expliziten Knopf; die Suchpalette passt auch in kurze Fenster. Schließen wurde über die Knöpfe geprüft, einschließlich der abgeschlossenen Ausblendanimation. |
| Einstellungswechsel behielten die alte Scrollposition: von der Sprachseite führte Zurück zur Identität bereits 153 px nach unten versetzt. | Der gemeinsame Seitenscroller startet bei einer anderen Route oben. Filteränderungen auf derselben Route behalten ihre Position. Browser-Nachprüfung ergab 0 px; ein neuer Regressionstest prüft beide Fälle. |
| Der letzte Agententab verschob die ganze mobile Seite seitlich; die Leiste war etwa 410 px breit bei 343 px verfügbarem Platz. | Tab-Leisten brechen innerhalb ihrer verfügbaren Breite um. Alle vier Agententabs wurden geöffnet und bis zum Inhaltsende geprüft; die Leiste misst anschließend 343 px ohne Überbreite. |
| Agentenerinnerungen ohne Detailaktion wurden in einer unbeschränkten Textzeile beziehungsweise gekürzt dargestellt. | Diese Nur-Lese-Ansicht zeigt den vollständigen Text mit begrenzter Zeilenbreite und Zeilenumbruch. |
| Filter wurden neben langen Tab-Leisten in mehrere schmale Zeilen gedrückt. | Unterhalb der breiten Inhaltsansicht bekommen Filter eine eigene Zeile. |

Erneut gescrollt: Übersicht, Gespräche und bestehender Chat, Aufgaben, Auftragshistorie, Zeitpläne und Zeitplandetail, Gateway/Telegram, alle drei Firmenlisten, Agentendetail mit allen vier Tabs, Erinnerungen/Netz/Nächte, Werkzeuge mit Detail, Skills mit vollständiger Anleitung/Import, alle sechs Einstellungsabschnitte sowie sämtliche Anlegeformulare. Zusätzlich wurden Agenten-, Team-, Projekt- und Skillbearbeitung bis zum Ende gelesen und über Abbrechen verlassen.

Gesondert geprüft wurden die scrollenden Drawer für Gespräche, Agenten, Teams, Projekte und Nachtberichte sowie beide Auftragsdialoge. Deren Fußaktionen blieben erreichbar. Die Bestätigung zum Zurücksetzen eines Werkzeugs wurde geöffnet und abgebrochen. Sprachmodus-Einstieg und Rückkehr zur Gesprächsliste wurden ohne Aktivierung des Mikrofons geprüft. Das Netz benötigt für das Scrollen der umgebenden Seite den Rand außerhalb des Canvas: über dem Canvas steuert das Rad ausdrücklich den Zoom; die Legende wurde über den Seitenrand erreicht.

Keine Aufträge, Löschungen oder Änderungen an der Live-Konfiguration wurden für diese Prüfung ausgeführt. Die weiterhin leeren Aufgaben-/Auftragshistorien und der systemverwaltete Schlafzeitplan begrenzen die Prüfung gefüllter Aufgaben-/Auftragsdetails und gewöhnlicher Zeitplanbearbeitung. Das ist keine Abnahme aller möglichen Laufzustände oder realer Smartphone-Tastaturen.

Nach diesem Durchgang: 19 Web-Regressionstests erfolgreich, Web-TypeScript-Prüfung und Produktionsbuild erfolgreich. Die bestehende Bundlegrößenwarnung bleibt unverändert.
