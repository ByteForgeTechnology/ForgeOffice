import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMTPServer } from 'smtp-server';
import { hashPassword } from '@forge/auth';
import { connectDatabase, domains, organizations, users, type DatabaseHandle } from '@forge/db';
import { createMailStoreServer } from '@forge/storage';
import { createMailContext, ensureDkimKey, mailStoreToken, startMailProtocols, type MailContext } from '../src';

export interface Harness {
  handle: DatabaseHandle;
  ctx: MailContext;
  ports: Record<string, number>;
  root: string;
  orgId: string;
  domainId: string;
  relay: { port: number; received: { from: string; to: string[]; raw: Buffer }[] };
  createUser(username: string, password: string, extra?: Partial<typeof users.$inferInsert>): Promise<typeof users.$inferSelect>;
  waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

/** Start a fake internet MTA that records every message it receives. */
async function startRelay() {
  const received: { from: string; to: string[]; raw: Buffer }[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    closeTimeout: 500,
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks) });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.server.address() as { port: number }).port, received };
}

export async function startHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'forge-mail-'));
  const handle = await connectDatabase('pglite://memory');
  await handle.migrate(fileURLToPath(new URL('../../db/drizzle', import.meta.url)));
  const [org] = await handle.db.insert(organizations).values({ name: 'Acme', slug: 'acme', setupCompletedAt: new Date() }).returning();
  const [domain] = await handle.db.insert(domains).values({ orgId: org!.id, name: 'acme.test', isPrimary: true, verified: true, verificationToken: 'x' }).returning();
  const relay = await startRelay();
  const quiet = { info: () => {}, warn: () => {}, error: (o: unknown) => console.error(o) };
  // FORGE_TEST_REMOTE_STORE=1 runs everything through a real mail-store service, as in production.
  const masterSecret = 'test-master-secret-0123456789-abcdefghijklmnop';
  let store: { url: string; close: () => Promise<void> } | null = null;
  if (process.env.FORGE_TEST_REMOTE_STORE === '1') {
    const server = createMailStoreServer({ root: join(root, 'store'), token: mailStoreToken(masterSecret) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    store = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((r) => server.close(() => r())) };
  }
  const ctx = await createMailContext({
    db: handle.db,
    mailDir: join(root, 'mail'),
    storeUrl: store?.url ?? null,
    bus: null,
    deliveryQueue: null,
    log: quiet,
    config: {
      hostname: 'mail.acme.test',
      publicUrl: 'http://localhost',
      certsDir: join(root, 'certs'),
      relayUrl: `smtp://127.0.0.1:${relay.port}?ignoreTLS=true`,
      disableAuthChecks: true,
      masterSecret,
    },
  });
  await ensureDkimKey(ctx, domain!);
  const protocols = await startMailProtocols(ctx, {
    ports: { host: '127.0.0.1', smtp: 0, submission: 0, imap: 0 },
    allowInsecureAuth: true,
    maxMessageBytes: 10 * 1024 * 1024,
  });

  return {
    handle,
    ctx,
    ports: protocols.ports as Record<string, number>,
    root,
    orgId: org!.id,
    domainId: domain!.id,
    relay: { port: relay.port, received: relay.received },
    async createUser(username, password, extra = {}) {
      const [u] = await handle.db
        .insert(users)
        .values({ orgId: org!.id, domainId: domain!.id, username, email: `${username}@acme.test`, displayName: username, passwordHash: await hashPassword(password), ...extra })
        .returning();
      return u!;
    },
    async waitFor(fn, timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const v = await fn();
        if (v) return v as never;
        if (Date.now() > end) throw new Error('waitFor timed out');
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async close() {
      await protocols.close();
      await store?.close();
      await new Promise<void>((r) => relay.server.close(() => r()));
      await handle.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
