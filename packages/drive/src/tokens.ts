import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compact HS256 JWTs for ForgeDrive: external sharing links, short-lived
 * download URLs (so <img>/<video> can load files without an Authorization
 * header) and WOPI access tokens for the Office editor.
 */
const b64 = (v: Buffer | string) => Buffer.from(v).toString('base64url');
const HEADER = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export function signToken(key: Buffer, claims: Record<string, unknown>, ttlSeconds?: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64(JSON.stringify({ ...claims, iat: now, ...(ttlSeconds ? { exp: now + ttlSeconds } : {}) }));
  const sig = createHmac('sha256', key).update(`${HEADER}.${payload}`).digest('base64url');
  return `${HEADER}.${payload}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(key: Buffer, token: string, purpose: string): (T & { iat: number; exp?: number }) | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const expected = createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2]!, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as T & { iat: number; exp?: number; p?: string };
    if (claims.p !== purpose) return null;
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
