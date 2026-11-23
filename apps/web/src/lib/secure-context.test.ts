import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { randomUUID, sha256 } from './secure-context';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('plain-HTTP crypto fallbacks', () => {
  it('sha256 matches Node for every padding boundary', () => {
    for (const len of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = randomBytes(len);
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'));
    }
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('makes version 4 UUIDs', () => {
    const id = randomUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomUUID()).not.toBe(id);
  });
});
