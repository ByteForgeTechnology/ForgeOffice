import { Type } from 'typebox';
import type { AppContext } from '../../context';
import { authenticate, requirePermission } from '../../plugins/auth';
import { SenderListBody, addSenderEntries, listSenderEntries, removeSenderEntries } from '../../services/sender-lists';
import type { App } from '../../types';

/** Organisation-wide blocked & allowed senders. */
export function adminSenderListRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  app.get(
    '/api/v1/admin/sender-lists',
    { preHandler: requirePermission(ctx, 'system:read'), schema: { tags: ['admin: mail'], summary: 'Organisation blocked and allowed senders' } },
    async (req) => ({ items: await listSenderEntries(db, { orgId: req.principal!.orgId, userId: null }) }),
  );

  app.post(
    '/api/v1/admin/sender-lists',
    { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Block or allow senders for the whole organisation', body: SenderListBody } },
    async (req, reply) => {
      const items = await addSenderEntries(db, { orgId: req.principal!.orgId, userId: null }, req.body, req.principal!.user.id);
      await ctx.audit.fromRequest(req, {
        action: req.body.list === 'block' ? 'mail.senders_blocked' : 'mail.senders_allowed',
        targetType: 'organization',
        targetId: req.principal!.orgId,
        metadata: { entries: items.map((i) => i.entry), note: req.body.note ?? '' },
      });
      reply.code(201);
      return { items };
    },
  );

  app.post(
    '/api/v1/admin/sender-lists/remove',
    {
      preHandler: requirePermission(ctx, 'org:manage'),
      schema: { tags: ['admin: mail'], summary: 'Remove organisation sender list entries', body: Type.Object({ ids: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 1000 }) }) },
    },
    async (req) => {
      const removed = await removeSenderEntries(db, { orgId: req.principal!.orgId, userId: null }, req.body.ids);
      if (removed.length)
        await ctx.audit.fromRequest(req, { action: 'mail.sender_list_entries_removed', targetType: 'organization', targetId: req.principal!.orgId, metadata: { entries: removed.map((r) => `${r.list}: ${r.entry}`) } });
      return { removed: removed.length };
    },
  );
}
