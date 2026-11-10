/** The old POS's customers and sales: one customer per mobile, history kept apart, safe to repeat. */
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeMobile,
  planCustomers,
  readOldPosFile,
  type OldPosFile,
} from '../../src/modules/oldpos/index.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

type Bill = NonNullable<OldPosFile['bills']>[number];
const bill = (over: Partial<Bill>): Bill => ({
  id: 1,
  billNo: 100,
  at: '2026-03-01T13:30:00',
  total: 500,
  discount: 0,
  payable: 500,
  paid: 500,
  balance: 0,
  status: 'paid',
  customerName: '',
  mobile: '',
  location: '',
  cashier: 'Ali',
  ...over,
});

describe('mobile numbers', () => {
  it('writes every form of one Pakistani mobile the same way', () => {
    for (const raw of [
      '0300-1234567',
      '+92 300 1234567',
      '923001234567',
      '3001234567',
      '0092 300 1234567',
    ])
      expect(normalizeMobile(raw), raw).toBe('03001234567');
    expect(normalizeMobile('042 35761234')).toBe('04235761234');
    expect(normalizeMobile('12')).toBeNull();
    expect(normalizeMobile('')).toBeNull();
  });

  it('one customer per mobile, with the newest name and location', () => {
    const customers = planCustomers([
      bill({ id: 2, at: '2026-05-01T10:00:00', mobile: '+92 300 1234567', customerName: 'Sara K' }),
      bill({
        id: 1,
        at: '2026-01-01T10:00:00',
        mobile: '0300-1234567',
        customerName: 'Sara',
        location: 'DHA',
      }),
      bill({ id: 3, at: '2026-02-01T10:00:00', mobile: 'none', customerName: 'Walk-in' }),
    ]);
    expect(customers).toEqual([
      { mobile: '03001234567', name: 'Sara K', location: 'DHA', lastSeen: '2026-05-01' },
    ]);
  });
});

describe('reading the export file', () => {
  it('takes it compressed or plain, and refuses anything else', () => {
    const file = { products: [], bills: [bill({})], lines: [] };
    expect(readOldPosFile(gzipSync(Buffer.from(JSON.stringify(file)))).bills).toHaveLength(1);
    expect(readOldPosFile(Buffer.from(JSON.stringify(file))).bills).toHaveLength(1);
    expect(() => readOldPosFile(Buffer.from('{"products": "no"}'))).toThrow(
      /not an old POS export/,
    );
    expect(() => readOldPosFile(Buffer.from([0x1f, 0x8b, 0, 1, 2]))).toThrow(/damaged/);
  });
});

let fx: IdentityFixture;
let owner: Client;
const file: OldPosFile = {
  source: 'test.accdb',
  products: [
    { name: 'Hist Fries', barcode: '1', price: 250, inStock: true, category: 'Hist Starter' },
  ],
  bills: [
    bill({
      id: 9001,
      billNo: 77,
      mobile: '0321 5550001',
      customerName: 'Bilal',
      location: 'Gulberg',
    }),
    bill({ id: 9002, billNo: 77, at: '2026-03-02T23:50:00', payable: 300 }),
    bill({ id: 9003, billNo: 78, at: '2026-03-02T12:00:00', status: 'Pending', payable: 900 }),
  ],
  lines: [
    {
      id: 8001,
      billNo: 77,
      at: '2026-03-01T13:30:00',
      barcode: '1',
      name: 'Hist Fries',
      category: 'Hist Starter',
      qty: 2,
      price: 250,
      amount: 500,
      status: 'Paid',
    },
    {
      id: 8002,
      billNo: 77,
      at: '2026-03-02T23:50:00',
      barcode: '',
      name: 'Tea',
      category: 'Tea',
      qty: 1,
      price: 300,
      amount: 300,
      status: 'Paid',
    },
  ],
};

async function send(path: 'preview' | 'apply', body: Buffer) {
  const res = await owner.call({
    method: 'POST',
    url: `/api/staff/v1/imports/old-pos/${path}`,
    headers: { 'content-type': 'application/gzip', 'idempotency-key': randomUUID() },
    payload: body,
  });
  return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
}

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
});
afterAll(async () => {
  await fx.close();
});

describe('the import on screen (owner)', () => {
  const zipped = gzipSync(Buffer.from(JSON.stringify(file)));

  it('the preview shows what would happen and saves nothing', async () => {
    const res = await send('preview', zipped);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      customers: { created: 1, updated: 0 },
      history: { bills: 3, lines: 2 },
    });
    const { rows } = await fx.pool.query('SELECT 1 FROM cl.old_pos_bills');
    expect(rows).toHaveLength(0);
  });

  it('the import keeps it; a second import adds nothing', async () => {
    expect((await send('apply', zipped)).body).toMatchObject({
      menu: { itemsCreated: 1 },
      history: { bills: 3, lines: 2 },
    });
    expect((await send('apply', zipped)).body).toMatchObject({
      menu: { itemsCreated: 0, alreadyThere: 1 },
      customers: { created: 0, updated: 0 },
      history: { bills: 0, lines: 0 },
    });
  });

  it('a damaged file changes nothing and says so', async () => {
    const res = await send('apply', Buffer.from('not a file'));
    expect(res.status).toBe(400);
  });

  it('finds the customer by any part of the name or number, and for a delivery by mobile', async () => {
    const list = await owner.call({ method: 'GET', url: '/api/staff/v1/customers?q=bil' });
    expect(list.json<{ items: unknown[]; total: number }>()).toMatchObject({
      total: 1,
      items: [{ mobile: '03215550001', name: 'Bilal', location: 'Gulberg', bills: 1 }],
    });
    const byNumber = await owner.call({ method: 'GET', url: '/api/staff/v1/customers?q=5550' });
    expect(byNumber.json<{ items: unknown[] }>().items).toHaveLength(1);
    const lookup = await owner.call({
      method: 'GET',
      url: '/api/staff/v1/customers/lookup?mobile=%2B92%20321%205550001',
    });
    expect(lookup.json()).toEqual({ customer: { name: 'Bilal', location: 'Gulberg' } });
    const unknown = await owner.call({
      method: 'GET',
      url: '/api/staff/v1/customers/lookup?mobile=03009999999',
    });
    expect(unknown.json()).toEqual({ customer: null });
  });

  it('the old sales report counts paid bills by shop day, and the best sellers', async () => {
    const res = await owner.call({
      method: 'GET',
      url: '/api/staff/v1/reports/old-pos?from=2026-03-01&to=2026-03-31',
    });
    const report = res.json<{
      totals: { bills: number; sales: number };
      days: { date: string; bills: number; sales: number }[];
      items: { item: string; amount: number }[];
    }>();
    expect(report.totals).toEqual({ bills: 2, sales: 800 }); // the pending bill does not count
    expect(report.days.map((d) => d.date)).toEqual(['2026-03-01', '2026-03-02']);
    expect(report.items[0]).toMatchObject({ item: 'Hist Fries', amount: 500 });
  });

  it('nobody can change the old sales afterwards', async () => {
    await expect(fx.pool.query('UPDATE cl.old_pos_bills SET payable = 1')).rejects.toThrow(
      /permission denied/,
    );
    await expect(fx.pool.query('DELETE FROM cl.old_pos_bill_lines')).rejects.toThrow(
      /permission denied/,
    );
  });
});
