import { simpleParser, type AddressObject } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';
import type { AttachmentInfo, MailAddress, MimeNode } from '@forge/db';
import { decodedSize, headerValue, leafParts, parseHeaderBlock, parseMimeTree, partFilename } from './mime';

export interface IndexedMessage {
  tree: MimeNode;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  sentAt: Date | null;
  snippet: string;
  bodyText: string;
  html: string | null;
  attachments: AttachmentInfo[];
  /** Lower-case header name → raw values (root header only). */
  headers: Map<string, string[]>;
  calendarParts: { method: string | null; ics: string }[];
}

function addresses(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((v) => v.value.flatMap((a) => (a.group ? a.group : [a]))).filter((a) => !!a.address).map((a) => ({ name: a.name ?? '', address: a.address! }));
}

const MSGID_RE = /<[^<>\s]+>/g;

/** Parse a raw RFC 5322 message into the fields stored on `messages`. */
export async function indexMessage(raw: Buffer): Promise<IndexedMessage> {
  const tree = parseMimeTree(raw);
  const rootFields = parseHeaderBlock(raw.subarray(0, tree.bodyStart).toString('utf8'));
  const headers = new Map<string, string[]>();
  for (const f of rootFields) headers.set(f.key, [...(headers.get(f.key) ?? []), f.value]);

  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true, maxHtmlLengthToParse: 2_000_000 });
  const text = parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }) : '');
  const bodyText = text.replace(/\s+\n/g, '\n').slice(0, 500_000);
  const snippet = bodyText
    .split('\n')
    .filter((l) => !l.startsWith('>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  const attachments: AttachmentInfo[] = [];
  const calendarParts: { method: string | null; ics: string }[] = [];
  for (const part of leafParts(tree)) {
    const filename = partFilename(part);
    const contentType = `${part.type}/${part.subtype}`;
    if (contentType === 'text/calendar') {
      const att = parsed.attachments.find((a) => a.contentType === 'text/calendar');
      const ics = att ? att.content.toString('utf8') : '';
      if (ics) calendarParts.push({ method: part.params.method?.toUpperCase() ?? null, ics });
    }
    const isBody = part.type === 'text' && (part.subtype === 'plain' || part.subtype === 'html') && !filename && part.disposition?.type !== 'attachment';
    if (isBody || part.path === '') {
      if (!filename) continue;
    }
    if (part.type === 'multipart') continue;
    const inline = part.disposition?.type === 'inline' || (!!part.id && part.type === 'image' && part.disposition?.type !== 'attachment');
    attachments.push({
      partPath: part.path || '1',
      filename: filename ?? (contentType === 'text/calendar' ? 'invite.ics' : `part-${part.path || '1'}`),
      contentType,
      size: decodedSize(part),
      contentId: part.id ? part.id.replace(/^<|>$/g, '') : null,
      inline,
    });
  }

  const references = (headerValue(rootFields, 'references') ?? '').match(MSGID_RE) ?? [];
  const inReplyTo = (headerValue(rootFields, 'in-reply-to') ?? '').match(MSGID_RE)?.[0] ?? null;
  const messageId = (headerValue(rootFields, 'message-id') ?? '').match(MSGID_RE)?.[0] ?? null;
  const from = addresses(parsed.from)[0] ?? null;

  return {
    tree,
    messageId,
    inReplyTo,
    references,
    subject: (parsed.subject ?? '').slice(0, 998),
    from,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    replyTo: addresses(parsed.replyTo),
    sentAt: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null,
    snippet,
    bodyText,
    html: typeof parsed.html === 'string' ? parsed.html : null,
    attachments,
    headers,
    calendarParts,
  };
}

/** Normalised subject used as a fallback threading key ("Re: Fwd: x" → "x"). */
export function baseSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^(re|fw|fwd|aw|wg|sv|vs|antw|ref|tr)(\[\d+\])?\s*:\s*/i, '').replace(/^\[[^\]]{1,40}\]\s*/, '');
    if (next === s) break;
    s = next;
  }
  return s.toLowerCase();
}
