import type { Job } from 'bullmq';
import { processVersion, scanVersion, type DriveContext } from '@forge/drive';
import type { JobData, TypedQueue } from '@forge/events';

/** Virus-scan a new file version; clean (or unscanned) files go on to thumbnails and text extraction. */
export function createScanProcessor(ctx: DriveContext, thumbnails: TypedQueue<'thumbnails'>) {
  return async (job: Job<JobData<'virus-scan', 'scan'>>) => {
    const verdict = await scanVersion(ctx, job.data);
    if (verdict !== 'infected' && verdict !== 'gone') await thumbnails.add('generate', job.data);
    return { verdict };
  };
}

/** WebP thumbnail and searchable text for a file version. */
export function createThumbnailProcessor(ctx: DriveContext) {
  return async (job: Job<JobData<'thumbnails', 'generate'>>) => processVersion(ctx, job.data);
}
