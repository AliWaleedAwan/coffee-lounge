/**
 * Applies pending migrations to DATABASE_URL.
 * Usage (from apps/server): corepack pnpm db:migrate
 */
import { fileURLToPath } from 'node:url';
import { runMigrations as runJobQueueMigrations } from 'graphile-worker';
import pg from 'pg';
import { loadMigrations, migrate } from './migrate.ts';
import { adoptJobQueue } from '../jobs.ts';
import { createPool } from './pool.ts';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example).');
  process.exit(1);
}

const migrationsDir = fileURLToPath(new URL('../../../migrations', import.meta.url));
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrate(client, await loadMigrations(migrationsDir));
  console.log(
    applied.length > 0 ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date.',
  );
  // The job queue keeps its own schema (graphile_worker), installed and upgraded here too.
  const pool = createPool({ connectionString: url, max: 2 });
  try {
    await runJobQueueMigrations({ pgPool: pool });
    await adoptJobQueue(pool);
    console.log('Job queue schema is up to date.');
  } finally {
    await pool.end();
  }
} finally {
  await client.end();
}
