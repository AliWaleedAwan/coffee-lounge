/**
 * Vitest global setup for server tests: rebuilds the migrated template database once
 * per run. Test files copy it (support/db.ts), so each file starts from a clean schema.
 */
import { runMigrations as runJobQueueMigrations } from 'graphile-worker';
import pg from 'pg';
import { loadMigrations, migrate } from '../src/platform/db/migrate.ts';
import { createPool } from '../src/platform/db/pool.ts';
import { silentLogger } from '../src/worker/runner.ts';
import { adminDdl, MIGRATIONS_DIR, TEMPLATE_DB, urlFor, withAdmin } from './support/db.ts';

export default async function setup(): Promise<void> {
  await adminDdl(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await adminDdl(`CREATE DATABASE ${TEMPLATE_DB} TEMPLATE template0`);

  const client = new pg.Client({ connectionString: urlFor(TEMPLATE_DB) });
  await client.connect();
  try {
    await migrate(client, await loadMigrations(MIGRATIONS_DIR));
    const pool = createPool({ connectionString: urlFor(TEMPLATE_DB), max: 2 });
    try {
      await runJobQueueMigrations({ pgPool: pool, logger: silentLogger });
    } finally {
      await pool.end();
    }
    // Let the test login act as the application role (to test privileges, DATABASE.md §12).
    await client.query('GRANT cl_app TO CURRENT_USER WITH INHERIT FALSE, SET TRUE');
    await client.query('GRANT cl_readonly TO CURRENT_USER WITH INHERIT FALSE, SET TRUE');
    await client.query('VACUUM (FREEZE, ANALYZE)');
  } finally {
    await client.end();
  }
  // Copies need the template idle; autovacuum leaves a database that refuses connections alone
  // (unless near wraparound), so it cannot be found "in use" while files copy it.
  await withAdmin((admin) =>
    admin.query(`ALTER DATABASE ${TEMPLATE_DB} WITH ALLOW_CONNECTIONS false`),
  );
}
