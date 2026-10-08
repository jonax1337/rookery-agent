import type { ToolServer, ToolServerAudience } from '@/lib/types';

/** What the detail page's form edits, written together by one "Save". */
export interface ToolDraft {
  audience: ToolServerAudience;
  /** One entry per `optionDef`, pre-filled from the entry's default. */
  options: Record<string, string>;
  /**
   * Only what has been typed. Values never travel to the browser, so an empty
   * field means "leave it alone" - and it has to, because the server deletes a
   * key whose value arrives empty (`withToolServer` in core).
   */
  env: Record<string, string>;
  /** Empty means every project. */
  projectIds: string[];
}

export const EMPTY_TOOL_DRAFT: ToolDraft = {
  audience: 'assistant',
  options: {},
  env: {},
  projectIds: [],
};

export function toolDraftOf(tool: ToolServer): ToolDraft {
  return {
    audience: tool.audience,
    options: Object.fromEntries(
      tool.optionDefs.map((option) => [option.key, tool.options[option.key] ?? option.default]),
    ),
    env: {},
    projectIds: tool.projectIds,
  };
}

/** The keys that were actually typed; blank ones stay untouched on the server. */
export function typedEnv(draft: ToolDraft): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(draft.env)) {
    if (value.trim()) env[name] = value.trim();
  }
  return env;
}
