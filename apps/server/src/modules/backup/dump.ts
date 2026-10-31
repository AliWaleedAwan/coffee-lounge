/**
 * The nightly dump (BACKUP_RECOVERY.md §1, §4; step 7.1). After the business day is closed
 * (04:35, once the ledger check and the day-end have run): `pg_dump -Fc` of the shop's data,
 * checked readable with `pg_restore --list`, encrypted to the backup public key and written
 * to the backup drive under a temporary name, then renamed and read back against its
 * checksum. The plain dump only ever exists in memory. The attached bills (FILES_DIR) are
 * copied alongside, each encrypted, only those not copied yet. Each run is a row in
 * `cl.backup_runs`, failed ones with their reason.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Queryable } from '../../platform/db/pool.ts';
import { encrypt, readRecipient, sha256 } from './keys.ts';
import { backupRoot, runTool, stampOf, writeDurably, type BackupConfig } from './tools.ts';

export { backupRoot, type BackupConfig } from './tools.ts';
import { testRestore } from './verify.ts';

function* filesUnder(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

/** Attached bills not copied yet, each encrypted to `<drive>\CoffeeLounge\files\<name>.age`. */
async function copyFiles(c: BackupConfig, recipient: string): Promise<number> {
  const target = join(backupRoot(c.driveRoot), 'files');
  let copied = 0;
  for (const file of filesUnder(c.filesDir)) {
    const out = join(target, `${relative(c.filesDir, file)}.age`);
    if (existsSync(out) && statSync(out).size > 0) continue;
    mkdirSync(join(out, '..'), { recursive: true });
    writeDurably(out, await encrypt(recipient, readFileSync(file)));
    copied += 1;
  }
  return copied;
}

export interface DumpResult {
  runId: string;
  status: 'succeeded' | 'failed';
  path: string | null;
  sizeBytes: number | null;
  filesCopied: number;
  error: string | null;
  /** The test restore, when one was made with this dump (step 7.2). */
  restoreTest?: { runId: string; ok: boolean; failed: string[] } | undefined;
}

export async function runDump(
  db: Queryable,
  c: BackupConfig,
  at: Date,
  options: { testRestore?: boolean } = {},
): Promise<DumpResult> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cl.backup_runs (kind, started_at) VALUES ('dump', $1) RETURNING id::text`,
    [at],
  );
  const runId = rows[0]?.id ?? '';
  try {
    if (!existsSync(c.driveRoot)) throw new Error('The backup drive is not plugged in');
    const recipient = readRecipient(c.publicKeyFile);
    const plain = await runTool(c, 'pg_dump', [
      '--format=custom',
      '--no-owner',
      // Grants are kept, so a restored database gives the application role what it had.
      '--schema=cl',
      '--schema=cl_meta',
      `--dbname=${c.connectionString}`,
    ]);
    // Readable: the table of contents lists the shop's tables (BACKUP_RECOVERY.md §4).
    const toc = (await runTool(c, 'pg_restore', ['--list'], plain)).toString();
    for (const table of ['invoices', 'payments', 'stock_movements', 'ledger_entries'])
      if (!toc.includes(`TABLE DATA cl ${table}`)) throw new Error(`the dump has no ${table}`);
    const sealed = await encrypt(recipient, plain);
    const dir = join(backupRoot(c.driveRoot), 'dumps');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `cl-${stampOf(at)}.dump.age`);
    writeDurably(path, sealed);
    const sum = sha256(sealed);
    if (sha256(readFileSync(path)) !== sum) throw new Error('the written dump does not read back');
    const filesCopied = await copyFiles(c, recipient);
    const restoreTest =
      options.testRestore && c.restoreTestUrl
        ? await recordTestRestore(db, c, c.restoreTestUrl, plain, runId, path, sum)
        : undefined;
    await db.query(
      `UPDATE cl.backup_runs SET status = 'succeeded', finished_at = now(), path = $2, size_bytes = $3,
              sha256 = $4, files_copied = $5, verified_at = now() WHERE id = $1`,
      [runId, path, sealed.length, sum, filesCopied],
    );
    return {
      runId,
      status: 'succeeded',
      path,
      sizeBytes: sealed.length,
      filesCopied,
      error: null,
      restoreTest,
    };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await db.query(
      `UPDATE cl.backup_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
      [runId, error],
    );
    return { runId, status: 'failed', path: null, sizeBytes: null, filesCopied: 0, error };
  }
}

/** The test restore of this dump, as its own run (AT-81); a failure is kept with what failed. */
async function recordTestRestore(
  db: Queryable,
  c: BackupConfig,
  url: string,
  plain: Buffer,
  dumpRunId: string,
  path: string,
  sum: string,
): Promise<{ runId: string; ok: boolean; failed: string[] }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cl.backup_runs (kind, source_run_id) VALUES ('restore_test', $1) RETURNING id::text`,
    [dumpRunId],
  );
  const runId = rows[0]?.id ?? '';
  let failed: string[];
  try {
    const report = await testRestore(c, url, plain);
    failed = report.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`);
  } catch (e) {
    failed = [`The restore failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`];
  }
  await db.query(
    failed.length === 0
      ? `UPDATE cl.backup_runs SET status = 'succeeded', finished_at = now(), path = $2, size_bytes = $3,
                sha256 = $4, verified_at = now() WHERE id = $1`
      : `UPDATE cl.backup_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
    failed.length === 0 ? [runId, path, plain.length, sum] : [runId, failed.join('; ')],
  );
  return { runId, ok: failed.length === 0, failed };
}
