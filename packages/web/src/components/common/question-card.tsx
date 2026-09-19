import * as React from 'react';

import { CircleHelpIcon, SendIcon } from '@/components/icons';
import { inkButton, paper, pressable } from '@/components/assistant-ui/elements/surfaces';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { failureMessage } from '@/lib/errors';
import type { QuestionEvent } from '@/lib/socket';
import type { QuestionReply } from '@/hooks/useChat';
import { cn } from '@/lib/utils';

/**
 * The assistant's question, as a card that sits in the page rather than over
 * it.
 *
 * A modal would be wrong twice: it would freeze everything else for as long
 * as a turn waits - which may be minutes - and the question is not a decision
 * the app needs before it can go on. Anyone may ignore it, keep reading, or
 * answer it from the phone instead; the card simply disappears when the
 * question closes, wherever it was answered.
 *
 * Options are indices, not labels: the answer travels back as `selected`, so
 * a label the model rephrases between asking and reading changes nothing. The
 * free field rides along with them, so "the second one, but only for this
 * project" is one answer rather than two.
 */

export interface QuestionCardProps {
  question: QuestionEvent;
  /** Deliver the answer. Rejects if it got nowhere, and the card says so. */
  onAnswer(reply: QuestionReply): Promise<void> | void;
  /** The deadline passed with no answer; the turn has moved on without us. */
  onExpire?(): void;
  className?: string;
}

/** How long is left, in words. `null` once there is nothing left. */
export function remainingLabel(expiresAt: number, now: number): string | null {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  const left = expiresAt - now;
  if (left <= 0) return null;
  const minutes = Math.round(left / 60000);
  if (minutes < 1) return 'less than a minute left';
  return minutes === 1 ? '1 minute left' : minutes + ' minutes left';
}

const TICK_MS = 15000;

export function QuestionCard({ question, onAnswer, onExpire, className }: QuestionCardProps) {
  const [selected, setSelected] = React.useState<number[]>([]);
  const [other, setOther] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  const headingId = 'question-' + question.id;
  const otherId = headingId + '-other';
  const optionId = (index: number): string => headingId + '-option-' + index;

  // The label counts down while the card waits; a minute's resolution needs
  // nothing finer than this.
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // The server closes an expired question itself, but a dropped socket would
  // leave the card standing in front of a turn that has long since given up.
  // Held in a ref so a caller's inline arrow does not restart the timer on
  // every render.
  const expireRef = React.useRef(onExpire);
  expireRef.current = onExpire;
  React.useEffect(() => {
    const left = question.expiresAt - Date.now();
    if (!Number.isFinite(question.expiresAt) || question.expiresAt <= 0) return undefined;
    if (left <= 0) {
      expireRef.current?.();
      return undefined;
    }
    const timer = setTimeout(() => expireRef.current?.(), left);
    return () => clearTimeout(timer);
  }, [question.expiresAt]);

  const text = other.trim();
  const canSend = selected.length > 0 || text.length > 0;
  const remaining = remainingLabel(question.expiresAt, now);

  function choose(index: number, checked: boolean): void {
    setFailure(null);
    setSelected((current) => {
      if (!question.multiSelect) return checked ? [index] : [];
      if (checked) return current.includes(index) ? current : [...current, index].sort((a, b) => a - b);
      return current.filter((entry) => entry !== index);
    });
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (sending || !canSend) return;
    setSending(true);
    setFailure(null);
    try {
      await onAnswer({ selected, ...(text ? { text } : {}) });
      // No `setSending(false)` on the way out: a delivered answer takes the
      // card with it, and re-enabling the button first would offer a second
      // answer to a question that is already closed.
    } catch (caught) {
      setFailure(failureMessage(caught));
      setSending(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-busy={sending}
      className={cn(
        paper,
        'fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex w-full flex-col gap-4 rounded-xl p-4 duration-300 motion-reduce:animate-none',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="gap-1.5">
          <CircleHelpIcon className="size-3" />
          {question.header || 'Question'}
        </Badge>
        {remaining ? (
          <span className="text-muted-foreground text-xs tabular-nums">{remaining}</span>
        ) : null}
      </div>

      <p id={headingId} className="text-sm leading-relaxed text-pretty">
        {question.question}
      </p>

      {question.options.length > 0 ? (
        question.multiSelect ? (
          <div role="group" aria-labelledby={headingId} className="grid gap-2">
            {question.options.map((option, index) => (
              <FieldLabel key={index} htmlFor={optionId(index)}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{option.label}</FieldTitle>
                    {option.description ? (
                      <FieldDescription>{option.description}</FieldDescription>
                    ) : null}
                  </FieldContent>
                  <Checkbox
                    id={optionId(index)}
                    checked={selected.includes(index)}
                    onCheckedChange={(checked) => choose(index, checked === true)}
                    aria-label={option.label}
                  />
                </Field>
              </FieldLabel>
            ))}
          </div>
        ) : (
          <RadioGroup
            aria-labelledby={headingId}
            className="gap-2"
            value={selected.length > 0 ? String(selected[0]) : ''}
            onValueChange={(value) => choose(Number(value), true)}
          >
            {question.options.map((option, index) => (
              <FieldLabel key={index} htmlFor={optionId(index)}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{option.label}</FieldTitle>
                    {option.description ? (
                      <FieldDescription>{option.description}</FieldDescription>
                    ) : null}
                  </FieldContent>
                  <RadioGroupItem
                    value={String(index)}
                    id={optionId(index)}
                    aria-label={option.label}
                  />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
        )
      ) : null}

      {/* Always offered, never required: the options are the model's guesses
          at the answer, and the real one is often none of them. */}
      <Field>
        <FieldLabel htmlFor={otherId}>Other</FieldLabel>
        <Input
          id={otherId}
          value={other}
          placeholder="Answer in your own words"
          autoComplete="off"
          onChange={(event) => {
            setOther(event.target.value);
            setFailure(null);
          }}
        />
      </Field>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {failure ? (
          <p role="alert" className="text-destructive text-xs">
            {failure}
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            The turn is waiting, and carries on as soon as you answer.
          </p>
        )}
        <Button
          type="submit"
          disabled={!canSend || sending}
          className={cn(inkButton, pressable, 'ms-auto rounded-md px-4')}
        >
          {sending ? <Spinner /> : <SendIcon className="size-4" />}
          Send answer
        </Button>
      </div>
    </form>
  );
}
