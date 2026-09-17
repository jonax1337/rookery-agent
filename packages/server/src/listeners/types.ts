import type { ListenerKind } from '@rookery/core';

/**
 * What a listener is willing to say about itself.
 *
 * Everything here is meant for the settings page, so nothing here is a
 * secret: whether a password is present is `configured`, what it is stays in
 * the config file. `blocked` carries a sentence a person can act on, never a
 * server response that might quote the credential back.
 */
export interface ListenerStatus {
  id: string;
  kind: ListenerKind;
  /** One human line, e.g. `me@example.org / INBOX`. */
  label: string;
  /** Everything it needs to run is set. */
  configured: boolean;
  enabled: boolean;
  running: boolean;
  jobId: string;
  /** The schedule's name, resolved for the page; empty when the job is gone. */
  jobName?: string;
  /**
   * Stopped for a reason that will not pass on its own - a rejected password,
   * a mailbox that does not exist. Nothing is being retried; only changed
   * settings start it again.
   */
  blocked?: string;
  lastError?: string;
  /** When something last happened on the far end. */
  lastEventAt?: number;
  /** When that last actually started a run of the schedule. */
  lastFiredAt?: number;
}

/**
 * A connection held open on behalf of one schedule.
 *
 * This deliberately does not reuse `GatewayHandle` from `gateways/telegram.ts`.
 * That interface is Telegram-shaped - its `id` is the literal `'telegram'` and
 * it carries a `send(userId: number, ...)` that only makes sense for a chat -
 * and decision E5 in `docs/concepts/telegram-channel.md` deferred pulling a
 * shared transport interface out of it on purpose, because with one example
 * the shape would have been guesswork. A listener is the second example, but
 * it is a different animal: it carries a single fact rather than a
 * conversation, and it has nothing to send. So the two stay apart until
 * something actually wants to treat them alike.
 */
export interface ListenerHandle {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** React to a config change: start, stop or reconnect accordingly. */
  refresh(): Promise<void>;
  status(): ListenerStatus;
}
