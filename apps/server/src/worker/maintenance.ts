/**
 * Worker housekeeping: heartbeat (WINDOWS_DEPLOYMENT.md §2) and pruning of expired
 * idempotency keys (API.md §3: 24 h) and old live-update hints (API.md §7: 24 h).
 */
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
