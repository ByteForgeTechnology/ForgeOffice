import { Type, type Static } from 'typebox';
import { groups, orm, transportRuleHits, transportRules, type RuleAction, type RuleCondition, type TransportRule } from '@forge/db';
import { applyTransportRules, composeMessage, indexMessage, isValidAddress, type Direction } from '@forge/mail';
import type { AppContext } from '../../context';
import { badRequest, notFound } from '../../errors';
import { authenticate, requirePermission } from '../../plugins/auth';
import type { App } from '../../types';

const { and, asc, count, desc, eq, gt, inArray, sql } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const CONDITION_TYPES = [
  'senderAddress',
  'senderScope',
  'senderMemberOf',
  'recipientAddress',
  'recipientScope',
  'recipientMemberOf',
  'subjectContains',
  'subjectOrBodyContains',
  'headerContains',
  'hasAttachment',
  'attachmentExtension',
  'attachmentNameContains',
  'sizeOver',
  'spamScoreAbove',
] as const;
const ACTION_TYPES = ['prependSubject', 'setHeader', 'appendDisclaimer', 'bcc', 'redirect', 'junk', 'quarantine', 'reject', 'delete'] as const;

const Condition = Type.Object({
  type: Type.Unsafe<(typeof CONDITION_TYPES)[number]>(Type.String({ enum: [...CONDITION_TYPES] })),
  values: Type.Optional(Type.Array(Type.String({ maxLength: 320 }), { maxItems: 200 })),
  scope: Type.Optional(Type.Union([Type.Literal('internal'), Type.Literal('external')])),
  header: Type.Optional(Type.String({ maxLength: 76 })),
  number: Type.Optional(Type.Number({ minimum: 0 })),
});
const Action = Type.Object({
  type: Type.Unsafe<(typeof ACTION_TYPES)[number]>(Type.String({ enum: [...ACTION_TYPES] })),
  text: Type.Optional(Type.String({ maxLength: 10_000 })),
  html: Type.Optional(Type.String({ maxLength: 50_000 })),
  header: Type.Optional(Type.String({ maxLength: 76 })),
  addresses: Type.Optional(Type.Array(Type.String({ maxLength: 320 }), { maxItems: 50 })),
});
const RuleBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 2000, default: '' }),
  enabled: Type.Boolean({ default: true }),
  mode: Type.Union([Type.Literal('enforce'), Type.Literal('test')], { default: 'enforce' }),
  appliesTo: Type.Union([Type.Literal('all'), Type.Literal('inbound'), Type.Literal('outbound'), Type.Literal('internal')], { default: 'all' }),
  conditions: Type.Array(Condition, { maxItems: 30, default: [] }),
  exceptions: Type.Array(Condition, { maxItems: 30, default: [] }),
  actions: Type.Array(Action, { minItems: 1, maxItems: 20 }),
  stopProcessing: Type.Boolean({ default: false }),
});
type RuleInput = Static<typeof RuleBody>;

const HEADER_RE = /^X-[A-Za-z0-9-]{1,74}$/;

export function adminTransportRuleRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  /** Reject rules that could never work or would be unsafe (e.g. rewriting From:). */
  const validate = async (r: RuleInput) => {
    const groupIds = new Set<string>();
    const checkCondition = (c: RuleCondition, where: string) => {
      const needsValues = ['senderAddress', 'recipientAddress', 'senderMemberOf', 'recipientMemberOf', 'subjectContains', 'subjectOrBodyContains', 'attachmentExtension', 'attachmentNameContains'];
      if (needsValues.includes(c.type) && !(c.values ?? []).some((v) => v.trim())) throw badRequest(`${where}: add at least one value`);
      if ((c.type === 'senderScope' || c.type === 'recipientScope') && !c.scope) throw badRequest(`${where}: choose inside or outside the organisation`);
      if ((c.type === 'sizeOver' || c.type === 'spamScoreAbove') && c.number === undefined) throw badRequest(`${where}: enter a number`);
      if (c.type === 'headerContains' && !c.header?.trim()) throw badRequest(`${where}: enter a header name`);
      if (c.type === 'senderMemberOf' || c.type === 'recipientMemberOf') (c.values ?? []).forEach((v) => groupIds.add(v));
    };
    r.conditions.forEach((c) => checkCondition(c as RuleCondition, 'Condition'));
    r.exceptions.forEach((c) => checkCondition(c as RuleCondition, 'Exception'));
    if (groupIds.size) {
      const found = await db.select({ id: groups.id }).from(groups).where(inArray(groups.id, [...groupIds]));
      if (found.length !== groupIds.size) throw badRequest('One or more groups do not exist');
    }
    for (const a of r.actions as RuleAction[]) {
      if (a.type === 'setHeader' && !HEADER_RE.test(a.header ?? '')) throw badRequest('Only custom X- headers can be set');
      if (a.type === 'prependSubject' && !a.text?.trim()) throw badRequest('Enter the subject prefix');
      if (a.type === 'appendDisclaimer' && !a.text?.trim()) throw badRequest('Enter the disclaimer text');
      if ((a.type === 'bcc' || a.type === 'redirect') && (!a.addresses?.length || a.addresses.some((x) => !isValidAddress(x)))) throw badRequest('Enter valid email addresses');
      if (a.type === 'junk' && r.appliesTo !== 'inbound') throw badRequest('“Move to Junk” only applies to incoming mail');
    }
  };

  const serialize = (r: TransportRule, hits?: number) => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), ...(hits !== undefined ? { hits30d: hits } : {}) });

  app.get('/api/v1/admin/transport-rules', { preHandler: requirePermission(ctx, 'system:read'), schema: { tags: ['admin: mail'], summary: 'Transport (mail flow) rules in priority order' } }, async (req) => {
    const rules = await db.select().from(transportRules).where(eq(transportRules.orgId, req.principal!.orgId)).orderBy(asc(transportRules.priority), asc(transportRules.createdAt));
    const since = new Date(Date.now() - 30 * 86400_000);
    const counts = await db
      .select({ ruleId: transportRuleHits.ruleId, n: count() })
      .from(transportRuleHits)
      .where(gt(transportRuleHits.createdAt, since))
      .groupBy(transportRuleHits.ruleId);
    return { items: rules.map((r) => serialize(r, counts.find((c) => c.ruleId === r.id)?.n ?? 0)) };
  });

  app.post('/api/v1/admin/transport-rules', { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Create a rule (added last)', body: RuleBody } }, async (req, reply) => {
    const body = req.body as RuleInput;
    await validate(body);
    const [{ next }] = (await db
      .select({ next: sql<number>`coalesce(max(${transportRules.priority}), -1)::int + 1` })
      .from(transportRules)
      .where(eq(transportRules.orgId, req.principal!.orgId))) as [{ next: number }];
    const [row] = await db
      .insert(transportRules)
        .values({ ...(body as unknown as typeof transportRules.$inferInsert), orgId: req.principal!.orgId, priority: next })
      .returning();
    await ctx.audit.fromRequest(req, { action: 'mail.transport_rule_created', targetType: 'transport_rule', targetId: row!.id, targetLabel: row!.name, metadata: { rule: body } });
    reply.code(201);
    return { rule: serialize(row!) };
  });

  app.put('/api/v1/admin/transport-rules/:id', { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Replace a rule', params: IdParams, body: RuleBody } }, async (req) => {
    const body = req.body as RuleInput;
    await validate(body);
    const [before] = await db.select().from(transportRules).where(and(eq(transportRules.id, req.params.id), eq(transportRules.orgId, req.principal!.orgId)));
    if (!before) throw notFound('Rule');
    const [row] = await db.update(transportRules).set(body as unknown as Partial<TransportRule>).where(eq(transportRules.id, before.id)).returning();
    await ctx.audit.fromRequest(req, { action: 'mail.transport_rule_updated', targetType: 'transport_rule', targetId: before.id, targetLabel: row!.name, metadata: { before, after: body } });
    return { rule: serialize(row!) };
  });

  app.delete('/api/v1/admin/transport-rules/:id', { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Delete a rule', params: IdParams } }, async (req) => {
    const [row] = await db.delete(transportRules).where(and(eq(transportRules.id, req.params.id), eq(transportRules.orgId, req.principal!.orgId))).returning();
    if (!row) throw notFound('Rule');
    await ctx.audit.fromRequest(req, { action: 'mail.transport_rule_deleted', targetType: 'transport_rule', targetId: row.id, targetLabel: row.name, metadata: { rule: row } });
    return { ok: true };
  });

  app.post(
    '/api/v1/admin/transport-rules/order',
    { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Set rule priority order', body: Type.Object({ ids: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 500 }) }) } },
    async (req) => {
      for (const [i, id] of req.body.ids.entries()) await db.update(transportRules).set({ priority: i }).where(and(eq(transportRules.id, id), eq(transportRules.orgId, req.principal!.orgId)));
      await ctx.audit.fromRequest(req, { action: 'mail.transport_rules_reordered', metadata: { ids: req.body.ids } });
      return { ok: true };
    },
  );

  app.get('/api/v1/admin/transport-rules/:id/hits', { preHandler: requirePermission(ctx, 'system:read'), schema: { tags: ['admin: mail'], summary: 'Recent messages this rule matched (30 days)', params: IdParams } }, async (req) => ({
    items: (await db.select().from(transportRuleHits).where(eq(transportRuleHits.ruleId, req.params.id)).orderBy(desc(transportRuleHits.createdAt)).limit(200)).map((h) => ({
      ...h,
      createdAt: h.createdAt.toISOString(),
    })),
  }));

  app.post(
    '/api/v1/admin/transport-rules/test',
    {
      preHandler: requirePermission(ctx, 'system:read'),
      schema: {
        tags: ['admin: mail'],
        summary: 'Dry-run the rules against a sample message (nothing is sent or recorded)',
        body: Type.Object({
          direction: Type.Union([Type.Literal('inbound'), Type.Literal('outbound'), Type.Literal('internal')]),
          from: Type.String({ maxLength: 320 }),
          to: Type.Array(Type.String({ maxLength: 320 }), { minItems: 1, maxItems: 20 }),
          subject: Type.String({ maxLength: 998, default: '' }),
          body: Type.String({ maxLength: 50_000, default: '' }),
          attachmentNames: Type.Array(Type.String({ maxLength: 255 }), { maxItems: 10, default: [] }),
          spamScore: Type.Optional(Type.Number()),
          includeDisabled: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => {
      const b = req.body;
      if (!isValidAddress(b.from) || b.to.some((t) => !isValidAddress(t))) throw badRequest('Enter valid email addresses');
      const { raw } = await composeMessage({
        from: { name: '', address: b.from },
        to: b.to.map((address) => ({ name: '', address })),
        subject: b.subject,
        text: b.body,
        attachments: b.attachmentNames.map((filename) => ({ filename, contentType: 'application/octet-stream', content: Buffer.from('sample') })),
      });
      const rules = b.includeDisabled
        ? (await db.select().from(transportRules).where(eq(transportRules.orgId, req.principal!.orgId)).orderBy(asc(transportRules.priority))).map((r) => ({ ...r, enabled: true }))
        : undefined;
      const outcome = await applyTransportRules(
        ctx.mail,
        { direction: b.direction as Direction, envelopeFrom: b.from, recipients: b.to.map((t) => t.toLowerCase()), raw, idx: await indexMessage(raw), spamScore: b.spamScore },
        { dryRun: true, rules },
      );
      const after = outcome.raw !== raw ? await indexMessage(outcome.raw) : null;
      return {
        matched: outcome.matched,
        result: outcome.reject
          ? { verdict: 'rejected', message: outcome.reject }
          : outcome.drop
            ? { verdict: 'deleted' }
            : outcome.quarantine
              ? { verdict: 'quarantined', reason: outcome.quarantine }
              : { verdict: outcome.junk ? 'junk' : 'delivered', recipients: outcome.recipients, subject: after?.subject ?? b.subject, body: after?.bodyText ?? b.body },
      };
    },
  );
}
