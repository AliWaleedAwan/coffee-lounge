/**
 * Exports and the day-end (Phase 6 step 6.5; AT-103, AT-122, AC-RPT-1). A day of trading
 * through the API (cash, card at 10 % off, JazzCash with half refunded, a
 * paid-out, waste, one bill presented and left unpaid, the shift closed), then the next day: the
 * day-end for that day agrees with payments, refunds, the shift and the open bill, is made
 * once and kept; every export is the report on screen, needs `reports.export` and is audited.
 */
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../../src/platform/settings.ts';
import { closeDay } from '../../src/modules/reports/index.ts';
import { dayEndPrintData } from '../../src/modules/printing/day-end-data.ts';
import { renderDayEnd } from '../../src/modules/printing/index.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { decodeEscPos } from '../support/escpos/decoder.ts';
import { TradingShop } from '../support/trading.ts';

let fx: IdentityFixture;
let owner: Client;
let manager: Client;
let shop: TradingShop;
let day = '';
let today = '';
let openInvoice = '';
// Trading happens now; then the app's clock moves a day on, so today's business day is
// over (the database keeps its own clock for created and opened times, which stay today).
const start = new Date();
let clock = start;

type Body = Record<string, unknown>;
const n = (v: unknown) => new Decimal(typeof v === 'string' || typeof v === 'number' ? v : 0);
async function get(client: Client, url: string) {
  const res = await client.call({ method: 'GET', url: `/api/staff/v1${url}` });
  return res;
}
async function json(client: Client, url: string): Promise<Body> {
  const res = await get(client, url);
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json<Body>();
}
/** A CSV body as rows of cells (the test data has no quoted cells). */
const csvRows = (text: string) =>
  text
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n')
    .map((l) => l.split(','));

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app', now: () => clock });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('ex-cash', ['cashier']);
  await fx.addUser('ex-partner', ['owner'], { pin: '1357' });
  await fx.addUser('ex-mgr', ['manager']);
  manager = await fx.loggedIn('ex-mgr');
  const cashier = await fx.loggedIn('ex-cash');
  day = await businessDateOf(fx.pool, clock);
  shop = new TradingShop(fx, owner, cashier, { username: 'ex-partner', pin: '1357' }, 'XP');
  await shop.setUp({ recipe: true });
  await shop.openShift();
  await shop.sale(2, 'cash');
  await shop.sale(1, 'card_manual', 'jazzcash', { discountPercent: 10 });
  const c = await shop.sale(3, 'transfer', 'jazzcash');
  await shop.refund(c, 50);
  await shop.cashMovement('paid_out', 200);
  const { rows } = await fx.pool.query<{ id: string }>(
    `SELECT id::text FROM cl.inventory_items WHERE sku = 'XP-BEANS'`,
  );
  const waste = await owner.call({
    method: 'POST',
    url: '/api/staff/v1/inventory/waste',
    payload: { itemId: rows[0]?.id, qty: '100', reasonCode: 'spilled' },
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
  expect(waste.statusCode, waste.body).toBeLessThan(300);
  openInvoice = await shop.openBill(1);
  await shop.closeShift();
  clock = new Date(start.getTime() + 24 * 3600 * 1000);
  today = await businessDateOf(fx.pool, clock);
}, 300_000);
afterAll(async () => {
  await fx.close();
});

describe('the day-end report (AT-122)', () => {
  it('agrees with the payments, refunds, the shift and the open bill', async () => {
    const res = await json(owner, '/reports/day-end');
    expect(res).toMatchObject({ date: day, generatedBy: 'on_request' });
    const r = res['report'] as Body & {
      sales: Body;
      payments: Body[];
      shifts: Body[];
      openBills: Body;
      topItems: Body[];
      profit: Body | null;
      waste: Body;
    };
    const salesDay = (await json(owner, `/reports/sales-by-day?from=${day}&to=${day}`))[
      'totals'
    ] as Body;
    for (const k of ['gross', 'discounts', 'refunds', 'net_sales', 'collected'])
      expect(n(r.sales[k]).toString(), k).toBe(n(salesDay[k]).toString());
    expect(r.sales).toMatchObject({ orders: 3, gross: '2700.00', discounts: '45.00' });
    // Payments and refunds: the stored mix is the payment-mix report, and the database's.
    const mix = await json(owner, `/reports/payment-mix?from=${day}&to=${day}`);
    expect(r.payments.map((p) => [p['method'], p['collected']])).toEqual(
      (mix['rows'] as Body[]).map((p) => [p['method'], p['collected']]),
    );
    const { rows: money } = await fx.pool.query<{ paid: string; refunded: string }>(
      `SELECT (SELECT sum(amount) FROM cl.payments WHERE business_date = $1)::text AS paid,
              (SELECT sum(amount) FROM cl.refunds WHERE kind = 'refund' AND business_date = $1)::text AS refunded`,
      [day],
    );
    const taken = r.payments.reduce((s, p) => s.plus(n(p['taken'])), new Decimal(0));
    const refunded = r.payments.reduce((s, p) => s.plus(n(p['refunded'])), new Decimal(0));
    expect(taken.toString()).toBe(n(money[0]?.paid).toString());
    expect(refunded.toString()).toBe(n(money[0]?.refunded).toString());
    expect(refunded.toString()).toBe(n(r.sales['refunds']).toString());
    // The shift: closed, balanced, expected = float + cash sales − paid-out.
    expect(r.shifts).toEqual([
      expect.objectContaining({ cashier: 'ex-cash', expected: '5700.00', variance: '0.00' }),
    ]);
    // The bill presented and not paid.
    const { rows: bill } = await fx.pool.query<{ total: string }>(
      'SELECT total::text FROM cl.invoices WHERE id = $1',
      [openInvoice],
    );
    expect(r.openBills).toEqual({ count: 1, value: bill[0]?.total });
    expect(r.topItems).toEqual([expect.objectContaining({ items: 6 })]);
    expect(r.profit).toMatchObject({ coverage: '100.00' });
    expect(n(r.waste['cost']).toString()).toBe('50');
  });

  it('is made once and kept: the worker and later requests get the same one', async () => {
    const first = await json(owner, '/reports/day-end');
    await shop.sale(1, 'card_manual'); // the next day: does not touch the stored report
    const byWorker = await closeDay(fx.pool, clock);
    expect(byWorker).toMatchObject({ date: day, generatedBy: 'on_request' });
    expect(byWorker.generatedAt).toBe(first['generatedAt']);
    expect(await json(owner, `/reports/day-end?date=${day}`)).toEqual(first);
    await expect(fx.pool.query('DELETE FROM cl.day_end_reports')).rejects.toThrow();
    // Today is not over yet.
    expect((await get(owner, `/reports/day-end?date=${today}`)).statusCode).toBe(400);
  });

  it('shows costs and margins only with reports.profit', async () => {
    const view = (await json(manager, '/reports/day-end'))['report'] as Body & {
      waste: Body;
      topItems: Body[];
    };
    expect(view['profit']).toBeNull();
    expect(view.waste['cost']).toBeNull();
    expect(view.topItems[0]?.['margin']).toBeNull();
  });

  it('as a PDF (with reports.export) and on the 80 mm printer, without costs on paper', async () => {
    const pdf = await get(owner, `/reports/day-end/export?date=${day}&format=pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="day-end_${day}.pdf"`);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await get(manager, `/reports/day-end/export?date=${day}&format=pdf`)).statusCode).toBe(
      403,
    );

    const none = await owner.call({
      method: 'POST',
      url: '/api/staff/v1/reports/day-end/print',
      payload: { date: day },
    });
    expect(none.statusCode).toBe(400); // no receipt printer yet
    const printer = await owner.call({
      method: 'POST',
      url: '/api/staff/v1/printers',
      payload: { name: 'Day-end printer', connection: 'tcp', address: '127.0.0.1:9' },
    });
    const tills = await json(owner, '/printers');
    await owner.call({
      method: 'PUT',
      url: `/api/staff/v1/tills/${String((tills['tills'] as Body[])[0]?.['id'])}/printer`,
      payload: { printerId: printer.json<Body>()['id'] },
    });
    const print = async () =>
      (
        await owner.call({
          method: 'POST',
          url: '/api/staff/v1/reports/day-end/print',
          payload: { date: day },
        })
      ).json<Body>();
    expect(await print()).toMatchObject({ date: day, copyNo: 1 });
    expect(await print()).toMatchObject({ copyNo: 2 });
    const { rows } = await fx.pool.query<{ id: string }>(
      'SELECT id::text FROM cl.day_end_reports WHERE business_date = $1',
      [day],
    );
    const { text } = decodeEscPos(
      renderDayEnd(await dayEndPrintData(fx.pool, rows[0]?.id ?? ''), {
        width: 48,
        canCut: true,
        copyNo: 1,
        timeZone: 'Asia/Karachi',
      }),
    );
    expect(text).toContain('NET SALES');
    expect(text).toMatch(/Open bills \(1\)/);
    expect(text).not.toMatch(/COGS|margin %/i);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48);
  });
});

describe('exports (AT-103)', () => {
  it('CSV: BOM, ISO dates, plain decimals, the same rows and totals as the screen', async () => {
    const query = `from=${day}&to=${day}`;
    const screen = await json(owner, `/reports/sales-by-day?${query}`);
    const res = await get(owner, `/reports/sales-by-day/export?format=csv&${query}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="sales-by-day_${day}.csv"`,
    );
    expect(res.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const [head, ...rest] = csvRows(res.body);
    const columns = screen['columns'] as { key: string; label: string }[];
    expect(head).toEqual(columns.map((c) => c.label));
    expect(rest).toHaveLength(2); // the day and the total
    expect(rest[0]?.[0]).toBe(day);
    const totals = screen['totals'] as Body;
    const at = (key: string) => columns.findIndex((c) => c.key === key);
    expect(rest[1]?.[0]).toBe('Total');
    expect(rest[1]?.[at('net_sales')]).toBe(totals['net_sales']);
    expect(rest[1]?.[at('gross')]).toBe('2700.00'); // no thousands separator
    expect(rest[1]?.[at('cogs')]).toBe(String(totals['cogs']));
  });

  it('file names carry the filters by name; PDFs are PDFs; formats as the catalogue says', async () => {
    const { rows } = await fx.pool.query<{ id: string }>(
      `SELECT id::text FROM cl.menu_items WHERE name = 'XP coffee'`,
    );
    const item = await get(
      owner,
      `/reports/sales-by-item/export?format=csv&from=${day}&to=${today}&itemId=${rows[0]?.id ?? ''}`,
    );
    expect(item.statusCode, item.body).toBe(200);
    expect(item.headers['content-disposition']).toBe(
      `attachment; filename="sales-by-item_${day}_${today}_item-xp-coffee.csv"`,
    );
    const pdf = await get(owner, `/reports/payment-mix/export?format=pdf&from=${day}&to=${day}`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await get(owner, `/reports/audit-log/export?format=pdf`)).statusCode).toBe(400);
    expect((await get(owner, `/reports/audit-log/export?format=csv`)).statusCode).toBe(200);
    expect((await get(owner, `/reports/operating-result/export?format=csv`)).statusCode).toBe(400);
    expect((await get(owner, `/reports/bills/export?format=xlsx`)).statusCode).toBe(400);
  });

  it('need reports.export as well as the report’s own permission, and are audited', async () => {
    expect((await get(manager, `/reports/sales-by-day/export?format=csv`)).statusCode).toBe(403);
    // The manager may open the report but not export it, until the owner grants export.
    expect((await get(manager, `/reports/sales-by-day`)).statusCode).toBe(200);
    const { rows: denied } = await fx.pool.query<{ after: Body }>(
      `SELECT after FROM cl.audit_events WHERE action = 'access.denied' ORDER BY id DESC LIMIT 1`,
    );
    expect(denied[0]?.after).toMatchObject({ permission: 'reports.export' });
    const { rows } = await fx.pool.query<{ after: Body }>(
      `SELECT after FROM cl.audit_events WHERE action = 'report.export' ORDER BY id`,
    );
    expect(rows.map((r) => r.after['report'])).toEqual(
      expect.arrayContaining(['sales-by-day', 'sales-by-item', 'payment-mix', 'day-end']),
    );
    expect(rows.find((r) => r.after['report'] === 'sales-by-item')?.after).toMatchObject({
      format: 'csv',
      filters: { itemId: expect.any(String) as unknown },
    });
  });
});
