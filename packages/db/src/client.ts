import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as coreSchema from './schema';
import * as mailSchema from './schema-mail';

const schema = { ...coreSchema, ...mailSchema };

export { schema };

/**
 * Driver-agnostic Drizzle database handle. Production uses postgres.js;
 * tests and single-binary dev mode use PGlite (embedded Postgres in WASM).
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: Database;
  driver: 'postgres' | 'pglite';
  /** Run migrations from a drizzle-kit output folder. */
  migrate(migrationsFolder: string): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connect using a URL:
 *   postgres://user:pass@host:5432/db  → PostgreSQL via postgres.js
 *   pglite://memory                     → in-memory PGlite (tests)
 *   pglite:///absolute/path             → PGlite persisted to a directory (dev)
 */
export async function connectDatabase(url: string, opts: { max?: number } = {}): Promise<DatabaseHandle> {
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const rest = url.slice('pglite:'.length).replace(/^\/\//, '');
    const client = rest === 'memory' || rest === '' ? new PGlite() : new PGlite(rest);
    const db = drizzle(client, { schema });
    return {
      db: db as unknown as Database,
      driver: 'pglite',
      migrate: (folder) => migrate(db, { migrationsFolder: folder }),
      ping: async () => {
        await client.query('select 1');
      },
      close: () => client.close(),
    };
  }

  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Database,
    driver: 'postgres',
    migrate: (folder) => migrate(db, { migrationsFolder: folder }),
    ping: async () => {
      await client`select 1`;
    },
    close: () => client.end({ timeout: 5 }),
  };
}
