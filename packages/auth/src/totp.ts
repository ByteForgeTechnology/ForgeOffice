import { randomInt } from 'node:crypto';
import { generate, generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { safeEqual, sha256Hex } from './crypto';

export function createTotpSecret(): string {
  return generateSecret();
}

export function totpUri(opts: { secret: string; issuer: string; label: string }): string {
  return generateURI({ issuer: opts.issuer, label: opts.label, secret: opts.secret });
}

export function totpQrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
}

export interface TotpCheck {
  valid: boolean;
  /** Time step that matched; persist it and pass back as `lastStep` to block replays. */
  timeStep?: number;
}

/** Verify a 6-digit code allowing ±1 step of clock drift and rejecting replays. */
export async function verifyTotp(secret: string, token: string, lastStep?: number | null): Promise<TotpCheck> {
  const cleaned = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { valid: false };
  const result = await verify({
    secret,
    token: cleaned,
    epochTolerance: 30,
    ...(lastStep != null ? { afterTimeStep: lastStep } : {}),
  });
  if (!result.valid) return { valid: false };
  return { valid: true, timeStep: (result as { timeStep?: number }).timeStep };
}

/** Exposed for tests and tooling. */
export function generateTotp(secret: string): Promise<string> {
  return generate({ secret });
}

// ---------------------------------------------------------------------------
// Recovery codes: 10 single-use codes, stored as SHA-256 hashes.
// ---------------------------------------------------------------------------

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = '';
    for (let j = 0; j < 10; j++) raw += ALPHABET[randomInt(ALPHABET.length)];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return { codes, hashes: codes.map((c) => sha256Hex(normaliseRecoveryCode(c))) };
}

/** Returns the remaining hashes if the code matched, otherwise null. */
export function consumeRecoveryCode(hashes: string[], code: string): string[] | null {
  const candidate = sha256Hex(normaliseRecoveryCode(code));
  let matched = -1;
  hashes.forEach((h, i) => {
    if (safeEqual(h, candidate)) matched = i;
  });
  if (matched === -1) return null;
  return hashes.filter((_, i) => i !== matched);
}
