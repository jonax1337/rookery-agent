/**
 * Scrollback entries for a conversation's persisted messages.
 *
 * Resuming used to start from an empty screen: `startTui` loaded the
 * session's metadata but none of its turns, so the reader lost the thread
 * they were following. These entries rebuild it the way it happened, from the
 * ordered `blocks` core persists since the transcript work - and from the
 * flat `content`/`toolCalls` view for rows written before that existed.
 */

import { TurnBlocks } from '@rookery/core';
import type { Message, MessageBlock, ProviderId } from '@rookery/core';
import { glyph } from './theme.js';
import { blockSegments, speakerName, thinkingLines } from './types.js';
import type { BlockSegment, Entry, SessionState } from './types.js';

type AssistantEntry = Extract<Entry, { kind: 'assistant' }>;

/** How a block segment is turned into scrollback entries. */
export interface SegmentEntryContext {
  /** Reasoning is part of the record, but only verbose wants to reread it. */
  verbose: boolean;
  /** Whose name the answer carries. */
  speaker: string;
  provider: ProviderId | undefined;
  /** Mint the id of one entry produced from `segment`. */
  nextId: (segment: BlockSegment) => string;
}

/**
 * The scrollback entries a transcript's segments leave, in order.
 *
 * Shared by the live turn and the history so what was streamed and what is
 * reloaded read the same.
 */
export function segmentEntries(segments: BlockSegment[], context: SegmentEntryContext): Entry[] {
  return segments.flatMap((segment) => entriesOf(segment, context));
}

/**
 * Stamp `patch` onto the newest assistant entry, in place.
 * Returns false when there is no assistant entry to carry it.
 */
export function amendLastAssistant(entries: Entry[], patch: Partial<AssistantEntry>): boolean {
  const index = entries.findLastIndex((entry) => entry.kind === 'assistant');
  const entry = entries[index];
  if (entry?.kind !== 'assistant') return false;
  entries[index] = { ...entry, ...patch };
  return true;
}

function entriesOf(segment: BlockSegment, context: SegmentEntryContext): Entry[] {
  switch (segment.kind) {
    case 'tools':
      return [{ kind: 'tools', id: context.nextId(segment), calls: segment.calls }];

    case 'note':
      return [
        {
          kind: 'activity',
          id: context.nextId(segment),
          icon: segment.note.icon,
          text: segment.note.text,
          ...(segment.note.color ? { color: segment.note.color } : {}),
        },
      ];

    case 'thinking':
      if (!context.verbose) return [];
      return thinkingLines(segment.text).map((line) => ({
        kind: 'activity' as const,
        id: context.nextId(segment),
        icon: glyph.thinking,
        text: line,
      }));

    case 'text': {
      const text = segment.text.trim();
      if (!text) return [];
      return [
        {
          kind: 'assistant',
          id: context.nextId(segment),
          text,
          speaker: context.speaker,
          ...(context.provider ? { provider: context.provider } : {}),
        },
      ];
    }
  }
}

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

    const context: SegmentEntryContext = {
      verbose: session.verbose,
      speaker: message.agent || speakerName(session),
      provider: message.provider,
      nextId,
    };
    entries.push(
      ...(message.blocks?.length
        ? blockEntries(message, message.blocks, context)
        : flatEntries(message, context)),
    );
  }

  return entries;
}

function blockEntries(
  message: Message,
  blocks: MessageBlock[],
  context: SegmentEntryContext,
): Entry[] {
  // History is settled: a tool block an interrupted turn left open renders as
  // done, not as a pulse that never ends.
  const entries = segmentEntries(blockSegments(blocks, { closed: 'done' }), context);
  if (message.usage) amendLastAssistant(entries, { usage: message.usage });
  return entries;
}

/** Rows from before blocks existed: the flat view, tools first then text. */
function flatEntries(message: Message, context: SegmentEntryContext): Entry[] {
  const entries: Entry[] = [];

  if (message.toolCalls?.length) {
    // The flat view kept every raw event, a call's start beside its end;
    // folding them back through the transcript's own state machine merges
    // them into the calls that ran, settled for good.
    const folder = new TurnBlocks();
    for (const call of message.toolCalls) folder.apply(call);
    const [group] = blockSegments(folder.blocks, { closed: 'done' });
    if (group?.kind === 'tools') {
      entries.push({ kind: 'tools', id: context.nextId(group), calls: group.calls });
    }
  }

  const answer = segmentEntries([{ kind: 'text', text: message.content, streaming: false }], context);
  if (message.usage) amendLastAssistant(answer, { usage: message.usage });
  entries.push(...answer);

  return entries;
}
