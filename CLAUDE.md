# Rookery Agent — Claude Code instructions

Siehe [`AGENTS.md`](AGENTS.md) fuer Projektueberblick, Verzeichnisstruktur,
Build-/Dev-/Test-Befehle und Konventionen — die gelten hier genauso. Dieses File
ergaenzt ausschliesslich, was fuer Claude Code als Werkzeug spezifisch ist.

## Code-Intelligence (ProjectAtlas)

- **Atlas-first ist der Standard:** Jede nicht-triviale Repo-Aufgabe beginnt bei verfuegbaren ProjectAtlas-MCP-Tools mit genau einem `atlas_session_brief(query: "<Aufgabe>", compact: true)`. Danach den zurueckgegebenen typisierten Call und seine Selektoren uebernehmen.
- Vor dem Session-Brief keine breiten Repo-Scans, Verzeichnis-Walks oder vollstaendigen Dateireads. Ausnahmen: Der Nutzer nennt bereits einen exakten Pfad, die Aufgabe ist eine rein mechanische Aenderung an bekannten Dateien oder Atlas ist nicht verfuegbar. Liefert der Brief keinen brauchbaren Kandidaten: `atlas_overview` -> `atlas_folders` -> `atlas_files`, erst danach `rg`/Dateisystem-Fallbacks.
- MCP vor CLI: Normale Atlas-Arbeit ueber `atlas_*`; CLI nur fuer Installation, Diagnose oder wenn das passende MCP-Tool fehlt.
- ProjectAtlas nur initialisieren, wenn `.projectatlas/projectatlas.db` fehlt. Nach relevanten Dateiaenderungen bei Bedarf mit `atlas_watch_once` aktualisieren; kein Scan bei jedem Session-Start.
- ProjectAtlas beantwortet "Wo ist was und wer haengt daran?". `AGENTS.md`, `README.md` und `docs/` bleiben die versionierte Wahrheit fuer Regeln und Architektur; die lokale Atlas-Datenbank ist nie alleinige Entscheidungsquelle.
- Purpose-Kuratierung (`atlas_purpose_queue` / `atlas_purpose_review`) laeuft in der Hauptsitzung. Kommt bei `atlas_purpose_review` alles als "stale" zurueck, aendert sich eine indizierte Datei laufend (typisch: Playwright-Logs); den Ordner per `atlas_ignore_add` ausschliessen. Notfalls Items nur mit `{path, purpose}` ohne Tokens senden.
- Agenten-Gedaechtnis liegt ausschliesslich im Claude-Code-Auto-Memory; claude-mem ist deaktiviert.

## Design-Konzepte

Konzeptdokumente fuer Ausbaustufen (z. B. Agent-Leistungsbewertung, Gedaechtnis als
Graph) liegen unter `docs/concepts/`, nicht unter `docs/design/`. Vor einer Aenderung
an Organisation oder Gedaechtnis dort nachsehen, ob es ein einschlaegiges Konzept mit
offenen Punkten gibt — Konzept, kein Code; weicht der Code ab, gilt der Code.
