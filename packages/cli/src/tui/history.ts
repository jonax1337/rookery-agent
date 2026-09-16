/**
 * Scrollback entries for a conversation's persisted messages.
 *
 * Resuming used to start from an empty screen: `startTui` loaded the
 * session's metadata but none of its turns, so the reader lost the thread
 * they were following. These entries rebuild it the way it happened, from the
 * ordered `blocks` core persists since the transcript work - and from the flat
 * `content`/`toolCalls` view for rows written before that existed.
 */

import { TurnBlocks } from '@rookery/core';
import type { Message } from '@rookery/core';
import { glyph } from './theme.js';
import { blockSegments, thinkingLines } from './types.js';
import type { Entry, SessionState } from './types.js';

/**
 * Turn persisted messages into scrollback entries, oldest first.
 *
 * `session` is the conversation being entered - its counterpart decides whose
 * name an answer carries - and `nextId` comes from the caller so the ids stay
 * unique within whatever list the entries land in.
 */
export function historyEntries(
  messages: Message[],
  session: SessionState,
  nextId: () => string,
): Entry[] {
  const entries: Entry[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      entries.push({ kind: 'user', id: nextId(), text: message.content });
      continue;
    }
    if (message.role !== 'assistant') continue;

    const speaker = message.agent || session.counterpart || session.assistantName;

    if (message.blocks?.length) {
      let lastAssistant = -1;
      // History is settled: a tool block an interrupted turn left open
      // renders as done, not as a pulse that never ends.
      for (const segment of blockSegments(message.blocks, { closed: 'done' })) {
        if (segment.kind === 'tools') {
          entries.push({ kind: 'tools', id: nextId(), calls: segment.calls });
          continue;
        }
        if (segment.kind === 'note') {
          entries.push({
            kind: 'activity',
            id: nextId(),
            icon: segment.note.icon,
            text: segment.note.text,
            ...(segment.note.color ? { color: segment.note.color } : {}),
          });
          continue;
        }
        if (segment.kind === 'thinking') {
          // Reasoning is part of the record, but only verbose wants to reread it.
          if (!session.verbose) continue;
          for (const line of thinkingLines(segment.text)) {
            entries.push({ kind: 'activity', id: nextId(), icon: glyph.thinking, text: line });
          }
          continue;
        }
        const text = segment.text.trim();
        if (!text) continue;
        entries.push({
          kind: 'assistant',
          id: nextId(),
          text,
          speaker,
          ...(message.provider ? { provider: message.provider } : {}),
        });
        lastAssistant = entries.length - 1;
      }
      if (lastAssistant >= 0 && message.usage) {
        const entry = entries[lastAssistant];
        if (entry?.kind === 'assistant') {
          entries[lastAssistant] = { ...entry, usage: message.usage };
        }
      }
      continue;
    }

    // Rows from before blocks existed: the flat view, tools first then text.
    if (message.toolCalls?.length) {
      // The flat view kept every raw event, a call's start beside its end;
      // folding them back through the transcript's own state machine merges
      // them into the calls that ran, settled for good.
      const folder = new TurnBlocks();
      for (const call of message.toolCalls) folder.apply(call);
      const [group] = blockSegments(folder.blocks, { closed: 'done' });
      if (group?.kind === 'tools') {
        entries.push({ kind: 'tools', id: nextId(), calls: group.calls });
      }
    }
    const text = message.content.trim();
    if (text) {
      entries.push({
        kind: 'assistant',
        id: nextId(),
        text,
        speaker,
        ...(message.provider ? { provider: message.provider } : {}),
        ...(message.usage ? { usage: message.usage } : {}),
      });
    }
  }

  return entries;
}
