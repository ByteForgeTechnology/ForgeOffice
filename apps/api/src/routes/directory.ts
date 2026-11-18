import { Type } from 'typebox';
import { groups, orm, users } from '@forge/db';
import type { AppContext } from '../context';
import { notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import { directoryCard } from '../services/directory';
import type { App } from '../types';

const { and, asc, eq, ilike, or } = orm;

/** Organisation directory available to every signed-in user (powers global search & people pickers). */
export function directoryRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  app.get(
    '/api/v1/directory/search',
    {
      schema: {
        tags: ['directory'],
        summary: 'Search people and groups',
        querystring: Type.Object({ q: Type.String({ minLength: 1, maxLength: 200 }), limit: Type.Integer({ minimum: 1, maximum: 50, default: 10 }) }),
      },
    },
    async (req) => {
      const orgId = req.principal!.orgId;
      const term = `%${req.query.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      const [people, teams] = await Promise.all([
        db
          .select()
          .from(users)
          .where(
            and(
              eq(users.orgId, orgId),
              eq(users.status, 'active'),
              or(ilike(users.displayName, term), ilike(users.email, term), ilike(users.department, term), ilike(users.jobTitle, term)),
            ),
          )
          .orderBy(asc(users.displayName))
          .limit(req.query.limit),
        db
          .select({ id: groups.id, name: groups.name, type: groups.type, email: groups.email, description: groups.description })
          .from(groups)
          .where(and(eq(groups.orgId, orgId), or(ilike(groups.name, term), ilike(groups.email, term))))
          .orderBy(asc(groups.name))
          .limit(req.query.limit),
      ]);
      return { people: people.map(directoryCard), groups: teams };
    },
  );

  app.get(
    '/api/v1/directory/users/:id',
    { schema: { tags: ['directory'], summary: 'Directory card for a person', params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } },
    async (req) => {
      const [u] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, req.params.id), eq(users.orgId, req.principal!.orgId), eq(users.status, 'active')))
        .limit(1);
      if (!u) throw notFound('Person');
      return { person: directoryCard(u) };
    },
  );
}
