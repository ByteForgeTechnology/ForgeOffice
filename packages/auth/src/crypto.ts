import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Derive a purpose-specific 32-byte key from the installation master secret. */
export function deriveKey(masterSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterSecret, 'forgeoffice', purpose, 32));
}

/** AES-256-GCM encrypt; output is `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encryptString(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptString(key: Buffer, encoded: string): string {
  const [version, iv, tag, ct] = encoded.split('.');
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
