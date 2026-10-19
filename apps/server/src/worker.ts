/**
 * Worker service entry point (Windows service `coffeelounge-worker`, WINDOWS_DEPLOYMENT.md §2).
 * Waits until the database is reachable and its schema matches this version, then runs
 * the job queue and writes a heartbeat every 15 s.
 */
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Runner } from 'graphile-worker';
import { loadConfig } from './platform/config.ts';
import { loadMigrations } from './platform/db/migrate.ts';
import { createPool } from './platform/db/pool.ts';
import { Readiness, runStartupChecks } from './platform/readiness.ts';
import { Heartbeat } from './worker/maintenance.ts';
import { startRunner } from './worker/runner.ts';

const VERSION = process.env['npm_package_version'] ?? '0.0.0';
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
const migrations = await loadMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));

const stop = new AbortController();
let heartbeat: Heartbeat | undefined;
let runner: Runner | undefined;

async function shutdown(signal: string): Promise<void> {
  if (stop.signal.aborted) return;
  stop.abort();
  log('info', 'shutting down', { signal });
  heartbeat?.stop();
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
  heartbeat = new Heartbeat(pool, 'worker', VERSION);
  heartbeat.start((error) => {
    log('error', 'heartbeat failed', {
      err: error instanceof Error ? error.message : String(error),
    });
  });
  runner = await startRunner({ pool });
  log('info', 'worker started');
  await runner.promise;
}
