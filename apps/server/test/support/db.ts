/**
 * Test databases (TEST_PLAN.md §1, §2 level I): a template database is migrated once
 * per run by global-setup.ts; every test file gets its own copy and drops it afterwards.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const TEMPLATE_DB = 'coffee_lounge_test_template';
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Loads the repository's .env once if the test database URL is not already set. */
export function baseUrl(): string {
  if (!process.env['TEST_DATABASE_URL']) {
    process.loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
  }
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
  return url;
}

export function urlFor(database: string): string {
  const url = new URL(baseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

/** Runs fn with a client on the maintenance database (coffee_lounge_test). */
export async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: baseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Runs a CREATE/DROP DATABASE statement, retrying for a few seconds while another backend
 * (typically autovacuum, which the test login may not terminate) is using the database.
 */
export async function adminDdl(sql: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await withAdmin((admin) => admin.query(sql));
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const busy = code === '55006' || (code === '42501' && /terminate/.test(String(error)));
      if (!busy || attempt >= 20) throw error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export interface TestDatabase {
  name: string;
  client: pg.Client;
  /** Opens another connection to the same database (for concurrency tests). */
  connect(): Promise<pg.Client>;
  drop(): Promise<void>;
}

/** Creates a database copied from the migrated template, or an empty one. */
export async function createTestDatabase(
  kind: 'migrated' | 'empty' = 'migrated',
): Promise<TestDatabase> {
  const name = `cl_t_${randomBytes(6).toString('hex')}`;
  const template = kind === 'migrated' ? TEMPLATE_DB : 'template0';
  await adminDdl(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  const extra: pg.Client[] = [];
  const open = async (): Promise<pg.Client> => {
    const c = new pg.Client({ connectionString: urlFor(name) });
    await c.connect();
    return c;
  };
  const client = await open();
  return {
    name,
    client,
    async connect() {
      const c = await open();
      extra.push(c);
      return c;
    },
    async drop() {
      await Promise.all([client, ...extra].map((c) => c.end().catch(() => undefined)));
      await adminDdl(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}
