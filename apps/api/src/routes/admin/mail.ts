import { resolveMx, resolveTxt } from 'node:dns/promises';
import { Type, type Static } from 'typebox';
import { domains, groups, organizations, orm, outboundMessages, quarantine, resources, userAliases, users } from '@forge/db';
import { configuredRelay, dkimDnsRecord, ensureDkimKey, isValidAddress, releaseBlob, releaseFromQuarantine, testRelay, type RelaySettings } from '@forge/mail';
import { encryptString } from '@forge/auth';
import { getPrimaryOrg } from '../../services/directory';
import { renameCalendarAddress } from '@forge/calendar';
import type { AppContext } from '../../context';
import { badRequest, conflict, notFound } from '../../errors';
import { authenticate, requirePermission } from '../../plugins/auth';
import type { App } from '../../types';

const { and, desc, eq, isNull } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export function adminMailRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  /** An address may belong to exactly one user, alias, group or resource. */
  const assertAddressFree = async (orgId: string, address: string) => {
    const at = address.lastIndexOf('@');
    if (at < 1) throw badRequest('Invalid address');
    const [domain] = await db.select().from(domains).where(and(eq(domains.orgId, orgId), eq(domains.name, address.slice(at + 1)))).limit(1);
    if (!domain) throw badRequest('The address must use one of your organisation’s domains');
    const checks = await Promise.all([
      db.select({ id: users.id }).from(users).where(eq(users.email, address)).limit(1),
      db.select({ id: userAliases.id }).from(userAliases).where(eq(userAliases.address, address)).limit(1),
      db.select({ id: groups.id }).from(groups).where(eq(groups.email, address)).limit(1),
      db.select({ id: resources.id }).from(resources).where(eq(resources.email, address)).limit(1),
    ]);
    const rows = checks.flat();
    if (rows.length) throw conflict(`${address} is already in use`);
  };

  // -------------------------------------------------------------------------
  // Domain mail DNS
  // -------------------------------------------------------------------------

  app.get(
    '/api/v1/admin/domains/:id/mail-dns',
    { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: mail'], summary: 'Required mail DNS records and their current state', params: IdParams } },
    async (req) => {
      const [domain] = await db.select().from(domains).where(and(eq(domains.id, req.params.id), eq(domains.orgId, req.principal!.orgId))).limit(1);
      if (!domain) throw notFound('Domain');
      if (!domain.dkimPublicKey) domain.dkimPublicKey = await ensureDkimKey(ctx.mail, domain);
      const host = ctx.config.mail.hostname;
      const dkim = dkimDnsRecord(domain);
      const txt = async (name: string) => {
        try {
          return (await resolveTxt(name)).map((r) => r.join(''));
        } catch {
          return [];
        }
      };
      const [mx, spf, dkimFound, dmarc] = await Promise.all([
        resolveMx(domain.name).catch(() => []),
        txt(domain.name),
        txt(dkim.host),
        txt(`_dmarc.${domain.name}`),
      ]);
      const records = [
        { purpose: 'Receive mail', type: 'MX', host: domain.name, value: `10 ${host}`, ok: mx.some((m) => m.exchange.toLowerCase() === host.toLowerCase()), found: mx.map((m) => `${m.priority} ${m.exchange}`) },
        { purpose: 'Authorise this server to send (SPF)', type: 'TXT', host: domain.name, value: `v=spf1 mx a:${host} ~all`, ok: spf.some((v) => v.startsWith('v=spf1') && (v.includes(host) || v.includes(' mx'))), found: spf.filter((v) => v.startsWith('v=spf1')) },
        { purpose: 'Sign outgoing mail (DKIM)', type: 'TXT', host: dkim.host, value: dkim.value, ok: dkimFound.some((v) => v.replace(/\s/g, '').includes(`p=${domain.dkimPublicKey}`)), found: dkimFound },
        { purpose: 'Policy for failed checks (DMARC)', type: 'TXT', host: `_dmarc.${domain.name}`, value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain.name}`, ok: dmarc.some((v) => v.startsWith('v=DMARC1')), found: dmarc },
      ];
      const catchAll = domain.catchAllUserId ? (await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, domain.catchAllUserId)))[0] : null;
      return { domain: domain.name, hostname: host, records, catchAll: catchAll ?? null };
    },
  );

  app.patch(
    '/api/v1/admin/domains/:id/mail',
    {
      preHandler: requirePermission(ctx, 'domains:manage'),
      schema: { tags: ['admin: mail'], summary: 'Set the catch-all mailbox', params: IdParams, body: Type.Object({ catchAllUserId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]) }) },
    },
    async (req) => {
      const orgId = req.principal!.orgId;
      if (req.body.catchAllUserId) {
        const [u] = await db.select().from(users).where(and(eq(users.id, req.body.catchAllUserId), eq(users.orgId, orgId))).limit(1);
        if (!u) throw notFound('User');
      }
      const [d] = await db
        .update(domains)
        .set({ catchAllUserId: req.body.catchAllUserId })
        .where(and(eq(domains.id, req.params.id), eq(domains.orgId, orgId)))
        .returning();
      if (!d) throw notFound('Domain');
      await ctx.audit.fromRequest(req, { action: 'domain.catch_all_changed', targetType: 'domain', targetId: d.id, targetLabel: d.name, metadata: { catchAllUserId: req.body.catchAllUserId } });
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Outgoing smarthost (SMTP relay)
  // -------------------------------------------------------------------------

  const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\d{1,3}(\.\d{1,3}){3}$|^\[[0-9a-f:]+\]$/i;
  const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
  const RelayBody = Type.Object({
    enabled: Type.Boolean(),
    host: Type.String({ maxLength: 253 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    security: Type.Union([Type.Literal('starttls'), Type.Literal('tls'), Type.Literal('none')]),
    username: Type.Union([Type.String({ maxLength: 320 }), Type.Null()]),
    /** Omit to keep the saved password; null or "" clears it. */
    password: Type.Optional(Type.Union([Type.String({ maxLength: 1024 }), Type.Null()])),
    domains: Type.Array(Type.String({ maxLength: 253 }), { maxItems: 200 }),
  });

  const relayState = async () => {
    const org = await getPrimaryOrg(db);
    if (!org) throw notFound('Organisation');
    return {
      org,
      view: {
        enabled: org.smtpRelayEnabled,
        host: org.smtpRelayHost ?? '',
        port: org.smtpRelayPort,
        security: org.smtpRelaySecurity,
        username: org.smtpRelayUsername,
        hasPassword: !!org.smtpRelayPasswordEnc,
        domains: org.smtpRelayDomains,
        /** FORGE_SMTP_RELAY is set: used whenever the smarthost here is off or out of scope. */
        environmentRelay: !!ctx.config.mail.relayUrl,
        hostname: ctx.config.mail.hostname,
      },
    };
  };

  const checkRelay = (b: { enabled: boolean; host: string; domains: string[]; security: string; username: string | null }) => {
    const host = b.host.trim().toLowerCase();
    if (b.enabled && !host) throw badRequest('Enter the smarthost’s host name');
    if (host && !HOST_RE.test(host)) throw badRequest('Enter a host name such as smtp.example.com');
    const domainsList = [...new Set(b.domains.map((d) => d.trim().toLowerCase().replace(/^\*?\.?/, '')).filter(Boolean))];
    const bad = domainsList.find((d) => !DOMAIN_RE.test(d));
    if (bad) throw badRequest(`Not a domain: ${bad}`);
    return { host, domains: domainsList, username: b.username?.trim() || null };
  };

  app.get('/api/v1/admin/mail/smarthost', { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: mail'], summary: 'Outgoing smarthost (SMTP relay)' } }, async () => (await relayState()).view);

  app.put(
    '/api/v1/admin/mail/smarthost',
    { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Configure the outgoing smarthost', body: RelayBody } },
    async (req) => {
      const { org } = await relayState();
      const b = req.body;
      const clean = checkRelay(b);
      const password = b.password === undefined ? undefined : b.password ? encryptString(ctx.keys.smtpRelayKey, b.password) : null;
      await db
        .update(organizations)
        .set({
          smtpRelayEnabled: b.enabled,
          smtpRelayHost: clean.host || null,
          smtpRelayPort: b.port,
          smtpRelaySecurity: b.security,
          smtpRelayUsername: clean.username,
          ...(password !== undefined ? { smtpRelayPasswordEnc: password } : {}),
          smtpRelayDomains: clean.domains,
        })
        .where(eq(organizations.id, org.id));
      await ctx.audit.fromRequest(req, {
        action: 'mail.smarthost_updated',
        targetType: 'organization',
        targetId: org.id,
        metadata: { enabled: b.enabled, host: clean.host, port: b.port, security: b.security, username: clean.username, passwordChanged: password !== undefined, domains: clean.domains },
      });
      return (await relayState()).view;
    },
  );

  app.post(
    '/api/v1/admin/mail/smarthost/test',
    {
      preHandler: requirePermission(ctx, 'org:manage'),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['admin: mail'],
        summary: 'Test smarthost settings (connect and sign in; optionally send a test message)',
        body: Type.Intersect([RelayBody, Type.Object({ sendTo: Type.Optional(Type.String({ maxLength: 320 })) })]),
      },
    },
    async (req) => {
      const b = req.body as Static<typeof RelayBody> & { sendTo?: string };
      const clean = checkRelay({ ...b, enabled: true });
      // Without a new password, test with the saved one.
      let password = b.password ?? null;
      if (b.password === undefined) password = (await configuredRelay(ctx.mail, { ...(await relayState()).org, smtpRelayEnabled: true, smtpRelayHost: clean.host }).catch(() => null))?.password ?? null;
      const settings: RelaySettings = { host: clean.host, port: b.port, security: b.security, username: clean.username, password };
      if (b.sendTo && !isValidAddress(b.sendTo)) throw badRequest('Enter a valid email address to send the test to');
      const result = await testRelay(settings, ctx.config.mail.hostname, b.sendTo ? { from: req.principal!.user.email, to: b.sendTo.trim() } : undefined);
      await ctx.audit.fromRequest(req, { action: 'mail.smarthost_tested', outcome: result.ok ? 'success' : 'failure', metadata: { host: clean.host, port: b.port, sentTo: b.sendTo ?? null, result: result.message } });
      return result;
    },
  );

  // -------------------------------------------------------------------------
  // Aliases
  // -------------------------------------------------------------------------

  app.get('/api/v1/admin/users/:id/aliases', { preHandler: requirePermission(ctx, 'users:read'), schema: { tags: ['admin: mail'], summary: 'Email aliases of a user', params: IdParams } }, async (req) => ({
    items: await db.select().from(userAliases).where(eq(userAliases.userId, req.params.id)),
  }));

  app.post(
    '/api/v1/admin/users/:id/aliases',
    { preHandler: requirePermission(ctx, 'users:manage'), schema: { tags: ['admin: mail'], summary: 'Add an alias', params: IdParams, body: Type.Object({ address: Type.String({ maxLength: 320 }) }) } },
    async (req, reply) => {
      const orgId = req.principal!.orgId;
      const [user] = await db.select().from(users).where(and(eq(users.id, req.params.id), eq(users.orgId, orgId))).limit(1);
      if (!user) throw notFound('User');
      const address = req.body.address.trim().toLowerCase();
      await assertAddressFree(orgId, address);
      const [row] = await db.insert(userAliases).values({ userId: user.id, address }).returning();
      await ctx.audit.fromRequest(req, { action: 'user.alias_added', targetType: 'user', targetId: user.id, targetLabel: user.email, metadata: { address } });
      reply.code(201);
      return { alias: row };
    },
  );

  app.post(
    '/api/v1/admin/users/:id/aliases/:aliasId/make-primary',
    {
      preHandler: requirePermission(ctx, 'users:manage'),
      schema: {
        tags: ['admin: mail'],
        summary: 'Make an alias the primary address; the old primary address becomes an alias',
        params: Type.Object({ id: Type.String({ format: 'uuid' }), aliasId: Type.String({ format: 'uuid' }) }),
      },
    },
    async (req) => {
      const orgId = req.principal!.orgId;
      const [user] = await db.select().from(users).where(and(eq(users.id, req.params.id), eq(users.orgId, orgId))).limit(1);
      if (!user) throw notFound('User');
      if (user.status === 'deleted') throw conflict('Restore this account before changing its address');
      const [alias] = await db.select().from(userAliases).where(and(eq(userAliases.id, req.params.aliasId), eq(userAliases.userId, user.id))).limit(1);
      if (!alias) throw notFound('Alias');
      const at = alias.address.lastIndexOf('@');
      const [domain] = await db.select().from(domains).where(and(eq(domains.orgId, orgId), eq(domains.name, alias.address.slice(at + 1)))).limit(1);
      if (!domain) throw badRequest('The alias is not on one of your organisation’s domains');
      const previous = user.email;

      // Swap in one transaction so the address is never unowned (and never owned twice).
      const updated = await db.transaction(async (tx) => {
        await tx.delete(userAliases).where(eq(userAliases.id, alias.id));
        const [row] = await tx.update(users).set({ email: alias.address, username: alias.address.slice(0, at), domainId: domain.id }).where(eq(users.id, user.id)).returning();
        await tx.insert(userAliases).values({ userId: user.id, address: previous });
        return row!;
      });

      // Their own events now name them by the new address.
      const events = await renameCalendarAddress(db, user.id, previous, alias.address).catch((err: Error) => {
        req.log.warn({ err: err.message }, 'could not update calendar addresses');
        return 0;
      });
      await ctx.audit.fromRequest(req, { action: 'user.primary_address_changed', targetType: 'user', targetId: user.id, targetLabel: alias.address, metadata: { from: previous, to: alias.address, calendarEventsUpdated: events } });
      void ctx.bus?.publish('user.updated', { orgId, userId: user.id, change: 'updated' }).catch(() => {});
      return { email: updated.email, previous };
    },
  );

  app.delete(
    '/api/v1/admin/users/:id/aliases/:aliasId',
    { preHandler: requirePermission(ctx, 'users:manage'), schema: { tags: ['admin: mail'], summary: 'Remove an alias', params: Type.Object({ id: Type.String({ format: 'uuid' }), aliasId: Type.String({ format: 'uuid' }) }) } },
    async (req) => {
      const [row] = await db.delete(userAliases).where(and(eq(userAliases.id, req.params.aliasId), eq(userAliases.userId, req.params.id))).returning();
      if (!row) throw notFound('Alias');
      await ctx.audit.fromRequest(req, { action: 'user.alias_removed', targetType: 'user', targetId: req.params.id, metadata: { address: row.address } });
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Rooms & equipment
  // -------------------------------------------------------------------------

  const Resource = Type.Object({
    name: Type.String({ minLength: 1, maxLength: 200 }),
    email: Type.String({ maxLength: 320 }),
    kind: Type.Union([Type.Literal('room'), Type.Literal('equipment')], { default: 'room' }),
    capacity: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 100000 }), Type.Null()])),
    location: Type.String({ maxLength: 500, default: '' }),
    autoAccept: Type.Boolean({ default: true }),
  });

  app.get('/api/v1/admin/resources', { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: mail'], summary: 'Rooms and equipment' } }, async (req) => ({
    items: await db.select().from(resources).where(eq(resources.orgId, req.principal!.orgId)),
  }));

  app.post('/api/v1/admin/resources', { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Add a bookable room or equipment', body: Resource } }, async (req, reply) => {
    const orgId = req.principal!.orgId;
    const email = req.body.email.trim().toLowerCase();
    await assertAddressFree(orgId, email);
    const [row] = await db.insert(resources).values({ ...req.body, email, orgId }).returning();
    await ctx.audit.fromRequest(req, { action: 'resource.created', targetType: 'resource', targetId: row!.id, targetLabel: row!.name });
    reply.code(201);
    return { resource: row };
  });

  app.patch(
    '/api/v1/admin/resources/:id',
    { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Update a resource', params: IdParams, body: Type.Partial(Type.Omit(Resource, ['email'])) } },
    async (req) => {
      const [row] = await db.update(resources).set(req.body).where(and(eq(resources.id, req.params.id), eq(resources.orgId, req.principal!.orgId))).returning();
      if (!row) throw notFound('Resource');
      return { resource: row };
    },
  );

  app.delete('/api/v1/admin/resources/:id', { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Delete a resource', params: IdParams } }, async (req) => {
    const [row] = await db.delete(resources).where(and(eq(resources.id, req.params.id), eq(resources.orgId, req.principal!.orgId))).returning();
    if (!row) throw notFound('Resource');
    await ctx.audit.fromRequest(req, { action: 'resource.deleted', targetType: 'resource', targetId: row.id, targetLabel: row.name });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Quarantine & outbound queue
  // -------------------------------------------------------------------------

  app.get('/api/v1/admin/mail/quarantine', { preHandler: requirePermission(ctx, 'system:read'), schema: { tags: ['admin: mail'], summary: 'Messages held for review' } }, async () => ({
    items: (await db.select().from(quarantine).where(isNull(quarantine.releasedAt)).orderBy(desc(quarantine.createdAt)).limit(500)).map((q) => ({ ...q, createdAt: q.createdAt.toISOString() })),
  }));

  app.post('/api/v1/admin/mail/quarantine/:id/release', { preHandler: requirePermission(ctx, 'system:manage'), schema: { tags: ['admin: mail'], summary: 'Deliver a quarantined message', params: IdParams } }, async (req) => {
    const results = await releaseFromQuarantine(ctx.mail, req.params.id, req.principal!.user.id);
    if (!results.length) throw notFound('Quarantined message');
    await ctx.audit.fromRequest(req, { action: 'mail.quarantine_released', targetType: 'quarantine', targetId: req.params.id, metadata: { results } });
    return { results };
  });

  app.delete('/api/v1/admin/mail/quarantine/:id', { preHandler: requirePermission(ctx, 'system:manage'), schema: { tags: ['admin: mail'], summary: 'Discard a quarantined message', params: IdParams } }, async (req) => {
    const [row] = await db.delete(quarantine).where(eq(quarantine.id, req.params.id)).returning();
    if (!row) throw notFound('Quarantined message');
    await releaseBlob(ctx.mail, row.blobSha);
    await ctx.audit.fromRequest(req, { action: 'mail.quarantine_deleted', targetType: 'quarantine', targetId: row.id, targetLabel: row.subject });
    return { ok: true };
  });

  app.get(
    '/api/v1/admin/mail/outbound',
    { preHandler: requirePermission(ctx, 'system:read'), schema: { tags: ['admin: mail'], summary: 'Outgoing mail queue', querystring: Type.Object({ status: Type.Optional(Type.String({ maxLength: 20 })) }) } },
    async (req) => {
      const rows = await db
        .select({ o: outboundMessages, email: users.email })
        .from(outboundMessages)
        .leftJoin(users, eq(users.id, outboundMessages.userId))
        .where(req.query.status ? eq(outboundMessages.status, req.query.status as typeof outboundMessages.$inferSelect.status) : undefined)
        .orderBy(desc(outboundMessages.createdAt))
        .limit(200);
      return {
        items: rows.map(({ o, email }) => ({
          id: o.id,
          sender: email ?? (o.envelopeFrom || 'system'),
          subject: o.subject,
          status: o.status,
          recipients: o.recipients,
          lastError: o.lastError,
          sendAt: o.sendAt.toISOString(),
          createdAt: o.createdAt.toISOString(),
        })),
      };
    },
  );

}
