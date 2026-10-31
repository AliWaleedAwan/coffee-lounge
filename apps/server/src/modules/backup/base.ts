/**
 * Base backups (BACKUP_RECOVERY.md §1, §3; step 7.2): `pg_basebackup` as the backup login
 * (REPLICATION), tar with the WAL it needs (`-X fetch`), compressed and encrypted to
 * `<drive>\CoffeeLounge\base\<time>\base.tar.gz.age`. Made every Monday at 04:50 and whenever a
 * different drive is plugged in, so each drive can be restored to the latest minute with its
 * own WAL.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Queryable } from '../../platform/db/pool.ts';
import { identifyDrive } from './drive.ts';
import { backupRoot, runTool, stampOf, writeDurably, type BackupConfig } from './tools.ts';
import { encrypt, readRecipient, sha256 } from './keys.ts';

export interface BaseResult {
  runId: string;
  status: 'succeeded' | 'failed';
  path: string | null;
  error: string | null;
}

export async function runBaseBackup(
  db: Queryable,
  c: BackupConfig & { replicationUrl: string },
  at: Date,
): Promise<BaseResult> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cl.backup_runs (kind, started_at) VALUES ('base_backup', $1) RETURNING id::text`,
    [at],
  );
  const runId = rows[0]?.id ?? '';
  try {
    const drive = await identifyDrive(db, c.driveRoot);
    if (!drive) throw new Error('The backup drive is not plugged in');
    // To a private temporary folder, not standard output: on Windows pg_basebackup's output
    // through a pipe is not binary-safe (found by the restore drill, step 7.3). The folder is
    // the service account's own, and removed as soon as the backup is encrypted.
    const scratch = mkdtempSync(join(tmpdir(), 'cl-base-'));
    let tar: Buffer;
    try {
      await runTool(c, 'pg_basebackup', [
        '--format=tar',
        '--wal-method=fetch',
        '--checkpoint=fast',
        `--pgdata=${scratch}`,
        `--dbname=${c.replicationUrl}`,
      ]);
      tar = readFileSync(join(scratch, 'base.tar'));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const sealed = await encrypt(readRecipient(c.publicKeyFile), gzipSync(tar));
    const dir = join(backupRoot(c.driveRoot), 'base', stampOf(at));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'base.tar.gz.age');
    writeDurably(path, sealed);
    const sum = sha256(sealed);
    if (sha256(readFileSync(path)) !== sum)
      throw new Error('the written base backup does not read back');
    await db.query(
      `UPDATE cl.backup_runs SET status = 'succeeded', finished_at = now(), path = $2, size_bytes = $3,
              sha256 = $4, drive_id = $5, drive_label = $6, verified_at = now() WHERE id = $1`,
      [runId, path, sealed.length, sum, drive.id, drive.label],
    );
    return { runId, status: 'succeeded', path, error: null };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await db.query(
      `UPDATE cl.backup_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
      [runId, error],
    );
    return { runId, status: 'failed', path: null, error };
  }
}

/** A base backup is due when the drive plugged in has none yet (a swap, or a new drive). */
export async function baseBackupDue(db: Queryable, driveRoot: string): Promise<boolean> {
  const drive = await identifyDrive(db, driveRoot);
  if (!drive) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM cl.backup_runs WHERE kind = 'base_backup' AND status = 'succeeded'
       AND drive_id = $1 AND pruned_at IS NULL LIMIT 1`,
    [drive.id],
  );
  return rows.length === 0;
}
