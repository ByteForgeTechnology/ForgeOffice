import { randomBytes } from 'node:crypto';
import { BUILTIN_ROLES, GLOBAL_ADMIN, checkPasswordPolicy, hashPassword } from '@forge/auth';
import {
  domains,
  orm,
  organizations,
  roles,
  userRoles,
  users,
  type Database,
  type Domain,
  type Organization,
  type User,
} from '@forge/db';
import { badRequest, conflict, isUniqueViolation, notFound } from '../errors';

const { and, asc, eq, inArray, sql } = orm;

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function normaliseDomain(name: string): string {
  const d = name.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(d)) throw badRequest(`"${name}" is not a valid domain name`);
  return d;
}

export function normaliseUsername(name: string): string {
  const u = name.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) {
    throw badRequest('Usernames may contain lower-case letters, digits, ".", "_" and "-", and must start and end with a letter or digit');
  }
  return u;
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'org'
  );
}

export function newVerificationToken(): string {
  return randomBytes(16).toString('hex');
}

/** ForgeOffice runs one organisation per installation; this returns it. */
export async function getPrimaryOrg(db: Database): Promise<Organization | null> {
  const [org] = await db.select().from(organizations).orderBy(asc(organizations.createdAt)).limit(1);
  return org ?? null;
}

export async function seedBuiltinRoles(db: Database, orgId: string): Promise<void> {
  for (const role of BUILTIN_ROLES) {
    await db
      .insert(roles)
      .values({ orgId, key: role.key, name: role.name, description: role.description, permissions: role.permissions, builtin: true })
      .onConflictDoUpdate({
        target: [roles.orgId, roles.key],
        set: { name: role.name, description: role.description, permissions: role.permissions, builtin: true },
      });
  }
}

export interface CreateUserInput {
  orgId: string;
  username: string;
  domainId?: string;
  displayName: string;
  givenName?: string | null;
  familyName?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  password: string;
  mustChangePassword?: boolean;
  mfaRequired?: boolean;
  quotaBytes?: number | null;
  roleKeys?: string[];
}

export async function resolveDomain(db: Database, orgId: string, domainId?: string): Promise<Domain> {
  const where = domainId
    ? and(eq(domains.orgId, orgId), eq(domains.id, domainId))
    : and(eq(domains.orgId, orgId), eq(domains.isPrimary, true));
  const [domain] = await db.select().from(domains).where(where).limit(1);
  if (!domain) throw domainId ? notFound('Domain') : badRequest('The organisation has no primary domain');
  return domain;
}

export async function createUser(db: Database, input: CreateUserInput): Promise<User> {
  const username = normaliseUsername(input.username);
  const domain = await resolveDomain(db, input.orgId, input.domainId);
  const displayName = input.displayName.trim();
  if (!displayName) throw badRequest('Display name is required');
  const problems = checkPasswordPolicy(input.password, undefined, [username, input.givenName ?? '', input.familyName ?? '']);
  if (problems.length) throw badRequest('Password does not meet the policy', { password: problems });

  const email = `${username}@${domain.name}`;
  const passwordHash = await hashPassword(input.password);
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          orgId: input.orgId,
          domainId: domain.id,
          username,
          email,
          displayName,
          givenName: input.givenName ?? null,
          familyName: input.familyName ?? null,
          jobTitle: input.jobTitle ?? null,
          department: input.department ?? null,
          passwordHash,
          passwordChangedAt: new Date(),
          mustChangePassword: input.mustChangePassword ?? false,
          mfaRequired: input.mfaRequired ?? false,
          quotaBytes: input.quotaBytes ?? null,
        })
        .returning();
      if (!user) throw new Error('insert returned no row');
      if (input.roleKeys?.length) {
        const found = await tx
          .select({ id: roles.id, key: roles.key })
          .from(roles)
          .where(and(eq(roles.orgId, input.orgId), inArray(roles.key, input.roleKeys)));
        if (found.length !== new Set(input.roleKeys).size) throw badRequest('One or more roles do not exist');
        await tx.insert(userRoles).values(found.map((r) => ({ userId: user.id, roleId: r.id })));
      }
      return user;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`The address ${email} is already in use`);
    throw err;
  }
}

/** Number of active users holding the global administrator role. */
export async function countActiveGlobalAdmins(db: Database, orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(roles.orgId, orgId), eq(roles.key, GLOBAL_ADMIN), eq(users.status, 'active')));
  return row?.n ?? 0;
}

export async function userRoleKeys(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.key);
}

export function effectiveQuota(user: Pick<User, 'quotaBytes'>, org: Pick<Organization, 'defaultQuotaBytes'>): number {
  return user.quotaBytes ?? org.defaultQuotaBytes;
}

/** Public, admin-facing representation of a user (never includes secrets). */
export function serializeUser(user: User, extra: { roles?: string[] } = {}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    domainId: user.domainId,
    displayName: user.displayName,
    givenName: user.givenName,
    familyName: user.familyName,
    jobTitle: user.jobTitle,
    department: user.department,
    timezone: user.timezone,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    mfaRequired: user.mfaRequired,
    mfaEnabled: !!user.totpEnabledAt,
    recoveryCodesRemaining: user.recoveryCodes.length,
    quotaBytes: user.quotaBytes,
    usedBytes: user.usedBytes,
    locked: !!user.lockedUntil && user.lockedUntil > new Date(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    passwordChangedAt: user.passwordChangedAt?.toISOString() ?? null,
    suspendedAt: user.suspendedAt?.toISOString() ?? null,
    deletedAt: user.deletedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    ...(extra.roles ? { roles: extra.roles } : {}),
  };
}

/** Minimal directory card visible to every signed-in user. */
export function directoryCard(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    jobTitle: user.jobTitle,
    department: user.department,
  };
}

export function serializeOrg(org: Organization) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    timezone: org.timezone,
    locale: org.locale,
    defaultQuotaBytes: org.defaultQuotaBytes,
    requireMfa: org.requireMfa,
    brandColor: org.brandColor,
    hasLogo: !!org.logoBlob,
    setupCompletedAt: org.setupCompletedAt?.toISOString() ?? null,
  };
}
