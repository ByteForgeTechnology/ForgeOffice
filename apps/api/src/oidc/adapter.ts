import { oidcPayloads, orm, userSessions, type Database } from '@forge/db';

const { and, eq, isNull, lt, or, gt } = orm;

type Payload = Record<string, unknown> & {
  grantId?: string;
  userCode?: string;
  uid?: string;
  accountId?: string;
  consumed?: number;
};

/**
 * oidc-provider persistence adapter backed by the `oidc_payloads` table.
 * One table holds every model type (Session, Grant, AccessToken, ...), keyed
 * by (id, type) with indexed lookup columns for grant/uid/user-code/account.
 */
export function createOidcAdapter(db: Database, opts: { findClient?: (clientId: string) => Promise<Record<string, unknown> | undefined> } = {}) {
  return class DrizzleOidcAdapter {
    constructor(private readonly type: string) {}

    async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
      const row = {
        id,
        type: this.type,
        payload,
        grantId: payload.grantId ?? null,
        userCode: payload.userCode ?? null,
        uid: payload.uid ?? null,
        accountId: payload.accountId ?? null,
        expiresAt,
      };
      await db
        .insert(oidcPayloads)
        .values(row)
        .onConflictDoUpdate({
          target: [oidcPayloads.id, oidcPayloads.type],
          set: { payload, grantId: row.grantId, userCode: row.userCode, uid: row.uid, accountId: row.accountId, expiresAt },
        });
    }

    private async findWhere(condition: orm.SQL | undefined): Promise<Payload | undefined> {
      const [row] = await db
        .select()
        .from(oidcPayloads)
        .where(and(eq(oidcPayloads.type, this.type), condition, or(isNull(oidcPayloads.expiresAt), gt(oidcPayloads.expiresAt, new Date()))))
        .limit(1);
      if (!row) return undefined;
      return {
        ...row.payload,
        ...(row.consumedAt ? { consumed: Math.floor(row.consumedAt.getTime() / 1000) } : {}),
      };
    }

    find(id: string) {
      // Registered applications live in their own table (managed in the admin center).
      if (this.type === 'Client') return opts.findClient ? opts.findClient(id) : Promise.resolve(undefined);
      return this.findWhere(eq(oidcPayloads.id, id));
    }

    findByUserCode(userCode: string) {
      return this.findWhere(eq(oidcPayloads.userCode, userCode));
    }

    findByUid(uid: string) {
      return this.findWhere(eq(oidcPayloads.uid, uid));
    }

    async consume(id: string): Promise<void> {
      await db
        .update(oidcPayloads)
        .set({ consumedAt: new Date() })
        .where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.type, this.type)));
    }

    async destroy(id: string): Promise<void> {
      await db.delete(oidcPayloads).where(and(eq(oidcPayloads.id, id), eq(oidcPayloads.type, this.type)));
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await db.delete(oidcPayloads).where(eq(oidcPayloads.grantId, grantId));
    }
  };
}

/** Remove every session, grant and token belonging to an account (e.g. on suspension). */
export async function revokeAccount(db: Database, accountId: string): Promise<void> {
  const grants = await db
    .select({ grantId: oidcPayloads.grantId })
    .from(oidcPayloads)
    .where(eq(oidcPayloads.accountId, accountId));
  await db.delete(oidcPayloads).where(eq(oidcPayloads.accountId, accountId));
  for (const { grantId } of grants) if (grantId) await db.delete(oidcPayloads).where(eq(oidcPayloads.grantId, grantId));
  // Access tokens already issued stop working at the API too.
  await db.update(userSessions).set({ revokedAt: new Date() }).where(and(eq(userSessions.userId, accountId), isNull(userSessions.revokedAt)));
}

export async function purgeExpiredOidc(db: Database): Promise<number> {
  const deleted = await db.delete(oidcPayloads).where(lt(oidcPayloads.expiresAt, new Date())).returning({ id: oidcPayloads.id });
  return deleted.length;
}
