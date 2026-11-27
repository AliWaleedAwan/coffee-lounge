/**
 * Worker service entry point (Windows service `coffeelounge-worker`, WINDOWS_DEPLOYMENT.md §2).
 * Waits until the database is reachable and its schema matches this version, then runs
 * the job queue and writes a heartbeat every 15 s.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Runner } from 'graphile-worker';
import { loadConfig } from './platform/config.ts';
import { loadMigrations } from './platform/db/migrate.ts';
import { createPool } from './platform/db/pool.ts';
import { DEV_FILES_DIR, DEV_MAIL_KEY_FILE, MIGRATIONS_DIR } from './platform/paths.ts';
import { Readiness, runStartupChecks } from './platform/readiness.ts';
import { SERVER_VERSION } from './platform/version.ts';
import { Heartbeat, releaseStaleLocks } from './worker/maintenance.ts';
import { LiveWal } from './modules/backup/index.ts';
import { startRunner } from './worker/runner.ts';

const log = (level: string, msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(
    JSON.stringify({ level, time: new Date().toISOString(), name: 'worker', msg, ...extra }),
  );
};

const config = loadConfig();
const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: 4,
  onError: (error) => {
    log('error', 'database connection error', { err: error.message });
  },
});
const migrations = await loadMigrations(MIGRATIONS_DIR);

const stop = new AbortController();
let heartbeat: Heartbeat | undefined;
let runner: Runner | undefined;
let liveWal: LiveWal | undefined;

async function shutdown(signal: string): Promise<void> {
  if (stop.signal.aborted) return;
  stop.abort();
  log('info', 'shutting down', { signal });
  await heartbeat?.stop();
  liveWal?.stop();
  await runner?.stop();
  await pool.end();
}
// Registered before the readiness wait, so a service stop during it exits cleanly.
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

const readiness = new Readiness();
while (!stop.signal.aborted) {
  await runStartupChecks({
    db: pool,
    migrations,
    now: new Date(),
    clockToleranceMs: config.CLOCK_TOLERANCE_SECONDS * 1_000,
    readiness,
  });
  if (readiness.isReady()) break;
  log('warn', 'not ready yet', { blockers: readiness.snapshot().blockers });
  await sleep(5_000, undefined, { signal: stop.signal }).catch(() => undefined);
}

if (!stop.signal.aborted) {
  heartbeat = new Heartbeat(pool, 'worker', SERVER_VERSION);
  heartbeat.start((error) => {
    log('error', 'heartbeat failed', {
      err: error instanceof Error ? error.message : String(error),
    });
  });
  if (config.LIVE_WAL_DIR && config.BACKUP_REPLICATION_URL) {
    liveWal = new LiveWal({
      dir: config.LIVE_WAL_DIR,
      replicationUrl: config.BACKUP_REPLICATION_URL,
      pgBinDir: config.PG_BIN_DIR,
      log: (message) => {
        log('error', message);
      },
    });
    liveWal.start();
  }
  const released = await releaseStaleLocks(pool);
  if (released > 0) log('warn', 'released job locks left by a stopped worker', { released });
  runner = await startRunner({
    pool,
    logDir: config.LOG_DIR,
    mail: { keyFile: config.MAIL_KEY_FILE ?? DEV_MAIL_KEY_FILE },
    ...(config.BACKUP_DRIVE_PATH && config.BACKUP_PUBLIC_KEY_FILE
      ? {
          backup: {
            driveRoot: config.BACKUP_DRIVE_PATH,
            publicKeyFile: config.BACKUP_PUBLIC_KEY_FILE,
            pgBinDir: config.PG_BIN_DIR,
            connectionString: config.DATABASE_URL,
            filesDir: config.FILES_DIR ?? DEV_FILES_DIR,
            replicationUrl: config.BACKUP_REPLICATION_URL,
            walGapFile: config.BACKUP_WAL_GAP_FILE,
            restoreTestUrl: config.RESTORE_TEST_DATABASE_URL,
          },
        }
      : {}),
  });
  log('info', 'worker started');
  await runner.promise;
}
