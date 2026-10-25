/**
 * Self-tests for the concurrency harness (PLAN.md step 2.10): it must be able to show a
 * race when one exists, prove lock waits, and run the platform's own race-sensitive
 * code (gapless numbers, idempotency) with real overlap.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { runIdempotent } from '../../src/platform/idempotency.ts';
import { urlFor } from '../support/db.ts';
import {
  Barrier,
  BarrierTimeout,
  race,
  raceRuns,
  repeatRace,
  tally,
  waitUntilBlocked,
} from '../support/concurrency.ts';
import { platformFixture, type PlatformFixture } from '../support/platform.ts';

let fx: PlatformFixture;
let url: string;
beforeAll(async () => {
  fx = await platformFixture(4);
  url = urlFor(fx.db.name);
  await fx.pool.query('CREATE TABLE public.harness_counter (id int PRIMARY KEY, n int NOT NULL)');
  await fx.pool.query('CREATE TABLE public.harness_effects (key text NOT NULL)');
});
afterAll(async () => {
  await fx.close();
});

async function resetCounter(): Promise<void> {
  await fx.pool.query('TRUNCATE public.harness_counter');
  await fx.pool.query('INSERT INTO public.harness_counter VALUES (1, 0)');
}
const counter = async (): Promise<number> =>
  (await fx.pool.query<{ n: number }>('SELECT n FROM public.harness_counter WHERE id = 1')).rows[0]
    ?.n ?? -1;

describe('barrier', () => {
  it('releases every party at the same moment, only when the last arrives', async () => {
    const barrier = new Barrier(3);
    const released: number[] = [];
    const parties = [0, 30, 60].map(async (delay, i) => {
      await new Promise((r) => setTimeout(r, delay));
      await barrier.wait();
      released.push(i);
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(released).toEqual([]);
    expect(barrier.waiting).toBe(2);
    await Promise.all(parties);
    expect(released.sort()).toEqual([0, 1, 2]);
    await barrier.wait(); // after release it no longer blocks
  });

  it('fails the waiters if a party never arrives, instead of hanging', async () => {
    const barrier = new Barrier(2, 50);
    await expect(barrier.wait()).rejects.toBeInstanceOf(BarrierTimeout);
    expect(() => new Barrier(0)).toThrow();
  });
});

describe('races on real connections', () => {
  it('exposes a lost update every time when two transactions read before either writes', async () => {
    await repeatRace(raceRuns(), async () => {
      await resetCounter();
      const outcomes = await race({
        connectionString: url,
        contenders: 2,
        body: async ({ pool, barrier }) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const { rows } = await client.query<{ n: number }>(
              'SELECT n FROM public.harness_counter WHERE id = 1',
            );
            await barrier.wait(); // both have read 0
            await client.query('UPDATE public.harness_counter SET n = $1 WHERE id = 1', [
              (rows[0]?.n ?? 0) + 1,
            ]);
            await client.query('COMMIT');
          } finally {
            client.release();
          }
        },
      });
      expect(tally(outcomes).failed).toEqual([]);
      expect(await counter()).toBe(1); // 2 increments, 1 survives: the harness shows the bug
    });
  });

  it('shows the fix holds: with FOR UPDATE no increment is lost', async () => {
    const contenders = 6;
    await repeatRace(raceRuns(), async () => {
      await resetCounter();
      const outcomes = await race({
        connectionString: url,
        contenders,
        body: ({ pool, barrier }) =>
          withTransaction(pool, async (tx) => {
            await barrier.wait();
            const { rows } = await tx.query<{ n: number }>(
              'SELECT n FROM public.harness_counter WHERE id = 1 FOR UPDATE',
            );
            await tx.query('UPDATE public.harness_counter SET n = $1 WHERE id = 1', [
              (rows[0]?.n ?? 0) + 1,
            ]);
          }),
      });
      expect(tally(outcomes).failed).toEqual([]);
      expect(await counter()).toBe(contenders);
    });
  });

  it('proves that one transaction waited on the other’s lock', async () => {
    await resetCounter();
    let holderPid = 0;
    let waiterPid = 0;
    let releaseHolder: () => void = () => undefined;
    const holding = new Promise<void>((r) => {
      releaseHolder = r;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((r) => {
      locked = r;
    });

    const running = race({
      connectionString: url,
      contenders: 2,
      body: async ({ index, pool, pid }) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (index === 0) {
            holderPid = pid;
            await client.query('UPDATE public.harness_counter SET n = 10 WHERE id = 1');
            locked();
            await holding;
          } else {
            waiterPid = pid;
            await lockTaken;
            await client.query('UPDATE public.harness_counter SET n = n + 1 WHERE id = 1');
          }
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      },
    });
    await lockTaken;
    await new Promise((r) => setTimeout(r, 0));
    const blockers = await waitUntilBlocked(fx.pool, waiterPid);
    expect(blockers).toEqual([holderPid]);
    releaseHolder();
    expect(tally(await running).failed).toEqual([]);
    expect(await counter()).toBe(11); // the waiter saw the holder's committed value
  });

  it('reports every outcome, does not strand others when one fails, and catches leaks', async () => {
    const outcomes = await race({
      connectionString: url,
      contenders: 3,
      barrierTimeoutMs: 2_000,
      body: async ({ index, pool, barrier }) => {
        if (index === 1) throw Object.assign(new Error('boom'), { code: 'TEST_FAILURE' });
        await barrier.wait();
        return (await pool.query<{ one: number }>('SELECT 1 AS one')).rows[0]?.one;
      },
    });
    expect(tally(outcomes)).toEqual({ ok: [1, 1], failed: ['TEST_FAILURE'] });

    await expect(
      race({
        connectionString: url,
        contenders: 1,
        body: async ({ pool }) => {
          await pool.connect(); // never released
        },
      }),
    ).rejects.toThrow(/did not release/);
  });
});

describe('platform code under real overlap', () => {
  it('hands out gapless, unique document numbers when settlements collide', async () => {
    const contenders = 8;
    await repeatRace(raceRuns(), async (run) => {
      const scope = `harness-${String(run)}`;
      const outcomes = await race({
        connectionString: url,
        contenders,
        body: ({ pool, barrier }) =>
          withTransaction(pool, async (tx) => {
            await barrier.wait();
            return tx.nextNumber('harness', scope);
          }),
      });
      const numbers = tally(outcomes)
        .ok.map(Number)
        .sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: contenders }, (_, i) => i + 1));
    });
  });

  it('runs a command once when the same Idempotency-Key arrives on several devices at once', async () => {
    const contenders = 5;
    await repeatRace(raceRuns(), async () => {
      const key = randomUUID();
      const outcomes = await race({
        connectionString: url,
        contenders,
        body: async ({ pool, barrier }) => {
          await barrier.wait();
          return runIdempotent(
            pool,
            { scope: 'harness.effect', key, actorRef: 'device:1', payload: { a: 1 } },
            async (tx) => {
              await tx.query('INSERT INTO public.harness_effects (key) VALUES ($1)', [key]);
              return { status: 201, body: { done: true } };
            },
          );
        },
      });
      const results = tally(outcomes);
      expect(results.failed).toEqual([]);
      expect(results.ok.filter((r) => !r.replayed)).toHaveLength(1);
      expect(results.ok.every((r) => r.status === 201)).toBe(true);
      const { rows } = await fx.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.harness_effects WHERE key = $1',
        [key],
      );
      expect(rows[0]?.n).toBe(1);
    });
  });
});
