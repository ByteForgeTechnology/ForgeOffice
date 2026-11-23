import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Organizations & domains
// ---------------------------------------------------------------------------

export type Feature = 'mail' | 'calendar' | 'contacts' | 'tasks' | 'drive' | 'team';
export type FeatureFlags = Record<Feature, boolean>;
export interface DriveSettings {
  /** Days items stay in recycle bins before they are deleted for good. */
  trashDays: number;
  maxUploadMb: number;
  /** Allow links that work for people outside the organisation. */
  externalSharing: boolean;
  /** Longest an external link may last (days); null = no limit. */
  linkMaxDays: number | null;
}
export const DEFAULT_DRIVE_SETTINGS: DriveSettings = { trashDays: 93, maxUploadMb: 10240, externalSharing: true, linkMaxDays: null };
export interface TeamSettings {
  /** People outside the organisation may join meetings from a link (after being admitted). */
  guestAccess: boolean;
  /** Meetings may be recorded (to forge_team_media). */
  recording: boolean;
  /** Who may create teams: everyone, or only admins. */
  createTeams: 'everyone' | 'admins';
  /** Most people in one meeting. */
  maxParticipants: number;
}
export const DEFAULT_TEAM_SETTINGS: TeamSettings = { guestAccess: true, recording: true, createTeams: 'everyone', maxParticipants: 50 };

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull().default('UTC'),
  locale: text('locale').notNull().default('en-GB'),
  /** Default per-user storage quota in bytes (applies when a user has no override). */
  defaultQuotaBytes: bigint('default_quota_bytes', { mode: 'number' }).notNull().default(50 * 1024 ** 3),
  /** When true every user must enrol TOTP MFA at next sign-in. */
  requireMfa: boolean('require_mfa').notNull().default(false),
  /** Sign in again after this many hours, however active (web app and "Sign in with ForgeOffice" apps). */
  sessionMaxHours: integer('session_max_hours').notNull().default(336),
  /** Sign out after this many minutes without activity; null = never. */
  sessionIdleMinutes: integer('session_idle_minutes'),
  /** Optional products switched on for the organisation (ForgeDirectory is always on). */
  /** ForgeDrive policies (Admin → ForgeDrive → Settings). */
  driveSettings: jsonb('drive_settings').$type<DriveSettings>().notNull().default({ trashDays: 93, maxUploadMb: 10240, externalSharing: true, linkMaxDays: null }),
  features: jsonb('features').$type<FeatureFlags>().notNull().default({ mail: true, calendar: true, contacts: true, tasks: true, drive: true, team: true }),
  /** ForgeTeam policies (Admin → ForgeTeam → Settings). */
  teamSettings: jsonb('team_settings').$type<TeamSettings>().notNull().default({ guestAccess: true, recording: true, createTeams: 'everyone', maxParticipants: 50 }),
  /** Largest message accepted by SMTP and the composer. */
  mailMaxMessageBytes: integer('mail_max_message_bytes').notNull().default(35 * 1024 * 1024),
  /** Seconds a sent message is held so the user can undo it. */
  undoSendSeconds: integer('undo_send_seconds').notNull().default(10),
  /**
   * Outgoing smarthost (SMTP relay). When on, mail for other organisations is
   * handed to this server instead of being delivered directly to each domain's MX.
   */
  smtpRelayEnabled: boolean('smtp_relay_enabled').notNull().default(false),
  smtpRelayHost: text('smtp_relay_host'),
  smtpRelayPort: integer('smtp_relay_port').notNull().default(587),
  /** starttls: plain connection upgraded with STARTTLS (required); tls: TLS from the start (465); none: no encryption. */
  smtpRelaySecurity: text('smtp_relay_security', { enum: ['starttls', 'tls', 'none'] })
    .notNull()
    .default('starttls'),
  smtpRelayUsername: text('smtp_relay_username'),
  /** AES-GCM encrypted with a key derived from the master secret. */
  smtpRelayPasswordEnc: text('smtp_relay_password_enc'),
  /** Only use the relay for these recipient domains (and their subdomains); empty = all outside mail. */
  smtpRelayDomains: jsonb('smtp_relay_domains').$type<string[]>().notNull().default([]),
  brandColor: text('brand_color').notNull().default('#4f46e5'),
  /** SHA-256 of the logo blob in the drive volume, if any. */
  logoBlob: text('logo_blob'),
  logoMime: text('logo_mime'),
  setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const domains = pgTable(
  'domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    verified: boolean('verified').notNull().default(false),
    /** Value expected in a `forge-verification=<token>` DNS TXT record. */
    verificationToken: text('verification_token').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** Mail for unknown local parts is delivered here when set. */
    catchAllUserId: uuid('catch_all_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    dkimSelector: text('dkim_selector').notNull().default('forge'),
    /** Base64 SPKI public key published in DNS; the private key lives in forge_certs/dkim. */
    dkimPublicKey: text('dkim_public_key'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('domains_name_uq').on(t.name), index('domains_org_idx').on(t.orgId)],
);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const userStatus = pgEnum('user_status', ['active', 'suspended', 'deleted']);
/** "shared" accounts are mailboxes only: they cannot sign in, members are granted access. */
export const userKind = pgEnum('user_kind', ['person', 'shared']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    domainId: uuid('domain_id')
      .notNull()
      .references(() => domains.id, { onDelete: 'restrict' }),
    /** Local part of the primary address (`alice` in alice@example.com). */
    username: text('username').notNull(),
    /** Full primary address, always lower-case. Used as the sign-in name. */
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    givenName: text('given_name'),
    familyName: text('family_name'),
    jobTitle: text('job_title'),
    department: text('department'),
    /** Contact details shown in the directory and available to email signatures. */
    company: text('company'),
    officeLocation: text('office_location'),
    workPhone: text('work_phone'),
    mobilePhone: text('mobile_phone'),
    website: text('website'),
    streetAddress: text('street_address'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    country: text('country'),
    pronouns: text('pronouns'),
    timezone: text('timezone'),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    status: userStatus('status').notNull().default('active'),
    kind: userKind('kind').notNull().default('person'),
    /** Force TOTP enrolment for this user regardless of org policy. */
    mfaRequired: boolean('mfa_required').notNull().default(false),
    /** AES-256-GCM encrypted base32 TOTP secret. */
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    /** Last accepted TOTP time step, for replay protection. */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    /** SHA-256 hashes of unused one-time recovery codes. */
    recoveryCodes: jsonb('recovery_codes').$type<string[]>().notNull().default([]),
    /** Per-user quota override in bytes; null means use the org default. */
    quotaBytes: bigint('quota_bytes', { mode: 'number' }),
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** Profile picture: a 512×512 WebP in the blob store (by SHA-256). */
    avatarSha: text('avatar_sha'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    index('users_org_status_idx').on(t.orgId, t.status),
    index('users_display_name_idx').on(t.displayName),
  ],
);

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    builtin: boolean('builtin').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_org_key_uq').on(t.orgId, t.key)],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index('user_roles_role_idx').on(t.roleId)],
);

// ---------------------------------------------------------------------------
// Security groups & distribution lists
// ---------------------------------------------------------------------------

export const groupType = pgEnum('group_type', ['security', 'distribution']);
export const groupMemberRole = pgEnum('group_member_role', ['owner', 'member']);

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    type: groupType('type').notNull(),
    /** Mail address for distribution lists / mail-enabled security groups. */
    email: text('email'),
    /** Distribution lists: whether senders outside the organisation may post. */
    allowExternalSenders: boolean('allow_external_senders').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('groups_org_name_uq').on(t.orgId, t.name), uniqueIndex('groups_email_uq').on(t.email)],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: groupMemberRole('role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('group_members_user_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Snapshot of the actor's address so entries remain readable after purge. */
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    outcome: text('outcome', { enum: ['success', 'failure'] })
      .notNull()
      .default('success'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    targetLabel: text('target_label'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_created_idx').on(t.createdAt),
    index('audit_action_idx').on(t.action),
    index('audit_actor_idx').on(t.actorId),
    index('audit_target_idx').on(t.targetType, t.targetId),
  ],
);

// ---------------------------------------------------------------------------
// OIDC provider persistence (sessions, grants, codes, refresh tokens, ...)
// ---------------------------------------------------------------------------

export const oidcPayloads = pgTable(
  'oidc_payloads',
  {
    id: text('id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    grantId: text('grant_id'),
    userCode: text('user_code'),
    uid: text('uid'),
    accountId: text('account_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.type] }),
    index('oidc_grant_idx').on(t.grantId),
    index('oidc_uid_idx').on(t.uid),
    index('oidc_user_code_idx').on(t.userCode),
    index('oidc_account_idx').on(t.accountId),
    index('oidc_expires_idx').on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// Content-addressable blob reference counts (@forge/storage)
// ---------------------------------------------------------------------------

export const blobs = pgTable('blobs', {
  sha256: text('sha256').primaryKey(),
  volume: text('volume').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  mime: text('mime'),
  refCount: integer('ref_count').notNull().default(0),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Backups (triggered from the admin console, executed by the worker)
// ---------------------------------------------------------------------------

export const backupStatus = pgEnum('backup_status', ['queued', 'running', 'completed', 'failed']);

export const backups = pgTable(
  'backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: backupStatus('status').notNull().default('queued'),
    trigger: text('trigger', { enum: ['manual', 'scheduled'] }).notNull(),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** Directory name inside the backups volume. */
    name: text('name'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    manifest: jsonb('manifest').$type<BackupManifest>(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('backups_created_idx').on(t.createdAt)],
);

export interface BackupManifest {
  version: 1;
  createdAt: string;
  artifacts: { name: string; kind: 'database' | 'volume'; source: string; bytes: number; sha256: string }[];
}

export type Organization = typeof organizations.$inferSelect;
export type Domain = typeof domains.$inferSelect;
export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;

/**
 * Signed-in sessions (one per browser or device), keyed by the identity
 * provider's session id. Used to show "where you're signed in", to enforce
 * session timeouts, and to sign a device out.
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    loginAt: timestamp('login_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** OAuth client IDs used in this session (ForgeOffice, registered apps). */
    clients: jsonb('clients').$type<string[]>().notNull().default([]),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('user_sessions_user_idx').on(t.userId, t.lastSeenAt)],
);
export type UserSession = typeof userSessions.$inferSelect;

/**
 * Applications registered by an administrator to sign people in with
 * ForgeDirectory over OAuth 2.0 / OpenID Connect.
 */
export const oauthApps = pgTable(
  'oauth_apps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The OAuth client_id given to the application. */
    clientId: text('client_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    homepageUrl: text('homepage_url'),
    /** "confidential": a server-side app with a secret; "public": SPA or mobile/desktop app (PKCE, no secret). */
    type: text('type', { enum: ['confidential', 'public'] }).notNull(),
    /** How a confidential app sends its secret to the token endpoint. */
    authMethod: text('auth_method', { enum: ['client_secret_basic', 'client_secret_post'] })
      .notNull()
      .default('client_secret_basic'),
    /** AES-GCM encrypted client secret (shown to the admin once). */
    secretEnc: text('secret_enc'),
    secretHint: text('secret_hint'),
    secretCreatedAt: timestamp('secret_created_at', { withTimezone: true }),
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull().default([]),
    postLogoutRedirectUris: jsonb('post_logout_redirect_uris').$type<string[]>().notNull().default([]),
    /** Scopes the app may ask for (openid, profile, email, phone, groups, offline_access). */
    scopes: jsonb('scopes').$type<string[]>().notNull().default(['openid', 'profile', 'email']),
    /** Who may sign in: everyone, or members of `groupIds`. */
    access: text('access', { enum: ['all', 'groups'] })
      .notNull()
      .default('all'),
    groupIds: jsonb('group_ids').$type<string[]>().notNull().default([]),
    /** "user": each person is asked to consent; "admin": approved for everyone by an administrator. */
    consent: text('consent', { enum: ['user', 'admin'] })
      .notNull()
      .default('user'),
    enabled: boolean('enabled').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('oauth_apps_client_id_uq').on(t.clientId), index('oauth_apps_org_idx').on(t.orgId)],
);
export type OAuthApp = typeof oauthApps.$inferSelect;
export type Backup = typeof backups.$inferSelect;

/** Case-insensitive column helper for searches. */
export const lower = (col: unknown) => sql`lower(${col})`;
