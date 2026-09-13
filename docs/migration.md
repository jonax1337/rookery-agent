# Migrate your agent to Rookery

Bring the personality and saved knowledge of a Hermes or OpenClaw agent into Rookery. Rookery provides this importer; it is not an endorsement or compatibility guarantee from either source project. Your agent keeps its imported Markdown identity while Rookery supplies the runtime, provider integration, tools, and permissions. A different model or harness can still change how it responds.

## During installation

The Windows and Linux installers run `rookery setup`, which opens **Settings → Migration**. Choose **Hermes** or **OpenClaw**, inspect the detected source directory, then select individual files and schedules with their checkboxes. Files and schedules each have their own select-all/clear controls. Only selected entries are imported and backed up; selecting only schedules leaves your existing personality files unchanged. A custom path refers to a directory on the machine running the Rookery server. For a browser on another machine, first copy your source profile to the server.

Choose **Start fresh** to continue with Rookery's neutral profile, then personalize it under **Settings → Identity**. Existing Rookery users can open Migration later. Setup does not import anything automatically.

## Terminal

The installed standalone launcher supports:

```bash
rookery migrate hermes
rookery migrate openclaw --from /path/to/openclaw/workspace
rookery migrate hermes --from /path/to/hermes/profile --apply
rookery migrate hermes --job <source-job-id> --apply
rookery migrate openclaw --file SOUL.md --file USER.md --apply
```

The default is a preview of files and compatible schedules. Repeat `--file` and `--job` to import only named target paths and source job IDs; when either flag is present, unlisted files and jobs are excluded. Without selection flags, all compatible entries are selected. `--apply` prints the current preview, verifies that its source and destination fingerprint still matches, then imports. Review the preview before adding `--apply`: that flag also authorizes replacing conflicting destination files with backups. The command does not start the server or enable autostart. From a built source checkout, use `node scripts/rookery.mjs migrate ...`.

## Source directories

- **Hermes:** normally `~/.hermes`; custom instances use `HERMES_HOME`, and named profiles live under `~/.hermes/profiles/<name>`. `hermes profile show <name>` reports a profile's home. Pass the desired profile directory with `--from`. Hermes stores `SOUL.md` at that root and `USER.md` and `MEMORY.md` under `memories/`. See the official [file map](https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what) and [profile documentation](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/).
- **OpenClaw:** normally `~/.openclaw/workspace`. Profiles, environment overrides, and per-agent workspace configuration can change it. Select the actual agent workspace with `--from` when using a custom or multi-agent installation. Files from different agents should not be merged by guessing their directories. See the official [workspace documentation](https://docs.openclaw.ai/concepts/agent-workspace).

For another machine, copy the source directory first. Hermes also offers `hermes profile export <name> -o profile.tar.gz`; extract that archive yourself and select the extracted profile directory. Rookery's importer accepts directories, not archive uploads. An export can contain personal history even though Hermes excludes `.env` and `auth.json` by filename. See the official [export command](https://hermes-agent.nousresearch.com/docs/reference/profile-commands).

## What transfers

| Data | Hermes source | OpenClaw source | Rookery destination |
|---|---|---|---|
| Name and identity | `IDENTITY.md`, if present | `IDENTITY.md` | `IDENTITY.md` |
| Personality and tone | `SOUL.md` | `SOUL.md` | `SOUL.md` |
| User profile | `memories/USER.md` | `USER.md` | `USER.md` |
| Curated knowledge | `memories/MEMORY.md` | `MEMORY.md` | `MEMORY.md` |
| Workspace guidance | `AGENTS.md`, if present at the selected root | `AGENTS.md` | `AGENTS.md` |
| Tool conventions | `TOOLS.md`, if present | `TOOLS.md`, if present | `TOOLS.md` |
| Detailed notes | No additional note folders imported | `memory/**/*.md` | `memory/` |

Hermes uses `SOUL.md` as its primary identity, so an absent `IDENTITY.md` is normal. Its memory files may use `§` separators; those remain intact. OpenClaw's newer templates keep tool conventions in the `## Tools` section of `AGENTS.md`; legacy `TOOLS.md` is also supported. These files carry instructions and notes, not tool implementations. [Hermes identity](https://hermes-agent.nousresearch.com/docs/user-guide/features/personality), [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [OpenClaw memory](https://docs.openclaw.ai/concepts/memory).

The preview is the exact list for your installation. `HEARTBEAT.md`, `BOOT.md`, and `BOOTSTRAP.md` are retained as inactive `.md.txt` files under `migration-archive/<source>/` when present. Those archived instructions do not create schedules, run startup actions, or restart an old onboarding ritual.

## Scheduled jobs

Compatible recurring cron jobs appear in the same migration preview and import into **Schedules**, paused with `chat` permission. The importer keeps their names, prompt text, and supported five-field cron expressions. It does not run jobs during migration or replay missed occurrences. Review each schedule's timing, tools, permissions, and output delivery before enabling it. Repeating an import does not replace your local edits to a previously imported schedule.

Hermes jobs are read from `<profile>/cron/jobs.json`. Hermes can also attach skills, scripts, finite repeat counts, custom models, and delivery targets; those source features need separate treatment. See [Hermes cron internals](https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals).

Current OpenClaw stores schedules in its shared `<state-dir>/state/openclaw.sqlite` database. For a selected workspace named `workspace`, Rookery checks the adjacent state directory and its default cron partition. Legacy `<state-dir>/cron/jobs.json` is used when the database is absent. A moved database may retain the old absolute partition path, and custom or multi-agent layouts need an explicit export. See [OpenClaw automations](https://docs.openclaw.ai/cli/cron).

For those layouts, run `openclaw automations list --json` (optionally filter with `--agent <id>`) and save the output as UTF-8 `jobs.json` in the workspace directory you select for migration. Rookery accepts a job list or an object containing `jobs`; this file takes precedence over automatic cron discovery. A `cron/jobs.json` directly under the selected directory is also supported. Review the exported jobs to ensure they belong to the agent you are migrating. The official [CLI reference](https://docs.openclaw.ai/cli/cron) describes JSON output.

The converter accepts recurring five-field cron schedules with assistant text prompts, plus Hermes script jobs. Finite repeats preserve the remaining attempt count (`times - completed`); it is reserved before each run, including failed attempts, so restarts cannot exceed the limit. It skips one-shot timestamps, fixed intervals, six-field schedules, unsupported command/heartbeat/system-event payloads, unmapped custom agents, monitor gates, chained contexts, custom script working directories, explicit timezones that differ from the Rookery host, staggering, conditional triggers, and pacing. OpenClaw top-of-hour jobs need an explicit exact-timing setting (`staggerMs: 0`) because its implicit staggering is not reproduced. Source delivery destinations and model/tool settings are not enabled automatically. Warnings identify unsupported or unmapped features; their definitions remain in the source installation. OpenClaw supports these broader schedule types natively, as documented in its [schedule guide](https://docs.openclaw.ai/automation/cron-jobs/schedules).

## Script schedules

Selecting a Hermes script schedule also selects its script bundle. Python, Node.js, Bash and PowerShell scripts are supported. The preview lists locally resolved helper modules and referenced JSON state/rule files. They are copied into `<ROOKERY_HOME>/imported-scripts/`; credential-like JSON sidecars are excluded. Script files themselves can contain embedded credentials, so review the code before importing. Separate authentication stores, installed interpreters, third-party packages and dynamically located dependencies are not installed or copied automatically.

Imported scripts remain paused with chat-only permission. Open their detail page in **Schedules**, review the source and its dependencies, explicitly grant **Full access**, then enable or run the job. Script execution is a local process with filesystem/network access, not a sandbox. Rookery uses an interpreter argument array, a two-minute script timeout, bounded output and process-tree cancellation. It does not forward provider/gateway secrets from its environment.

Hermes `no_agent` jobs return script output directly. Other script jobs feed stdout into the assistant with the saved job prompt. Empty script-only output, `wakeAgent: false` control output and the assistant's `[SILENT]` response suppress notifications. Absolute paths inside scripts are preserved and flagged: a script that refers to an old Hermes installation or external authentication files needs those references reviewed before the old installation is removed. Source delivery destinations do not become Rookery gateway settings.

## Rookery's portable profile

The assistant workspace defaults to `~/.rookery/workspace`. The standard files are `IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`, and `MEMORY.md`. New generated templates can use `{{assistantName}}`, `{{userName}}`, `{{honorific}}`, and `{{formalAddress}}` to follow Settings. Imported identity text remains authoritative about the agent's persona.

Rookery loads the profile for assistant turns and exposes Markdown notes through its own MCP profile tools. Existing SQLite memories remain available alongside those files. Project agents keep their separate identities and memory scope. This migration does not add group-chat access: Telegram continues to accept only permitted controllers in private chats. Keep personal knowledge in a private Rookery home.

Automatic context includes up to 12,000 characters per standard file, with explicit excerpt notices. Note searches scan up to 16 MiB and label partial results; `read_profile` can read a known file in pages. Retrieval errors are reported without replacing the saved personality or breaking the conversation. Projectless staff use `<ROOKERY_HOME>/agent-workspaces/<agent-id>` so their provider does not automatically load the assistant's private profile.

Review the files under **Settings → Identity** after importing. Start a new conversation for the cleanest transition; an old provider conversation can still contain its earlier identity context.

## Backups and recovery

The importer leaves the source directory unchanged, reports conflicts before applying, and preserves backups when replacing destination files under `<ROOKERY_HOME>/migration-backups/`. Keep the backup/report path printed by the CLI or shown by the UI. Its `manifest.json` identifies selected files, their `targetRoot` and relative `targetPath`, and which originals were backed up. Profile files belong to the assistant workspace; script bundles belong to the Rookery home. If files change between preview and apply, obtain a new preview.

To undo an import manually, stop Rookery and use the migration report to identify changed files. Restore replaced files from the backup and remove only files the report identifies as newly created by that import. Preserve later edits separately before restoring. Restart Rookery, review Identity, and remove the imported schedules you no longer want under **Schedules**. There is no automatic rollback command; a migration backup is not a snapshot of the complete Rookery database or provider sessions.

## What needs separate setup

Chat sessions and native provider thread IDs, conversation databases and search indexes, credentials, API keys, channel pairing, approvals, hooks, plugins, executable skills, external memory services, and model/provider settings are not automatically converted. Configure Rookery's provider login, Gateways, Tools, and Skills separately. Markdown cannot grant permissions or reproduce an unavailable source tool.

Hermes stores searchable conversation history in `state.db`; current OpenClaw stores per-agent runtime data in `agents/<id>/agent/openclaw-agent.sqlite`, with older session directories retained as legacy artifacts. Importing Markdown does not import either conversation store. External memory providers may also hold knowledge that is absent from local Markdown. [Hermes memory and sessions](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [OpenClaw state locations](https://docs.openclaw.ai/concepts/agent-workspace).
