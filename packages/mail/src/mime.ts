import libmime from 'libmime';
import { decode as qpDecode } from 'libqp';
import type { MimeNode } from '@forge/db';

const CRLF = Buffer.from('\r\n');

/** Convert bare LF line endings to CRLF (RFC 5322 storage form). */
export function normaliseLineEndings(buf: Buffer): Buffer {
  if (!buf.includes(0x0a)) return buf;
  let needs = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) {
      needs = true;
      break;
    }
  }
  if (!needs) return buf;
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) out.push(0x0d);
    out.push(buf[i]!);
  }
  return Buffer.from(out);
}

export interface HeaderLine {
  /** Lower-case field name. */
  key: string;
  /** Unfolded value (UTF-8 interpretation, encoded-words left intact). */
  value: string;
  /** Raw bytes of the field including its folding and trailing CRLF. */
  raw: string;
}

/** Split a header block into fields, preserving raw folded lines. */
export function parseHeaderBlock(block: string): HeaderLine[] {
  const lines = block.split(/\r?\n/);
  const fields: HeaderLine[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && fields.length) {
      const last = fields[fields.length - 1]!;
      last.value += ' ' + line.trim();
      last.raw += line + '\r\n';
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    fields.push({ key: line.slice(0, idx).trim().toLowerCase(), value: line.slice(idx + 1).trim(), raw: line + '\r\n' });
  }
  return fields;
}

export function headerValue(fields: HeaderLine[], key: string): string | null {
  return fields.find((f) => f.key === key)?.value ?? null;
}

function locateHeaderEnd(buf: Buffer, start: number, end: number): { headerEnd: number; bodyStart: number } {
  // A part may start directly with a blank line (no headers).
  if (buf[start] === 0x0d && buf[start + 1] === 0x0a) return { headerEnd: start, bodyStart: start + 2 };
  if (buf[start] === 0x0a) return { headerEnd: start, bodyStart: start + 1 };
  for (let i = start; i < end - 1; i++) {
    if (buf[i] === 0x0a) {
      if (buf[i + 1] === 0x0a) return { headerEnd: i + 1, bodyStart: i + 2 };
      if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) return { headerEnd: i + 1, bodyStart: i + 3 };
    }
  }
  return { headerEnd: end, bodyStart: end };
}

function parseParams(value: string | null): { value: string; params: Record<string, string> } {
  if (!value) return { value: '', params: {} };
  const parsed = libmime.parseHeaderValue(value) as { value: string; params: Record<string, string> };
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.params ?? {})) params[k.toLowerCase()] = String(v);
  return { value: (parsed.value ?? '').trim(), params };
}

function countLines(buf: Buffer, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) if (buf[i] === 0x0a) n++;
  // A trailing partial line still counts.
  if (end > start && buf[end - 1] !== 0x0a) n++;
  return n;
}

/**
 * Parse a raw message into a MIME tree with byte offsets. Offsets always
 * refer to the original buffer, so IMAP sections can be served as slices.
 */
export function parseMimeTree(buf: Buffer): MimeNode {
  return parseEntity(buf, 0, buf.length, '', 'text/plain', 0);
}

function parseEntity(buf: Buffer, start: number, end: number, path: string, defaultType: string, depth: number): MimeNode {
  const { headerEnd, bodyStart } = locateHeaderEnd(buf, start, end);
  const fields = parseHeaderBlock(buf.subarray(start, headerEnd).toString('utf8'));
  const ct = parseParams(headerValue(fields, 'content-type'));
  let [type = 'text', subtype = 'plain'] = (ct.value || defaultType).toLowerCase().split('/');
  if (!subtype) subtype = 'plain';
  const disp = headerValue(fields, 'content-disposition');
  const dispParsed = disp ? parseParams(disp) : null;
  const node: MimeNode = {
    path,
    headerStart: start,
    bodyStart: Math.min(bodyStart, end),
    bodyEnd: end,
    type,
    subtype,
    params: ct.params,
    id: headerValue(fields, 'content-id'),
    description: headerValue(fields, 'content-description'),
    encoding: (headerValue(fields, 'content-transfer-encoding') ?? '7bit').toLowerCase().trim(),
    disposition: dispParsed ? { type: dispParsed.value.toLowerCase(), params: dispParsed.params } : null,
    language: headerValue(fields, 'content-language'),
    location: headerValue(fields, 'content-location'),
    md5: headerValue(fields, 'content-md5'),
    lines: 0,
    children: [],
  };

  if (depth > 20) return node; // guard against pathological nesting

  if (type === 'multipart' && ct.params.boundary) {
    const childDefault = subtype === 'digest' ? 'message/rfc822' : 'text/plain';
    const parts = splitMultipart(buf, node.bodyStart, end, ct.params.boundary);
    node.children = parts.map((p, i) => parseEntity(buf, p.start, p.end, path ? `${path}.${i + 1}` : String(i + 1), childDefault, depth + 1));
    if (!node.children.length) {
      node.type = 'text';
      node.subtype = 'plain';
    }
  } else if (type === 'message' && subtype === 'rfc822') {
    node.message = parseEntity(buf, node.bodyStart, end, path, 'text/plain', depth + 1);
    node.lines = countLines(buf, node.bodyStart, end);
  } else if (type === 'text') {
    node.lines = countLines(buf, node.bodyStart, end);
  }
  return node;
}

/** Find body parts between boundary delimiter lines (RFC 2046 §5.1.1). */
function splitMultipart(buf: Buffer, start: number, end: number, boundary: string): { start: number; end: number }[] {
  const delim = Buffer.from('--' + boundary);
  const parts: { start: number; end: number }[] = [];
  let partStart = -1;
  let pos = start;
  while (pos < end) {
    const lineEnd = buf.indexOf(0x0a, pos);
    const next = lineEnd === -1 || lineEnd >= end ? end : lineEnd + 1;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d && buf.subarray(pos, pos + delim.length).equals(delim)) {
      const after = buf.subarray(pos + delim.length, Math.min(next, end)).toString('latin1');
      const closing = after.startsWith('--');
      if (/^(--)?[ \t]*\r?\n?$/.test(after)) {
        if (partStart >= 0) {
          // The CRLF before the delimiter belongs to the delimiter.
          let partEnd = pos;
          if (partEnd > partStart && buf[partEnd - 1] === 0x0a) partEnd--;
          if (partEnd > partStart && buf[partEnd - 1] === 0x0d) partEnd--;
          parts.push({ start: partStart, end: Math.max(partStart, partEnd) });
        }
        if (closing) return parts;
        partStart = next;
      }
    }
    pos = next;
  }
  if (partStart >= 0 && partStart < end) parts.push({ start: partStart, end });
  return parts;
}

/** Locate a part by numeric IMAP path (e.g. [2, 1]). */
export function findPart(root: MimeNode, path: number[]): MimeNode | null {
  let node: MimeNode = root;
  for (let i = 0; i < path.length; i++) {
    const n = path[i]!;
    if (i > 0 && node.type === 'message' && node.subtype === 'rfc822' && node.message) node = node.message;
    if (node.type === 'multipart') {
      const child = node.children[n - 1];
      if (!child) return null;
      node = child;
    } else if (n !== 1) {
      return null;
    }
  }
  return node;
}

/** Decode a part body (base64 / quoted-printable / identity). */
export function decodePartBody(raw: Buffer, encoding: string): Buffer {
  const enc = encoding.toLowerCase();
  if (enc === 'base64') return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return qpDecode(raw.toString('latin1'));
  return raw;
}

/** Estimated decoded size of a part, without decoding it. */
export function decodedSize(node: MimeNode): number {
  const len = node.bodyEnd - node.bodyStart;
  if (node.encoding === 'base64') return Math.floor((len * 3) / 4 * (76 / 78));
  return len;
}

export function partFilename(node: MimeNode): string | null {
  const name = node.disposition?.params.filename ?? node.params.name;
  if (!name) return null;
  try {
    return libmime.decodeWords(name);
  } catch {
    return name;
  }
}

/** Walk leaf parts (descending into attached messages only for structure, not attachments). */
export function* leafParts(node: MimeNode): Generator<MimeNode> {
  if (node.type === 'multipart') {
    for (const c of node.children) yield* leafParts(c);
  } else {
    yield node;
  }
}

/** Header block of the root (or of an embedded message) as a string. */
export function headerBlock(buf: Buffer, node: MimeNode): string {
  return buf.subarray(node.headerStart, node.bodyStart).toString('utf8');
}

export function joinCrlf(...parts: (string | Buffer)[]): Buffer {
  return Buffer.concat(parts.flatMap((p, i) => (i ? [CRLF, Buffer.isBuffer(p) ? p : Buffer.from(p)] : [Buffer.isBuffer(p) ? p : Buffer.from(p)])));
}

export function decodeHeaderWords(value: string): string {
  try {
    return libmime.decodeWords(value);
  } catch {
    return value;
  }
}
