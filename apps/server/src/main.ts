/**
 * API service entry point (Windows service `coffeelounge-api`, WINDOWS_DEPLOYMENT.md §2).
 * Starts both listeners immediately; business routes answer 503 until startup checks pass,
 * and the checks are retried every few seconds (e.g. while PostgreSQL is still starting).
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApps } from './platform/app.ts';
import { ClockJumpDetector } from './platform/clock.ts';
import { loadConfig } from './platform/config.ts';
import { loadMigrations } from './platform/db/migrate.ts';
import { createPool } from './platform/db/pool.ts';
import { HealthMonitor, parseInternetTarget } from './platform/health.ts';
import { LiveHub } from './platform/live-hub.ts';
import { Readiness, runStartupChecks } from './platform/readiness.ts';
import { SERVER_VERSION } from './platform/version.ts';
import { registerStaffRoutes } from './staff-routes.ts';

const RECHECK_MS = 5_000;
const CLOCK_SAMPLE_MS = 60_000;
const CLOCK_JUMP_MS = 10 * 60_000;

const config = loadConfig();
const readiness = new Readiness();
const pool = createPool({
  connectionString: config.DATABASE_URL,
  onError: (error) => {
    customer.log.error({ err: error }, 'database connection error');
  },
});
const migrations = await loadMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
const secureCookies = config.STAFF_TLS_CERT !== undefined;
const hub = new LiveHub({
  pool,
  connectListener: async () => {
    const client = new pg.Client({ connectionString: config.DATABASE_URL });
    await client.connect();
    return client;
  },
  onError: (error, context) => {
    staff.log.warn({ err: error }, `live hub: ${context}`);
  },
});
const health = new HealthMonitor({
  db: pool,
  readiness,
  version: SERVER_VERSION,
  ...(config.DISK_CHECK_PATH ? { diskPath: config.DISK_CHECK_PATH } : {}),
  ...(config.BACKUP_DRIVE_PATH ? { backupDrivePath: config.BACKUP_DRIVE_PATH } : {}),
  internetTarget: parseInternetTarget(config.INTERNET_CHECK_TARGET),
});
let hubStarted = false;
const { customer, staff } = buildApps(
  { config, pool, readiness, health },
  { staff: (app) => registerStaffRoutes(app, { pool, secureCookies, hub, health }) },
);

const check = async (): Promise<void> => {
  await runStartupChecks({
    db: pool,
    migrations,
    now: new Date(),
    clockToleranceMs: config.CLOCK_TOLERANCE_SECONDS * 1_000,
    readiness,
  });
  const state = readiness.snapshot();
  if (readiness.isReady() && !hubStarted) {
    await hub.start();
    hubStarted = true;
  }
  if (readiness.isReady()) customer.log.info('startup checks passed; serving requests');
  else customer.log.warn({ blockers: state.blockers }, 'not ready yet');
};

const recheck = setInterval(() => {
  if (!readiness.isReady()) void check();
}, RECHECK_MS);

const detector = new ClockJumpDetector(CLOCK_JUMP_MS);
const clockWatch = setInterval(() => {
  const jump = detector.sample();
  if (jump !== null) {
    const detail = `System clock jumped by ${Math.round(jump / 60_000)} min at ${new Date().toISOString()}`;
    readiness.warn('clock_jumped', detail);
    customer.log.error(detail);
  }
}, CLOCK_SAMPLE_MS);

await customer.listen({ host: config.HOST, port: config.CUSTOMER_PORT });
await staff.listen({ host: config.HOST, port: config.STAFF_PORT });
await check();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  customer.log.info({ signal }, 'shutting down');
  clearInterval(recheck);
  clearInterval(clockWatch);
  await hub.stop();
  await Promise.allSettled([customer.close(), staff.close()]);
  await pool.end();
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
