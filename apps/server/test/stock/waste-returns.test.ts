/**
 * Waste and supplier returns (Phase 4 step 4.4). AT-109: ingredient waste with lot and
 * reason → a waste movement and a waste record valued at the average. AT-110: a supplier
 * return → stock out at the current average against the receipt line (and its lot), the
 * refund recorded for Phase 5's ledger (P4-2), never more than the line brought in.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findStockMismatches, postOpeningBalance } from '../../src/modules/stock/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let manager: Client;
let cashier: Client;
let today = '';

type Body = Record<string, unknown>;
const d = (v: string) => new Decimal(v);
async function call(
  client: Client,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload?: object,
  key: string = randomUUID(),
) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': key } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}
const day = (n: number) => {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

let skuCounter = 0;
async function item(fields: Body = {}, opening = { qty: '0', cost: '0.3' }): Promise<string> {
  skuCounter += 1;
  const res = await call(clerk, 'POST', '/inventory/items', {
    sku: `wr-${String(skuCounter)}`,
    name: `Waste item ${String(skuCounter)}`,
    baseUom: 'ml',
    ...fields,
  });
  const id = res.body['id'] as string;
  await withTransaction(fx.pool, (t) =>
    postOpeningBalance(
      t,
      { actorUserId: fx.ownerId, businessDate: today },
      { actor: { kind: 'user', userId: fx.ownerId }, correlationId: randomUUID() },
      { itemId: id, qty: d(opening.qty), unitCost: d(opening.cost) },
    ),
  );
  return id;
}

async function receive(lines: Body[]) {
  const res = await call(clerk, 'POST', '/purchase-receipts', { paidNow: false, lines });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { receiptId: string; lines: { lineId: string }[] };
}

async function balance(itemId: string) {
  const { rows } = await fx.pool.query<{ on_hand: string; inventory_value: string }>(
    'SELECT on_hand::text, inventory_value::text FROM cl.inventory_balances WHERE item_id = $1',
    [itemId],
  );
  return rows[0];
}

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('wr-clerk', ['inventory_clerk']);
  await fx.addUser('wr-mgr', ['manager']);
  await fx.addUser('wr-cash', ['cashier']);
  clerk = await fx.loggedIn('wr-clerk');
  manager = await fx.loggedIn('wr-mgr');
  cashier = await fx.loggedIn('wr-cash');
  today = await businessDateOf(fx.pool, new Date());
});
afterAll(async () => {
  await fx.close();
});

describe('ingredient waste (AT-109)', () => {
  it('posts a waste movement and record at the average, with lot and reason', async () => {
    const milk = await item({ trackLots: true, trackExpiry: true }, { qty: '0', cost: '0.3' });
    await receive([
      { itemId: milk, qty: '1000', lineCost: '250', expiryDate: day(2), lotCode: 'A' },
    ]);
    await receive([
      { itemId: milk, qty: '2000', lineCost: '700', expiryDate: day(9), lotCode: 'B' },
    ]);
    // Q 3000, V 950: A = 0.31666667. Spill 0.3 l from lot B.
    const lotB = (
      (await call(clerk, 'GET', `/inventory/items/${milk}`)).body['lots'] as Body[]
    ).find((l) => l['lotCode'] === 'B');
    const res = await call(owner, 'POST', '/inventory/waste', {
      itemId: milk,
      qty: '0.3',
      uom: 'l',
      reasonCode: 'spilled',
      lotId: lotB?.['id'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ itemId: milk, qtyBase: '300.0000', value: '95.0000' });
    expect(await balance(milk)).toEqual({ on_hand: '2700.0000', inventory_value: '855.0000' });
    const { rows } = await fx.pool.query<Body>(
      `SELECT w.kind, w.qty::text, w.reason_code, w.cost_value::text, l.lot_code,
              m.movement_type, m.value_delta::text, s.qty_delta::text AS lot_qty
         FROM cl.wastage_records w
         JOIN cl.stock_movements m ON m.id = w.movement_id
         JOIN cl.inventory_lots l ON l.id = w.lot_id
         JOIN cl.stock_movement_lots s ON s.movement_id = m.id
        WHERE w.item_id = $1`,
      [milk],
    );
    expect(rows).toEqual([
      {
        kind: 'ingredient',
        qty: '300.0000',
        reason_code: 'spilled',
        cost_value: '95.0000',
        lot_code: 'B',
        movement_type: 'waste',
        value_delta: '-95.0000',
        lot_qty: '-300.0000',
      },
    ]);
    // Without a lot: earliest expiry first.
    await call(clerk, 'POST', '/inventory/waste', {
      itemId: milk,
      qty: '100',
      reasonCode: 'damaged',
    });
    const lots = (await call(clerk, 'GET', `/inventory/items/${milk}`)).body['lots'] as Body[];
    expect(lots.map((l) => [l['lotCode'], l['qtyRemaining']])).toEqual([
      ['A', '900.0000'],
      ['B', '1700.0000'],
    ]);
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('shows the value only to those who may see costs, and lists the day', async () => {
    const id = await item({}, { qty: '1000', cost: '0.5' });
    const res = await call(clerk, 'POST', '/inventory/waste', {
      itemId: id,
      qty: '10',
      reasonCode: 'other',
      note: 'Fly in the jug',
    });
    expect(res.body).toEqual({ itemId: id, qtyBase: '10.0000', value: null });
    const asClerk = (await call(clerk, 'GET', '/inventory/waste')).body;
    expect(asClerk['date']).toBe(today);
    expect((asClerk['items'] as Body[]).find((w) => w['itemId'] === id)).toMatchObject({
      kind: 'ingredient',
      qty: '10.0000',
      reasonCode: 'other',
      note: 'Fly in the jug',
      value: null,
      recordedBy: 'wr-clerk',
    });
    const asOwner = (await call(owner, 'GET', `/inventory/waste?date=${today}`)).body;
    expect((asOwner['items'] as Body[]).find((w) => w['itemId'] === id)?.['value']).toBe('5.0000');
  });

  it('refuses what is not allowed and acts once per key', async () => {
    const id = await item({}, { qty: '500', cost: '1' });
    const bad = async (body: Body) =>
      (await call(clerk, 'POST', '/inventory/waste', { itemId: id, ...body })).body;
    expect((await bad({ qty: '1', uom: 'kg', reasonCode: 'spilled' }))['detail']).toMatch(
      /kept in ml \(volume\); kg \(mass\) cannot be converted/,
    );
    expect((await bad({ qty: '600', reasonCode: 'spilled' }))['detail']).toBe(
      'That is more than the book quantity. Record a stock count instead.',
    );
    expect((await bad({ qty: '1', reasonCode: 'other' }))['detail']).toBe(
      'Say what happened when the reason is "other"',
    );
    expect((await bad({ qty: '1', reasonCode: 'stolen' }))['code']).toBe('VALIDATION_FAILED');
    expect((await bad({ qty: '1', reasonCode: 'spilled', lotId: '1' }))['detail']).toBe(
      'This item has no lots',
    );
    expect(
      (
        await call(cashier, 'POST', '/inventory/waste', {
          itemId: id,
          qty: '1',
          reasonCode: 'spilled',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(manager, 'POST', '/inventory/waste', {
          itemId: id,
          qty: '1',
          reasonCode: 'spilled',
        })
      ).status,
    ).toBe(201);
    const key = randomUUID();
    const body = { itemId: id, qty: '5', reasonCode: 'quality' };
    await call(clerk, 'POST', '/inventory/waste', body, key);
    await call(clerk, 'POST', '/inventory/waste', body, key);
    expect((await balance(id))?.on_hand).toBe('494.0000');
  });
});

describe('supplier returns (AT-110)', () => {
  it('takes the stock out at the current average and records the refund', async () => {
    const milk = await item({}, { qty: '2400', cost: '0.27' });
    const posted = await receive([{ itemId: milk, qty: '6', uom: 'l', lineCost: '1650' }]);
    // Q 8400, V 2298: return 2 l → round4(2000 × 2298 / 8400) = 547.1429.
    const lineId = posted.lines[0]?.lineId ?? '';
    const res = await call(clerk, 'POST', `/purchase-receipts/${posted.receiptId}/returns`, {
      lineId,
      qty: '2',
      uom: 'l',
      reason: 'Two cartons leaking',
      refundAmount: '550',
      refundChannel: 'cash',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      qtyBase: '2000.0000',
      value: '547.1429',
      returnedSoFar: '2000.0000',
    });
    expect(await balance(milk)).toEqual({ on_hand: '6400.0000', inventory_value: '1750.8571' });
    const { rows } = await fx.pool.query<Body>(
      `SELECT m.movement_type, m.qty_delta::text, m.value_delta::text, m.source_type, m.note
         FROM cl.stock_movements m WHERE m.item_id = $1 ORDER BY m.id DESC LIMIT 1`,
      [milk],
    );
    expect(rows[0]).toEqual({
      movement_type: 'supplier_return',
      qty_delta: '-2000.0000',
      value_delta: '-547.1429',
      source_type: 'purchase_receipt_line',
      note: 'Two cartons leaking',
    });
    const read = (await call(clerk, 'GET', `/purchase-receipts/${posted.receiptId}`)).body;
    expect((read['lines'] as Body[])[0]?.['returnedQty']).toBe('2000.0000');
    expect(read['returns']).toEqual([
      expect.objectContaining({
        lineId,
        qtyBase: '2000.0000',
        value: '547.1429',
        refundAmount: '550.00',
        refundChannel: 'cash',
        returnedBy: 'wr-clerk',
      }),
    ]);
    // Never more than the line brought in; and the receipt can no longer be reversed.
    const more = await call(clerk, 'POST', `/purchase-receipts/${posted.receiptId}/returns`, {
      lineId,
      qty: '4001',
      reason: 'Too much',
    });
    expect(more.body['detail']).toBe(
      `This line has 4000 ml of Waste item ${String(skuCounter)} left to return`,
    );
    const reverse = await call(clerk, 'POST', `/purchase-receipts/${posted.receiptId}/reverse`, {
      reason: 'Wrong',
    });
    expect(reverse.body['detail']).toBe(
      'Part of this receipt went back to the supplier. Return or waste the rest instead.',
    );
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('returns a lot-tracked item from the line’s own lot', async () => {
    const cream = await item({ trackLots: true, trackExpiry: true });
    const first = await receive([
      { itemId: cream, qty: '500', lineCost: '300', expiryDate: day(3), lotCode: 'C1' },
    ]);
    await receive([
      { itemId: cream, qty: '500', lineCost: '300', expiryDate: day(2), lotCode: 'C2' },
    ]);
    const lineId = first.lines[0]?.lineId ?? '';
    const res = await call(clerk, 'POST', `/purchase-receipts/${first.receiptId}/returns`, {
      lineId,
      qty: '200',
      reason: 'Wrong fat content',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const lots = (await call(clerk, 'GET', `/inventory/items/${cream}`)).body['lots'] as Body[];
    expect(lots.map((l) => [l['lotCode'], l['qtyRemaining']])).toEqual([
      ['C2', '500.0000'],
      ['C1', '300.0000'],
    ]);
    const over = await call(clerk, 'POST', `/purchase-receipts/${first.receiptId}/returns`, {
      lineId,
      qty: '300.0001',
      reason: 'All of it',
    });
    expect(over.status).toBe(400);
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('refuses card numbers, half a refund, reversed receipts and readers without the right', async () => {
    const id = await item();
    const posted = await receive([{ itemId: id, qty: '100', lineCost: '30' }]);
    const lineId = posted.lines[0]?.lineId ?? '';
    const path = `/purchase-receipts/${posted.receiptId}/returns`;
    const base = { lineId, qty: '10', reason: 'Damaged box' };
    expect((await call(clerk, 'POST', path, { ...base, refundAmount: '3' })).status).toBe(400);
    expect(
      (
        await call(clerk, 'POST', path, {
          ...base,
          refundAmount: '3',
          refundChannel: 'card',
          refundReference: '4111111111111111',
        })
      ).body['code'],
    ).toBe('CARD_NUMBER_NOT_ALLOWED');
    expect((await call(manager, 'POST', path, base)).status).toBe(403);
    const asManager = (await call(manager, 'GET', `/purchase-receipts/${posted.receiptId}`)).body;
    expect(asManager['returns']).toEqual([]);
    await call(clerk, 'POST', `/purchase-receipts/${posted.receiptId}/reverse`, {
      reason: 'Wrong shop',
    });
    expect((await call(clerk, 'POST', path, base)).status).toBe(409);
  });
});
