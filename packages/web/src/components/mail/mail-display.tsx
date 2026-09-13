import { useState } from 'react';
import { MailOpenIcon, SendIcon } from 'lucide-react';

import type { Mail } from '@/lib/types';
import { relativeTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/empty-state';
import { ResultMarkdown } from '@/components/result-markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';

/**
 * The reading pane: one mail in full, with subject, from, the to/cc line and
 * a reply box underneath - only when the mailbox is the user's own. Every
 * other mailbox is "nur mitlesen": the same pane, without a way to answer.
 */

interface MailDisplayProps {
  mail: Mail | null;
  senderLabel(mail: Mail): string;
  /** Full "To: …" line, and "Cc: …" when there is one. */
  toLine(mail: Mail): string;
  ccLine(mail: Mail): string | null;
  /** Only the "You" mailbox may reply. */
  interactive: boolean;
  replyTargetName: string | null;
  onReply(body: string): Promise<void>;
  sending: boolean;
}

export function MailDisplay({
  mail,
  senderLabel,
  toLine,
  ccLine,
  interactive,
  replyTargetName,
  onReply,
  sending,
}: MailDisplayProps) {
  const [draft, setDraft] = useState('');

  if (!mail) {
    return (
      <EmptyState
        icon={MailOpenIcon}
        title="No mail selected"
        description="Pick one from the list to read it here."
        className="m-auto"
      />
    );
  }

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    await onReply(text);
    setDraft('');
  };

  const cc = ccLine(mail);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="border-b p-4">
          <div className="text-sm font-medium">{mail.subject || '(No subject)'}</div>
          <div className="mt-1 text-xs text-muted-foreground">From {senderLabel(mail)}</div>
          <div className="text-xs text-muted-foreground">{toLine(mail)}</div>
          {cc && <div className="text-xs text-muted-foreground">{cc}</div>}
          <div className="mt-0.5 text-xs text-muted-foreground">{relativeTime(mail.createdAt)}</div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            <ResultMarkdown text={mail.body} />
          </div>
        </ScrollArea>
      </div>

      {interactive && replyTargetName && (
        <div className="border-t p-3">
          <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={'Reply to ' + replyTargetName + '…'}
              className="min-h-16 flex-1 resize-none"
            />
            <Button type="button" size="icon" onClick={() => void submit()} disabled={sending || !draft.trim()}>
              <SendIcon className="size-4" />
              <span className="sr-only">Reply</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
