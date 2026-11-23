export interface Addr {
  name: string;
  address: string;
}

export interface MailboxInfo {
  id: string;
  path: string;
  name: string;
  specialUse: string | null;
  /** Your access to this folder: owner, full (incl. delete), write (flag/file), read. */
  access?: 'owner' | 'full' | 'write' | 'read';
  total: number;
  unread: number;
}

export interface AttachmentInfo {
  partPath: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageSummary {
  id: string;
  mailboxId: string;
  threadId: string;
  subject: string;
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  date: string;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
  attachments: AttachmentInfo[];
  messageId: string | null;
  spamScore: number | null;
}

export interface ThreadSummary {
  threadId: string;
  messageIds: string[];
  count: number;
  unread: number;
  flagged: boolean;
  hasAttachments: boolean;
  lastDate: string;
  participants: string[];
  latest: MessageSummary;
}

export interface FullMessage extends MessageSummary {
  body: { html: string; text: string; blockedImages: number };
}

export interface MailAccount {
  id: string;
  name: string;
  address: string;
  /** 'folders': only some folders are shared with you. */
  access: 'owner' | 'full' | 'read' | 'folders';
  sendAs: boolean;
  sendOnBehalf: boolean;
  shared: boolean;
}

/** Request header selecting a shared mailbox for /api/v1/mail calls. */
export const mailboxHeader = (account: MailAccount | undefined): Record<string, string> | undefined =>
  account?.shared ? { 'x-forge-mailbox': account.id } : undefined;

export interface Upload {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface ComposeState {
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  html: string;
  attachments: Upload[];
  replyToMessageId?: string;
  forwardMessageId?: string;
  draftId?: string;
  from?: string;
}

export function formatAddr(a: Addr | null | undefined): string {
  if (!a) return 'Unknown';
  return a.name || a.address;
}

/** Short, human date for message lists: time today, weekday this week, else date. */
export function listDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (now.getTime() - d.getTime() < 6 * 86400_000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleDateString();
}
