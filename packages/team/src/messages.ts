import { channelMembers, channels, driveItems, teamMessageReactions, teamMessages, orm, users, type Channel, type Database, type MessageAttachment, type TeamMessage } from '@forge/db';
import { principalFor, requireItem } from '@forge/drive';
import { TeamError, channelAudience, shareWithChat, type TeamCtx } from './teams';

const { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } = orm;

export const MAX_MESSAGE_LENGTH = 28_000;
const MENTION = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

/** People mentioned as <@id> who can read the conversation. */
export async function mentionsIn(db: Database, channel: Channel, body: string) {
  const ids = [...new Set([...body.matchAll(MENTION)].map((m) => m[1]!.toLowerCase()))];
  if (!ids.length) return [];
  const audience = new Set(await channelAudience(db, channel));
  return ids.filter((id) => audience.has(id));
}

export interface SerialisedMessage {
  id: string;
  channelId: string;
  parentId: string | null;
  kind: TeamMessage['kind'];
  author: { id: string; name: string; avatarUrl: string | null } | null;
  body: string;
  mentions: string[];
  attachments: MessageAttachment[];
  meta: Record<string, unknown> | null;
  reactions: { emoji: string; count: number; userIds: string[] }[];
  replyCount: number;
  lastReplyAt: Date | null;
  editedAt: Date | null;
  deleted: boolean;
  createdAt: Date;
}

export async function serialiseMessages(db: Database, rows: TeamMessage[]): Promise<SerialisedMessage[]> {
  if (!rows.length) return [];
  const authorIds = [...new Set(rows.map((r) => r.authorId).filter(Boolean) as string[])];
  const people = authorIds.length ? await db.select({ id: users.id, name: users.displayName, avatarSha: users.avatarSha }).from(users).where(inArray(users.id, authorIds)) : [];
  const avatar = (p?: { id: string; avatarSha: string | null }) => (p?.avatarSha ? `/api/v1/avatars/${p.id}?v=${p.avatarSha.slice(0, 12)}` : null);
  const reactions = await db.select().from(teamMessageReactions).where(inArray(teamMessageReactions.messageId, rows.map((r) => r.id))).orderBy(asc(teamMessageReactions.createdAt));
  return rows.map((r) => {
    const mine = reactions.filter((x) => x.messageId === r.id);
    const grouped = new Map<string, string[]>();
    for (const x of mine) grouped.set(x.emoji, [...(grouped.get(x.emoji) ?? []), x.userId]);
    const deleted = !!r.deletedAt;
    return {
      id: r.id,
      channelId: r.channelId,
      parentId: r.parentId,
      kind: r.kind,
      author: r.authorId ? { id: r.authorId, name: people.find((p) => p.id === r.authorId)?.name ?? 'Someone', avatarUrl: avatar(people.find((p) => p.id === r.authorId)) } : null,
      body: deleted ? '' : r.body,
      mentions: deleted ? [] : r.mentions,
      attachments: deleted ? [] : r.attachments,
      meta: r.meta ?? null,
      reactions: deleted ? [] : [...grouped].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds })),
      replyCount: r.replyCount,
      lastReplyAt: r.lastReplyAt,
      editedAt: r.editedAt,
      deleted,
      createdAt: r.createdAt,
    };
  });
}

/** Top-level messages, newest last; page back with `before`. */
export async function listMessages(db: Database, channelId: string, opts: { before?: Date; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = await db
    .select()
    .from(teamMessages)
    .where(and(eq(teamMessages.channelId, channelId), isNull(teamMessages.parentId), opts.before ? lt(teamMessages.createdAt, opts.before) : undefined))
    .orderBy(desc(teamMessages.createdAt))
    .limit(limit + 1);
  return { items: await serialiseMessages(db, rows.slice(0, limit).reverse()), more: rows.length > limit };
}

export async function listReplies(db: Database, parentId: string) {
  const rows = await db.select().from(teamMessages).where(eq(teamMessages.parentId, parentId)).orderBy(asc(teamMessages.createdAt)).limit(1000);
  return serialiseMessages(db, rows);
}

/** Attachments are Drive files the sender can open (uploaded to the conversation's folder first). */
async function checkAttachments(ctx: TeamCtx, userId: string, itemIds: string[]): Promise<MessageAttachment[]> {
  if (itemIds.length > 20) throw new TeamError(400, 'Attach up to 20 files');
  const p = await principalFor(ctx.db, userId);
  const out: MessageAttachment[] = [];
  for (const id of [...new Set(itemIds)]) {
    const { item } = await requireItem(ctx.db, p, id, 'viewer').catch(() => {
      throw new TeamError(400, 'You can only attach files you can open', 'bad_attachment');
    });
    out.push({ itemId: item.id, name: item.name, size: item.size, mime: item.mime });
  }
  return out;
}

export async function postMessage(
  ctx: TeamCtx,
  channel: Channel,
  author: { id: string } | null,
  input: { body: string; parentId?: string | null; attachments?: string[]; kind?: TeamMessage['kind']; meta?: Record<string, unknown> },
) {
  const body = input.body.trim();
  const kind = input.kind ?? 'message';
  const attachments = author && input.attachments?.length ? await checkAttachments(ctx, author.id, input.attachments) : [];
  if (kind === 'message' && !body && !attachments.length) throw new TeamError(400, 'Write a message');
  if (body.length > MAX_MESSAGE_LENGTH) throw new TeamError(400, 'That message is too long');
  let parent: TeamMessage | undefined;
  if (input.parentId) {
    [parent] = await ctx.db.select().from(teamMessages).where(and(eq(teamMessages.id, input.parentId), eq(teamMessages.channelId, channel.id))).limit(1);
    if (!parent || parent.parentId) throw new TeamError(400, 'Reply to a message in this conversation');
    if (parent.deletedAt) throw new TeamError(400, 'That message was deleted');
  }
  const mentions = await mentionsIn(ctx.db, channel, body);
  const [msg] = await ctx.db
    .insert(teamMessages)
    .values({ channelId: channel.id, parentId: parent?.id ?? null, authorId: author?.id ?? null, kind, body, mentions, attachments, meta: input.meta ?? null })
    .returning();
  if (parent) await ctx.db.update(teamMessages).set({ replyCount: sql`${teamMessages.replyCount} + 1`, lastReplyAt: msg!.createdAt }).where(eq(teamMessages.id, parent.id));
  await ctx.db.update(channels).set({ lastMessageAt: msg!.createdAt }).where(eq(channels.id, channel.id));
  // A new message brings a hidden chat back; the sender has read up to here.
  await ctx.db.update(channelMembers).set({ hiddenAt: null }).where(eq(channelMembers.channelId, channel.id));
  if (author) await markRead(ctx.db, channel.id, author.id, msg!.createdAt);
  if (author && attachments.length) await shareWithChat(ctx, channel, attachments.map((a) => a.itemId), author.id);
  const [serialised] = await serialiseMessages(ctx.db, [msg!]);
  return serialised!;
}

export async function loadMessage(db: Database, channelId: string, id: string) {
  const [msg] = await db.select().from(teamMessages).where(and(eq(teamMessages.id, id), eq(teamMessages.channelId, channelId))).limit(1);
  if (!msg) throw new TeamError(404, 'Message not found', 'not_found');
  return msg;
}

export async function editMessage(ctx: TeamCtx, channel: Channel, msg: TeamMessage, userId: string, body: string) {
  if (msg.authorId !== userId || msg.kind !== 'message') throw new TeamError(403, 'You can only edit your own messages', 'forbidden');
  if (msg.deletedAt) throw new TeamError(400, 'That message was deleted');
  const text = body.trim();
  if (!text && !msg.attachments.length) throw new TeamError(400, 'Write a message');
  if (text.length > MAX_MESSAGE_LENGTH) throw new TeamError(400, 'That message is too long');
  const [updated] = await ctx.db.update(teamMessages).set({ body: text, mentions: await mentionsIn(ctx.db, channel, text), editedAt: new Date() }).where(eq(teamMessages.id, msg.id)).returning();
  return (await serialiseMessages(ctx.db, [updated!]))[0]!;
}

/** Authors delete their own messages; channel managers (team owners) can delete any. */
export async function deleteMessage(ctx: TeamCtx, msg: TeamMessage, userId: string, canModerate: boolean) {
  if (msg.authorId !== userId && !canModerate) throw new TeamError(403, 'You can only delete your own messages', 'forbidden');
  const [updated] = await ctx.db.update(teamMessages).set({ deletedAt: new Date(), body: '', attachments: [], mentions: [] }).where(eq(teamMessages.id, msg.id)).returning();
  await ctx.db.delete(teamMessageReactions).where(eq(teamMessageReactions.messageId, msg.id));
  return (await serialiseMessages(ctx.db, [updated!]))[0]!;
}

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '👀', '✅', '🙏', '🔥'];

export async function react(ctx: TeamCtx, msg: TeamMessage, userId: string, emoji: string, on: boolean) {
  if (!/^\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u.test(emoji) || emoji.length > 16) throw new TeamError(400, 'Choose an emoji');
  if (msg.deletedAt) throw new TeamError(400, 'That message was deleted');
  if (on) await ctx.db.insert(teamMessageReactions).values({ messageId: msg.id, userId, emoji }).onConflictDoNothing();
  else await ctx.db.delete(teamMessageReactions).where(and(eq(teamMessageReactions.messageId, msg.id), eq(teamMessageReactions.userId, userId), eq(teamMessageReactions.emoji, emoji)));
  return (await serialiseMessages(ctx.db, [msg]))[0]!;
}

// ---------------------------------------------------------------------------
// Read state, notification levels, unread counts
// ---------------------------------------------------------------------------

export async function markRead(db: Database, channelId: string, userId: string, at = new Date()) {
  await db
    .insert(channelMembers)
    .values({ channelId, userId, lastReadAt: at })
    .onConflictDoUpdate({ target: [channelMembers.channelId, channelMembers.userId], set: { lastReadAt: sql`greatest(${channelMembers.lastReadAt}, excluded.last_read_at)` } });
}

/** The notification level in effect: someone's choice, or the default for the conversation. */
export const notifyLevel = (channel: Pick<Channel, 'kind'>, chosen: 'all' | 'mentions' | 'muted' | null | undefined) => chosen ?? (channel.kind === 'dm' || channel.kind === 'group' ? 'all' : 'mentions');

export async function setNotify(db: Database, channelId: string, userId: string, notify: 'all' | 'mentions' | 'muted' | null) {
  await db.insert(channelMembers).values({ channelId, userId, notify }).onConflictDoUpdate({ target: [channelMembers.channelId, channelMembers.userId], set: { notify } });
}

/**
 * Unread messages and mentions per conversation for one person: messages by
 * others after their read position (people new to a standard channel start
 * from when they joined the team: nothing is unread yet).
 */
export async function unreadCounts(db: Database, userId: string, channelIds: string[]) {
  type Counts = { unread: number; mentions: number; notify: 'all' | 'mentions' | 'muted' | null; lastReadAt: Date | null };
  if (!channelIds.length) return new Map<string, Counts>();
  const reads = await db.select().from(channelMembers).where(and(eq(channelMembers.userId, userId), inArray(channelMembers.channelId, channelIds)));
  const rows = await db
    .select({
      channelId: teamMessages.channelId,
      unread: sql<number>`count(*)::int`,
      mentions: sql<number>`count(*) filter (where ${teamMessages.mentions} ? ${userId})::int`,
    })
    .from(teamMessages)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, teamMessages.channelId), eq(channelMembers.userId, userId)))
    .where(
      and(
        inArray(teamMessages.channelId, channelIds),
        isNull(teamMessages.deletedAt),
        or(isNull(teamMessages.authorId), ne(teamMessages.authorId, userId)),
        // A channel never opened: messages from the last 14 days count as new.
        gt(teamMessages.createdAt, sql`coalesce(${channelMembers.lastReadAt}, now() - interval '14 days')`),
      ),
    )
    .groupBy(teamMessages.channelId);
  const out = new Map<string, Counts>();
  for (const id of channelIds) {
    const r = reads.find((x) => x.channelId === id);
    const c = rows.find((x) => x.channelId === id);
    out.set(id, { unread: c?.unread ?? 0, mentions: c?.mentions ?? 0, notify: r?.notify ?? null, lastReadAt: r?.lastReadAt ?? null });
  }
  return out;
}

/** Search messages in conversations someone can read. */
export async function searchMessages(db: Database, channelIds: string[], q: string, limit = 30) {
  if (!channelIds.length || !q.trim()) return [];
  const rows = await db
    .select()
    .from(teamMessages)
    .where(and(inArray(teamMessages.channelId, channelIds), isNull(teamMessages.deletedAt), sql`${teamMessages.searchVector} @@ plainto_tsquery('simple', ${q.trim()})`))
    .orderBy(desc(teamMessages.createdAt))
    .limit(limit);
  return serialiseMessages(db, rows);
}

/** Who to tell about a new message, and how loudly. */
export async function notificationTargets(db: Database, channel: Channel, msg: Pick<SerialisedMessage, 'author' | 'mentions'>) {
  const audience = await channelAudience(db, channel);
  const prefs = audience.length ? await db.select().from(channelMembers).where(and(eq(channelMembers.channelId, channel.id), inArray(channelMembers.userId, audience))) : [];
  return audience
    .filter((id) => id !== msg.author?.id)
    .map((id) => {
      const notify = notifyLevel(channel, prefs.find((p) => p.userId === id)?.notify);
      const mentioned = msg.mentions.includes(id);
      return { userId: id, alert: notify === 'muted' ? mentioned : notify === 'all' || mentioned, mentioned };
    });
}

/** Attachments still pointing at files that exist (for the files tab). */
export async function liveAttachments(db: Database, itemIds: string[]) {
  if (!itemIds.length) return new Set<string>();
  return new Set((await db.select({ id: driveItems.id }).from(driveItems).where(and(inArray(driveItems.id, itemIds), isNull(driveItems.deletedAt)))).map((r) => r.id));
}
