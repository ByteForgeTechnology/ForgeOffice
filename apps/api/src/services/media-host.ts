import { createReadStream } from 'node:fs';
import { channels, meetings, orm, recordings, teamMessages } from '@forge/db';
import { channelAudience, postMessage, removeQuietly, serialiseMessages, type MeetingHost } from '@forge/team';
import type { AppContext } from '../context';

const { eq } = orm;

/**
 * What a media node needs from ForgeOffice: send events to sockets (through
 * the team hub: Socket.IO in this process, or the Redis emitter), record that
 * a meeting ended, and store recordings (in the team storage namespace: this
 * machine's volume, or the storage nodes).
 */
export function createMeetingHost(ctx: AppContext, log: MeetingHost['log']): MeetingHost {
  const { db } = ctx;
  const tctx = () => ({ db, drive: ctx.drive });
  return {
    log,
    emit(rooms, event, payload) {
      for (const room of rooms) ctx.team.hub.toRoom(room, event, payload);
    },

    async meetingEnded(meetingId, participants) {
      const [meeting] = await db.update(meetings).set({ endedAt: new Date() }).where(eq(meetings.id, meetingId)).returning();
      if (!meeting?.messageId) return;
      const [msg] = await db.select().from(teamMessages).where(eq(teamMessages.id, meeting.messageId)).limit(1);
      if (!msg) return;
      const durationMs = meeting.startedAt ? Date.now() - meeting.startedAt.getTime() : 0;
      const [updated] = await db
        .update(teamMessages)
        .set({ meta: { ...(msg.meta ?? {}), endedAt: new Date().toISOString(), durationMs, participants } })
        .where(eq(teamMessages.id, msg.id))
        .returning();
      const [channel] = await db.select().from(channels).where(eq(channels.id, msg.channelId)).limit(1);
      if (channel) ctx.team.hub.toUsers(await channelAudience(db, channel), 'message:updated', { message: (await serialiseMessages(db, [updated!]))[0] });
    },

    async recordingFinished({ meetingId, file, durationMs, size, startedBy }) {
      try {
        const blob = await ctx.team.recordings.put(createReadStream(file));
        const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
        const [rec] = await db.insert(recordings).values({ meetingId, path: `blob:${blob.sha256}`, size: blob.size || size, durationMs, startedBy }).returning();
        if (meeting?.channelId) {
          const [channel] = await db.select().from(channels).where(eq(channels.id, meeting.channelId)).limit(1);
          if (channel) {
            const msg = await postMessage(tctx(), channel, null, { body: '', kind: 'recording', meta: { recordingId: rec!.id, meetingId, title: meeting.title, durationMs, size: blob.size } });
            ctx.team.hub.toUsers(await channelAudience(db, channel), 'message:new', { message: msg, channel: { id: channel.id, kind: channel.kind, teamId: channel.teamId, name: channel.name } });
          }
        }
        return rec!.id;
      } finally {
        await removeQuietly(file);
      }
    },
  };
}
