/**
 * Alerts, overview and movement history (Phase 4 step 4.7; RECIPE_INVENTORY.md §10).
 * AT-111: low, near-expiry and overstock alerts open once per item and kind and resolve
 * when the condition clears, also when a threshold changes. A person may note an alert as
 * seen; only a balance mismatch (owner), found stock and an expired lot used in an order
 * are closed by hand. The overview lists what needs attention; history shows every
 * movement with the on-hand after it.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postOpeningBalance, scanExpiry } from '../../src/modules/stock/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let today = '';

type Body = Record<string, unknown>;
async function call(
  client: Client,
  method: 'GET' | 'POST' | 'PATCH',
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
const day = (n: number) => {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

let skuCounter = 0;
async function item(fields: Body, opening: string): Promise<string> {
  skuCounter += 1;
  const res = await call(clerk, 'POST', '/inventory/items', {
    sku: `al-${String(skuCounter)}`,
    name: `Alert item ${String(skuCounter)}`,
    baseUom: 'ml',
    ...fields,
  });
  const id = res.body['id'] as string;
  await withTransaction(fx.pool, (t) =>
    postOpeningBalance(
      t,
      { actorUserId: fx.ownerId, businessDate: today },
      { actor: { kind: 'user', userId: fx.ownerId }, correlationId: randomUUID() },
      { itemId: id, qty: new Decimal(opening), unitCost: new Decimal('0.3') },
    ),
  );
  return id;
}

async function alertsOf(itemId: string) {
  const { rows } = await fx.pool.query<{ kind: string; state: string }>(
    `SELECT kind, state FROM cl.inventory_alerts WHERE item_id = $1 ORDER BY id`,
    [itemId],
  );
  return rows;
}
const open = async (itemId: string) =>
  (await alertsOf(itemId)).filter((a) => a.state !== 'resolved').map((a) => a.kind);

const receive = (itemId: string, qty: string, extra: Body = {}) =>
  call(clerk, 'POST', '/purchase-receipts', {
    paidNow: false,
    lines: [{ itemId, qty, lineCost: '1', ...extra }],
  });
const waste = (itemId: string, qty: string) =>
  call(clerk, 'POST', '/inventory/waste', { itemId, qty, reasonCode: 'spilled' });

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('al-clerk', ['inventory_clerk']);
  clerk = await fx.loggedIn('al-clerk');
  today = await businessDateOf(fx.pool, new Date());
});
afterAll(async () => {
  await fx.close();
});

describe('alerts fire once per item and kind, and resolve when cleared (AT-111)', () => {
  it('low', async () => {
    const id = await item({ lowThreshold: '500' }, '1000');
    expect(await open(id)).toEqual([]);
    await waste(id, '600'); // 400 ≤ 500
    await waste(id, '100'); // still low: no second alert
    expect(await open(id)).toEqual(['low']);
    await receive(id, '1000'); // 1300
    expect(await open(id)).toEqual([]);
    await waste(id, '900'); // low again: a new alert
    expect((await alertsOf(id)).map((a) => [a.kind, a.state])).toEqual([
      ['low', 'resolved'],
      ['low', 'open'],
    ]);
  });

  it('overstock, also when the threshold is changed', async () => {
    const id = await item({ overstockThreshold: '2000' }, '1000');
    await receive(id, '1000'); // 2000 ≥ 2000
    await receive(id, '10');
    expect(await open(id)).toEqual(['overstock']);
    await waste(id, '100'); // 1910
    expect(await open(id)).toEqual([]);
    const version = (await call(clerk, 'GET', `/inventory/items/${id}`)).body['version'];
    await call(clerk, 'PATCH', `/inventory/items/${id}`, {
      expectedVersion: version,
      overstockThreshold: '1500',
    });
    expect(await open(id)).toEqual(['overstock']); // re-checked with the new level
    const v2 = (await call(clerk, 'GET', `/inventory/items/${id}`)).body['version'];
    await call(clerk, 'PATCH', `/inventory/items/${id}`, {
      expectedVersion: v2,
      overstockThreshold: null,
    });
    expect(await open(id)).toEqual([]);
  });

  it('near expiry, per lot, cleared when the lot is used up', async () => {
    const id = await item({ trackLots: true, trackExpiry: true, nearExpiryDays: 3 }, '0');
    await receive(id, '500', { expiryDate: day(2), lotCode: 'N1' });
    await receive(id, '500', { expiryDate: day(30), lotCode: 'N2' });
    await withTransaction(fx.pool, (t) => scanExpiry(t, today));
    await withTransaction(fx.pool, (t) => scanExpiry(t, today));
    expect(await open(id)).toEqual(['near_expiry']);
    await waste(id, '500'); // FEFO: N1 gone
    expect(await open(id)).toEqual([]);
  });
});

describe('noting and closing alerts', () => {
  it('notes as seen; closes by hand only what never clears by itself', async () => {
    const id = await item({ lowThreshold: '500' }, '100');
    await waste(id, '10');
    const list = (await call(clerk, 'GET', '/inventory/alerts')).body['items'] as Body[];
    const low = list.find((a) => a['itemId'] === id && a['kind'] === 'low');
    expect(low).toMatchObject({
      state: 'open',
      manual: false,
      itemName: expect.stringMatching(/^Alert item/) as string,
    });
    expect(
      (await call(clerk, 'POST', `/inventory/alerts/${low?.['id'] as string}/acknowledge`, {}))
        .body,
    ).toEqual({
      state: 'acknowledged',
    });
    expect(
      (await call(clerk, 'POST', `/inventory/alerts/${low?.['id'] as string}/acknowledge`, {}))
        .status,
    ).toBe(409);
    const close = await call(clerk, 'POST', `/inventory/alerts/${low?.['id'] as string}/close`, {
      note: 'Ordered more',
    });
    expect(close.body['detail']).toBe('This alert closes by itself when the stock is right again');

    // A balance mismatch: only the owner closes it, and nothing is fixed (AT-94).
    const { rows } = await fx.pool.query<{ id: string }>(
      `INSERT INTO cl.inventory_alerts (item_id, kind, detail) VALUES ($1, 'balance_mismatch', '{"problems":["test"]}')
       RETURNING id::text`,
      [id],
    );
    const mismatch = rows[0]?.id ?? '';
    const byClerk = await call(clerk, 'POST', `/inventory/alerts/${mismatch}/close`, {
      note: 'Looked at it',
    });
    expect(byClerk.status).toBe(403);
    expect(
      ((await call(clerk, 'GET', '/inventory/alerts')).body['items'] as Body[])[0],
    ).toMatchObject({
      id: mismatch,
      kind: 'balance_mismatch',
      manual: true,
    }); // listed first
    const byOwner = await call(owner, 'POST', `/inventory/alerts/${mismatch}/close`, {
      note: 'Restored backup checked',
    });
    expect(byOwner.body).toEqual({ state: 'resolved' });
    const { rows: audit } = await fx.pool.query<{ reason: string }>(
      `SELECT reason FROM cl.audit_events WHERE action = 'stock.alert.close' AND entity_id = $1`,
      [mismatch],
    );
    expect(audit).toEqual([{ reason: 'Restored backup checked' }]);
  });
});

describe('the overview', () => {
  it('lists out, low, short, overstock, expiring and expired, open alerts and stock control progress', async () => {
    const outItem = await item({}, '0');
    const lowItem = await item({ lowThreshold: '500' }, '400');
    const overItem = await item({ overstockThreshold: '100' }, '150');
    const lotItem = await item({ trackLots: true, trackExpiry: true, nearExpiryDays: 2 }, '0');
    await receive(lotItem, '200', { expiryDate: day(1), lotCode: 'SOON' });
    await receive(lotItem, '300', { expiryDate: day(9), lotCode: 'BAD' });
    await fx.pool.query(
      `UPDATE cl.inventory_lots SET expiry_date = $2 WHERE item_id = $1 AND lot_code = 'BAD'`,
      [lotItem, day(-1)],
    );
    skuCounter += 1;
    await call(clerk, 'POST', '/inventory/items', {
      sku: `al-new-${String(skuCounter)}`,
      name: 'Not counted',
      baseUom: 'g',
    });
    const view = (await call(clerk, 'GET', '/inventory/overview')).body;
    const ids = (k: string) => (view[k] as Body[]).map((x) => x['itemId']);
    expect(ids('out')).toContain(outItem);
    expect(ids('low')).toContain(lowItem);
    expect(ids('overstock')).toContain(overItem);
    expect((view['expiring'] as Body[]).find((l) => l['itemId'] === lotItem)).toMatchObject({
      lotCode: 'SOON',
    });
    expect((view['expired'] as Body[]).find((l) => l['itemId'] === lotItem)).toMatchObject({
      lotCode: 'BAD',
    });
    const progress = view['stockControl'] as { counted: number; total: number };
    expect(progress.total - progress.counted).toBeGreaterThanOrEqual(1);
    expect(view['stockValue']).toBeNull(); // the clerk sees no values
    expect((await call(owner, 'GET', '/inventory/overview')).body['stockValue']).toMatch(
      /^\d+\.\d{2}$/,
    );
  });
});

describe('movement history', () => {
  it('shows each movement with its source, lots and the on-hand after it, filtered by type', async () => {
    const id = await item({ trackLots: true, trackExpiry: true }, '0');
    const posted = await receive(id, '1000', { expiryDate: day(5), lotCode: 'H1' });
    await waste(id, '250');
    const history = (await call(clerk, 'GET', `/inventory/items/${id}/movements`)).body[
      'items'
    ] as Body[];
    expect(history.map((m) => [m['type'], m['qtyDelta'], m['balanceAfter'], m['source']])).toEqual([
      ['waste', '-250.0000', '750.0000', 'Waste'],
      ['receipt', '1000.0000', '1000.0000', posted.body['receiptNo']],
    ]);
    expect(history[0]).toMatchObject({
      reasonCode: 'spilled',
      actor: 'al-clerk',
      valueDelta: null,
      lots: [{ lotCode: 'H1', qtyDelta: '-250.0000', expired: false }],
    });
    const asOwner = (await call(owner, 'GET', `/inventory/items/${id}/movements?type=receipt`))
      .body['items'] as Body[];
    expect(asOwner.map((m) => [m['type'], m['valueDelta']])).toEqual([['receipt', '1.0000']]);
    expect(
      (await call(clerk, 'GET', `/inventory/items/${id}/movements?type=nonsense`)).status,
    ).toBe(400);
  });
});
