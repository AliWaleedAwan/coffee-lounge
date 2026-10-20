/**
 * The background worker (Windows service `coffeelounge-worker`): graphile-worker with
 * this project's task list and schedule. Later phases add print, report and e-mail tasks.
 */
import { Logger, parseCrontab, run, type Runner, type TaskList } from 'graphile-worker';
import type pg from 'pg';
import { scanStaleSessions } from '../modules/floor/index.ts';
import { raiseMismatchAlerts } from '../modules/stock/index.ts';
import { withTransaction } from '../platform/db/tx.ts';
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
    // ORDER_STATE_MACHINE.md T1: alert once per session open too long; no state change.
    'sessions:stale_scan': async (_payload, helpers) => {
      const raised = await scanStaleSessions(pool, new Date());
      if (raised > 0) helpers.logger.info(`raised ${String(raised)} stale-session alerts`);
    },
    // COST_VALUATION.md §11: report, never correct.
    'stock:reconcile': async (_payload, helpers) => {
      const mismatches = await withTransaction(pool, (tx) => raiseMismatchAlerts(tx));
      if (mismatches.length > 0) {
        helpers.logger.error(`stock check found ${String(mismatches.length)} mismatches`);
      } else {
        helpers.logger.info('stock check: every balance matches its movements');
      }
    },
  };
}

/**
 * Hourly housekeeping, minutes staggered; stale sessions every 10 minutes; the stock check runs nightly just after the
 * business-day cutoff (04:00 shop time, D-22).
 */
export const CRONTAB = [
  '5 * * * * maintenance:prune_idempotency_keys',
  '35 * * * * maintenance:prune_outbox',
  '*/10 * * * * sessions:stale_scan',
  '10 4 * * * stock:reconcile',
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
