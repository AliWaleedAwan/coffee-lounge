/** Helpers for platform tests: a pool on a throwaway database and a ready app. */
import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { buildApps } from '../../src/platform/app.ts';
import { createPool } from '../../src/platform/db/pool.ts';
import { Readiness } from '../../src/platform/readiness.ts';
import { createTestDatabase, urlFor, type TestDatabase } from './db.ts';

export interface PlatformFixture {
  db: TestDatabase;
  pool: pg.Pool;
  close(): Promise<void>;
}

export async function platformFixture(poolSize = 20): Promise<PlatformFixture> {
  const db = await createTestDatabase();
  const pool = createPool({ connectionString: urlFor(db.name), max: poolSize });
  return {
    db,
    pool,
    async close() {
      await pool.end();
      await db.drop();
    },
  };
}

export const TEST_CONFIG = { LOG_LEVEL: 'silent' as const };

export function readyApps(
  pool: pg.Pool,
  routes: { customer?: FastifyPluginAsync; staff?: FastifyPluginAsync } = {},
  readiness = (() => {
    const r = new Readiness();
    r.clear('startup_pending');
    return r;
  })(),
) {
  return {
    readiness,
    ...buildApps({ config: TEST_CONFIG, pool, readiness, logging: false }, routes),
  };
}
