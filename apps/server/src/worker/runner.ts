/**
 * The background worker (Windows service `coffeelounge-worker`): graphile-worker with
 * this project's task list and schedule. Later phases add print, report and e-mail tasks.
 */
import { Logger, parseCrontab, run, type Runner, type TaskList } from 'graphile-worker';
import type pg from 'pg';
import { scanStaleSessions } from '../modules/floor/index.ts';
import { raiseLedgerAlerts } from '../modules/ledger/index.ts';
import {
  escalateOverdue,
  expireUnpaidTakeaways,
  scanUncollected,
} from '../modules/orders/index.ts';
import {
  raiseMismatchAlerts,
  raiseStaleReservationAlerts,
  scanExpiry,
} from '../modules/stock/index.ts';
import { withTransaction } from '../platform/db/tx.ts';
import { businessDateOf } from '../platform/settings.ts';
import {
  dispatchPrinter,
  defaultTransports,
  sweepPrinters,
  type DispatchDeps,
} from '../modules/printing/index.ts';
import { pruneIdempotencyKeys, pruneLogs, pruneOutbox } from './maintenance.ts';

export interface TaskOptions {
  /** How print jobs reach printers (tests pass fakes). */
  transports?: DispatchDeps['transports'];
  /** W-3: the services' log folder. */
  logDir?: string | undefined;
}

export function makeTasks(pool: pg.Pool, options: TaskOptions = {}): TaskList {
  const transports = options.transports ?? defaultTransports();
  return {
    // PRINTING_HARDWARE.md §5: one dispatcher per printer at a time (queue print-<id>).
    'print:dispatch': async (payload, helpers) => {
      const { printerId } = payload as { printerId: string };
      const sent = await dispatchPrinter(pool, printerId, { transports });
      if (sent > 0) helpers.logger.info(`printer ${printerId}: ${String(sent)} jobs sent`);
    },
    'print:sweep': async () => {
      await sweepPrinters(pool, new Date());
    },
    'maintenance:prune_logs': async (_payload, helpers) => {
      if (!options.logDir) return;
      const removed = await pruneLogs(options.logDir, new Date());
      if (removed > 0)
        helpers.logger.info(`deleted ${String(removed)} log files older than 30 days`);
    },
    'maintenance:prune_idempotency_keys': async (_payload, helpers) => {
      const removed = await pruneIdempotencyKeys(pool);
      helpers.logger.info(`pruned ${String(removed)} expired idempotency keys`);
    },
    'maintenance:prune_outbox': async (_payload, helpers) => {
      const removed = await pruneOutbox(pool);
      helpers.logger.info(`pruned ${String(removed)} old live-update hints`);
    },
    // ORDER_STATE_MACHINE.md T2 (D-36): rounds waiting too long go to managers and cashiers.
    'orders:escalate': async (_payload, helpers) => {
      const escalated = await withTransaction(pool, (tx) => escalateOverdue(tx, new Date()));
      if (escalated > 0) helpers.logger.info(`escalated ${String(escalated)} waiting orders`);
    },
    // R6 (D-40): unpaid counter-QR takeaway orders cancel themselves.
    'orders:expire_unpaid_takeaway': async (_payload, helpers) => {
      const expired = await expireUnpaidTakeaways(pool, new Date());
      if (expired > 0) helpers.logger.info(`cancelled ${String(expired)} unpaid takeaway orders`);
    },
    // T3 (D-33): accepted items nobody picked up.
    'orders:uncollected_scan': async (_payload, helpers) => {
      const raised = await scanUncollected(pool, new Date());
      if (raised > 0) helpers.logger.info(`raised ${String(raised)} uncollected-item alerts`);
    },
    // ORDER_STATE_MACHINE.md §5: reservations open longer than 12 hours.
    'stock:stale_reservations': async (_payload, helpers) => {
      const items = await withTransaction(pool, (tx) =>
        raiseStaleReservationAlerts(tx, new Date()),
      );
      if (items > 0) helpers.logger.info(`${String(items)} ingredients have stale reservations`);
    },
    // ORDER_STATE_MACHINE.md T1: alert once per session open too long; no state change.
    'sessions:stale_scan': async (_payload, helpers) => {
      const raised = await scanStaleSessions(pool, new Date());
      if (raised > 0) helpers.logger.info(`raised ${String(raised)} stale-session alerts`);
    },
    // RECIPE_INVENTORY.md §10: expired and near-expiry lots, after the business-day cutoff.
    'stock:expiry_scan': async (_payload, helpers) => {
      const found = await withTransaction(pool, async (tx) =>
        scanExpiry(tx, await businessDateOf(tx, new Date())),
      );
      helpers.logger.info(
        `expiry scan: ${String(found.expired)} expired, ${String(found.nearExpiry)} near expiry`,
      );
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
    // FINANCE_REPORTING.md §4: every money source has exactly its entry; report, never correct.
    'ledger:reconcile': async (_payload, helpers) => {
      const mismatches = await withTransaction(pool, (tx) => raiseLedgerAlerts(tx));
      if (mismatches.length > 0) {
        helpers.logger.error(`ledger check found ${String(mismatches.length)} mismatches`);
      } else {
        helpers.logger.info('ledger check: every source has exactly its entry');
      }
    },
  };
}

/**
 * Hourly housekeeping, minutes staggered; waiting and unpaid takeaway orders every minute; stale sessions every 10 minutes; the expiry scan (04:05), the stock check
 * (04:10) and the ledger check (04:15) run nightly just after the business-day cutoff (04:00 shop time, D-22).
 */
export const CRONTAB = [
  '5 * * * * maintenance:prune_idempotency_keys',
  '* * * * * print:sweep',
  '30 3 * * * maintenance:prune_logs',
  '35 * * * * maintenance:prune_outbox',
  '* * * * * orders:escalate',
  '* * * * * orders:expire_unpaid_takeaway',
  '*/5 * * * * orders:uncollected_scan',
  '*/10 * * * * sessions:stale_scan',
  '15 * * * * stock:stale_reservations',
  '5 4 * * * stock:expiry_scan',
  '10 4 * * * stock:reconcile',
  '15 4 * * * ledger:reconcile',
].join('\n');

export interface WorkerRunOptions {
  pool: pg.Pool;
  concurrency?: number;
  pollInterval?: number;
  logger?: Logger;
  taskList?: TaskList;
  logDir?: string | undefined;
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
    options.taskList ?? makeTasks(options.pool, { logDir: options.logDir }),
    parseCrontab(options.crontab ?? CRONTAB),
  );
}

/** A logger that discards everything (tests). */
export const silentLogger = new Logger(() => () => undefined);
