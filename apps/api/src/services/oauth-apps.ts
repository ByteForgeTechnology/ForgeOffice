import { randomBytes } from 'node:crypto';
import { decryptString, encryptString } from '@forge/auth';
import { groupMembers, oauthApps, oidcPayloads, orm, type Database, type OAuthApp } from '@forge/db';
import { badRequest } from '../errors';

const { and, eq, inArray, sql } = orm;

/** Scopes an application may be allowed to request, with what they reveal (shown on the consent screen). */
export const APP_SCOPES = [
  { scope: 'openid', label: 'Sign you in', description: 'Your account ID', required: true },
  { scope: 'profile', label: 'Your profile', description: 'Name, username and time zone' },
  { scope: 'email', label: 'Your email address', description: 'Your primary email address' },
  { scope: 'phone', label: 'Your phone number', description: 'Your work or mobile phone number' },
  { scope: 'groups', label: 'Your groups', description: 'The names of the groups you belong to' },
  { scope: 'offline_access', label: 'Stay signed in', description: 'Keep access when you are not using the app (refresh tokens)' },
] as const;
export const APP_SCOPE_NAMES = APP_SCOPES.map((s) => s.scope) as string[];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Redirect URIs must be exact (no wildcards or fragments): https anywhere,
 * http only on this computer (loopback, for development and desktop apps),
 * or a private-use scheme for mobile apps (e.g. com.example.app:/callback).
 */
export function checkRedirectUri(uri: string): string {
  let u: URL;
  try {
    u = new URL(uri.trim());
  } catch {
    throw badRequest(`Not a valid address: ${uri}`);
  }
  if (u.hash) throw badRequest(`Redirect addresses cannot contain a #fragment: ${uri}`);
  if (uri.includes('*')) throw badRequest(`Wildcards are not allowed: ${uri}`);
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (['javascript', 'data', 'file', 'vbscript', 'blob', 'about'].includes(scheme)) throw badRequest(`Not allowed: ${uri}`);
  if (scheme === 'http' && !LOOPBACK.has(u.hostname)) throw badRequest(`Use https (http is only allowed for localhost): ${uri}`);
  if (scheme !== 'http' && scheme !== 'https' && !scheme.includes('.')) throw badRequest(`Custom schemes must be reverse-domain names such as com.example.app: ${uri}`);
  return u.toString();
}

/** Desktop and mobile apps (loopback or private-use redirect schemes) are "native" in OpenID Connect terms. */
const isNative = (uris: string[]) => uris.some((x) => {
  const u = new URL(x);
  return (u.protocol !== 'https:' && u.protocol !== 'http:') || LOOPBACK.has(u.hostname);
});

export const newClientId = () => `forge-app-${randomBytes(12).toString('hex')}`;
export const newClientSecret = () => randomBytes(32).toString('base64url');

export function encryptSecret(key: Buffer, secret: string) {
  return { secretEnc: encryptString(key, secret), secretHint: secret.slice(-4), secretCreatedAt: new Date() };
}

/** Client metadata for oidc-provider (the client secret is decrypted only here). */
export function clientMetadata(app: OAuthApp, key: Buffer): Record<string, unknown> {
  const confidential = app.type === 'confidential';
  return {
    client_id: app.clientId,
    client_name: app.name,
    ...(app.homepageUrl ? { client_uri: app.homepageUrl } : {}),
    application_type: isNative(app.redirectUris) ? 'native' : 'web',
    redirect_uris: app.redirectUris,
    post_logout_redirect_uris: app.postLogoutRedirectUris,
    response_types: ['code'],
    grant_types: app.scopes.includes('offline_access') ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
    token_endpoint_auth_method: confidential ? app.authMethod : 'none',
    ...(confidential && app.secretEnc ? { client_secret: decryptString(key, app.secretEnc) } : {}),
    // The scopes this app may request; anything else is dropped.
    scope: app.scopes.join(' '),
  };
}

export async function appByClientId(db: Database, clientId: string): Promise<OAuthApp | null> {
  const [app] = await db.select().from(oauthApps).where(eq(oauthApps.clientId, clientId)).limit(1);
  return app ?? null;
}

/** May this person use the app? */
export async function canUseApp(db: Database, app: OAuthApp, userId: string): Promise<boolean> {
  if (!app.enabled) return false;
  if (app.access === 'all') return true;
  if (!app.groupIds.length) return false;
  const [hit] = await db
    .select({ g: groupMembers.groupId })
    .from(groupMembers)
    .where(and(eq(groupMembers.userId, userId), inArray(groupMembers.groupId, app.groupIds)))
    .limit(1);
  return !!hit;
}

/**
 * End an app's access: delete its grants, tokens and codes (for one person,
 * or everyone). Sessions are kept: people stay signed in to ForgeOffice.
 */
export async function revokeAppAccess(db: Database, clientId: string, accountId?: string): Promise<number> {
  const rows = await db
    .select({ id: oidcPayloads.id, type: oidcPayloads.type, grantId: oidcPayloads.grantId })
    .from(oidcPayloads)
    .where(and(sql`${oidcPayloads.payload}->>'clientId' = ${clientId}`, accountId ? eq(oidcPayloads.accountId, accountId) : undefined));
  const grantIds = [...new Set(rows.map((r) => r.grantId).filter((g): g is string => !!g))];
  if (grantIds.length) await db.delete(oidcPayloads).where(inArray(oidcPayloads.grantId, grantIds));
  const loose = rows.filter((r) => r.type !== 'Session');
  for (const r of loose) await db.delete(oidcPayloads).where(and(eq(oidcPayloads.id, r.id), eq(oidcPayloads.type, r.type)));
  return grantIds.length;
}
