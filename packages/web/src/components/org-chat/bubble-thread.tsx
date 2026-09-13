import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowUpIcon, SquareIcon, WrenchIcon } from 'lucide-react';

import { relativeTime } from '@/lib/format';
import type { Message } from '@/lib/types';
import { cn } from '@/lib/utils';

import { ResultMarkdown } from '@/components/result-markdown';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';

/**
 * A lean, Teams/WhatsApp-style message list for `OrgChatPage`.
 *
 * This is deliberately not the assistant-ui `Thread` the chat hub uses: that
 * component renders every provider event with the same prominence a coding
 * console needs (expandable tool-call cards, a reasoning panel, branch
 * pickers). A conversation with a colleague is not a console session, so this
 * reads `chat.messages` directly - the same `Message[]` the runtime already
 * builds in `useChat` - and draws it as bubbles: the user's own messages
 * right-aligned, the other party's left-aligned with a name and an avatar
 * initial. Tool calls collapse to a single muted line; there is no
 * "thinking" panel at all.
 */

function initialsOf(name: string): string {
  const letter = name.trim().charAt(0);
  return letter ? letter.toUpperCase() : '?';
}

/** Each provider tool call rides in as a start *and* an end event; count the
 * calls themselves, not the events. */
function countToolCalls(toolCalls: NonNullable<Message['toolCalls']>): number {
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (call.status !== 'start') continue;
    seen.add(call.id ?? call.name);
  }
  return seen.size || toolCalls.length;
}

interface BubbleProps {
  role: 'user' | 'assistant';
  content: string;
  toolCallCount?: number;
  showHeader: boolean;
  name: string;
  timestamp?: number;
  pending?: boolean;
}

function Bubble({ role, content, toolCallCount, showHeader, name, timestamp, pending }: BubbleProps) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex items-end gap-2', isUser && 'flex-row-reverse')}>
      <div className="w-8 shrink-0">
        {!isUser && showHeader && (
          <Avatar size="sm">
            <AvatarFallback>{initialsOf(name)}</AvatarFallback>
          </Avatar>
        )}
      </div>
      <div className={cn('flex max-w-[75%] flex-col gap-1', isUser && 'items-end')}>
        {showHeader && (
          <div className={cn('flex items-baseline gap-2 px-1 text-xs text-muted-foreground', isUser && 'flex-row-reverse')}>
            <span className="font-medium text-foreground">{isUser ? 'You' : name}</span>
            {timestamp !== undefined && <span>{relativeTime(timestamp)}</span>}
          </div>
        )}
        {content && (
          <div
            className={cn(
              'rounded-2xl px-3.5 py-2',
              isUser
                ? 'rounded-br-sm bg-primary text-primary-foreground'
                : 'rounded-bl-sm bg-muted text-foreground',
            )}
          >
            {isUser ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{content}</p>
            ) : (
              <ResultMarkdown text={content} className="text-sm leading-relaxed" />
            )}
          </div>
        )}
        {pending && !content && (
          <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5">
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
          </div>
        )}
        {!!toolCallCount && (
          <div className={cn('flex items-center gap-1 px-1 text-xs text-muted-foreground', isUser && 'flex-row-reverse')}>
            <WrenchIcon className="size-3" />
            <span>{toolCallCount === 1 ? 'Used 1 tool' : 'Used ' + toolCallCount + ' tools'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export interface BubbleThreadProps {
  messages: Message[];
  streaming: string;
  busy: boolean;
  counterpartName: string;
  welcome?: React.ReactNode;
  onSend(text: string): void;
  onAbort(): void;
  className?: string;
}

export function BubbleThread({
  messages,
  streaming,
  busy,
  counterpartName,
  welcome,
  onSend,
  onAbort,
  className,
}: BubbleThreadProps) {
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    // A trailing run from the same sender shares one header (name, avatar,
    // timestamp) - repeating it on every line is the one thing that makes a
    // transcript read like a console log instead of a chat.
    return messages.map((message, index) => ({
      message,
      showHeader: index === 0 || messages[index - 1]?.role !== message.role,
    }));
  }, [messages]);

  const showStreamingHeader = rows.length === 0 || rows[rows.length - 1]?.message.role !== 'assistant';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streaming, busy]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const isEmpty = messages.length === 0 && !busy && !streaming;

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          {isEmpty ? (
            welcome
          ) : (
            <div className="flex flex-col gap-3 px-4 py-4 sm:px-6">
              {rows.map(({ message, showHeader }) => (
                <Bubble
                  key={message.id}
                  role={message.role === 'user' ? 'user' : 'assistant'}
                  content={message.content}
                  toolCallCount={message.toolCalls?.length ? countToolCalls(message.toolCalls) : undefined}
                  showHeader={showHeader}
                  name={counterpartName}
                  timestamp={message.createdAt}
                />
              ))}
              {(busy || streaming) && (
                <Bubble
                  role="assistant"
                  content={streaming}
                  showHeader={showStreamingHeader}
                  name={counterpartName}
                  pending={busy}
                />
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </ScrollArea>
      </div>

      <div className="border-t p-3 sm:p-4">
        <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={'Message ' + counterpartName + '…'}
            className="max-h-40 min-h-10 flex-1 resize-none rounded-2xl"
            rows={1}
          />
          {busy ? (
            <Button type="button" size="icon" className="size-10 shrink-0 rounded-full" onClick={onAbort}>
              <SquareIcon className="size-3.5 fill-current" />
              <span className="sr-only">Stop</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              className="size-10 shrink-0 rounded-full"
              onClick={submit}
              disabled={!draft.trim()}
            >
              <ArrowUpIcon className="size-4" />
              <span className="sr-only">Send</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
