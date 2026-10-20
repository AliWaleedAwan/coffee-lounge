/**
 * Clock safety for an old PC without a UPS (WINDOWS_DEPLOYMENT.md §5, AT-79).
 *
 * 1. At startup the PC clock must not be behind the latest timestamp already stored,
 *    or new sales would land on the wrong business date.
 * 2. While running, a wall-clock jump larger than the threshold raises a warning.
 */
import type { Queryable } from './db/pool.ts';

/**
 * Columns holding "when something happened". Later phases append their tables
 * (payments, stock movements, …) so the check covers every recorded instant.
 */
export const RECORDED_INSTANT_COLUMNS: string[] = [
  'cl.audit_events.occurred_at',
  'cl.outbox_events.created_at',
  'cl.idempotency_keys.created_at',
  'cl.auth_sessions.last_seen_at',
  'cl.step_up_approvals.created_at',
  'cl.stock_movements.occurred_at',
];

const COLUMN_REF = /^cl\.[a-z_]+\.[a-z_]+$/;

export async function latestRecordedInstant(db: Queryable): Promise<Date | null> {
  const parts = RECORDED_INSTANT_COLUMNS.map((ref) => {
    if (!COLUMN_REF.test(ref)) throw new Error(`Bad column reference ${ref}`);
    const column = ref.slice(ref.lastIndexOf('.') + 1);
    const table = ref.slice(0, ref.lastIndexOf('.'));
    return `(SELECT max(${column}) FROM ${table})`;
  });
  const { rows } = await db.query<{ latest: Date | null }>(
    `SELECT GREATEST(${parts.join(', ')}) AS latest`,
  );
  return rows[0]?.latest ?? null;
}

export type ClockCheck = { ok: true } | { ok: false; behindByMs: number; latest: Date };

export function checkClock(now: Date, latest: Date | null, toleranceMs: number): ClockCheck {
  if (latest === null) return { ok: true };
  const behindByMs = latest.getTime() - now.getTime();
  return behindByMs > toleranceMs ? { ok: false, behindByMs, latest } : { ok: true };
}

/** Detects wall-clock jumps by comparing elapsed wall time with a monotonic clock. */
export class ClockJumpDetector {
  private readonly thresholdMs: number;
  private readonly wall: () => number;
  private readonly monotonic: () => number;
  private lastWall: number;
  private lastMonotonic: number;

  constructor(
    thresholdMs: number,
    wall: () => number = () => Date.now(),
    monotonic: () => number = () => performance.now(),
  ) {
    this.thresholdMs = thresholdMs;
    this.wall = wall;
    this.monotonic = monotonic;
    this.lastWall = wall();
    this.lastMonotonic = monotonic();
  }

  /** Returns the jump in ms (positive = clock moved forward) if it exceeds the threshold. */
  sample(): number | null {
    const wall = this.wall();
    const monotonic = this.monotonic();
    const drift = wall - this.lastWall - (monotonic - this.lastMonotonic);
    this.lastWall = wall;
    this.lastMonotonic = monotonic;
    return Math.abs(drift) > this.thresholdMs ? drift : null;
  }
}
