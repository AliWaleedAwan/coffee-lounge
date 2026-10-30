/**
 * Stock, purchase and people reports (Phase 6 step 6.4; AT-20, AC-RPT-1). A day through the
 * API: 3 coffees sold (18 g beans each at Rs 0.50), milk received paid and on credit with a
 * carton returned, 200 g beans spilled, beans counted 10 g short. Then each report adds up,
 * agrees with the sales reports (used value = COGS, waste and count variance) and with the
 * stock balances, and shows values only to those who may see costs.
 */
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { expectReconciled } from '../support/reconcile.ts';
import { TradingShop } from '../support/trading.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let manager: Client;
let waiter: Client;
let shop: TradingShop;
let today = '';
let beans = '';

type Body = Record<string, unknown>;
type Report = { rows: Body[]; totals: Body; columns: { key: string }[]; key: string };
async function report(client: Client, key: string, query = '') {
  const res = await client.call({
    method: 'GET',
    url: `/api/staff/v1/reports/${key}?from=${today}&to=${today}${query}`,
  });
  return { status: res.statusCode, body: res.json<Report>() };
}
async function ok(key: string, query = '', client: Client = owner): Promise<Report> {
  const res = await report(client, key, query);
  expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(200);
  expectReconciled(res.body as never);
  return res.body;
}
const n = (v: unknown) => new Decimal(typeof v === 'string' || typeof v === 'number' ? v : 0);
async function call(client: Client, method: 'GET' | 'POST', path: string, payload?: object) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': crypto.randomUUID() } } : {}),
  });
  expect(res.statusCode, `${method} ${path}: ${res.body}`).toBeLessThan(300);
  return res.json<Body>();
}

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('sr-cash', ['cashier']);
  await fx.addUser('sr-partner', ['owner'], { pin: '1357' });
  await fx.addUser('sr-clerk', ['inventory_clerk']);
  await fx.addUser('sr-mgr', ['manager']);
  await fx.addUser('sr-waiter', ['waiter']);
  clerk = await fx.loggedIn('sr-clerk');
  manager = await fx.loggedIn('sr-mgr');
  waiter = await fx.loggedIn('sr-waiter');
  const cashier = await fx.loggedIn('sr-cash');
  today = await businessDateOf(fx.pool, new Date());
  shop = new TradingShop(fx, owner, cashier, { username: 'sr-partner', pin: '1357' }, 'SR');
  await shop.setUp({ recipe: true });
  const { rows } = await fx.pool.query<{ id: string }>(
    `SELECT id::text FROM cl.inventory_items WHERE sku = 'SR-BEANS'`,
  );
  beans = rows[0]?.id ?? '';
  await shop.sale(3, 'card_manual');
  const paid = await shop.receive(6, 1650, 'card');
  await shop.receive(2, 600, null);
  expect(await shop.supplierRefund(paid, 275, 'card')).toBe(true);
  await call(owner, 'POST', '/inventory/waste', {
    itemId: beans,
    qty: '200',
    reasonCode: 'spilled',
  });
  const count = await call(owner, 'POST', '/stock-counts', { scope: 'items', itemIds: [beans] });
  const countId = String(count['id']);
  const { rows: book } = await fx.pool.query<{ on_hand: string }>(
    'SELECT on_hand::text FROM cl.inventory_balances WHERE item_id = $1',
    [beans],
  );
  await call(owner, 'POST', `/stock-counts/${countId}/lines`, {
    itemId: beans,
    countedQty: n(book[0]?.on_hand).minus(10).toString(),
  });
  const submitted = await call(owner, 'POST', `/stock-counts/${countId}/submit`, {});
  expect(submitted['status']).toBe('posted');
});
afterAll(async () => {
  await fx.close();
});

describe('stock reports add up and agree with the sales figures (AC-RPT-1)', () => {
  it('inventory usage: used value = COGS, waste and count variance = the day’s', async () => {
    const usage = await ok('inventory-usage');
    const day = (await ok('sales-by-day')).totals;
    const beansRow = usage.rows.find((r) => r['item'] === 'SR beans');
    expect(beansRow).toMatchObject({ unit: 'g', used: '54', wasted: '200', counted: '-10' });
    expect(n(beansRow?.['used_value']).toString()).toBe('27');
    expect(n(beansRow?.['waste_value']).toString()).toBe('100');
    expect(n(beansRow?.['variance_value']).toString()).toBe('5');
    const milk = usage.rows.find((r) => r['item'] === 'SR milk');
    expect(milk).toMatchObject({ unit: 'ml', received: '8000', returned: '1000' });
    expect(n(usage.totals['used_value']).toString()).toBe(n(day['cogs']).toString());
    expect(n(usage.totals['waste_value']).toString()).toBe(n(day['waste']).toString());
    expect(n(usage.totals['variance_value']).toString()).toBe(n(day['variance']).toString());
    // Quantities of different units are never added up.
    expect(usage.totals['used']).toBeNull();
  });

  it('waste, counts and stock on hand agree with usage and with the balances', async () => {
    const waste = await ok('waste');
    expect(waste.rows).toEqual([
      expect.objectContaining({
        item: 'SR beans',
        kind: 'ingredient',
        reason: 'spilled',
        qty: '200',
        unit: 'g',
      }),
    ]);
    expect(n(waste.totals['value']).toString()).toBe('100');
    const counts = await ok('stock-counts');
    expect(counts.rows).toEqual([
      expect.objectContaining({ lines: 1, differed: 1, counted_by: 'Owner' }),
    ]);
    expect(n(counts.totals['variance_value']).toString()).toBe('5');
    const onHand = await ok('stock-on-hand');
    expect(onHand.rows.find((r) => r['item'] === 'SR beans')).toMatchObject({
      on_hand: '99736',
      reserved: '0',
      available: '99736',
    });
    const { rows } = await fx.pool.query<{ v: string }>(
      'SELECT sum(inventory_value)::text AS v FROM cl.inventory_balances',
    );
    expect(n(onHand.totals['value']).toString()).toBe(n(rows[0]?.v).toString());
  });

  it('purchases: posted receipts and what they cost', async () => {
    const purchases = await ok('purchases');
    expect(purchases.rows.map((r) => [r['paid'], r['cost']])).toEqual([
      ['Card', '1650.00'],
      ['On credit', '600.00'],
    ]);
    expect(purchases.totals).toMatchObject({ receipts: 2, cost: '2250.00' });
  });
});

describe('people reports', () => {
  it('staff activity: bills settled and payments taken by each person', async () => {
    const activity = await ok('staff-activity');
    expect(activity.rows.find((r) => r['person'] === 'sr-cash')).toMatchObject({
      bills: 1,
      bills_amount: '1350.00',
      payments: 1,
      taken: '1350.00',
    });
    expect(n(activity.totals['taken']).toString()).toBe(
      n((await ok('payment-mix')).totals['taken']).toString(),
    );
  });

  it('the audit log as a report: one row per event of the period', async () => {
    const audit = await ok('audit-log');
    expect(audit.rows.length).toBeGreaterThan(5);
    expect(audit.totals['events']).toBe(audit.rows.length);
    const actions = audit.rows.map((r) => r['action']);
    expect(actions).toEqual(
      expect.arrayContaining(['stock.waste', 'stock.count.post', 'invoice.settle']),
    );
    // Filtered to one person and to one kind of record.
    const counts = await ok('audit-log', `&staffId=${fx.ownerId}&entityType=stock_count`);
    expect(counts.rows.length).toBeGreaterThan(0);
    expect(counts.rows.every((r) => String(r['action']).startsWith('stock.count'))).toBe(true);
  });
});

describe('who sees what', () => {
  it('the clerk sees stock without values; the manager people; the waiter nothing', async () => {
    const usage = await ok('inventory-usage', '', clerk);
    const keys = usage.columns.map((c) => c.key);
    expect(keys).toContain('used');
    expect(keys).not.toContain('used_value');
    expect((await ok('purchases', '', clerk)).columns.map((c) => c.key)).not.toContain('cost');
    expect((await report(manager, 'staff-activity')).status).toBe(200);
    expect((await report(manager, 'audit-log')).status).toBe(403);
    expect((await report(clerk, 'staff-activity')).status).toBe(403);
    for (const key of [
      'inventory-usage',
      'waste',
      'stock-on-hand',
      'stock-counts',
      'purchases',
      'staff-activity',
    ]) {
      expect((await report(waiter, key)).status, key).toBe(403);
    }
    expect(
      (await report(owner, 'inventory-usage', `&inventoryItemId=${beans}`)).body.rows,
    ).toHaveLength(1);
  });
});
