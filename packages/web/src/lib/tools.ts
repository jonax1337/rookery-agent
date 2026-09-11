import { CircleCheckIcon, TriangleAlertIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { ToolServer, ToolServerAudience } from './types';

/**
 * Shared vocabulary of the Werkzeuge *and* the Skills pages.
 *
 * Both records carry the same `audience` field, and the labels for it had
 * grown three independent copies (ToolsPage, SkillsPage, SkillFormPage) that
 * were already drifting. There is one table now, and every page reads it.
 */

/** In the order a chooser should offer them. */
export const AUDIENCE_VALUES: ToolServerAudience[] = ['assistant', 'agents', 'both'];

export const AUDIENCE_LABEL: Record<ToolServerAudience, string> = {
  assistant: 'Assistent',
  agents: 'Agenten',
  both: 'Assistent und Agenten',
};

/** The short form, for a badge in a table cell or a radio option. */
export const AUDIENCE_SHORT_LABEL: Record<ToolServerAudience, string> = {
  assistant: 'Assistent',
  agents: 'Agenten',
  both: 'Beide',
};

/** One sentence under a radio option: what the choice actually decides. */
export const AUDIENCE_HINT: Record<ToolServerAudience, string> = {
  assistant: 'Nur im Chat und im Sprachmodus.',
  agents: 'Nur in den Aufträgen der Agenten.',
  both: 'Im Chat und in jedem Auftrag.',
};

/**
 * The three audience radio cards, ready for `ChoiceField`.
 *
 * The tool form and the skill form built this from the same three maps, line
 * for line. Typed structurally rather than as `ChoiceOption<…>` so that
 * `lib/` keeps out of `components/`; the shape is what that type asks for.
 */
export const AUDIENCE_CHOICES: {
  value: ToolServerAudience;
  label: string;
  description: string;
}[] = AUDIENCE_VALUES.map((value) => ({
  value,
  label: AUDIENCE_LABEL[value],
  description: AUDIENCE_HINT[value],
}));

export const INSTALL_LABEL: Record<ToolServer['install'], string> = {
  bundled: 'mitgeliefert',
  'on-demand': 'auf Abruf per npx',
  custom: 'eigener Server',
};

export type ToolStatusTone = 'on' | 'off' | 'blocked';

export interface ToolStatus {
  label: string;
  tone: ToolStatusTone;
}

/**
 * One word about a server's state, and which colour it deserves.
 *
 * The labels are capitalised because they are printed in a badge, not in a
 * sentence - the list used to draw a bare coloured dot with no caption at all,
 * so the state was only readable to someone who already knew the code.
 */
export function toolStatus(tool: ToolServer): ToolStatus {
  if (!tool.installed) return { label: 'Nicht installiert', tone: 'blocked' };
  if (tool.missingEnv.length) return { label: 'Schlüssel fehlt', tone: 'blocked' };
  if (tool.enabled) return { label: 'Bereit', tone: 'on' };
  return { label: 'Aus', tone: 'off' };
}

export interface ToolStatusLook extends ToolStatus {
  variant: 'default' | 'outline' | 'destructive';
  /** `null` for the resting state - "Aus" needs no glyph to be understood. */
  icon: LucideIcon | null;
  iconClassName?: string;
}

const TONE_VARIANT: Record<ToolStatusTone, ToolStatusLook['variant']> = {
  on: 'default',
  off: 'outline',
  blocked: 'destructive',
};

/**
 * How that state looks as a badge. Both the list and the detail page draw the
 * same badge, so the mapping lives next to the state instead of in a component
 * one of them would have to import from the other.
 */
export function toolStatusLook(tool: ToolServer): ToolStatusLook {
  const status = toolStatus(tool);
  if (status.tone === 'on') {
    return {
      ...status,
      variant: TONE_VARIANT.on,
      icon: CircleCheckIcon,
      // The filled check reads as "ready" before the word is read.
      iconClassName: 'fill-status-ok',
    };
  }
  if (status.tone === 'blocked') {
    return { ...status, variant: TONE_VARIANT.blocked, icon: TriangleAlertIcon };
  }
  return { ...status, variant: TONE_VARIANT.off, icon: null };
}
