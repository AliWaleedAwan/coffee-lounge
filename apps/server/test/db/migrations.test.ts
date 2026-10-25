import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, MigrationError } from '../../src/platform/db/migrate.ts';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../support/db.ts';

let db: TestDatabase | undefined;
afterEach(async () => {
  await db?.drop();
  db = undefined;
});

async function tempMigrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cl-migrations-'));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
}

describe('migration runner', () => {
  it('applies every migration to an empty database, then has nothing left to do', async () => {
    db = await createTestDatabase('empty');
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    const versions = migrations.map((m) => m.version);
    expect(versions.slice(0, 4)).toEqual(['0001', '0002', '0003', '0004']);

    expect(await migrate(db.client, migrations)).toEqual(versions);
    expect(await migrate(db.client, migrations)).toEqual([]);

    const { rows } = await db.client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM cl_meta.schema_migrations',
    );
    expect(rows[0]?.n).toBe(String(versions.length));
  });

  it('refuses to continue if an applied migration was edited afterwards', async () => {
    db = await createTestDatabase('empty');
    const dir = await tempMigrations({ '0001_one.sql': 'CREATE TABLE t1 (id int);' });
    await migrate(db.client, await loadMigrations(dir));
    await writeFile(join(dir, '0001_one.sql'), 'CREATE TABLE t1 (id bigint);');
    await expect(migrate(db.client, await loadMigrations(dir))).rejects.toThrow(/was changed/);
    await rm(dir, { recursive: true });
  });

  it('refuses if an applied migration is missing or a new one sorts before it', async () => {
    db = await createTestDatabase('empty');
    const dir = await tempMigrations({ '0002_two.sql': 'CREATE TABLE t2 (id int);' });
    await migrate(db.client, await loadMigrations(dir));

    await writeFile(join(dir, '0001_late.sql'), 'CREATE TABLE t0 (id int);');
    await expect(migrate(db.client, await loadMigrations(dir))).rejects.toThrow(/sorts before/);

    await rm(join(dir, '0002_two.sql'));
    await expect(migrate(db.client, await loadMigrations(dir))).rejects.toThrow(
      /missing from disk/,
    );
    await rm(dir, { recursive: true });
  });

  it('rolls back a failing migration completely and reports which one failed', async () => {
    db = await createTestDatabase('empty');
    const dir = await tempMigrations({
      '0001_ok.sql': 'CREATE TABLE ok (id int);',
      '0002_bad.sql': 'CREATE TABLE half (id int); SELECT * FROM does_not_exist;',
    });
    await expect(migrate(db.client, await loadMigrations(dir))).rejects.toThrow(/0002_bad failed/);
    const { rows } = await db.client.query<{ half: string | null; applied: string }>(
      `SELECT to_regclass('public.half')::text AS half,
              (SELECT string_agg(version, ',') FROM cl_meta.schema_migrations) AS applied`,
    );
    expect(rows[0]).toEqual({ half: null, applied: '0001' });
    await rm(dir, { recursive: true });
  });

  it('rejects badly named or duplicate migration files', async () => {
    const badName = await tempMigrations({ 'one.sql': 'SELECT 1;' });
    await expect(loadMigrations(badName)).rejects.toBeInstanceOf(MigrationError);
    const dup = await tempMigrations({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' });
    await expect(loadMigrations(dup)).rejects.toThrow(/Duplicate migration version 0001/);
    await rm(badName, { recursive: true });
    await rm(dup, { recursive: true });
  });
});
