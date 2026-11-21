import { createServer, type Server } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobs, connectDatabase, drivePermissions, groupMembers, groups, orm, organizations, users, type Database, type DriveLibrary } from '@forge/db';
import { BlobStore } from '@forge/storage';
import {
  accessibleLibraries,
  appendChunk,
  checkIn,
  checkOut,
  children,
  copy,
  createFolder,
  createUpload,
  effectiveRole,
  ensureGroupLibrary,
  ensurePersonalLibrary,
  move,
  previewPath,
  principalFor,
  processVersion,
  purge,
  rename,
  restore,
  restoreVersion,
  scanVersion,
  sharedWithMe,
  signToken,
  storeFile,
  trash,
  trashList,
  verifyToken,
  versions,
  type DriveContext,
} from '../src';

const { eq } = orm;
let root: string;
let db: Database;
let close: () => Promise<void>;
let ctx: DriveContext;
let org: string;
let alice: { id: string; orgId: string };
let bob: { id: string; orgId: string };
let mine: DriveLibrary;

async function user(name: string) {
  const [u] = await db.insert(users).values({ orgId: org, domainId: (await domain()).id, username: name, email: `${name}@acme.test`, displayName: name, passwordHash: 'x' }).returning();
  return { id: u!.id, orgId: org };
}
let dom: { id: string } | null = null;
async function domain() {
  if (dom) return dom;
  const { domains } = await import('@forge/db');
  const [d] = await db.insert(domains).values({ orgId: org, name: 'acme.test', isPrimary: true, verified: true, verificationToken: 'x' }).returning();
  dom = { id: d!.id };
  return dom!;
}
const text = (s: string) => Buffer.from(s);
const refCount = async (sha: string) => (await db.select().from(blobs).where(eq(blobs.sha256, sha)))[0]?.refCount ?? 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'forge-drive-'));
  const handle = await connectDatabase('pglite://memory');
  await handle.migrate(new URL('../../db/drizzle', import.meta.url).pathname);
  db = handle.db;
  close = () => handle.close();
  const [o] = await db.insert(organizations).values({ name: 'Acme', slug: 'acme', defaultQuotaBytes: 1024 * 1024 }).returning();
  org = o!.id;
  const store = new BlobStore(join(root, 'blobs'));
  await store.init();
  ctx = { db, blobs: store, root, log: { info: () => {}, warn: () => {}, error: () => {} } };
  alice = await user('alice');
  bob = await user('bob');
  mine = await ensurePersonalLibrary(db, alice);
}, 60_000);

afterAll(async () => {
  await close?.();
  await rm(root, { recursive: true, force: true });
});

describe('files and folders', () => {
  it('creates folders and files; names are unique per folder (case-insensitive)', async () => {
    const docs = await createFolder(ctx, mine, null, 'Documents', alice.id);
    await expect(createFolder(ctx, mine, null, 'documents', alice.id)).rejects.toThrow(/already exists/);
    expect((await createFolder(ctx, mine, null, 'Documents', alice.id, 'rename')).name).toBe('Documents (2)');
    await expect(createFolder(ctx, mine, null, 'a/b', alice.id)).rejects.toThrow(/cannot contain/);

    const { item } = await storeFile(ctx, { lib: mine, parentId: docs.id, name: 'notes.txt', source: text('hello'), userId: alice.id });
    expect(item).toMatchObject({ name: 'notes.txt', mime: 'text/plain', size: 5, scanStatus: 'skipped' });
    await expect(storeFile(ctx, { lib: mine, parentId: docs.id, name: 'Notes.TXT', source: text('x'), userId: alice.id })).rejects.toThrow(/already exists/);
    expect((await storeFile(ctx, { lib: mine, parentId: docs.id, name: 'notes.txt', source: text('x'), userId: alice.id, conflict: 'rename' })).item.name).toBe('notes (2).txt');
    // Replace = a new version of the same file.
    const v2 = await storeFile(ctx, { lib: mine, parentId: docs.id, name: 'notes.txt', source: text('hello again'), userId: alice.id, conflict: 'replace' });
    expect(v2.item.id).toBe(item.id);
    expect((await versions(ctx, item.id)).map((v) => v.version.number)).toEqual([2, 1]);
    expect((await children(ctx, mine.id, docs.id)).map((c) => c.name)).toEqual(['notes (2).txt', 'notes.txt']);
  });

  it('stores identical content once, and rolls back versions', async () => {
    const a = await storeFile(ctx, { lib: mine, parentId: null, name: 'a.txt', source: text('same bytes'), userId: alice.id });
    const b = await storeFile(ctx, { lib: mine, parentId: null, name: 'b.txt', source: text('same bytes'), userId: alice.id });
    expect(a.item.sha256).toBe(b.item.sha256);
    expect(await refCount(a.item.sha256!)).toBe(2);
    await storeFile(ctx, { lib: mine, parentId: null, name: 'a.txt', source: text('changed'), userId: alice.id, conflict: 'replace' });
    const back = await restoreVersion(ctx, mine, a.item, a.version.id, alice.id);
    expect(back.sha256).toBe(a.item.sha256);
    expect((await versions(ctx, a.item.id))[0]!.version.comment).toBe('Restored version 1');
  });

  it('keeps saves of the same file in order under concurrency', async () => {
    const results = await Promise.all([1, 2, 3].map((n) => storeFile(ctx, { lib: mine, parentId: null, name: 'race.txt', source: text(`v${n}`), userId: alice.id, conflict: 'replace' })));
    expect(new Set(results.map((r) => r.item.id)).size).toBe(1);
    expect((await versions(ctx, results[0]!.item.id)).map((v) => v.version.number)).toEqual([3, 2, 1]);
  });

  it('enforces the personal quota', async () => {
    await expect(storeFile(ctx, { lib: mine, parentId: null, name: 'big.bin', source: Buffer.alloc(2 * 1024 * 1024), userId: alice.id })).rejects.toThrow(/storage space/);
  });
});

describe('move, copy, recycle bin', () => {
  it('moves between libraries (usage follows), refuses cycles, copies without duplicating content', async () => {
    const [g] = await db.insert(groups).values({ orgId: org, name: 'Sales', type: 'security' }).returning();
    const team = await ensureGroupLibrary(db, g!);
    const f = await createFolder(ctx, mine, null, 'Proposals', alice.id);
    const sub = await createFolder(ctx, mine, f.id, 'Drafts', alice.id);
    const file = await storeFile(ctx, { lib: mine, parentId: sub.id, name: 'deal.txt', source: text('0123456789'), userId: alice.id });
    await expect(move(ctx, f, mine, mine, sub.id, alice.id)).rejects.toThrow(/into itself/);
    const usedBefore = (await db.select().from(users).where(eq(users.id, alice.id)))[0]!.usedBytes;
    await move(ctx, f, mine, team, null, alice.id);
    expect((await children(ctx, team.id, null)).map((c) => c.name)).toContain('Proposals');
    expect((await db.select().from(users).where(eq(users.id, alice.id)))[0]!.usedBytes).toBe(usedBefore - 10);
    const dup = await copy(ctx, f, mine, null, alice.id);
    expect(dup.name).toBe('Proposals');
    expect(await refCount(file.item.sha256!)).toBe(2);
  });

  it('trash, restore (renamed if needed) and purge (content released)', async () => {
    const folder = await createFolder(ctx, mine, null, 'Old', alice.id);
    const f = await storeFile(ctx, { lib: mine, parentId: folder.id, name: 'gone.txt', source: text('unique content 42'), userId: alice.id });
    await trash(ctx, folder, alice.id);
    expect((await children(ctx, mine.id, null)).map((c) => c.name)).not.toContain('Old');
    expect((await trashList(ctx, mine.id)).map((t) => t.name)).toContain('Old');
    await createFolder(ctx, mine, null, 'Old', alice.id);
    const [trashed] = (await trashList(ctx, mine.id)).filter((t) => t.id === folder.id);
    expect((await restore(ctx, trashed!, alice.id)).name).toBe('Old (2)');
    expect((await children(ctx, mine.id, folder.id)).map((c) => c.name)).toEqual(['gone.txt']);
    await trash(ctx, folder, alice.id);
    const [again] = (await trashList(ctx, mine.id)).filter((t) => t.id === folder.id);
    await purge(ctx, again!);
    expect(await refCount(f.item.sha256!)).toBe(0);
    await expect(ctx.blobs.read(f.item.sha256!)).rejects.toThrow();
  });
});

describe('permissions', () => {
  it('combines library, group and item grants; a folder can stop inheritance', async () => {
    const bobP = await principalFor(db, bob.id);
    const shared = await createFolder(ctx, mine, null, 'Shared with Bob', alice.id);
    const secret = await createFolder(ctx, mine, shared.id, 'Private', alice.id);
    expect(await effectiveRole(db, bobP, mine, shared)).toBeNull();
    await db.insert(drivePermissions).values({ libraryId: mine.id, itemId: shared.id, principalType: 'user', principalId: bob.id, role: 'editor' });
    expect(await effectiveRole(db, bobP, mine, shared)).toBe('editor');
    expect(await effectiveRole(db, bobP, mine, secret)).toBe('editor');
    await db.update((await import('@forge/db')).driveItems).set({ inheritPermissions: false }).where(eq((await import('@forge/db')).driveItems.id, secret.id));
    const [fresh] = await db.select().from((await import('@forge/db')).driveItems).where(eq((await import('@forge/db')).driveItems.id, secret.id));
    expect(await effectiveRole(db, bobP, mine, fresh!)).toBeNull();
    expect(await effectiveRole(db, await principalFor(db, alice.id), mine, fresh!)).toBe('owner');
    expect((await sharedWithMe(db, bobP)).map((s) => s.item.name)).toEqual(['Shared with Bob']);
  });

  it('group libraries: owners manage, members edit', async () => {
    const [g] = await db.insert(groups).values({ orgId: org, name: 'Design', type: 'security' }).returning();
    await db.insert(groupMembers).values([{ groupId: g!.id, userId: bob.id, role: 'owner' }, { groupId: g!.id, userId: alice.id }]);
    const libs = await accessibleLibraries(db, await principalFor(db, alice.id), org);
    expect(libs.find((l) => l.name === 'Design')?.role).toBe('editor');
    expect((await accessibleLibraries(db, await principalFor(db, bob.id), org)).find((l) => l.name === 'Design')?.role).toBe('owner');
  });
});

describe('uploads, check-out and tokens', () => {
  it('resumes chunked uploads at the right offset', async () => {
    const data = Buffer.from('chunk-one|chunk-two|chunk-three');
    const up = await createUpload(ctx, { lib: mine, parentId: null, name: 'big.txt', size: data.length, userId: alice.id, maxBytes: 1024 });
    const r1 = await appendChunk(ctx, { id: up.id, userId: alice.id, offset: 0, body: Readable.from([data.subarray(0, 10)]), lib: mine });
    expect(r1.upload.received).toBe(10);
    await expect(appendChunk(ctx, { id: up.id, userId: alice.id, offset: 0, body: Readable.from([data.subarray(0, 10)]), lib: mine })).rejects.toThrow(/Expected offset 10/);
    const r2 = await appendChunk(ctx, { id: up.id, userId: alice.id, offset: 10, body: Readable.from([data.subarray(10)]), lib: mine });
    expect(r2.stored?.item.name).toBe('big.txt');
    expect((await ctx.blobs.read(r2.stored!.item.sha256!)).equals(data)).toBe(true);
    await expect(createUpload(ctx, { lib: mine, parentId: null, name: 'x', size: 5000, userId: alice.id, maxBytes: 1024 })).rejects.toThrow(/at most/);
  });

  it('check-out blocks other people’s saves until checked in', async () => {
    const f = await storeFile(ctx, { lib: mine, parentId: null, name: 'contract.txt', source: text('v1'), userId: alice.id });
    const out = await checkOut(ctx, f.item, alice.id);
    await expect(checkOut(ctx, out, bob.id)).rejects.toThrow(/checked out/);
    await expect(storeFile(ctx, { lib: mine, parentId: null, name: 'contract.txt', source: text('bob'), userId: bob.id, conflict: 'replace' })).rejects.toThrow(/checked out/);
    await storeFile(ctx, { lib: mine, parentId: null, name: 'contract.txt', source: text('v2'), userId: alice.id, conflict: 'replace' });
    await checkIn(ctx, out, alice.id);
    await storeFile(ctx, { lib: mine, parentId: null, name: 'contract.txt', source: text('bob'), userId: bob.id, conflict: 'replace' });
  });

  it('signs tokens for one purpose with an expiry', async () => {
    const key = Buffer.alloc(32, 7);
    const t = signToken(key, { p: 'download', i: 'item' }, 60);
    expect(verifyToken(key, t, 'download')).toMatchObject({ i: 'item' });
    expect(verifyToken(key, t, 'share')).toBeNull();
    expect(verifyToken(Buffer.alloc(32, 8), t, 'download')).toBeNull();
    expect(verifyToken(key, signToken(key, { p: 'download' }, -1), 'download')).toBeNull();
    expect(verifyToken(key, t.slice(0, -2) + 'xx', 'download')).toBeNull();
  });
});

describe('scanning and previews', () => {
  let clamd: Server;
  let port: number;
  beforeAll(async () => {
    // A tiny clamd: INSTREAM chunks, "stream: OK" or "stream: Eicar-Signature FOUND".
    clamd = createServer((s) => {
      let buf = Buffer.alloc(0);
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d as Buffer]);
        const body = buf.subarray(buf.indexOf(0) + 1);
        let off = 0;
        const parts: Buffer[] = [];
        while (off + 4 <= body.length) {
          const len = body.readUInt32BE(off);
          if (len === 0) {
            const all = Buffer.concat(parts).toString();
            s.end(all.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (off + 4 + len > body.length) return;
          parts.push(body.subarray(off + 4, off + 4 + len));
          off += 4 + len;
        }
      });
    });
    await new Promise<void>((r) => clamd.listen(0, '127.0.0.1', () => r()));
    port = (clamd.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => clamd.close(() => r())));

  it('marks infected files', async () => {
    const scanning: DriveContext = { ...ctx, clamav: { host: '127.0.0.1', port } };
    const ok = await storeFile(scanning, { lib: mine, parentId: null, name: 'fine.txt', source: text('nothing to see'), userId: alice.id });
    expect(ok.item.scanStatus).toBe('pending');
    expect(await scanVersion(scanning, { itemId: ok.item.id, versionId: ok.version.id })).toBe('clean');
    const bad = await storeFile(scanning, { lib: mine, parentId: null, name: 'eicar.com', source: text('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'), userId: alice.id });
    expect(await scanVersion(scanning, { itemId: bad.item.id, versionId: bad.version.id })).toBe('infected');
    const [row] = await db.select().from((await import('@forge/db')).driveItems).where(eq((await import('@forge/db')).driveItems.id, bad.item.id));
    expect(row).toMatchObject({ scanStatus: 'infected', scanDetail: 'Eicar-Signature' });
  });

  it('makes WebP thumbnails of images and extracts PDF and text for search', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#4f46e5' } }).png().toBuffer();
    const img = await storeFile(ctx, { lib: mine, parentId: null, name: 'photo.png', source: png, userId: alice.id });
    expect(await processVersion(ctx, { itemId: img.item.id, versionId: img.version.id })).toMatchObject({ thumbnail: true });
    const meta = await sharp((await readFile(previewPath(ctx, img.item.sha256!))) as Buffer).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 480 });

    const pdf = await storeFile(ctx, { lib: mine, parentId: null, name: 'invoice.pdf', source: minimalPdf('Quarterly invoice ZEBRA-9'), userId: alice.id });
    expect(await processVersion(ctx, { itemId: pdf.item.id, versionId: pdf.version.id })).toMatchObject({ text: true });
    const { driveItems } = await import('@forge/db');
    const [hit] = await db.select({ name: driveItems.name }).from(driveItems).where(orm.sql`${driveItems.searchVector} @@ plainto_tsquery('simple', 'zebra-9')`);
    expect(hit?.name).toBe('invoice.pdf');
    await rename(ctx, pdf.item, 'Invoice Q3.pdf', alice.id);
  });
});

/** A one-page PDF containing `text`. */
function minimalPdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 20 70 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
