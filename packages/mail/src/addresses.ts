import addressparser from 'nodemailer/lib/addressparser';
import type { MailAddress } from '@forge/db';
import { decodeHeaderWords } from './mime';

type Parsed = { name: string; address?: string; group?: Parsed[] };

/** Parse an address-list header into flat, decoded {name, address} pairs. */
export function parseAddressList(value: string | null | undefined): MailAddress[] {
  if (!value) return [];
  const out: MailAddress[] = [];
  const walk = (list: Parsed[]) => {
    for (const a of list) {
      if (a.group) walk(a.group);
      else if (a.address) out.push({ name: decodeHeaderWords(a.name ?? '').trim(), address: a.address.trim() });
    }
  };
  walk(addressparser(value) as unknown as Parsed[]);
  return out;
}

export function normaliseAddress(address: string): string {
  return address.trim().replace(/^<|>$/g, '').toLowerCase();
}

export function splitAddress(address: string): { local: string; domain: string } {
  const a = normaliseAddress(address);
  const at = a.lastIndexOf('@');
  return at < 0 ? { local: a, domain: '' } : { local: a.slice(0, at), domain: a.slice(at + 1) };
}

/** Strip "+tag" sub-addressing from the local part. */
export function baseAddress(address: string): string {
  const { local, domain } = splitAddress(address);
  const plus = local.indexOf('+');
  return `${plus > 0 ? local.slice(0, plus) : local}@${domain}`;
}

export function formatAddress(a: MailAddress): string {
  if (!a.name) return a.address;
  const safe = /^[\w .'-]+$/.test(a.name) ? a.name : `"${a.name.replace(/(["\\])/g, '\\$1')}"`;
  return `${safe} <${a.address}>`;
}

export function isValidAddress(address: string): boolean {
  return /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(address.trim());
}
