import { BotIcon, UserRoundIcon } from 'lucide-react';

import type { Agent } from '@/lib/types';
import { AssistantAvatar } from '@/components/shell/assistant-avatar';
import { Item, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';

/**
 * The mailbox switcher: "You", the assistant, and one row per agent.
 *
 * Every mailbox but "You" is read-only - the user can look in on anyone's
 * traffic, but the company writes mail to each other, not through the user's
 * own compose form. `InboxPage` is the one place that decides what that means
 * for the panes beside this rail.
 */

interface MailNavProps {
  agents: Agent[];
  assistantName: string;
  mailboxId: string;
  onSelect(mailboxId: string): void;
}

export function MailNav({ agents, assistantName, mailboxId, onSelect }: MailNavProps) {
  return (
    <div className="flex w-64 shrink-0 flex-col border-r">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 p-2">
          <Item asChild size="sm" variant={mailboxId === 'user' ? 'muted' : 'default'}>
            <button type="button" onClick={() => onSelect('user')} className="text-left">
              <ItemMedia variant="icon" className="size-8 rounded-lg bg-muted">
                <UserRoundIcon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>You</ItemTitle>
              </ItemContent>
            </button>
          </Item>

          <Item asChild size="sm" variant={mailboxId === 'assistant' ? 'muted' : 'default'}>
            <button type="button" onClick={() => onSelect('assistant')} className="text-left">
              <ItemMedia variant="icon" className="size-8 rounded-lg bg-muted">
                <AssistantAvatar label={assistantName} className="size-5" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{assistantName}</ItemTitle>
              </ItemContent>
            </button>
          </Item>

          <div className="mt-3 mb-1 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Agents
          </div>

          {agents.map((agent) => (
            <Item asChild key={agent.id} size="sm" variant={mailboxId === agent.id ? 'muted' : 'default'}>
              <button type="button" onClick={() => onSelect(agent.id)} className="text-left">
                <ItemMedia variant="icon" className="size-8 rounded-lg bg-muted">
                  <BotIcon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{agent.name}</ItemTitle>
                </ItemContent>
              </button>
            </Item>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
