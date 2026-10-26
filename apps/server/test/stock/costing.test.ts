/**
 * Costing through the real services (Phase 4 step 4.6). AT-33: the Phase 0 §5.2 milk
 * events give the worked example's weighted-average values exactly. AT-66: the
 * COST_VALUATION.md §10 fixture (drain rule, found stock at the last cost) gives its exact
 * values. AT-68: a supplier price correction splits between stock and variance as §6 says,
 * owner only, and changes nothing posted before. AT-19 (cost part): line costs already
 * frozen stay as they were after corrections and later receipts.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consume, findStockMismatches, reserve } from '../../src/modules/stock/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { testOrderLines } from '../support/orders.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let manager: Client;
let today = '';

type Body = Record<string, unknown>;
const d = (v: string) => new Decimal(v);
async function call(client: Client, method: 'GET' | 'POST', path: string, payload?: object) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}
const ctx = () => ({ actorUserId: fx.ownerId, businessDate: today });

let skuCounter = 0;
async function newItem(): Promise<string> {
  skuCounter += 1;
  const res = await call(clerk, 'POST', '/inventory/items', {
    sku: `cost-${String(skuCounter)}`,
    name: `Costing milk ${String(skuCounter)}`,
    baseUom: 'ml',
  });
  return res.body['id'] as string;
}

/** A receipt of `litres` for `cost`; the first one starts stock control (empty shelf). */
async function receipt(itemId: string, qty: string, cost: string, first = false) {
  const res = await call(clerk, 'POST', '/purchase-receipts', {
    paidNow: false,
    ...(first ? { startStockControl: [itemId] } : {}),
    lines: [{ itemId, qty, lineCost: cost }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { receiptId: string; lines: { lineId: string }[] };
}

/** A pickup of `qty` ml: reserve and consume; returns the frozen line cost. */
async function pickup(itemId: string, qty: string): Promise<string> {
  const [l = ''] = await testOrderLines(fx.pool, fx.ownerId);
  await withTransaction(fx.pool, (t) =>
    reserve(t, { orderLineId: l, requirement: new Map([[itemId, d(qty)]]) }),
  );
  const { value } = await withTransaction(fx.pool, (t) =>
    consume(t, ctx(), { orderLineId: l, eventKey: randomUUID(), takes: [{ itemId, qty: 'rest' }] }),
  );
  return value.toFixed(4);
}

async function waste(itemId: string, qty: string): Promise<string> {
  const res = await call(owner, 'POST', '/inventory/waste', { itemId, qty, reasonCode: 'damaged' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body['value'] as string;
}

/** A count by the clerk, approved by the owner when needed; returns the movement value. */
async function count(itemId: string, counted: string): Promise<string> {
  const started = await call(clerk, 'POST', '/stock-counts', { scope: 'items', itemIds: [itemId] });
  const countId = started.body['id'] as string;
  await call(clerk, 'POST', `/stock-counts/${countId}/lines`, { itemId, countedQty: counted });
  const submitted = await call(clerk, 'POST', `/stock-counts/${countId}/submit`, {});
  if (submitted.body['status'] === 'submitted') {
    expect((await call(owner, 'POST', `/stock-counts/${countId}/approve`, {})).status).toBe(200);
  }
  const { rows } = await fx.pool.query<{ v: string }>(
    `SELECT m.value_delta::text AS v FROM cl.stock_count_lines l JOIN cl.stock_movements m ON m.id = l.movement_id
      WHERE l.count_id = $1`,
    [countId],
  );
  return rows[0]?.v ?? '';
}

async function balance(itemId: string) {
  const { rows } = await fx.pool.query<{ q: string; v: string; l: string | null }>(
    `SELECT on_hand::text AS q, inventory_value::text AS v, last_unit_cost::text AS l
       FROM cl.inventory_balances WHERE item_id = $1`,
    [itemId],
  );
  return rows[0];
}
const avg = async (itemId: string) => {
  const b = await balance(itemId);
  return d(b?.v ?? '0')
    .dividedBy(b?.q ?? '1')
    .toDecimalPlaces(8)
    .toFixed(8);
};

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('cost-clerk', ['inventory_clerk']);
  await fx.addUser('cost-mgr', ['manager']);
  clerk = await fx.loggedIn('cost-clerk');
  manager = await fx.loggedIn('cost-mgr');
  today = await businessDateOf(fx.pool, new Date());
});
afterAll(async () => {
  await fx.close();
});

describe('the Phase 0 §5.2 milk example through the services (AT-33)', () => {
  it('gives the worked example’s values exactly', async () => {
    const milk = await newItem();
    const two = (v: string) => d(v).abs().toFixed(2);
    await receipt(milk, '20000', '5000.00', true); // 1. R1 20 L @ Rs 250/L
    expect(await balance(milk)).toMatchObject({ q: '20000.0000', v: '5000.0000' });
    expect(two(await pickup(milk, '12000'))).toBe('3000.00'); // 2.
    expect((await balance(milk))?.v).toBe('2000.0000');
    await receipt(milk, '30000', '8100.00'); // 3. R2 30 L @ Rs 270/L
    expect(await avg(milk)).toBe('0.26578947');
    expect(two(await pickup(milk, '25000'))).toBe('6644.74'); // 4.
    expect((await balance(milk))?.v).toBe('3455.2632');
    expect(two(await waste(milk, '1000'))).toBe('265.79'); // 5.
    expect((await balance(milk))?.v).toBe('3189.4737');
    expect(two(await count(milk, '11500'))).toBe('132.89'); // 6. count −500 (4 %: approved)
    expect(await balance(milk)).toMatchObject({ q: '11500.0000', v: '3056.5790' });
    await receipt(milk, '20000', '6000.00'); // 7. R3 20 L @ Rs 300/L
    expect(await balance(milk)).toMatchObject({ q: '31500.0000', v: '9056.5790' });
    expect(two(await pickup(milk, '15000'))).toBe('4312.66'); // 8.
    expect(await balance(milk)).toMatchObject({ q: '16500.0000', v: '4743.9223' });
    expect(d((await balance(milk))?.v ?? '0').toFixed(2)).toBe('4743.92');
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });
});

describe('the COST_VALUATION.md §10 fixture through the services (AT-66)', () => {
  it('follows the drain rule and values found stock at the last cost', async () => {
    const milk = await newItem();
    await receipt(milk, '3000', '805.00', true); // 1.
    expect(await pickup(milk, '157.5')).toBe('42.2625'); // 2.
    expect(await pickup(milk, '157.5')).toBe('42.2625'); // 3.
    expect((await balance(milk))?.v).toBe('720.4750');
    expect(await count(milk, '2600')).toBe('-22.8083'); // 4. variance −85
    expect(await balance(milk)).toMatchObject({ q: '2600.0000', v: '697.6667' });
    expect(await avg(milk)).toBe('0.26833335');
    expect(await waste(milk, '2600')).toBe('697.6667'); // 5. drain rule
    expect(await balance(milk)).toEqual({ q: '0.0000', v: '0.0000', l: '0.26833335' });
    expect(await count(milk, '500')).toBe('134.1667'); // 6. found 500 at L
    expect(await balance(milk)).toMatchObject({ q: '500.0000', v: '134.1667' });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });
});

describe('supplier price corrections (AT-68, AT-19)', () => {
  it('puts the share still on hand into stock and the rest into variance; nothing earlier changes', async () => {
    const milk = await newItem();
    const posted = await receipt(milk, '6000', '1650.00', true); // A = 0.275
    const lineId = posted.lines[0]?.lineId ?? '';
    const used = await pickup(milk, '1500'); // 412.5, frozen
    expect(used).toBe('412.5000');
    const movementsBefore = await fx.pool.query(
      'SELECT id, value_delta FROM cl.stock_movements WHERE item_id = $1 ORDER BY id',
      [milk],
    );
    // The supplier's invoice said Rs 1,800: Δ = +150; 4,500 of 6,000 still here → 112.5 to stock.
    const res = await call(
      owner,
      'POST',
      `/purchase-receipts/${posted.receiptId}/cost-corrections`,
      {
        lineId,
        correctLineCost: '1800',
        reason: 'Invoice price was Rs 300 per litre',
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({
      delta: '150.00',
      toInventory: '112.5000',
      toVariance: '37.5000',
      lineCostNow: '1800.00',
    });
    expect(await balance(milk)).toMatchObject({ q: '4500.0000', v: '1350.0000' });
    const { rows: adj } = await fx.pool.query<Body>(
      `SELECT a.amount::text, a.to_inventory::text, a.to_variance::text, m.movement_type, m.qty_delta::text,
              m.value_delta::text
         FROM cl.cost_adjustments a JOIN cl.stock_movements m ON m.id = a.movement_id
        WHERE a.receipt_line_id = $1`,
      [lineId],
    );
    expect(adj).toEqual([
      {
        amount: '150.00',
        to_inventory: '112.5000',
        to_variance: '37.5000',
        movement_type: 'cost_adjustment',
        qty_delta: '0.0000',
        value_delta: '112.5000',
      },
    ]);
    // Past periods untouched: earlier movements and the frozen line cost stay (AT-19).
    const movementsAfter = await fx.pool.query(
      'SELECT id, value_delta FROM cl.stock_movements WHERE item_id = $1 AND id <= $2 ORDER BY id',
      [milk, (movementsBefore.rows.at(-1) as { id: string }).id],
    );
    expect(movementsAfter.rows).toEqual(movementsBefore.rows);
    const { rows: costs } = await fx.pool.query<{ value: string }>(
      'SELECT value::text FROM cl.order_line_costs WHERE item_id = $1',
      [milk],
    );
    expect(costs).toEqual([{ value: '412.5000' }]);
    // A later receipt at a new cost does not touch the frozen line cost either.
    await receipt(milk, '1000', '400.00');
    expect(
      (
        await fx.pool.query('SELECT value::text FROM cl.order_line_costs WHERE item_id = $1', [
          milk,
        ])
      ).rows,
    ).toEqual([{ value: '412.5000' }]);
    // Corrected again, back down: Δ is against the cost on record now (1,800).
    const back = await call(
      owner,
      'POST',
      `/purchase-receipts/${posted.receiptId}/cost-corrections`,
      {
        lineId,
        correctLineCost: '1650',
        reason: 'Supplier credit note',
      },
    );
    // 5,500 of the 6,000 are on hand now (the later receipt counts): −150 × 5500 / 6000.
    expect(back.body).toMatchObject({
      delta: '-150.00',
      toInventory: '-137.5000',
      toVariance: '-12.5000',
    });
    const same = await call(
      owner,
      'POST',
      `/purchase-receipts/${posted.receiptId}/cost-corrections`,
      {
        lineId,
        correctLineCost: '1650.00',
        reason: 'Again',
      },
    );
    expect(same.body['detail']).toBe('That line already costs 1650.00');
    const read = await call(owner, 'GET', `/purchase-receipts/${posted.receiptId}`);
    expect((read.body['lines'] as Body[])[0]).toMatchObject({
      lineCost: '1650.00',
      lineCostNow: '1650.00',
    });
    expect(
      (
        await call(owner, 'POST', `/purchase-receipts/${posted.receiptId}/reverse`, {
          reason: 'Wrong',
        })
      ).body['detail'],
    ).toBe('This receipt has returns or cost corrections. Return or waste the rest instead.');
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('sends everything to variance when nothing is left, and never takes value below zero', async () => {
    const milk = await newItem();
    const posted = await receipt(milk, '1000', '300.00', true);
    await waste(milk, '1000'); // nothing left
    const gone = await call(
      owner,
      'POST',
      `/purchase-receipts/${posted.receiptId}/cost-corrections`,
      {
        lineId: posted.lines[0]?.lineId,
        correctLineCost: '350',
        reason: 'Late invoice',
      },
    );
    expect(gone.body).toMatchObject({ toInventory: '0.0000', toVariance: '50.0000' });
    expect(await balance(milk)).toMatchObject({ q: '0.0000', v: '0.0000' });

    const other = await newItem();
    const big = await receipt(other, '1000', '1000.00', true);
    await pickup(other, '900'); // Q 100, V 100
    const down = await call(owner, 'POST', `/purchase-receipts/${big.receiptId}/cost-corrections`, {
      lineId: big.lines[0]?.lineId,
      correctLineCost: '0',
      reason: 'Free sample after all',
    });
    // Δ −1000 × 100/1000 = −100 to stock (V reaches 0, not below), −900 variance.
    expect(down.body).toMatchObject({ toInventory: '-100.0000', toVariance: '-900.0000' });
    expect(await balance(other)).toMatchObject({ q: '100.0000', v: '0.0000' });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('is for the owner only (inventory.cost_adjust)', async () => {
    const milk = await newItem();
    const posted = await receipt(milk, '1000', '300.00', true);
    const body = { lineId: posted.lines[0]?.lineId, correctLineCost: '310', reason: 'Invoice' };
    expect(
      (await call(clerk, 'POST', `/purchase-receipts/${posted.receiptId}/cost-corrections`, body))
        .status,
    ).toBe(403);
    expect(
      (await call(manager, 'POST', `/purchase-receipts/${posted.receiptId}/cost-corrections`, body))
        .status,
    ).toBe(403);
    const asClerk = await call(clerk, 'GET', `/purchase-receipts/${posted.receiptId}`);
    expect((asClerk.body['lines'] as Body[])[0]?.['lineCostNow']).toBe('300.00'); // the clerk receives: sees costs
    const asManager = await call(manager, 'GET', `/purchase-receipts/${posted.receiptId}`);
    expect((asManager.body['lines'] as Body[])[0]?.['lineCostNow']).toBeNull();
  });
});
