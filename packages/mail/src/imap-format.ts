import type { MimeNode } from '@forge/db';
import addressparser from 'nodemailer/lib/addressparser';
import { headerBlock, headerValue, parseHeaderBlock } from './mime';

/** IMAP string: quoted when safe, otherwise a literal. */
export function istr(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NIL';
  if (/[\r\n\0]/.test(value) || /[^\x20-\x7e]/.test(value) || value.length > 1000) {
    return `{${Buffer.byteLength(value)}}\r\n${value}`;
  }
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

export function nstr(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? 'NIL' : istr(value);
}

function paramList(params: Record<string, string>): string {
  const entries = Object.entries(params);
  if (!entries.length) return 'NIL';
  return '(' + entries.map(([k, v]) => `${istr(k.toUpperCase())} ${istr(v)}`).join(' ') + ')';
}

type Parsed = { name: string; address?: string; group?: Parsed[] };

function addressStructs(value: string | null): string {
  if (!value) return 'NIL';
  const list = addressparser(value) as unknown as Parsed[];
  const out: string[] = [];
  for (const a of list) {
    if (a.group) {
      out.push(`(NIL NIL ${istr(a.name)} NIL)`);
      for (const m of a.group) out.push(single(m));
      out.push('(NIL NIL NIL NIL)');
    } else if (a.address) out.push(single(a));
  }
  return out.length ? `(${out.join('')})` : 'NIL';

  function single(a: Parsed) {
    const addr = a.address ?? '';
    const at = addr.lastIndexOf('@');
    const mailbox = at < 0 ? addr : addr.slice(0, at);
    const host = at < 0 ? null : addr.slice(at + 1);
    return `(${nstr(a.name)} NIL ${istr(mailbox)} ${nstr(host)})`;
  }
}

/** RFC 3501 ENVELOPE for the message whose header block is given. */
export function envelopeFromHeaders(block: string): string {
  const fields = parseHeaderBlock(block);
  const from = headerValue(fields, 'from');
  const sender = headerValue(fields, 'sender') ?? from;
  const replyTo = headerValue(fields, 'reply-to') ?? from;
  return (
    '(' +
    [
      nstr(headerValue(fields, 'date')),
      nstr(headerValue(fields, 'subject')),
      addressStructs(from),
      addressStructs(sender),
      addressStructs(replyTo),
      addressStructs(headerValue(fields, 'to')),
      addressStructs(headerValue(fields, 'cc')),
      addressStructs(headerValue(fields, 'bcc')),
      nstr(headerValue(fields, 'in-reply-to')),
      nstr(headerValue(fields, 'message-id')),
    ].join(' ') +
    ')'
  );
}

/** BODY (extended = false) or BODYSTRUCTURE (extended = true). */
export function bodyStructure(node: MimeNode, buf: Buffer | null, extended: boolean): string {
  const disposition = node.disposition ? `(${istr(node.disposition.type.toUpperCase())} ${paramList(node.disposition.params)})` : 'NIL';
  if (node.type === 'multipart') {
    const children = node.children.map((c) => bodyStructure(c, buf, extended)).join('');
    const ext = extended ? ` ${paramList(node.params)} ${disposition} ${nstr(node.language)} ${nstr(node.location)}` : '';
    return `(${children} ${istr(node.subtype.toUpperCase())}${ext})`;
  }
  const size = node.bodyEnd - node.bodyStart;
  let out = `(${istr(node.type.toUpperCase())} ${istr(node.subtype.toUpperCase())} ${paramList(node.params)} ${nstr(node.id)} ${nstr(node.description)} ${istr(node.encoding.toUpperCase())} ${size}`;
  if (node.type === 'text') out += ` ${node.lines}`;
  else if (node.type === 'message' && node.subtype === 'rfc822' && node.message) {
    const env = buf ? envelopeFromHeaders(headerBlock(buf, node.message)) : 'NIL';
    out += ` ${env} ${bodyStructure(node.message, buf, extended)} ${node.lines}`;
  }
  if (extended) out += ` ${nstr(node.md5)} ${disposition} ${nstr(node.language)} ${nstr(node.location)}`;
  return out + ')';
}
