/**
 * The installed API and worker log in as a member of cl_app, never as the schema owner
 * (DATABASE.md §12, WINDOWS_DEPLOYMENT.md §2). Every connection here acts as cl_app, so
 * a missing grant fails the test instead of the first morning in the shop.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob } from '../../src/platform/jobs.ts';
import { workerStatus } from '../../src/platform/health.ts';
import { LiveHub } from '../../src/platform/live-hub.ts';
import { loadMigrations } from '../../src/platform/db/migrate.ts';
import { publish } from '../../src/platform/outbox.ts';
import { Readiness, runStartupChecks } from '../../src/platform/readiness.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { Heartbeat, pruneIdempotencyKeys, pruneOutbox } from '../../src/worker/maintenance.ts';
import { silentLogger, startRunner } from '../../src/worker/runner.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
});
afterAll(async () => {
  await fx.close();
});

describe('services running with only the cl_app role', () => {
  it('acts as cl_app (the test would prove nothing otherwise)', async () => {
    const { rows } = await fx.pool.query<{ who: string }>('SELECT current_user AS who');
    expect(rows[0]?.who).toBe('cl_app');
  });

  it('passes the startup checks (migrations, clock)', async () => {
    const readiness = new Readiness();
    await runStartupChecks({
      db: fx.pool,
      migrations: await loadMigrations(fileURLToPath(new URL('../../migrations', import.meta.url))),
      now: new Date(),
      clockToleranceMs: 120_000,
      readiness,
    });
    expect(readiness.snapshot().blockers).toEqual({});
  });

  it('publishes and delivers live updates', async () => {
    const hub = new LiveHub({
      pool: fx.pool,
      connectListener: async () => {
        const client = new pg.Client({
          connectionString: urlFor(fx.db.name),
          options: '-c role=cl_app',
        });
        await client.connect();
        return client;
      },
      pollMs: 50,
    });
    await hub.start();
    try {
      const seen: string[] = [];
      await hub.subscribe({ id: 'x', canSee: () => true, write: (f) => seen.push(f) > 0 });
      const id = await withTransaction(fx.pool, (tx) =>
        publish(tx, {
          type: 'table.changed',
          entityType: 'table',
          entityId: '1',
          topics: ['floor'],
        }),
      );
      const end = Date.now() + 3_000;
      while (!seen.some((f) => f.includes(`id: ${id}\n`)) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(seen.some((f) => f.includes(`id: ${id}\n`))).toBe(true);
    } finally {
      await hub.stop();
    }
  });

  it('queues jobs in business transactions and runs them in the worker', async () => {
    const ran: number[] = [];
    await withTransaction(fx.pool, (tx) => enqueueJob(tx, 'test:least_privilege', { n: 7 }));
    const runner = await startRunner({
      pool: fx.pool,
      pollInterval: 100,
      logger: silentLogger,
      crontab: '',
      taskList: {
        'test:least_privilege': async (payload) => {
          ran.push((payload as { n: number }).n);
        },
      },
    });
    try {
      const end = Date.now() + 10_000;
      while (ran.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(ran).toEqual([7]);
    } finally {
      await runner.stop();
    }
  });

  it('keeps the heartbeat and housekeeping working', async () => {
    await new Heartbeat(fx.pool, 'worker', '1.0.0').beat();
    expect((await workerStatus(fx.pool)).status).toBe('ok');
    await pruneIdempotencyKeys(fx.pool);
    await pruneOutbox(fx.pool);
  });

  it('serves device registration, login and the health page', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    expect((await owner.call({ url: '/api/staff/v1/auth/me' })).statusCode).toBe(200);
    const health = await owner.call({ url: '/api/staff/v1/system/health' });
    expect(health.statusCode).toBe(200);
  });

  it('finds every job-queue object owned by cl_jobs (after each job-queue migration)', async () => {
    const { rows } = await fx.pool.query<{ kind: string; name: string }>(`
    SELECT 'relation' AS kind, c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'graphile_worker' AND pg_get_userbyid(c.relowner) <> 'cl_jobs'
    UNION ALL
    SELECT 'function', p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'graphile_worker' AND pg_get_userbyid(p.proowner) <> 'cl_jobs'
    UNION ALL
    SELECT 'type', t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'graphile_worker' AND pg_get_userbyid(t.typowner) <> 'cl_jobs'
    UNION ALL
    SELECT 'schema', nspname FROM pg_namespace
     WHERE nspname = 'graphile_worker' AND pg_get_userbyid(nspowner) <> 'cl_jobs'`);
    expect(rows).toEqual([]);
  });

  it('cannot change the schema or rewrite history (append-only stays enforced)', async () => {
    await expect(fx.pool.query('CREATE TABLE cl.sneaky (id int)')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(fx.pool.query('TRUNCATE cl.audit_events')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(fx.pool.query('DELETE FROM cl_meta.schema_migrations')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
