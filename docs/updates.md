# Updates and releases

Rookery is distributed as the npm package [`rookery-agent`](https://www.npmjs.com/package/rookery-agent). An installation updates itself from that package; a release is published by pushing a version tag.

## For people running Rookery

### Settings → Updates

The page shows the installed version, the newest one on the chosen channel, and a link to its release notes. **Check now** asks the registry immediately; **Install** updates and restarts.

| Setting | Values | Meaning |
|---|---|---|
| Updates | *Off* | Never looks for new versions. |
| | *Tell me* (default) | Looks every six hours (first check one minute after start) and shows what it found. You decide when to install. |
| | *Install automatically* | Also installs, but only while nothing is running: no conversation answering, no agent run or task, no schedule, no open terminal. While something runs, it looks again every five minutes. A version whose update already failed is never retried automatically. |
| Channel | *Stable releases* | Follows the npm dist-tag `latest`. |
| | *Pre-releases* | Follows `next`: versions such as `0.3.0-beta.1`, published before the stable release. |

Both are stored in `~/.rookery/config.json` as `updates.mode` (`off`, `notify`, `auto`) and `updates.channel` (`latest`, `next`).

Installing while work is running asks first and stops that work: the server restarts. The page waits for the new version and reloads by itself.

### Terminal

```bash
rookery update --check   # installed and newest version, nothing else
rookery update           # install the newest version on your channel
rookery update --force   # install even while work is running
```

With a server running, the command asks that server to update, exactly like the button. Without one, the update runs in the terminal and leaves the server stopped; start it again with `rookery start`.

### What an update does

The server cannot replace its own files while it runs (on Windows, loaded native modules are locked). It therefore hands the work to a separate updater process and exits:

1. The server writes `~/.rookery/run/update-plan.json`, copies `scripts/updater.mjs` to `~/.rookery/run/updater.mjs`, starts it detached, and shuts down cleanly.
2. The updater waits for the old server process to exit (at most 90 seconds, then it ends it).
3. It copies the database (`rookery.db` with its `-wal`/`-shm` files) to `~/.rookery/backups/update-<old version>-<time>/`.
4. It runs `npm install --global --ignore-scripts rookery-agent@<version>` into the same prefix the current installation lives in. A failed attempt is retried twice.
5. It starts the new server (`rookery start`, or `systemctl --user start rookery.service` when Rookery runs as a systemd user service) and waits up to a minute for `/api/health` to answer with the new version.
6. If installing or starting fails, it rolls back: stops what came up, restores the database backup, reinstalls the previous version, and starts that.

The outcome is written to `~/.rookery/run/update-status.json`; Settings → Updates shows a failed update and its reason. Every step is logged to `~/.rookery/logs/update.log`. Backups are not deleted automatically.

Database migrations only run forward, which is why the backup is taken before every update and restored on rollback. A newer database is refused by an older Rookery.

### When Rookery cannot update itself

- **Source checkout** (you cloned the repository): update with `git pull`, `npm install`, and `npm run build`. The page says so instead of offering Install.
- **Not a global npm installation** (a local tarball unpacked somewhere, an `npx` cache): reinstall with `npm install -g --ignore-scripts rookery-agent`.
- **Rookery 0.1.0** predates the updater. Update once by hand, then restart:
  ```bash
  npm install -g --ignore-scripts rookery-agent@latest
  ```
  On Linux installations made by the installer, add `--prefix "$HOME/.local"`.

### Troubleshooting

- **The page says Rookery did not come back.** Look at `~/.rookery/logs/update.log` and `~/.rookery/server.log`, then run `rookery start`.
- **npm reported a busy or locked file (Windows).** Another process still held a file of the old installation, often a terminal left over from an agent run. Close it and run `rookery update` again.
- **Restoring data by hand.** Stop Rookery, copy the files from the newest `~/.rookery/backups/update-*` folder back to `~/.rookery/`, and delete `rookery.db-wal`/`rookery.db-shm` files that the backup does not contain. Then install the matching version: `npm install -g --ignore-scripts rookery-agent@<old version>`.

## Installers

`scripts/install.ps1` (Windows) and `scripts/install.sh` (Linux) install the released package from npm; nothing is built on the user's machine.

| | Windows | Linux |
|---|---|---|
| Pin a version or dist-tag | `$env:ROOKERY_VERSION = '0.2.0'` | `ROOKERY_VERSION=0.2.0` |
| Build `main` instead of a release | `-FromSource` | `ROOKERY_FROM_SOURCE=1` |
| Install location | npm's global prefix | `~/.local` |

The installers are fetched from the `main` branch, so a change to them is live for new installations the moment it is pushed.

## For maintainers: releasing

### One-time setup

On npmjs.com, open the `rookery-agent` package → **Settings** → **Trusted Publisher** and add GitHub Actions with repository `jonax1337/rookery-agent` and workflow `release.yml`. The workflow then publishes with a short-lived OIDC token and signed provenance; no npm token is stored anywhere.

### Publishing a release

```bash
npm version 0.2.0 --workspaces --include-workspace-root --no-git-tag-version
git commit -am "release: 0.2.0"
git tag -a v0.2.0 -m v0.2.0
git push --follow-tags
```

`.github/workflows/release.yml` runs on every `v*` tag. It checks that the tag matches `package.json`, runs `npm ci`, `npm run build`, and `npm test`, packs the standalone package with `scripts/package.mjs`, publishes it, and creates the GitHub release with generated notes. A tag with a suffix (`v0.3.0-beta.1`) is published to the `next` dist-tag and marked as a pre-release; everything else goes to `latest`.

One version covers the whole release: `scripts/package.mjs` stamps the root version into every bundled workspace package, and the server reports the root `package.json` version, which the updater compares after a restart.

### Testing an update locally

Do not test against a real installation. The update code reads `ROOKERY_NPM_REGISTRY`, so a throwaway registry and a separate home work end to end:

1. Build (`npm run build`), then pack two or more versions: set the root `version`, run `node scripts/package.mjs`, and `npm pack ./dist/npm`. To test a rollback, replace `dist/npm/packages/server/dist/main.js` with a file that throws before packing.
2. Serve them from a small local registry that answers `/rookery-agent` (packument), `/rookery-agent/latest`, and the tarball URLs, and proxies every other package to `registry.npmjs.org`.
3. Install the older version into a temporary prefix with `npm install -g --prefix <temp> --registry <local> rookery-agent@<old>`, give it its own `ROOKERY_HOME` whose `config.json` sets another `port`, and start it with `ROOKERY_NPM_REGISTRY=<local>`.
4. `POST /api/updates/check`, then `POST /api/updates/install` with a JSON body `{}`, and watch `logs/update.log` in the temporary home.

The unit tests are in `packages/server/test/updates.test.js`; the installer smoke test is `scripts/install-linux.test.sh`.

## HTTP API

| Route | |
|---|---|
| `GET /api/updates` | Current status: installed and newest version, whether this installation can update itself (and why not), what is running, the last update's outcome. |
| `POST /api/updates/check` | Ask the registry now; returns the status. |
| `POST /api/updates/install` | Body `{ "force": boolean }`. Answers `202 { from, to }` and shuts down shortly after; `409` when nothing is newer or work is running without `force`, `400` when this installation cannot update itself. |
