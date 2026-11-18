import { Type, type Static } from 'typebox';
import { simpleParser } from 'mailparser';
import {
  autoReplies,
  contacts,
  addressBooks,
  groups,
  folderPermissions,
  mailFilters,
  mailUploads,
  mailboxes,
  messages,
  orm,
  organizations,
  outboundMessages,
  users,
  type MailAddress,
  type Message,
} from '@forge/db';
import {
  cancelOutbound,
  composeMessage,
  createMailbox,
  decodePartBody,
  deleteMailbox,
  ensureMailboxes,
  expungeMessages,
  findPart,
  isValidAddress,
  moveMessages,
  QuotaExceededError,
  readRaw,
  releaseBlob,
  renameMailbox,
  retainBlob,
  sanitizeEmailHtml,
  sendableAddresses,
  setFlags,
  specialMailbox,
  submitMessage,
  appendMessage,
  accessibleMailboxes,
  canDelete,
  canManage,
  canRead,
  canWrite,
  folderScope,
  sharedFolderOwners,
  type FolderScope,
  type MailAccess,
  notifyMailChanged,
  mailboxAccess,
  onBehalfAddresses,
  sharedOwnerByAddress,
  type ComposeAttachment,
} from '@forge/mail';
import type { AppContext } from '../context';
import { assertPrincipals, withPrincipalNames } from '../services/sharing';
import { SenderListBody, addSenderEntries, listSenderEntries, removeSenderEntries } from '../services/sender-lists';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import type { App } from '../types';

const { and, asc, desc, eq, ilike, inArray, isNull, lt, ne, or, sql } = orm;

const Address = Type.Object({ name: Type.Optional(Type.String({ maxLength: 200 })), address: Type.String({ maxLength: 320 }) });
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const Compose = Type.Object({
  from: Type.Optional(Type.String({ maxLength: 320 })),
  to: Type.Array(Address, { maxItems: 500, default: [] }),
  cc: Type.Array(Address, { maxItems: 500, default: [] }),
  bcc: Type.Array(Address, { maxItems: 500, default: [] }),
  subject: Type.String({ maxLength: 998, default: '' }),
  html: Type.String({ maxLength: 5_000_000, default: '' }),
  attachmentIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100, default: [] }),
  replyToMessageId: Type.Optional(Type.String({ format: 'uuid' })),
  forwardMessageId: Type.Optional(Type.String({ format: 'uuid' })),
  draftId: Type.Optional(Type.String({ format: 'uuid' })),
});

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function textToHtml(text: string) {
  return `<div style="white-space:pre-wrap;font-family:inherit">${escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</div>`;
}

export function serializeMessageSummary(m: Message) {
  return {
    id: m.id,
    mailboxId: m.mailboxId,
    threadId: m.threadId,
    uid: m.uid,
    subject: m.subject,
    from: m.fromAddr,
    to: m.toAddrs,
    cc: m.ccAddrs,
    bcc: m.bccAddrs,
    replyTo: m.replyTo,
    date: (m.sentAt ?? m.internalDate).toISOString(),
    receivedAt: m.internalDate.toISOString(),
    snippet: m.snippet,
    seen: m.seen,
    flagged: m.flagged,
    answered: m.answered,
    draft: m.draft,
    keywords: m.keywords,
    size: m.size,
    hasAttachments: m.hasAttachments,
    attachments: m.attachments.filter((a) => !a.inline),
    messageId: m.messageId,
    spamScore: m.spamScore,
  };
}

export function mailRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  const mail = ctx.mail;
  app.addHook('preHandler', authenticate(ctx));

  app.addContentTypeParser(['application/octet-stream'], { parseAs: 'buffer', bodyLimit: 40 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  const userId = (req: { principal: { user: { id: string } } | null }) => req.principal!.user.id;

  /**
   * The mailbox a request acts on: the caller's own, or a shared/delegated
   * mailbox named in the X-Forge-Mailbox header that they have rights on.
   */
  const account = async (req: { principal: { user: { id: string } } | null; headers: Record<string, unknown> }, need: 'read' | 'full'): Promise<string> => {
    const me = userId(req);
    const target = req.headers['x-forge-mailbox'];
    if (!target || target === me) return me;
    if (typeof target !== 'string' || !/^[0-9a-f-]{36}$/i.test(target)) throw badRequest('Invalid X-Forge-Mailbox header');
    const { access } = await mailboxAccess(mail, me, target);
    if (!canRead(access)) throw notFound('Mailbox');
    if (need === 'full' && !canManage(access)) throw forbidden('You have read-only access to this mailbox');
    return target;
  };

  /** Per-folder access to the selected account (whole-mailbox grants plus individually shared folders). */
  const scope = async (req: { principal: { user: { id: string } } | null; headers: Record<string, unknown> }): Promise<FolderScope> => {
    const me = userId(req);
    const target = req.headers['x-forge-mailbox'];
    const ownerId = !target || target === me ? me : String(target);
    if (!/^[0-9a-f-]{36}$/i.test(ownerId)) throw badRequest('Invalid X-Forge-Mailbox header');
    const fs = await folderScope(mail, me, ownerId);
    if (!fs.folders.size) throw notFound('Mailbox');
    return fs;
  };
  const need = (fs: FolderScope, mailboxId: string, level: 'read' | 'write' | 'delete'): MailAccess => {
    const a = fs.folders.get(mailboxId) ?? 'none';
    if (!canRead(a)) throw notFound('Folder');
    if (level === 'write' && !canWrite(a)) throw forbidden('You have read-only access to this folder');
    if (level === 'delete' && !canDelete(a)) throw forbidden('You cannot delete messages in this folder');
    return a;
  };
  const loadReadable = async (fs: FolderScope, id: string) => {
    const m = await loadMessage(fs.ownerId, id);
    if (!canRead(fs.folders.get(m.mailboxId) ?? 'none')) throw notFound('Message');
    return m;
  };

  const loadMessage = async (uid: string, id: string) => {
    const [m] = await db.select().from(messages).where(and(eq(messages.id, id), eq(messages.userId, uid))).limit(1);
    if (!m) throw notFound('Message');
    return m;
  };

  const mapQuota = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof QuotaExceededError) throw new HttpError(507, 'Your mailbox is full. Delete some messages and try again.', 'quota_exceeded');
      throw err;
    }
  };

  app.get('/api/v1/mail/accounts', { schema: { tags: ['mail'], summary: 'Your mailbox plus shared mailboxes you can open' } }, async (req) => {
    const me = req.principal!.user;
    const grants = await accessibleMailboxes(mail, me.id);
    return {
      items: [
        { id: me.id, name: me.displayName, address: me.email, access: 'owner', sendAs: true, sendOnBehalf: false, shared: false },
        ...grants.filter((g) => g.access !== 'none').map((g) => ({ id: g.ownerId, name: g.name, address: g.address, access: g.access, sendAs: g.sendAs, sendOnBehalf: g.sendOnBehalf, shared: true })),
        // Accounts that shared only some folders with you.
        ...(await sharedFolderOwners(mail, me.id))
          .filter((o) => !grants.some((g) => g.ownerId === o.ownerId && g.access !== 'none'))
          .map((o) => {
            const g = grants.find((x) => x.ownerId === o.ownerId);
            return { id: o.ownerId, name: o.name, address: o.address, access: 'folders', sendAs: g?.sendAs ?? false, sendOnBehalf: g?.sendOnBehalf ?? false, shared: true };
          }),
      ],
    };
  });

  // -------------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------------

  app.get('/api/v1/mail/mailboxes', { schema: { tags: ['mail'], summary: 'Folders with message and unread counts' } }, async (req) => {
    const fs = await scope(req);
    const uid = fs.ownerId;
    const boxes = (await ensureMailboxes(mail, uid)).filter((b) => fs.folders.has(b.id));
    const counts = await db
      .select({ mailboxId: messages.mailboxId, total: sql<number>`count(*)::int`, unread: sql<number>`count(*) filter (where not ${messages.seen})::int` })
      .from(messages)
      .where(eq(messages.userId, uid))
      .groupBy(messages.mailboxId);
    const order = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];
    return {
      items: boxes
        .map((b) => {
          const c = counts.find((x) => x.mailboxId === b.id);
          return {
            id: b.id,
            path: b.path,
            name: b.specialUse === '\\Inbox' ? 'Inbox' : (b.path.split('/').at(-1) ?? b.path),
            specialUse: b.specialUse,
            access: fs.folders.get(b.id),
            total: c?.total ?? 0,
            unread: c?.unread ?? 0,
          };
        })
        .sort((a, b) => {
          const ai = a.specialUse ? order.indexOf(a.specialUse) : 99;
          const bi = b.specialUse ? order.indexOf(b.specialUse) : 99;
          return ai - bi || a.path.localeCompare(b.path);
        }),
    };
  });

  app.post(
    '/api/v1/mail/mailboxes',
    { schema: { tags: ['mail'], summary: 'Create a folder', body: Type.Object({ path: Type.String({ minLength: 1, maxLength: 200 }) }) } },
    async (req, reply) => {
      try {
        const box = await createMailbox(mail, await account(req, 'full'), req.body.path);
        reply.code(201);
        return { mailbox: { id: box.id, path: box.path } };
      } catch (err) {
        throw conflict((err as Error).message.includes('unique') || (err as Error).message.includes('duplicate') ? 'A folder with that name already exists' : (err as Error).message);
      }
    },
  );

  app.patch(
    '/api/v1/mail/mailboxes/:id',
    { schema: { tags: ['mail'], summary: 'Rename a folder', params: IdParams, body: Type.Object({ path: Type.String({ minLength: 1, maxLength: 200 }) }) } },
    async (req) => {
      try {
        await renameMailbox(mail, await account(req, 'full'), req.params.id, req.body.path);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
      return { ok: true };
    },
  );

  app.delete('/api/v1/mail/mailboxes/:id', { schema: { tags: ['mail'], summary: 'Delete a folder and its messages', params: IdParams } }, async (req) => {
    try {
      await deleteMailbox(mail, await account(req, 'full'), req.params.id);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    return { ok: true };
  });

  /** Who a single folder is shared with. Requires whole-mailbox rights (your own, or full access). */
  app.get('/api/v1/mail/mailboxes/:id/shares', { schema: { tags: ['mail'], summary: 'Who a folder is shared with', params: IdParams } }, async (req) => {
    const owner = await account(req, 'full');
    const [box] = await db.select().from(mailboxes).where(and(eq(mailboxes.id, req.params.id), eq(mailboxes.userId, owner))).limit(1);
    if (!box) throw notFound('Folder');
    const rows = await db.select().from(folderPermissions).where(eq(folderPermissions.mailboxId, box.id));
    return { items: await withPrincipalNames(rows) };
  });

  app.put(
    '/api/v1/mail/mailboxes/:id/shares',
    {
      schema: {
        tags: ['mail'],
        summary: 'Share a single folder: read (view), write (view, flag, file in/out) or full (also delete)',
        params: IdParams,
        body: Type.Object({
          grants: Type.Array(
            Type.Object({ principalType: Type.Union([Type.Literal('user'), Type.Literal('group')]), principalId: Type.String({ format: 'uuid' }), access: Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('full')]) }),
            { maxItems: 200 },
          ),
        }),
      },
    },
    async (req) => {
      const owner = await account(req, 'full');
      const [box] = await db.select().from(mailboxes).where(and(eq(mailboxes.id, req.params.id), eq(mailboxes.userId, owner))).limit(1);
      if (!box) throw notFound('Folder');
      await assertPrincipals(req.body.grants, owner);
      await db.transaction(async (tx) => {
        await tx.delete(folderPermissions).where(eq(folderPermissions.mailboxId, box.id));
        if (req.body.grants.length) await tx.insert(folderPermissions).values(req.body.grants.map((g) => ({ ...g, mailboxId: box.id, ownerId: owner })));
      });
      await ctx.audit.fromRequest(req, {
        action: 'mail.folder_shared',
        targetType: 'mailbox',
        targetId: box.id,
        targetLabel: box.path,
        metadata: { owner, grants: req.body.grants.map((g) => `${g.principalType}:${g.principalId}:${g.access}`) },
      });
      notifyMailChanged(mail, owner);
      return { items: await withPrincipalNames(await db.select().from(folderPermissions).where(eq(folderPermissions.mailboxId, box.id))) };
    },
  );

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  app.get(
    '/api/v1/mail/threads',
    {
      schema: {
        tags: ['mail'],
        summary: 'Conversations in a folder, or full-text search across folders',
        querystring: Type.Object({
          mailboxId: Type.Optional(Type.String({ format: 'uuid' })),
          q: Type.Optional(Type.String({ maxLength: 500 })),
          unread: Type.Optional(Type.Boolean()),
          before: Type.Optional(Type.String({ format: 'date-time' })),
          limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
        }),
      },
    },
    async (req) => {
      const fs = await scope(req);
      const uid = fs.ownerId;
      const { mailboxId, q, unread, before, limit } = req.query;
      if (mailboxId) need(fs, mailboxId, 'read');
      const boxes = await ensureMailboxes(mail, uid);
      // Search covers every readable folder except Trash and Junk.
      const searchable = boxes.filter((b) => fs.folders.has(b.id) && b.specialUse !== '\\Trash' && b.specialUse !== '\\Junk').map((b) => b.id);
      const folderFilter = mailboxId ? eq(messages.mailboxId, mailboxId) : searchable.length ? inArray(messages.mailboxId, searchable) : sql`false`;
      const search = q?.trim()
        ? or(sql`${messages.searchVector} @@ websearch_to_tsquery('simple', ${q.trim()})`, ilike(messages.searchAddresses, `%${q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`))
        : undefined;
      const where = and(eq(messages.userId, uid), folderFilter, search, unread ? eq(messages.seen, false) : undefined);
      const lastAt = sql<Date>`max(${messages.internalDate})`;
      const groupsRows = await db
        .select({
          threadId: messages.threadId,
          last: lastAt,
          count: sql<number>`count(*)::int`,
          unread: sql<number>`count(*) filter (where not ${messages.seen})::int`,
          flagged: sql<boolean>`bool_or(${messages.flagged})`,
          attachments: sql<boolean>`bool_or(${messages.hasAttachments})`,
          ids: sql<string[]>`array_agg(${messages.id} order by ${messages.internalDate})`,
        })
        .from(messages)
        .where(where)
        .groupBy(messages.threadId)
        .having(before ? lt(lastAt, new Date(before)) : undefined)
        .orderBy(desc(lastAt))
        .limit(limit + 1);
      const more = groupsRows.length > limit;
      const page = groupsRows.slice(0, limit);
      const latestIds = page.map((g) => g.ids.at(-1)!);
      const latest = latestIds.length ? await db.select().from(messages).where(inArray(messages.id, latestIds)) : [];
      const participants = page.length
        ? await db
            .select({ threadId: messages.threadId, from: messages.fromAddr })
            .from(messages)
            .where(and(eq(messages.userId, uid), inArray(messages.mailboxId, [...fs.folders.keys()]), inArray(messages.threadId, page.map((g) => g.threadId))))
        : [];
      return {
        items: page.map((g) => {
          const m = latest.find((l) => l.id === g.ids.at(-1))!;
          const names = [...new Map(participants.filter((p) => p.threadId === g.threadId && p.from).map((p) => [p.from!.address, p.from!.name || p.from!.address])).values()];
          return {
            threadId: g.threadId,
            messageIds: g.ids,
            count: g.count,
            unread: g.unread,
            flagged: g.flagged,
            hasAttachments: g.attachments,
            lastDate: new Date(g.last).toISOString(),
            participants: names,
            latest: serializeMessageSummary(m),
          };
        }),
        nextCursor: more ? new Date(page.at(-1)!.last).toISOString() : null,
      };
    },
  );

  /** Parse a stored message for display: sanitized HTML with inline images. */
  const renderBody = async (m: Message, allowRemoteImages: boolean) => {
    const raw = await readRaw(mail, m);
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextLinks: true });
    const inlineImages: Record<string, string> = {};
    for (const a of parsed.attachments) {
      if (a.cid && a.size < 3 * 1024 * 1024 && a.contentType.startsWith('image/')) inlineImages[a.cid] = `data:${a.contentType};base64,${a.content.toString('base64')}`;
    }
    const sourceHtml = typeof parsed.html === 'string' && parsed.html ? parsed.html : textToHtml(parsed.text ?? '');
    const { html, blockedImages } = sanitizeEmailHtml(sourceHtml, { inlineImages, allowRemoteImages });
    return { html, text: parsed.text ?? '', blockedImages };
  };

  app.get(
    '/api/v1/mail/threads/:threadId',
    {
      schema: {
        tags: ['mail'],
        summary: 'All messages in a conversation, with rendered bodies',
        params: Type.Object({ threadId: Type.String({ format: 'uuid' }) }),
        querystring: Type.Object({ remoteImages: Type.Optional(Type.Boolean()) }),
      },
    },
    async (req) => {
      const fs = await scope(req);
      const rows = await db
        .select()
        .from(messages)
        .where(and(eq(messages.userId, fs.ownerId), eq(messages.threadId, req.params.threadId), inArray(messages.mailboxId, [...fs.folders.keys()])))
        .orderBy(asc(messages.internalDate));
      if (!rows.length) throw notFound('Conversation');
      const items = [];
      for (const m of rows) items.push({ ...serializeMessageSummary(m), body: await renderBody(m, !!req.query.remoteImages) });
      return { threadId: req.params.threadId, subject: rows[0]!.subject, messages: items };
    },
  );

  app.get(
    '/api/v1/mail/messages/:id/attachments/:part',
    { schema: { tags: ['mail'], summary: 'Download an attachment', params: Type.Object({ id: Type.String({ format: 'uuid' }), part: Type.String({ pattern: '^\\d+(\\.\\d+)*$' }) }) } },
    async (req, reply) => {
      const m = await loadReadable(await scope(req), req.params.id);
      const info = m.attachments.find((a) => a.partPath === req.params.part);
      const node = findPart(m.mimeTree, req.params.part.split('.').map(Number));
      if (!info || !node) throw notFound('Attachment');
      const raw = await readRaw(mail, m);
      const data = decodePartBody(raw.subarray(node.bodyStart, node.bodyEnd), node.encoding);
      reply
        .header('Content-Type', info.contentType.startsWith('text/') ? `${info.contentType}; charset=utf-8` : info.contentType)
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(info.filename)}`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox");
      return reply.send(data);
    },
  );

  app.get('/api/v1/mail/messages/:id/raw', { schema: { tags: ['mail'], summary: 'Download the original message (.eml)', params: IdParams } }, async (req, reply) => {
    const m = await loadReadable(await scope(req), req.params.id);
    reply.header('Content-Type', 'message/rfc822').header('Content-Disposition', `attachment; filename="message-${m.id.slice(0, 8)}.eml"`);
    return reply.send(await readRaw(mail, m));
  });

  app.post(
    '/api/v1/mail/messages/actions',
    {
      schema: {
        tags: ['mail'],
        summary: 'Bulk actions on messages',
        body: Type.Object({
          ids: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 5000 }),
          action: Type.Union(['read', 'unread', 'flag', 'unflag', 'move', 'archive', 'delete', 'junk', 'notJunk', 'restore'].map((a) => Type.Literal(a))),
          mailboxId: Type.Optional(Type.String({ format: 'uuid' })),
        }),
      },
    },
    async (req) => {
      const fs = await scope(req);
      const uid = fs.ownerId;
      const { ids, action, mailboxId } = req.body as { ids: string[]; action: string; mailboxId?: string };
      const owned = (await db.select({ id: messages.id, mailboxId: messages.mailboxId }).from(messages).where(and(eq(messages.userId, uid), inArray(messages.id, ids)))).filter((o) =>
        fs.folders.has(o.mailboxId),
      );
      const valid = owned.map((o) => o.id);
      if (!valid.length) throw notFound('Messages');
      const special = async (use: Parameters<typeof specialMailbox>[2]) => (await specialMailbox(mail, uid, use)).id;
      // Flagging and filing need "write" on the folder; moving also on the destination; deleting needs "full".
      const sources = [...new Set(owned.map((o) => o.mailboxId))];
      const requireAll = (level: 'write' | 'delete') => sources.forEach((b) => need(fs, b, level));
      const moveTo = async (target: string) => {
        requireAll('write');
        need(fs, target, 'write');
        await moveMessages(mail, uid, valid, target);
      };
      switch (action) {
        case 'read':
        case 'unread':
          requireAll('write');
          await setFlags(mail, uid, valid, { seen: action === 'read' });
          break;
        case 'flag':
        case 'unflag':
          requireAll('write');
          await setFlags(mail, uid, valid, { flagged: action === 'flag' });
          break;
        case 'move':
          if (!mailboxId) throw badRequest('mailboxId is required');
          await moveTo(mailboxId);
          break;
        case 'archive':
          await moveTo(await special('\\Archive'));
          break;
        case 'junk':
          await moveTo(await special('\\Junk'));
          break;
        case 'notJunk':
        case 'restore':
          await moveTo(await special('\\Inbox'));
          break;
        case 'delete': {
          requireAll('delete');
          const trash = await special('\\Trash');
          const canUseTrash = canWrite(fs.folders.get(trash) ?? 'none');
          const inTrash = owned.filter((o) => o.mailboxId === trash || !canUseTrash).map((o) => o.id);
          const elsewhere = owned.filter((o) => o.mailboxId !== trash && canUseTrash).map((o) => o.id);
          if (inTrash.length) await expungeMessages(mail, uid, inTrash);
          if (elsewhere.length) await moveMessages(mail, uid, elsewhere, trash);
          break;
        }
      }
      return { ok: true, count: valid.length };
    },
  );

  app.post('/api/v1/mail/mailboxes/:id/empty', { schema: { tags: ['mail'], summary: 'Permanently delete everything in a folder', params: IdParams } }, async (req) => {
    const fs = await scope(req);
    need(fs, req.params.id, 'delete');
    const uid = fs.ownerId;
    const ids = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.userId, uid), eq(messages.mailboxId, req.params.id)));
    await expungeMessages(mail, uid, ids.map((r) => r.id));
    return { ok: true, count: ids.length };
  });

  // -------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------

  app.post(
    '/api/v1/mail/uploads',
    {
      bodyLimit: 40 * 1024 * 1024,
      schema: { tags: ['mail'], summary: 'Upload a composer attachment (raw body, X-Filename header)', hide: false },
    },
    async (req, reply) => {
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Send the file as application/octet-stream');
      const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'attachment')).slice(0, 255) || 'attachment';
      const contentType = String(req.headers['x-content-type'] ?? 'application/octet-stream').slice(0, 200);
      const [org] = await db.select({ max: organizations.mailMaxMessageBytes }).from(organizations).limit(1);
      if (org && body.length > org.max * 0.73) throw badRequest('Attachment is too large to send by email');
      const { sha256, size } = await retainBlob(mail, body);
      const [row] = await db.insert(mailUploads).values({ userId: userId(req), blobSha: sha256, filename, contentType, size }).returning();
      reply.code(201);
      return { upload: { id: row!.id, filename, contentType, size } };
    },
  );

  const recipients = (list: { name?: string; address: string }[]): MailAddress[] =>
    list.map((a) => {
      const address = a.address.trim().toLowerCase();
      if (!isValidAddress(address)) throw badRequest(`"${a.address}" is not a valid email address`);
      return { name: (a.name ?? '').trim(), address };
    });

  /** Build MIME from composer input (shared by send and save-draft). */
  const buildFromInput = async (uid: string, owner: string, body: Static<typeof Compose>) => {
    const [me] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
    const allowed = await sendableAddresses(mail, uid);
    const behalf = await onBehalfAddresses(mail, uid);
    const fromAddress = (body.from ?? me!.email).toLowerCase();
    if (!allowed.includes(fromAddress) && !behalf.includes(fromAddress)) throw badRequest('You cannot send from that address');
    const shared = await sharedOwnerByAddress(mail, uid, fromAddress);
    const fromName =
      fromAddress === me!.email
        ? me!.displayName
        : (shared?.name ?? (await db.select({ name: groups.name }).from(groups).where(eq(groups.email, fromAddress)).limit(1))[0]?.name ?? '');
    // "Send on behalf": From is the shared mailbox, Sender is the person.
    const sender = behalf.includes(fromAddress) ? { name: me!.displayName, address: me!.email } : undefined;

    const attachments: ComposeAttachment[] = [];
    const uploads = body.attachmentIds.length
      ? await db.select().from(mailUploads).where(and(eq(mailUploads.userId, uid), inArray(mailUploads.id, body.attachmentIds)))
      : [];
    for (const u of uploads) attachments.push({ filename: u.filename, contentType: u.contentType, content: await mail.blobs.read(u.blobSha) });

    if (body.forwardMessageId) {
      const orig = await loadMessage(owner, body.forwardMessageId);
      const parsed = await simpleParser(await readRaw(mail, orig));
      for (const a of parsed.attachments) {
        attachments.push({ filename: a.filename ?? 'attachment', contentType: a.contentType, content: a.content, cid: a.cid, inline: a.contentDisposition === 'inline' });
      }
    }

    let inReplyTo: string | null = null;
    let references: string[] = [];
    if (body.replyToMessageId) {
      const orig = await loadMessage(owner, body.replyToMessageId);
      inReplyTo = orig.messageId;
      references = [...orig.references, ...(orig.messageId ? [orig.messageId] : [])].slice(-30);
    }
    const { raw, messageId } = await composeMessage({
      from: { name: fromName, address: fromAddress },
      sender,
      to: recipients(body.to),
      cc: recipients(body.cc),
      subject: body.subject,
      html: body.html || '<p></p>',
      attachments,
      inReplyTo,
      references,
    });
    return { raw, messageId, from: fromAddress, uploads, sentOwner: shared?.ownerId };
  };

  app.post(
    '/api/v1/mail/send',
    {
      bodyLimit: 6 * 1024 * 1024,
      schema: {
        tags: ['mail'],
        summary: 'Send a message (held for the undo window, or until sendAt)',
        body: Type.Intersect([Compose, Type.Object({ sendAt: Type.Optional(Type.String({ format: 'date-time' })) })]),
      },
    },
    async (req) => {
      const uid = userId(req);
      const fs = await scope(req);
      const owner = fs.ownerId;
      const body = req.body as Static<typeof Compose> & { sendAt?: string };
      // The message being answered or forwarded must be in a folder the sender can read.
      const original = body.replyToMessageId ? await loadReadable(fs, body.replyToMessageId) : body.forwardMessageId ? await loadReadable(fs, body.forwardMessageId) : null;
      const to = recipients(body.to);
      const cc = recipients(body.cc);
      const bcc = recipients(body.bcc);
      const all = [...to, ...cc, ...bcc];
      if (!all.length) throw badRequest('Add at least one recipient');
      const { raw, from, uploads, sentOwner } = await buildFromInput(uid, owner, body);
      const [org] = await db.select().from(organizations).limit(1);
      if (raw.length > (org?.mailMaxMessageBytes ?? 35 * 1024 * 1024)) throw badRequest('The message is too large');

      const sendAt = body.sendAt ? new Date(body.sendAt) : null;
      const delayMs = sendAt ? Math.max(0, sendAt.getTime() - Date.now()) : (org?.undoSendSeconds ?? 10) * 1000;
      const out = await mapQuota(() =>
        submitMessage(mail, { userId: uid, raw, envelopeFrom: from, recipients: all.map((a) => a.address), delayMs, saveToSent: { bcc, ownerId: sentOwner }, source: 'webmail' }),
      );

      // Flag changes on the original need write access to the mailbox it lives in.
      const originalWritable = !!original && canWrite(fs.folders.get(original.mailboxId) ?? 'none');
      if (originalWritable && body.replyToMessageId) await setFlags(mail, owner, [body.replyToMessageId], { answered: true });
      if (originalWritable && body.forwardMessageId) await setFlags(mail, owner, [body.forwardMessageId], { addKeywords: ['$Forwarded'] });
      if (body.draftId) {
        // The draft lives in the owner's Drafts (or the sender's own, if they cannot manage the owner's mailbox).
        const [draft] = await db.select({ id: messages.id, userId: messages.userId, mailboxId: messages.mailboxId }).from(messages).where(eq(messages.id, body.draftId)).limit(1);
        const draftAccess = draft ? (draft.userId === uid ? 'owner' : draft.userId === owner ? (fs.folders.get(draft.mailboxId) ?? 'none') : 'none') : 'none';
        if (draft && canDelete(draftAccess)) await expungeMessages(mail, draft.userId, [draft.id]);
      }
      for (const u of uploads) {
        await db.delete(mailUploads).where(eq(mailUploads.id, u.id));
        await releaseBlob(mail, u.blobSha);
      }
      return { outbound: { id: out.id, status: out.status, sendAt: out.sendAt.toISOString(), undoable: !sendAt }, sentMessageId: out.sentMessageId };
    },
  );

  app.post('/api/v1/mail/outbound/:id/cancel', { schema: { tags: ['mail'], summary: 'Undo send / cancel a scheduled message', params: IdParams } }, async (req) => {
    const result = await cancelOutbound(mail, userId(req), req.params.id);
    if (!result) throw conflict('Too late — the message has already been sent');
    return result;
  });

  app.get('/api/v1/mail/outbound', { schema: { tags: ['mail'], summary: 'Scheduled and recent outgoing messages' } }, async (req) => {
    const rows = await db
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.userId, userId(req)), ne(outboundMessages.source, 'system')))
      .orderBy(desc(outboundMessages.createdAt))
      .limit(100);
    return {
      items: rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        status: r.status,
        sendAt: r.sendAt.toISOString(),
        recipients: r.recipients,
        lastError: r.lastError,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.put(
    '/api/v1/mail/drafts',
    { bodyLimit: 6 * 1024 * 1024, schema: { tags: ['mail'], summary: 'Save a draft (replaces draftId if given)', body: Compose } },
    async (req) => {
      const me = userId(req);
      const fs = await scope(req);
      // Save into the selected mailbox's Drafts only with whole-mailbox rights; otherwise into your own.
      const uid = canManage(fs.mailbox) ? fs.ownerId : me;
      const body = req.body as Static<typeof Compose>;
      if (body.replyToMessageId) await loadReadable(fs, body.replyToMessageId);
      if (body.forwardMessageId) await loadReadable(fs, body.forwardMessageId);
      const { raw } = await buildFromInput(me, fs.ownerId, body);
      const drafts = await specialMailbox(mail, uid, '\\Drafts');
      const saved = await mapQuota(() => appendMessage(mail, { userId: uid, mailboxId: drafts.id, raw, seen: true, draft: true, bcc: recipients(body.bcc) }));
      if (body.draftId) {
        const [old] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, body.draftId), eq(messages.userId, uid))).limit(1);
        if (old) await expungeMessages(mail, uid, [old.id]);
      }
      return { draft: { id: saved.id } };
    },
  );

  app.get('/api/v1/mail/drafts/:id', { schema: { tags: ['mail'], summary: 'Load a draft for editing', params: IdParams } }, async (req) => {
    const uid = userId(req);
    const m = await loadReadable(await scope(req), req.params.id);
    const raw = await readRaw(mail, m);
    const parsed = await simpleParser(raw);
    const uploads = [];
    for (const a of parsed.attachments.filter((x) => x.contentDisposition !== 'inline')) {
      const { sha256, size } = await retainBlob(mail, a.content);
      const [row] = await db
        .insert(mailUploads)
        .values({ userId: uid, blobSha: sha256, filename: a.filename ?? 'attachment', contentType: a.contentType, size })
        .returning();
      uploads.push({ id: row!.id, filename: row!.filename, contentType: row!.contentType, size });
    }
    return {
      draft: {
        id: m.id,
        to: m.toAddrs,
        cc: m.ccAddrs,
        bcc: m.bccAddrs,
        subject: m.subject,
        html: typeof parsed.html === 'string' ? parsed.html : textToHtml(parsed.text ?? ''),
        attachments: uploads,
        inReplyTo: m.inReplyTo,
      },
    };
  });

  // -------------------------------------------------------------------------
  // Settings, rules, suggestions
  // -------------------------------------------------------------------------

  app.get('/api/v1/mail/settings', { schema: { tags: ['mail'], summary: 'Identities, auto-reply and connection settings' } }, async (req) => {
    const me = userId(req);
    const uid = await account(req, 'read');
    const [ar] = await db.select().from(autoReplies).where(eq(autoReplies.userId, uid)).limit(1);
    const [org] = await db.select().from(organizations).limit(1);
    const { config } = ctx;
    const ports = config.mail.ports;
    return {
      identities: await sendableAddresses(mail, me),
      onBehalfOf: await onBehalfAddresses(mail, me),
      undoSendSeconds: org?.undoSendSeconds ?? 10,
      maxMessageBytes: org?.mailMaxMessageBytes ?? 35 * 1024 * 1024,
      autoReply: ar
        ? { enabled: ar.enabled, subject: ar.subject, body: ar.body, startsAt: ar.startsAt?.toISOString() ?? null, endsAt: ar.endsAt?.toISOString() ?? null, internalOnly: ar.internalOnly }
        : { enabled: false, subject: 'Out of office', body: '', startsAt: null, endsAt: null, internalOnly: false },
      connection: {
        hostname: config.mail.hostname,
        imap: { port: config.mail.embed ? (ports.imap ?? 143) : 993, security: config.mail.embed ? 'STARTTLS' : 'SSL/TLS' },
        smtp: { port: config.mail.embed ? (ports.submission ?? 587) : 465, security: config.mail.embed ? 'STARTTLS' : 'SSL/TLS' },
        caldav: `${config.publicUrl}/dav/`,
        carddav: `${config.publicUrl}/dav/`,
      },
    };
  });

  app.put(
    '/api/v1/mail/auto-reply',
    {
      schema: {
        tags: ['mail'],
        summary: 'Configure the out-of-office auto-reply',
        body: Type.Object({
          enabled: Type.Boolean(),
          subject: Type.String({ maxLength: 500 }),
          body: Type.String({ maxLength: 20_000 }),
          startsAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
          endsAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
          internalOnly: Type.Boolean(),
        }),
      },
    },
    async (req) => {
      const uid = await account(req, 'full');
      const b = req.body;
      const values = { ...b, startsAt: b.startsAt ? new Date(b.startsAt) : null, endsAt: b.endsAt ? new Date(b.endsAt) : null };
      await db.insert(autoReplies).values({ userId: uid, ...values }).onConflictDoUpdate({ target: autoReplies.userId, set: values });
      await ctx.audit.fromRequest(req, { action: b.enabled ? 'mail.auto_reply_enabled' : 'mail.auto_reply_disabled', targetType: 'user', targetId: uid });
      return { ok: true };
    },
  );

  const Filter = Type.Object({
    name: Type.String({ minLength: 1, maxLength: 200 }),
    enabled: Type.Boolean({ default: true }),
    match: Type.Union([Type.Literal('all'), Type.Literal('any')], { default: 'all' }),
    conditions: Type.Array(
      Type.Object({
        field: Type.Union(['from', 'to', 'cc', 'subject', 'body', 'header', 'hasAttachment', 'size'].map((f) => Type.Literal(f))),
        op: Type.Union(['contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'matches', 'greaterThan', 'lessThan', 'isTrue'].map((f) => Type.Literal(f))),
        value: Type.Optional(Type.String({ maxLength: 1000 })),
        header: Type.Optional(Type.String({ maxLength: 200 })),
      }),
      { minItems: 1, maxItems: 20 },
    ),
    actions: Type.Array(
      Type.Object({ type: Type.Union(['move', 'markRead', 'flag', 'delete', 'forward', 'stop'].map((f) => Type.Literal(f))), value: Type.Optional(Type.String({ maxLength: 320 })) }),
      { minItems: 1, maxItems: 10 },
    ),
  });

  const checkFilter = async (uid: string, f: Static<typeof Filter>) => {
    for (const a of f.actions) {
      if (a.type === 'move') {
        const [box] = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.id, a.value ?? ''), eq(mailboxes.userId, uid))).limit(1);
        if (!box) throw badRequest('Choose a folder to move messages to');
      }
      if (a.type === 'forward' && !isValidAddress(a.value ?? '')) throw badRequest('Enter a valid forwarding address');
    }
    for (const c of f.conditions) if (c.op === 'matches') {
      try {
        new RegExp(c.value ?? '');
      } catch {
        throw badRequest(`Invalid pattern: ${c.value}`);
      }
    }
  };

  app.get('/api/v1/mail/filters', { schema: { tags: ['mail'], summary: 'Server-side rules' } }, async (req) => ({
    items: await db.select().from(mailFilters).where(eq(mailFilters.userId, await account(req, 'read'))).orderBy(asc(mailFilters.position)),
  }));

  app.post('/api/v1/mail/filters', { schema: { tags: ['mail'], summary: 'Create a rule', body: Filter } }, async (req, reply) => {
    const uid = await account(req, 'full');
    const f = req.body as Static<typeof Filter>;
    await checkFilter(uid, f);
    const [{ n }] = (await db.select({ n: sql<number>`coalesce(max(${mailFilters.position}), -1)::int + 1` }).from(mailFilters).where(eq(mailFilters.userId, uid))) as [{ n: number }];
    const [row] = await db.insert(mailFilters).values({ ...f, userId: uid, position: n } as typeof mailFilters.$inferInsert).returning();
    if (f.actions.some((a) => a.type === 'forward')) await ctx.audit.fromRequest(req, { action: 'mail.forwarding_rule_created', targetType: 'user', targetId: uid, metadata: { to: f.actions.filter((a) => a.type === 'forward').map((a) => a.value) } });
    reply.code(201);
    return { filter: row };
  });

  app.put('/api/v1/mail/filters/:id', { schema: { tags: ['mail'], summary: 'Replace a rule', params: IdParams, body: Filter } }, async (req) => {
    const uid = await account(req, 'full');
    const f = req.body as Static<typeof Filter>;
    await checkFilter(uid, f);
    const [row] = await db
      .update(mailFilters)
      .set(f as Partial<typeof mailFilters.$inferInsert>)
      .where(and(eq(mailFilters.id, req.params.id), eq(mailFilters.userId, uid)))
      .returning();
    if (!row) throw notFound('Rule');
    return { filter: row };
  });

  app.delete('/api/v1/mail/filters/:id', { schema: { tags: ['mail'], summary: 'Delete a rule', params: IdParams } }, async (req) => {
    await db.delete(mailFilters).where(and(eq(mailFilters.id, req.params.id), eq(mailFilters.userId, await account(req, 'full'))));
    return { ok: true };
  });

  app.post(
    '/api/v1/mail/filters/order',
    { schema: { tags: ['mail'], summary: 'Reorder rules', body: Type.Object({ ids: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 200 }) }) } },
    async (req) => {
      const uid = await account(req, 'full');
      for (const [i, id] of req.body.ids.entries()) await db.update(mailFilters).set({ position: i }).where(and(eq(mailFilters.id, id), eq(mailFilters.userId, uid)));
      return { ok: true };
    },
  );

  // Blocked & allowed senders for this mailbox (or a shared mailbox with full access).
  app.get('/api/v1/mail/sender-lists', { schema: { tags: ['mail'], summary: 'Blocked and allowed senders' } }, async (req) => ({
    items: await listSenderEntries(db, { orgId: req.principal!.orgId, userId: await account(req, 'read') }),
  }));

  app.post('/api/v1/mail/sender-lists', { schema: { tags: ['mail'], summary: 'Block or allow senders (addresses or domains)', body: SenderListBody } }, async (req, reply) => {
    const uid = await account(req, 'full');
    const items = await addSenderEntries(db, { orgId: req.principal!.orgId, userId: uid }, req.body, userId(req));
    reply.code(201);
    return { items };
  });

  app.post(
    '/api/v1/mail/sender-lists/remove',
    { schema: { tags: ['mail'], summary: 'Remove entries from the blocked / allowed senders', body: Type.Object({ ids: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 1000 }) }) } },
    async (req) => {
      const removed = await removeSenderEntries(db, { orgId: req.principal!.orgId, userId: await account(req, 'full') }, req.body.ids);
      return { removed: removed.length };
    },
  );

  app.get(
    '/api/v1/mail/suggest',
    { schema: { tags: ['mail'], summary: 'Recipient suggestions (directory, contacts, recent)', querystring: Type.Object({ q: Type.String({ minLength: 1, maxLength: 200 }) }) } },
    async (req) => {
      const uid = userId(req);
      const term = `%${req.query.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      const orgId = req.principal!.orgId;
      const [people, lists, personal, recent] = await Promise.all([
        db
          .select({ name: users.displayName, address: users.email })
          .from(users)
          .where(and(eq(users.orgId, orgId), eq(users.status, 'active'), or(ilike(users.displayName, term), ilike(users.email, term))))
          .limit(8),
        db
          .select({ name: groups.name, address: groups.email })
          .from(groups)
          .where(and(eq(groups.orgId, orgId), sql`${groups.email} is not null`, or(ilike(groups.name, term), ilike(groups.email, term))))
          .limit(5),
        db
          .select({ name: contacts.fullName, emails: contacts.emails })
          .from(contacts)
          .innerJoin(addressBooks, eq(addressBooks.id, contacts.addressBookId))
          .where(and(eq(addressBooks.userId, uid), isNull(contacts.deletedAt), or(ilike(contacts.fullName, term), sql`${contacts.emails}::text ilike ${term}`)))
          .limit(8),
        db
          .select({ to: messages.toAddrs })
          .from(messages)
          .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
          .where(and(eq(messages.userId, uid), eq(mailboxes.specialUse, '\\Sent'), ilike(messages.searchAddresses, term)))
          .orderBy(desc(messages.internalDate))
          .limit(20),
      ]);
      const out = new Map<string, { name: string; address: string; kind: string }>();
      const add = (name: string, address: string | null, kind: string) => {
        if (address && !out.has(address)) out.set(address, { name, address, kind });
      };
      people.forEach((p) => add(p.name, p.address, 'person'));
      lists.forEach((g) => add(g.name, g.address, 'group'));
      personal.forEach((c) => c.emails.forEach((e) => add(c.name, e, 'contact')));
      const needle = req.query.q.trim().toLowerCase();
      recent.flatMap((r) => r.to).filter((a) => `${a.name} ${a.address}`.toLowerCase().includes(needle)).forEach((a) => add(a.name, a.address, 'recent'));
      return { items: [...out.values()].slice(0, 12) };
    },
  );
}
