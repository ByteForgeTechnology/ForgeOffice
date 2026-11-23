import { randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { accessibleAddressBooks, buildVCard, delegatedMailboxes, deleteContact, parseVCard, putContact } from '@forge/calendar';
import { addressBookShares, addressBooks, contacts, groups, orm, resources, users } from '@forge/db';
import { assertPrincipals, withPrincipalNames } from '../services/sharing';
import type { AppContext } from '../context';
import { forbidden, notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import type { App } from '../types';

const { and, asc, eq, ilike, isNull, or, sql } = orm;

const ContactBody = Type.Object({
  fullName: Type.String({ minLength: 1, maxLength: 300 }),
  givenName: Type.String({ maxLength: 150, default: '' }),
  familyName: Type.String({ maxLength: 150, default: '' }),
  emails: Type.Array(Type.Object({ type: Type.String({ maxLength: 20 }), value: Type.String({ maxLength: 320 }) }), { maxItems: 20, default: [] }),
  phones: Type.Array(Type.Object({ type: Type.String({ maxLength: 20 }), value: Type.String({ maxLength: 50 }) }), { maxItems: 20, default: [] }),
  organization: Type.String({ maxLength: 300, default: '' }),
  title: Type.String({ maxLength: 300, default: '' }),
  note: Type.String({ maxLength: 10_000, default: '' }),
});

export function contactRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const BookQuery = Type.Object({ bookId: Type.Optional(Type.String({ format: 'uuid' })) });

  /** The address book a request targets: your default one, or a shared mailbox's (?bookId=). */
  const book = async (req: { principal: { user: { id: string } } | null; query: unknown }, need: 'read' | 'write' = 'read') => {
    const books = await accessibleAddressBooks(db, req.principal!.user.id);
    const bookId = (req.query as { bookId?: string }).bookId;
    const b = bookId ? books.find((x) => x.id === bookId) : books.find((x) => x.access === 'owner' && x.isDefault);
    if (!b) throw notFound('Address book');
    if (need === 'write' && b.access === 'read') throw forbidden('You have read-only access to this address book');
    return b;
  };

  /** Owners share their books; full-access members share a shared mailbox's books. */
  const requireBookManage = async (userId: string, bookId: string) => {
    const [b] = await db.select().from(addressBooks).where(eq(addressBooks.id, bookId)).limit(1);
    if (!b) throw notFound('Address book');
    if (b.userId === userId || (await delegatedMailboxes(db, userId)).some((d) => d.ownerId === b.userId && d.access === 'full')) return b;
    throw forbidden('Only the owner can share this address book');
  };

  app.get('/api/v1/contacts/books/:id/shares', { schema: { tags: ['contacts'], summary: 'Who an address book is shared with', params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } }, async (req) => {
    const b = await requireBookManage(req.principal!.user.id, req.params.id);
    return { items: await withPrincipalNames(await db.select().from(addressBookShares).where(eq(addressBookShares.addressBookId, b.id))) };
  });

  app.put(
    '/api/v1/contacts/books/:id/shares',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Share a single address book (read or write)',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object({
          grants: Type.Array(
            Type.Object({ principalType: Type.Union([Type.Literal('user'), Type.Literal('group')]), principalId: Type.String({ format: 'uuid' }), access: Type.Union([Type.Literal('read'), Type.Literal('write')]) }),
            { maxItems: 200 },
          ),
        }),
      },
    },
    async (req) => {
      const b = await requireBookManage(req.principal!.user.id, req.params.id);
      await assertPrincipals(req.body.grants, b.userId);
      await db.transaction(async (tx) => {
        await tx.delete(addressBookShares).where(eq(addressBookShares.addressBookId, b.id));
        if (req.body.grants.length) await tx.insert(addressBookShares).values(req.body.grants.map((g) => ({ ...g, addressBookId: b.id })));
      });
      await ctx.audit.fromRequest(req, { action: 'contacts.book_shared', targetType: 'address_book', targetId: b.id, targetLabel: b.name, metadata: { grants: req.body.grants.map((g) => `${g.principalType}:${g.principalId}:${g.access}`) } });
      return { items: await withPrincipalNames(await db.select().from(addressBookShares).where(eq(addressBookShares.addressBookId, b.id))) };
    },
  );

  app.get('/api/v1/contacts/books', { schema: { tags: ['contacts'], summary: 'Your address books and those of shared mailboxes you can open' } }, async (req) => ({
    items: await Promise.all(
      (await accessibleAddressBooks(db, req.principal!.user.id)).map(async (b) => ({
        id: b.id,
        name: b.ownerName ? `${b.ownerName}` : b.name,
        access: b.access,
        shared: !!b.ownerName,
        isDefault: b.isDefault,
        canShare: b.userId === req.principal!.user.id || (await delegatedMailboxes(db, req.principal!.user.id)).some((d) => d.ownerId === b.userId && d.access === 'full'),
      })),
    ),
  }));

  const serialize = (c: typeof contacts.$inferSelect) => ({ id: c.id, ...parseVCard(c.vcard), updatedAt: c.updatedAt.toISOString() });

  app.get(
    '/api/v1/contacts',
    { schema: { tags: ['contacts'], summary: 'Contacts in an address book', querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 200 })), bookId: Type.Optional(Type.String({ format: 'uuid' })) }) } },
    async (req) => {
      const b = await book(req);
      const term = req.query.q?.trim() ? `%${req.query.q.trim()}%` : null;
      const rows = await db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.addressBookId, b.id),
            isNull(contacts.deletedAt),
            term ? or(ilike(contacts.fullName, term), ilike(contacts.organization, term), sql`${contacts.emails}::text ilike ${term}`) : undefined,
          ),
        )
        .orderBy(asc(contacts.fullName))
        .limit(1000);
      return { items: rows.map(serialize) };
    },
  );

  app.post('/api/v1/contacts', { schema: { tags: ['contacts'], summary: 'Add a contact', body: ContactBody, querystring: BookQuery } }, async (req, reply) => {
    const b = await book(req, 'write');
    const uid = randomUUID();
    const { contact } = await putContact(db, b.id, `${uid}.vcf`, buildVCard({ ...(req.body as Static<typeof ContactBody>), uid }), { ifNoneMatch: '*' });
    reply.code(201);
    return { contact: serialize(contact) };
  });

  app.put('/api/v1/contacts/:id', { schema: { tags: ['contacts'], summary: 'Update a contact', params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: ContactBody, querystring: BookQuery } }, async (req) => {
    const b = await book(req, 'write');
    const [existing] = await db.select().from(contacts).where(and(eq(contacts.id, req.params.id), eq(contacts.addressBookId, b.id), isNull(contacts.deletedAt))).limit(1);
    if (!existing) throw notFound('Contact');
    const { contact } = await putContact(db, b.id, existing.href, buildVCard({ ...(req.body as Static<typeof ContactBody>), uid: existing.uid }));
    return { contact: serialize(contact) };
  });

  app.delete('/api/v1/contacts/:id', { schema: { tags: ['contacts'], summary: 'Delete a contact', params: Type.Object({ id: Type.String({ format: 'uuid' }) }), querystring: BookQuery } }, async (req) => {
    const b = await book(req, 'write');
    const [existing] = await db.select().from(contacts).where(and(eq(contacts.id, req.params.id), eq(contacts.addressBookId, b.id))).limit(1);
    if (!existing) throw notFound('Contact');
    await deleteContact(db, b.id, existing.href);
    return { ok: true };
  });

  /** Global Address List: every active person, mail-enabled group and room. */
  app.get(
    '/api/v1/directory/gal',
    {
      schema: {
        tags: ['directory'],
        summary: 'Global Address List',
        querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 200 })), limit: Type.Integer({ minimum: 1, maximum: 1000, default: 200 }), offset: Type.Integer({ minimum: 0, default: 0 }) }),
      },
    },
    async (req) => {
      const orgId = req.principal!.orgId;
      const term = req.query.q?.trim() ? `%${req.query.q.trim()}%` : null;
      const [people, lists, rooms] = await Promise.all([
        db
          .select({ id: users.id, name: users.displayName, email: users.email, jobTitle: users.jobTitle, department: users.department, kind: users.kind })
          .from(users)
          .where(and(eq(users.orgId, orgId), eq(users.status, 'active'), term ? or(ilike(users.displayName, term), ilike(users.email, term), ilike(users.department, term)) : undefined))
          .orderBy(asc(users.displayName)),
        db
          .select({ id: groups.id, name: groups.name, email: groups.email, description: groups.description })
          .from(groups)
          .where(and(eq(groups.orgId, orgId), sql`${groups.email} is not null`, term ? or(ilike(groups.name, term), ilike(groups.email, term)) : undefined))
          .orderBy(asc(groups.name)),
        db
          .select({ id: resources.id, name: resources.name, email: resources.email, location: resources.location, capacity: resources.capacity })
          .from(resources)
          .where(and(eq(resources.orgId, orgId), term ? or(ilike(resources.name, term), ilike(resources.email, term)) : undefined))
          .orderBy(asc(resources.name)),
      ]);
      const entries = [
        ...people.map((p) => ({
          kind: p.kind === 'shared' ? ('shared' as const) : ('person' as const),
          id: p.id,
          name: p.name,
          email: p.email,
          detail: p.kind === 'shared' ? 'Shared mailbox' : [p.jobTitle, p.department].filter(Boolean).join(' · '),
        })),
        ...lists.map((g) => ({ kind: 'group' as const, id: g.id, name: g.name, email: g.email!, detail: g.description })),
        ...rooms.map((r) => ({ kind: 'room' as const, id: r.id, name: r.name, email: r.email, detail: [r.location, r.capacity ? `${r.capacity} people` : ''].filter(Boolean).join(' · ') })),
      ];
      return { total: entries.length, items: entries.slice(req.query.offset, req.query.offset + req.query.limit) };
    },
  );
}
