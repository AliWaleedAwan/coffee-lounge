/**
 * PT-01 (Phase 3 subset, TEST_PLAN.md §7): random sequences of reservations, pickups,
 * cancels and waste on a few ingredients. After every step: on hand = Σ movements,
 * value = Σ movement values, reserved = Σ open reservations, one equal line cost per
 * consumption, value 0 at quantity 0, nothing negative. Receipts and counts join the
 * sequence in Phase 4. CL_PROP_RUNS / CL_PROP_SEED as in test/support/random.ts.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  createInventoryItem,
  findStockMismatches,
  postOpeningBalance,
  release,
  reserve,
  wasteIngredient,
  type Take,
} from '../../src/modules/stock/index.ts';
import { AppError } from '../../src/platform/errors.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { platformFixture, type PlatformFixture } from '../support/platform.ts';
import { testOrderLines } from '../support/orders.ts';
import { forEachSeed, propRuns, type Random } from '../support/random.ts';

let fx: PlatformFixture;
let ownerId: string;
beforeAll(async () => {
  fx = await platformFixture(4, 'cl_app');
  const { rows } = await fx.pool.query<{ id: string }>(
    `INSERT INTO cl.users (username, display_name, password_hash, is_owner)
     VALUES ('owner', 'Owner', 'x', true) RETURNING id::text`,
  );
  ownerId = rows[0]?.id ?? '';
});
afterAll(async () => {
  await fx.close();
});

let sequence = 0;

/** Errors the services are expected to answer with; anything else fails the property. */
function expected(error: unknown): boolean {
  return (
    error instanceof AppError && ['INSUFFICIENT_STOCK', 'VALIDATION_FAILED'].includes(error.code)
  );
}

async function step(random: Random, items: string[]): Promise<string> {
  const audit = { actor: { kind: 'user' as const, userId: ownerId }, correlationId: randomUUID() };
  const ctx = { actorUserId: ownerId, businessDate: '2026-10-21' };
  const { rows: open } = await fx.pool.query<{ order_line_id: string; item_id: string }>(
    `SELECT order_line_id::text, item_id::text FROM cl.stock_reservations
      WHERE status = 'active' AND item_id = ANY($1::bigint[]) ORDER BY order_line_id, item_id`,
    [items],
  );
  const lines = [...new Set(open.map((r) => r.order_line_id))];
  const kind =
    lines.length === 0
      ? 'reserve'
      : random.pick(['reserve', 'reserve', 'consume', 'consume', 'release', 'waste']);
  const takesFor = (line: string): Take[] =>
    open
      .filter((r) => r.order_line_id === line)
      .map((r) => ({
        itemId: r.item_id,
        qty: random.chance(0.4) ? 'rest' : new Decimal(random.decimal(0, 60, 4)),
      }));

  try {
    await withTransaction(fx.pool, async (tx) => {
      if (kind === 'reserve') {
        const chosen = items.filter(() => random.chance(0.6));
        const need = new Map(
          (chosen.length > 0 ? chosen : [random.pick(items)]).map((id) => [
            id,
            new Decimal(random.decimal(0.0001, 400, 4)),
          ]),
        );
        const [line = ''] = await testOrderLines(fx.pool, ownerId);
        await reserve(tx, { orderLineId: line, requirement: need });
      } else if (kind === 'consume') {
        const line = random.pick(lines);
        await consume(tx, ctx, {
          orderLineId: line,
          eventKey: randomUUID(),
          takes: takesFor(line),
        });
      } else if (kind === 'release') {
        const line = random.pick(lines);
        await release(tx, { orderLineId: line, takes: takesFor(line) });
      } else {
        await wasteIngredient(tx, ctx, audit, {
          itemId: random.pick(items),
          qty: new Decimal(random.decimal(0.0001, 300, 4)),
          reasonCode: random.pick(['spilled', 'damaged', 'expired']),
          key: randomUUID(),
        });
      }
    });
  } catch (error) {
    // A partial take larger than what is open is a caller bug the ledger refuses loudly.
    if (!expected(error) && !(error instanceof Error && /cannot take/.test(error.message)))
      throw error;
    return `${kind} refused`;
  }
  return kind;
}

describe('stock ledger invariants under random sequences (PT-01 subset)', () => {
  it('keeps balances equal to their movements and reservations after every step', async () => {
    await forEachSeed(propRuns(6), async (random) => {
      sequence += 1;
      const items: string[] = [];
      await withTransaction(fx.pool, async (tx) => {
        const audit = {
          actor: { kind: 'user' as const, userId: ownerId },
          correlationId: randomUUID(),
        };
        for (let i = 0; i < 3; i++) {
          const { id } = await createInventoryItem(tx, audit, {
            sku: `P${String(sequence)}-${String(i)}`,
            name: `Prop ${String(sequence)}.${String(i)}`,
            baseUom: 'ml',
            lowThreshold: random.decimal(0, 200, 0),
          });
          await postOpeningBalance(
            tx,
            { actorUserId: ownerId, businessDate: '2026-10-21' },
            audit,
            {
              itemId: id,
              qty: new Decimal(random.decimal(0, 1500, 4)),
              unitCost: new Decimal(random.decimal(0.01, 20, 8)),
            },
          );
          items.push(id);
        }
      });
      const history: string[] = [];
      for (let n = 0; n < 40; n++) {
        history.push(await step(random, items));
        const mismatches = (await findStockMismatches(fx.pool)).filter((m) =>
          items.includes(m.itemId),
        );
        expect(mismatches, `after ${history.join(', ')}`).toEqual([]);
      }
      // The sequence must have exercised the interesting paths at least sometimes.
      expect(history.some((h) => h === 'reserve')).toBe(true);
    });
  });
});
