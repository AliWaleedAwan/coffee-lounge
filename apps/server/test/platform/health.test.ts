import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerStaffIdentity } from '../../src/modules/identity/index.ts';
import { createPool, isConnectionError } from '../../src/platform/db/pool.ts';
import {
  Cached,
  HealthMonitor,
  diskLevel,
  parseInternetTarget,
  probeDatabase,
  probeDisk,
  probeInternet,
  probePathPresent,
  type SystemHealth,
} from '../../src/platform/health.ts';
import { SERVER_VERSION } from '../../src/platform/version.ts';
import { Heartbeat } from '../../src/worker/maintenance.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type IdentityFixture } from '../support/identity.ts';
import { readyApps } from '../support/platform.ts';

/** A pool pointed at a port where nothing listens: the database is "down". */
function deadPool() {
  const url = new URL(urlFor('coffee_lounge_test'));
  url.port = '1';
  return createPool({ connectionString: url.toString(), max: 2 });
}

describe('probes', () => {
  it('shares one in-flight probe between callers and caches the result for its lifetime', async () => {
    let now = 0;
    let calls = 0;
    const cached = new Cached(
      1_000,
      async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return calls;
      },
      () => now,
    );
    expect(await Promise.all([cached.get(), cached.get(), cached.get()])).toEqual([1, 1, 1]);
    now = 999;
    expect(await cached.get()).toBe(1);
    now = 1_000;
    expect(await cached.get()).toBe(2);
  });

  it('reports the database unreachable when it refuses connections or does not answer in time', async () => {
    const dead = deadPool();
    try {
      expect(await probeDatabase(dead)).toBe('unreachable');
    } finally {
      await dead.end();
    }
    const busy = createPool({ connectionString: urlFor('coffee_lounge_test'), max: 1 });
    const held = await busy.connect();
    try {
      expect(await probeDatabase(busy, 100)).toBe('unreachable');
      held.release();
      expect(await probeDatabase(busy)).toBe('ok');
    } finally {
      await busy.end();
    }
  });

  it('tells connection failures apart from query errors', () => {
    const coded = (code: string, message = 'x') => Object.assign(new Error(message), { code });
    expect(isConnectionError(coded('ECONNREFUSED'))).toBe(true);
    expect(isConnectionError(coded('57P01'))).toBe(true); // terminated by administrator
    expect(isConnectionError(coded('08006'))).toBe(true); // connection failure
    expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isConnectionError(new AggregateError([coded('ECONNREFUSED')]))).toBe(true);
    expect(isConnectionError(coded('23505'))).toBe(false); // unique violation
    expect(isConnectionError(coded('40001'))).toBe(false); // serialization failure
    expect(isConnectionError(new Error('boom'))).toBe(false);
    expect(isConnectionError('ECONNREFUSED')).toBe(false);
  });

  it('measures free disk space and warns at 80 % and 90 % used (H-14)', async () => {
    const disk = await probeDisk(tmpdir());
    expect(disk.status).not.toBe('unknown');
    expect(disk.freePercent).toBeGreaterThan(0);
    expect(disk.freePercent).toBeLessThanOrEqual(100);
    expect(await probeDisk('/no/such/volume')).toEqual({ freePercent: null, status: 'unknown' });
    expect([25, 20.1, 20, 10.1, 10, 0].map(diskLevel)).toEqual([
      'ok',
      'ok',
      'warning',
      'warning',
      'critical',
      'critical',
    ]);
  });

  it('reports the backup drive present only when its path is configured and mounted', async () => {
    expect(await probePathPresent(undefined)).toBe(false);
    expect(await probePathPresent(tmpdir())).toBe(true);
    expect(await probePathPresent('/no/such/volume')).toBe(false);
  });

  it('reports internet online when a TCP connection opens, offline otherwise or when off', async () => {
    const server: Server = createServer((socket) => socket.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await probeInternet({ host: '127.0.0.1', port })).toBe('online');
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await probeInternet({ host: '127.0.0.1', port }, 500)).toBe('offline');
    expect(await probeInternet(null)).toBe('offline');
    expect(parseInternetTarget('off')).toBeNull();
    expect(parseInternetTarget('1.1.1.1:443')).toEqual({ host: '1.1.1.1', port: 443 });
    expect(() => parseInternetTarget('1.1.1.1')).toThrow();
  });
});

describe('database down after startup (AT-120, DB part)', () => {
  it('answers /health/ready and business routes with 503 DATABASE_UNAVAILABLE, never 500', async () => {
    const pool = deadPool();
    const { customer, staff } = readyApps(pool, {
      staff: async (app) => {
        await registerStaffIdentity(app, { pool, secureCookies: false });
      },
      customer: async (app) => {
        app.get('/probe', async () => (await pool.query<{ one: number }>('SELECT 1 AS one')).rows);
      },
    });
    try {
      for (const app of [customer, staff]) {
        expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
        const ready = await app.inject({ url: '/health/ready' });
        expect(ready.statusCode).toBe(503);
        expect(ready.json()).toMatchObject({
          code: 'DATABASE_UNAVAILABLE',
          database: 'unreachable',
        });
        expect(ready.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|cl_dev/);
      }
      const business = await customer.inject({ url: '/api/customer/v1/probe' });
      expect(business.statusCode).toBe(503);
      expect(business.json()).toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
      const me = await staff.inject({
        url: '/api/staff/v1/auth/me',
        cookies: { cl_device: 'x'.repeat(43) },
      });
      expect(me.statusCode).toBe(503);
      expect(me.json()).toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    } finally {
      await Promise.all([customer.close(), staff.close()]);
      await pool.end();
    }
  });
});

describe('GET /api/staff/v1/system/health (AT-120, foundation parts)', () => {
  let fx: IdentityFixture;
  let diskFree = 55.5;
  beforeAll(async () => {
    fx = await identityFixture({
      probes: {
        disk: () => Promise.resolve({ freePercent: diskFree, status: diskLevel(diskFree) }),
        backupDrivePresent: () => Promise.resolve(true),
      },
    });
  });
  afterAll(async () => {
    await fx.close();
  });

  it('is limited to roles with system.health', async () => {
    await fx.addUser('health_waiter', ['waiter']);
    const waiter = await fx.loggedIn('health_waiter');
    const res = await waiter.call({ url: '/api/staff/v1/system/health' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reports database, worker, disk, backup drive and internet, and flags trouble', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const read = async (): Promise<SystemHealth> => {
      const res = await owner.call({ url: '/api/staff/v1/system/health' });
      expect(res.statusCode).toBe(200);
      return res.json<SystemHealth>();
    };

    const { checkedAt, ...first } = await read();
    expect(Math.abs(Date.parse(checkedAt) - Date.now())).toBeLessThan(10_000);
    expect(first).toEqual({
      api: 'ok',
      database: 'ok',
      databaseRestarts: { last: null, lastWeek: 0 },
      worker: { status: 'down', lastHeartbeatAt: null },
      printer: { status: 'unknown', openJobs: 0 },
      backup: { lastSuccessAt: null, lastVerifiedAt: null, usbDrivePresent: true },
      disk: { freePercent: 55.5, status: 'ok' },
      internet: 'offline',
      warnings: {},
      version: SERVER_VERSION,
    });

    await new Heartbeat(fx.pool, 'worker', '1.0.0').beat();
    const beating = await read();
    expect(beating.worker.status).toBe('ok');
    expect(Date.parse(beating.worker.lastHeartbeatAt ?? '')).toBeGreaterThan(Date.now() - 10_000);

    await fx.pool.query(
      `UPDATE cl.worker_heartbeats SET beat_at = now() - interval '61 seconds' WHERE worker_name = 'worker'`,
    );
    expect((await read()).worker.status).toBe('stale');

    fx.readiness.warn('clock_jumped', 'System clock jumped by 15 min');
    const degraded = await read();
    expect(degraded.api).toBe('degraded');
    expect(degraded.warnings).toEqual({ clock_jumped: 'System clock jumped by 15 min' });
  });

  it('reports a nearly full disk as critical', async () => {
    diskFree = 9; // the fixture monitor caches disk readings for 10 s; a fresh monitor reads now
    const monitor = new HealthMonitor({
      db: fx.pool,
      readiness: fx.readiness,
      probes: {
        disk: () => Promise.resolve({ freePercent: diskFree, status: diskLevel(diskFree) }),
        internet: () => Promise.resolve('online'),
      },
    });
    const health = await monitor.system();
    expect(health.disk).toEqual({ freePercent: 9, status: 'critical' });
    expect(health.internet).toBe('online');
    expect(health.backup.usbDrivePresent).toBe(false); // no BACKUP_DRIVE_PATH configured
  });
});
