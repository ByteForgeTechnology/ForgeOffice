import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { convert as htmlToText } from 'html-to-text';
import type { MailAddress } from '@forge/db';
import { formatAddress } from './addresses';

export interface ComposeAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  cid?: string;
  inline?: boolean;
}

export interface ComposeInput {
  from: MailAddress;
  to?: MailAddress[];
  cc?: MailAddress[];
  /** Not written to the transmitted headers; delivered via the envelope only. */
  bcc?: MailAddress[];
  replyTo?: MailAddress[];
  /** Sender: header, for mail sent on behalf of another address. */
  sender?: MailAddress;
  subject: string;
  html?: string;
  text?: string;
  attachments?: ComposeAttachment[];
  inReplyTo?: string | null;
  references?: string[];
  messageId?: string;
  headers?: Record<string, string>;
  /** iMIP calendar part (text/calendar; method=...). */
  calendar?: { method: string; content: string };
  date?: Date;
}

export function newMessageId(domain: string): string {
  return `<${randomUUID()}@${domain}>`;
}

/** Build an RFC 5322 message (CRLF line endings). */
export async function composeMessage(input: ComposeInput): Promise<{ raw: Buffer; messageId: string }> {
  const domain = input.from.address.split('@')[1] ?? 'localhost';
  const messageId = input.messageId ?? newMessageId(domain);
  const text = input.text ?? (input.html ? htmlToText(input.html, { wordwrap: 78 }) : '');
  const composer = new MailComposer({
    from: formatAddress(input.from),
    to: input.to?.map(formatAddress),
    cc: input.cc?.map(formatAddress),
    replyTo: input.replyTo?.map(formatAddress),
    sender: input.sender ? formatAddress(input.sender) : undefined,
    subject: input.subject,
    text,
    html: input.html,
    messageId,
    date: input.date ?? new Date(),
    inReplyTo: input.inReplyTo ?? undefined,
    references: input.references?.length ? input.references.join(' ') : undefined,
    headers: input.headers,
    attachments: input.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      cid: a.cid,
      contentDisposition: a.inline ? 'inline' : 'attachment',
    })),
    icalEvent: input.calendar ? { method: input.calendar.method, content: input.calendar.content } : undefined,
    newline: '\r\n',
  } as ConstructorParameters<typeof MailComposer>[0]);
  const raw = await new Promise<Buffer>((resolve, reject) => composer.compile().build((err: Error | null, msg: Buffer) => (err ? reject(err) : resolve(msg))));
  return { raw, messageId };
}
