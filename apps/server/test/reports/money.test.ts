/**
 * Money and sales reports (Phase 6 step 6.3; AT-20, AC-RPT-1): a day of trading through the
 * API (sales by every method, one with 10 % off, a refund, a method correction, a paid-out,
 * expenses, a delivery taken), then every report checked twice: its totals are the sums of
 * its rows, and its figures agree with the other reports that count the same money.
 */
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { expectReconciled } from '../support/reconcile.ts';
import { TradingShop } from '../support/trading.ts';

let fx: IdentityFixture;
let owner: Client;
let manager: Client;
let clerk: Client;
let shop: TradingShop;
let today = '';
let cashierId = '';

type Body = Record<string, unknown>;
type Report = { rows: Body[]; totals: Body; columns: { key: string }[]; key: string };
async function report(client: Client, key: string, query = '') {
  const res = await client.call({
    method: 'GET',
    url: `/api/staff/v1/reports/${key}?from=${today}&to=${today}${query}`,
  });
  return { status: res.statusCode, body: res.json<Report>() };
}
async function ok(key: string, query = ''): Promise<Report> {
  const res = await report(owner, key, query);
  expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(200);
  expectReconciled(res.body as never);
  return res.body;
}
const n = (v: unknown) => new Decimal(typeof v === 'string' || typeof v === 'number' ? v : 0);

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  cashierId = await fx.addUser('mr-cash', ['cashier']);
  await fx.addUser('mr-partner', ['owner'], { pin: '1357' });
  await fx.addUser('mr-mgr', ['manager']);
  await fx.addUser('mr-clerk', ['inventory_clerk']);
  manager = await fx.loggedIn('mr-mgr');
  clerk = await fx.loggedIn('mr-clerk');
  const cashier = await fx.loggedIn('mr-cash');
  today = await businessDateOf(fx.pool, new Date());
  shop = new TradingShop(fx, owner, cashier, { username: 'mr-partner', pin: '1357' }, 'MR');
  await shop.setUp({ recipe: true });
  await shop.openShift();
  const a = await shop.sale(2, 'cash');
  await shop.sale(1, 'card_manual', 'jazzcash', { discountPercent: 10 });
  const c = await shop.sale(3, 'transfer', 'jazzcash');
  await shop.sale(1, 'transfer', 'easypaisa');
  await shop.refund(c, 50);
  expect(await shop.correct(a, 'card_manual')).toBe(true);
  await shop.cashMovement('paid_out', 200);
  await shop.expense(1000, 'transfer', { provider: 'bank', category: 'Rent' });
  await shop.expense(200, 'card', { category: 'Supplies' });
  const delivery = await owner.call({
    method: 'POST',
    url: '/api/staff/v1/sessions/delivery',
    payload: { channel: 'phone', paymentMode: 'cod_cash' },
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
  expect(delivery.statusCode, delivery.body).toBe(201);
});
afterAll(async () => {
  await fx.close();
});

describe('every report adds up, and they agree with each other (AC-RPT-1)', () => {
  it('bills, items and categories add up to the day', async () => {
    const day = (await ok('sales-by-day')).totals;
    const bills = await ok('bills');
    const items = (await ok('sales-by-item')).totals;
    const categories = (await ok('sales-by-category')).totals;
    expect(bills.rows).toHaveLength(4);
    for (const k of ['gross', 'discounts']) {
      expect(n(bills.totals[k]).toString(), `bills ${k}`).toBe(n(day[k]).toString());
      expect(n(items[k]).toString(), `items ${k}`).toBe(n(day[k]).toString());
      expect(n(categories[k]).toString(), `categories ${k}`).toBe(n(day[k]).toString());
    }
    expect(n(day['gross']).toString()).toBe(String(7 * 450));
    expect(n(day['discounts']).toString()).toBe('45');
    // Bills paid in full: the bills' totals are what was taken.
    const mix = await ok('payment-mix');
    expect(n(bills.totals['total']).toString()).toBe(n(mix.totals['taken']).toString());
    // Each bill's lines add up to its row.
    const first = bills.rows[0] as Body & { id: string };
    const lines = await ok('bill-lines', `&invoiceId=${first.id}`);
    expect(n(lines.totals['net']).toString()).toBe(n(first['net']).toString());
    expect(n(lines.totals['cogs']).toString()).toBe(n(first['cogs']).toString());
  });

  it('payment mix: by the method as corrected, collected = the day’s collected', async () => {
    const mix = await ok('payment-mix');
    const by = Object.fromEntries(mix.rows.map((r) => [String(r['method']), r]));
    // 2 coffees taken as cash, corrected to card; a card sale at 10 % off; JazzCash 3 coffees, half refunded.
    expect(by['Cash']).toMatchObject({ payments: 0, taken: '0.00' });
    expect(by['Card']).toMatchObject({ payments: 2, taken: '1305.00' });
    expect(by['JazzCash']).toMatchObject({
      payments: 1,
      taken: '1350.00',
      refunds: 1,
      refunded: '675.00',
      collected: '675.00',
    });
    expect(by['Easypaisa']).toMatchObject({ taken: '450.00' });
    const day = (await ok('sales-by-day')).totals;
    expect(n(mix.totals['collected']).toString()).toBe(n(day['collected']).toString());
  });

  it('discounts, comps and refunds: the list adds up to the day’s discounts and refunds', async () => {
    const list = await ok('discounts');
    const day = (await ok('sales-by-day')).totals;
    const sum = (kind: string) =>
      list.rows
        .filter((r) => r['kind'] === kind)
        .reduce((s, r) => s.plus(n(r['amount'])), new Decimal(0));
    expect(sum('discount').toString()).toBe(n(day['discounts']).toString());
    expect(sum('refund').toString()).toBe(n(day['refunds']).toString());
    expect(list.rows.find((r) => r['kind'] === 'refund')).toMatchObject({
      reason: 'Quality',
      approved_by: 'mr-partner',
    });
    expect((await ok('discounts', '&kind=refund')).rows).toHaveLength(1);
  });

  it('the operating result: its lines add up to the day’s result (coverage 100 %)', async () => {
    const statement = await ok('operating-result');
    const day = (await ok('sales-by-day')).totals;
    expect(day['coverage']).toBe('100.00');
    expect(n(statement.totals['amount']).toString()).toBe(n(day['operating_result']).toString());
    expect(statement.rows.map((r) => r['line'])).toEqual([
      'Net sales',
      'Cost of goods sold',
      'Waste',
      'Stock variance',
      'Purchase price variance',
      'Rent',
      'Supplies',
    ]);
    // 7 coffees × 18 g × Rs 0.50 = Rs 63 of COGS.
    expect(statement.rows[1]).toMatchObject({ amount: '-63.00' });
  });

  it('ledger and expenses: what the ledger and the expense list hold', async () => {
    const ledger = await ok('ledger');
    const movement = n(ledger.totals['in']).minus(n(ledger.totals['out']));
    const model = [...shop.expected().values()].reduce((s, v) => s + v, 0) / 100;
    expect(movement.toNumber()).toBe(model);
    const expenses = await ok('expenses');
    expect(expenses.rows.map((r) => r['category'])).toEqual(['Rent', 'Supplies']);
    expect(n(expenses.totals['amount']).toString()).toBe(
      n((await ok('sales-by-day')).totals['expenses']).toString(),
    );
  });

  it('menu engineering classes the coffee; deliveries list the order taken', async () => {
    const menu = await ok('menu-engineering');
    expect(menu.rows).toEqual([
      expect.objectContaining({ items: 7, share: '100.00', class: 'Star' }),
    ]);
    const deliveries = await ok('deliveries');
    expect(deliveries.rows).toEqual([
      expect.objectContaining({ status: 'pending_dispatch', deliveries: 1, delivered: 0 }),
    ]);
    expect(deliveries.totals).toMatchObject({ deliveries: 1, delivered: 0 });
  });

  it('filters by who settled the bill', async () => {
    const mine = (await ok('sales-by-day', `&staffId=${cashierId}`)).totals;
    expect(mine['orders']).toBe(4);
    const none = (await ok('sales-by-day', `&staffId=${fx.ownerId}`)).totals;
    expect(none['orders']).toBe(0);
  });
});

describe('who may open which report', () => {
  it('profit reports need reports.profit; the ledger and expenses their own permissions', async () => {
    expect((await report(manager, 'sales-by-category')).status).toBe(200);
    for (const key of ['menu-engineering', 'operating-result', 'ledger', 'expenses']) {
      expect((await report(manager, key)).status, key).toBe(403);
    }
    expect((await report(clerk, 'bills')).status).toBe(403);
    const catalog = await owner.call({ url: '/api/staff/v1/reports' });
    expect(catalog.json<{ items: { key: string }[] }>().items.map((r) => r.key)).toEqual([
      'sales-by-day',
      'bills',
      'sales-by-item',
      'sales-by-category',
      'sales-by-hour',
      'menu-engineering',
      'discounts',
      'payment-mix',
      'deliveries',
      'operating-result',
      'ledger',
      'expenses',
      'bill-lines',
    ]);
  });
});
