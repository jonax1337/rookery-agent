import { useMemo } from 'react';
import { BotIcon, TriangleAlertIcon } from 'lucide-react';

import { greeting } from '@/lib/format';
import { useChatSession, useConfig, useOrgState, useSessionsState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';

import { BubbleThread } from '@/components/org-chat/bubble-thread';
import { EmptyState, EmptyStateGreeting } from '@/components/assistant-ui/elements/empty-state';
import { AssistantAvatar } from '@/components/shell/assistant-avatar';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { ScrollArea } from '@/components/ui/scroll-area';

import { cn } from '@/lib/utils';

/**
 * The company's Teams-style directory: everyone there is to talk to, on the
 * left, and the real conversation on the right.
 *
 * The right pane used to be the chat hub's own assistant-ui `Thread`, mounted
 * a second time - same tool-call cards, same reasoning panel, same console
 * chrome the hub needs for coding turns. A colleague chat is not a console
 * session, so this reads `chat.messages` directly (the plain `Message[]`
 * `useChat` already builds - the same state `Thread` reads through the
 * assistant-ui runtime) and draws it with `BubbleThread`: right-aligned
 * bubbles for the user, left-aligned ones with a name and avatar initial for
 * the other party, tool calls collapsed to a single muted line. Sending still
 * goes through `chat.send`/`chat.abort` - only the rendering changed.
 *
 * Picking a row calls the same `selectCounterpart`/`chat.reset()` pair
 * `chooseCounterpart` uses, without its `navigate()` - staying on `/org/chat`
 * is the whole point of a directory. `ChatPage`, `OrgAgentsPage`'s row menu
 * and `AgentDetailPage`'s Chat button are untouched; they still hand off to
 * the hub the way they always did.
 */

function PresenceDot({ busy }: { busy: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn('size-1.5 shrink-0 rounded-full', busy ? 'bg-amber-500' : 'bg-emerald-500')}
      />
      {busy ? 'Beschäftigt' : 'Verfügbar'}
    </span>
  );
}

export function OrgChatPage() {
  const { chat, counterpart, turn } = useChatSession();
  const sessions = useSessionsState();
  const { assistantName, config } = useConfig();
  const org = useOrgState();

  usePageMeta(
    { breadcrumb: [{ label: 'Organization', to: '/org' }, { label: 'Chat' }] },
    [],
  );

  const busyAgentIds = useMemo(
    () => new Set(org.running.map((assignment) => assignment.agentId)),
    [org.running],
  );
  const teamName = (teamId: string | undefined): string | undefined =>
    org.teams.find((team) => team.id === teamId)?.name;

  // Same state change `chooseCounterpart` makes, minus the navigate - a
  // directory that jumped away from itself on every click would defeat the
  // two-pane layout entirely.
  const selectInPlace = (agentId: string | null): void => {
    if (agentId === sessions.counterpartId) return;
    sessions.selectCounterpart(agentId);
    chat.reset();
  };

  const agents = org.agents.filter((agent) => !agent.archived || agent.id === counterpart?.id);

  const welcome = useMemo(
    () => (
      <EmptyState className="mx-auto mb-8 max-w-none gap-4">
        <div className="flex items-center gap-3 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
          <span aria-hidden="true" className="h-px w-6 bg-border" />
          {counterpart?.name ?? assistantName}
          <span aria-hidden="true" className="h-px w-6 bg-border" />
        </div>
        <EmptyStateGreeting className="font-heading text-3xl leading-[1.1] tracking-[-0.035em] text-balance">
          {greeting(new Date(), { honorific: config?.honorific, userName: config?.userName })}
        </EmptyStateGreeting>
        <p className="max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
          {counterpart
            ? `A question, an idea, or a next step — talk it through with ${counterpart.name}.`
            : 'A thought, a plan, or a fresh start. What’s on your mind?'}
        </p>
      </EmptyState>
    ),
    [counterpart, assistantName, config?.honorific, config?.userName],
  );

  // The same payload `useRookeryRuntime`'s `onNew` builds for the chat hub's
  // composer - this pane sends over the same `chat.send`/socket plumbing, it
  // just does not go through the assistant-ui runtime to get there.
  const sendMessage = (text: string): void => {
    chat.send({
      text,
      provider: turn.provider,
      permission: turn.permission,
      ...(turn.model ? { model: turn.model } : {}),
      ...(turn.effort ? { effort: turn.effort } : {}),
      ...(turn.projectId ? { projectId: turn.projectId } : {}),
      ...(sessions.counterpartId ? { agentId: sessions.counterpartId } : {}),
    });
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-72 shrink-0 flex-col border-r">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2">
            <Item asChild size="sm" variant={sessions.counterpartId === null ? 'muted' : 'default'}>
              <button type="button" onClick={() => selectInPlace(null)} className="text-left">
                <ItemMedia>
                  <AssistantAvatar label={assistantName} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{assistantName}</ItemTitle>
                  <ItemDescription>Assistant</ItemDescription>
                </ItemContent>
              </button>
            </Item>

            {agents.map((agent) => (
              <Item
                asChild
                key={agent.id}
                size="sm"
                variant={sessions.counterpartId === agent.id ? 'muted' : 'default'}
              >
                <button type="button" onClick={() => selectInPlace(agent.id)} className="text-left">
                  <ItemMedia variant="icon" className="size-8 rounded-lg bg-muted">
                    <BotIcon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{agent.name}</ItemTitle>
                    <ItemDescription className="flex items-center gap-2">
                      <PresenceDot busy={busyAgentIds.has(agent.id)} />
                      {teamName(agent.teamId) ? <span>· {teamName(agent.teamId)}</span> : null}
                    </ItemDescription>
                  </ItemContent>
                </button>
              </Item>
            ))}
          </div>
        </ScrollArea>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {chat.error && (
          <div className="mx-auto w-full max-w-3xl px-4 pt-4">
            <Item variant="outline" size="sm" className="border-destructive/50 items-start">
              <ItemMedia>
                <TriangleAlertIcon className="text-destructive" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="text-destructive">The turn failed</ItemTitle>
                <ItemDescription className="text-foreground">{chat.error}</ItemDescription>
              </ItemContent>
            </Item>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          <BubbleThread
            messages={chat.messages}
            streaming={chat.streaming}
            busy={chat.busy}
            counterpartName={counterpart?.name ?? assistantName}
            welcome={welcome}
            onSend={sendMessage}
            onAbort={chat.abort}
          />
        </div>
      </div>

      <span className="sr-only">Conversation with {counterpart?.name ?? assistantName}</span>
    </div>
  );
}
