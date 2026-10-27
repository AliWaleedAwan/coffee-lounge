/**
 * Starts a disposable shop for browser end-to-end tests (apps/web/e2e): a fresh database
 * with migrations, test users and registration codes, and the real API serving the built
 * web app. Writes the test credentials to E2E_STATE_FILE (git-ignored) and drops the
 * database on SIGINT/SIGTERM. Development only: never point it at a shop database.
 *
 *   node --env-file=../../.env scripts/e2e-server.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations as runJobQueueMigrations } from 'graphile-worker';
import pg from 'pg';
import { createOwner, createRegistrationCode } from '../src/modules/identity/index.ts';
import { hashSecret } from '../src/modules/identity/secrets.ts';
import { buildApps } from '../src/platform/app.ts';
import { loadMigrations, migrate } from '../src/platform/db/migrate.ts';
import { createPool } from '../src/platform/db/pool.ts';
import { HealthMonitor } from '../src/platform/health.ts';
import { adoptJobQueue } from '../src/platform/jobs.ts';
import { LiveHub } from '../src/platform/live-hub.ts';
import { Readiness, runStartupChecks } from '../src/platform/readiness.ts';
import { SERVER_VERSION } from '../src/platform/version.ts';
import { registerCustomerRoutes } from '../src/customer-routes.ts';
import { registerStaffRoutes } from '../src/staff-routes.ts';
import { silentLogger, startRunner } from '../src/worker/runner.ts';
import { createTestDatabase, MIGRATIONS_DIR, urlFor } from '../test/support/db.ts';

const STAFF_PORT = Number(process.env['E2E_STAFF_PORT'] ?? 18443);
const CUSTOMER_PORT = Number(process.env['E2E_CUSTOMER_PORT'] ?? 18080);
// Optional HTTPS on the staff port (desktop tests use throwaway certificates).
const TLS =
  process.env['E2E_TLS_CERT'] && process.env['E2E_TLS_KEY']
    ? { STAFF_TLS_CERT: process.env['E2E_TLS_CERT'], STAFF_TLS_KEY: process.env['E2E_TLS_KEY'] }
    : null;
const STATE_FILE =
  process.env['E2E_STATE_FILE'] ??
  fileURLToPath(new URL('../../web/.e2e/state.json', import.meta.url));
const WEB_ROOT =
  process.env['WEB_DIST_DIR'] ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const facts = { correlationId: randomUUID() };

const db = await createTestDatabase('empty');
const migrations = await loadMigrations(MIGRATIONS_DIR);
await migrate(db.client, migrations);
// Installing the job queue needs the owner; everything after runs with only the
// application role's privileges, as the installed services do.
const ownerPool = createPool({ connectionString: urlFor(db.name), max: 2 });
await runJobQueueMigrations({ pgPool: ownerPool });
await adoptJobQueue(ownerPool);
await ownerPool.end();
const pool = createPool({ connectionString: urlFor(db.name), max: 10, sessionRole: 'cl_app' });

// Test users: an owner (password); a waiter, a cashier and an inventory clerk (password and PIN).
const password = `e2e-${randomUUID()}`;
const owner = { username: 'owner', name: 'Owner', password };
const { userId: ownerId } = await createOwner(
  pool,
  { username: owner.username, displayName: owner.name, password },
  facts,
);
const staff = [
  { username: 'sara', name: 'Sara', role: 'waiter', pin: '2580' },
  { username: 'ali', name: 'Ali', role: 'cashier', pin: '3691' },
  { username: 'faisal', name: 'Faisal', role: 'inventory_clerk', pin: '4812' },
];
const passwordHash = await hashSecret(password);
for (const s of staff) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO cl.users (username, display_name, password_hash, pin_hash, must_change_password)
     VALUES ($1, $2, $3, $4, false) RETURNING id::text`,
    [s.username, s.name, passwordHash, await hashSecret(s.pin)],
  );
  await pool.query(
    'INSERT INTO cl.user_roles (user_id, role_id) SELECT $1, id FROM cl.roles WHERE key = $2',
    [rows[0]?.id, s.role],
  );
}
const codes: string[] = [];
for (let i = 1; i <= 30; i++) {
  const { code } = await createRegistrationCode(
    pool,
    { actor: { kind: 'system' }, userId: ownerId },
    {
      deviceName: `E2E device ${String(i)}`,
      kind: i === 1 ? 'reception' : 'waiter',
      ownership: 'shop',
    },
    facts,
  );
  codes.push(code);
}

const readiness = new Readiness();
await runStartupChecks({
  db: pool,
  migrations,
  now: new Date(),
  clockToleranceMs: 120_000,
  readiness,
});
const health = new HealthMonitor({
  db: pool,
  readiness,
  version: SERVER_VERSION,
  internetTarget: null,
});
const hub = new LiveHub({
  pool,
  connectListener: async () => {
    const client = new pg.Client({ connectionString: urlFor(db.name), options: '-c role=cl_app' });
    await client.connect();
    return client;
  },
  pollMs: 500,
});
await hub.start();
const apps = buildApps(
  {
    config: { LOG_LEVEL: 'warn', ...TLS },
    pool,
    readiness,
    health,
    staffWebRoot: WEB_ROOT,
    customerWebRoot: WEB_ROOT,
  },
  {
    // Every test phone shares 127.0.0.1: per-phone limits would count them together
    // (the limits have their own server tests).
    customer: (app) =>
      registerCustomerRoutes(app, { pool, hub, limits: { perIp: 10_000, submissions: 1_000 } }),
    staff: (app) =>
      registerStaffRoutes(app, {
        pool,
        secureCookies: TLS !== null,
        hub,
        health,
        guestBaseUrl: `http://127.0.0.1:${String(CUSTOMER_PORT)}`,
        filesDir: mkdtempSync(join(tmpdir(), 'cl-e2e-files-')),
      }),
  },
);
await apps.customer.listen({ host: '127.0.0.1', port: CUSTOMER_PORT });
await apps.staff.listen({ host: '127.0.0.1', port: STAFF_PORT });

mkdirSync(dirname(STATE_FILE), { recursive: true });
writeFileSync(
  STATE_FILE,
  JSON.stringify(
    {
      baseURL: `${TLS ? 'https' : 'http'}://127.0.0.1:${String(STAFF_PORT)}`,
      database: db.name,
      owner,
      staff,
      password,
      codes,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `e2e shop ready on ${TLS ? 'https' : 'http'}://127.0.0.1:${String(STAFF_PORT)} (database ${db.name})`,
);

// The real worker, so print jobs are dispatched as in the shop (printer banner, retries).
const runner = await startRunner({ pool, logger: silentLogger });

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runner.stop();
  await hub.stop();
  await Promise.allSettled([apps.customer.close(), apps.staff.close()]);
  await pool.end();
  await db.drop();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
