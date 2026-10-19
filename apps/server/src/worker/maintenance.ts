/**
 * Worker housekeeping: heartbeat (WINDOWS_DEPLOYMENT.md §2) and pruning of expired
 * idempotency keys (API.md §3: 24 h) and old live-update hints (API.md §7: 24 h).
 */
import type pg from 'pg';
import type { Queryable } from '../platform/db/pool.ts';

export const OUTBOX_RETENTION_HOURS = 24;
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** The API reports the worker as down after this long without a heartbeat. */
export const HEARTBEAT_STALE_MS = 60_000;

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
    void this.beat().catch(onError);
    this.timer = setInterval(() => void this.beat().catch(onError), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

export interface WorkerStatus {
  status: 'ok' | 'stale' | 'down';
  lastHeartbeatAt: Date | null;
}

/** Read by the API health page (step 2.6). */
export async function workerStatus(db: Queryable, name = 'worker'): Promise<WorkerStatus> {
  const { rows } = await db.query<{ beat_at: Date; age_ms: number }>(
    `SELECT beat_at, (EXTRACT(EPOCH FROM (now() - beat_at)) * 1000)::int AS age_ms
       FROM cl.worker_heartbeats WHERE worker_name = $1`,
    [name],
  );
  const row = rows[0];
  if (!row) return { status: 'down', lastHeartbeatAt: null };
  return {
    status: row.age_ms <= HEARTBEAT_STALE_MS ? 'ok' : 'stale',
    lastHeartbeatAt: row.beat_at,
  };
}
