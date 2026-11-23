import { Type, type Static } from 'typebox';
import { auditLog, orm, type AuditEntry } from '@forge/db';
import type { AppContext } from '../../context';
import { authenticate, requirePermission } from '../../plugins/auth';
import type { App } from '../../types';

const { and, desc, eq, gte, ilike, like, lt, lte, or } = orm;

const Query = Type.Object({
  action: Type.Optional(Type.String({ maxLength: 100 })),
  actor: Type.Optional(Type.String({ maxLength: 320 })),
  target: Type.Optional(Type.String({ maxLength: 320 })),
  outcome: Type.Optional(Type.Union([Type.Literal('success'), Type.Literal('failure')])),
  from: Type.Optional(Type.String({ format: 'date-time' })),
  to: Type.Optional(Type.String({ format: 'date-time' })),
  before: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Integer({ minimum: 1, maximum: 500, default: 100 }),
});

function serialize(e: AuditEntry) {
  return { ...e, createdAt: e.createdAt.toISOString() };
}

function csvCell(v: unknown): string {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function adminAuditRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const where = (orgId: string, q: Static<typeof Query>) =>
    and(
      or(eq(auditLog.orgId, orgId), orm.isNull(auditLog.orgId)),
      q.action ? (q.action.endsWith('.') ? like(auditLog.action, `${q.action}%`) : eq(auditLog.action, q.action)) : undefined,
      q.actor ? ilike(auditLog.actorLabel, `%${q.actor}%`) : undefined,
      q.target ? ilike(auditLog.targetLabel, `%${q.target}%`) : undefined,
      q.outcome ? eq(auditLog.outcome, q.outcome) : undefined,
      q.from ? gte(auditLog.createdAt, new Date(q.from)) : undefined,
      q.to ? lte(auditLog.createdAt, new Date(q.to)) : undefined,
      q.before ? lt(auditLog.id, q.before) : undefined,
    );

  app.get(
    '/api/v1/admin/audit',
    { preHandler: requirePermission(ctx, 'audit:read'), schema: { tags: ['admin: audit'], summary: 'Query the audit log (newest first, cursor = `before`)', querystring: Query } },
    async (req) => {
      const rows = await db
        .select()
        .from(auditLog)
        .where(where(req.principal!.orgId, req.query))
        .orderBy(desc(auditLog.id))
        .limit(req.query.limit + 1);
      const more = rows.length > req.query.limit;
      const items = rows.slice(0, req.query.limit).map(serialize);
      return { items, nextCursor: more ? items.at(-1)!.id : null };
    },
  );

  app.get(
    '/api/v1/admin/audit/export.csv',
    { preHandler: requirePermission(ctx, 'audit:read'), schema: { tags: ['admin: audit'], summary: 'Export matching entries as CSV (max 50 000 rows)', querystring: Type.Omit(Query, ['limit', 'before']) } },
    async (req, reply) => {
      const rows = await db
        .select()
        .from(auditLog)
        .where(where(req.principal!.orgId, { ...req.query, limit: 50_000 }))
        .orderBy(desc(auditLog.id))
        .limit(50_000);
      const header = ['id', 'createdAt', 'action', 'outcome', 'actor', 'targetType', 'targetId', 'target', 'ip', 'userAgent', 'metadata'];
      const lines = rows.map((r) =>
        [r.id, r.createdAt.toISOString(), r.action, r.outcome, r.actorLabel, r.targetType, r.targetId, r.targetLabel, r.ip, r.userAgent, r.metadata].map(csvCell).join(','),
      );
      await ctx.audit.fromRequest(req, { action: 'audit.exported', metadata: { rows: rows.length, filters: req.query } });
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="forge-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
      return [header.join(','), ...lines].join('\r\n') + '\r\n';
    },
  );
}
