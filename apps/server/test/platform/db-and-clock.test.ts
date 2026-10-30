import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '../../src/platform/audit.ts';
import { checkClock, ClockJumpDetector } from '../../src/platform/clock.ts';
import { ConfigError, loadConfig } from '../../src/platform/config.ts';
import { loadMigrations } from '../../src/platform/db/migrate.ts';
import { LockOrderError, withTransaction } from '../../src/platform/db/tx.ts';
import { Readiness, runStartupChecks } from '../../src/platform/readiness.ts';
import { businessDateOf, shopDateOf } from '../../src/platform/settings.ts';
import { MIGRATIONS_DIR } from '../support/db.ts';
import { platformFixture, type PlatformFixture } from '../support/platform.ts';

let fx: PlatformFixture;
beforeAll(async () => {
  fx = await platformFixture(25);
});
afterAll(async () => {
  await fx.close();
});

describe('database value types (DATABASE.md §1)', () => {
  it('returns DATE as YYYY-MM-DD, NUMERIC and BIGINT as strings, TIMESTAMPTZ as an instant', async () => {
    const { rows } = await fx.pool.query<Record<string, unknown>>(
      `SELECT '2026-10-20'::date AS d, 1300.50::numeric(14,2) AS money,
              9007199254740993::bigint AS big, '2026-10-20T00:30:00+05:00'::timestamptz AS ts`,
    );
    const row = rows[0] ?? {};
    expect(row['d']).toBe('2026-10-20');
    expect(row['money']).toBe('1300.50');
    expect(row['big']).toBe('9007199254740993'); // beyond Number.MAX_SAFE_INTEGER, kept exact
    expect(row['ts']).toEqual(new Date('2026-10-19T19:30:00Z'));
  });
});

describe('transactions', () => {
  it('commits on success and rolls back everything on error', async () => {
    await withTransaction(fx.pool, (tx) => tx.nextNumber('tx', 'ok'));
    await expect(
      withTransaction(fx.pool, async (tx) => {
        await tx.nextNumber('tx', 'rolled-back');
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const { rows } = await fx.pool.query<{ scope_key: string }>(
      `SELECT scope_key FROM cl.document_counters WHERE kind = 'tx' ORDER BY scope_key`,
    );
    expect(rows.map((r) => r.scope_key)).toEqual(['ok']);
  });

  it('refuses to lock tables out of the global order (DATABASE.md §14)', async () => {
    await expect(
      withTransaction(fx.pool, async (tx) => {
        await tx.lock('order_rounds', []);
        await tx.lock('dining_sessions', []);
      }),
    ).rejects.toBeInstanceOf(LockOrderError);
    await expect(
      withTransaction(fx.pool, async (tx) => {
        await tx.nextNumber('tx', 'late');
        await tx.lock('invoices', []);
      }),
    ).rejects.toBeInstanceOf(LockOrderError);
  });

  it('refuses to lock a lower id after a higher id in the same table', async () => {
    // The order check runs before any SQL, so this works before Phase 3 creates the table.
    await expect(
      withTransaction(fx.pool, async (tx) => {
        await tx.lock('order_lines', ['20', '10']).catch((e: unknown) => {
          if (e instanceof LockOrderError) throw e; // ascending sort is fine; table missing is expected
        });
        await tx.lock('order_lines', ['5']);
      }),
    ).rejects.toBeInstanceOf(LockOrderError);
  });

  it('hands out gapless, unique numbers under concurrency', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        withTransaction(fx.pool, (tx) => tx.nextNumber('inv', '2026')),
      ),
    );
    expect(numbers.map(Number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });
});

describe('audit writer (AT-95, platform part)', () => {
  it('stores actor, action, before/after, reason and correlation id', async () => {
    const correlationId = randomUUID();
    const id = await writeAudit(
      fx.pool,
      { actor: { kind: 'system' }, correlationId, ip: '192.168.100.250' },
      {
        action: 'settings.update',
        entityType: 'system_setting',
        before: { value: 3 },
        after: { value: 4 },
        reason: 'test',
      },
    );
    const { rows } = await fx.pool.query(
      `SELECT actor_kind, action, before, after, reason, correlation_id::text, host(ip) AS ip
         FROM cl.audit_events WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      actor_kind: 'system',
      action: 'settings.update',
      before: { value: 3 },
      after: { value: 4 },
      reason: 'test',
      correlation_id: correlationId,
      ip: '192.168.100.250',
    });
  });
});

describe('startup checks and clock safety (AT-79)', () => {
  const run = async (readiness: Readiness, now: Date) =>
    runStartupChecks({
      db: fx.pool,
      migrations: await loadMigrations(MIGRATIONS_DIR),
      now,
      clockToleranceMs: 120_000,
      readiness,
    });

  it('becomes ready when the database, schema and clock are fine', async () => {
    const readiness = new Readiness();
    await run(readiness, new Date());
    expect(readiness.snapshot().blockers).toEqual({});
    expect(readiness.isReady()).toBe(true);
  });

  it('stays starting when the PC clock is behind the latest saved record', async () => {
    await fx.pool.query(
      `INSERT INTO cl.audit_events (actor_kind, action, entity_type, correlation_id, occurred_at)
       VALUES ('system', 'test.future', 'test', $1, now() + interval '1 day')`,
      [randomUUID()],
    );
    const readiness = new Readiness();
    await run(readiness, new Date());
    expect(readiness.isReady()).toBe(false);
    expect(readiness.snapshot().blockers['clock_behind']).toMatch(/PC clock is wrong/);

    // Once the clock is set correctly, the same check passes.
    await run(readiness, new Date(Date.now() + 2 * 86_400_000));
    expect(readiness.isReady()).toBe(true);
  });

  it('stays starting when the schema does not match this server version', async () => {
    const other = await platformFixture(2);
    try {
      await other.pool.query(`DELETE FROM cl_meta.schema_migrations WHERE version = '0003'`);
      const readiness = new Readiness();
      await runStartupChecks({
        db: other.pool,
        migrations: await loadMigrations(MIGRATIONS_DIR),
        now: new Date(),
        clockToleranceMs: 120_000,
        readiness,
      });
      expect(readiness.snapshot().blockers['migrations_pending']).toMatch(
        /0003_seed_settings not applied/,
      );
    } finally {
      await other.close();
    }
  });

  it('reports an unreachable database without throwing', async () => {
    const readiness = new Readiness();
    await runStartupChecks({
      db: { query: () => Promise.reject(new Error('connect ECONNREFUSED')) } as never,
      migrations: [],
      now: new Date(),
      clockToleranceMs: 0,
      readiness,
    });
    expect(readiness.snapshot().blockers['database_unreachable']).toMatch(/ECONNREFUSED/);
  });

  it('checkClock allows small differences within the tolerance', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    expect(checkClock(now, new Date('2026-10-20T10:01:00Z'), 120_000)).toEqual({ ok: true });
    expect(checkClock(now, null, 0)).toEqual({ ok: true });
    expect(checkClock(now, new Date('2026-10-20T10:03:00Z'), 120_000).ok).toBe(false);
  });

  it('detects wall-clock jumps against a monotonic clock', () => {
    let wall = 1_000_000;
    let mono = 0;
    const detector = new ClockJumpDetector(
      600_000,
      () => wall,
      () => mono,
    );
    wall += 60_000;
    mono += 60_000;
    expect(detector.sample()).toBeNull(); // normal minute
    wall -= 3_600_000; // clock reset back an hour
    mono += 60_000;
    expect(detector.sample()).toBe(-3_660_000);
  });
});

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

  it('applies defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      HOST: '0.0.0.0',
      CUSTOMER_PORT: 8080,
      STAFF_PORT: 8443,
      CLOCK_TOLERANCE_SECONDS: 120,
    });
  });

  it('rejects bad settings with a readable message', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, STAFF_TLS_CERT: 'c.pem' })).toThrow(/set together/);
    expect(() => loadConfig({ ...base, CUSTOMER_PORT: '8443' })).toThrow(/must differ/);
    expect(() => loadConfig({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(/postgres/);
  });
});

describe('business date and shop date (D-22)', () => {
  it('at 02:00 in Karachi the business day is still yesterday; the shop’s calendar date is today', async () => {
    const at = new Date('2026-10-31T02:00:00+05:00');
    expect(await businessDateOf(fx.pool, at)).toBe('2026-10-30');
    expect(await shopDateOf(fx.pool, at)).toBe('2026-10-31');
    const later = new Date('2026-10-31T04:00:00+05:00');
    expect(await businessDateOf(fx.pool, later)).toBe('2026-10-31');
  });
});
