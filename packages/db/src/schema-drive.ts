import { sql } from 'drizzle-orm';
import { primaryKey, bigint, boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { groups, organizations, users } from './schema';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

// ---------------------------------------------------------------------------
// ForgeDrive: libraries, items (folders & files), versions, permissions
// ---------------------------------------------------------------------------

/**
 * A document library: a person's "My files", a group's library, or a site's
 * library. Every item belongs to exactly one library.
 */
export const driveLibraries = pgTable(
  'drive_libraries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['personal', 'group', 'site'] }).notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** A role everyone in the organisation has (e.g. "viewer" for an organisation-wide site); null = members only. */
    everyoneRole: text('everyone_role', { enum: ['owner', 'editor', 'commenter', 'viewer'] }),
    /** Bytes of current versions plus older versions and the recycle bin. */
    usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
    /** Turned off by an administrator: nobody can open it (or its site) until it is enabled again. */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledBy: uuid('disabled_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('drive_libraries_personal_uq').on(t.ownerUserId).where(sql`${t.kind} = 'personal'`),
    uniqueIndex('drive_libraries_group_uq').on(t.groupId).where(sql`${t.kind} = 'group'`),
    index('drive_libraries_org_idx').on(t.orgId),
  ],
);

export type DriveRole = 'owner' | 'editor' | 'commenter' | 'viewer';
export type ScanStatus = 'pending' | 'clean' | 'infected' | 'error' | 'skipped';

/** Folders and files. Deleted items stay (recycle bin) until purged. */
export const driveItems = pgTable(
  'drive_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => driveLibraries.id, { onDelete: 'cascade' }),
    /** null = in the library's root. */
    parentId: uuid('parent_id').references((): AnyPgColumn => driveItems.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['folder', 'file'] }).notNull(),
    name: text('name').notNull(),
    /** Current version (files). */
    versionId: uuid('version_id'),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    mime: text('mime'),
    sha256: text('sha256'),
    /** false: permissions are not inherited from the parent folder / library. */
    inheritPermissions: boolean('inherit_permissions').notNull().default(true),
    scanStatus: text('scan_status', { enum: ['pending', 'clean', 'infected', 'error', 'skipped'] }),
    scanDetail: text('scan_detail'),
    /** WebP thumbnail blob (sha256), when one could be made. */
    thumbnailSha: text('thumbnail_sha'),
    /** Text extracted for search (PDF, text files). */
    textContent: text('text_content'),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple'::regconfig, coalesce(name, '')), 'A') || to_tsvector('simple'::regconfig, coalesce(left(text_content, 200000), ''))`,
    ),
    /** Check-out: only this person may save new versions until checked in. */
    checkedOutBy: uuid('checked_out_by').references(() => users.id, { onDelete: 'set null' }),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    /** WOPI lock held by an Office editor (Euro-Office), with its expiry. */
    wopiLock: text('wopi_lock'),
    wopiLockExpiresAt: timestamp('wopi_lock_expires_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Recycle bin: when deleted, by whom, and the item that was deleted (when removed as part of a folder). */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    trashRootId: uuid('trash_root_id'),
  },
  (t) => [
    // Names are unique among the live items of a folder (case-insensitive).
    uniqueIndex('drive_items_name_uq').on(t.libraryId, sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.name})`).where(sql`${t.deletedAt} is null`),
    index('drive_items_parent_idx').on(t.libraryId, t.parentId),
    index('drive_items_trash_idx').on(t.libraryId, t.deletedAt),
    index('drive_items_search_idx').using('gin', t.searchVector),
  ],
);

/** Immutable file versions; each points at a blob in forge_drive_data. */
export const driveVersions = pgTable(
  'drive_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => driveItems.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    blobSha: text('blob_sha').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    mime: text('mime'),
    comment: text('comment').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('drive_versions_item_number_uq').on(t.itemId, t.number)],
);

/** Access grants on a whole library (itemId null) or a folder/file; inherited downwards. */
export const drivePermissions = pgTable(
  'drive_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => driveLibraries.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').references(() => driveItems.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'group'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
    role: text('role', { enum: ['owner', 'editor', 'commenter', 'viewer'] }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('drive_permissions_uq').on(t.libraryId, sql`coalesce(${t.itemId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.principalType, t.principalId),
    index('drive_permissions_principal_idx').on(t.principalType, t.principalId),
  ],
);

/** External sharing links (signed tokens), with optional password, expiry and download limit. */
export const driveShareLinks = pgTable(
  'drive_share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => driveItems.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    maxDownloads: integer('max_downloads'),
    downloadCount: integer('download_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('drive_share_links_item_idx').on(t.itemId)],
);

export const driveComments = pgTable(
  'drive_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => driveItems.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('drive_comments_item_idx').on(t.itemId, t.createdAt)],
);

/** Resumable uploads in progress (chunks are appended to a temp file on the drive volume). */
export const driveUploads = pgTable('drive_uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  libraryId: uuid('library_id')
    .notNull()
    .references(() => driveLibraries.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  /** Set when uploading a new version of an existing file. */
  itemId: uuid('item_id'),
  name: text('name').notNull(),
  mime: text('mime'),
  size: bigint('size', { mode: 'number' }).notNull(),
  received: bigint('received', { mode: 'number' }).notNull().default(0),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Activity feed (uploads, edits, shares…) for libraries and sites. */
export const driveActivity = pgTable(
  'drive_activity',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    libraryId: uuid('library_id')
      .notNull()
      .references(() => driveLibraries.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id'),
    itemName: text('item_name').notNull().default(''),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('drive_activity_library_idx').on(t.libraryId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// ForgeSites: intranet & wiki sites (block pages stored as TipTap JSON)
// ---------------------------------------------------------------------------

export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    color: text('color').notNull().default('#4f46e5'),
    /** organisation: everyone can read it (communication site); members: only its members. */
    visibility: text('visibility', { enum: ['organisation', 'members'] })
      .notNull()
      .default('members'),
    /** The site's document library; its permissions are the site's permissions. */
    libraryId: uuid('library_id')
      .notNull()
      .references(() => driveLibraries.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sites_slug_uq').on(t.orgId, t.slug)],
);

export const sitePages = pgTable(
  'site_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** TipTap / ProseMirror JSON document (including widget blocks). */
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    /** News posts appear in the site's news feed. */
    isNews: boolean('is_news').notNull().default(false),
    isHome: boolean('is_home').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('site_pages_slug_uq').on(t.siteId, t.slug), index('site_pages_news_idx').on(t.siteId, t.isNews, t.publishedAt)],
);

/** A column of a site list. The first column is always the item's Title. */
export interface SiteListColumn {
  /** Stable key in item values (survives renames). */
  id: string;
  name: string;
  type: 'text' | 'note' | 'number' | 'choice' | 'date' | 'boolean' | 'person' | 'link';
  required?: boolean;
  /** choice: the options; the first is the default colour order. */
  choices?: string[];
  /** date: include a time of day. */
  withTime?: boolean;
}

/**
 * Built-in columns every list has, usable in views: when each item was created
 * and last changed, and by whom.
 */
export const LIST_SYSTEM_COLUMNS = ['_created', '_modified', '_createdBy', '_modifiedBy'] as const;

export type ListFilterOp = 'eq' | 'ne' | 'contains' | 'gt' | 'ge' | 'lt' | 'le' | 'empty' | 'notEmpty';

/**
 * A saved way of looking at a list (as in SharePoint): which columns, in
 * what order, sorted, filtered and grouped how; as a table or as a board.
 * Filter values may be "[Me]" (person columns) or "[Today]" / "[Today]+7" /
 * "[Today]-30" (date columns).
 */
export interface SiteListView {
  id: string;
  name: string;
  layout: 'table' | 'board';
  /** Visible columns in order (table), or the fields shown on cards (board). */
  columns: string[];
  sort: { column: string; desc: boolean }[];
  filters: { column: string; op: ListFilterOp; value?: string | number | boolean | null }[];
  /** table: group rows by this column. */
  groupBy?: string | null;
  /** board: the choice column whose choices are the board's columns. */
  boardColumn?: string | null;
}

/** Lists (as in SharePoint): structured data on a site, with typed columns. */
export const siteLists = pgTable(
  'site_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    columns: jsonb('columns').$type<SiteListColumn[]>().notNull(),
    /** Saved views; the first is the default. Empty = one "All items" view. */
    views: jsonb('views').$type<SiteListView[]>().notNull().default([]),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('site_lists_site_idx').on(t.siteId)],
);

export const siteListItems = pgTable(
  'site_list_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listId: uuid('list_id')
      .notNull()
      .references(() => siteLists.id, { onDelete: 'cascade' }),
    /** Column id → value (string, number, boolean, ISO date, user id). */
    values: jsonb('values').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('site_list_items_list_idx').on(t.listId, t.createdAt)],
);

/** What happened to list items, for starred-item notifications. */
export const siteListActivity = pgTable(
  'site_list_activity',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    listId: uuid('list_id')
      .notNull()
      .references(() => siteLists.id, { onDelete: 'cascade' }),
    /** No foreign key: deletions are recorded too. */
    itemId: uuid('item_id').notNull(),
    itemTitle: text('item_title').notNull().default(''),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action', { enum: ['created', 'updated', 'deleted'] }).notNull(),
    /** updated: what changed, as people read it. */
    detail: jsonb('detail').$type<{ changes?: { column: string; from: string; to: string }[] }>(),
    createdAt: createdAt(),
  },
  (t) => [index('site_list_activity_item_idx').on(t.itemId, t.createdAt), index('site_list_activity_time_idx').on(t.createdAt)],
);

/**
 * Stars: documents, folders and list items someone follows. Changes made by
 * others are emailed to them, batched; `notifiedAt` is how far they have been told.
 */
export const stars = pgTable(
  'stars',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['drive_item', 'list_item'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    createdAt: createdAt(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.targetId] }), index('stars_target_idx').on(t.kind, t.targetId)],
);

export type DriveLibrary = typeof driveLibraries.$inferSelect;
export type DriveItem = typeof driveItems.$inferSelect;
export type DriveVersion = typeof driveVersions.$inferSelect;
export type DrivePermission = typeof drivePermissions.$inferSelect;
export type DriveShareLink = typeof driveShareLinks.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type SitePage = typeof sitePages.$inferSelect;
export type SiteList = typeof siteLists.$inferSelect;
export type SiteListItem = typeof siteListItems.$inferSelect;
export type Star = typeof stars.$inferSelect;
