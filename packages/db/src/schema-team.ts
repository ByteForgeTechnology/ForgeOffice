import { sql } from 'drizzle-orm';
import { bigint, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { groups, organizations, users } from './schema';

// ---------------------------------------------------------------------------
// ForgeTeam (Microsoft Teams equivalent). A team is a security group (so its
// members, owners and document library are the group's); channels and chats
// hold messages; meetings run on the SFU in the team service.
// ---------------------------------------------------------------------------

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Members and owners are this group's; its document library is the team's files. */
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    color: text('color').notNull().default('#4f46e5'),
    /** public: anyone in the organisation can find and join it; private: owners add people. */
    visibility: text('visibility', { enum: ['public', 'private'] })
      .notNull()
      .default('private'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('teams_group_uq').on(t.groupId), index('teams_org_idx').on(t.orgId)],
);

/**
 * Where messages are posted: a team's channels (standard: every team member;
 * private: listed members) and chats outside teams (dm: two people; group:
 * a few people).
 */
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['standard', 'private', 'dm', 'group'] }).notNull(),
    name: text('name').notNull().default(''),
    description: text('description').notNull().default(''),
    /** The channel's folder in the team's document library (files shared in it). */
    folderId: uuid('folder_id'),
    /** dm: the two people, sorted, so a pair has one chat. */
    dmKey: text('dm_key'),
    isGeneral: integer('is_general').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('channels_team_idx').on(t.teamId), uniqueIndex('channels_dm_uq').on(t.orgId, t.dmKey)],
);

/**
 * Per person and channel: membership (private channels and chats), read
 * position and notification level. Standard channels get a row the first time
 * someone reads one or changes its notifications.
 */
export const channelMembers = pgTable(
  'channel_members',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** For private channels and chats: whether they belong (standard channels: always "member"). */
    role: text('role', { enum: ['owner', 'member'] })
      .notNull()
      .default('member'),
    /** null: the default (chats: every message; channels: mentions only). */
    notify: text('notify', { enum: ['all', 'mentions', 'muted'] }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
    /** Hidden from the chat list until a new message arrives. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] }), index('channel_members_user_idx').on(t.userId)],
);

export interface MessageAttachment {
  itemId: string;
  name: string;
  size: number;
  mime: string | null;
}

export const teamMessages = pgTable(
  'team_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** A reply in a thread: the thread's first message. */
    parentId: uuid('parent_id'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** message: written by someone; meeting / recording / system: posted by ForgeTeam. */
    kind: text('kind', { enum: ['message', 'meeting', 'recording', 'system'] })
      .notNull()
      .default('message'),
    /** Markdown, with mentions as <@user-id>. */
    body: text('body').notNull().default(''),
    mentions: jsonb('mentions').$type<string[]>().notNull().default([]),
    attachments: jsonb('attachments').$type<MessageAttachment[]>().notNull().default([]),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    replyCount: integer('reply_count').notNull().default(0),
    lastReplyAt: timestamp('last_reply_at', { withTimezone: true }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    searchVector: tsvector('search_vector').generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, coalesce(left(body, 100000), ''))`),
  },
  (t) => [index('team_messages_channel_idx').on(t.channelId, t.parentId, t.createdAt), index('team_messages_parent_idx').on(t.parentId, t.createdAt), index('team_messages_search_idx').using('gin', t.searchVector)],
);

export const teamMessageReactions = pgTable(
  'team_message_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => teamMessages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

/**
 * Meetings: started from a channel ("Meet now"), or from a calendar event's
 * meeting link (/team/meet/<code>). The room itself lives in the SFU while
 * people are in it.
 */
export const meetings = pgTable(
  'team_meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    /** The channel message announcing it (updated when it ends). */
    messageId: uuid('message_id'),
    title: text('title').notNull().default('Meeting'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('team_meetings_code_uq').on(t.code)],
);

export const recordings = pgTable('team_recordings', {
  id: uuid('id').primaryKey().defaultRandom(),
  meetingId: uuid('meeting_id')
    .notNull()
    .references(() => meetings.id, { onDelete: 'cascade' }),
  /** Relative to forge_team_media. */
  path: text('path').notNull(),
  size: bigint('size', { mode: 'number' }).notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/** Status someone set themselves (Busy, Do not disturb, Appear away…), until a time. */
export const userPresence = pgTable('user_presence', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['available', 'busy', 'dnd', 'away', 'offline'] }),
  until: timestamp('until', { withTimezone: true }),
  message: text('message').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Team = typeof teams.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type ChannelMember = typeof channelMembers.$inferSelect;
export type TeamMessage = typeof teamMessages.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type Recording = typeof recordings.$inferSelect;
