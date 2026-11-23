import { groups, orm, users, type Database } from '@forge/db';
import { badRequest } from '../errors';

const { inArray } = orm;

export interface PrincipalRef {
  principalType: 'user' | 'group';
  principalId: string;
}

let dbRef: Database | null = null;
/** Set once at startup so route modules can share these helpers. */
export function initSharing(db: Database) {
  dbRef = db;
}

/** Shares may only name existing people or groups (not shared mailboxes, not the owner), each once. */
export async function assertPrincipals(grants: PrincipalRef[], ownerId: string): Promise<void> {
  const db = dbRef!;
  const keys = grants.map((g) => `${g.principalType}:${g.principalId}`);
  if (new Set(keys).size !== keys.length) throw badRequest('Each person or group can only be listed once');
  const userIds = grants.filter((g) => g.principalType === 'user').map((g) => g.principalId);
  const groupIds = grants.filter((g) => g.principalType === 'group').map((g) => g.principalId);
  if (userIds.includes(ownerId)) throw badRequest('You cannot share with the owner');
  if (userIds.length) {
    const found = await db.select({ id: users.id, kind: users.kind }).from(users).where(inArray(users.id, userIds));
    if (found.length !== userIds.length || found.some((f) => f.kind === 'shared')) throw badRequest('Share with people or groups');
  }
  if (groupIds.length) {
    const found = await db.select({ id: groups.id }).from(groups).where(inArray(groups.id, groupIds));
    if (found.length !== groupIds.length) throw badRequest('One or more groups do not exist');
  }
}

/** Attach display names/emails to share rows for the UI. */
export async function withPrincipalNames<T extends PrincipalRef>(rows: T[]): Promise<(T & { name: string; email: string | null })[]> {
  const db = dbRef!;
  const userIds = rows.filter((r) => r.principalType === 'user').map((r) => r.principalId);
  const groupIds = rows.filter((r) => r.principalType === 'group').map((r) => r.principalId);
  const people = userIds.length ? await db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, userIds)) : [];
  const teams = groupIds.length ? await db.select({ id: groups.id, name: groups.name, email: groups.email }).from(groups).where(inArray(groups.id, groupIds)) : [];
  return rows.map((r) => {
    const who = r.principalType === 'user' ? people.find((p) => p.id === r.principalId) : teams.find((g) => g.id === r.principalId);
    return { ...r, name: who?.name ?? 'Unknown', email: who?.email ?? null };
  });
}
