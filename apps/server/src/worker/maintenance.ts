/**
 * Worker housekeeping: heartbeat (WINDOWS_DEPLOYMENT.md §2) and pruning of expired
 * idempotency keys (API.md §3: 24 h) and old live-update hints (API.md §7: 24 h).
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { Queryable } from '../platform/db/pool.ts';

export const OUTBOX_RETENTION_HOURS = 24;
export const HEARTBEAT_INTERVAL_MS = 15_000;

export async function pruneIdempotencyKeys(db: Queryable): Promise<number> {
  const result = await db.query('DELETE FROM cl.idempotency_keys WHERE expires_at < now()');
  return result.rowCount ?? 0;
}

export async function pruneOutbox(
  db: Queryable,
  retentionHours = OUTBOX_RETENTION_HOURS,
): Promise<number> {
  const result = await db.query(
    'DELETE FROM cl.outbox_events WHERE created_at < now() - make_interval(hours => $1)',
    [retentionHours],
  );
  return result.rowCount ?? 0;
}

export class Heartbeat {
  private readonly pool: pg.Pool;
  private readonly name: string;
  private readonly version: string;
  private readonly startedAt = new Date();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(pool: pg.Pool, name: string, version: string) {
    this.pool = pool;
    this.name = name;
    this.version = version;
  }

  async beat(): Promise<void> {
    await this.pool.query(
      `INSERT INTO cl.worker_heartbeats (worker_name, pid, version, started_at, beat_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (worker_name) DO UPDATE
         SET pid = EXCLUDED.pid, version = EXCLUDED.version,
             started_at = EXCLUDED.started_at, beat_at = now()`,
      [this.name, process.pid, this.version, this.startedAt],
    );
  }

  start(onError: (error: unknown) => void, intervalMs = HEARTBEAT_INTERVAL_MS): void {
    const tick = () => {
      this.inFlight = this.beat().catch(onError);
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  /** Stops beating; resolves once a beat already being written has finished. */
  stop(): Promise<void> {
    clearInterval(this.timer);
    return this.inFlight;
  }
}

export const LOG_RETENTION_DAYS = 30;

/**
 * W-3 (WINDOWS_DEPLOYMENT.md §8): the service wrapper rolls logs daily but never deletes
 * them. Deletes files in the log folder not written to for `days`. Only plain files at
 * the top of the folder; nothing outside it.
 */
export async function pruneLogs(
  dir: string,
  now: Date,
  days = LOG_RETENTION_DAYS,
): Promise<number> {
  const cutoff = now.getTime() - days * 86_400_000;
  let removed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(dir, entry.name);
    if ((await stat(file)).mtimeMs < cutoff) {
      await rm(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}

/**
 * Releases job and queue locks left by a worker that was killed mid-job (a service stop
 * during uninstall or upgrade). The shop runs one worker service, so at its start-up every
 * lock is stale. Without this, graphile-worker keeps the queue (e.g. a printer's) locked
 * for 4 hours and nothing on it runs.
 */
export async function releaseStaleLocks(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `WITH j AS (
       UPDATE graphile_worker._private_jobs
          SET locked_at = NULL, locked_by = NULL
        WHERE locked_at IS NOT NULL RETURNING 1),
     q AS (
       UPDATE graphile_worker._private_job_queues
          SET locked_at = NULL, locked_by = NULL
        WHERE locked_at IS NOT NULL RETURNING 1)
     SELECT (SELECT count(*) FROM j)::int + (SELECT count(*) FROM q)::int AS n`,
  );
  return rows[0]?.n ?? 0;
}
