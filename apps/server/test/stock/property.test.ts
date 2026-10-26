/**
 * PT-01 (TEST_PLAN.md §7, in full since Phase 4 step 4.10): random sequences of receipts,
 * reservations, pickups, cancels, waste, counts, supplier returns and cost corrections on
 * a few ingredients, one of them lot-tracked with lots that expire along the way. After
 * every step: on hand = Σ movements, value = Σ movement values, reserved = Σ open
 * reservations, on hand = Σ lots for the lot-tracked item, one equal line cost per
 * consumption, value 0 at quantity 0, nothing negative. CL_PROP_RUNS / CL_PROP_SEED as in
 * test/support/random.ts.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postReceipt } from '../../src/modules/purchasing/index.ts';
import {
  adjustCost,
  consume,
  postCountLines,
  returnStock,
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
let countLine = 9_000_000_000;
/** Receipt lines posted in the current sequence: what returns and corrections act on. */
let received: { lineId: string; itemId: string; qty: string }[] = [];

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
      WHERE status = 'active' AND item_id = ANY($1::bigint[]) ORDER BY stock_reservations.order_line_id, stock_reservations.item_id`,
    [items],
  );
  const lines = [...new Set(open.map((r) => r.order_line_id))];
  const kinds = ['receipt', 'reserve', 'reserve', 'count', 'waste', 'expire'];
  if (lines.length > 0) kinds.push('consume', 'consume', 'release');
  if (received.length > 0) kinds.push('return', 'cost');
  const kind = random.pick(kinds);
  const lotItem = items[2] ?? '';
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
      } else if (kind === 'receipt') {
        const chosen = items.filter(() => random.chance(0.5));
        const posted = await postReceipt(
          tx,
          { key: randomUUID(), correlationId: randomUUID(), now: new Date() },
          {
            user: { id: ownerId } as never,
            device: {} as never,
            permissions: new Set(['inventory.receive']) as never,
          },
          {
            paidNow: false,
            lines: (chosen.length > 0 ? chosen : [random.pick(items)]).map((itemId) => ({
              itemId,
              qty: random.decimal(0.0001, 800, 4),
              lineCost: random.decimal(0, 400, 2),
              ...(itemId === lotItem
                ? {
                    lotCode: `L${String(random.int(1, 999))}`,
                    expiryDate: `2099-0${String(random.int(1, 9))}-15`,
                  }
                : {}),
            })),
          },
        );
        received.push(
          ...posted.lines.map((l) => ({ lineId: l.lineId, itemId: l.itemId, qty: l.qtyBase })),
        );
      } else if (kind === 'count') {
        const itemId = random.pick(items);
        let lotId: string | null = null;
        let book = '0';
        if (itemId === lotItem && random.chance(0.7)) {
          const { rows } = await tx.query<{ id: string; q: string }>(
            'SELECT id::text, qty_remaining::text AS q FROM cl.inventory_lots WHERE item_id = $1 ORDER BY inventory_lots.id',
            [itemId],
          );
          const lot = rows.length > 0 ? random.pick(rows) : undefined;
          lotId = lot?.id ?? null;
          book = lot?.q ?? '0';
        } else if (itemId !== lotItem) {
          const { rows } = await tx.query<{ q: string }>(
            'SELECT on_hand::text AS q FROM cl.inventory_balances WHERE item_id = $1',
            [itemId],
          );
          book = rows[0]?.q ?? '0';
        }
        countLine += 1;
        const counted = new Decimal(random.decimal(0, Number(book) + 200, 4));
        await postCountLines(tx, ctx, [
          {
            lineId: String(countLine),
            itemId,
            lotId,
            variance: counted.minus(book),
            newLotExpiry: lotId === null && itemId === lotItem ? '2099-12-31' : null,
          },
        ]);
      } else if (kind === 'return') {
        const line = random.pick(received);
        await returnStock(tx, ctx, {
          itemId: line.itemId,
          qty: new Decimal(random.decimal(0.0001, Number(line.qty), 4)),
          receiptLineId: line.lineId,
          key: randomUUID(),
          note: 'Property return',
        });
      } else if (kind === 'cost') {
        const line = random.pick(received);
        const delta = new Decimal(random.decimal(-200, 200, 2));
        if (!delta.isZero()) {
          await adjustCost(tx, ctx, {
            itemId: line.itemId,
            receiptLineId: line.lineId,
            qtyReceived: new Decimal(line.qty),
            delta,
            key: randomUUID(),
            note: 'Property correction',
          });
        }
      } else if (kind === 'expire') {
        // Time passes: one of the lot-tracked item's lots expires.
        await tx.query(
          `UPDATE cl.inventory_lots SET expiry_date = DATE '2000-01-01'
      WHERE id = (SELECT id FROM cl.inventory_lots WHERE item_id = $1 AND qty_remaining > 0
                   ORDER BY random() LIMIT 1)`,
          [lotItem],
        );
      } else if (kind === 'waste') {
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

describe('stock ledger invariants under random sequences (PT-01)', () => {
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
            // The third ingredient keeps lots with expiry dates.
            ...(i === 2 ? { trackLots: true, trackExpiry: true } : {}),
          });
          await postOpeningBalance(
            tx,
            { actorUserId: ownerId, businessDate: '2026-10-21' },
            audit,
            {
              itemId: id,
              qty: new Decimal(random.decimal(0, 1500, 4)),
              unitCost: new Decimal(random.decimal(0.01, 20, 8)),
              ...(i === 2 ? { expiryDate: '2099-06-30' } : {}),
            },
          );
          items.push(id);
        }
      });
      received = [];
      const history: string[] = [];
      for (let n = 0; n < 60; n++) {
        history.push(await step(random, items));
        const mismatches = (await findStockMismatches(fx.pool)).filter((m) =>
          items.includes(m.itemId),
        );
        expect(mismatches, `after ${history.join(', ')}`).toEqual([]);
      }
      // The sequence must have exercised the interesting paths at least sometimes.
      expect(history.some((h) => h === 'reserve')).toBe(true);
      expect(history.some((h) => h === 'receipt')).toBe(true);
    });
  });
});
