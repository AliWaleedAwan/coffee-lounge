/**
 * Vitest global setup for server tests: rebuilds the migrated template database once
 * per run. Test files copy it (support/db.ts), so each file starts from a clean schema.
 */
import pg from 'pg';
import { loadMigrations, migrate } from '../src/platform/db/migrate.ts';
import { MIGRATIONS_DIR, TEMPLATE_DB, urlFor, withAdmin } from './support/db.ts';

export default async function setup(): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB} TEMPLATE template0`);
  });

  const client = new pg.Client({ connectionString: urlFor(TEMPLATE_DB) });
  await client.connect();
  try {
    await migrate(client, await loadMigrations(MIGRATIONS_DIR));
    // Let the test login act as the application role (to test privileges, DATABASE.md §12).
    await client.query('GRANT cl_app TO CURRENT_USER WITH INHERIT FALSE, SET TRUE');
    await client.query('GRANT cl_readonly TO CURRENT_USER WITH INHERIT FALSE, SET TRUE');
  } finally {
    await client.end();
  }
}
