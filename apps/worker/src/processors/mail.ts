import type { Job } from 'bullmq';
import { processOutbound, type MailContext } from '@forge/mail';
import type { JobData } from '@forge/events';

/** Deliver one outbound message; throwing makes BullMQ retry deferred recipients with backoff. */
export function createMailDeliveryProcessor(ctx: MailContext) {
  return async (job: Job<JobData<'mail-delivery', 'deliver'>>) => {
    const attempt = job.attemptsMade + 1;
    const final = attempt >= (job.opts.attempts ?? 1);
    const result = await processOutbound(ctx, job.data.outboundId, { number: attempt, final });
    if (result.retry && !final) throw new Error('Some recipients were deferred; retrying later');
    return result;
  };
}
