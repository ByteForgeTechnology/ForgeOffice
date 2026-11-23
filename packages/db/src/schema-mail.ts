import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './schema';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export interface MailAddress {
  name: string;
  address: string;
}

/** Byte-offset map of a MIME message, used by IMAP section fetches. */
export interface MimeNode {
  /** Part path, e.g. "" for root, "1", "1.2". */
  path: string;
  headerStart: number;
  bodyStart: number;
  bodyEnd: number;
  type: string;
  subtype: string;
  params: Record<string, string>;
  id: string | null;
  description: string | null;
  encoding: string;
  disposition: { type: string; params: Record<string, string> } | null;
  language: string | null;
  location: string | null;
  md5: string | null;
  lines: number;
  children: MimeNode[];
  /** For message/rfc822 parts: the embedded message's root node. */
  message?: MimeNode;
}

export interface AttachmentInfo {
  partPath: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const userAliases = pgTable('user_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  address: text('address').notNull().unique(),
  createdAt: createdAt(),
});

/** Passwords for IMAP/SMTP/CalDAV clients, which cannot do interactive MFA. */
export const appPasswords = pgTable(
  'app_passwords',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    createdAt: createdAt(),
  },
  (t) => [index('app_passwords_user_idx').on(t.userId)],
);

/**
 * Delegated access to another account's mailbox (normally a shared mailbox).
 * access: "read" = read-only, "full" = read/write/organise; sendAs and
 * sendOnBehalf are independent send rights.
 */
export const mailboxPermissions = pgTable(
  'mailbox_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'group'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
    access: text('access', { enum: ['none', 'read', 'full'] })
      .notNull()
      .default('full'),
    sendAs: boolean('send_as').notNull().default(false),
    sendOnBehalf: boolean('send_on_behalf').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mailbox_permissions_uq').on(t.ownerId, t.principalType, t.principalId), index('mailbox_permissions_principal_idx').on(t.principalType, t.principalId)],
);

// ---------------------------------------------------------------------------
// Mailboxes & messages
// ---------------------------------------------------------------------------

export const mailboxes = pgTable(
  'mailboxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Hierarchical name using "/" as delimiter, e.g. "Projects/2026". */
    path: text('path').notNull(),
    /** IMAP SPECIAL-USE attribute: \Inbox (pseudo), \Sent, \Drafts, \Junk, \Trash, \Archive. */
    specialUse: text('special_use'),
    uidValidity: integer('uid_validity').notNull(),
    uidNext: integer('uid_next').notNull().default(1),
    /** Incremented on every change in the mailbox (flags, adds, removals). */
    modseq: bigint('modseq', { mode: 'number' }).notNull().default(1),
    subscribed: boolean('subscribed').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mailboxes_user_path_uq').on(t.userId, t.path)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mailboxId: uuid('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    uid: integer('uid').notNull(),
    modseq: bigint('modseq', { mode: 'number' }).notNull(),
    /** SHA-256 of the raw RFC 5322 message in the mail volume blob store. */
    blobSha: text('blob_sha').notNull(),
    size: integer('size').notNull(),
    internalDate: timestamp('internal_date', { withTimezone: true }).notNull().defaultNow(),
    seen: boolean('seen').notNull().default(false),
    flagged: boolean('flagged').notNull().default(false),
    answered: boolean('answered').notNull().default(false),
    draft: boolean('draft').notNull().default(false),
    deleted: boolean('deleted').notNull().default(false),
    keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    references: jsonb('references').$type<string[]>().notNull().default([]),
    threadId: uuid('thread_id').notNull(),
    subject: text('subject').notNull().default(''),
    fromAddr: jsonb('from_addr').$type<MailAddress | null>(),
    toAddrs: jsonb('to_addrs').$type<MailAddress[]>().notNull().default([]),
    ccAddrs: jsonb('cc_addrs').$type<MailAddress[]>().notNull().default([]),
    bccAddrs: jsonb('bcc_addrs').$type<MailAddress[]>().notNull().default([]),
    replyTo: jsonb('reply_to').$type<MailAddress[]>().notNull().default([]),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    snippet: text('snippet').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    attachments: jsonb('attachments').$type<AttachmentInfo[]>().notNull().default([]),
    mimeTree: jsonb('mime_tree').$type<MimeNode>().notNull(),
    /** Denormalised "name <address>" list of all participants, for search. */
    searchAddresses: text('search_addresses').notNull().default(''),
    spamScore: real('spam_score'),
    authResults: jsonb('auth_results').$type<Record<string, unknown>>(),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple'::regconfig, coalesce(subject, '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce(search_addresses, '')), 'B') || to_tsvector('simple'::regconfig, coalesce(left(body_text, 200000), ''))`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('messages_mailbox_uid_uq').on(t.mailboxId, t.uid),
    index('messages_mailbox_date_idx').on(t.mailboxId, t.internalDate),
    index('messages_user_thread_idx').on(t.userId, t.threadId),
    index('messages_user_msgid_idx').on(t.userId, t.messageId),
    index('messages_search_idx').using('gin', t.searchVector),
  ],
);

/**
 * Sharing of a single mail folder with another person or group.
 * read = view; write = view, flag, file messages in/out; full = write + delete.
 */
export const folderPermissions = pgTable(
  'folder_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mailboxId: uuid('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    /** Owner of the folder (denormalised for lookups). */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'group'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
    access: text('access', { enum: ['read', 'write', 'full'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('folder_permissions_uq').on(t.mailboxId, t.principalType, t.principalId), index('folder_permissions_principal_idx').on(t.principalType, t.principalId)],
);

/** Files uploaded from the composer before a message is sent. */
export const mailUploads = pgTable('mail_uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  blobSha: text('blob_sha').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Outbound delivery
// ---------------------------------------------------------------------------

export const outboundStatus = pgEnum('outbound_status', ['scheduled', 'queued', 'sending', 'sent', 'partial', 'failed', 'cancelled']);

export interface OutboundRecipient {
  address: string;
  local: boolean;
  status: 'pending' | 'delivered' | 'deferred' | 'failed';
  response?: string;
  attempts: number;
  updatedAt?: string;
}

export const outboundMessages = pgTable(
  'outbound_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    blobSha: text('blob_sha').notNull(),
    size: integer('size').notNull(),
    envelopeFrom: text('envelope_from').notNull(),
    recipients: jsonb('recipients').$type<OutboundRecipient[]>().notNull(),
    subject: text('subject').notNull().default(''),
    status: outboundStatus('status').notNull().default('queued'),
    sendAt: timestamp('send_at', { withTimezone: true }).notNull().defaultNow(),
    /** The copy saved in the sender's Sent folder (for undo / scheduled cancel). */
    sentMessageId: uuid('sent_message_id'),
    /** Draft restored when a send is cancelled. */
    source: text('source', { enum: ['webmail', 'smtp', 'system'] }).notNull(),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('outbound_user_idx').on(t.userId, t.createdAt), index('outbound_status_idx').on(t.status)],
);

// ---------------------------------------------------------------------------
// Rules, auto-replies, quarantine
// ---------------------------------------------------------------------------

export interface FilterCondition {
  field: 'from' | 'to' | 'cc' | 'subject' | 'body' | 'header' | 'hasAttachment' | 'size';
  op: 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith' | 'matches' | 'greaterThan' | 'lessThan' | 'isTrue';
  value?: string;
  /** Header name when field = "header". */
  header?: string;
}

export interface FilterAction {
  type: 'move' | 'markRead' | 'flag' | 'delete' | 'forward' | 'stop';
  /** Mailbox id for "move"; address for "forward". */
  value?: string;
}

export const mailFilters = pgTable(
  'mail_filters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    position: integer('position').notNull().default(0),
    match: text('match', { enum: ['all', 'any'] })
      .notNull()
      .default('all'),
    conditions: jsonb('conditions').$type<FilterCondition[]>().notNull(),
    actions: jsonb('actions').$type<FilterAction[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('mail_filters_user_idx').on(t.userId, t.position)],
);

export const autoReplies = pgTable('auto_replies', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  subject: text('subject').notNull().default('Out of office'),
  body: text('body').notNull().default(''),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  /** Only reply to senders inside the organisation. */
  internalOnly: boolean('internal_only').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Remembers who already received an auto-reply (one per sender every 4 days). */
export const autoReplyLog = pgTable(
  'auto_reply_log',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sender: text('sender').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sender] })],
);

export const quarantine = pgTable(
  'quarantine',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    blobSha: text('blob_sha').notNull(),
    size: integer('size').notNull(),
    envelopeFrom: text('envelope_from').notNull(),
    recipients: jsonb('recipients').$type<string[]>().notNull(),
    fromHeader: text('from_header').notNull().default(''),
    subject: text('subject').notNull().default(''),
    reason: text('reason').notNull(),
    spamScore: real('spam_score'),
    authResults: jsonb('auth_results').$type<Record<string, unknown>>(),
    remoteIp: text('remote_ip'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('quarantine_created_idx').on(t.createdAt)],
);

// ---------------------------------------------------------------------------
// Transport (mail flow) rules: organisation-wide policies for mail in transit
// ---------------------------------------------------------------------------

export type RuleConditionType =
  | 'senderAddress'
  | 'senderScope'
  | 'senderMemberOf'
  | 'recipientAddress'
  | 'recipientScope'
  | 'recipientMemberOf'
  | 'subjectContains'
  | 'subjectOrBodyContains'
  | 'headerContains'
  | 'hasAttachment'
  | 'attachmentExtension'
  | 'attachmentNameContains'
  | 'sizeOver'
  | 'spamScoreAbove';

export interface RuleCondition {
  type: RuleConditionType;
  /** Words, addresses/domains, extensions or group ids (any one matches). */
  values?: string[];
  /** 'internal' | 'external' for scope conditions. */
  scope?: 'internal' | 'external';
  /** Header name for headerContains. */
  header?: string;
  /** Bytes for sizeOver; score for spamScoreAbove. */
  number?: number;
}

export type RuleActionType =
  | 'prependSubject'
  | 'setHeader'
  | 'appendDisclaimer'
  | 'addRecipients'
  | 'bcc'
  | 'redirect'
  | 'junk'
  | 'quarantine'
  | 'reject'
  | 'delete';

export interface RuleAction {
  type: RuleActionType;
  /** Subject prefix, header value, rejection text, plain-text disclaimer. */
  text?: string;
  /** HTML disclaimer (defaults to the escaped plain text). */
  html?: string;
  header?: string;
  addresses?: string[];
}

export const transportRules = pgTable(
  'transport_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    /** Lower runs first. */
    priority: integer('priority').notNull().default(0),
    /** "test" records matches without changing anything. */
    mode: text('mode', { enum: ['enforce', 'test'] })
      .notNull()
      .default('enforce'),
    appliesTo: text('applies_to', { enum: ['all', 'inbound', 'outbound', 'internal'] })
      .notNull()
      .default('all'),
    conditions: jsonb('conditions').$type<RuleCondition[]>().notNull().default([]),
    exceptions: jsonb('exceptions').$type<RuleCondition[]>().notNull().default([]),
    actions: jsonb('actions').$type<RuleAction[]>().notNull(),
    stopProcessing: boolean('stop_processing').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('transport_rules_org_idx').on(t.orgId, t.priority)],
);

/** Recent rule matches (a lightweight message trace), pruned after 30 days. */
export const transportRuleHits = pgTable(
  'transport_rule_hits',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => transportRules.id, { onDelete: 'cascade' }),
    direction: text('direction', { enum: ['inbound', 'outbound', 'internal'] }).notNull(),
    sender: text('sender').notNull(),
    recipients: jsonb('recipients').$type<string[]>().notNull(),
    subject: text('subject').notNull().default(''),
    messageId: text('message_id'),
    mode: text('mode', { enum: ['enforce', 'test'] }).notNull(),
    actions: jsonb('actions').$type<string[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('transport_rule_hits_rule_idx').on(t.ruleId, t.createdAt), index('transport_rule_hits_created_idx').on(t.createdAt)],
);

/**
 * Blocked and allowed senders. With a userId the entry belongs to that
 * mailbox; without one it applies to the whole organisation. An entry is an
 * exact address (`a@b.com`) or a domain (`b.com`, which includes subdomains),
 * and sits on one list only per scope.
 */
export const senderLists = pgTable(
  'sender_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    list: text('list', { enum: ['block', 'allow'] }).notNull(),
    entry: text('entry').notNull(),
    note: text('note').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sender_lists_user_uq').on(t.userId, t.entry).where(sql`${t.userId} is not null`),
    uniqueIndex('sender_lists_org_uq').on(t.orgId, t.entry).where(sql`${t.userId} is null`),
  ],
);
export type SenderListEntry = typeof senderLists.$inferSelect;

/**
 * Organisation email signatures. The HTML contains {{variables}} filled from
 * each person's contact details. The first enabled signature (by priority)
 * whose audience includes the sender is used.
 */
export const emailSignatures = pgTable(
  'email_signatures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    html: text('html').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    /** Everyone, or only members of `groupIds`. */
    audience: text('audience', { enum: ['all', 'groups'] })
      .notNull()
      .default('all'),
    groupIds: jsonb('group_ids').$type<string[]>().notNull().default([]),
    /** Insert in new messages / in replies and forwards (webmail). */
    useForNew: boolean('use_for_new').notNull().default(true),
    useForReplies: boolean('use_for_replies').notNull().default(true),
    /** Also append on the server to mail sent from desktop and phone apps (SMTP). */
    applyToApps: boolean('apply_to_apps').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('email_signatures_org_idx').on(t.orgId, t.priority)],
);
export type EmailSignature = typeof emailSignatures.$inferSelect;

/** Images (logos, icons) used in signatures, served publicly so recipients can load them. */
export const signatureImages = pgTable('signature_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  blobSha: text('blob_sha').notNull(),
  mime: text('mime').notNull(),
  name: text('name').notNull().default(''),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Calendars (CalDAV)
// ---------------------------------------------------------------------------

export const calendarOwnerType = pgEnum('calendar_owner_type', ['user', 'group', 'resource']);

export const calendars = pgTable(
  'calendars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerType: calendarOwnerType('owner_type').notNull(),
    /** users.id, groups.id or resources.id depending on ownerType. */
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    color: text('color').notNull().default('#4f46e5'),
    timezone: text('timezone').notNull().default('UTC'),
    isDefault: boolean('is_default').notNull().default(false),
    /** "events" calendars hold VEVENTs; "tasks" lists hold VTODOs (Outlook-style tasks). */
    kind: text('kind', { enum: ['events', 'tasks'] })
      .notNull()
      .default('events'),
    /** System task list: "flagged" holds a task for each flagged email. */
    role: text('role', { enum: ['flagged'] }),
    /** Monotonic revision for CalDAV sync tokens / CTag. */
    syncRevision: bigint('sync_revision', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('calendars_owner_idx').on(t.ownerType, t.ownerId),
    // Exactly one default calendar and one default task list per owner (prevents duplicates from concurrent first use).
    uniqueIndex('calendars_default_uq').on(t.ownerType, t.ownerId, t.kind).where(sql`${t.isDefault}`),
    uniqueIndex('calendars_role_uq').on(t.ownerType, t.ownerId, t.role).where(sql`${t.role} is not null`),
  ],
);

export const calendarShares = pgTable(
  'calendar_shares',
  {
    calendarId: uuid('calendar_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'group'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
    access: text('access', { enum: ['freebusy', 'read', 'write'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.calendarId, t.principalType, t.principalId] })],
);

export const calendarObjects = pgTable(
  'calendar_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    calendarId: uuid('calendar_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    uid: text('uid').notNull(),
    /** Resource name inside the collection, e.g. "<uid>.ics". */
    href: text('href').notNull(),
    etag: text('etag').notNull(),
    ics: text('ics').notNull(),
    componentType: text('component_type').notNull().default('VEVENT'),
    /** Overall time span (first start → last end, recurrence-aware) for range queries. */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    recurring: boolean('recurring').notNull().default(false),
    summary: text('summary').notNull().default(''),
    organizer: text('organizer'),
    transparent: boolean('transparent').notNull().default(false),
    syncRevision: bigint('sync_revision', { mode: 'number' }).notNull(),
    /** Tombstone for sync-collection; the row keeps its href so deletions sync. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('calendar_objects_href_uq').on(t.calendarId, t.href),
    index('calendar_objects_uid_idx').on(t.calendarId, t.uid),
    index('calendar_objects_range_idx').on(t.calendarId, t.startsAt, t.endsAt),
    index('calendar_objects_sync_idx').on(t.calendarId, t.syncRevision),
  ],
);

/** Per-person settings for a calendar they can see (e.g. whether its reminders reach them). */
export const calendarPreferences = pgTable(
  'calendar_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    reminders: boolean('reminders').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.calendarId] })],
);

export const resources = pgTable('resources', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  kind: text('kind', { enum: ['room', 'equipment'] })
    .notNull()
    .default('room'),
  capacity: integer('capacity'),
  location: text('location').notNull().default(''),
  /** Accept invitations automatically when the slot is free. */
  autoAccept: boolean('auto_accept').notNull().default(true),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Contacts (CardDAV)
// ---------------------------------------------------------------------------

export const addressBooks = pgTable(
  'address_books',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    isDefault: boolean('is_default').notNull().default(false),
    syncRevision: bigint('sync_revision', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('address_books_user_idx').on(t.userId), uniqueIndex('address_books_default_uq').on(t.userId).where(sql`${t.isDefault}`)],
);

/** Sharing of a single address book with another person or group. */
export const addressBookShares = pgTable(
  'address_book_shares',
  {
    addressBookId: uuid('address_book_id')
      .notNull()
      .references(() => addressBooks.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'group'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
    access: text('access', { enum: ['read', 'write'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.addressBookId, t.principalType, t.principalId] })],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    addressBookId: uuid('address_book_id')
      .notNull()
      .references(() => addressBooks.id, { onDelete: 'cascade' }),
    uid: text('uid').notNull(),
    href: text('href').notNull(),
    etag: text('etag').notNull(),
    vcard: text('vcard').notNull(),
    fullName: text('full_name').notNull().default(''),
    emails: jsonb('emails').$type<string[]>().notNull().default([]),
    phones: jsonb('phones').$type<string[]>().notNull().default([]),
    organization: text('organization').notNull().default(''),
    syncRevision: bigint('sync_revision', { mode: 'number' }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('contacts_href_uq').on(t.addressBookId, t.href), index('contacts_book_sync_idx').on(t.addressBookId, t.syncRevision)],
);

export type Mailbox = typeof mailboxes.$inferSelect;
export type MailboxPermission = typeof mailboxPermissions.$inferSelect;
export type FolderPermission = typeof folderPermissions.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type OutboundMessage = typeof outboundMessages.$inferSelect;
export type MailFilter = typeof mailFilters.$inferSelect;
export type TransportRule = typeof transportRules.$inferSelect;
export type Calendar = typeof calendars.$inferSelect;
export type CalendarObject = typeof calendarObjects.$inferSelect;
export type Resource = typeof resources.$inferSelect;
export type AddressBook = typeof addressBooks.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
