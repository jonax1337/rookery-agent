# Rookery im Vergleich mit anderen KI-Assistenten

Stand: 14.10.2026 · Erstellt vom Research-Team (Iris) für Jonas

**Legende:**
- **[B]** belegt durch eine Primärquelle (Hersteller-Doku, Repo, Release-Seite) oder mehrere unabhängige Berichte.
- **[S]** stützt sich nur auf eine Sekundärquelle.
- **[?]** unklar oder nicht gefunden.

Rookery-Aussagen stammen aus dem Code und der README in diesem Repository (Stand v0.5.1, Commit `7954a66`). Die Webfakten wurden am 14.10.2026 recherchiert. Preise standen auf keiner offiziellen Preisseite in lesbarer Form zur Verfügung und gelten daher als ungeprüft.

## 1. Was unter den genannten Namen tatsächlich existiert

| Genannt | Gefunden | Anmerkung |
|---|---|---|
| Hermes Agent | **Hermes Agent** von Nous Research, MIT-Lizenz, v0.21.7 vom 11.10.2026 [B] | https://github.com/NousResearch/hermes-agent |
| OpenClaw | **OpenClaw** (früher Clawdbot/Moltbot), MIT-Lizenz, 2026.10.3 vom 13.10.2026 [B] | https://github.com/openclaw/openclaw |
| „Grok Bot“ | **Grok Bot** von xAI: benannte Agenten, jeder mit eigenem Cloud-Rechner, Early Beta seit etwa 11.08.2026 [B]/[S] | https://docs.x.ai/grok-bot/overview. Die Rechner laufen laut Doku „in Cursor's cloud“. |
| OpenAI „Dot“ | Ein Produkt „Dot“ im Singular gibt es nicht. Am nächsten kommt **„dots“**, vorgestellt auf dem DevDay am 29.09.2026 [B] | https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/. Die ältere App „Dot“ von New Computer hat damit nichts zu tun. |
| Z.ai-Assistent | **AutoClaw**, „Z.ai's Official AI Agent“: ein lokaler OpenClaw-Client, seit 10.03.2026 [B] | https://autoclaw.z.ai/. Daneben gibt es **AutoGLM**, einen Agenten, der das Smartphone bedient. |

Als zusätzlich relevant wurden vier Systeme gewählt:

- **Claude Cowork** (Anthropic): Scheduled Tasks, Dispatch, Computer Use und Chrome. Es ist die gehostete Variante desselben Harness, auf dem Rookery läuft.
- **Google Gemini Tasks/Agent**: Big-Tech-Assistent mit Zeit- und Ereignisauslösern sowie tiefem Zugriff auf Gmail und Kalender.
- **Manus** (seit Ende 2025 bei Meta): Cloud-Agent mit Telegram, MCP und Desktop-Bridge.
- **NanoClaw**: der relevanteste selbstgehostete OpenClaw-Konkurrent. Das Sicherheitsmodell isoliert jeden Agenten in einem Container.

Letta wird nur am Rand als Referenz für Gedächtnisarchitektur erwähnt. Perplexity Comet wurde verworfen, weil es nur ein Browser ist. Project Mariner ist laut einer Sekundärquelle eingestellt und in Gemini Agent aufgegangen [S]. Microsoft Copilot und Agent Zero wurden nicht geprüft.

## 2. Vergleichstabelle

Abkürzungen: CU = Computer Use (Bedienung des Desktops), SaaS = gehosteter Clouddienst.

| Kriterium | **Rookery** (v0.5.1) | **Hermes Agent** | **OpenClaw** | **Grok Bot** (xAI) | **OpenAI dots** | **Z.ai AutoClaw** | **Claude Cowork** | **Gemini Tasks** | **Manus** | **NanoClaw** |
|---|---|---|---|---|---|---|---|---|---|---|
| **Zeitgesteuert** | 5-Feld-Cron, Agent- und Skript-Jobs, endliche Wiederholungen, Nachholen nach Neustart. **Keine** Einmal-Termine, Intervalle oder Heartbeats (der Migrationsimport überspringt sie) | Cron in natürlicher Sprache oder als Ausdruck, Zustellung an jeden Kanal [B] | One-Shot und wiederkehrend, Heartbeat, Zustellung an Kanal oder Webhook [B] | Routines, höchstens alle 5 Minuten, maximal 50 pro Bot [B] | Automations nach Zeitplan [B] | Geplante Browser-Aufgaben [B]; Cron und Heartbeat [?] | Stündlich bis wöchentlich, läuft remote auch bei schlafendem PC [B] | Zu festen Zeiten [B] | Scheduled Tasks 2.0 [S] | Wiederkehrende Tasks mit Skript-Gates [B] |
| **Ereignisgesteuert** | Webhook pro Job (eigenes Secret, Cooldown) und IMAP-IDLE-Listener [Code]. Webhooks von außen nur mit Tunnel, weil die Instanz lokal läuft | Gateway-Hooks und Webhooks [B]; eingehender Webhook-Endpunkt [?] | `/hooks/*`-Webhooks, Gmail-Pub/Sub, „Standing Intents“ [B] | Slack und GitHub als Auslöser [B]; Mail und Webhook nicht dokumentiert | Externe Events [B] | [?] | Nicht dokumentiert [?] | „in response to events“ [B] | Slack-Trigger [B] | Über Kanäle [B] |
| **Gedächtnis** | SQLite mit FTS5/BM25, Graph mit Kanten, Zitatpflicht gegen Halluzinationen, nächtlicher Schlaf und Traum (Konsolidierung, Insights, Messung der Abrufqualität), selbst geschriebene und reparierte Skills, eigenes Gedächtnis pro Agent. Rein lexikalisch, keine Embeddings | `MEMORY.md` (2.200 Zeichen) und `USER.md` (1.375 Zeichen), Sitzungssuche per FTS5, 8 externe Memory-Provider, selbst geschriebene Skills, Honcho-Nutzermodell [B] | Markdown mit Tagesnotizen, hybride Vektor- und Keyword-Suche, „Dreaming“ standardmäßig an [B] | Pro Bot persistent, über Bots hinweg nur per Dateien [B] | Lernt Präferenzen, privates Gedächtnis [B] | [?] | Ein Dispatch-Thread, editierbar [B] | Personal Intelligence [B] | Projekt- und Thread-Kontext [S] | `CLAUDE.md` und Store pro Agentengruppe [B] |
| **Mail** | Nur IMAP-Listener als Auslöser. Lesen und Senden laufen über importierte Hermes-Python-Skripte (`imap_act.py`, `mail_act.py`) und den Skill `mail-watcher`, nicht nativ | E-Mail als Kanal [B] | Gmail über Pub/Sub [B] | Über Connectoren und CU [B] | E-Mail und Kalender in der „Space“ [B] | [?] | Connectoren, MCP [B] | Gmail nativ [B] | Gmail- und Outlook-Connector [B] | E-Mail über Resend [B] |
| **Kalender** | Nur über den Skill `icloud-calendar` (CalDAV-Skript), nicht nativ | [?] | Nur Skills und Plugins [?] | Connectoren [B] | [B] | [?] | Connector [B] | Google Calendar nativ [B] | Google Calendar [B] | [?] |
| **Rechnerzugriff** | **Stark auf Windows:** native UI-Automation im Hintergrund, OCR-Klicks, Batches, Not-Aus, Übergabe an den Menschen (`hand_over`), Audit-Log | Nur macOS (`cua-driver`) [B] | Geräte-Nodes, Bildschirm und Kamera [B] | Cloud-Rechner, nicht Ihr PC [B] | Cloud-Rechner, PC optional [B] | Lokal [B] | macOS und Windows, Research Preview [B] | Nein | „My Computer“-App [B] | Container, kein CU [?] |
| **Browser** | Playwright headless oder sichtbar, ein Profil pro Agent | Lokal per CDP, dazu Browserbase [B] | Verwaltetes Profil oder Anbindung an das echte Chrome [B] | Ja (Cloud) [B] | Ja (Cloud) [B] | Ja [B] | Claude in Chrome [S] | Lokales oder Cloud-Chrome [B] | Cloud-Browser und eigener Browser [B] | Nur Fetch und Suche [B] |
| **MCP** | Client-Hub, übernimmt Server aus Claude Code und Codex (Freigabe pro Server), interne Brücke | Client und `hermes mcp serve` [B] | Client und `openclaw mcp serve` [B] | Allowlist nur in Enterprise [B] | Nicht erwähnt [?] | [?] | Voll [B] | [?] | Custom MCP [B] | Über Agent SDK [?] |
| **Kanäle** | Web, Terminal, Sprache, **nur Telegram** als Messenger | Telegram, Discord, Slack, WhatsApp, Signal, E-Mail [B] | 25+ Kanäle [B] | X, Apps [B] | ChatGPT, Slack, Teams [B] | WhatsApp, Telegram, Discord, Lark, Slack [B] | Nur Claude-Apps [B] | Gemini-Apps | Telegram [B] | 12+ inklusive WhatsApp und Telegram [B] |
| **Multi-Agent** | **Stärkster Punkt:** Firma mit Teams, Rollen, Vorgesetzten, Aufgabenboard, Delegation (Tiefe 3, 4 parallel), Rückfragen an den Auftraggeber, eigenes Gedächtnis pro Agent | `delegate_task`, 3 parallel [B] | `sessions_spawn` und Subagent-Steuerung [B] | Bots, Gruppenchats, Übergaben [B] | Spezialisten-dots nur im Enterprise-Pilot [B] | [?] | Agenten über Plugins [?] | [?] | „Wide Research“ [B] | Teammates, Agent Swarms [B] |
| **Datenschutz / Selbsthosting** | Lokal mit SQLite, bindet auf loopback; Modellanfragen gehen an den Anbieter | Selbstgehostet, dazu ein Cloud-Angebot [B]/[S] | Selbstgehostet [B] | Nur SaaS (Cursor-Cloud, USA) [B] | Nur SaaS [B] | Lokal, Kontext geht ans Modell [B] | SaaS [B] | SaaS, **nicht in EWR, UK oder CH verfügbar** [B] | SaaS (Meta) [B] | Selbstgehostet [B] |
| **Sicherheit / Rechte** | Vier Stufen (chat, read, write, full) über Claude-Code-Flags, Telegram-Allowlist, Freigabe pro MCP-Server, Not-Aus für CU. **Keine Sandbox**, keine Freigabe pro Aktion; `full` = `--dangerously-skip-permissions`; das Telegram-Gateway steht standardmäßig auf `full` | Freigaben `smart`, `manual` oder `off`, harte Blockliste, 7 Sandbox-Backends [B]; 2 CVEs (CVSS 7,3) [S] | Läuft standardmäßig direkt auf dem Host, `security audit` [B]; etwa 730 GHSA-Advisories [B], ClawHub-Malware-Welle [S] | Allow/Deny pro Aktion, prüfendes Zweitmodell [B] | Regeln (erlauben, freigeben, verbieten), prüfendes Zweitmodell [B] | Herstellerangaben [S] | Fragt vor Aktionen, Injection-Scan [B] | Bestätigung vor Aktionen [B] | Freigabe „Allow once“ [B] | **Container oder MicroVM pro Agent, Credential-Gateway** [B] |
| **Modelle / Kosten** | Claude über das Abo, ChatGPT über das Abo per **inoffizieller** Codex-Bridge, GLM (z.ai) per Key. Lokale Modelle sind nicht im Katalog. Keine Zusatzkosten neben den Abos | 300+ Modelle über Portal und OpenRouter, lokal über Ollama und vLLM [B] | Jeder Anbieter und lokal [B] | Cursor- oder SuperGrok-Abo [B] | Pro ($100/Monat) [S] | GLM und DeepSeek, Gratis-Credits [B] | Claude ab Pro [B] | AI Pro oder Ultra [B] | Credits, $20–200 [S] | Claude, Codex, Ollama [B] |
| **Reife / Community** | Seit 10.09.2026 öffentlich, 1 GitHub-Stern, ein Entwickler, 779 Tests, v0.5.1 | ~253.000 Sterne, Releases im Wochentakt [B] | ~392.000 Sterne, fast tägliche Releases [B] | Beta, etwa 2 Monate [S] | Beta, 2 Wochen [B] | Etwa 7 Monate [B] | Mehrere Previews [B] | Experimentell [B] | Etabliert, Kurs unter Meta offen [S] | ~31.000 Sterne [B] |
| **Betriebsaufwand** | Einzeiler-Installer für Windows und Linux, Autostart, **Auto-Update mit DB-Backup und Rollback**, Einrichtung komplett in der UI | Einzeiler, `hermes update` [B] | npm, `openclaw doctor` [B] | Keiner | Keiner | Gering | Sehr gering | Keiner | Gering | Mittel (Docker; Anpassung im Code) [B] |

## 3. Gesamteinschätzung

### Wo Rookery besser ist

- **Gedächtnis-Qualität.** Keines der verglichenen Systeme dokumentiert eine vergleichbare Beweispflicht. Bei Rookery muss jede Erinnerung das wörtliche Nutzerzitat tragen. Dazu kommen ein nächtlicher Konsolidierungslauf mit Undo und eine Messung, ob der Abruf überhaupt gut ist. Hermes begrenzt sein Gedächtnis bewusst auf etwa 3.500 Zeichen. OpenClaw hat „Dreaming“, aber ohne Zitatpflicht [B].
- **Multi-Agent-Organisation.** Hermes und OpenClaw kennen Subagenten. Rookery hat dauerhafte Rollen mit Teams, Hierarchie, Aufgabenboard und Rückfragen an den Auftraggeber. Das ist ein Organisationsmodell, kein reiner Fan-out.
- **Windows-Desktop.** Die Rechnerbedienung im Hintergrund über UI-Automation ist für Ihr Windows-Setup deutlich weiter als bei Hermes (Computer Use nur auf macOS) [B].
- **Betrieb.** Updates laufen mit Datenbank-Backup und automatischem Rollback, die Einrichtung ohne Dateibearbeitung. Das ist komfortabler als bei Hermes und OpenClaw.
- **Kosten.** Rookery läuft auf den Abos, die Sie ohnehin haben, ohne API-Keys.

### Wo Rookery gleichauf ist

- Cron-Zeitpläne, Webhook- und IMAP-Auslöser, MCP-Client, Browser-Automation, Selbsthosting, Telegram.

### Wo Rookery schlechter ist

- **Mail und Kalender.** Beides läuft nicht nativ, sondern nur über importierte Hermes-Skripte. Die eigentliche Mail-Arbeit hängt damit weiter am Hermes-Erbe.
- **Sicherheitsmodell.** Es gibt keine Sandbox und keine Freigabe pro Aktion. NanoClaw, Hermes, Grok Bot und dots sind hier strukturell weiter.
- **Kanäle.** Rookery hat nur Telegram, OpenClaw über 25 Kanäle.
- **Modellbreite.** Lokale Modelle fehlen. Der ChatGPT-Weg über die Codex-Bridge ist laut eigener README „not a supported interface“ und kann jederzeit brechen.
- **Reife und Bus-Faktor.** Hinter Rookery stehen ein Entwickler und fünf Wochen öffentliche Historie. Hinter Hermes und OpenClaw stehen Hunderttausende Sterne und tägliche Releases. Das zeigt sich vor allem in der Integrationsbreite.

### Gehostete Assistenten (Grok Bot, dots, Cowork, Gemini, Manus)

Funktional haben die gehosteten Assistenten bei Zeitplänen, Mail, Kalender und Browser aufgeholt. Sie bieten aber kein Selbsthosting, binden an einen Modellanbieter und haben teils Regionssperren (Gemini Tasks nicht im EWR). Für Ihren Anwendungsfall eines lokalen, eigenen Systems sind sie keine Alternative, wohl aber Vorbilder beim Rechtemodell: Freigaben pro Aktion und ein zweites Modell, das riskante Aktionen prüft.

## 4. Die fünf wichtigsten Lücken (priorisiert)

1. **Native Mail- und Kalender-Werkzeuge.**
   - Ziel: IMAP/SMTP lesen, suchen, verschieben und senden sowie CalDAV lesen und schreiben, als eingebaute MCP-Tools mit Zugangsdaten in der UI.
   - Grund für die Priorität: Ohne das ist der Ersatz für Hermes nicht vollständig. Der Mail-Watcher hängt an `imap_act.py` und `mail_act.py` aus dem Hermes-Verzeichnis. Der IMAP-Listener existiert schon und lässt sich wiederverwenden.
2. **Ein Rechtemodell mit Freigabe pro Aktion statt nur Stufen.**
   - Heute heißt `full` „alles ohne Rückfrage“, und das Telegram-Gateway steht standardmäßig auf `full`.
   - Nötig ist eine Stufe dazwischen: riskante Aktionen wie Senden, Löschen oder Shell-Befehle werden per Telegram oder Web freigegeben (Allow once/always, Deny).
   - Optional kommt eine Isolation hinzu (Docker-Backend für Agentenläufe, analog zu Hermes und NanoClaw).
   - Grund: Sobald Mail nativ senden kann, wird das Risiko real.
3. **Vollständige Zeitplanung.**
   - Es fehlen Einmal-Termine („morgen 9 Uhr erinnern“), Intervalle, ein Heartbeat und Zustellziele pro Job.
   - Der Migrationsimport überspringt genau diese Jobtypen aus Hermes und OpenClaw (`migration-cron.ts`). Damit lassen sich bestehende Jobs nicht 1:1 übernehmen.
4. **Weitere Kanäle.**
   - Mindestens E-Mail als Kanal (an den Assistenten schreiben, Antwort per Mail) und WhatsApp oder Signal.
   - Hermes bietet sechs Kanäle, OpenClaw über 25.
   - Die Gateway-Schicht (`packages/server/src/gateways`) ist bisher Telegram-spezifisch.
5. **Breitere und robustere Modellanbindung.**
   - Ziel: ein generisches OpenAI-kompatibles Profil (OpenRouter, Ollama, vLLM) über die bestehende Loopback-Übersetzung.
   - Grund: ein Ausweg für den Fall, dass die inoffizielle Codex-Bridge bricht, und eine lokale Option für sensible Daten.
   - Ob ein Anthropic-kompatibler lokaler Endpunkt heute schon als Profil funktioniert, ist nicht geprüft [?].

Bewusst nicht in der Liste: Embeddings oder Vektorsuche. Das lexikalische Gedächtnis mit Zitatpflicht ist eine Stärke; eine Vektorsuche wäre erst nach der Messung durch den Traum-Lauf begründbar.

## 5. Offene Punkte

- Ob die Hermes-CVEs (CVE-2026-9353, CVE-2026-10220) in v0.21.x behoben sind, ist ungeklärt. Laut den Einträgen hat der Hersteller nicht reagiert [S].
- Was CVE-2026-25253 bei OpenClaw genau umfasst, ist umstritten [S].
- Weder bei Hermes noch im OpenClaw-Kern wurde eine dokumentierte Kalender-Integration gefunden [?].
- Die Preise für dots und Manus sowie das Modell hinter Grok Bot sind nicht offiziell belegt.
- Microsoft Copilot und Agent Zero wurden nicht geprüft.

## Quellen

**Hermes Agent**
- https://github.com/NousResearch/hermes-agent
- https://github.com/NousResearch/hermes-agent/releases
- https://hermes-agent.nousresearch.com/docs/user-guide/features/overview
- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use
- https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- https://hermes-agent.nousresearch.com/docs/user-guide/security
- https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup
- https://db.gcve.eu/vuln/cve-2026-9353
- https://secualive.jp/en/feed/nvd/vulnerability/detailinfo/CVE-2026-10220/
- https://airq.adversa.ai/agent/hermes-agent

**OpenClaw**
- https://github.com/openclaw/openclaw
- https://github.com/openclaw/openclaw/releases
- https://github.com/openclaw/openclaw/security/advisories
- https://docs.openclaw.ai/automation/cron-jobs
- https://docs.openclaw.ai/concepts/memory
- https://docs.openclaw.ai/tools/browser
- https://docs.openclaw.ai/cli/mcp
- https://docs.openclaw.ai/tools/subagents
- https://docs.openclaw.ai/gateway/security
- https://www.openclaw.ai/blog/virustotal-partnership
- https://www.immersivelabs.com/resources/c7-blog/openclaw-what-you-need-to-know-before-it-claws-its-way-into-your-organization
- https://en.wikipedia.org/wiki/OpenClaw

**Grok Bot**
- https://docs.x.ai/grok-bot/overview
- https://docs.x.ai/grok-bot/skills-routines-and-automations
- https://docs.x.ai/grok-bot/security
- https://flaviocopes.com/grok-bot/

**OpenAI dots**
- https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/
- https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams
- https://www.aljazeera.com/economy/2026/9/30/openai-launches-dots-personal-ai-assistant-built-to-handle-everything
- https://www.forbesafrica.com/current-affairs/2026/09/30/openai-unveils-new-ai-assistant-dots-heres-what-it-does

**Z.ai**
- https://autoclaw.z.ai/
- https://aihola.com/article/zhipu-autoclaw-local-openclaw
- https://www.yicaiglobal.com/news/zhipu-ai-bytedance-tencent-10-other-chinese-internet-giants-launch-openclaw-versions
- https://www.yicaiglobal.com/news/chinas-zhipu-unveils-worlds-first-mobile-agent-turning-phones-into-ai-assistants

**Claude Cowork**
- https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork
- https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork
- https://claude.com/blog/dispatch-and-computer-use
- https://claude.com/docs/connectors

**Gemini**
- https://support.google.com/gemini/answer/16596215

**Manus**
- https://manus.im/features/connectors
- https://manus.im/docs/integrations/mcp-connectors
- https://manus.im/blog/manus-agents-telegram
- https://manus.im/docs/features/desktop
- https://www.eweek.com/news/meta-acquires-manus-2b/

**NanoClaw**
- https://github.com/qwibitai/nanoclaw
- https://www.docker.com/press-release/nanoclaw-partners-with-docker-to-run-ai-agents-safely/
- https://www.datacamp.com/blog/nanoclaw-vs-openclaw

**Rookery**
- `README.md`
- `docs/migration.md`
- `docs/concepts/event-triggers-and-listeners.md`
- `packages/core/src/types.ts` (CronJob ab etwa Zeile 1641)
- `packages/core/src/tools/catalog.ts`
- `packages/core/src/providers/provider-catalog.ts`
- `packages/core/src/cron/script.ts:47` („This is not a sandbox“)
- `packages/server/src/gateways/`
- `~/.rookery/skills/` (`mail-watcher`, `icloud-calendar`)
