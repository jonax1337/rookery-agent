import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import type { Mail, MailRecipient, RequesterKind } from '@/lib/types';
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
 * The three panes follow shadcn's mail example: a collapsible rail with the
 * open mailbox, its folders and the switcher; a list of cards with search and
 * an All/Unread filter; and a reading pane whose action bar carries Reply,
 * Reply all and Forward. Reply answers inline, the other two open Compose
 * pre-filled, because they are the two that change who a mail goes to.
 *
 * `?mailbox=<id>` pre-selects a mailbox and `?compose=<agentId>` opens Compose
 * with that agent already in To - the two entry points `AgentDetailPage` and
 * `OrgAgentsPage` use instead of the "Chat" button they used to have.
 */

/** What Compose opens with, when something else fills it in first. */
interface ComposePrefill {
  to: EntityOption[];
  cc: EntityOption[];
  subject: string;
  body: string;
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
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [mails, setMails] = useState<Mail[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** Unread in this mailbox's inbox, remembered while the outbox is open. */
  const [inboxUnread, setInboxUnread] = useState<number | null>(null);

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

  /**
   * An agent's job title - "Lead Engineer", "Research Lead".
   *
   * Six agent names in a rail are six names; the title is what says who does
   * what, so it rides along wherever a single sender is named. Only agents
   * have one: the user is the user, and the assistant's role is its name.
   */
  const roleOf = useCallback(
    (kind: RequesterKind, id?: string): string | null =>
      kind === 'agent' && id ? (org.agentById(id)?.title?.trim() || null) : null,
    [org],
  );

  const mailboxRole = useCallback(
    (id: string): string | null => (id === 'user' || id === 'assistant' ? null : roleOf('agent', id)),
    [roleOf],
  );

  const senderRole = useCallback(
    (mail: Mail): string | null => roleOf(mail.fromKind, mail.fromAgentId),
    [roleOf],
  );

  const namesFor = useCallback(
    (mail: Mail, box: 'to' | 'cc'): string[] =>
      mail.recipients
        .filter((recipient) => recipient.box === box)
        .map((recipient) => nameOf(recipient.recipientKind, recipient.recipientId)),
    [nameOf],
  );

  const toLine = useCallback((mail: Mail): string => 'To: ' + (namesFor(mail, 'to').join(', ') || '—'), [namesFor]);
  const ccLine = useCallback(
    (mail: Mail): string | null => {
      const cc = namesFor(mail, 'cc');
      return cc.length > 0 ? 'Cc: ' + cc.join(', ') : null;
    },
    [namesFor],
  );

  /* ------------------------------ ownership -------------------------------- */

  /** Whether a recipient row belongs to whoever's mailbox is open. */
  const isOwnRow = useCallback(
    (recipient: MailRecipient): boolean =>
      mailboxId === 'user'
        ? recipient.recipientKind === 'user'
        : mailboxId === 'assistant'
          ? recipient.recipientKind === 'assistant'
          : recipient.recipientKind === 'agent' && recipient.recipientId === mailboxId,
    [mailboxId],
  );

  /** The mailbox owner's own recipient row on a mail, when there is one. */
  const ownRecipient = useCallback((mail: Mail) => mail.recipients.find(isOwnRow), [isOwnRow]);

  const isUnread = useCallback(
    (mail: Mail): boolean => (ownRecipient(mail)?.readAt ?? null) == null,
    [ownRecipient],
  );

  /* --------------------------------- rows ---------------------------------- */

  /** The name a list row leads with: the sender, or in the outbox the To line. */
  const primaryLabel = useCallback(
    (mail: Mail): string => (box === 'outbox' ? namesFor(mail, 'to').join(', ') || '—' : senderLabel(mail)),
    [box, namesFor, senderLabel],
  );

  /**
   * The job title beside that name - but only when the name is one person.
   *
   * An outbox row addressed to three agents leads with three names, and a
   * single title hung on the end of them would read as though it belonged to
   * the last one.
   */
  const primaryRole = useCallback(
    (mail: Mail): string | null => {
      if (box !== 'outbox') return senderRole(mail);
      const to = mail.recipients.filter((recipient) => recipient.box === 'to');
      const only = to.length === 1 ? to[0] : undefined;
      return only ? roleOf(only.recipientKind, only.recipientId) : null;
    },
    [box, senderRole, roleOf],
  );

  /**
   * The badges under a row: everyone the mail also went to.
   *
   * The mailbox owner is left out of the inbox's chips - "You" on every row of
   * your own inbox says nothing - and so is the whole To line in the outbox,
   * where it is already the row's heading.
   */
  const recipientChips = useCallback(
    (mail: Mail): string[] => {
      const cc = namesFor(mail, 'cc').map((name) => name + ' (Cc)');
      if (box === 'outbox') return cc;
      const to = mail.recipients
        .filter((recipient) => recipient.box === 'to' && !isOwnRow(recipient))
        .map((recipient) => nameOf(recipient.recipientKind, recipient.recipientId));
      return [...to, ...cc];
    },
    [box, namesFor, isOwnRow, nameOf],
  );

  /* ------------------------------ addressing ------------------------------- */

  /** Token `api.sendMail` understands for who sent this mail. */
  const senderToken = (mail: Mail): string =>
    mail.fromKind === 'agent' ? (mail.fromAgentId ?? 'assistant') : mail.fromKind;

  /** The same tokens for one of a mail's recipient boxes, the user left out. */
  const recipientTokens = (mail: Mail, box: 'to' | 'cc'): string[] =>
    mail.recipients
      .filter((recipient) => recipient.box === box && recipient.recipientKind !== 'user')
      .map((recipient) =>
        recipient.recipientKind === 'agent' ? (recipient.recipientId ?? 'assistant') : recipient.recipientKind,
      );

  /**
   * Who a reply goes to. Replying to your own sent mail answers the people it
   * was addressed to, the way a mail client does - taking the sender literally
   * there would post the reply straight back into your own inbox.
   */
  const replyTargets = (mail: Mail): string[] => {
    if (mail.fromKind !== 'user') return [senderToken(mail)];
    return recipientTokens(mail, 'to');
  };

  const tokenLabel = useCallback(
    (token: string): string =>
      token === 'assistant' ? assistantName : (org.agentById(token)?.name ?? 'Former agent'),
    [assistantName, org],
  );

  const replyTargetLabel = (mail: Mail): string | null => {
    const names = replyTargets(mail).map(tokenLabel);
    return names.length > 0 ? names.join(', ') : null;
  };

  /** Everyone a "Reply all" would reach: To gains the sender, Cc stays Cc. */
  const replyAllTargets = (mail: Mail): { to: string[]; cc: string[] } => {
    const sender = mail.fromKind === 'user' ? [] : [senderToken(mail)];
    const to = [...new Set([...sender, ...recipientTokens(mail, 'to')])];
    const cc = [...new Set(recipientTokens(mail, 'cc'))].filter((token) => !to.includes(token));
    return { to, cc };
  };

  /* -------------------------------- options -------------------------------- */

  // "You" is left out: mailing yourself is not what compose is for. The title
  // rides along as the hint, so picking a recipient is a choice between roles
  // rather than between six first names.
  const recipientOptions: EntityOption[] = useMemo(
    () => [
      { value: 'assistant', label: assistantName },
      ...org.agents
        .filter((agent) => !agent.archived)
        .map((agent) => ({
          value: agent.id,
          label: agent.name,
          ...(agent.title.trim() ? { hint: agent.title } : {}),
        })),
    ],
    [org.agents, assistantName],
  );

  /* --------------------------------- load ---------------------------------- */

  // Sequence guard: switching the mailbox or the box starts a new load while
  // the old one may still be out; only the newest run may write state, so the
  // previous mailbox's slow answer cannot land in the one now open.
  const loadSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    try {
      const list = await api.mail(mailboxId, box, 200);
      if (seq !== loadSeq.current) return;
      setMails(list);
      setOffline(false);
    } catch {
      if (seq !== loadSeq.current) return;
      setOffline(true);
    }
  }, [mailboxId, box]);

  useEffect(() => {
    setMails(null);
    setSelectedId(null);
    void load();
  }, [load]);

  useEffect(() => socket.onMail(() => void load()), [socket, load]);

  // The rail's unread count comes from the inbox itself, so it also counts for
  // mailboxes that are not the user's - and it survives a look in the outbox.
  useEffect(() => setInboxUnread(null), [mailboxId]);
  useEffect(() => {
    if (box !== 'inbox' || mails === null) return;
    setInboxUnread(mails.filter(isUnread).length);
  }, [box, mails, isUnread]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    let list = mails ?? [];
    if (interactive && box === 'inbox' && filter === 'unread') list = list.filter(isUnread);
    if (!query) return list;
    return list.filter(
      (mail) =>
        mail.subject.toLowerCase().includes(query) ||
        mail.body.toLowerCase().includes(query) ||
        senderLabel(mail).toLowerCase().includes(query),
    );
  }, [mails, search, senderLabel, interactive, box, filter, isUnread]);

  useEffect(() => {
    if (selectedId && !filtered.some((mail) => mail.id === selectedId)) setSelectedId(null);
  }, [filtered, selectedId]);

  const selected = useMemo(() => filtered.find((mail) => mail.id === selectedId) ?? null, [filtered, selectedId]);

  /* -------------------------------- actions -------------------------------- */

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
      setFilter('all');
    },
    [setSearchParams],
  );

  /** Writes one recipient row's read mark into the loaded list. */
  const patchReadAt = useCallback((mailId: string, rowId: string, readAt: number | undefined): void => {
    setMails(
      (current) =>
        current?.map((entry) =>
          entry.id === mailId
            ? {
                ...entry,
                recipients: entry.recipients.map((recipient) =>
                  recipient.id === rowId ? { ...recipient, readAt } : recipient,
                ),
              }
            : entry,
        ) ?? null,
    );
  }, []);

  const select = useCallback(
    (id: string): void => {
      setSelectedId(id);
      if (!interactive || box !== 'inbox') return;
      const mail = mails?.find((entry) => entry.id === id);
      const own = mail ? ownRecipient(mail) : undefined;
      if (!mail || !own || own.readAt != null) return;
      patchReadAt(mail.id, own.id, Date.now());
      void api
        .markMailRead([own.id])
        .then(() => void mailBadge.refresh())
        .catch(() => undefined);
    },
    [interactive, box, mails, ownRecipient, mailBadge, patchReadAt],
  );

  /** The open mail's own row, when it is read and so can be put back. */
  const unreadableRow = useMemo(() => {
    if (!interactive || !selected) return null;
    const own = ownRecipient(selected);
    return own && own.readAt != null ? own : null;
  }, [interactive, selected, ownRecipient]);

  const markUnread = useCallback((): void => {
    if (!selected || !unreadableRow) return;
    patchReadAt(selected.id, unreadableRow.id, undefined);
    void api
      .markMailRead([unreadableRow.id], false)
      .then(() => void mailBadge.refresh())
      .catch((caught: unknown) => reportFailure('Mark as unread', caught));
  }, [selected, unreadableRow, mailBadge, patchReadAt]);

  const resetCompose = (): void => {
    setComposeTo([]);
    setComposeCc([]);
    setSubject('');
    setBody('');
  };

  const openCompose = (prefill: ComposePrefill): void => {
    setComposeTo(prefill.to);
    setComposeCc(prefill.cc);
    setSubject(prefill.subject);
    setBody(prefill.body);
    setComposeOpen(true);
  };

  /** The mail as a quote block, the way a mail client stacks a conversation. */
  const quoted = (mail: Mail): string =>
    '\n\nOn ' +
    formatDateTime(mail.createdAt) +
    ', ' +
    senderLabel(mail) +
    ' wrote:\n' +
    mail.body
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n');

  const replyAll = (): void => {
    if (!selected) return;
    const { to, cc } = replyAllTargets(selected);
    openCompose({
      to: to.map((token) => ({ value: token, label: tokenLabel(token) })),
      cc: cc.map((token) => ({ value: token, label: tokenLabel(token) })),
      subject: selected.subject.startsWith('Re: ') ? selected.subject : 'Re: ' + selected.subject,
      body: quoted(selected),
    });
  };

  const forward = (): void => {
    if (!selected) return;
    openCompose({
      to: [],
      cc: [],
      subject: selected.subject.startsWith('Fwd: ') ? selected.subject : 'Fwd: ' + selected.subject,
      body:
        '\n\n--- Forwarded message ---\nFrom: ' +
        senderLabel(selected) +
        '\nDate: ' +
        formatDateTime(selected.createdAt) +
        '\nSubject: ' +
        (selected.subject || '(No subject)') +
        '\n' +
        toLine(selected) +
        '\n\n' +
        selected.body,
    });
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

  /* --------------------------------- render -------------------------------- */

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

  const replyAllReach = selected ? replyAllTargets(selected) : null;

  return (
    <div className="flex min-h-0 flex-1">
      <MailNav
        agents={org.agents.filter((agent) => !agent.archived)}
        assistantName={assistantName}
        mailboxId={mailboxId}
        mailboxLabel={mailboxLabel(mailboxId)}
        mailboxRole={mailboxRole(mailboxId)}
        onSelect={selectMailbox}
        box={box}
        onBoxChange={setBox}
        unread={inboxUnread}
        collapsed={navCollapsed}
        onCollapsedChange={setNavCollapsed}
      />

      {/* `min-w-0`: without it this flex child keeps its `min-width: auto` and
          a long unwrapped mail line stretches the panel group past the window,
          pushing the reading pane off screen and defeating every `truncate`. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="38" minSize="24">
            <MailList
              mails={filtered}
              selectedId={selectedId}
              onSelect={select}
              title={mailboxLabel(mailboxId)}
              box={box}
              filter={filter}
              onFilterChange={setFilter}
              interactive={interactive}
              onCompose={() => setComposeOpen(true)}
              search={search}
              onSearch={setSearch}
              primaryLabel={primaryLabel}
              primaryRole={primaryRole}
              recipientChips={recipientChips}
              isUnread={isUnread}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="62" minSize="30">
            <MailDisplay
              mail={selected}
              senderLabel={senderLabel}
              senderRole={senderRole}
              toLine={toLine}
              ccLine={ccLine}
              interactive={interactive}
              replyTargetName={selected ? replyTargetLabel(selected) : null}
              onReply={reply}
              onReplyAll={replyAll}
              onForward={forward}
              canReplyAll={replyAllReach !== null && replyAllReach.to.length + replyAllReach.cc.length > 1}
              onMarkUnread={unreadableRow ? markUnread : undefined}
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
              {/* `max-h-64`: Reply all and Forward arrive with a whole mail
                  quoted underneath, and an auto-growing field would push the
                  Send button past the bottom of the dialog. */}
              <Textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Write your message…"
                className="max-h-64 min-h-32 overflow-y-auto"
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
