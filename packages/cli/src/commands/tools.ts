import { SkillStore, loadConfig, saveConfig, toolServerStates, withToolServer } from '@rookery/core';
import type { ToolServerAudience } from '@rookery/core';
import { glyph, theme } from '../ui/theme.js';
import { heading } from '../ui/render.js';
import { CliError } from './shared.js';

/**
 * `rookery tools` and `rookery skills`: the same hub and folder the web page
 * shows, from the terminal. Flipping a switch writes the config; a running
 * server picks it up on its next config read, the CLI on its next turn.
 */

export async function toolsCommand(verb: string | undefined, id: string | undefined, audience?: string): Promise<number> {
  const config = loadConfig();
  const states = toolServerStates(config);

  if (!verb || verb === 'list') {
    process.stdout.write('\n' + heading('Werkzeuge') + '\n\n');
    for (const state of states) {
      // Pad before colouring: escape codes would count towards the width.
      const [label, paint] = !state.installed
        ? ['nicht installiert', theme.red]
        : state.missingEnv.length
          ? ['Schlüssel fehlt: ' + state.missingEnv.join(', '), theme.yellow]
          : state.enabled
            ? ['an', theme.green]
            : ['aus', theme.dim];
      const options = Object.entries(state.options)
        .map(([key, value]) => key + '=' + value)
        .join(' ');
      process.stdout.write(
        '  ' + state.id.padEnd(14) + paint(label.padEnd(52)) + theme.dim(state.audience.padEnd(10)) +
          state.name + (options ? theme.dim('  ' + options) : '') + '\n',
      );
    }
    process.stdout.write('\n' + theme.dim('  rookery tools enable <id> [assistant|agents|both]  ·  rookery tools disable <id>') + '\n\n');
    return 0;
  }

  if (verb !== 'enable' && verb !== 'disable') throw new CliError('Usage: rookery tools [list|enable <id>|disable <id>]');
  if (!id) throw new CliError('Which server? One of: ' + states.map((state) => state.id).join(', '));
  const state = states.find((entry) => entry.id === id);
  if (!state) throw new CliError('No tool server "' + id + '". One of: ' + states.map((entry) => entry.id).join(', '));
  if (verb === 'enable' && !state.installed) throw new CliError(state.name + ' is not installed on this machine.');
  if (verb === 'enable' && state.missingEnv.length) {
    throw new CliError(state.name + ' needs ' + state.missingEnv.join(', ') + ' first (Werkzeuge page, or the environment).');
  }
  const who = audience === 'assistant' || audience === 'agents' || audience === 'both' ? (audience as ToolServerAudience) : undefined;
  saveConfig({ tools: withToolServer(config, state.id, { enabled: verb === 'enable', ...(who ? { audience: who } : {}) }) });
  process.stdout.write(
    theme.green(glyph.ok + ' ') + state.name + ' ' + (verb === 'enable' ? 'an' : 'aus') +
      theme.dim(' für ' + (who ?? state.audience) + ', gilt ab dem nächsten Turn') + '\n',
  );
  return 0;
}

export async function skillsCommand(): Promise<number> {
  const config = loadConfig();
  const skills = new SkillStore(config.skillsDir).list();
  process.stdout.write('\n' + heading('Skills') + theme.dim('  ' + config.skillsDir) + '\n\n');
  if (!skills.length) {
    process.stdout.write(theme.dim('  Noch keine. Ein Ordner mit SKILL.md pro Skill, oder die Seite Skills im Web.') + '\n\n');
    return 0;
  }
  for (const skill of skills) {
    process.stdout.write('  ' + skill.name.padEnd(24) + theme.dim(skill.audience.padEnd(10)) + skill.description + '\n');
  }
  process.stdout.write('\n');
  return 0;
}
