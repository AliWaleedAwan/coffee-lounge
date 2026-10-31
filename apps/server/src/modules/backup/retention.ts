/**
 * Retention (BACKUP_RECOVERY.md §2; step 7.2), on the drive plugged in: nightly dumps 14 daily
 * + 8 weekly (Mondays) + 12 monthly (the 1st); base backups the latest 2; WAL everything newer
 * than the oldest base backup kept. Nothing is removed unless the newest dump on the drive
 * has been verified (read back against its checksum), and only files on this drive: the other
 * drive, at home, keeps its own history until it is plugged in again.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Queryable } from '../../platform/db/pool.ts';
import { backupRoot } from './tools.ts';

const KEEP = { daily: 14, weekly: 8, monthly: 12, base: 2 };
/** WAL a little older than the oldest base backup stays: it started before its label. */
const WAL_MARGIN_MS = 3600_000;

interface Kept {
  id: string;
  path: string;
  started_at: Date;
  verified: boolean;
}

/** The shop's calendar date of a moment (Asia/Karachi, UTC+5, no daylight saving). */
const shopDate = (at: Date) => new Date(at.getTime() + 5 * 3600_000).toISOString().slice(0, 10);

/** Which dumps the rules keep, newest first. */
export function dumpsToKeep(dumps: readonly { id: string; started_at: Date }[]): Set<string> {
  const keep = new Set<string>();
  const byDay = new Map<string, string>();
  for (const d of dumps) {
    const day = shopDate(d.started_at);
    if (!byDay.has(day)) byDay.set(day, d.id); // the newest of each day
  }
  const days = [...byDay.entries()];
  for (const [, id] of days.slice(0, KEEP.daily)) keep.add(id);
  const monday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() === 1;
  for (const [, id] of days.filter(([d]) => monday(d)).slice(0, KEEP.weekly)) keep.add(id);
  for (const [, id] of days.filter(([d]) => d.endsWith('-01')).slice(0, KEEP.monthly)) keep.add(id);
  return keep;
}

export interface PruneResult {
  dumps: number;
  baseBackups: number;
  walFiles: number;
  skipped: string | null;
}

export async function pruneBackups(db: Queryable, driveRoot: string): Promise<PruneResult> {
  const root = backupRoot(driveRoot);
  const result: PruneResult = { dumps: 0, baseBackups: 0, walFiles: 0, skipped: null };
  if (!existsSync(root)) return { ...result, skipped: 'the backup drive is not plugged in' };
  const onDrive = async (kind: string) =>
    (
      await db.query<Kept>(
        `SELECT id::text, path, started_at, verified_at IS NOT NULL AS verified FROM cl.backup_runs
          WHERE kind = $1 AND status = 'succeeded' AND pruned_at IS NULL AND starts_with(path, $2)
          ORDER BY started_at DESC, id DESC`,
        [kind, root],
      )
    ).rows.filter((r) => existsSync(r.path));
  const dumps = await onDrive('dump');
  if (!dumps[0]?.verified) return { ...result, skipped: 'the newest dump is not verified yet' };
  const prune = async (r: Kept, remove: string) => {
    rmSync(remove, { recursive: true, force: true });
    await db.query('UPDATE cl.backup_runs SET pruned_at = now() WHERE id = $1', [r.id]);
  };
  const keep = dumpsToKeep(dumps);
  for (const d of dumps) {
    if (keep.has(d.id)) continue;
    await prune(d, d.path);
    result.dumps += 1;
  }
  const bases = await onDrive('base_backup');
  for (const b of bases.slice(KEEP.base)) {
    await prune(b, dirname(b.path));
    result.baseBackups += 1;
  }
  const oldest = bases.slice(0, KEEP.base).at(-1);
  const walDir = join(root, 'wal');
  if (oldest && existsSync(walDir)) {
    const before = oldest.started_at.getTime() - WAL_MARGIN_MS;
    // One folder per database cluster (step 7.3), and the older flat layout.
    const pruneWal = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) pruneWal(file);
        else if (statSync(file).mtimeMs < before) {
          rmSync(file, { force: true });
          if (entry.name.endsWith('.gz.age')) result.walFiles += 1;
        }
      }
    };
    pruneWal(walDir);
  }
  return result;
}
