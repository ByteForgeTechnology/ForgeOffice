import { Redis, type RedisOptions } from 'ioredis';

/** General-purpose client that fails fast instead of queueing while Redis is down. */
export function createRedis(url: string, opts: RedisOptions = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    connectTimeout: 5_000,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
    ...opts,
  });
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type { Redis };
