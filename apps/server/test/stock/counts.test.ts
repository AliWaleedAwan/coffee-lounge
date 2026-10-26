/**
 * Stock counts (Phase 4 step 4.5; RECIPE_INVENTORY.md §9, D-18, P4-5). AT-108: a blind
 * count; variances over 2 % or Rs 1,000 need approval by someone other than the
 * submitter; posting adds the variance as a delta, so sales made while counting are kept.
 * AT-29: a count below what is reserved still posts, raises the shortfall alert and blocks
 * new acceptances of the item. AT-67: a pickup after a low count posts found stock first,
 * with an owner alert. Lots are counted per lot. A count posting racing a pickup of the
 * same item loses nothing.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  findStockMismatches,
  postOpeningBalance,
  reserve,
} from '../../src/modules/stock/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { race, raceRuns, repeatRace, tally } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { testOrderLines } from '../support/orders.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let clerk2: Client;
let manager: Client;
let today = '';

type Body = Record<string, unknown>;
const d = (v: string) => new Decimal(v);
async function call(
  client: Client,
  method: 'GET' | 'POST' | 'DELETE',
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
const ctx = () => ({ actorUserId: fx.ownerId, businessDate: today });
const audit = () => ({
  actor: { kind: 'user' as const, userId: fx.ownerId },
  correlationId: randomUUID(),
});

let skuCounter = 0;
async function item(qty: string, cost: string, fields: Body = {}): Promise<string> {
  skuCounter += 1;
  const res = await call(clerk, 'POST', '/inventory/items', {
    sku: `cnt-${String(skuCounter)}`,
    name: `Count item ${String(skuCounter)}`,
    baseUom: 'ml',
    category: 'Counted',
    ...fields,
  });
  const id = res.body['id'] as string;
  await withTransaction(fx.pool, (t) =>
    postOpeningBalance(t, ctx(), audit(), { itemId: id, qty: d(qty), unitCost: d(cost) }),
  );
  return id;
}

async function balance(itemId: string) {
  const { rows } = await fx.pool.query<{
    on_hand: string;
    reserved: string;
    inventory_value: string;
  }>(
    'SELECT on_hand::text, reserved::text, inventory_value::text FROM cl.inventory_balances WHERE item_id = $1',
    [itemId],
  );
  return rows[0];
}

/** Starts a count of the given items as the clerk. */
async function start(itemIds: string[], extra: Body = {}): Promise<string> {
  const res = await call(clerk, 'POST', '/stock-counts', { scope: 'items', itemIds, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body['countNo']).toMatch(/^CNT-\d{4}-\d{5}$/);
  return res.body['id'] as string;
}
const enter = (countId: string, body: Body, client: Client = clerk) =>
  call(client, 'POST', `/stock-counts/${countId}/lines`, body);
const view = async (countId: string, client: Client = clerk) =>
  (await call(client, 'GET', `/stock-counts/${countId}`)).body;
const line = async () => (await testOrderLines(fx.pool, fx.ownerId))[0] ?? '';

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('cnt-clerk', ['inventory_clerk']);
  await fx.addUser('cnt-clerk2', ['inventory_clerk']);
  await fx.addUser('cnt-mgr', ['manager'], { pin: '4826' });
  await fx.addUser('cnt-owner2', ['owner'], { pin: '7391' });
  clerk = await fx.loggedIn('cnt-clerk');
  clerk2 = await fx.loggedIn('cnt-clerk2');
  manager = await fx.loggedIn('cnt-mgr');
  today = await businessDateOf(fx.pool, new Date());
});
afterAll(async () => {
  await fx.close();
});

describe('a blind count (AT-108)', () => {
  it('hides the book while counting, posts small variances at once as deltas', async () => {
    const milk = await item('1000', '0.3');
    const countId = await start([milk]);
    await enter(countId, { itemId: milk, countedQty: '990' }); // −1 %, Rs 3: within the thresholds
    const counting = await view(countId);
    expect(counting).toMatchObject({ status: 'draft', blind: true, scope: 'items' });
    expect((counting['items'] as Body[]).map((i) => i['id'])).toEqual([milk]);
    expect((counting['lines'] as Body[])[0]).toMatchObject({
      countedQty: '990.0000',
      bookQty: null,
      varianceQty: null,
      needsApproval: null,
    });
    // A sale while the count is open is kept: posting adds −10, not "set to 990".
    const l = await line();
    await withTransaction(fx.pool, (t) =>
      reserve(t, { orderLineId: l, requirement: new Map([[milk, d('100')]]) }),
    );
    await withTransaction(fx.pool, (t) =>
      consume(t, ctx(), {
        orderLineId: l,
        eventKey: randomUUID(),
        takes: [{ itemId: milk, qty: 'rest' }],
      }),
    );
    const submitted = await call(clerk, 'POST', `/stock-counts/${countId}/submit`, {});
    expect(submitted.body).toEqual({ status: 'posted', needsApproval: 0 });
    expect(await balance(milk)).toMatchObject({ on_hand: '890.0000', inventory_value: '267.0000' });
    const posted = await view(countId);
    expect((posted['lines'] as Body[])[0]).toMatchObject({
      bookQty: '1000.0000',
      varianceQty: '-10.0000',
      varianceValue: null, // the clerk does not see costs
      postedQty: '-10.0000',
      needsApproval: false,
    });
    expect((await view(countId, owner))['lines']).toEqual([
      expect.objectContaining({ varianceValue: '-3.0000' }),
    ]);
    const { rows } = await fx.pool.query<Body>(
      `SELECT movement_type, qty_delta::text, value_delta::text, source_type
         FROM cl.stock_movements WHERE item_id = $1 ORDER BY stock_movements.id DESC LIMIT 1`,
      [milk],
    );
    expect(rows[0]).toEqual({
      movement_type: 'count_adjustment',
      qty_delta: '-10.0000',
      value_delta: '-3.0000',
      source_type: 'stock_count_line',
    });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('needs approval above 2 % or Rs 1,000, by someone other than the submitter', async () => {
    const beans = await item('10000', '0.2'); // Rs 2,000
    const cups = await item('100', '15', { baseUom: 'pcs' }); // Rs 1,500
    const countId = await start([beans, cups]);
    await enter(countId, { itemId: beans, countedQty: '9.7', uom: 'l' }); // −3 %: over 2 %
    await enter(countId, { itemId: cups, countedQty: '99' }); // −1 %, Rs 15
    const submitted = await call(clerk, 'POST', `/stock-counts/${countId}/submit`, {});
    expect(submitted.body).toEqual({ status: 'submitted', needsApproval: 1 });
    const seen = await view(countId);
    expect(
      (seen['lines'] as Body[]).map((l) => [l['itemId'], l['varianceQty'], l['needsApproval']]),
    ).toEqual([
      [beans, '-300.0000', true],
      [cups, '-1.0000', false],
    ]);
    expect((await balance(beans))?.on_hand).toBe('10000.0000'); // nothing posted yet
    // Not the clerk (no right, no PIN), not a manager without the right.
    expect((await call(clerk, 'POST', `/stock-counts/${countId}/approve`, {})).body['code']).toBe(
      'STEP_UP_REQUIRED',
    );
    expect((await call(manager, 'POST', `/stock-counts/${countId}/approve`, {})).body['code']).toBe(
      'STEP_UP_REQUIRED',
    );
    // The owner approves: both lines post.
    const approved = await call(owner, 'POST', `/stock-counts/${countId}/approve`, {});
    expect(approved.body).toEqual({ status: 'posted' });
    expect(await balance(beans)).toMatchObject({
      on_hand: '9700.0000',
      inventory_value: '1940.0000',
    });
    expect((await balance(cups))?.on_hand).toBe('99.0000');
    expect(await view(countId)).toMatchObject({ approvedBy: 'Owner', submittedBy: 'cnt-clerk' });
  });

  it('is never approved by its own submitter, even the owner', async () => {
    const x = await item('500', '1');
    const { status, body } = await call(owner, 'POST', '/stock-counts', {
      scope: 'items',
      itemIds: [x],
    });
    expect(status).toBe(201);
    const countId = body['id'] as string;
    await enter(countId, { itemId: x, countedQty: '400' }, owner);
    await call(owner, 'POST', `/stock-counts/${countId}/submit`, {});
    const own = await call(owner, 'POST', `/stock-counts/${countId}/approve`, {});
    expect(own.status).toBe(403);
    expect(own.body['detail']).toBe(
      'Someone other than the person who submitted the count must approve it',
    );
    await call(owner, 'POST', `/stock-counts/${countId}/send-back`, {
      reason: 'Recount the shelf',
    });
    await call(owner, 'POST', `/stock-counts/${countId}/cancel`, {});
  });

  it('lets an owner approve by PIN on the clerk’s device (step-up)', async () => {
    const x = await item('500', '1');
    const countId = await start([x]);
    await enter(countId, { itemId: x, countedQty: '300' });
    await call(clerk, 'POST', `/stock-counts/${countId}/submit`, {});
    const step = await call(clerk, 'POST', '/auth/step-up', {
      action: 'count.variance',
      entityType: 'stock_count',
      entityId: countId,
      approverUsername: 'cnt-owner2',
      approverPin: '7391',
      reason: 'Checked the shelf with the clerk',
    });
    expect(step.status, JSON.stringify(step.body)).toBe(201);
    const res = await call(clerk, 'POST', `/stock-counts/${countId}/approve`, {
      stepUpId: step.body['stepUpId'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await balance(x))?.on_hand).toBe('300.0000');
  });

  it('sends flagged lines back for a recount, which takes a fresh book quantity', async () => {
    const x = await item('800', '1');
    const y = await item('800', '1');
    const countId = await start([x, y]);
    await enter(countId, { itemId: x, countedQty: '500' });
    await enter(countId, { itemId: y, countedQty: '800' });
    await call(clerk2, 'POST', `/stock-counts/${countId}/submit`, {});
    const back = await call(owner, 'POST', `/stock-counts/${countId}/send-back`, {
      reason: 'Count the back shelf too',
    });
    expect(back.body).toEqual({ status: 'draft', recount: 1 });
    const again = await view(countId);
    expect(again).toMatchObject({ status: 'draft', sentBackReason: 'Count the back shelf too' });
    expect((again['lines'] as Body[]).map((l) => l['itemId'])).toEqual([y]);
    await enter(countId, { itemId: x, countedQty: '795' });
    expect((await call(clerk, 'POST', `/stock-counts/${countId}/submit`, {})).body).toEqual({
      status: 'posted',
      needsApproval: 0,
    });
    expect((await balance(x))?.on_hand).toBe('795.0000');
  });

  it('refuses a second open count, items outside the scope, and edits after submitting', async () => {
    const x = await item('100', '1');
    const countId = await start([x]);
    expect((await call(clerk, 'POST', '/stock-counts', { scope: 'all' })).body['detail']).toMatch(
      /^Count CNT-\d{4}-\d{5} is still open/,
    );
    const outside = await item('100', '1');
    expect((await enter(countId, { itemId: outside, countedQty: '1' })).body['detail']).toBe(
      'That item is not part of this count',
    );
    expect((await enter(countId, { itemId: x, countedQty: '1', uom: 'kg' })).status).toBe(400);
    await enter(countId, { itemId: x, countedQty: '100' });
    await call(clerk, 'POST', `/stock-counts/${countId}/submit`, {});
    expect((await enter(countId, { itemId: x, countedQty: '5' })).status).toBe(409);
    await expect(
      fx.pool.query('UPDATE cl.stock_count_lines SET counted_qty = 1 WHERE count_id = $1', [
        countId,
      ]),
    ).rejects.toThrow(/only while the count is a draft/);
  });
});

describe('a count below what is reserved (AT-29) and the pickup after it (AT-67)', () => {
  it('posts the truth, raises the shortfall, blocks new acceptances, then finds stock at pickup', async () => {
    const milk = await item('500', '0.3');
    const l = await line();
    await withTransaction(fx.pool, (t) =>
      reserve(t, { orderLineId: l, requirement: new Map([[milk, d('300')]]) }),
    );
    const countId = await start([milk]);
    await enter(countId, { itemId: milk, countedQty: '100' });
    await call(clerk, 'POST', `/stock-counts/${countId}/submit`, {});
    await call(owner, 'POST', `/stock-counts/${countId}/approve`, {});
    expect(await balance(milk)).toMatchObject({ on_hand: '100.0000', reserved: '300.0000' });
    const { rows } = await fx.pool.query<{ kind: string }>(
      `SELECT kind FROM cl.inventory_alerts WHERE item_id = $1 AND state <> 'resolved' ORDER BY id`,
      [milk],
    );
    expect(rows.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['zero', 'reservation_shortfall']),
    );
    const other = await line();
    await expect(
      withTransaction(fx.pool, (t) =>
        reserve(t, { orderLineId: other, requirement: new Map([[milk, d('1')]]) }),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    // AT-67: the reserved drink is picked up anyway: 200 found first, then consumed.
    await withTransaction(fx.pool, (t) =>
      consume(t, ctx(), {
        orderLineId: l,
        eventKey: randomUUID(),
        takes: [{ itemId: milk, qty: 'rest' }],
      }),
    );
    const { rows: moves } = await fx.pool.query<{
      movement_type: string;
      qty_delta: string;
      flags: string[];
    }>(
      `SELECT movement_type, qty_delta::text, flags FROM cl.stock_movements
        WHERE item_id = $1 ORDER BY stock_movements.id DESC LIMIT 2`,
      [milk],
    );
    expect(moves.reverse()).toEqual([
      { movement_type: 'count_adjustment', qty_delta: '200.0000', flags: ['auto_found_stock'] },
      { movement_type: 'consumption', qty_delta: '-300.0000', flags: [] },
    ]);
    const { rows: found } = await fx.pool.query(
      `SELECT 1 FROM cl.inventory_alerts WHERE item_id = $1 AND kind = 'found_stock' AND state <> 'resolved'`,
      [milk],
    );
    expect(found).toHaveLength(1);
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });
});

describe('counting lots', () => {
  it('counts each lot, and puts stock found in no known lot into a new one', async () => {
    const cream = await item('0', '1', { trackLots: true, trackExpiry: true });
    const receipt = await call(clerk, 'POST', '/purchase-receipts', {
      paidNow: false,
      lines: [
        { itemId: cream, qty: '600', lineCost: '600', expiryDate: '2099-03-01', lotCode: 'K1' },
        { itemId: cream, qty: '400', lineCost: '400', expiryDate: '2099-01-01', lotCode: 'K2' },
      ],
    });
    expect(receipt.status).toBe(201);
    const countId = await start([cream]);
    const lots = ((await view(countId))['items'] as Body[])[0]?.['lots'] as Body[];
    expect(lots.map((l) => [l['lotCode'], l['qtyRemaining']])).toEqual([
      ['K2', null], // blind: no quantities
      ['K1', null],
    ]);
    const k1 = lots.find((l) => l['lotCode'] === 'K1')?.['id'];
    const k2 = lots.find((l) => l['lotCode'] === 'K2')?.['id'];
    await enter(countId, { itemId: cream, lotId: k1, countedQty: '590' });
    await enter(countId, { itemId: cream, lotId: k2, countedQty: '400' });
    await enter(countId, { itemId: cream, countedQty: '50', newLotExpiry: '2099-02-01' });
    await call(clerk, 'POST', `/stock-counts/${countId}/submit`, {});
    await call(owner, 'POST', `/stock-counts/${countId}/approve`, {}); // 50 found: book 0
    const after = (await call(clerk, 'GET', `/inventory/items/${cream}`)).body['lots'] as Body[];
    expect(
      after.map((l) => [l['lotCode'], l['expiryDate'], l['qtyRemaining'], l['origin']]),
    ).toEqual([
      ['K2', '2099-01-01', '400.0000', 'receipt'],
      [null, '2099-02-01', '50.0000', 'count'],
      ['K1', '2099-03-01', '590.0000', 'receipt'],
    ]);
    expect((await balance(cream))?.on_hand).toBe('1040.0000');
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });
});

describe('a count posting racing a pickup of the same item', () => {
  it('keeps both: the pickup is consumed and the variance is added as a delta', async () => {
    await repeatRace(raceRuns(), async () => {
      const milk = await item('1000', '0.3');
      const l = await line();
      await withTransaction(fx.pool, (t) =>
        reserve(t, { orderLineId: l, requirement: new Map([[milk, d('200')]]) }),
      );
      const countId = await start([milk]);
      await enter(countId, { itemId: milk, countedQty: '995' }); // −5, within thresholds
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: async ({ index, pool, barrier }) =>
          withTransaction(pool, async (t) => {
            await barrier.wait();
            if (index === 0) {
              const { submitCount } = await import('../../src/modules/stock/counts.ts');
              return submitCount(
                t,
                { userId: fx.ownerId, permissions: new Set<string>(), audit: audit() },
                countId,
                new Date(),
              );
            }
            return consume(t, ctx(), {
              orderLineId: l,
              eventKey: randomUUID(),
              takes: [{ itemId: milk, qty: 'rest' }],
            });
          }),
      });
      expect(tally(outcomes).failed).toEqual([]);
      expect(await balance(milk)).toMatchObject({ on_hand: '795.0000', reserved: '0.0000' });
    });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });
});
