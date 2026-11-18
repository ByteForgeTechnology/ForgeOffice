import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';

export interface ContactFields {
  uid: string;
  fullName: string;
  givenName: string;
  familyName: string;
  emails: { type: string; value: string }[];
  phones: { type: string; value: string }[];
  organization: string;
  title: string;
  note: string;
}

export class InvalidVCardError extends Error {
  constructor(message = 'Invalid vCard data') {
    super(message);
    this.name = 'InvalidVCardError';
  }
}

const typeOf = (p: { getParameter(n: string): unknown }) => {
  const t = p.getParameter('type');
  return (Array.isArray(t) ? t[0] : t ?? 'other').toString().toLowerCase();
};

export function parseVCard(text: string): ContactFields {
  let comp;
  try {
    const parsed = ICAL.parse(text);
    comp = new ICAL.Component(Array.isArray(parsed[0]) ? parsed[0] : parsed);
  } catch (err) {
    throw new InvalidVCardError((err as Error).message);
  }
  if (comp.name !== 'vcard') throw new InvalidVCardError('Expected a VCARD');
  const n = comp.getFirstPropertyValue('n') as string[] | string | null;
  const nParts = Array.isArray(n) ? n : typeof n === 'string' ? n.split(';') : [];
  const org = comp.getFirstPropertyValue('org');
  const fields: ContactFields = {
    uid: String(comp.getFirstPropertyValue('uid') ?? ''),
    fullName: String(comp.getFirstPropertyValue('fn') ?? ''),
    familyName: String(nParts[0] ?? ''),
    givenName: String(nParts[1] ?? ''),
    emails: comp.getAllProperties('email').map((p) => ({ type: typeOf(p), value: String(p.getFirstValue()).replace(/^mailto:/i, '') })),
    phones: comp.getAllProperties('tel').map((p) => ({ type: typeOf(p), value: String(p.getFirstValue()).replace(/^tel:/i, '') })),
    organization: Array.isArray(org) ? org.filter(Boolean).join(', ') : String(org ?? ''),
    title: String(comp.getFirstPropertyValue('title') ?? ''),
    note: String(comp.getFirstPropertyValue('note') ?? ''),
  };
  if (!fields.fullName) fields.fullName = [fields.givenName, fields.familyName].filter(Boolean).join(' ') || fields.emails[0]?.value || '';
  return fields;
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

/** Fold content lines at 75 octets (RFC 6350 §3.2). */
function fold(line: string): string {
  const bytes = Buffer.from(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = '';
  for (const ch of line) {
    if (Buffer.byteLength(current + ch) > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
    }
    current += ch;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** Extra directory fields written to vCards (not parsed back). */
export interface VCardExtras {
  orgUnit?: string;
  url?: string;
  address?: { street?: string; city?: string; region?: string; postalCode?: string; country?: string };
}

export function buildVCard(c: Partial<ContactFields> & VCardExtras & { fullName: string }): string {
  const adr = c.address && Object.values(c.address).some(Boolean) ? c.address : null;
  const uid = c.uid || randomUUID();
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `PRODID:-//ForgeOffice//Contacts//EN`,
    `UID:${esc(uid)}`,
    `FN:${esc(c.fullName)}`,
    `N:${esc(c.familyName ?? '')};${esc(c.givenName ?? '')};;;`,
    ...(c.emails ?? []).filter((e) => e.value).map((e) => `EMAIL;TYPE=${(e.type || 'other').toUpperCase()}:${esc(e.value)}`),
    ...(c.phones ?? []).filter((p) => p.value).map((p) => `TEL;TYPE=${(p.type || 'other').toUpperCase()}:${esc(p.value)}`),
    ...(c.organization || c.orgUnit ? [`ORG:${esc(c.organization ?? '')}${c.orgUnit ? `;${esc(c.orgUnit)}` : ''}`] : []),
    ...(c.url ? [`URL:${esc(c.url)}`] : []),
    ...(adr ? [`ADR;TYPE=WORK:;;${esc(adr.street ?? '')};${esc(adr.city ?? '')};${esc(adr.region ?? '')};${esc(adr.postalCode ?? '')};${esc(adr.country ?? '')}`] : []),
    ...(c.title ? [`TITLE:${esc(c.title)}`] : []),
    ...(c.note ? [`NOTE:${esc(c.note)}`] : []),
    `REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    'END:VCARD',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
