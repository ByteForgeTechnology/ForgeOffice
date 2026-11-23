import type { Redis } from 'ioredis';

/** Cross-service events delivered over Redis Pub/Sub. */
export interface ForgeEvents {
  'audit.created': { id: number; orgId: string | null; action: string; actorLabel: string | null; outcome: string; createdAt: string };
  'user.updated': { userId: string; orgId: string; change: 'created' | 'updated' | 'suspended' | 'unsuspended' | 'deleted' | 'restored' | 'roles' };
  'org.updated': { orgId: string };
  'backup.updated': { backupId: string; status: string };
  'notify.user': { userId: string; title: string; body?: string; link?: string };
  /** A user's mailbox contents changed (new mail, flags, moves, expunges). */
  'mail.changed': { userId: string; mailboxId?: string };
  'calendar.changed': { userIds: string[] };
}

export type ForgeEventName = keyof ForgeEvents;

const CHANNEL_PREFIX = 'forge:events:';

export class EventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  private subscribed = false;

  /** `pub` is used for publishing; `sub` must be a dedicated connection. */
  constructor(
    private readonly pub: Redis,
    private readonly sub?: Redis,
  ) {}

  async publish<E extends ForgeEventName>(event: E, payload: ForgeEvents[E]): Promise<void> {
    await this.pub.publish(CHANNEL_PREFIX + event, JSON.stringify(payload));
  }

  async on<E extends ForgeEventName>(event: E, handler: (payload: ForgeEvents[E]) => void): Promise<() => void> {
    if (!this.sub) throw new Error('EventBus was created without a subscriber connection');
    if (!this.subscribed) {
      this.subscribed = true;
      this.sub.on('message', (channel: string, message: string) => {
        const set = this.handlers.get(channel);
        if (!set) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          return;
        }
        for (const h of set) h(parsed);
      });
    }
    const channel = CHANNEL_PREFIX + event;
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(handler as (p: unknown) => void);
    return () => set!.delete(handler as (p: unknown) => void);
  }
}
