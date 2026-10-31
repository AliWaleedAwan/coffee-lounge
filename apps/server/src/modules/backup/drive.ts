/**
 * The two rotating backup drives (BACKUP_RECOVERY.md §3; D-23). Each carries its own
 * identity in `CoffeeLounge\drive.json` (an id and a label, A, B, C … in the order they were
 * first plugged in), so the system knows when the drive was swapped and makes a new base
 * backup on it.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queryable } from '../../platform/db/pool.ts';
import { backupRoot } from './tools.ts';

export interface Drive {
  id: string;
  label: string;
}

/** The drive's identity, given on first sight: its label is the next letter not yet used. */
export async function identifyDrive(db: Queryable, driveRoot: string): Promise<Drive | null> {
  if (!existsSync(driveRoot)) return null;
  const file = join(backupRoot(driveRoot), 'drive.json');
  if (existsSync(file)) {
    const d = JSON.parse(readFileSync(file, 'utf8')) as Partial<Drive>;
    if (typeof d.id === 'string' && typeof d.label === 'string')
      return { id: d.id, label: d.label };
  }
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(DISTINCT drive_id)::int AS n FROM cl.backup_runs WHERE drive_id IS NOT NULL',
  );
  const drive = {
    id: randomUUID(),
    label: String.fromCharCode(65 + Math.min(25, rows[0]?.n ?? 0)),
  };
  mkdirSync(backupRoot(driveRoot), { recursive: true });
  writeFileSync(
    `${file}.tmp`,
    `${JSON.stringify({ ...drive, firstSeen: new Date().toISOString() })}\n`,
  );
  renameSync(`${file}.tmp`, file);
  return drive;
}
