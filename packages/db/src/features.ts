import { asc } from 'drizzle-orm';
import type { Database } from './client';
import { organizations, type Feature, type FeatureFlags } from './schema';

export const FEATURES: Feature[] = ['mail', 'calendar', 'contacts', 'tasks', 'drive'];
export const ALL_FEATURES_ON: FeatureFlags = { mail: true, calendar: true, contacts: true, tasks: true, drive: true };

let cached: { at: number; flags: FeatureFlags } | null = null;
const TTL_MS = 5_000;

/**
 * Which optional products are switched on (Admin → Organisation → Features).
 * Cached briefly: every container checks this on requests, and a change made
 * in the admin center reaches all of them within a few seconds.
 */
export async function featureFlags(db: Database): Promise<FeatureFlags> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.flags;
  const [org] = await db.select({ features: organizations.features }).from(organizations).orderBy(asc(organizations.createdAt)).limit(1);
  const flags = { ...ALL_FEATURES_ON, ...(org?.features ?? {}) };
  cached = { at: Date.now(), flags };
  return flags;
}

export async function featureEnabled(db: Database, feature: Feature): Promise<boolean> {
  return (await featureFlags(db))[feature];
}

/** Forget the cached flags (after an admin changes them in this process). */
export function resetFeatureCache() {
  cached = null;
}

export const FEATURE_NAMES: Record<Feature, string> = { mail: 'ForgeMail', calendar: 'ForgeCalendar', contacts: 'ForgeContacts', tasks: 'ForgeTasks', drive: 'ForgeDrive' };

export class FeatureDisabledError extends Error {
  constructor(readonly feature: Feature) {
    super(`${FEATURE_NAMES[feature]} is turned off for your organisation`);
    this.name = 'FeatureDisabledError';
  }
}
