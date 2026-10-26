/**
 * Suppliers and purchase receipts (Phase 4 step 4.2; RECIPE_INVENTORY.md §7,
 * COST_VALUATION.md §3): AT-31 through the API (6 × 1 L carton → 6,000 ml exactly, unit
 * cost to 8 dp, average updated), gapless GRN numbers, the D-29 start of stock control,
 * lot and expiry rules, payment recorded for Phase 5 (P4-2), reversal while the stock is
 * still available (exact when nothing moved since, else at the average), frozen receipts,
 * costs hidden from readers without cost rights, and a receipt racing an acceptance of
 * the same item.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postReceipt } from '../../src/modules/purchasing/index.ts';
import {
  findStockMismatches,
  postOpeningBalance,
  reserve,
  wasteIngredient,
} from '../../src/modules/stock/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { race, raceRuns, repeatRace, tally } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { testOrderLines } from '../support/orders.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let manager: Client;
let clerkId = '';

type Body = Record<string, unknown>;
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

const audit = () => ({
  actor: { kind: 'user' as const, userId: fx.ownerId },
  correlationId: randomUUID(),
});
const stockCtx = () => ({ actorUserId: fx.ownerId, businessDate: '2026-10-26' });

let skuCounter = 0;
/** An item with a "1 L carton" (or "Sleeve of 50") pack, optionally counted with an opening. */
async function newItem(
  options: {
    baseUom?: 'ml' | 'pcs';
    opening?: { qty: string; cost: string };
    fields?: Body;
  } = {},
): Promise<{ id: string; packId: string; name: string }> {
  skuCounter += 1;
  const name = `Receipt item ${String(skuCounter)}`;
  const baseUom = options.baseUom ?? 'ml';
  const created = await call(clerk, 'POST', '/inventory/items', {
    sku: `rc-${String(skuCounter)}`,
    name,
    baseUom,
    ...options.fields,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body['id'] as string;
  const pack = await call(
    clerk,
    'POST',
    `/inventory/items/${id}/pack-sizes`,
    baseUom === 'ml'
      ? { name: '1 L carton', qty: '1', uom: 'l' }
      : { name: 'Sleeve of 50', qty: '50', uom: 'pcs' },
  );
  if (options.opening) {
    const { qty, cost } = options.opening;
    await withTransaction(fx.pool, (t) =>
      postOpeningBalance(t, stockCtx(), audit(), {
        itemId: id,
        qty: new Decimal(qty),
        unitCost: new Decimal(cost),
      }),
    );
  }
  return { id, packId: pack.body['id'] as string, name };
}

async function balance(itemId: string) {
  const { rows } = await fx.pool.query<{
    on_hand: string;
    reserved: string;
    inventory_value: string;
    last_unit_cost: string | null;
  }>(
    `SELECT on_hand::text, reserved::text, inventory_value::text, last_unit_cost::text
       FROM cl.inventory_balances WHERE item_id = $1`,
    [itemId],
  );
  return rows[0];
}

const receive = (lines: Body[], extra: Body = {}, client: Client = clerk, key?: string) =>
  call(client, 'POST', '/purchase-receipts', { paidNow: false, lines, ...extra }, key);

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  clerkId = await fx.addUser('rc-clerk', ['inventory_clerk']);
  await fx.addUser('rc-mgr', ['manager']);
  clerk = await fx.loggedIn('rc-clerk');
  manager = await fx.loggedIn('rc-mgr');
});
afterAll(async () => {
  await fx.close();
});

describe('posting a receipt (AT-31)', () => {
  it('turns 6 × 1 L carton into 6,000 ml at an 8 dp unit cost and updates the average', async () => {
    const milk = await newItem({ opening: { qty: '2400', cost: '0.27' } });
    const res = await receive(
      [{ itemId: milk.id, packSizeId: milk.packId, packQty: '6', lineCost: '1000' }],
      { supplierInvoiceRef: 'INV-778' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      receiptNo: expect.stringMatching(/^GRN-\d{4}-\d{5}$/) as string,
      totalCost: '1000.00',
      lines: [
        {
          itemId: milk.id,
          packName: '1 L carton',
          packQty: '6.000',
          qtyBase: '6000.0000',
          lineCost: '1000.00',
          unitCost: '0.16666667',
          onHandAfter: '8400.0000',
        },
      ],
    });
    // Q 2400 + 6000; V 648 + 1000; L = the receipt's unit cost.
    expect(await balance(milk.id)).toEqual({
      on_hand: '8400.0000',
      reserved: '0.0000',
      inventory_value: '1648.0000',
      last_unit_cost: '0.16666667',
    });
    const { rows } = await fx.pool.query<Body>(
      `SELECT movement_type, qty_delta::text, unit_cost::text, value_delta::text, source_type
         FROM cl.stock_movements WHERE item_id = $1 ORDER BY stock_movements.id`,
      [milk.id],
    );
    expect(rows[1]).toEqual({
      movement_type: 'receipt',
      qty_delta: '6000.0000',
      unit_cost: '0.16666667',
      value_delta: '1000.0000',
      source_type: 'purchase_receipt_line',
    });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('numbers receipts without gaps, and acts once for a repeated key', async () => {
    const cups = await newItem({ baseUom: 'pcs', opening: { qty: '0', cost: '35' } });
    const key = randomUUID();
    const line = { itemId: cups.id, packSizeId: cups.packId, packQty: '2', lineCost: '3500' };
    const first = await receive([line], {}, clerk, key);
    const again = await receive([line], {}, clerk, key);
    expect(again.body['receiptNo']).toBe(first.body['receiptNo']);
    const next = await receive([{ itemId: cups.id, qty: '10', lineCost: '350' }]);
    const n = (r: { body: Body }) => Number((r.body['receiptNo'] as string).slice(-5));
    expect(n(next)).toBe(n(first) + 1);
    expect((await balance(cups.id))?.on_hand).toBe('110.0000');
  });

  it('accepts a loose quantity in a unit of the same dimension, and refuses another', async () => {
    const milk = await newItem({ opening: { qty: '0', cost: '0.3' } });
    const ok = await receive([{ itemId: milk.id, qty: '2.5', uom: 'l', lineCost: '700' }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((ok.body['lines'] as Body[])[0]?.['qtyBase']).toBe('2500.0000');
    const kg = await receive([{ itemId: milk.id, qty: '1', uom: 'kg', lineCost: '1' }]);
    expect(kg.status).toBe(400);
    expect(kg.body['detail']).toMatch(/kept in ml \(volume\); kg \(mass\) cannot be converted/);
    const both = await receive([
      { itemId: milk.id, packSizeId: milk.packId, packQty: '1', qty: '1', lineCost: '1' },
    ]);
    expect(both.status).toBe(400);
    const other = await newItem();
    const wrongPack = await receive([
      { itemId: milk.id, packSizeId: other.packId, packQty: '1', lineCost: '1' },
    ]);
    expect(wrongPack.body['detail']).toBe(`That pack is not one of ${milk.name}'s`);
  });

  it('starts stock control from a receipt only when asked, and only with the right (D-29)', async () => {
    const fresh = await newItem({ baseUom: 'pcs' });
    const line = { itemId: fresh.id, packSizeId: fresh.packId, packQty: '4', lineCost: '7000' };
    const refused = await receive([line]);
    expect(refused.status).toBe(400);
    expect(refused.body['detail']).toMatch(/is not counted yet: confirm its shelf was empty/);
    expect((await balance(fresh.id))?.on_hand).toBe('0.0000');
    // The manager may not receive by default; the owner may, but not start stock control
    // for an item missing from the receipt.
    expect((await receive([line], { startStockControl: [fresh.id] }, manager)).status).toBe(403);
    const ok = await receive([line], { startStockControl: [fresh.id] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const { rows } = await fx.pool.query<{ stock_control_active: boolean }>(
      'SELECT stock_control_active FROM cl.inventory_items WHERE id = $1',
      [fresh.id],
    );
    expect(rows[0]?.stock_control_active).toBe(true);
    expect(await balance(fresh.id)).toMatchObject({
      on_hand: '200.0000',
      inventory_value: '7000.0000',
    });
    const stray = await receive([line], { startStockControl: [(await newItem()).id] }, owner);
    expect(stray.status).toBe(400);
  });

  it('needs an expiry date for expiry-tracked items, refuses expired stock and stray lots', async () => {
    const cream = await newItem({
      opening: { qty: '0', cost: '1' },
      fields: { trackLots: true, trackExpiry: true, nearExpiryDays: 2 },
    });
    const base = { itemId: cream.id, packSizeId: cream.packId, packQty: '1', lineCost: '600' };
    const noExpiry = await receive([base]);
    expect(noExpiry.body['detail']).toBe(`Enter the expiry date of ${cream.name}`);
    const expired = await receive([{ ...base, expiryDate: '2020-01-01' }]);
    expect(expired.body['detail']).toBe(
      `${cream.name} expired on 2020-01-01: do not receive expired stock`,
    );
    const ok = await receive([{ ...base, lotCode: 'L-0042', expiryDate: '2099-12-31' }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const plain = await newItem({ opening: { qty: '0', cost: '1' } });
    const stray = await receive([
      { itemId: plain.id, qty: '1', lineCost: '1', lotCode: 'X', expiryDate: '2099-01-01' },
    ]);
    expect(stray.body['detail']).toBe(`${plain.name} does not track lots`);
  });

  it('records how it was paid for the ledger of Phase 5, never a card number (P4-2)', async () => {
    const item = await newItem({ opening: { qty: '0', cost: '1' } });
    const line = { itemId: item.id, qty: '1000', lineCost: '300' };
    expect((await receive([line], { paidNow: true })).status).toBe(400);
    expect((await receive([line], { paidNow: false, paymentChannel: 'cash' })).status).toBe(400);
    const card = await receive([line], {
      paidNow: true,
      paymentChannel: 'card',
      paymentReference: '4111 1111 1111 1111',
    });
    expect(card.body['code']).toBe('CARD_NUMBER_NOT_ALLOWED');
    const paid = await receive([line], {
      paidNow: true,
      paymentChannel: 'transfer',
      paymentReference: 'JazzCash 99812',
    });
    expect(paid.status).toBe(201);
    const read = await call(clerk, 'GET', `/purchase-receipts/${paid.body['receiptId'] as string}`);
    expect(read.body).toMatchObject({
      status: 'posted',
      paidNow: true,
      paymentChannel: 'transfer',
      paymentReference: 'JazzCash 99812',
      totalCost: '300.00',
      postedBy: 'rc-clerk',
    });
  });

  it('re-evaluates alerts and refreshes availability', async () => {
    const milk = await newItem({
      opening: { qty: '2400', cost: '0.27' },
      fields: { lowThreshold: '5000' },
    });
    const open = () =>
      fx.pool.query(
        `SELECT 1 FROM cl.inventory_alerts WHERE item_id = $1 AND kind = 'low' AND state <> 'resolved'`,
        [milk.id],
      );
    // The opening was posted before the threshold applied to it: refresh by a tiny receipt.
    await receive([{ itemId: milk.id, qty: '1', lineCost: '0.27' }]);
    expect((await open()).rowCount).toBe(1);
    await receive([{ itemId: milk.id, packSizeId: milk.packId, packQty: '6', lineCost: '1650' }]);
    expect((await open()).rowCount).toBe(0);
    const { rows } = await fx.pool.query(
      `SELECT 1 FROM cl.outbox_events WHERE event_type = 'availability.changed' AND entity_id = $1`,
      [milk.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('a posted receipt', () => {
  it('never changes, its lines never change, and readers without cost rights see no costs', async () => {
    const item = await newItem({ opening: { qty: '0', cost: '1' } });
    const posted = await receive([{ itemId: item.id, qty: '500', lineCost: '150' }]);
    const id = posted.body['receiptId'] as string;
    await expect(
      fx.pool.query('UPDATE cl.purchase_receipts SET total_cost = 1 WHERE id = $1', [id]),
    ).rejects.toThrow(/never changes/);
    await expect(
      fx.pool.query('UPDATE cl.purchase_receipt_lines SET line_cost = 1 WHERE receipt_id = $1', [
        id,
      ]),
    ).rejects.toThrow(/permission denied|only while the receipt is a draft/);
    await expect(
      fx.pool.query('DELETE FROM cl.purchase_receipts WHERE id = $1', [id]),
    ).rejects.toThrow();
    const asManager = await call(manager, 'GET', `/purchase-receipts/${id}`);
    expect(asManager.body['totalCost']).toBeNull();
    expect((asManager.body['lines'] as Body[])[0]).toMatchObject({
      qtyBase: '500.0000',
      lineCost: null,
      unitCost: null,
    });
    const list = await call(manager, 'GET', '/purchase-receipts');
    expect((list.body['items'] as Body[]).every((r) => r['totalCost'] === null)).toBe(true);
    expect(
      ((await call(clerk, 'GET', '/purchase-receipts')).body['items'] as Body[])[0],
    ).toMatchObject({ id, totalCost: '150.00' });
  });
});

describe('reversing a receipt (RECIPE_INVENTORY.md §7)', () => {
  it('restores the exact quantity, value and last cost when nothing moved since', async () => {
    const milk = await newItem({ opening: { qty: '2400', cost: '0.27' } });
    const before = await balance(milk.id);
    // A typo: 60 cartons instead of 6.
    const wrong = await receive([
      { itemId: milk.id, packSizeId: milk.packId, packQty: '60', lineCost: '1650' },
    ]);
    const id = wrong.body['receiptId'] as string;
    const reversed = await call(clerk, 'POST', `/purchase-receipts/${id}/reverse`, {
      reason: 'Typed 60 instead of 6',
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(await balance(milk.id)).toEqual(before);
    const again = await call(clerk, 'POST', `/purchase-receipts/${id}/reverse`, {
      reason: 'Again',
    });
    expect(again.status).toBe(409);
    const { rows } = await fx.pool.query<Body>(
      `SELECT movement_type, qty_delta::text, value_delta::text, flags
         FROM cl.stock_movements WHERE item_id = $1 ORDER BY stock_movements.id DESC LIMIT 1`,
      [milk.id],
    );
    expect(rows[0]).toEqual({
      movement_type: 'reversal',
      qty_delta: '-60000.0000',
      value_delta: '-1650.0000',
      flags: [],
    });
    const read = await call(clerk, 'GET', `/purchase-receipts/${id}`);
    expect(read.body).toMatchObject({
      status: 'reversed',
      reversalReason: 'Typed 60 instead of 6',
    });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('takes the stock out at the average once something else moved the item', async () => {
    const milk = await newItem({ opening: { qty: '1000', cost: '0.2' } });
    const posted = await receive([
      { itemId: milk.id, packSizeId: milk.packId, packQty: '1', lineCost: '400' },
    ]);
    // Q 2000, V 600; spill 500 at 0.3 → Q 1500, V 450.
    await withTransaction(fx.pool, (t) =>
      wasteIngredient(t, stockCtx(), audit(), {
        itemId: milk.id,
        qty: new Decimal('500'),
        reasonCode: 'spilled',
        key: randomUUID(),
      }),
    );
    const res = await call(
      clerk,
      'POST',
      `/purchase-receipts/${posted.body['receiptId'] as string}/reverse`,
      { reason: 'Wrong delivery' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // 1000 out at 0.3 = 300: Q 500, V 150.
    expect(await balance(milk.id)).toMatchObject({
      on_hand: '500.0000',
      inventory_value: '150.0000',
    });
    const { rows } = await fx.pool.query<{ flags: string[] }>(
      `SELECT flags FROM cl.stock_movements WHERE item_id = $1 AND movement_type = 'reversal'`,
      [milk.id],
    );
    expect(rows[0]?.flags).toEqual(['at_average']);
  });

  it('is refused once the stock is used or reserved for accepted orders', async () => {
    const milk = await newItem({ opening: { qty: '0', cost: '0.3' } });
    const posted = await receive([
      { itemId: milk.id, packSizeId: milk.packId, packQty: '2', lineCost: '600' },
    ]);
    const [line = ''] = await testOrderLines(fx.pool, clerkId);
    await withTransaction(fx.pool, (t) =>
      reserve(t, { orderLineId: line, requirement: new Map([[milk.id, new Decimal('300')]]) }),
    );
    const res = await call(
      clerk,
      'POST',
      `/purchase-receipts/${posted.body['receiptId'] as string}/reverse`,
      { reason: 'Wrong delivery' },
    );
    expect(res.status).toBe(400);
    expect(res.body['detail']).toBe(
      `Only 1700 ml of ${milk.name} is still available, and this receipt brought in 2000. ` +
        'Record a waste or a supplier return instead.',
    );
    expect((await balance(milk.id))?.on_hand).toBe('2000.0000');
  });
});

describe('suppliers', () => {
  it('are added, edited with versions, made inactive, and named on receipts', async () => {
    const created = await call(clerk, 'POST', '/suppliers', {
      name: 'Haleeb Foods',
      phone: '042 111 222 333',
    });
    expect(created.status).toBe(201);
    const supplierId = created.body['id'] as string;
    expect((await call(clerk, 'POST', '/suppliers', { name: ' haleeb foods ' })).status).toBe(400);
    const item = await newItem({ opening: { qty: '0', cost: '1' } });
    const posted = await receive([{ itemId: item.id, qty: '1', lineCost: '1' }], { supplierId });
    const list = await call(clerk, 'GET', `/purchase-receipts?supplierId=${supplierId}`);
    expect((list.body['items'] as Body[]).map((r) => [r['id'], r['supplierName']])).toEqual([
      [posted.body['receiptId'], 'Haleeb Foods'],
    ]);
    const edit = await call(clerk, 'PATCH', `/suppliers/${supplierId}`, {
      expectedVersion: 1,
      email: 'orders@haleeb.example',
      isActive: false,
    });
    expect(edit.status).toBe(200);
    expect(
      (await call(clerk, 'PATCH', `/suppliers/${supplierId}`, { expectedVersion: 1, name: 'X' }))
        .status,
    ).toBe(409);
    const names = ((await call(clerk, 'GET', '/suppliers')).body['items'] as Body[]).map(
      (s) => s['name'],
    );
    expect(names).not.toContain('Haleeb Foods');
    const inactive = await receive([{ itemId: item.id, qty: '1', lineCost: '1' }], { supplierId });
    expect(inactive.body['detail']).toBe('That supplier is not active');
    expect((await call(manager, 'POST', '/suppliers', { name: 'Nope' })).status).toBe(403);
  });
});

describe('a receipt racing an acceptance of the same item', () => {
  it('lets both commit with nothing lost: stock, value and reservations add up', async () => {
    await repeatRace(raceRuns(), async () => {
      const milk = await newItem({ opening: { qty: '1000', cost: '0.3' } });
      const [line = ''] = await testOrderLines(fx.pool, clerkId);
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: async ({ index, pool, barrier }) =>
          withTransaction(pool, async (t) => {
            await barrier.wait();
            if (index === 0) {
              await postReceipt(
                t,
                { key: randomUUID(), correlationId: randomUUID(), now: new Date() },
                {
                  user: { id: clerkId } as never,
                  device: { id: '1' } as never,
                  permissions: new Set(['inventory.receive']) as never,
                },
                {
                  paidNow: false,
                  lines: [
                    { itemId: milk.id, packSizeId: milk.packId, packQty: '3', lineCost: '900' },
                  ],
                },
              );
            } else {
              await reserve(t, {
                orderLineId: line,
                requirement: new Map([[milk.id, new Decimal('800')]]),
              });
            }
            return index;
          }),
      });
      expect(tally(outcomes).failed).toEqual([]);
      expect(await balance(milk.id)).toMatchObject({
        on_hand: '4000.0000',
        reserved: '800.0000',
        inventory_value: '1200.0000',
      });
    });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });
});
