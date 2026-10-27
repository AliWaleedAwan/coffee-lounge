/**
 * KPIs and the report engine (Phase 6 step 6.1; FINANCE_REPORTING.md §2–3). One business day
 * worked by hand through the real API, then the reports checked against it:
 *   - Table A: 2 lattes (Rs 500, recipe 18 g beans at Rs 0.50 = Rs 9 each) and 1 cake (Rs 300,
 *     no recipe), 10 % off the bill (Rs 100 on the lattes, Rs 30 on the cake), paid by card;
 *     Rs 100 of one latte refunded.
 *   - Table B: 1 latte, comped (settles at Rs 0).
 *   - 200 g beans spilled (Rs 100 waste); Rs 50 of supplies.
 * Also: COGS coverage and the "Needs recipes" rule (AT-70), a sale at 00:30 on the day before
 * (AT-44), totals = Σ rows and tiles = report totals (AC-RPT-1), and who sees costs.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { salesKpis } from '../../src/modules/reports/index.ts';
import { derive } from '../../src/modules/reports/kpi.ts';
import { postOpeningBalance } from '../../src/modules/stock/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { expectReconciled } from '../support/reconcile.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let manager: Client;
let waiter: Client;
let today = '';
let clock: Date | null = null;
const menu = { latte: '', cake: '', category: '' };

type Body = Record<string, unknown>;
async function call(
  client: Client,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  payload?: object,
) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}
async function ok(client: Client, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) {
  const res = await call(client, method, path, payload);
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

let tableNo = 0;
async function table(lines: { variantId: string; qty: number }[]) {
  tableNo += 1;
  const t = await ok(owner, 'POST', '/tables', {
    code: `KP${String(tableNo)}`,
    name: `KPI ${String(tableNo)}`,
  });
  const s = await ok(owner, 'POST', `/tables/${String(t['id'])}/sessions`, {});
  await ok(owner, 'POST', `/sessions/${String(s['id'])}/rounds`, {
    lines: lines.map((l) => ({ ...l, modifierOptionIds: [] })),
  });
  const { rows } = await fx.pool.query<{ id: string; variant: string; qty: number }>(
    `SELECT ol.id::text, ol.variant_id::text AS variant, ol.qty FROM cl.order_lines ol WHERE ol.session_id = $1 ORDER BY ol.id`,
    [s['id']],
  );
  for (const l of rows) await ok(owner, 'POST', `/lines/${l.id}/pickup`, { qty: l.qty });
  const bill = (await ok(owner, 'GET', `/sessions/${String(s['id'])}/bill`)) as {
    invoice: { id: string };
  };
  return { sessionId: String(s['id']), invoiceId: bill.invoice.id, lines: rows };
}
const report = async (client: Client, key: string, query: string) =>
  call(client, 'GET', `/reports/${key}?${query}`);

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app', now: () => clock ?? new Date() });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('kp-clerk', ['inventory_clerk']);
  await fx.addUser('kp-mgr', ['manager']);
  await fx.addUser('kp-waiter', ['waiter']);
  await fx.addUser('kp-partner', ['owner'], { pin: '1357' });
  clerk = await fx.loggedIn('kp-clerk');
  manager = await fx.loggedIn('kp-mgr');
  waiter = await fx.loggedIn('kp-waiter');
  today = await businessDateOf(fx.pool, new Date());

  const beans = String(
    (
      await ok(clerk, 'POST', '/inventory/items', {
        sku: 'KP-BEANS',
        name: 'KPI beans',
        baseUom: 'g',
      })
    )['id'],
  );
  await withTransaction(fx.pool, (t) =>
    postOpeningBalance(
      t,
      { actorUserId: fx.ownerId, businessDate: today },
      { actor: { kind: 'user', userId: fx.ownerId }, correlationId: randomUUID() },
      { itemId: beans, qty: new Decimal('5000'), unitCost: new Decimal('0.5') },
    ),
  );
  const cat = await ok(owner, 'POST', '/menu/categories', { name: 'KPI drinks' });
  menu.category = String(cat['id']);
  const latte = await ok(owner, 'POST', '/menu/items', {
    categoryId: cat['id'],
    name: 'KPI latte',
    variants: [{ name: 'Regular', price: '500' }],
  });
  const cake = await ok(owner, 'POST', '/menu/items', {
    categoryId: cat['id'],
    name: 'KPI cake',
    variants: [{ name: 'Slice', price: '300' }],
  });
  menu.latte = (latte['variantIds'] as string[])[0] ?? '';
  menu.cake = (cake['variantIds'] as string[])[0] ?? '';
  const draft = String(
    (await ok(clerk, 'POST', `/recipes/variants/${menu.latte}/draft`, {}))['id'],
  );
  const versions = (await ok(clerk, 'GET', `/recipes/variants/${menu.latte}`))[
    'versions'
  ] as Body[];
  await ok(clerk, 'PUT', `/recipes/versions/${draft}`, {
    expectedVersion: versions.find((v) => v['id'] === draft)?.['version'],
    components: [
      { itemId: beans, qty: '18', forDineIn: true, forTakeaway: true, forDelivery: true },
    ],
  });
  await ok(clerk, 'POST', `/recipes/versions/${draft}/activate`, {});
  await ok(clerk, 'POST', `/recipes/variants/${menu.latte}/stock-mode`, { mode: 'recipe' });

  // Table A: 2 lattes and a cake, 10 % off, paid by card; Rs 100 of a latte refunded.
  const a = await table([
    { variantId: menu.latte, qty: 2 },
    { variantId: menu.cake, qty: 1 },
  ]);
  await ok(owner, 'POST', `/invoices/${a.invoiceId}/discounts`, {
    orderLineId: null,
    kind: 'percent',
    value: '10',
    reason: 'Regular guest',
  });
  const locked = await ok(owner, 'POST', `/invoices/${a.invoiceId}/lock`, {});
  const paid = await ok(owner, 'POST', `/invoices/${a.invoiceId}/payments`, {
    lockVersion: locked['lockVersion'],
    method: 'card_manual',
    amount: '1170',
  });
  const { rows: lattes } = await fx.pool.query<{ id: string }>(
    `SELECT il.id::text FROM cl.invoice_lines il JOIN cl.order_lines ol ON ol.id = il.order_line_id
      WHERE il.invoice_id = $1 AND ol.variant_id = $2`,
    [a.invoiceId, menu.latte],
  );
  const stepUp = await ok(owner, 'POST', '/auth/step-up', {
    action: 'refund.approve',
    entityType: 'invoice',
    entityId: a.invoiceId,
    approverUsername: 'kp-partner',
    approverPin: '1357',
    reason: 'Cold latte',
  });
  await ok(owner, 'POST', `/invoices/${a.invoiceId}/refunds`, {
    kind: 'refund',
    paymentId: paid['paymentId'],
    amount: '100',
    reason: 'Cold latte',
    lines: [{ invoiceLineId: lattes[0]?.id, qty: 1, amount: '100' }],
    stepUpId: stepUp['stepUpId'],
  });
  // Table B: a latte on the house.
  const b = await table([{ variantId: menu.latte, qty: 1 }]);
  await ok(owner, 'POST', `/invoices/${b.invoiceId}/comps`, {
    orderLineId: b.lines[0]?.id,
    reason: 'Birthday',
  });
  await ok(owner, 'POST', `/invoices/${b.invoiceId}/lock`, {});
  // Waste and an expense.
  await ok(clerk, 'POST', '/inventory/waste', { itemId: beans, qty: '200', reasonCode: 'spilled' });
  const cats = (await ok(owner, 'GET', '/expense-categories'))['items'] as {
    id: string;
    name: string;
  }[];
  await ok(owner, 'POST', '/expenses', {
    categoryId: cats.find((c) => c.name === 'Supplies')?.id,
    amount: '50',
    paidVia: 'card',
  });
});
afterAll(async () => {
  await fx.close();
});

describe('the KPIs of a hand-worked day (FINANCE_REPORTING.md §3)', () => {
  it('match the day worked by hand, row and total alike', async () => {
    const res = await report(owner, 'sales-by-day', `from=${today}&to=${today}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const day = (res.body['rows'] as Body[])[0];
    expect(day).toMatchObject({
      date: today,
      orders: 2,
      items: 4,
      gross: '1800.00',
      discounts: '630.00',
      refunds: '100.00',
      net_sales: '1070.00',
      aov: '585.00',
      rounding: '0.00',
      collected: '1070.00',
      waste: '100',
      variance: '0',
      ppv: '0',
      expenses: '50.00',
      needs_recipes: 'Needs recipes',
      operating_result: null,
      coverage: '76.92',
      margin: '85.89',
    });
    expect(new Decimal(String(day?.['cogs'])).toString()).toBe('27');
    expect(new Decimal(String(day?.['gross_profit'])).toString()).toBe('943');
    expect(res.body['totals']).toMatchObject({
      orders: 2,
      net_sales: '1070.00',
      aov: '585.00',
      margin: '85.89',
      coverage: '76.92',
    });
    expectReconciled(res.body as never);
    expect((res.body['footer'] as Body)['notes']).toEqual([
      'Costs incomplete: 23.08 % of sales have no recipe yet; the margin is over recipe items only',
    ]);
  });

  it('by item: the latte carries the costs, the cake none; Σ items = the day', async () => {
    const res = await report(owner, 'sales-by-item', `from=${today}&to=${today}`);
    const rows = res.body['rows'] as Body[];
    expect(rows.map((r) => r['item'])).toEqual(['KPI latte', 'KPI cake']);
    expect(rows[0]).toMatchObject({
      items: 3,
      gross: '1500.00',
      discounts: '600.00',
      refunds: '100.00',
      net_sales: '800.00',
      coverage: '100.00',
      margin: '96.63',
    });
    expect(rows[1]).toMatchObject({
      items: 1,
      gross: '300.00',
      discounts: '30.00',
      net_sales: '270.00',
      coverage: '0.00',
      margin: null,
    });
    expectReconciled(res.body as never);
    expect(res.body['totals']).toMatchObject({ gross: '1800.00', net_sales: '1070.00' });
  });

  it('the tiles are the totals of the report (AC-RPT-1)', async () => {
    const tiles = await salesKpis(fx.pool, { from: today, to: today });
    const res = await report(owner, 'sales-by-day', `from=${today}&to=${today}`);
    const totals = res.body['totals'] as Body;
    for (const k of [
      'orders',
      'gross',
      'refunds',
      'net_sales',
      'aov',
      'cogs',
      'coverage',
      'gross_profit',
      'margin',
      'expenses',
      'waste',
    ]) {
      expect(new Decimal(String(tiles[k])).toString(), k).toBe(
        new Decimal(String(totals[k])).toString(),
      );
    }
    expect(tiles['needs_recipes']).toBe('Needs recipes');
  });

  it('filters by order type, category and item, leaving shop-wide figures out', async () => {
    const res = await report(
      owner,
      'sales-by-day',
      `from=${today}&to=${today}&itemId=${await itemOf(menu.cake)}`,
    );
    expect((res.body['rows'] as Body[])[0]).toMatchObject({
      orders: 1,
      gross: '300.00',
      net_sales: '270.00',
      waste: null,
      expenses: null,
      rounding: null,
    });
    const footer = res.body['footer'] as { filters: string[]; notes: string[] };
    expect(footer.filters).toEqual(['itemId: KPI cake']);
    expect(footer.notes).toContain(
      'Waste, stock variance, expenses and cash rounding belong to the whole shop: left out when filtering by order type, category or item',
    );
    const takeaway = await report(
      owner,
      'sales-by-day',
      `from=${today}&to=${today}&orderType=takeaway`,
    );
    expect((takeaway.body['rows'] as Body[])[0]).toMatchObject({ orders: 0, gross: '0.00' });
  });
});

async function itemOf(variantId: string): Promise<string> {
  const { rows } = await fx.pool.query<{ id: string }>(
    'SELECT item_id::text AS id FROM cl.menu_variants WHERE id = $1',
    [variantId],
  );
  return rows[0]?.id ?? '';
}

describe('COGS coverage and the operating result (AT-70)', () => {
  const d = (v: Record<string, string | null>) =>
    derive(
      Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, x === null ? null : new Decimal(x)]),
      ),
    );
  const base = {
    orders: '10',
    gross: '10000',
    promotions: '0',
    manual: '0',
    comps: '0',
    refunds: '0',
    cogs: '3000',
    waste: '0',
    variance: '0',
    ppv: '0',
    expenses: '1000',
  };

  it('below 100 % the margin is over recipe items only; at 100 % over all sales', () => {
    expect(d({ ...base, tracked_net: '10000' })).toMatchObject({
      coverage: '100',
      margin: '70',
      operating_result: '6000',
      needs_recipes: null,
    });
    // Half the sales have no recipe: margin over the recipe half (5000 − 3000) ÷ 5000.
    expect(d({ ...base, tracked_net: '5000' })).toMatchObject({
      coverage: '50',
      margin: '40',
      operating_result: null,
      needs_recipes: 'Needs recipes',
    });
  });

  it('shows the operating result from 95 % coverage, "Needs recipes" below', () => {
    expect(d({ ...base, tracked_net: '9500' })).toMatchObject({
      coverage: '95',
      needs_recipes: null,
      operating_result: '6000',
    });
    expect(d({ ...base, tracked_net: '9499' })).toMatchObject({
      coverage: '94.99',
      needs_recipes: 'Needs recipes',
      operating_result: null,
    });
  });

  it('no sales: no ratios, never a division by zero', () => {
    expect(d({ ...base, orders: '0', gross: '0', cogs: '0', tracked_net: '0' })).toMatchObject({
      coverage: null,
      margin: null,
      aov: null,
    });
  });
});

describe('the owner overview (AT-20 dashboard part, J8)', () => {
  it('shows tiles that are the totals of the reports they open, against last week', async () => {
    const res = await call(owner, 'GET', `/reports/overview?from=${today}&to=${today}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const tiles = res.body['tiles'] as Body[];
    expect(tiles.map((t) => t['key'])).toEqual([
      'net_sales',
      'orders',
      'aov',
      'margin',
      'waste',
      'operating_result',
    ]);
    const day = (await report(owner, 'sales-by-day', `from=${today}&to=${today}`)).body[
      'totals'
    ] as Body;
    for (const t of tiles) {
      expect(t['value'], String(t['key'])).toEqual(day[String(t['key'])] ?? null);
      expect(t['report']).toBe('sales-by-day');
    }
    expect(tiles[0]).toMatchObject({ value: '1070.00', compare: '0.00', change: null });
    expect(tiles[3]).toMatchObject({
      value: '85.89',
      note: 'Over recipe items only (COGS coverage 76.92 %)',
    });
    expect(tiles[5]).toMatchObject({
      value: null,
      note: 'Needs recipes: costs are missing for more than 5 % of sales',
    });
    // The hours add up to the sales after discounts; the days are the report's rows.
    const hours = res.body['byHour'] as Body[];
    expect(hours).toHaveLength(24);
    expect(hours[0]?.['hour']).toBe('04:00');
    const byHour = (await report(owner, 'sales-by-hour', `from=${today}&to=${today}`)).body;
    expectReconciled(byHour as never);
    expect((byHour['totals'] as Body)['sales']).toBe('1170.00');
    expect(hours.reduce((s, h) => s + Number(h['sales']), 0)).toBe(1170);
    expect(res.body['byDay']).toEqual([{ date: today, net_sales: '1070.00', orders: 2 }]);
    // J8: top items by margin straight on the overview.
    expect((res.body['topByMargin'] as Body[]).map((r) => [r['item'], r['margin']])).toEqual([
      ['KPI latte', '96.63'],
    ]);
    expect((res.body['topItems'] as Body[]).map((r) => r['item'])).toEqual([
      'KPI latte',
      'KPI cake',
    ]);
    expect(Object.keys(res.body['alerts'] as Body).sort()).toEqual([
      'ledger',
      'operational',
      'stock',
    ]);
  });

  it('a manager sees the sales tiles only; a waiter none', async () => {
    const res = await call(manager, 'GET', `/reports/overview?from=${today}&to=${today}`);
    expect((res.body['tiles'] as Body[]).map((t) => t['key'])).toEqual([
      'net_sales',
      'orders',
      'aov',
    ]);
    expect(res.body['topByMargin']).toBeNull();
    expect((res.body['topItems'] as Body[])[0]).not.toHaveProperty('margin');
    expect(res.body['coverage']).toBeNull();
    expect((await call(waiter, 'GET', '/reports/overview')).status).toBe(403);
    expect((await call(owner, 'GET', '/reports/overview?from=yesterday')).status).toBe(400);
  });
});

describe('business dates (AT-44, reports side)', () => {
  it('a sale settled at 00:30 counts on the business day before', async () => {
    const [y, m, dd] = today.split('-').map(Number) as [number, number, number];
    clock = new Date(Date.UTC(y, m - 1, dd + 1, 0, 30) - 5 * 3600 * 1000); // 00:30 in Karachi, the next morning
    const next = (() => {
      const t = new Date(Date.UTC(y, m - 1, dd + 1));
      return t.toISOString().slice(0, 10);
    })();
    const before = (await report(owner, 'sales-by-day', `from=${today}&to=${next}`)).body[
      'rows'
    ] as Body[];
    const night = await table([{ variantId: menu.cake, qty: 1 }]);
    const locked = await ok(owner, 'POST', `/invoices/${night.invoiceId}/lock`, {});
    await ok(owner, 'POST', `/invoices/${night.invoiceId}/payments`, {
      lockVersion: locked['lockVersion'],
      method: 'card_manual',
      amount: '300',
    });
    clock = null;
    const after = (await report(owner, 'sales-by-day', `from=${today}&to=${next}`)).body[
      'rows'
    ] as Body[];
    expect(after[0]?.['orders']).toBe(Number(before[0]?.['orders']) + 1);
    expect(after[1]?.['orders']).toBe(0);
  });
});

describe('who sees what', () => {
  it('a manager sees sales without costs; a waiter and a clerk see no sales report', async () => {
    const res = await report(manager, 'sales-by-day', `from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const keys = (res.body['columns'] as { key: string }[]).map((c) => c.key);
    expect(keys).toContain('net_sales');
    expect(keys).not.toContain('cogs');
    expect(keys).not.toContain('margin');
    expect(Object.keys((res.body['rows'] as Body[])[0] ?? {})).not.toContain('cogs');
    expect((res.body['footer'] as { notes: string[] }).notes).toEqual([]);
    for (const c of [waiter, clerk]) expect((await report(c, 'sales-by-day', '')).status).toBe(403);
    expect((await call(waiter, 'GET', '/reports')).body['items'] as Body[]).toEqual([]);
    expect(
      ((await call(owner, 'GET', '/reports')).body['items'] as Body[]).map((r) => r['key']),
    ).toEqual([
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
    expect((await report(owner, 'sales-by-day', 'from=2026-10-27&to=2026-10-01')).status).toBe(400);
    expect((await report(owner, 'sales-by-day', 'from=2025-01-01&to=2026-10-01')).status).toBe(400);
    expect(
      (await report(owner, 'sales-by-day', `from=${today}&to=${today}&orderType=drive_in`)).status,
    ).toBe(400);
  });
});
