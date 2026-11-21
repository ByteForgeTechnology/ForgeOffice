import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RemoteBlobStore, createMailStoreServer } from '@forge/storage';

let dir: string;
let url: string;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mailstore-'));
  const server = createMailStoreServer({ root: dir, token: 'service-token', maxBytes: 1024 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});

afterAll(async () => {
  await close?.();
  await rm(dir, { recursive: true, force: true });
});

describe('mail-store service', () => {
  it('stores, deduplicates, reads and deletes messages', async () => {
    const store = new RemoteBlobStore(url, 'service-token');
    const msg = Buffer.from('Subject: hi\r\n\r\nhello');
    const first = await store.put(msg);
    expect(first).toMatchObject({ size: msg.length, created: true });
    expect((await store.put(msg)).created).toBe(false);
    expect((await store.read(first.sha256)).equals(msg)).toBe(true);
    expect(await store.exists(first.sha256)).toBe(true);
    expect(await store.delete(first.sha256)).toBe(true);
    expect(await store.exists(first.sha256)).toBe(false);
    await expect(store.read(first.sha256)).rejects.toThrow(/not found/);
  });

  it('refuses callers without the service token, and oversized messages', async () => {
    await expect(new RemoteBlobStore(url, 'wrong').put(Buffer.from('x'))).rejects.toThrow(/service token/);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    await expect(new RemoteBlobStore(url, 'service-token').put(Buffer.alloc(2048))).rejects.toThrow(/maximum allowed size/);
    await expect(new RemoteBlobStore(url, 'service-token').read('../../etc/passwd')).rejects.toThrow(/Invalid blob id/);
  });
});
