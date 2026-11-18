import type { EventEmitter } from 'node:events';
import type { Database } from '@forge/db';
import type { EventBus } from '@forge/events';
import type { BlobStore } from '@forge/storage';

export interface MailLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface MailConfig {
  /** Public host name of this mail server (EHLO, Received headers, Message-IDs). */
  hostname: string;
  publicUrl: string;
  certsDir: string;
  /** Optional smarthost, e.g. smtp://user:pass@relay.example.com:587. */
  relayUrl: string | null;
  /** Skip SPF/DKIM/DMARC lookups (tests and offline development). */
  disableAuthChecks: boolean;
  /** Remote MX port override (tests). */
  remotePort?: number;
}

export interface OutboundScheduler {
  schedule(outboundId: string, delayMs: number): Promise<void>;
  /** Cancel a pending send; false if it already started. */
  cancel(outboundId: string): Promise<boolean>;
}

export interface MailContext {
  db: Database;
  /** Content-addressed store inside forge_mail_data. */
  blobs: BlobStore;
  bus: EventBus | null;
  events: EventEmitter;
  scheduler: OutboundScheduler;
  config: MailConfig;
  log: MailLogger;
}

/** Notify IMAP IDLE sessions and webmail clients that a user's mail changed. */
export function notifyMailChanged(ctx: MailContext, userId: string, mailboxId?: string) {
  const payload = { userId, mailboxId };
  if (ctx.bus) void ctx.bus.publish('mail.changed', payload).catch(() => ctx.events.emit('mail.changed', payload));
  else ctx.events.emit('mail.changed', payload);
}

/** Subscribe to mail changes regardless of whether Redis is configured. */
export async function onMailChanged(ctx: Pick<MailContext, 'bus' | 'events'>, handler: (e: { userId: string; mailboxId?: string }) => void): Promise<() => void> {
  if (ctx.bus) {
    try {
      return await ctx.bus.on('mail.changed', handler);
    } catch {
      /* fall back to local events */
    }
  }
  ctx.events.on('mail.changed', handler);
  return () => ctx.events.off('mail.changed', handler);
}
