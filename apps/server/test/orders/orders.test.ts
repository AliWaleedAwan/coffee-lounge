/**
 * Rounds and acceptance (step 3.4), as the application role: guest rounds through the
 * customer listener, staff rounds and decisions through the staff listener. Kitchen
 * tickets and print jobs join acceptance in steps 3.5–3.6, so AT-02/AT-03/AT-08 are
 * checked here for rounds, prices and reservations only.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptRound, escalateOverdue } from '../../src/modules/orders/index.ts';
import {
  activateRecipe,
  createInventoryItem,
  createRecipeDraft,
  findStockMismatches,
  postOpeningBalance,
  setStockMode,
} from '../../src/modules/stock/index.ts';
import { withTransaction, type Tx } from '../../src/platform/db/tx.ts';
import { race, raceRuns, repeatRace, tally } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

const T0 = new Date('2026-10-21T13:00:00+05:00');
let clock = T0;
let fx: IdentityFixture;
let owner: Client;
const audit = () => ({
  actor: { kind: 'user' as const, userId: fx.ownerId },
  correlationId: randomUUID(),
});
const ctx = () => ({ actorUserId: fx.ownerId, businessDate: '2026-10-21' });

const menu = {
  flatWhite: '',
  cake: '',
  saffron: '',
  flatWhiteItem: '',
  oatOption: '',
  beans: '',
  milk: '',
  saffronStock: '',
};

const url = (path: string) => `/api/staff/v1${path}`;
async function staff(
  client: Client,
  method: 'GET' | 'POST',
  path: string,
  payload?: object,
  key: string | null = randomUUID(),
) {
  const res = await client.call({
    method,
    url: url(path),
    ...(payload ? { payload } : {}),
    ...(method === 'POST' && key ? { headers: { 'idempotency-key': key } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Record<string, unknown>>() : {}, res };
}

/** A guest phone on the customer listener. */
class Phone {
  cookies: Record<string, string> = {};
  private async send(
    method: 'GET' | 'POST',
    path: string,
    payload?: object,
    key?: string,
  ): Promise<LightMyRequestResponse> {
    const res = await fx.customer.inject({
      method,
      url: `/api/customer/v1${path}`,
      cookies: this.cookies,
      ...(payload ? { payload } : {}),
      ...(key ? { headers: { 'idempotency-key': key } } : {}),
    });
    for (const c of res.cookies) {
      if (c.value === '' || c.maxAge === 0) Reflect.deleteProperty(this.cookies, c.name);
      else this.cookies[c.name] = c.value;
    }
    return res;
  }
  scan(token: string) {
    return this.send('GET', `/entry/${token}`);
  }
  order(lines: object[], key = randomUUID()) {
    return this.send('POST', '/rounds', { lines }, key);
  }
  withdraw(roundId: string) {
    return this.send('POST', `/rounds/${roundId}/withdraw`, {}, randomUUID());
  }
  session() {
    return this.send('GET', '/session');
  }
}

let tableNo = 0;
async function newTable(): Promise<{ id: string; token: string }> {
  tableNo += 1;
  const t = await staff(
    owner,
    'POST',
    '/tables',
    { code: `O${String(tableNo)}`, name: `Table ${String(tableNo)}` },
    null,
  );
  const id = String(t.body['id']);
  const qr = await staff(
    owner,
    'POST',
    '/qr-entry-points/generate',
    { tableIds: [id], counter: false },
    null,
  );
  return { id, token: (qr.body['items'] as { token: string }[])[0]?.token ?? '' };
}

async function seatedPhone(): Promise<{ table: { id: string; token: string }; phone: Phone }> {
  const table = await newTable();
  const phone = new Phone();
  await phone.scan(table.token);
  return { table, phone };
}

const line = (variantId: string, qty = 1, extra: object = {}) => ({
  variantId,
  qty,
  modifierOptionIds: [],
  ...extra,
});

async function guestRound(
  phone: Phone,
  lines: object[],
): Promise<{ id: string; roundRef: string }> {
  const res = await phone.order(lines);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ round: { id: string; roundRef: string } }>().round;
}

async function reservations(variantLineRound: string) {
  const { rows } = await fx.pool.query<{ item_id: string; qty_reserved: string }>(
    `SELECT r.item_id::text, r.qty_reserved::text FROM cl.stock_reservations r
       JOIN cl.order_lines l ON l.id = r.order_line_id WHERE l.round_id = $1 ORDER BY r.item_id`,
    [variantLineRound],
  );
  return rows;
}

async function balanceOf(itemId: string) {
  const { rows } = await fx.pool.query<{ on_hand: string; reserved: string }>(
    'SELECT on_hand::text, reserved::text FROM cl.inventory_balances WHERE item_id = $1',
    [itemId],
  );
  return rows[0];
}

const ownerAuth = () => ({
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
  permissions: new Map([['orders.accept', { scopes: 'all' as const, sources: ['test'] }]]),
});

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app', now: () => clock });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  const cat = await staff(owner, 'POST', '/menu/categories', { name: 'Drinks' }, null);
  const categoryId = String(cat.body['id']);
  const group = await staff(
    owner,
    'POST',
    '/modifier-groups',
    { name: 'Milk', minSelect: 0, maxSelect: 1, options: [{ name: 'Oat', priceDelta: '80' }] },
    null,
  );
  menu.oatOption = (group.body['optionIds'] as string[])[0] ?? '';
  const fw = await staff(
    owner,
    'POST',
    '/menu/items',
    {
      categoryId,
      name: 'Flat white',
      modifierGroupIds: [String(group.body['id'])],
      variants: [{ name: 'Regular', price: '450' }],
    },
    null,
  );
  menu.flatWhiteItem = String(fw.body['id']);
  menu.flatWhite = (fw.body['variantIds'] as string[])[0] ?? '';
  const cake = await staff(
    owner,
    'POST',
    '/menu/items',
    { categoryId, name: 'Cake', variants: [{ name: 'Slice', price: '300' }] },
    null,
  );
  menu.cake = (cake.body['variantIds'] as string[])[0] ?? '';
  const saffron = await staff(
    owner,
    'POST',
    '/menu/items',
    { categoryId, name: 'Saffron milk', variants: [{ name: 'Cup', price: '600' }] },
    null,
  );
  menu.saffron = (saffron.body['variantIds'] as string[])[0] ?? '';

  await withTransaction(fx.pool, async (tx: Tx) => {
    const item = async (sku: string, qty: string, cost: string) => {
      const { id } = await createInventoryItem(tx, audit(), { sku, name: sku, baseUom: 'g' });
      await postOpeningBalance(tx, ctx(), audit(), {
        itemId: id,
        qty: new Decimal(qty),
        unitCost: new Decimal(cost),
      });
      return id;
    };
    menu.beans = await item('BEANS', '100000', '9');
    menu.milk = await item('MILK', '100000', '0.3');
    menu.saffronStock = await item('SAFFRON', '0', '50');
    const recipe = async (variantId: string, components: { itemId: string; qtyBase: string }[]) => {
      const draft = await createRecipeDraft(tx, { variantId, components });
      await activateRecipe(tx, audit(), draft.id);
      await setStockMode(tx, audit(), variantId, 'recipe');
    };
    await recipe(menu.flatWhite, [
      { itemId: menu.beans, qtyBase: '18' },
      { itemId: menu.milk, qtyBase: '120' },
    ]);
    await recipe(menu.saffron, [{ itemId: menu.saffronStock, qtyBase: '1' }]);
  });
});
afterAll(async () => {
  await fx.close();
});

describe('guest rounds (R1)', () => {
  it('a first order opens the table session and waits for approval: no stock is touched (AT-01, AT-74)', async () => {
    const { table, phone } = await seatedPhone();
    const before = await balanceOf(menu.beans);
    const round = await guestRound(phone, [line(menu.flatWhite, 2)]);
    expect(round.roundRef).toMatch(/^R-\d{4}-\d{3}$/);
    expect(phone.cookies['cl_guest']).toBeDefined();
    const s = (await phone.session()).json<{
      rounds: { status: string; mine: boolean; quotedTotal: string }[];
    }>();
    expect(s.rounds).toMatchObject([
      { status: 'pending_approval', mine: true, quotedTotal: '900.00' },
    ]);
    expect(await reservations(round.id)).toEqual([]);
    expect(await balanceOf(menu.beans)).toEqual(before);
    const floor = await staff(owner, 'GET', '/floor');
    expect(
      (floor.body['tables'] as { id: string; state: string }[]).find((t) => t.id === table.id)
        ?.state,
    ).toBe('occupied');
  });

  it('a double tap or a retry after a network drop makes one round (AT-24)', async () => {
    const { phone } = await seatedPhone();
    await guestRound(phone, [line(menu.cake)]);
    const key = randomUUID();
    const first = await phone.order([line(menu.cake, 2)], key);
    const again = await phone.order([line(menu.cake, 2)], key);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const s = (await phone.session()).json<{ rounds: unknown[] }>();
    expect(s.rounds).toHaveLength(2);
  });

  it('two phones at one table send two rounds into one session (AT-09)', async () => {
    const { table, phone } = await seatedPhone();
    const other = new Phone();
    await other.scan(table.token);
    const a = await guestRound(phone, [line(menu.cake)]);
    await other.scan(table.token); // joins the session the first order opened
    const b = await guestRound(other, [line(menu.flatWhite)]);
    const view = (await other.session()).json<{ rounds: { id: string; mine: boolean }[] }>();
    expect(view.rounds.map((r) => [r.id, r.mine])).toEqual([
      [a.id, false],
      [b.id, true],
    ]);
  });

  it('takes the session only from cookies: ids in the request are refused (AT-127)', async () => {
    const { phone } = await seatedPhone();
    const bad = await phone.order([{ ...line(menu.cake), tableId: '1' }]);
    expect(bad.statusCode).toBe(400);
    const res = await fx.customer.inject({
      method: 'POST',
      url: '/api/customer/v1/rounds',
      cookies: phone.cookies,
      headers: { 'idempotency-key': randomUUID() },
      payload: { lines: [line(menu.cake)], sessionId: '1' },
    });
    expect(res.statusCode).toBe(400);
    const stranger = new Phone();
    expect((await stranger.order([line(menu.cake)])).json()).toMatchObject({ code: 'VISIT_ENDED' });
  });

  it('refuses notes over 120 characters and strips control characters (AT-124)', async () => {
    const { phone } = await seatedPhone();
    expect((await phone.order([line(menu.cake, 1, { notes: 'x'.repeat(121) })])).statusCode).toBe(
      400,
    );
    await guestRound(phone, [line(menu.cake, 1, { notes: 'no\u0007 sugar\n\tplease\u001b[2J' })]);
    const s = (await phone.session()).json<{ rounds: { lines: { notes: string }[] }[] }>();
    expect(s.rounds[0]?.lines[0]?.notes).toBe('no sugar please [2J');
  });

  it('allows at most 3 waiting rounds per session (AT-125)', async () => {
    const { phone } = await seatedPhone();
    for (let i = 0; i < 3; i++) await guestRound(phone, [line(menu.cake)]);
    const fourth = await phone.order([line(menu.cake)]);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('checks choices and prices server-side, and tells the guest when prices moved', async () => {
    const { phone } = await seatedPhone();
    const twoMilks = await phone.order([
      line(menu.flatWhite, 1, { modifierOptionIds: [menu.oatOption, menu.oatOption] }),
    ]);
    expect(twoMilks.statusCode).toBe(400);
    expect(twoMilks.json<{ detail: string }>().detail).toMatch(/same choice|at most 1/);
    const drift = await phone.order([
      line(menu.flatWhite, 1, { modifierOptionIds: [menu.oatOption], quotedUnitPrice: '450' }),
    ]);
    expect(drift.json()).toMatchObject({
      code: 'STALE_STATE',
      lines: [{ lineNo: 1, unitPrice: '530.00' }],
    });
    const ok = await phone.order([
      line(menu.flatWhite, 1, { modifierOptionIds: [menu.oatOption], quotedUnitPrice: '530.00' }),
    ]);
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ round: { quotedTotal: string } }>().round.quotedTotal).toBe('530.00');
  });

  it('lets a guest withdraw only their own waiting round', async () => {
    const { table, phone } = await seatedPhone();
    const round = await guestRound(phone, [line(menu.cake)]);
    const other = new Phone();
    await other.scan(table.token);
    expect((await other.withdraw(round.id)).statusCode).toBe(404);
    expect((await phone.withdraw(round.id)).statusCode).toBe(200);
    const again = await phone.withdraw(round.id);
    expect(again.json()).toMatchObject({ code: 'ROUND_ALREADY_DECIDED' });
    expect(again.json()).not.toHaveProperty('decidedBy');
  });
});

describe('acceptance (R3)', () => {
  it('reserves recipe × qty and freezes prices and the recipe; a retry acts once (AT-02, AT-03)', async () => {
    const { phone } = await seatedPhone();
    const round = await guestRound(phone, [
      line(menu.flatWhite, 2, { modifierOptionIds: [menu.oatOption] }),
      line(menu.cake),
    ]);
    const key = randomUUID();
    const first = await staff(owner, 'POST', `/rounds/${round.id}/accept`, {}, key);
    expect(first.status).toBe(200);
    const replay = await staff(owner, 'POST', `/rounds/${round.id}/accept`, {}, key);
    expect(replay.res.headers['idempotent-replayed']).toBe('true');
    const second = await staff(owner, 'POST', `/rounds/${round.id}/accept`, {});
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'ROUND_ALREADY_DECIDED', decidedBy: 'Owner' });

    expect(await reservations(round.id)).toEqual([
      { item_id: menu.beans, qty_reserved: '36.0000' },
      { item_id: menu.milk, qty_reserved: '240.0000' },
    ]);
    const { rows } = await fx.pool.query(
      `SELECT l.line_no, l.unit_price::text, l.line_gross::text, l.stock_mode_snap, (l.recipe_version_id IS NOT NULL) AS has_recipe,
              (SELECT count(*)::int FROM cl.order_line_components c WHERE c.line_id = l.id) AS components
         FROM cl.order_lines l WHERE l.round_id = $1 ORDER BY l.line_no`,
      [round.id],
    );
    expect(rows).toEqual([
      {
        line_no: 1,
        unit_price: '450.00',
        line_gross: '1060.00',
        stock_mode_snap: 'recipe',
        has_recipe: true,
        components: 2,
      },
      {
        line_no: 2,
        unit_price: '300.00',
        line_gross: '300.00',
        stock_mode_snap: 'untracked',
        has_recipe: false,
        components: 0,
      },
    ]);
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('lets exactly one decision win; waiters outside their tables and cashiers on assigned tables get 403 (AT-48, CT-01)', async () => {
    const sara = await fx.addUser('sara-acc', ['waiter']);
    await fx.addUser('omar-acc', ['waiter']);
    await fx.addUser('ali-acc', ['cashier']);
    await fx.addUser('mona-acc', ['manager']);
    const clients = {
      assigned: await fx.loggedIn('sara-acc'),
      other: await fx.loggedIn('omar-acc'),
      cashier: await fx.loggedIn('ali-acc'),
      manager: await fx.loggedIn('mona-acc'),
    };
    for (let run = 0; run < 3; run++) {
      const { table, phone } = await seatedPhone();
      expect(
        (
          await owner.call({
            method: 'PUT',
            url: url(`/tables/${table.id}/assignment`),
            payload: { userId: sara },
          })
        ).statusCode,
      ).toBe(204);
      const round = await guestRound(phone, [line(menu.cake)]);
      const results = await Promise.all(
        Object.entries(clients).map(
          async ([who, c]) =>
            [who, (await staff(c, 'POST', `/rounds/${round.id}/accept`, {})).body] as const,
        ),
      );
      const by = Object.fromEntries(results);
      expect(by['other']).toMatchObject({ code: 'NOT_IN_ACCEPTANCE_SCOPE' });
      expect(by['cashier']).toMatchObject({ code: 'NOT_IN_ACCEPTANCE_SCOPE' });
      const winners = [by['assigned'], by['manager']].filter((b) => b?.['status'] === 'accepted');
      expect(winners).toHaveLength(1);
      expect(
        [by['assigned'], by['manager']].filter((b) => b?.['code'] === 'ROUND_ALREADY_DECIDED'),
      ).toHaveLength(1);
    }
  });

  it('checks the waiter assigned at commit time when the table is reassigned mid-accept (AT-49)', async () => {
    const amy = await fx.addUser('amy-acc', ['waiter']);
    const ben = await fx.addUser('ben-acc', ['waiter']);
    const { table, phone } = await seatedPhone();
    await owner.call({
      method: 'PUT',
      url: url(`/tables/${table.id}/assignment`),
      payload: { userId: amy },
    });
    const round = await guestRound(phone, [line(menu.cake)]);
    const amyClient = await fx.loggedIn('amy-acc');

    // A manager's reassignment holds the table lock while Amy presses Accept.
    const admin = new pg.Client({ connectionString: urlFor(fx.db.name) });
    await admin.connect();
    try {
      await admin.query('BEGIN');
      await admin.query('SELECT 1 FROM cl.dining_tables WHERE id = $1 FOR UPDATE', [table.id]);
      await admin.query(
        `UPDATE cl.table_assignments SET ended_at = now(), ended_by = $2 WHERE table_id = $1 AND ended_at IS NULL`,
        [table.id, fx.ownerId],
      );
      await admin.query(
        'INSERT INTO cl.table_assignments (table_id, user_id, assigned_by) VALUES ($1, $2, $3)',
        [table.id, ben, fx.ownerId],
      );
      const pending = staff(amyClient, 'POST', `/rounds/${round.id}/accept`, {});
      for (let i = 0; i < 200; i++) {
        const { rows } = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`,
        );
        if ((rows[0]?.n ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await admin.query('COMMIT');
      expect((await pending).body).toMatchObject({
        code: 'NOT_IN_ACCEPTANCE_SCOPE',
        assignedTo: ben,
      });
    } finally {
      await admin.end();
    }
  });

  it('two rounds racing for the last stock: one is accepted, available never goes below zero (AT-04, CT-02)', async () => {
    await repeatRace(raceRuns(), async () => {
      await withTransaction(fx.pool, async (tx) => {
        // Exactly one cup of saffron milk can be made.
        const { rows } = await tx.query<{ on_hand: string; reserved: string }>(
          'SELECT on_hand::text, reserved::text FROM cl.inventory_balances WHERE item_id = $1',
          [menu.saffronStock],
        );
        const free = new Decimal(rows[0]?.on_hand ?? 0).minus(rows[0]?.reserved ?? 0);
        if (free.lessThan(1)) {
          await tx.query(
            `INSERT INTO cl.stock_movements (item_id, movement_type, qty_delta, unit_cost, value_delta, source_type, source_id, source_key, business_date)
             VALUES ($1, 'count_adjustment', $2, 50, $3, 'test', 0, $4, '2026-10-21')`,
            [
              menu.saffronStock,
              new Decimal(1).minus(free).toFixed(4),
              new Decimal(1).minus(free).times(50).toFixed(4),
              `test:${randomUUID()}`,
            ],
          );
          await tx.query(
            'UPDATE cl.inventory_balances SET on_hand = on_hand + $2, inventory_value = inventory_value + $3 WHERE item_id = $1',
            [
              menu.saffronStock,
              new Decimal(1).minus(free).toFixed(4),
              new Decimal(1).minus(free).times(50).toFixed(4),
            ],
          );
        }
      });
      const a = await guestRound((await seatedPhone()).phone, [line(menu.saffron)]);
      const b = await guestRound((await seatedPhone()).phone, [line(menu.saffron)]);
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: ({ index, pool, barrier }) =>
          withTransaction(pool, async (tx) => {
            await barrier.wait();
            return acceptRound(
              tx,
              { key: randomUUID(), correlationId: randomUUID(), now: clock },
              ownerAuth(),
              index === 0 ? a.id : b.id,
            );
          }),
      });
      const { ok, failed } = tally(outcomes);
      expect(ok).toHaveLength(1);
      expect(failed).toEqual(['INSUFFICIENT_STOCK']);
      const bal = await balanceOf(menu.saffronStock);
      expect(new Decimal(bal?.on_hand ?? 0).minus(bal?.reserved ?? 0).toFixed(4)).toBe('0.0000');
    });
    expect(await findStockMismatches(fx.pool)).toEqual([]);
  });

  it('honours a price that rose within 30 minutes, and refuses after (AT-25, AT-78)', async () => {
    const { phone } = await seatedPhone();
    const early = await guestRound(phone, [line(menu.cake, 2)]);
    const late = await guestRound(phone, [line(menu.cake)]);
    const v = await staff(owner, 'GET', '/menu/catalog');
    const version = (
      v.body['categories'] as { items: { variants: { id: string; version: number }[] }[] }[]
    )
      .flatMap((c) => c.items.flatMap((i) => i.variants))
      .find((x) => x.id === menu.cake)?.version;
    expect(
      (
        await staff(
          owner,
          'POST',
          `/menu/variants/${menu.cake}/price`,
          { expectedVersion: version, price: '350', reason: 'Butter price' },
          null,
        )
      ).status,
    ).toBe(200);

    clock = new Date(T0.getTime() + 20 * 60_000);
    try {
      expect((await staff(owner, 'POST', `/rounds/${early.id}/accept`, {})).status).toBe(200);
      const { rows } = await fx.pool.query(
        'SELECT catalog_unit_price::text, unit_price::text, price_locked, line_gross::text FROM cl.order_lines WHERE round_id = $1',
        [early.id],
      );
      expect(rows).toEqual([
        {
          catalog_unit_price: '350.00',
          unit_price: '300.00',
          price_locked: true,
          line_gross: '600.00',
        },
      ]);

      clock = new Date(T0.getTime() + 31 * 60_000);
      const expired = await staff(owner, 'POST', `/rounds/${late.id}/accept`, {});
      expect(expired.status).toBe(422);
      expect(expired.body).toMatchObject({ code: 'PRICE_CHANGED_LOCK_EXPIRED' });
      expect(
        (
          await staff(owner, 'POST', `/rounds/${late.id}/reject`, {
            reason: 'Price changed, please order again',
          })
        ).status,
      ).toBe(200);
      const view = (await phone.session()).json<{
        rounds: { id: string; status: string; reason: string | null }[];
      }>();
      expect(view.rounds.find((r) => r.id === late.id)).toMatchObject({
        status: 'rejected',
        reason: 'Price changed, please order again',
      });
    } finally {
      clock = T0;
      await staff(
        owner,
        'POST',
        `/menu/variants/${menu.cake}/price`,
        { expectedVersion: (version ?? 0) + 1, price: '300', reason: 'Back' },
        null,
      );
    }
  });

  it('keeps the price-lock rules when a price edit races a pending acceptance (CT-07)', async () => {
    const { phone } = await seatedPhone();
    const round = await guestRound(phone, [line(menu.flatWhite)]);
    const cat = await staff(owner, 'GET', '/menu/catalog');
    const version = (
      cat.body['categories'] as { items: { variants: { id: string; version: number }[] }[] }[]
    )
      .flatMap((c) => c.items.flatMap((i) => i.variants))
      .find((x) => x.id === menu.flatWhite)?.version;
    const [accept] = await Promise.all([
      staff(owner, 'POST', `/rounds/${round.id}/accept`, {}),
      staff(
        owner,
        'POST',
        `/menu/variants/${menu.flatWhite}/price`,
        { expectedVersion: version, price: '500', reason: 'Race' },
        null,
      ),
    ]);
    expect(accept.status).toBe(200);
    const { rows } = await fx.pool.query<{ unit_price: string }>(
      'SELECT unit_price::text FROM cl.order_lines WHERE round_id = $1',
      [round.id],
    );
    expect(rows[0]?.unit_price).toBe('450.00'); // never more than quoted
    await staff(
      owner,
      'POST',
      `/menu/variants/${menu.flatWhite}/price`,
      { expectedVersion: (version ?? 0) + 1, price: '450', reason: 'Back' },
      null,
    );
  });

  it('escalates a round waiting 3 minutes: then the cashier may accept it (AT-50)', async () => {
    const zed = await fx.addUser('zed-acc', ['waiter']);
    await fx.addUser('cash-esc', ['cashier']);
    const cashier = await fx.loggedIn('cash-esc');
    const { table, phone } = await seatedPhone();
    await owner.call({
      method: 'PUT',
      url: url(`/tables/${table.id}/assignment`),
      payload: { userId: zed },
    });
    const round = await guestRound(phone, [line(menu.cake)]);
    const queue = async () =>
      (
        (await staff(cashier, 'GET', '/approvals')).body['items'] as {
          id: string;
          escalated: boolean;
        }[]
      ).find((r) => r.id === round.id);
    expect(await queue()).toBeUndefined();
    expect((await staff(cashier, 'POST', `/rounds/${round.id}/accept`, {})).status).toBe(403);
    expect(
      await withTransaction(fx.pool, (tx) =>
        escalateOverdue(tx, new Date(T0.getTime() + 3 * 60_000)),
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(await queue()).toMatchObject({ escalated: true });
    expect((await staff(cashier, 'POST', `/rounds/${round.id}/accept`, {})).status).toBe(200);
  });

  it('flags rounds sent after a bill request (AT-101)', async () => {
    const { phone } = await seatedPhone();
    await guestRound(phone, [line(menu.cake)]);
    const { rows } = await fx.pool.query<{ id: string }>(
      `UPDATE cl.dining_sessions SET status = 'checkout_requested', checkout_requested_at = now()
        WHERE id = (SELECT session_id FROM cl.session_guest_tokens WHERE token_hash IS NOT NULL ORDER BY id DESC LIMIT 1)
        RETURNING id::text`,
    );
    expect(rows).toHaveLength(1);
    const after = await guestRound(phone, [line(menu.cake)]);
    expect((await staff(owner, 'POST', `/rounds/${after.id}/accept`, {})).status).toBe(200);
    const view = (await phone.session()).json<{
      rounds: { id: string; afterBillRequest: boolean; status: string }[];
    }>();
    expect(view.rounds.find((r) => r.id === after.id)).toMatchObject({
      afterBillRequest: true,
      status: 'accepted',
    });
  });
});

describe('staff rounds (R2)', () => {
  it('are accepted on submit with stock reserved; a short line saves nothing and is named (AT-26)', async () => {
    const table = await newTable();
    const opened = await staff(owner, 'POST', `/tables/${table.id}/sessions`, {});
    const sessionId = String(opened.body['id']);
    const ok = await staff(owner, 'POST', `/sessions/${sessionId}/rounds`, {
      lines: [line(menu.flatWhite), line(menu.cake)],
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'accepted' });
    expect(await reservations(String(ok.body['id']))).toHaveLength(2);

    const before = await fx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM cl.order_rounds WHERE session_id = $1',
      [sessionId],
    );
    const short = await staff(owner, 'POST', `/sessions/${sessionId}/rounds`, {
      lines: [line(menu.cake), line(menu.saffron, 20)],
    });
    expect(short.status).toBe(422);
    expect(short.body).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      shortages: [{ name: 'SAFFRON', lineNos: [2] }],
    });
    const afterCount = await fx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM cl.order_rounds WHERE session_id = $1',
      [sessionId],
    );
    expect(afterCount.rows[0]?.n).toBe(before.rows[0]?.n);

    const detail = await staff(owner, 'GET', `/sessions/${sessionId}`);
    expect(detail.body['acceptedTotal']).toBe('750.00');
  });

  it('closing a session refuses accepted items and cancels waiting rounds (S8)', async () => {
    const { table, phone } = await seatedPhone();
    const waiting = await guestRound(phone, [line(menu.cake)]);
    const floor = await staff(owner, 'GET', '/floor');
    const sessionId =
      (floor.body['tables'] as { id: string; session: { id: string } | null }[]).find(
        (t) => t.id === table.id,
      )?.session?.id ?? '';
    expect(
      (await staff(owner, 'POST', `/sessions/${sessionId}/cancel`, { reason: 'Guests left' }))
        .status,
    ).toBe(204);
    const { rows } = await fx.pool.query('SELECT status FROM cl.order_rounds WHERE id = $1', [
      waiting.id,
    ]);
    expect(rows).toEqual([{ status: 'cancelled' }]);

    const busy = await seatedPhone();
    const r = await guestRound(busy.phone, [line(menu.cake)]);
    await staff(owner, 'POST', `/rounds/${r.id}/accept`, {});
    const f2 = await staff(owner, 'GET', '/floor');
    const s2 =
      (f2.body['tables'] as { id: string; session: { id: string } | null }[]).find(
        (t) => t.id === busy.table.id,
      )?.session?.id ?? '';
    expect(
      (await staff(owner, 'POST', `/sessions/${s2}/cancel`, { reason: 'Guests left' })).status,
    ).toBe(400);
  });
});

describe('approvals queue (D-07)', () => {
  it('shows each person only the rounds they may decide, oldest first, with a stock warning', async () => {
    const wendy = await fx.addUser('wendy-q', ['waiter']);
    const waiter = await fx.loggedIn('wendy-q');
    const mine = await seatedPhone();
    await owner.call({
      method: 'PUT',
      url: url(`/tables/${mine.table.id}/assignment`),
      payload: { userId: wendy },
    });
    const theirs = await seatedPhone();
    const r1 = await guestRound(mine.phone, [line(menu.saffron)]);
    const r2 = await guestRound(theirs.phone, [line(menu.cake)]);
    const ids = (c: Client) =>
      staff(c, 'GET', '/approvals').then((res) =>
        (res.body['items'] as { id: string; stockShort: string[] }[]).filter((x) =>
          [r1.id, r2.id].includes(x.id),
        ),
      );
    const forWaiter = await ids(waiter);
    expect(forWaiter.map((x) => x.id)).toEqual([r1.id]);
    expect(forWaiter[0]?.stockShort).toEqual(['SAFFRON']);
    expect((await ids(owner)).map((x) => x.id)).toEqual([r1.id, r2.id]);
  });
});

describe('guest rate limits (AT-125, API.md §2)', () => {
  it('limits submissions per phone and requests per address, with Retry-After', async () => {
    const small = await identityFixture({
      sessionRole: 'cl_app',
      customerLimits: { perIp: 6, submissions: 2 },
    });
    try {
      const boss = await small.loggedIn(OWNER.username, OWNER.password);
      const cat = await boss.call({
        method: 'POST',
        url: url('/menu/categories'),
        payload: { name: 'C' },
      });
      const item = await boss.call({
        method: 'POST',
        url: url('/menu/items'),
        payload: {
          categoryId: cat.json<{ id: string }>().id,
          name: 'Tea',
          variants: [{ name: 'Cup', price: '100' }],
        },
      });
      const variantId = item.json<{ variantIds: string[] }>().variantIds[0] ?? '';
      const t = await boss.call({
        method: 'POST',
        url: url('/tables'),
        payload: { code: 'R1', name: 'R1' },
      });
      const qr = await boss.call({
        method: 'POST',
        url: url('/qr-entry-points/generate'),
        payload: { tableIds: [t.json<{ id: string }>().id], counter: false },
      });
      const token = qr.json<{ items: { token: string }[] }>().items[0]?.token ?? '';
      const cookies: Record<string, string> = {};
      const send = async (method: 'GET' | 'POST', path: string, payload?: object) => {
        const res = await small.customer.inject({
          method,
          url: `/api/customer/v1${path}`,
          cookies,
          ...(payload ? { payload, headers: { 'idempotency-key': randomUUID() } } : {}),
        });
        for (const c of res.cookies) cookies[c.name] = c.value;
        return res;
      };
      await send('GET', `/entry/${token}`); // 1
      expect((await send('POST', '/rounds', { lines: [line(variantId)] })).statusCode).toBe(201); // 2
      expect((await send('POST', '/rounds', { lines: [line(variantId)] })).statusCode).toBe(201); // 3
      const third = await send('POST', '/rounds', { lines: [line(variantId)] }); // 4
      expect(third.statusCode).toBe(429);
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
      await send('GET', '/session'); // 5
      await send('GET', '/session'); // 6
      const flooded = await send('GET', '/session'); // 7
      expect(flooded.statusCode).toBe(429);
      expect(flooded.json()).toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      await small.close();
    }
  });
});
