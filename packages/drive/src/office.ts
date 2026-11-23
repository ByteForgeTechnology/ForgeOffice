import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Euro-Office (ONLYOFFICE Docs API) integration helpers. The browser opens the
 * editor with a config signed with the secret shared with the document server
 * (JWT_SECRET there, FORGE_OFFICE_JWT_SECRET here); the document server signs
 * its save callbacks with the same secret.
 */

export type OfficeDocumentType = 'word' | 'cell' | 'slide' | 'pdf';

const TYPES: Record<string, OfficeDocumentType> = {};
for (const e of ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'odt', 'ott', 'rtf', 'txt', 'html', 'htm', 'epub', 'fb2', 'md']) TYPES[e] = 'word';
for (const e of ['xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'xltm', 'xlsb', 'ods', 'ots', 'csv']) TYPES[e] = 'cell';
for (const e of ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'pot', 'potx', 'potm', 'odp', 'otp']) TYPES[e] = 'slide';
for (const e of ['pdf', 'djvu', 'xps', 'oxps']) TYPES[e] = 'pdf';

/** Formats edited and saved back as the same format; the rest open read-only. */
export const OFFICE_EDITABLE = new Set(['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'odt', 'ods', 'odp', 'csv', 'txt']);

export const officeExtension = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
export const officeDocumentType = (name: string): OfficeDocumentType | null => TYPES[officeExtension(name)] ?? null;

/**
 * Document keys identify one revision of a file to the document server (people
 * opening the same key edit together). At most 128 of [0-9A-Za-z.=_-].
 */
export const officeKey = (versionId: string) => versionId.replace(/[^0-9A-Za-z.=_-]/g, '').slice(0, 128);

const b64 = (v: string) => Buffer.from(v).toString('base64url');
const HEADER = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export function signOfficeJwt(secret: string, payload: Record<string, unknown>, ttlSeconds = 8 * 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const body = b64(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(`${HEADER}.${body}`).digest('base64url');
  return `${HEADER}.${body}.${sig}`;
}

/** The payload of a token signed by the document server, or null. */
export function verifyOfficeJwt<T = Record<string, unknown>>(secret: string, token: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as { alg?: string };
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2]!, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as T & { exp?: number };
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
