/**
 * Lots, expiry and FEFO (Phase 4 step 4.3; RECIPE_INVENTORY.md §3, §5, §6, §10):
 * AT-129 (pickup takes the earliest-expiring lot first), AT-13 (only expired lots left →
 * unavailable, cannot reserve), AT-30 (a lot expiring between acceptance and pickup still
 * posts, flagged, with an alert), AT-102 (stock at zero → unavailable on staff and guest
 * menus; the manual switch wins), the nightly expiry scan, waste of a named lot, receipts
 * and reversals per lot, switching lots on for stock already on hand (P4-3), and the
 * nightly check of lots against balances.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateRecipe,
  consume,
  createRecipeDraft,
  findStockMismatches,
  postOpeningBalance,
  reserve,
  scanExpiry,
  setStockMode,
  wasteIngredient,
} from '../../src/modules/stock/index.ts';
import { withTransaction, type Tx } from '../../src/platform/db/tx.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { testOrderLines } from '../support/orders.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let today = '';

type Body = Record<string, unknown>;
const d = (v: string) => new Decimal(v);
const tx = <T>(fn: (t: Tx) => Promise<T>) => withTransaction(fx.pool, fn);
const audit = () => ({
  actor: { kind: 'user' as const, userId: fx.ownerId },
  correlationId: randomUUID(),
});
const ctx = () => ({ actorUserId: fx.ownerId, businessDate: today });
/** today ± n days, YYYY-MM-DD. */
const day = (n: number) => {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

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

let skuCounter = 0;
/** A lot-tracked milk kept in ml, counted with an empty shelf. */
async function milk(fields: Body = {}): Promise<string> {
  skuCounter += 1;
  const res = await call(clerk, 'POST', '/inventory/items', {
    sku: `lot-${String(skuCounter)}`,
    name: `Lot milk ${String(skuCounter)}`,
    baseUom: 'ml',
    trackLots: true,
    trackExpiry: true,
    nearExpiryDays: 2,
    ...fields,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body['id'] as string;
  await tx((t) =>
    postOpeningBalance(t, ctx(), audit(), { itemId: id, qty: d('0'), unitCost: d('0.3') }),
  );
  return id;
}

async function receive(itemId: string, qty: string, expiryDate: string, lotCode?: string) {
  const res = await call(clerk, 'POST', '/purchase-receipts', {
    paidNow: false,
    lines: [
      {
        itemId,
        qty,
        lineCost: (Number(qty) * 0.3).toFixed(2),
        expiryDate,
        ...(lotCode ? { lotCode } : {}),
      },
    ],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function lots(itemId: string) {
  return (await call(clerk, 'GET', `/inventory/items/${itemId}`)).body['lots'] as Body[];
}

/** Moves a lot's expiry into the past, as time passing would. */
async function expire(itemId: string, lotCode: string, daysAgo = 1) {
  await fx.pool.query(
    'UPDATE cl.inventory_lots SET expiry_date = $3 WHERE item_id = $1 AND lot_code = $2',
    [itemId, lotCode, day(-daysAgo)],
  );
}

async function shares(itemId: string) {
  const { rows } = await fx.pool.query<{
    lot_code: string;
    qty: string;
    expired: boolean;
    flags: string[];
  }>(
    `SELECT l.lot_code, s.qty_delta::text AS qty, s.expired, m.flags
       FROM cl.stock_movement_lots s
       JOIN cl.inventory_lots l ON l.id = s.lot_id
       JOIN cl.stock_movements m ON m.id = s.movement_id
      WHERE m.item_id = $1 AND m.movement_type = 'consumption' ORDER BY s.id`,
    [itemId],
  );
  return rows;
}

async function openAlerts(itemId: string) {
  const { rows } = await fx.pool.query<{ kind: string; lot_code: string | null; detail: Body }>(
    `SELECT a.kind, l.lot_code, a.detail FROM cl.inventory_alerts a
       LEFT JOIN cl.inventory_lots l ON l.id = a.lot_id
      WHERE a.item_id = $1 AND a.state <> 'resolved' ORDER BY a.id`,
    [itemId],
  );
  return rows;
}

const line = async () => (await testOrderLines(fx.pool, fx.ownerId))[0] ?? '';

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('lot-clerk', ['inventory_clerk']);
  clerk = await fx.loggedIn('lot-clerk');
  today = await businessDateOf(fx.pool, new Date());
});
afterAll(async () => {
  await fx.close();
});

describe('receiving into lots', () => {
  it('makes one lot per receipt line with its code and expiry, in FEFO order', async () => {
    const id = await milk();
    await receive(id, '2000', day(10), 'LATE');
    await receive(id, '1000', day(3), 'EARLY');
    expect((await lots(id)).map((l) => [l['lotCode'], l['expiryDate'], l['qtyRemaining']])).toEqual(
      [
        ['EARLY', day(3), '1000.0000'],
        ['LATE', day(10), '2000.0000'],
      ],
    );
    expect((await lots(id))[0]).toMatchObject({
      origin: 'receipt',
      receiptNo: expect.stringMatching(/^GRN-/) as string,
    });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('reverses a receipt only while its own lot still holds it', async () => {
    const id = await milk();
    const first = await receive(id, '1000', day(3), 'R1');
    await receive(id, '1000', day(9), 'R2');
    const l = await line();
    await tx((t) => reserve(t, { orderLineId: l, requirement: new Map([[id, d('300')]]) }));
    await tx((t) =>
      consume(t, ctx(), {
        orderLineId: l,
        eventKey: randomUUID(),
        takes: [{ itemId: id, qty: d('300') }],
      }),
    );
    const res = await call(
      clerk,
      'POST',
      `/purchase-receipts/${first['receiptId'] as string}/reverse`,
      {
        reason: 'Wrong lot',
      },
    );
    expect(res.status).toBe(400);
    expect(res.body['detail']).toMatch(
      /lot from this receipt is already used \(700 of 1000 ml left\)/,
    );
  });
});

describe('FEFO picking (AT-129, AT-30)', () => {
  it('takes the earliest-expiring lot first, then the next (AT-129)', async () => {
    const id = await milk();
    await receive(id, '2000', day(10), 'LATE');
    await receive(id, '500', day(2), 'EARLY');
    const l = await line();
    await tx((t) => reserve(t, { orderLineId: l, requirement: new Map([[id, d('800')]]) }));
    await tx((t) =>
      consume(t, ctx(), {
        orderLineId: l,
        eventKey: randomUUID(),
        takes: [{ itemId: id, qty: d('800') }],
      }),
    );
    expect(await shares(id)).toEqual([
      { lot_code: 'EARLY', qty: '-500.0000', expired: false, flags: [] },
      { lot_code: 'LATE', qty: '-300.0000', expired: false, flags: [] },
    ]);
    expect((await lots(id)).map((x) => [x['lotCode'], x['qtyRemaining']])).toEqual([
      ['LATE', '1700.0000'],
    ]);
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('a lot expiring between acceptance and pickup still posts, flagged, with an alert (AT-30)', async () => {
    const id = await milk();
    await receive(id, '300', day(1), 'TODAY');
    const l = await line();
    await tx((t) => reserve(t, { orderLineId: l, requirement: new Map([[id, d('200')]]) }));
    await expire(id, 'TODAY'); // the night passes before the pickup
    await tx((t) =>
      consume(t, ctx(), {
        orderLineId: l,
        eventKey: randomUUID(),
        takes: [{ itemId: id, qty: 'rest' }],
      }),
    );
    expect(await shares(id)).toEqual([
      { lot_code: 'TODAY', qty: '-200.0000', expired: true, flags: ['expired_lot_used'] },
    ]);
    const alerts = await openAlerts(id);
    expect(alerts.find((a) => a.kind === 'expired')).toMatchObject({
      lot_code: 'TODAY',
      detail: { usedBy: l, qty: '200.0000' },
    });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('uses usable lots first and only the rest from an expired one', async () => {
    const id = await milk();
    await receive(id, '300', day(1), 'OLD');
    await receive(id, '100', day(5), 'NEW');
    const l = await line();
    await tx((t) => reserve(t, { orderLineId: l, requirement: new Map([[id, d('250')]]) }));
    await expire(id, 'OLD');
    await tx((t) =>
      consume(t, ctx(), {
        orderLineId: l,
        eventKey: randomUUID(),
        takes: [{ itemId: id, qty: 'rest' }],
      }),
    );
    expect((await shares(id)).map((s) => [s.lot_code, s.qty, s.expired])).toEqual([
      ['NEW', '-100.0000', false],
      ['OLD', '-150.0000', true],
    ]);
  });
});

describe('expired lots are not available (AT-13)', () => {
  it('leaves only expired lots: nothing can be reserved', async () => {
    const id = await milk();
    await receive(id, '1000', day(2), 'GONE');
    await expire(id, 'GONE');
    const l = await line();
    await expect(
      tx((t) => reserve(t, { orderLineId: l, requirement: new Map([[id, d('100')]]) })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await receive(id, '150', day(4), 'FRESH');
    await tx((t) => reserve(t, { orderLineId: l, requirement: new Map([[id, d('100')]]) }));
    const other = await line();
    await expect(
      tx((t) => reserve(t, { orderLineId: other, requirement: new Map([[id, d('100')]]) })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect((await lots(id)).find((x) => x['lotCode'] === 'GONE')).toMatchObject({ expired: true });
  });
});

describe('menus (AT-102, AT-13)', () => {
  it('shows a drink unavailable on staff and guest menus when its milk is gone or expired; the manual switch wins', async () => {
    const id = await milk();
    await receive(id, '300', day(3), 'M1');
    const cat = await call(owner, 'POST', '/menu/categories', { name: 'Lot drinks' });
    const created = await call(owner, 'POST', '/menu/items', {
      categoryId: cat.body['id'],
      name: 'Lot latte',
      variants: [{ name: 'Regular', price: '500' }],
    });
    const variantId = (created.body['variantIds'] as string[])[0] ?? '';
    await tx(async (t) => {
      const draft = await createRecipeDraft(t, {
        variantId,
        components: [{ itemId: id, qtyBase: '200' }],
      });
      await activateRecipe(t, audit(), draft.id);
      await setStockMode(t, audit(), variantId, 'recipe');
    });
    const table = await call(owner, 'POST', '/tables', { code: 'L1', name: 'Lot table' });
    const qr = await call(owner, 'POST', '/qr-entry-points/generate', {
      tableIds: [table.body['id']],
      counter: false,
    });
    const token = (qr.body['items'] as { token: string }[])[0]?.token ?? '';
    const cookies: Record<string, string> = {};
    const keep = (res: LightMyRequestResponse) => {
      for (const c of res.cookies) cookies[c.name] = c.value;
      return res;
    };
    keep(
      await fx.customer.inject({ method: 'GET', url: `/api/customer/v1/entry/${token}`, cookies }),
    );
    type Menu = {
      categories: {
        items: {
          variants: { id: string; available: boolean; unavailableReason: string | null }[];
        }[];
      }[];
    };
    const find = (menu: Menu) =>
      menu.categories
        .flatMap((c) => c.items)
        .flatMap((i) => i.variants)
        .find((v) => v.id === variantId);
    const staff = async () => find((await call(owner, 'GET', '/menu')).body as unknown as Menu);
    const guest = async () =>
      find(
        keep(
          await fx.customer.inject({ method: 'GET', url: '/api/customer/v1/menu', cookies }),
        ).json<Menu>(),
      );

    expect(await staff()).toMatchObject({ available: true });
    expect(await guest()).toMatchObject({ available: true });
    // The only lot expires: on hand, but not usable.
    await expire(id, 'M1');
    expect(await staff()).toMatchObject({ available: false, unavailableReason: 'out_of_stock' });
    expect(await guest()).toMatchObject({ available: false });
    // Fresh milk arrives, then is used up to zero.
    await receive(id, '200', day(5), 'M2');
    expect(await staff()).toMatchObject({ available: true });
    await tx((t) =>
      wasteIngredient(t, ctx(), audit(), {
        itemId: id,
        qty: d('200'),
        reasonCode: 'spilled',
        key: randomUUID(),
      }),
    );
    expect(await guest()).toMatchObject({ available: false });
    // The manual switch wins over stock.
    await receive(id, '1000', day(6), 'M3');
    expect(await guest()).toMatchObject({ available: true });
    await call(owner, 'POST', `/menu/variants/${variantId}/availability`, {
      available: false,
      reason: 'Machine broken',
    });
    expect(await staff()).toMatchObject({
      available: false,
      unavailableReason: 'marked_unavailable',
    });
    expect(await guest()).toMatchObject({ available: false });
  });
});

describe('the expiry scan (RECIPE_INVENTORY.md §10)', () => {
  it('raises near-expiry and expired alerts per lot, once, and clears them when the lot is gone', async () => {
    const id = await milk();
    await receive(id, '500', day(1), 'SOON');
    await receive(id, '500', day(20), 'LATER');
    await receive(id, '400', day(5), 'BAD');
    await expire(id, 'BAD');
    const found = await tx((t) => scanExpiry(t, today));
    expect(found.expired).toBeGreaterThanOrEqual(1);
    expect((await openAlerts(id)).map((a) => [a.kind, a.lot_code])).toEqual([
      ['near_expiry', 'SOON'],
      ['expired', 'BAD'],
    ]);
    await tx((t) => scanExpiry(t, today)); // once only
    expect(await openAlerts(id)).toHaveLength(2);
    const { rows } = await fx.pool.query(
      `SELECT 1 FROM cl.outbox_events WHERE event_type = 'availability.changed' AND entity_id = $1`,
      [id],
    );
    expect(rows.length).toBeGreaterThan(0);
    // Waste the expired lot by name: recorded as expired-lot waste, alert cleared.
    const bad = (await lots(id)).find((x) => x['lotCode'] === 'BAD');
    await tx((t) =>
      wasteIngredient(t, ctx(), audit(), {
        itemId: id,
        qty: d('400'),
        reasonCode: 'expired',
        key: randomUUID(),
        lotId: bad?.['id'] as string,
      }),
    );
    const { rows: waste } = await fx.pool.query<{ kind: string }>(
      'SELECT kind FROM cl.wastage_records WHERE item_id = $1',
      [id],
    );
    expect(waste).toEqual([{ kind: 'expired_lot' }]);
    expect((await openAlerts(id)).map((a) => [a.kind, a.lot_code])).toEqual([
      ['near_expiry', 'SOON'],
    ]);
    // A day later SOON has expired: near expiry becomes expired.
    await tx((t) => scanExpiry(t, day(2)));
    expect((await openAlerts(id)).map((a) => [a.kind, a.lot_code])).toEqual([['expired', 'SOON']]);
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });
});

describe('switching lots on for stock on hand (P4-3)', () => {
  it('turns what is on hand into one opening lot with the expiry the clerk enters', async () => {
    skuCounter += 1;
    const res = await call(clerk, 'POST', '/inventory/items', {
      sku: `p43-${String(skuCounter)}`,
      name: 'Cream',
      baseUom: 'ml',
    });
    const id = res.body['id'] as string;
    await tx((t) =>
      postOpeningBalance(t, ctx(), audit(), { itemId: id, qty: d('1200'), unitCost: d('1') }),
    );
    const version = () =>
      call(clerk, 'GET', `/inventory/items/${id}`).then((r) => r.body['version'] as number);
    const missing = await call(clerk, 'PATCH', `/inventory/items/${id}`, {
      expectedVersion: await version(),
      trackLots: true,
      trackExpiry: true,
    });
    expect(missing.status).toBe(400);
    expect(missing.body['detail']).toBe('Enter the expiry date of the 1200 ml on hand');
    const ok = await call(clerk, 'PATCH', `/inventory/items/${id}`, {
      expectedVersion: await version(),
      trackLots: true,
      trackExpiry: true,
      nearExpiryDays: 1,
      existingStockExpiry: day(4),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await lots(id)).map((l) => [l['origin'], l['expiryDate'], l['qtyRemaining']])).toEqual([
      ['opening', day(4), '1200.0000'],
    ]);
    expect(await findStockMismatches(fx.pool)).toEqual([]);
    // Off again: the quantity stays on the item, the lot detail goes.
    const off = await call(clerk, 'PATCH', `/inventory/items/${id}`, {
      expectedVersion: await version(),
      trackLots: false,
      trackExpiry: false,
      nearExpiryDays: null,
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(await lots(id)).toEqual([]);
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });
});

describe('the nightly check (COST_VALUATION.md §11)', () => {
  it('reports lots that disagree with the balance', async () => {
    const id = await milk();
    await receive(id, '700', day(6), 'TAMPER');
    await fx.pool.query('UPDATE cl.inventory_lots SET qty_remaining = 650 WHERE item_id = $1', [
      id,
    ]);
    expect(await findStockMismatches(fx.pool)).toEqual([
      { itemId: id, problem: 'on hand 700.0000 ≠ lots 650.0000' },
    ]);
    await fx.pool.query('UPDATE cl.inventory_lots SET qty_remaining = 700 WHERE item_id = $1', [
      id,
    ]);
  });
});
