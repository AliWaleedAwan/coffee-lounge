/**
 * Where the backups stand (BACKUP_RECOVERY.md §4, §8; step 7.1), for the health page and the
 * banner every device shows (AT-80). A problem is raised when the drive has been missing for
 * 5 minutes (a weekly swap takes seconds, and is not one), WAL archiving keeps failing, the
 * last dump failed, or no dump has succeeded for 26 hours. Nothing is raised on a PC where
 * backups are not set up (development, tests), so the banner never cries wolf there.
 */
import { existsSync, statfsSync } from 'node:fs';
import type { Queryable } from '../../platform/db/pool.ts';

export type BackupProblem =
  'drive_missing' | 'archive_failing' | 'dump_failed' | 'restore_test_failed' | 'dump_overdue';

export interface BackupHealth {
  configured: boolean;
  usbDrivePresent: boolean;
  driveMissingSince: string | null;
  driveFreeBytes: number | null;
  lastSuccessAt: string | null;
  /** The weekly test restore (step 7.2). */
  lastVerifiedAt: string | null;
  lastDump: { at: string; status: string; error: string | null; sizeBytes: number | null } | null;
  lastTestRestore: { status: string; error: string | null } | null;
  /** The off-site copy (D-23): waiting is not a problem, only shown. */
  lastOffsite: { at: string; status: string; error: string | null } | null;
  archiver: { enabled: boolean; lastArchivedAt: string | null; lastFailedAt: string | null };
  problem: BackupProblem | null;
  message: string | null;
}

export const DRIVE_GRACE_MS = 5 * 60_000;
const DUMP_OVERDUE_MS = 26 * 3600_000;

const MESSAGES: Record<BackupProblem, string> = {
  drive_missing:
    'Backup drive missing: plug in the CL-BACKUP drive. Nothing is lost; backups wait until it is back.',
  archive_failing: 'Backups are failing: the latest changes are not being copied. See Health.',
  dump_failed: 'Last night’s backup failed. See Health.',
  restore_test_failed:
    'The weekly test restore found a problem in the backup. The owner has been told; see Health.',
  dump_overdue: 'No backup for more than a day. See Health.',
};

export class BackupWatch {
  private missingSince: Date | null = null;
  private readonly db: Queryable;
  private readonly driveRoot: string | undefined;
  private readonly publicKeyFile: string | undefined;
  private readonly now: () => Date;
  private readonly present: () => boolean;

  constructor(options: {
    db: Queryable;
    driveRoot?: string | undefined;
    publicKeyFile?: string | undefined;
    now?: () => Date;
    /** Tests replace the drive probe. */
    drivePresent?: () => boolean;
  }) {
    this.db = options.db;
    this.driveRoot = options.driveRoot;
    this.publicKeyFile = options.publicKeyFile;
    this.now = options.now ?? (() => new Date());
    this.present =
      options.drivePresent ?? (() => this.driveRoot !== undefined && existsSync(this.driveRoot));
  }

  get configured(): boolean {
    return Boolean(this.driveRoot && this.publicKeyFile && existsSync(this.publicKeyFile));
  }

  async status(): Promise<BackupHealth> {
    const now = this.now();
    const present = this.present();
    if (present) this.missingSince = null;
    else this.missingSince ??= now;
    let free: number | null = null;
    if (present && this.driveRoot) {
      try {
        const s = statfsSync(this.driveRoot);
        free = s.bavail * s.bsize;
      } catch {
        free = null;
      }
    }
    const { rows: dumps } = await this.db.query<{
      started_at: Date;
      status: string;
      error: string | null;
      size_bytes: string | null;
    }>(
      `SELECT started_at, status, error, size_bytes::text FROM cl.backup_runs
        WHERE kind = 'dump' AND status <> 'running' ORDER BY started_at DESC, id DESC LIMIT 1`,
    );
    const { rows: ok } = await this.db.query<{ at: Date | null; verified: Date | null }>(
      `SELECT (SELECT max(finished_at) FROM cl.backup_runs WHERE kind = 'dump' AND status = 'succeeded') AS at,
              (SELECT max(finished_at) FROM cl.backup_runs WHERE kind = 'restore_test' AND status = 'succeeded') AS verified`,
    );
    const { rows: arch } = await this.db.query<{
      mode: string;
      last_archived_time: Date | null;
      last_failed_time: Date | null;
    }>(
      `SELECT current_setting('archive_mode') AS mode, last_archived_time, last_failed_time FROM pg_stat_archiver`,
    );
    const a = arch[0];
    const enabled = a?.mode === 'on' || a?.mode === 'always';
    const failing =
      enabled &&
      a.last_failed_time !== null &&
      (a.last_archived_time === null || a.last_failed_time > a.last_archived_time);
    const last = dumps[0];
    const { rows: tests } = await this.db.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM cl.backup_runs WHERE kind = 'restore_test' AND status <> 'running'
        ORDER BY started_at DESC, id DESC LIMIT 1`,
    );
    const lastTest = tests[0];
    const { rows: offsite } = await this.db.query<{
      at: Date;
      status: string;
      error: string | null;
    }>(
      `SELECT COALESCE(finished_at, started_at) AS at, status, error FROM cl.backup_runs
        WHERE kind = 'offsite_copy' ORDER BY started_at DESC, id DESC LIMIT 1`,
    );
    const lastOff = offsite[0];
    const lastSuccess = ok[0]?.at ?? null;
    let problem: BackupProblem | null = null;
    if (this.configured) {
      if (this.missingSince && now.getTime() - this.missingSince.getTime() >= DRIVE_GRACE_MS)
        problem = 'drive_missing';
      else if (failing) problem = 'archive_failing';
      else if (last?.status === 'failed') problem = 'dump_failed';
      else if (lastTest?.status === 'failed') problem = 'restore_test_failed';
      else if (last && (!lastSuccess || now.getTime() - lastSuccess.getTime() > DUMP_OVERDUE_MS))
        problem = 'dump_overdue';
    }
    return {
      configured: this.configured,
      usbDrivePresent: present,
      driveMissingSince: this.missingSince?.toISOString() ?? null,
      driveFreeBytes: free,
      lastSuccessAt: lastSuccess?.toISOString() ?? null,
      lastVerifiedAt: ok[0]?.verified?.toISOString() ?? null,
      lastDump: last
        ? {
            at: last.started_at.toISOString(),
            status: last.status,
            error: last.error,
            sizeBytes: last.size_bytes === null ? null : Number(last.size_bytes),
          }
        : null,
      lastTestRestore: lastTest ? { status: lastTest.status, error: lastTest.error } : null,
      lastOffsite: lastOff
        ? { at: lastOff.at.toISOString(), status: lastOff.status, error: lastOff.error }
        : null,
      archiver: {
        enabled,
        lastArchivedAt: a?.last_archived_time?.toISOString() ?? null,
        lastFailedAt: a?.last_failed_time?.toISOString() ?? null,
      },
      problem,
      message: problem ? MESSAGES[problem] : null,
    };
  }
}
