import { randomUUID } from 'node:crypto';
import { parseCrontab } from 'graphile-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob } from '../../src/platform/jobs.ts';
import { workerStatus } from '../../src/platform/health.ts';
import { Heartbeat, pruneIdempotencyKeys, pruneOutbox } from '../../src/worker/maintenance.ts';
import { CRONTAB, makeTasks, silentLogger, startRunner } from '../../src/worker/runner.ts';
import { urlFor } from '../support/db.ts';
import { platformFixture, type PlatformFixture } from '../support/platform.ts';

let fx: PlatformFixture;
/** Connections that act as the application role, as the installed worker does (DATABASE.md §12). */
let appPool: pg.Pool;

beforeAll(async () => {
  fx = await platformFixture(6);
  appPool = new pg.Pool({
    connectionString: urlFor(fx.db.name),
    max: 2,
    options: '-c role=cl_app',
  });
});
afterAll(async () => {
  await appPool.end();
  await fx.close();
});

async function addKey(expiresIn: string): Promise<void> {
  await fx.pool.query(
    `INSERT INTO cl.idempotency_keys (scope, key, actor_ref, request_hash, expires_at)
     VALUES ('test', $1, 'device:1', '\\x00', now() + $2::interval)`,
    [randomUUID(), expiresIn],
  );
}
async function addHint(age: string): Promise<void> {
  await fx.pool.query(
    `INSERT INTO cl.outbox_events (topics, event_type, entity_type, entity_id, created_at)
     VALUES ('{system}', 'test.hint', 'test', 1, now() - $1::interval)`,
    [age],
  );
}
const count = async (table: string): Promise<number> =>
  Number((await fx.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

describe('housekeeping', () => {
  it('prunes only expired idempotency keys, as the application role', async () => {
    await fx.pool.query('DELETE FROM cl.idempotency_keys');
    await addKey('-1 minute');
    await addKey('-2 hours');
    await addKey('+1 hour');
    expect(await pruneIdempotencyKeys(appPool)).toBe(2);
    expect(await count('cl.idempotency_keys')).toBe(1);
  });

  it('prunes live-update hints older than 24 hours, as the application role', async () => {
    await fx.pool.query('DELETE FROM cl.outbox_events');
    await addHint('25 hours');
    await addHint('23 hours');
    await addHint('0 seconds');
    expect(await pruneOutbox(appPool)).toBe(1);
    expect(await count('cl.outbox_events')).toBe(2);
  });
});

describe('heartbeat', () => {
  it('reports down before the first beat, ok after it and stale after 60 s of silence', async () => {
    expect(await workerStatus(fx.pool, 'hb-test')).toEqual({
      status: 'down',
      lastHeartbeatAt: null,
    });
    const heartbeat = new Heartbeat(appPool, 'hb-test', '1.2.3');
    await heartbeat.beat();
    await heartbeat.beat(); // the second beat updates the same row
    const ok = await workerStatus(fx.pool, 'hb-test');
    expect(ok.status).toBe('ok');
    expect(ok.lastHeartbeatAt).toBeInstanceOf(Date);
    const { rows } = await fx.pool.query(
      `SELECT pid, version FROM cl.worker_heartbeats WHERE worker_name = 'hb-test'`,
    );
    expect(rows).toEqual([{ pid: process.pid, version: '1.2.3' }]);

    await fx.pool.query(
      `UPDATE cl.worker_heartbeats SET beat_at = now() - interval '61 seconds' WHERE worker_name = 'hb-test'`,
    );
    expect((await workerStatus(fx.pool, 'hb-test')).status).toBe('stale');
  });

  it('beats on a timer until stopped and reports errors instead of throwing', async () => {
    const heartbeat = new Heartbeat(appPool, 'hb-timer', '1.0.0');
    const errors: unknown[] = [];
    heartbeat.start((e) => errors.push(e), 50);
    await new Promise((r) => setTimeout(r, 200));
    heartbeat.stop();
    expect(errors).toEqual([]);
    const first = (await workerStatus(fx.pool, 'hb-timer')).lastHeartbeatAt;
    await new Promise((r) => setTimeout(r, 150));
    expect((await workerStatus(fx.pool, 'hb-timer')).lastHeartbeatAt).toEqual(first);

    const broken = new Heartbeat(appPool, 'x'.repeat(10), '1.0.0');
    await fx.pool.query(
      'ALTER TABLE cl.worker_heartbeats ADD CONSTRAINT short_name CHECK (length(worker_name) < 5) NOT VALID',
    );
    try {
      const failures: unknown[] = [];
      broken.start((e) => failures.push(e), 1_000);
      await new Promise((r) => setTimeout(r, 100));
      broken.stop();
      expect(failures).toHaveLength(1);
    } finally {
      await fx.pool.query('ALTER TABLE cl.worker_heartbeats DROP CONSTRAINT short_name');
    }
  });
});

describe('job queue', () => {
  const jobsFor = async (task: string): Promise<number> =>
    Number(
      (
        await fx.pool.query<{ n: string }>(
          'SELECT count(*) AS n FROM graphile_worker.jobs WHERE task_identifier = $1',
          [task],
        )
      ).rows[0]?.n,
    );

  it('adds a job only if the surrounding transaction commits', async () => {
    const client = await fx.pool.connect();
    try {
      await client.query('BEGIN');
      await enqueueJob(client, 'test:rolled_back', { n: 1 });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await enqueueJob(client, 'test:committed', { n: 2 });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await jobsFor('test:rolled_back')).toBe(0);
    expect(await jobsFor('test:committed')).toBe(1);
  });

  it('de-duplicates pending jobs by key and rejects malformed task names', async () => {
    const first = await enqueueJob(fx.pool, 'test:keyed', { copy: 1 }, { jobKey: 'ticket:7' });
    const second = await enqueueJob(fx.pool, 'test:keyed', { copy: 2 }, { jobKey: 'ticket:7' });
    expect(second).toBe(first);
    expect(await jobsFor('test:keyed')).toBe(1);
    await expect(enqueueJob(fx.pool, 'Drop Table', {})).rejects.toThrow(/Invalid task name/);
  });

  it('runs queued maintenance jobs with the project task list', async () => {
    await fx.pool.query('DELETE FROM cl.outbox_events');
    await addHint('30 hours');
    await addHint('1 hour');
    const runner = await startRunner({
      pool: fx.pool,
      pollInterval: 100,
      logger: silentLogger,
      crontab: '',
    });
    try {
      await enqueueJob(fx.pool, 'maintenance:prune_outbox', {});
      const end = Date.now() + 10_000;
      while ((await jobsFor('maintenance:prune_outbox')) > 0) {
        if (Date.now() > end) throw new Error('job did not run');
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await runner.stop();
    }
    expect(await count('cl.outbox_events')).toBe(1);
  });

  it('schedules every task with a handler: housekeeping, printing, order and stock alerts, the nightly stock check', () => {
    const tasks = makeTasks(fx.pool);
    expect(Object.keys(tasks).sort()).toEqual([
      'maintenance:prune_idempotency_keys',
      'maintenance:prune_logs',
      'maintenance:prune_outbox',
      'orders:escalate',
      'orders:expire_unpaid_takeaway',
      'orders:uncollected_scan',
      'print:dispatch',
      'print:sweep',
      'sessions:stale_scan',
      'stock:reconcile',
      'stock:stale_reservations',
    ]);
    // print:dispatch is queued per printer by print jobs, not scheduled.
    expect(parseCrontab(CRONTAB).map((c) => [c.task, c.match.length > 0])).toEqual(
      CRONTAB.split('\n').map((line) => [line.split(' ')[5], true]),
    );
    expect(
      Object.fromEntries(
        CRONTAB.split('\n').map((line) => [
          line.split(' ')[5],
          line.split(' ').slice(0, 5).join(' '),
        ]),
      ),
    ).toEqual({
      'maintenance:prune_idempotency_keys': '5 * * * *',
      'print:sweep': '* * * * *',
      'maintenance:prune_logs': '30 3 * * *',
      'maintenance:prune_outbox': '35 * * * *',
      'orders:escalate': '* * * * *',
      'orders:expire_unpaid_takeaway': '* * * * *',
      'orders:uncollected_scan': '*/5 * * * *',
      'sessions:stale_scan': '*/10 * * * *',
      'stock:stale_reservations': '15 * * * *',
      'stock:reconcile': '10 4 * * *',
    });
    for (const line of CRONTAB.split('\n')) expect(tasks[line.split(' ')[5] ?? '']).toBeDefined();
  });
});
