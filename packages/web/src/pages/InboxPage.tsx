import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { Mail, RequesterKind } from '@/lib/types';
import { useConfig, useConnection, useMailState, useOrgState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';
import { ServerOffline } from '@/components/common/empty-state';
import type { EntityOption } from '@/components/forms/entity-combobox';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

import { MailDisplay } from '@/components/mail/mail-display';
import { MailList } from '@/components/mail/mail-list';
import { MailNav } from '@/components/mail/mail-nav';
import { MultiEntityCombobox } from '@/components/mail/multi-entity-combobox';

/**
 * Company mail - a real mail program, not a note list.
 *
 * Chat stopped being how anyone talks to an agent; this is what replaced it.
 * A mailbox switcher picks whose mail is on screen - the user's own (the only
 * writable one), the assistant's, or any agent's, all real subject/To/Cc mail
 * with per-recipient read state. Mailing an agent's To line kicks off a real
 * run of theirs behind the scenes; its result comes back as a reply here.
 *
 * `?mailbox=<id>` pre-selects a mailbox and `?compose=<agentId>` opens Compose
 * with that agent already in To - the two entry points `AgentDetailPage` and
 * `OrgAgentsPage` use instead of the "Chat" button they used to have.
 */

function snippetOf(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

export function InboxPage() {
  const org = useOrgState();
  const { assistantName } = useConfig();
  const { socket } = useConnection();
  const mailBadge = useMailState();

  const [searchParams, setSearchParams] = useSearchParams();
  const mailboxId = searchParams.get('mailbox') ?? 'user';
  const composeAgentId = searchParams.get('compose');
  const interactive = mailboxId === 'user';

  const [box, setBox] = useState<'inbox' | 'outbox'>('inbox');
  const [mails, setMails] = useState<Mail[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState<EntityOption[]>([]);
  const [composeCc, setComposeCc] = useState<EntityOption[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  usePageMeta({ breadcrumb: [{ label: 'Inbox' }] }, []);

  /* ------------------------------- naming --------------------------------- */

  const nameOf = useCallback(
    (kind: RequesterKind, id?: string): string => {
      if (kind === 'user') return 'You';
      if (kind === 'assistant') return assistantName;
      return id ? (org.agentById(id)?.name ?? 'Former agent') : 'Former agent';
    },
    [org, assistantName],
  );

  const mailboxLabel = useCallback(
    (id: string): string => nameOf(id === 'user' || id === 'assistant' ? id : 'agent', id),
    [nameOf],
  );

  const senderLabel = useCallback((mail: Mail): string => nameOf(mail.fromKind, mail.fromAgentId), [nameOf]);

  const namesFor = useCallback(
    (mail: Mail, box: 'to' | 'cc'): string[] =>
      mail.recipients
        .filter((recipient) => recipient.box === box)
        .map((recipient) => nameOf(recipient.recipientKind, recipient.recipientId)),
    [nameOf],
  );

  const recipientSummary = useCallback(
    (mail: Mail): string => {
      const to = namesFor(mail, 'to');
      const cc = namesFor(mail, 'cc');
      return 'To: ' + (to.join(', ') || '—') + (cc.length > 0 ? ' · Cc: ' + cc.join(', ') : '');
    },
    [namesFor],
  );

  const toLine = useCallback((mail: Mail): string => 'To: ' + (namesFor(mail, 'to').join(', ') || '—'), [namesFor]);
  const ccLine = useCallback((mail: Mail): string | null => {
    const cc = namesFor(mail, 'cc');
    return cc.length > 0 ? 'Cc: ' + cc.join(', ') : null;
  }, [namesFor]);

  /** The mailbox owner's own recipient row on a mail, when there is one. */
  const ownRecipient = useCallback(
    (mail: Mail) =>
      mail.recipients.find((recipient) =>
        mailboxId === 'user'
          ? recipient.recipientKind === 'user'
          : mailboxId === 'assistant'
            ? recipient.recipientKind === 'assistant'
            : recipient.recipientKind === 'agent' && recipient.recipientId === mailboxId,
      ),
    [mailboxId],
  );

  const isUnread = useCallback(
    (mail: Mail): boolean => (ownRecipient(mail)?.readAt ?? null) == null,
    [ownRecipient],
  );

  /** Token `api.sendMail` understands for who sent this mail. */
  const senderToken = (mail: Mail): string => (mail.fromKind === 'agent' ? (mail.fromAgentId ?? 'assistant') : mail.fromKind);

  /**
   * Who a reply goes to. Replying to your own sent mail answers the people it
   * was addressed to, the way a mail client does - taking the sender literally
   * there would post the reply straight back into your own inbox.
   */
  const replyTargets = (mail: Mail): string[] => {
    if (mail.fromKind !== 'user') return [senderToken(mail)];
    return mail.recipients
      .filter((recipient) => recipient.box === 'to' && recipient.recipientKind !== 'user')
      .map((recipient) =>
        recipient.recipientKind === 'agent' ? (recipient.recipientId ?? 'assistant') : recipient.recipientKind,
      );
  };

  const replyTargetLabel = (mail: Mail): string | null => {
    const names = replyTargets(mail).map((token) =>
      token === 'assistant' ? assistantName : (org.agentById(token)?.name ?? 'Former agent'),
    );
    return names.length > 0 ? names.join(', ') : null;
  };

  /* -------------------------------- options -------------------------------- */

  // "You" is left out: mailing yourself is not what compose is for.
  const recipientOptions: EntityOption[] = useMemo(
    () => [
      { value: 'assistant', label: assistantName },
      ...org.agents.filter((agent) => !agent.archived).map((agent) => ({ value: agent.id, label: agent.name })),
    ],
    [org.agents, assistantName],
  );

  /* --------------------------------- load ---------------------------------- */

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await api.mail(mailboxId, box, 200);
      setMails(list);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [mailboxId, box]);

  useEffect(() => {
    setMails(null);
    setSelectedId(null);
    void load();
  }, [load]);

  useEffect(() => socket.onMail(() => void load()), [socket, load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = mails ?? [];
    if (!query) return list;
    return list.filter(
      (mail) =>
        mail.subject.toLowerCase().includes(query) ||
        mail.body.toLowerCase().includes(query) ||
        senderLabel(mail).toLowerCase().includes(query),
    );
  }, [mails, search, senderLabel]);

  useEffect(() => {
    if (selectedId && !filtered.some((mail) => mail.id === selectedId)) setSelectedId(null);
  }, [filtered, selectedId]);

  const selected = useMemo(() => filtered.find((mail) => mail.id === selectedId) ?? null, [filtered, selectedId]);

  /* -------------------------------- actions --------------------------------- */

  const selectMailbox = useCallback(
    (id: string): void => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (id === 'user') next.delete('mailbox');
          else next.set('mailbox', id);
          next.delete('compose');
          return next;
        },
        { replace: true },
      );
      setBox('inbox');
    },
    [setSearchParams],
  );

  const select = useCallback(
    (id: string): void => {
      setSelectedId(id);
      if (!interactive || box !== 'inbox') return;
      const mail = mails?.find((entry) => entry.id === id);
      const own = mail ? ownRecipient(mail) : undefined;
      if (!mail || !own || own.readAt != null) return;
      setMails((current) =>
        current?.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                recipients: entry.recipients.map((recipient) =>
                  recipient.id === own.id ? { ...recipient, readAt: Date.now() } : recipient,
                ),
              }
            : entry,
        ) ?? null,
      );
      void api
        .markMailRead([own.id])
        .then(() => void mailBadge.refresh())
        .catch(() => undefined);
    },
    [interactive, box, mails, ownRecipient, mailBadge],
  );

  const resetCompose = (): void => {
    setComposeTo([]);
    setComposeCc([]);
    setSubject('');
    setBody('');
  };

  const submitCompose = async (): Promise<void> => {
    const trimmedSubject = subject.trim();
    const trimmedBody = body.trim();
    if (!trimmedBody || composeTo.length === 0 || sending) return;
    setSending(true);
    try {
      await api.sendMail({
        to: composeTo.map((option) => option.value),
        ...(composeCc.length > 0 ? { cc: composeCc.map((option) => option.value) } : {}),
        subject: trimmedSubject || '(No subject)',
        body: trimmedBody,
      });
      resetCompose();
      setComposeOpen(false);
      toast('Mail sent');
      void load();
    } catch (caught) {
      reportFailure('Send', caught);
    } finally {
      setSending(false);
    }
  };

  const reply = async (text: string): Promise<void> => {
    if (!selected) return;
    const to = replyTargets(selected);
    if (to.length === 0) return;
    setSending(true);
    try {
      const replySubject = selected.subject.startsWith('Re: ') ? selected.subject : 'Re: ' + selected.subject;
      await api.sendMail({
        to,
        subject: replySubject,
        body: text,
        inReplyTo: selected.id,
      });
      toast('Reply sent');
      void load();
    } catch (caught) {
      reportFailure('Reply', caught);
    } finally {
      setSending(false);
    }
  };

  // `?compose=<agentId>` opens Compose pre-filled, from AgentDetailPage/OrgAgentsPage.
  useEffect(() => {
    if (!composeAgentId) return;
    const agent = org.agentById(composeAgentId);
    setComposeTo([{ value: composeAgentId, label: agent?.name ?? 'Former agent' }]);
    setComposeOpen(true);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('compose');
        return next;
      },
      { replace: true },
    );
  }, [composeAgentId, org, setSearchParams]);

  /* --------------------------------- render --------------------------------- */

  if (mails === null) {
    return (
      <div className="flex flex-col gap-3 p-4 lg:p-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (offline) {
    return (
      <div className="p-4 lg:p-6">
        <ServerOffline onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <MailNav
        agents={org.agents.filter((agent) => !agent.archived)}
        assistantName={assistantName}
        mailboxId={mailboxId}
        onSelect={selectMailbox}
      />

      {/* `min-w-0`: without it this flex child keeps its `min-width: auto` and
          a long unwrapped mail line stretches the panel group past the window,
          pushing the reading pane off screen and defeating every `truncate`. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="text-sm font-medium">{mailboxLabel(mailboxId)}</span>
          {!interactive && (
            <Badge variant="outline" className="text-muted-foreground">
              Read-only
            </Badge>
          )}
        </div>

        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="38" minSize="24">
            <MailList
              mails={filtered}
              selectedId={selectedId}
              onSelect={select}
              box={box}
              onBoxChange={setBox}
              interactive={interactive}
              onCompose={() => setComposeOpen(true)}
              search={search}
              onSearch={setSearch}
              senderLabel={senderLabel}
              recipientSummary={recipientSummary}
              isUnread={isUnread}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="62" minSize="30">
            <MailDisplay
              mail={selected}
              senderLabel={senderLabel}
              toLine={toLine}
              ccLine={ccLine}
              interactive={interactive}
              replyTargetName={selected ? replyTargetLabel(selected) : null}
              onReply={reply}
              sending={sending}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <Dialog
        open={composeOpen}
        onOpenChange={(open) => {
          setComposeOpen(open);
          if (!open) resetCompose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New mail</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel>To</FieldLabel>
              <MultiEntityCombobox
                options={recipientOptions}
                value={composeTo}
                onChange={setComposeTo}
                placeholder="Add recipient…"
              />
            </Field>
            <Field>
              <FieldLabel>Cc</FieldLabel>
              <MultiEntityCombobox
                options={recipientOptions}
                value={composeCc}
                onChange={setComposeCc}
                placeholder="Add Cc…"
              />
            </Field>
            <Field>
              <FieldLabel>Subject</FieldLabel>
              <Input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Subject" />
            </Field>
            <Field>
              <FieldLabel>Body</FieldLabel>
              <Textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Write your message…"
                className="min-h-32"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button onClick={() => void submitCompose()} disabled={sending || !body.trim() || composeTo.length === 0}>
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
