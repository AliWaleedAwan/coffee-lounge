/**
 * Kitchen tickets, pickup, serve, cancel and void (step 3.5), as the application role.
 * Rounds are sent by staff (R2: accepted at once) unless a test needs a guest round.
 * Print jobs join in step 3.6; comps join with billing in step 3.7.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelUnits, pickUp } from '../../src/modules/orders/lines.ts';
import { scanUncollected } from '../../src/modules/orders/index.ts';
import {
  activateRecipe,
  createInventoryItem,
  createRecipeDraft,
  findStockMismatches,
  postOpeningBalance,
  raiseStaleReservationAlerts,
  setStockMode,
} from '../../src/modules/stock/index.ts';
import { withTransaction, type Tx } from '../../src/platform/db/tx.ts';
import { race, raceRuns, repeatRace, tally } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
const menu = { coffee: '', cake: '', beans: '', milk: '' };
const audit = () => ({
  actor: { kind: 'user' as const, userId: fx.ownerId },
  correlationId: randomUUID(),
});

const url = (path: string) => `/api/staff/v1${path}`;
async function staff(client: Client, method: 'GET' | 'POST', path: string, payload?: object) {
  const res = await client.call({
    method,
    url: url(path),
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Record<string, unknown>>() : {} };
}

let tableNo = 0;
/** A dine-in session (or takeaway) with one staff round; returns its line ids in order. */
async function staffRound(
  lines: { variantId: string; qty: number }[],
  opts: { client?: Client; takeaway?: boolean } = {},
) {
  const client = opts.client ?? owner;
  let sessionId: string;
  let tableId: string | null = null;
  if (opts.takeaway) {
    const { rows } = await fx.pool.query<{ id: string }>(
      `INSERT INTO cl.dining_sessions (session_no, order_type, opened_via, opened_by_user_id, business_date)
       VALUES ($1, 'takeaway', 'staff', $2, current_date) RETURNING id::text`,
      [`S-TK-${randomUUID().slice(0, 8)}`, fx.ownerId],
    );
    sessionId = rows[0]?.id ?? '';
  } else {
    tableNo += 1;
    const t = await staff(owner, 'POST', '/tables', {
      code: `K${String(tableNo)}`,
      name: `Kitchen test ${String(tableNo)}`,
    });
    tableId = String(t.body['id']);
    sessionId = String((await staff(owner, 'POST', `/tables/${tableId}/sessions`, {})).body['id']);
  }
  const round = await staff(client, 'POST', `/sessions/${sessionId}/rounds`, {
    lines: lines.map((l) => ({ ...l, modifierOptionIds: [] })),
  });
  expect(round.status, JSON.stringify(round.body)).toBe(201);
  const { rows } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.order_lines WHERE round_id = $1 ORDER BY line_no',
    [round.body['id']],
  );
  return { sessionId, tableId, roundId: String(round.body['id']), lineIds: rows.map((r) => r.id) };
}

async function line(id: string) {
  const { rows } = await fx.pool.query<{
    qty_picked_up: number;
    qty_served: number;
    qty_cancelled_unprepared: number;
    qty_cancelled_prepared: number;
  }>(
    'SELECT qty_picked_up, qty_served, qty_cancelled_unprepared, qty_cancelled_prepared FROM cl.order_lines WHERE id = $1',
    [id],
  );
  return rows[0];
}

async function stockOf(lineId: string) {
  const { rows } = await fx.pool.query<{
    item_id: string;
    reserved: string;
    consumed: string;
    released: string;
    status: string;
  }>(
    `SELECT item_id::text, qty_reserved::text AS reserved, qty_consumed::text AS consumed, qty_released::text AS released, status
       FROM cl.stock_reservations WHERE order_line_id = $1 ORDER BY item_id`,
    [lineId],
  );
  return rows;
}

async function tickets(roundId: string) {
  const { rows } = await fx.pool.query<{
    id: string;
    kind: string;
    status: string;
    ticket_no: string;
  }>(
    'SELECT id::text, kind, status, ticket_no FROM cl.kitchen_tickets WHERE round_id = $1 ORDER BY id',
    [roundId],
  );
  return rows;
}

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  const cat = await staff(owner, 'POST', '/menu/categories', { name: 'Kitchen tests' });
  const item = async (name: string, price: string) =>
    (
      (
        await staff(owner, 'POST', '/menu/items', {
          categoryId: cat.body['id'],
          name,
          variants: [{ name: 'Regular', price }],
        })
      ).body['variantIds'] as string[]
    )[0] ?? '';
  menu.coffee = await item('Cappuccino', '500');
  menu.cake = await item('Carrot cake', '350');
  await withTransaction(fx.pool, async (tx: Tx) => {
    const ctx = { actorUserId: fx.ownerId, businessDate: '2026-10-22' };
    const ingredient = async (sku: string, qty: string, cost: string) => {
      const { id } = await createInventoryItem(tx, audit(), { sku, name: sku, baseUom: 'ml' });
      await postOpeningBalance(tx, ctx, audit(), {
        itemId: id,
        qty: new Decimal(qty),
        unitCost: new Decimal(cost),
      });
      return id;
    };
    menu.beans = await ingredient('K-BEANS', '100000', '9');
    menu.milk = await ingredient('K-MILK', '100000', '0.26833333');
    const draft = await createRecipeDraft(tx, {
      variantId: menu.coffee,
      components: [
        { itemId: menu.beans, qtyBase: '18' },
        { itemId: menu.milk, qtyBase: '150', wasteFactor: '0.05' },
      ],
    });
    await activateRecipe(tx, audit(), draft.id);
    await setStockMode(tx, audit(), menu.coffee, 'recipe');
  });
});
afterAll(async () => {
  await fx.close();
});

describe('kitchen tickets', () => {
  it('a first round gets a new ticket, the next a supplement, never with prices (AT-02, AT-08, AT-99)', async () => {
    const first = await staffRound([{ variantId: menu.coffee, qty: 2 }]);
    const [ticket] = await tickets(first.roundId);
    expect(ticket).toMatchObject({ kind: 'new', status: 'open' });
    expect(ticket?.ticket_no).toMatch(/^K-\d{4}-\d{3}$/);
    const next = await staff(owner, 'POST', `/sessions/${first.sessionId}/rounds`, {
      lines: [{ variantId: menu.cake, qty: 1, modifierOptionIds: [], notes: 'birthday candle' }],
    });
    expect((await tickets(String(next.body['id'])))[0]?.kind).toBe('supplement');

    const view = await staff(owner, 'GET', `/tickets/${ticket?.id ?? ''}`);
    expect(view.body).toMatchObject({
      kind: 'new',
      lines: [{ qty: 2, item: 'Cappuccino', variant: 'Regular' }],
    });
    const keys =
      JSON.stringify(view.body)
        .match(/"([A-Za-z]+)":/g)
        ?.map((k) => k.slice(1, -2).toLowerCase()) ?? [];
    for (const forbidden of [
      'price',
      'total',
      'amount',
      'pay',
      'discount',
      'phone',
      'email',
      'address',
      'customer',
    ]) {
      expect(
        keys.filter((k) => k.includes(forbidden)),
        forbidden,
      ).toEqual([]);
    }
    expect(JSON.stringify(view.body)).not.toMatch(/500|350/); // no price values either
  });

  it('refuses a kitchen template with a place for prices or guest details (AT-99)', async () => {
    await expect(
      fx.pool.query(
        `INSERT INTO cl.ticket_templates (kind, name, definition) VALUES ('kitchen', 'Bad', '{"blocks":["lines","linePrice"]}')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      fx.pool.query(
        `INSERT INTO cl.ticket_templates (kind, name, definition) VALUES ('kitchen', 'Bad', '{"blocks":["customerPhone"]}')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('pickup (L1)', () => {
  it('picking up 1 of 2 consumes exactly one unit at a frozen cost; the rest closes everything (AT-05)', async () => {
    const r = await staffRound([{ variantId: menu.coffee, qty: 2 }]);
    const lineId = r.lineIds[0] ?? '';
    const one = await staff(owner, 'POST', `/lines/${lineId}/pickup`, { qty: 1 });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ lines: [{ orderLineId: lineId, pickedUp: 1, open: 1 }] });
    expect(await line(lineId)).toMatchObject({ qty_picked_up: 1, qty_served: 1 }); // dine-in: picked up = served
    expect(await stockOf(lineId)).toEqual([
      {
        item_id: menu.beans,
        reserved: '36.0000',
        consumed: '18.0000',
        released: '0.0000',
        status: 'active',
      },
      {
        item_id: menu.milk,
        reserved: '315.0000',
        consumed: '157.5000',
        released: '0.0000',
        status: 'active',
      },
    ]);
    const { rows: costs } = await fx.pool.query<{
      item_id: string;
      qty_base: string;
      value: string;
    }>(
      'SELECT item_id::text, qty_base::text, value::text FROM cl.order_line_costs WHERE order_line_id = $1 ORDER BY item_id',
      [lineId],
    );
    expect(costs).toEqual([
      { item_id: menu.beans, qty_base: '18.0000', value: '162.0000' },
      { item_id: menu.milk, qty_base: '157.5000', value: '42.2625' },
    ]);
    expect((await tickets(r.roundId))[0]?.status).toBe('open');

    expect((await staff(owner, 'POST', `/lines/${lineId}/pickup`, { qty: 2 })).body).toMatchObject({
      code: 'QTY_EXCEEDS_REMAINING',
    });
    await staff(owner, 'POST', `/lines/${lineId}/pickup`, { qty: 1 });
    expect((await stockOf(lineId)).map((s) => s.status)).toEqual(['closed', 'closed']);
    expect((await tickets(r.roundId))[0]?.status).toBe('completed');
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('picks up a whole ticket at once; takeaway pickup does not mark it served (L2 stays separate)', async () => {
    const r = await staffRound(
      [
        { variantId: menu.coffee, qty: 1 },
        { variantId: menu.cake, qty: 2 },
      ],
      { takeaway: true },
    );
    const ticketId = (await tickets(r.roundId))[0]?.id ?? '';
    const queue = async () =>
      (
        (await staff(owner, 'GET', '/pickup')).body['tickets'] as { id: string; where: string }[]
      ).find((t) => t.id === ticketId);
    expect((await queue())?.where).toMatch(/^Takeaway S-TK-/);
    expect((await staff(owner, 'POST', `/tickets/${ticketId}/pickup`, {})).status).toBe(200);
    expect(await queue()).toBeUndefined();
    expect(await line(r.lineIds[1] ?? '')).toMatchObject({ qty_picked_up: 2, qty_served: 0 });
    expect(
      (await staff(owner, 'POST', `/lines/${r.lineIds[1] ?? ''}/serve`, { qty: 2 })).status,
    ).toBe(200);
    expect(
      (await staff(owner, 'POST', `/lines/${r.lineIds[1] ?? ''}/serve`, { qty: 1 })).body,
    ).toMatchObject({ code: 'QTY_EXCEEDS_REMAINING' });
  });
});

describe('cancel (L3 / L4) and void (L5)', () => {
  it('pick up 2 of 3 and cancel 1: two consumed, one released, nothing left over (AT-27)', async () => {
    const r = await staffRound([{ variantId: menu.coffee, qty: 3 }]);
    const lineId = r.lineIds[0] ?? '';
    await staff(owner, 'POST', `/lines/${lineId}/pickup`, { qty: 2 });
    const cancel = await staff(owner, 'POST', `/lines/${lineId}/cancel`, {
      qty: 1,
      made: false,
      reason: 'Guest changed mind',
    });
    expect(cancel.status).toBe(200);
    expect(await line(lineId)).toMatchObject({ qty_picked_up: 2, qty_cancelled_unprepared: 1 });
    expect(await stockOf(lineId)).toEqual([
      {
        item_id: menu.beans,
        reserved: '54.0000',
        consumed: '36.0000',
        released: '18.0000',
        status: 'closed',
      },
      {
        item_id: menu.milk,
        reserved: '472.5000',
        consumed: '315.0000',
        released: '157.5000',
        status: 'closed',
      },
    ]);
    const detail = await staff(owner, 'GET', `/sessions/${r.sessionId}`);
    expect(detail.body['acceptedTotal']).toBe('1000.00'); // the cancelled unit is not billed
    const kinds = (await tickets(r.roundId)).map((t) => [t.kind, t.status]);
    expect(kinds).toEqual([
      ['new', 'completed'],
      ['correction', 'completed'],
    ]);
  });

  it('cancelling a whole round before pickup, not made: stock released, a void ticket, no consumption (AT-06)', async () => {
    const r = await staffRound([{ variantId: menu.coffee, qty: 1 }]);
    const lineId = r.lineIds[0] ?? '';
    await staff(owner, 'POST', `/lines/${lineId}/cancel`, {
      qty: 1,
      made: false,
      reason: 'Wrong table',
    });
    expect((await stockOf(lineId)).map((s) => [s.consumed, s.released, s.status])).toEqual([
      ['0.0000', '18.0000', 'closed'],
      ['0.0000', '157.5000', 'closed'],
    ]);
    const { rows } = await fx.pool.query(
      'SELECT count(*)::int AS n FROM cl.order_line_costs WHERE order_line_id = $1',
      [lineId],
    );
    expect(rows[0]).toEqual({ n: 0 });
    expect((await tickets(r.roundId)).map((t) => [t.kind, t.status])).toEqual([
      ['new', 'cancelled'],
      ['void', 'completed'],
    ]);
  });

  it('"already made": consumed and written off as waste at its cost (AT-62)', async () => {
    const r = await staffRound([{ variantId: menu.coffee, qty: 1 }]);
    const lineId = r.lineIds[0] ?? '';
    const res = await staff(owner, 'POST', `/lines/${lineId}/cancel`, {
      qty: 1,
      made: true,
      reason: 'Guest left before it came',
    });
    expect(res.status).toBe(200);
    expect(await line(lineId)).toMatchObject({ qty_picked_up: 1, qty_cancelled_prepared: 1 });
    expect((await stockOf(lineId)).map((s) => s.status)).toEqual(['closed', 'closed']);
    const { rows } = await fx.pool.query<{ kind: string; qty: string; cost_value: string }>(
      'SELECT kind, qty::text, cost_value::text FROM cl.wastage_records WHERE order_line_id = $1',
      [lineId],
    );
    expect(rows).toEqual([
      { kind: 'prepared_item', qty: '1.0000', cost_value: res.body['wasteValue'] },
    ]);
    expect(Number(res.body['wasteValue'])).toBeGreaterThan(0);
  });

  it('voids a spilled coffee at the line cost with no stock back; a waiter needs a manager (AT-07)', async () => {
    await fx.addUser('mgr-k', ['manager'], { pin: '4826' });
    const waiterId = await fx.addUser('wtr-k', ['waiter']);
    const waiter = await fx.loggedIn('wtr-k');
    const r = await staffRound([{ variantId: menu.coffee, qty: 2 }], { client: waiter });
    await owner.call({
      method: 'PUT',
      url: url(`/tables/${r.tableId ?? ''}/assignment`),
      payload: { userId: waiterId },
    });
    const lineId = r.lineIds[0] ?? '';
    await staff(waiter, 'POST', `/lines/${lineId}/pickup`, { qty: 2 });
    const before = await fx.pool.query(
      'SELECT on_hand::text, inventory_value::text FROM cl.inventory_balances WHERE item_id = $1',
      [menu.milk],
    );

    const refused = await staff(waiter, 'POST', `/lines/${lineId}/void`, {
      qty: 1,
      reasonCode: 'spilled',
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const approval = await staff(waiter, 'POST', '/auth/step-up', {
      action: 'line.void_prepared',
      entityType: 'order_line',
      entityId: lineId,
      approverUsername: 'mgr-k',
      approverPin: '4826',
      reason: 'Spilled at the table',
    });
    expect(approval.status).toBe(201);
    const voided = await staff(waiter, 'POST', `/lines/${lineId}/void`, {
      qty: 1,
      reasonCode: 'spilled',
      stepUpId: approval.body['stepUpId'],
    });
    expect(voided.status).toBe(200);
    const { rows: costs } = await fx.pool.query<{ total: string }>(
      'SELECT sum(value)::text AS total FROM cl.order_line_costs WHERE order_line_id = $1',
      [lineId],
    );
    expect(voided.body['wasteValue']).toBe(
      new Decimal(costs[0]?.total ?? 0).dividedBy(2).toDecimalPlaces(4).toFixed(4),
    );
    const after = await fx.pool.query(
      'SELECT on_hand::text, inventory_value::text FROM cl.inventory_balances WHERE item_id = $1',
      [menu.milk],
    );
    expect(after.rows).toEqual(before.rows); // no stock credit
    expect(await line(lineId)).toMatchObject({ qty_picked_up: 2, qty_cancelled_prepared: 1 });
    // The same approval cannot be used twice.
    expect(
      (
        await staff(waiter, 'POST', `/lines/${lineId}/void`, {
          qty: 1,
          reasonCode: 'spilled',
          stepUpId: approval.body['stepUpId'],
        })
      ).body,
    ).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('pickup and cancel of the same last unit: each unit changes once (CT-05)', async () => {
    const auth = {
      user: {
        id: fx.ownerId,
        displayName: 'Owner',
        username: 'owner',
        isOwner: true,
        mustChangePassword: false,
      },
      device: {
        id: '1',
        name: 'test',
        kind: 'reception' as const,
        ownership: 'shop' as const,
        status: 'active' as const,
      },
      permissions: new Map([
        ['orders.void', { scopes: 'all' as const, sources: ['test'] }],
        ['orders.void_prepared', { scopes: 'all' as const, sources: ['test'] }],
      ]),
    };
    await repeatRace(raceRuns(), async () => {
      const r = await staffRound([{ variantId: menu.coffee, qty: 1 }]);
      const lineId = r.lineIds[0] ?? '';
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: ({ index, pool, barrier }) =>
          withTransaction(pool, async (tx) => {
            await barrier.wait();
            const ctx = { key: randomUUID(), correlationId: randomUUID(), now: new Date() };
            return index === 0
              ? pickUp(tx, ctx, auth, [{ lineId, qty: 1 }])
              : cancelUnits(tx, ctx, auth, { lineId, qty: 1, made: false, reason: 'Race' });
          }),
      });
      const { ok, failed } = tally(outcomes);
      expect(ok).toHaveLength(1);
      expect(failed).toEqual(['QTY_EXCEEDS_REMAINING']);
      const l = await line(lineId);
      expect((l?.qty_picked_up ?? 0) + (l?.qty_cancelled_unprepared ?? 0)).toBe(1);
    });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });
});

describe('alerts (AT-88)', () => {
  it('raises an uncollected alert after 30 minutes and a stale reservation after 12 hours; pickup resolves them', async () => {
    const r = await staffRound([{ variantId: menu.coffee, qty: 1 }]);
    const lineId = r.lineIds[0] ?? '';
    expect(await scanUncollected(fx.pool, new Date(Date.now() + 10 * 60_000))).toBe(0);
    expect(
      await scanUncollected(fx.pool, new Date(Date.now() + 31 * 60_000)),
    ).toBeGreaterThanOrEqual(1);
    const open = async () =>
      (
        await fx.pool.query<{ state: string }>(
          `SELECT state FROM cl.operational_alerts WHERE kind = 'uncollected_item' AND entity_id = $1`,
          [lineId],
        )
      ).rows;
    expect(await open()).toEqual([{ state: 'open' }]);
    expect(
      await withTransaction(fx.pool, (tx) =>
        raiseStaleReservationAlerts(tx, new Date(Date.now() + 13 * 3600_000)),
      ),
    ).toBeGreaterThanOrEqual(2);
    const stale = await fx.pool.query(
      `SELECT item_id::text FROM cl.inventory_alerts WHERE kind = 'stale_reservation' AND state = 'open' ORDER BY item_id`,
    );
    expect(stale.rows.map((x: { item_id: string }) => x.item_id)).toEqual(
      expect.arrayContaining([menu.beans, menu.milk]),
    );

    await staff(owner, 'POST', `/lines/${lineId}/pickup`, { qty: 1 });
    expect(await open()).toEqual([{ state: 'resolved' }]);
    const floor = await staff(owner, 'GET', '/floor');
    const t = (
      floor.body['tables'] as {
        id: string;
        session: { notPickedUp: number; pendingRounds: number } | null;
      }[]
    ).find((x) => x.id === r.tableId);
    expect(t?.session).toMatchObject({ notPickedUp: 0, pendingRounds: 0 });
  });
});
