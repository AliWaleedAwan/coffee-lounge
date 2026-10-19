import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tx } from '../../src/platform/db/tx.ts';
import {
  canonicalJson,
  handleCommand,
  runIdempotent,
  type CommandResult,
} from '../../src/platform/idempotency.ts';
import { platformFixture, readyApps, type PlatformFixture } from '../support/platform.ts';

let fx: PlatformFixture;
beforeAll(async () => {
  fx = await platformFixture(25);
});
afterAll(async () => {
  await fx.close();
});

/** The "effect" under test: takes the next number from a gapless counter. */
const takeNumber =
  (scope: string) =>
  async (tx: Tx): Promise<CommandResult<{ number: string }>> => ({
    status: 201,
    body: { number: await tx.nextNumber('test', scope) },
  });

async function counterValue(scope: string): Promise<string | undefined> {
  const { rows } = await fx.pool.query<{ next_value: string }>(
    `SELECT next_value::text FROM cl.document_counters WHERE kind = 'test' AND scope_key = $1`,
    [scope],
  );
  return rows[0]?.next_value;
}

describe('idempotent commands (AT-72)', () => {
  it('runs once, then replays the same response for the same key and payload', async () => {
    const req = { scope: 'test.take', key: randomUUID(), actorRef: 'user:1', payload: { a: 1 } };
    const first = await runIdempotent(fx.pool, req, takeNumber('replay'));
    const second = await runIdempotent(fx.pool, req, takeNumber('replay'));
    expect(first).toEqual({ status: 201, body: { number: '1' }, replayed: false });
    expect(second).toEqual({ status: 201, body: { number: '1' }, replayed: true });
    expect(await counterValue('replay')).toBe('2'); // taken exactly once
  });

  it('treats payloads with the same content in a different key order as identical', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });

  it('refuses the same key with a different payload or a different actor', async () => {
    const key = randomUUID();
    await runIdempotent(
      fx.pool,
      { scope: 'test.take', key, actorRef: 'user:1', payload: { a: 1 } },
      takeNumber('reuse'),
    );
    await expect(
      runIdempotent(
        fx.pool,
        { scope: 'test.take', key, actorRef: 'user:1', payload: { a: 2 } },
        takeNumber('reuse'),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      runIdempotent(
        fx.pool,
        { scope: 'test.take', key, actorRef: 'user:2', payload: { a: 1 } },
        takeNumber('reuse'),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await counterValue('reuse')).toBe('2');
  });

  it('keeps nothing from a failed attempt, so a retry runs normally', async () => {
    const req = { scope: 'test.take', key: randomUUID(), actorRef: 'user:1', payload: {} };
    await expect(
      runIdempotent(fx.pool, req, async (tx) => {
        await tx.nextNumber('test', 'failed');
        throw new Error('stock check failed');
      }),
    ).rejects.toThrow('stock check failed');
    expect(await counterValue('failed')).toBeUndefined(); // rolled back with the key

    const retry = await runIdempotent(fx.pool, req, takeNumber('failed'));
    expect(retry).toEqual({ status: 201, body: { number: '1' }, replayed: false });
  });

  it('gives ten simultaneous duplicates one effect and the same answer (CT-style race)', async () => {
    const req = { scope: 'test.take', key: randomUUID(), actorRef: 'user:1', payload: { x: 1 } };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => runIdempotent(fx.pool, req, takeNumber('race'))),
    );
    expect(new Set(results.map((r) => r.body.number))).toEqual(new Set(['1']));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await counterValue('race')).toBe('2');
  });

  it('runs again once the stored key has expired', async () => {
    const req = { scope: 'test.take', key: randomUUID(), actorRef: 'user:1', payload: {} };
    await runIdempotent(fx.pool, req, takeNumber('expiry'));
    await fx.pool.query(
      `UPDATE cl.idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = $1`,
      [req.key],
    );
    const again = await runIdempotent(fx.pool, req, takeNumber('expiry'));
    expect(again).toEqual({ status: 201, body: { number: '2' }, replayed: false });
  });
});

describe('HTTP command helper', () => {
  const routes: FastifyPluginAsync = async (app) => {
    app.post('/take', (request, reply) =>
      handleCommand(
        fx.pool,
        request,
        reply,
        { scope: 'http.take', actorRef: 'user:7' },
        takeNumber('http'),
      ),
    );
  };

  it('requires a UUID Idempotency-Key, replays with Idempotent-Replayed, refuses reuse', async () => {
    const { staff } = readyApps(fx.pool, { staff: routes });
    const url = '/api/staff/v1/take';

    const missing = await staff.inject({ method: 'POST', url, payload: { n: 1 } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const key = randomUUID();
    const headers = { 'idempotency-key': key };
    const first = await staff.inject({ method: 'POST', url, headers, payload: { n: 1 } });
    const second = await staff.inject({ method: 'POST', url, headers, payload: { n: 1 } });
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());

    const reused = await staff.inject({ method: 'POST', url, headers, payload: { n: 2 } });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
