import { hostname } from 'node:os';
import type { Redis } from 'ioredis';

const KEY_PREFIX = 'forge:heartbeat:';

export interface Heartbeat {
  service: string;
  instance: string;
  pid: number;
  version: string;
  startedAt: string;
  lastSeen: string;
  queues?: string[];
}

/** Periodically record that a service instance is alive (TTL = 3× interval). */
export function startHeartbeat(redis: Redis, info: { service: string; version: string; queues?: string[] }, intervalMs = 10_000): () => void {
  const instance = `${hostname()}:${process.pid}`;
  const startedAt = new Date().toISOString();
  const key = `${KEY_PREFIX}${info.service}:${instance}`;
  const beat = () => {
    const payload: Heartbeat = { ...info, instance, pid: process.pid, startedAt, lastSeen: new Date().toISOString() };
    redis.set(key, JSON.stringify(payload), 'PX', intervalMs * 3).catch(() => {});
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    redis.del(key).catch(() => {});
  };
}

export async function listHeartbeats(redis: Redis): Promise<Heartbeat[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  if (!keys.length) return [];
  const values = await redis.mget(...keys);
  return values.filter((v): v is string => !!v).map((v) => JSON.parse(v) as Heartbeat);
}

/** Cached volume scan results written by the maintenance worker. */
export const VOLUME_SCAN_KEY = 'forge:volume-scan';
export interface VolumeScan {
  scannedAt: string;
  volumes: Record<string, { bytes: number; files: number }>;
}
