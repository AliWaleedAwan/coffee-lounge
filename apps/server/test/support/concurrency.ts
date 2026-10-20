/**
 * Concurrency harness (TEST_PLAN.md §2 level C, §6). Races run on separate database
 * connections and meet at a barrier right before the statement under test, so they
 * really overlap instead of happening to run one after another. `waitUntilBlocked`
 * proves that a transaction is waiting on another one's lock (a deterministic
 * interleaving). Each race repeats CL_RACE_RUNS times: 10 per commit, 100 nightly.
 */
import pg from 'pg';

/** Runs per race: TEST_PLAN.md §6 (×10 per commit, ×100 nightly via CL_RACE_RUNS=100). */
export function raceRuns(): number {
  const value = Number(process.env['CL_RACE_RUNS'] ?? 10);
  return Number.isInteger(value) && value > 0 ? value : 10;
}

export class BarrierTimeout extends Error {
  override name = 'BarrierTimeout';
}

/**
 * Releases every party at once when the last of `parties` arrives. Single use: a party
 * arriving after release passes straight through. Rejects all waiters if the others
 * have not arrived within the timeout (a contender failed early).
 */
export class Barrier {
  private arrived = 0;
  private released = false;
  private readonly waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private timer: NodeJS.Timeout | undefined;
  readonly parties: number;
  private readonly timeoutMs: number;

  constructor(parties: number, timeoutMs = 5_000) {
    if (!Number.isInteger(parties) || parties < 1) throw new Error('parties must be ≥ 1');
    this.parties = parties;
    this.timeoutMs = timeoutMs;
  }

  get waiting(): number {
    return this.released ? 0 : this.arrived;
  }

  wait(): Promise<void> {
    if (this.released) return Promise.resolve();
    this.arrived += 1;
    if (this.arrived === 1) {
      this.timer = setTimeout(() => {
        this.fail(
          new BarrierTimeout(
            `barrier: ${String(this.arrived)} of ${String(this.parties)} arrived within ${String(this.timeoutMs)} ms`,
          ),
        );
      }, this.timeoutMs);
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (this.arrived === this.parties) this.release();
    return promise;
  }

  /** Lets everyone through (e.g. when a contender failed before arriving). */
  release(): void {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.timer);
    for (const w of this.waiters.splice(0)) w.resolve();
  }

  private fail(error: Error): void {
    if (this.released) return;
    this.released = true;
    for (const w of this.waiters.splice(0)) w.reject(error);
  }
}

export type Outcome<T> =
  | { index: number; ok: true; value: T; ms: number }
  | { index: number; ok: false; error: unknown; ms: number };

export interface Contender {
  index: number;
  /**
   * A pool of exactly one connection, so platform code (withTransaction) runs on this
   * contender's own backend. Release any client you check out.
   */
  pool: pg.Pool;
  /** Backend pid of that connection (for waitUntilBlocked). */
  pid: number;
  /** Meet the other contenders here, right before the racing statement. */
  barrier: Barrier;
}

export interface RaceOptions<T> {
  connectionString: string;
  contenders: number;
  body: (c: Contender) => Promise<T>;
  barrierTimeoutMs?: number;
}

/**
 * Runs `body` once per contender, each on its own connection, all at once. Never
 * throws for a contender's error: every outcome is returned, in contender order.
 * Open transactions are rolled back and connections closed afterwards.
 */
export async function race<T>(options: RaceOptions<T>): Promise<Outcome<T>[]> {
  const pools = await Promise.all(
    Array.from({ length: options.contenders }, async () => {
      const pool = new pg.Pool({ connectionString: options.connectionString, max: 1 });
      // A test may terminate connections, and a leaked client is ended when its database
      // is dropped: neither may crash the run.
      pool.on('error', () => undefined);
      pool.on('connect', (client) => {
        client.on('error', () => undefined);
      });
      const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return { pool, pid: rows[0]?.pid ?? 0 };
    }),
  );
  const barrier = new Barrier(options.contenders, options.barrierTimeoutMs);
  try {
    return await Promise.all(
      pools.map(async ({ pool, pid }, index): Promise<Outcome<T>> => {
        const start = performance.now();
        try {
          const value = await options.body({ index, pool, pid, barrier });
          return { index, ok: true, value, ms: performance.now() - start };
        } catch (error) {
          // A contender that fails before the barrier must not strand the others.
          barrier.release();
          return { index, ok: false, error, ms: performance.now() - start };
        }
      }),
    );
  } finally {
    const leaked: number[] = [];
    await Promise.all(
      pools.map(async ({ pool }, index) => {
        if (pool.idleCount < pool.totalCount) leaked.push(index);
        const ended = pool.end().then(() => true);
        const timedOut = new Promise<false>((r) =>
          setTimeout(() => {
            r(false);
          }, 2_000),
        );
        if (!(await Promise.race([ended, timedOut]))) leaked.push(index);
      }),
    );
    if (leaked.length > 0) {
      // eslint-disable-next-line no-unsafe-finally -- a leak must fail the test loudly
      throw new Error(
        `contenders ${[...new Set(leaked)].join(', ')} did not release their connection`,
      );
    }
  }
}

/** Repeats a whole race `runs` times (a fresh set of contenders each run). */
export async function repeatRace(
  runs: number,
  once: (run: number) => Promise<void>,
): Promise<void> {
  for (let run = 0; run < runs; run++) {
    try {
      await once(run);
    } catch (error) {
      throw new Error(`race failed on run ${String(run + 1)} of ${String(runs)}`, {
        cause: error,
      });
    }
  }
}

/**
 * Resolves once backend `pid` is waiting for a lock held by another transaction (and
 * returns the blocking pids). Use it to prove that the second transaction really
 * queued behind the first, rather than running before or after it.
 */
export async function waitUntilBlocked(
  observer: pg.ClientBase | pg.Pool,
  pid: number,
  timeoutMs = 5_000,
): Promise<number[]> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await observer.query<{ blockers: number[] }>(
      'SELECT pg_blocking_pids($1) AS blockers',
      [pid],
    );
    const blockers = rows[0]?.blockers ?? [];
    if (blockers.length > 0) return blockers;
    if (Date.now() > end) throw new Error(`backend ${String(pid)} never waited for a lock`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Summary for assertions: how many succeeded, and the error codes of the others. */
export function tally<T>(outcomes: readonly Outcome<T>[]): {
  ok: T[];
  failed: string[];
} {
  const ok: T[] = [];
  const failed: string[] = [];
  for (const o of outcomes) {
    if (o.ok) ok.push(o.value);
    else {
      const e = o.error as { code?: unknown; message?: unknown };
      failed.push(
        typeof e.code === 'string' ? e.code : typeof e.message === 'string' ? e.message : 'unknown',
      );
    }
  }
  return { ok, failed };
}
