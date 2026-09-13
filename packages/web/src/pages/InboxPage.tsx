import { useCallback, useEffect, useMemo, useState } from 'react';
import { InboxIcon, SendIcon } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { relativeTime } from '@/lib/format';
import type { AgentMessage } from '@/lib/types';
import { useConfig, useMailState, useOrgState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

/**
 * The user's own postbox.
 *
 * `AgentMessage`/`GET,POST /api/org/messages` were built for the assign/cron
 * flow to hand something back to a person, but nothing ever rendered them -
 * so a schedule saying "I'll get back to you" silently wrote a row nobody
 * ever saw. This is that row's screen: every message the company has posted,
 * newest first, plus a form to write one back to a specific agent.
 *
 * A top-level page, not an Organization one: the assistant itself writes into
 * this same inbox (a night's summary, a schedule reporting back), not only
 * agents - so it is a personal mailbox for whoever is signed in, and nesting
 * it under Organization misfiled it as an org-management screen it never was.
 * `OrgLayout`'s tab frame (Agents/Teams/Projects) is genuinely about the
 * company; this page is not part of that trio and was already a full-page
 * sibling of it before this move, same as `/org/chat`.
 *
 * Composing always targets an agent (the picker is not clearable): a note
 * with no recipient would be indistinguishable from a schedule's or an
 * agent's own report landing in this same inbox, which is exactly the signal
 * `RookeryProvider` uses to toast a background reply app-wide.
 */

export function InboxPage() {
  const org = useOrgState();
  const { assistantName } = useConfig();
  const mail = useMailState();

  const [messages, setMessages] = useState<AgentMessage[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [toAgentId, setToAgentId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await api.messages(200);
      setMessages(list);
      setOffline(false);

      const unreadIds = list
        .filter((message) => !message.toAgentId && message.readAt == null)
        .map((message) => message.id);
      if (unreadIds.length > 0) {
        await api.markMessagesRead(unreadIds);
        const readAt = Date.now();
        setMessages((current) =>
          current?.map((message) =>
            unreadIds.includes(message.id) ? { ...message, readAt } : message,
          ) ?? null,
        );
      }
      // The badge in the rail is only a convenience count; the page just made
      // it stale in one direction or the other, so it re-reads the server.
      void mail.refresh();
    } catch {
      setOffline(true);
    }
  }, [mail]);

  useEffect(() => {
    void load();
  }, [load]);

  usePageMeta({ breadcrumb: [{ label: 'Inbox' }] }, []);

  const agentOptions: EntityOption[] = useMemo(
    () =>
      org.agents
        .filter((agent) => !agent.archived)
        .map((agent) => ({ value: agent.id, label: agent.name, hint: agent.title })),
    [org.agents],
  );

  const nameOf = useCallback(
    (agentId: string | undefined): string => (agentId ? org.agentById(agentId)?.name ?? 'Former agent' : assistantName),
    [org, assistantName],
  );

  // `fromAgentId` unset is ambiguous by itself: the compose form below always
  // sets `toAgentId`, so a row with both unset came from a schedule, a night,
  // or the assistant, never from the user typing here - and a row with
  // `toAgentId` set but no sender is the one shape only the user can produce.
  const senderLabel = (message: AgentMessage): string =>
    message.fromAgentId ? nameOf(message.fromAgentId) : message.toAgentId ? 'You' : assistantName;

  const send = async (): Promise<void> => {
    const trimmed = content.trim();
    if (!trimmed || !toAgentId) return;
    setSending(true);
    try {
      const message = await api.postMessage({ toAgentId, content: trimmed });
      setMessages((current) => (current ? [message, ...current] : [message]));
      setContent('');
      toast('Note sent to ' + nameOf(toAgentId));
    } catch (caught) {
      reportFailure('Send', caught);
    } finally {
      setSending(false);
    }
  };

  if (messages === null) {
    return (
      <PageBody width="3xl">
        <div className="flex flex-col gap-3 px-4 lg:px-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </PageBody>
    );
  }

  return (
    <PageBody width="3xl">
      <div className="flex flex-col gap-3 px-4 lg:px-6">
        <h2 className="text-sm font-medium">Write a note</h2>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <EntityCombobox
            options={agentOptions}
            value={toAgentId}
            onChange={setToAgentId}
            placeholder="To…"
            clearable={false}
            className="sm:w-56"
          />
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={toAgentId ? 'Note for ' + nameOf(toAgentId) + '…' : 'Pick an agent first…'}
            className="min-h-20 flex-1"
          />
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void send()} disabled={sending || !content.trim() || !toAgentId}>
            <SendIcon data-icon="inline-start" />
            Send
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        {offline ? (
          <ServerOffline onRetry={() => void load()} />
        ) : messages.length === 0 ? (
          <EmptyState
            icon={InboxIcon}
            title="No messages yet"
            description="Notes to and from agents, and schedules reporting back, show up here."
          />
        ) : (
          <ItemGroup>
            {messages.map((message) => {
              const unread = !message.toAgentId && message.readAt == null;
              return (
                <Item key={message.id} size="sm" variant={unread ? 'outline' : 'default'}>
                  <ItemContent>
                    <ItemTitle>
                      {senderLabel(message)} → {nameOf(message.toAgentId)}
                      {unread && <Badge variant="secondary">New</Badge>}
                    </ItemTitle>
                    <ItemDescription className="whitespace-pre-wrap">{message.content}</ItemDescription>
                  </ItemContent>
                  <span className="shrink-0 self-start pt-1 text-xs text-muted-foreground">
                    {relativeTime(message.createdAt)}
                  </span>
                </Item>
              );
            })}
          </ItemGroup>
        )}
      </div>
    </PageBody>
  );
}
