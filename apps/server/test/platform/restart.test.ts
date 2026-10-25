/**
 * AT-17, foundation part: PostgreSQL restarting under a running API, live hub and job
 * runner. A real service restart needs the PostgreSQL superuser, so it is simulated by
 * terminating every connection to the test database (what clients see when the server
 * restarts). The Windows power-cut drill covers the real thing (WINDOWS_DEPLOYMENT.md §4).
 */
import { randomUUID } from 'node:crypto';
import type { Runner } from 'graphile-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob } from '../../src/platform/jobs.ts';
import { LiveHub } from '../../src/platform/live-hub.ts';
import { publish } from '../../src/platform/outbox.ts';
import { silentLogger, startRunner } from '../../src/worker/runner.ts';
import { urlFor, withAdmin } from '../support/db.ts';
import { identityFixture, OWNER, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let runner: Runner;
const ran: number[] = [];

beforeAll(async () => {
  fx = await identityFixture({
    makeHub: (pool) =>
      new LiveHub({
        pool,
        connectListener: async () => {
          const client = new pg.Client({ connectionString: urlFor(fx.db.name) });
          await client.connect();
          return client;
        },
        pollMs: 100,
        gapGraceMs: 200,
      }),
  });
  await fx.hub.start();
  runner = await startRunner({
    pool: fx.pool,
    pollInterval: 100,
    logger: silentLogger,
    crontab: '',
    taskList: {
      'test:record': async (payload) => {
        ran.push((payload as { n: number }).n);
      },
    },
  });
});
afterAll(async () => {
  await runner.stop();
  await fx.hub.stop();
  await fx.close();
});

async function eventually<T>(
  attempt: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('did not recover in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('database restart while the services run (AT-17, foundation part)', () => {
  it('keeps sessions, runs pending jobs, resumes live updates and reports ready again', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const received: string[] = [];
    await fx.hub.subscribe({
      id: randomUUID(),
      canSee: () => true,
      write: (frame) => {
        received.push(frame);
        return true;
      },
    });
    // A job committed before the restart, due shortly after it.
    await enqueueJob(fx.pool, 'test:record', { n: 1 }, { runAt: new Date(Date.now() + 1_500) });

    const killed = await withAdmin(async (admin) => {
      const { rowCount } = await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [fx.db.name],
      );
      return rowCount ?? 0;
    });
    expect(killed).toBeGreaterThan(2); // pool, LISTEN connection, job runner

    // While connections are re-established, requests fail as 503 (retryable), never 500.
    const statuses: number[] = [];
    await eventually(async () => {
      const res = await owner.call({ url: '/api/staff/v1/auth/me' });
      statuses.push(res.statusCode);
      return res.statusCode === 200 ? res : undefined;
    });
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);

    await eventually(async () => {
      const res = await fx.staff.inject({ url: '/health/ready' });
      return res.statusCode === 200 ? res : undefined;
    });

    await enqueueJob(fx.pool, 'test:record', { n: 2 });
    await eventually(async () => (ran.includes(1) && ran.includes(2) ? true : undefined));

    const client = await fx.pool.connect();
    let id: string;
    try {
      await client.query('BEGIN');
      id = await publish(client, {
        type: 'table.changed',
        entityType: 'table',
        entityId: '3',
        topics: ['floor'],
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await eventually(async () =>
      received.some((f) => f.includes(`id: ${id}\n`)) ? true : undefined,
    );
  });
});
