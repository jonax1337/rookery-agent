import type { ToolServer, ToolServerAudience } from './types';

/** Shared vocabulary of the Werkzeuge pages. */

export const AUDIENCE_LABEL: Record<ToolServerAudience, string> = {
  assistant: 'Assistent',
  agents: 'Agenten',
  both: 'Assistent und Agenten',
};

export const INSTALL_LABEL: Record<ToolServer['install'], string> = {
  bundled: 'mitgeliefert',
  'on-demand': 'auf Abruf per npx',
  custom: 'eigener Server',
};

/** One word about a server's state, and which colour it deserves. */
export function toolStatus(tool: ToolServer): { label: string; tone: 'on' | 'off' | 'blocked' } {
  if (!tool.installed) return { label: 'nicht installiert', tone: 'blocked' };
  if (tool.missingEnv.length) return { label: 'Schlüssel fehlt', tone: 'blocked' };
  if (tool.enabled) return { label: 'aktiv', tone: 'on' };
  return { label: 'aus', tone: 'off' };
}
