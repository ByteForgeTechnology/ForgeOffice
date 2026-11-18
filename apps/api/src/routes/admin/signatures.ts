import { Type, type Static } from 'typebox';
import { emailSignatures, groups, orm, signatureImages, users } from '@forge/db';
import { SIGNATURE_VARIABLES, renderSignature, sampleSignatureValues, sanitizeEmailHtml, signatureText, signatureValues, type SignatureValues } from '@forge/mail';
import type { AppContext } from '../../context';
import { badRequest, notFound } from '../../errors';
import { authenticate, requirePermission } from '../../plugins/auth';
import { decodeImageDataUrl, retainBlob } from '../../services/assets';
import { getPrimaryOrg } from '../../services/directory';
import type { App } from '../../types';

const { and, asc, desc, eq, inArray } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const SignatureBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  html: Type.String({ maxLength: 100_000 }),
  enabled: Type.Boolean({ default: true }),
  audience: Type.Union([Type.Literal('all'), Type.Literal('groups')], { default: 'all' }),
  groupIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100, default: [] }),
  useForNew: Type.Boolean({ default: true }),
  useForReplies: Type.Boolean({ default: true }),
  applyToApps: Type.Boolean({ default: false }),
});
type SignatureInput = Static<typeof SignatureBody>;

/** Public URL of a signature image: recipients' mail apps load it from here. */
export const signatureImageUrl = (ctx: AppContext, id: string) => `${ctx.config.publicUrl}/api/v1/signature-images/${id}`;

/** Organisation email signatures, designed by admins and applied to everyone (or chosen groups). */
export function adminSignatureRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  // Strip scripts and event handlers; keep {{variables}}, links and remote (logo) images.
  const sanitize = (html: string) => sanitizeEmailHtml(html, { allowRemoteImages: true }).html.replace(/ target="_blank" rel="noopener noreferrer nofollow"/g, '');

  const clean = async (orgId: string, b: SignatureInput) => {
    const html = sanitize(b.html);
    if (!html.replace(/<[^>]*>/g, '').trim() && !/<img/i.test(html)) throw badRequest('The signature is empty');
    const unknown = [...html.matchAll(/\{\{\s*([A-Za-z]+)\s*\}\}/g)].map((m) => m[1]!).filter((k) => !SIGNATURE_VARIABLES.some((v) => v.key === k));
    if (unknown.length) throw badRequest(`Unknown variable: {{${unknown[0]}}}`);
    if (b.audience === 'groups') {
      if (!b.groupIds.length) throw badRequest('Choose at least one group');
      const found = await db.select({ id: groups.id }).from(groups).where(and(eq(groups.orgId, orgId), inArray(groups.id, b.groupIds)));
      if (found.length !== new Set(b.groupIds).size) throw badRequest('One or more groups do not exist');
    }
    return { ...b, html, groupIds: b.audience === 'groups' ? b.groupIds : [] };
  };

  app.get('/api/v1/admin/signatures', { preHandler: requirePermission(ctx, 'system:read'), schema: { tags: ['admin: mail'], summary: 'Email signatures in priority order, and the variables they can use' } }, async (req) => ({
    items: await db.select().from(emailSignatures).where(eq(emailSignatures.orgId, req.principal!.orgId)).orderBy(asc(emailSignatures.priority), asc(emailSignatures.createdAt)),
    variables: SIGNATURE_VARIABLES,
  }));

  app.post('/api/v1/admin/signatures', { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Create a signature (added last)', body: SignatureBody } }, async (req, reply) => {
    const orgId = req.principal!.orgId;
    const body = await clean(orgId, req.body);
    const [last] = await db.select({ p: emailSignatures.priority }).from(emailSignatures).where(eq(emailSignatures.orgId, orgId)).orderBy(desc(emailSignatures.priority)).limit(1);
    const [row] = await db.insert(emailSignatures).values({ ...body, orgId, priority: (last?.p ?? -1) + 1 }).returning();
    await ctx.audit.fromRequest(req, { action: 'mail.signature_created', targetType: 'signature', targetId: row!.id, targetLabel: row!.name });
    reply.code(201);
    return { signature: row };
  });

  app.put('/api/v1/admin/signatures/:id', { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Update a signature', params: IdParams, body: SignatureBody } }, async (req) => {
    const orgId = req.principal!.orgId;
    const body = await clean(orgId, req.body);
    const [row] = await db.update(emailSignatures).set(body).where(and(eq(emailSignatures.id, req.params.id), eq(emailSignatures.orgId, orgId))).returning();
    if (!row) throw notFound('Signature');
    await ctx.audit.fromRequest(req, { action: 'mail.signature_updated', targetType: 'signature', targetId: row.id, targetLabel: row.name, metadata: { enabled: row.enabled, audience: row.audience, applyToApps: row.applyToApps } });
    return { signature: row };
  });

  app.delete('/api/v1/admin/signatures/:id', { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Delete a signature', params: IdParams } }, async (req) => {
    const [row] = await db.delete(emailSignatures).where(and(eq(emailSignatures.id, req.params.id), eq(emailSignatures.orgId, req.principal!.orgId))).returning();
    if (!row) throw notFound('Signature');
    await ctx.audit.fromRequest(req, { action: 'mail.signature_deleted', targetType: 'signature', targetId: row.id, targetLabel: row.name });
    return { ok: true };
  });

  app.post(
    '/api/v1/admin/signatures/order',
    { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: mail'], summary: 'Set signature priority (first match wins)', body: Type.Object({ ids: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 200 }) }) } },
    async (req) => {
      for (const [i, id] of req.body.ids.entries()) await db.update(emailSignatures).set({ priority: i }).where(and(eq(emailSignatures.id, id), eq(emailSignatures.orgId, req.principal!.orgId)));
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/admin/signatures/preview',
    {
      preHandler: requirePermission(ctx, 'system:read'),
      schema: { tags: ['admin: mail'], summary: 'Render a signature for a person (or sample details)', body: Type.Object({ html: Type.String({ maxLength: 100_000 }), userId: Type.Optional(Type.String({ format: 'uuid' })) }) },
    },
    async (req) => {
      const org = await getPrimaryOrg(db);
      let values: SignatureValues = { ...sampleSignatureValues(), company: org?.name ?? 'Acme Ltd' };
      if (req.body.userId) {
        const [u] = await db.select().from(users).where(and(eq(users.id, req.body.userId), eq(users.orgId, req.principal!.orgId))).limit(1);
        if (!u) throw notFound('User');
        values = signatureValues(u, org?.name ?? '');
      }
      const html = renderSignature(sanitize(req.body.html), values);
      return { html, text: signatureText(html) };
    },
  );

  app.get('/api/v1/admin/signatures/images', { preHandler: requirePermission(ctx, 'system:read'), schema: { tags: ['admin: mail'], summary: 'Uploaded signature images' } }, async (req) => {
    const rows = await db.select().from(signatureImages).where(eq(signatureImages.orgId, req.principal!.orgId)).orderBy(desc(signatureImages.createdAt));
    return { items: rows.map((r) => ({ id: r.id, name: r.name, url: signatureImageUrl(ctx, r.id), createdAt: r.createdAt })) };
  });

  app.post(
    '/api/v1/admin/signatures/images',
    {
      preHandler: requirePermission(ctx, 'org:manage'),
      bodyLimit: 1024 * 1024,
      schema: { tags: ['admin: mail'], summary: 'Upload a logo or icon (PNG, JPEG or WebP data URL, max 512 KB)', body: Type.Object({ dataUrl: Type.String({ maxLength: 1_000_000 }), name: Type.Optional(Type.String({ maxLength: 200 })) }) },
    },
    async (req, reply) => {
      const { mime, data } = decodeImageDataUrl(req.body.dataUrl);
      const sha = await retainBlob(db, ctx.assets, 'drive', data, mime);
      const [row] = await db.insert(signatureImages).values({ orgId: req.principal!.orgId, blobSha: sha, mime, name: req.body.name ?? '' }).returning();
      await ctx.audit.fromRequest(req, { action: 'mail.signature_image_uploaded', targetType: 'signature', targetId: row!.id, metadata: { bytes: data.length, name: row!.name } });
      reply.code(201);
      return { image: { id: row!.id, name: row!.name, url: signatureImageUrl(ctx, row!.id) } };
    },
  );
}

/** Signature images are public: they are shown in recipients' mail apps. */
export function signatureImageRoutes(app: App, ctx: AppContext) {
  app.get('/api/v1/signature-images/:id', { schema: { tags: ['public'], summary: 'A signature image', params: IdParams } }, async (req, reply) => {
    const [img] = await ctx.db.select().from(signatureImages).where(eq(signatureImages.id, req.params.id)).limit(1);
    if (!img) throw notFound('Image');
    reply.header('Content-Type', img.mime).header('Cache-Control', 'public, max-age=86400').header('X-Content-Type-Options', 'nosniff').header('Cross-Origin-Resource-Policy', 'cross-origin');
    return reply.send(ctx.assets.createReadStream(img.blobSha));
  });
}
