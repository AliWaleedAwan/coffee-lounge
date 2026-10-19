/**
 * Applies pending migrations to DATABASE_URL.
 * Usage (from apps/server): corepack pnpm db:migrate
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadMigrations, migrate } from './migrate.ts';

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
} finally {
  await client.end();
}
