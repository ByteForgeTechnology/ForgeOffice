import type { TypedQueue } from '@forge/events';
import type { MailContext, OutboundScheduler } from './context';
import { MAX_DELIVERY_ATTEMPTS, processOutbound } from './outbound';

const jobId = (id: string) => `out-${id}`;

/** Durable scheduling on the BullMQ "mail-delivery" queue (production). */
export class QueueScheduler implements OutboundScheduler {
  constructor(private readonly queue: TypedQueue<'mail-delivery'>) {}

  async schedule(outboundId: string, delayMs: number) {
    await this.queue.add(
      'deliver',
      { outboundId },
      { jobId: jobId(outboundId), delay: delayMs, attempts: MAX_DELIVERY_ATTEMPTS, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: { age: 7 * 86400 } },
    );
  }

  async cancel(outboundId: string) {
    const job = await this.queue.getJob(jobId(outboundId));
    if (!job) return false;
    const state = await job.getState();
    if (state !== 'delayed' && state !== 'waiting' && state !== 'prioritized') return false;
    await job.remove();
    return true;
  }
}

/**
 * In-process timers for development without Redis. Not durable: pending
 * sends are lost on restart.
 */
export class InlineScheduler implements OutboundScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(private readonly ctx: () => MailContext) {}

  async schedule(outboundId: string, delayMs: number, attempt = 1) {
    const timer = setTimeout(async () => {
      this.timers.delete(outboundId);
      try {
        const final = attempt >= 3;
        const { retry } = await processOutbound(this.ctx(), outboundId, { number: attempt, final });
        if (retry && !final) await this.schedule(outboundId, 30_000 * attempt, attempt + 1);
      } catch (err) {
        this.ctx().log.error({ err, outboundId }, 'inline delivery failed');
      }
    }, delayMs);
    timer.unref?.();
    this.timers.set(outboundId, timer);
  }

  async cancel(outboundId: string) {
    const t = this.timers.get(outboundId);
    if (!t) return false;
    clearTimeout(t);
    this.timers.delete(outboundId);
    return true;
  }

  /** Test helper: wait until nothing is scheduled. */
  get pending() {
    return this.timers.size;
  }
}
