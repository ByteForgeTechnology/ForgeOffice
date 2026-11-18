import type { EventEmitter } from 'node:events';
import type { FastifyRequest } from 'fastify';
import { auditLog, type Database } from '@forge/db';
import type { EventBus } from '@forge/events';

export interface AuditInput {
  action: string;
  orgId?: string | null;
  actorId?: string | null;
  actorLabel?: string | null;
  outcome?: 'success' | 'failure';
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit trail. Every write is also broadcast so the admin console
 * can show a live feed. Audit failures are logged but never break a request.
 */
export class AuditService {
  constructor(
    private readonly db: Database,
    private readonly events: EventEmitter,
    private readonly bus: EventBus | null,
    private readonly log: { error: (obj: unknown, msg?: string) => void },
  ) {}

  async record(input: AuditInput): Promise<void> {
    try {
      const [row] = await this.db
        .insert(auditLog)
        .values({
          action: input.action,
          orgId: input.orgId ?? null,
          actorId: input.actorId ?? null,
          actorLabel: input.actorLabel ?? null,
          outcome: input.outcome ?? 'success',
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          targetLabel: input.targetLabel ?? null,
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 512) ?? null,
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!row) return;
      const event = {
        id: row.id,
        orgId: row.orgId,
        action: row.action,
        actorLabel: row.actorLabel,
        outcome: row.outcome,
        createdAt: row.createdAt.toISOString(),
      };
      // Local listeners (Socket.IO, which fans out via its Redis adapter) and
      // the cross-service bus are notified independently.
      this.events.emit('audit.created', event);
      if (this.bus) await this.bus.publish('audit.created', event).catch(() => {});
    } catch (err) {
      this.log.error({ err, action: input.action }, 'failed to write audit log entry');
    }
  }

  /** Record an entry attributed to the authenticated principal of `req`. */
  fromRequest(req: FastifyRequest, input: Omit<AuditInput, 'ip' | 'userAgent'>): Promise<void> {
    const p = req.principal;
    return this.record({
      orgId: p?.orgId,
      actorId: p?.user.id,
      actorLabel: p?.user.email,
      ...input,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}
