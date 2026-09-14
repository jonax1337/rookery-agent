import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Keep the developer's own machine out of the tests.
 *
 * Rookery reads the Claude Code installed beside it, so without this every
 * run of the tool-hub tests would see whatever plugins and MCP servers happen
 * to be installed here - a suite that passes on one laptop and fails on the
 * next. `CODEX_HOME` goes with it: the ChatGPT provider reads the model list
 * the backend cached there, which is just as much this machine's state. Both
 * take an environment override; pointing them at an empty directory makes
 * "nothing installed" the baseline, and a test that wants an installation
 * points them at its own fixture instead.
 */
const empty = mkdtempSync(join(tmpdir(), 'rookery-no-cli-'));
process.env.CLAUDE_CONFIG_DIR ??= join(empty, 'claude');
process.env.CODEX_HOME ??= join(empty, 'codex');
