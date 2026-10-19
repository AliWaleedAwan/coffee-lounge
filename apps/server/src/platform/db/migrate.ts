/**
 * Forward-only SQL migrations (DATABASE.md §1, WINDOWS_DEPLOYMENT.md §7).
 *
 * Files are named `NNNN_description.sql` and applied in order, each in its own
 * transaction. A checksum of every applied file is stored; if an applied file is
 * later edited or removed, or a new file sorts before the last applied one, the
 * runner refuses to continue rather than silently diverging from the database.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from 'pg';

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Arbitrary constant key so concurrent runs wait for each other. */
const ADVISORY_LOCK_KEY = 4_206_101_920;

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match?.[1] || !match[2]) {
      throw new MigrationError(`Migration file name must look like 0001_name.sql: ${file}`);
    }
    const sql = await readFile(join(dir, file), 'utf8');
    migrations.push({ version: match[1], name: match[2], sql, checksum: checksumOf(sql) });
  }
  const versions = new Set<string>();
  for (const m of migrations) {
    if (versions.has(m.version))
      throw new MigrationError(`Duplicate migration version ${m.version}`);
    versions.add(m.version);
  }
  return migrations;
}

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
}

/** Applies pending migrations; returns the versions applied in this run. */
export async function migrate(client: Client, migrations: Migration[]): Promise<string[]> {
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS cl_meta');
    await client.query(`
      CREATE TABLE IF NOT EXISTS cl_meta.schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows: applied } = await client.query<AppliedRow>(
      'SELECT version, name, checksum FROM cl_meta.schema_migrations ORDER BY version',
    );

    const byVersion = new Map(migrations.map((m) => [m.version, m]));
    for (const row of applied) {
      const file = byVersion.get(row.version);
      if (!file) {
        throw new MigrationError(
          `Applied migration ${row.version}_${row.name} is missing from disk`,
        );
      }
      if (file.checksum !== row.checksum) {
        throw new MigrationError(
          `Applied migration ${row.version}_${row.name} was changed after it ran; add a new migration instead`,
        );
      }
    }

    const lastApplied = applied.at(-1)?.version ?? '';
    const appliedVersions = new Set(applied.map((r) => r.version));
    const pending = migrations.filter((m) => !appliedVersions.has(m.version));
    const outOfOrder = pending.find((m) => m.version < lastApplied);
    if (outOfOrder) {
      throw new MigrationError(
        `Migration ${outOfOrder.version}_${outOfOrder.name} sorts before already-applied ${lastApplied}`,
      );
    }

    const done: string[] = [];
    for (const m of pending) {
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          'INSERT INTO cl_meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        const reason = error instanceof Error ? error.message : String(error);
        throw new MigrationError(`Migration ${m.version}_${m.name} failed: ${reason}`);
      }
      done.push(m.version);
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}
