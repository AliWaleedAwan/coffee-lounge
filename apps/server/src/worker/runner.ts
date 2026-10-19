/**
 * The background worker (Windows service `coffeelounge-worker`): graphile-worker with
 * this project's task list and schedule. Later phases add print, report and e-mail tasks.
 */
import { Logger, parseCrontab, run, type Runner, type TaskList } from 'graphile-worker';
import type pg from 'pg';
import { pruneIdempotencyKeys, pruneOutbox } from './maintenance.ts';

export function makeTasks(pool: pg.Pool): TaskList {
  return {
    'maintenance:prune_idempotency_keys': async (_payload, helpers) => {
      const removed = await pruneIdempotencyKeys(pool);
      helpers.logger.info(`pruned ${String(removed)} expired idempotency keys`);
    },
    'maintenance:prune_outbox': async (_payload, helpers) => {
      const removed = await pruneOutbox(pool);
      helpers.logger.info(`pruned ${String(removed)} old live-update hints`);
    },
  };
}

/** Hourly housekeeping; minutes are staggered so both do not run at once. */
export const CRONTAB = [
  '5 * * * * maintenance:prune_idempotency_keys',
  '35 * * * * maintenance:prune_outbox',
].join('\n');

export interface WorkerRunOptions {
  pool: pg.Pool;
  concurrency?: number;
  pollInterval?: number;
  logger?: Logger;
  taskList?: TaskList;
  crontab?: string;
}

export function startRunner(options: WorkerRunOptions): Promise<Runner> {
  return run(
    {
      pgPool: options.pool,
      concurrency: options.concurrency ?? 2,
      pollInterval: options.pollInterval ?? 2_000,
      noHandleSignals: true,
      ...(options.logger ? { logger: options.logger } : {}),
    },
    options.taskList ?? makeTasks(options.pool),
    parseCrontab(options.crontab ?? CRONTAB),
  );
}

/** A logger that discards everything (tests). */
export const silentLogger = new Logger(() => () => undefined);
