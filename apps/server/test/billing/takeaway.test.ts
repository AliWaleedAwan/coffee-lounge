/**
 * Takeaway and the counter QR (step 3.9): one session per guest phone (AT-75), Accept &
 * pay in one transaction (AT-51, AT-52), unpaid orders cancelling themselves (AT-53),
 * and the cashier's own takeaway.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptAndPay } from '../../src/modules/billing/takeaway.ts';
import { expireUnpaidTakeaways } from '../../src/modules/orders/index.ts';
import {
  activateRecipe,
  createInventoryItem,
  createRecipeDraft,
  postOpeningBalance,
  setStockMode,
} from '../../src/modules/stock/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { race, raceRuns, repeatRace, tally } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let cashier: Client;
let counterToken = '';
const menu = { tea: '', iced: '', ice: '' };

type Body = Record<string, unknown>;
async function staff(
  client: Client,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  payload?: object,
  key = randomUUID(),
) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': key } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}

/** A guest phone: keeps its cookies like a browser. */
class Phone {
  cookies: Record<string, string> = {};
  private keep(res: LightMyRequestResponse) {
    for (const c of res.cookies) {
      if (c.value === '' || c.maxAge === 0) Reflect.deleteProperty(this.cookies, c.name);
      else this.cookies[c.name] = c.value;
    }
    return res;
  }
  async get(path: string) {
    return this.keep(
      await fx.customer.inject({
        method: 'GET',
        url: `/api/customer/v1${path}`,
        cookies: this.cookies,
      }),
    );
  }
  async post(path: string, payload: object) {
    return this.keep(
      await fx.customer.inject({
        method: 'POST',
        url: `/api/customer/v1${path}`,
        cookies: this.cookies,
        headers: { 'idempotency-key': randomUUID() },
        payload,
      }),
    );
  }
}

/** A phone scans the counter QR and orders; returns the phone and its pending round. */
async function guestOrder(variantId: string, qty = 1, customerName?: string) {
  const phone = new Phone();
  expect((await phone.get(`/entry/${counterToken}`)).statusCode).toBe(200);
  const res = await phone.post('/rounds', {
    lines: [{ variantId, qty, modifierOptionIds: [] }],
    ...(customerName ? { customerName } : {}),
  });
  expect(res.statusCode, res.body).toBe(201);
  const roundId = res.json<{ round: { id: string } }>().round.id;
  return { phone, roundId };
}

const audit = () => ({
  actor: { kind: 'user' as const, userId: fx.ownerId },
  correlationId: randomUUID(),
});
const staffAuth = () => ({
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
  permissions: new Map(
    ['orders.accept', 'invoices.lock', 'payments.collect'].map((k) => [
      k,
      { scopes: 'all' as const, sources: ['test'] },
    ]),
  ),
});

async function roundState(roundId: string) {
  const { rows } = await fx.pool.query<{
    round: string;
    session: string;
    invoice: string;
    payments: number;
    reservations: number;
    tickets: number;
  }>(
    `SELECT r.status AS round, s.status AS session, i.status AS invoice,
            (SELECT count(*)::int FROM cl.payments p WHERE p.invoice_id = i.id) AS payments,
            (SELECT count(*)::int FROM cl.stock_reservations x JOIN cl.order_lines l ON l.id = x.order_line_id
              WHERE l.round_id = r.id) AS reservations,
            (SELECT count(*)::int FROM cl.kitchen_tickets k WHERE k.round_id = r.id) AS tickets
       FROM cl.order_rounds r JOIN cl.dining_sessions s ON s.id = r.session_id JOIN cl.invoices i ON i.session_id = s.id
      WHERE r.id = $1`,
    [roundId],
  );
  return rows[0];
}

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('ta-cash', ['cashier']);
  cashier = await fx.loggedIn('ta-cash');
  const cat = await staff(owner, 'POST', '/menu/categories', { name: 'Takeaway tests' });
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
  menu.tea = await item('Karak chai', '250');
  menu.iced = await item('Iced latte', '600');
  await withTransaction(fx.pool, async (tx) => {
    const { id } = await createInventoryItem(tx, audit(), {
      sku: 'TA-ICE',
      name: 'Ice',
      baseUom: 'g',
    });
    menu.ice = id;
    await postOpeningBalance(tx, { actorUserId: fx.ownerId, businessDate: '2026-10-25' }, audit(), {
      itemId: id,
      qty: new Decimal(300),
      unitCost: new Decimal('0.01'),
    });
    const draft = await createRecipeDraft(tx, {
      variantId: menu.iced,
      components: [{ itemId: id, qtyBase: '200' }],
    });
    await activateRecipe(tx, audit(), draft.id);
    await setStockMode(tx, audit(), menu.iced, 'recipe');
  });
  const qr = await staff(owner, 'POST', '/qr-entry-points/generate', {
    tableIds: [],
    counter: true,
  });
  counterToken = (qr.body['items'] as { token: string }[])[0]?.token ?? '';
  await staff(cashier, 'POST', '/cash-shifts', { openingFloat: '1000' });
});
afterAll(async () => {
  await fx.close();
});

describe('the counter QR', () => {
  it('two guests get two takeaway sessions; neither sees the other’s order (AT-75)', async () => {
    const a = await guestOrder(menu.tea, 1, 'Hina');
    const b = await guestOrder(menu.tea, 2);
    const sa = (await a.phone.get('/session')).json<{
      session: { sessionNo: string };
      rounds: { id: string }[];
    }>();
    const sb = (await b.phone.get('/session')).json<{
      session: { sessionNo: string };
      rounds: { id: string }[];
    }>();
    expect(sa.session.sessionNo).not.toBe(sb.session.sessionNo);
    expect(sa.rounds.map((r) => r.id)).toEqual([a.roundId]);
    expect(sb.rounds.map((r) => r.id)).toEqual([b.roundId]);
    const { rows } = await fx.pool.query<{
      order_type: string;
      customer_name: string | null;
      table_id: string | null;
    }>(
      `SELECT s.order_type, s.customer_name, s.table_id::text FROM cl.order_rounds r
         JOIN cl.dining_sessions s ON s.id = r.session_id WHERE r.id = ANY($1::bigint[]) ORDER BY r.id`,
      [[a.roundId, b.roundId]],
    );
    expect(rows).toEqual([
      { order_type: 'takeaway', customer_name: 'Hina', table_id: null },
      { order_type: 'takeaway', customer_name: null, table_id: null },
    ]);
    // The same phone ordering again stays in its own visit.
    const again = await a.phone.post('/rounds', {
      lines: [{ variantId: menu.tea, qty: 1, modifierOptionIds: [] }],
    });
    expect(again.json<{ session: { sessionNo: string } }>().session.sessionNo).toBe(
      sa.session.sessionNo,
    );

    const queue = (await staff(cashier, 'GET', '/takeaway/queue')).body;
    const mine = (queue['items'] as Body[]).find((i) => i['roundId'] === a.roundId);
    expect(mine).toMatchObject({
      customerName: 'Hina',
      total: '250.00',
      lines: [{ qty: 1, description: 'Karak chai Regular' }],
    });
    expect(
      Date.parse(String(mine?.['expiresAt'])) - Date.parse(String(mine?.['submittedAt'])),
    ).toBe(30 * 60_000);
  });
});

describe('Accept & pay', () => {
  it('accepts, reserves, settles and prints once, in one transaction (AT-51)', async () => {
    const printer = await staff(owner, 'POST', '/printers', {
      name: 'TA printer',
      connection: 'tcp',
      address: '127.0.0.1:9',
    });
    const printers = await staff(owner, 'GET', '/printers');
    const tillId = (printers.body['tills'] as { id: string }[])[0]?.id ?? '';
    const stationId = (printers.body['stations'] as { id: string }[])[0]?.id ?? '';
    await staff(owner, 'PUT', `/tills/${tillId}/printer`, { printerId: printer.body['id'] });
    await staff(owner, 'PUT', `/stations/${stationId}/printer`, { printerId: printer.body['id'] });
    try {
      const { phone, roundId } = await guestOrder(menu.iced);
      const key = randomUUID();
      const body = { payments: [{ method: 'cash', amount: '600', tendered: '1000' }] };
      const paid = await staff(cashier, 'POST', `/rounds/${roundId}/accept-and-pay`, body, key);
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      expect(paid.body).toMatchObject({ total: '600.00', change: '400.00', receiptQueued: true });
      expect(String(paid.body['invoiceNo'])).toMatch(/^INV-\d{4}-\d{6}$/);
      expect(await roundState(roundId)).toEqual({
        round: 'accepted',
        session: 'settled',
        invoice: 'settled',
        payments: 1,
        reservations: 1,
        tickets: 1,
      });
      // A retry (the counter lost the answer) replays it: nothing twice.
      const again = await staff(cashier, 'POST', `/rounds/${roundId}/accept-and-pay`, body, key);
      expect(again.body).toEqual(paid.body);
      const { rows: jobs } = await fx.pool.query<{ document_type: string; n: number }>(
        `SELECT document_type, count(*)::int AS n FROM cl.print_jobs
          WHERE (document_type = 'receipt' AND document_id = $1)
             OR (document_type = 'kitchen_ticket' AND document_id IN (SELECT id FROM cl.kitchen_tickets WHERE round_id = $2))
          GROUP BY document_type ORDER BY document_type`,
        [paid.body['invoiceId'], roundId],
      );
      expect(jobs).toEqual([
        { document_type: 'kitchen_ticket', n: 1 },
        { document_type: 'receipt', n: 1 },
      ]);
      // The kitchen makes it like any other order: it is on the pickup screen.
      const pickup = await staff(cashier, 'GET', '/pickup');
      expect(JSON.stringify(pickup.body)).toContain('Iced latte');
      expect((await phone.get('/session')).statusCode).toBe(401); // paid and done: visit ended
    } finally {
      await staff(owner, 'PUT', `/tills/${tillId}/printer`, { printerId: null });
      await staff(owner, 'PUT', `/stations/${stationId}/printer`, { printerId: null });
    }
  });

  it('when an ingredient just ran out nothing is saved: no reservation, no payment (AT-52)', async () => {
    // 300 g of ice; the first order above reserved 200; this one needs 200 more.
    const { roundId } = await guestOrder(menu.iced);
    const refused = await staff(cashier, 'POST', `/rounds/${roundId}/accept-and-pay`, {
      payments: [{ method: 'card_manual', amount: '600', reference: 'AP77' }],
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await roundState(roundId)).toEqual({
      round: 'pending_approval',
      session: 'open',
      invoice: 'open',
      payments: 0,
      reservations: 0,
      tickets: 0,
    });
    // The cashier then rejects it with the reason the guest sees.
    expect(
      (await staff(cashier, 'POST', `/rounds/${roundId}/reject`, { reason: 'Item just ran out' }))
        .status,
    ).toBe(200);
  });

  it('the wrong amount or a dine-in order: nothing is saved; split tender works', async () => {
    const { roundId } = await guestOrder(menu.tea, 2);
    const short = await staff(cashier, 'POST', `/rounds/${roundId}/accept-and-pay`, {
      payments: [{ method: 'card_manual', amount: '250' }],
    });
    expect(short.status).toBe(409);
    expect(short.body).toMatchObject({ code: 'BILL_CHANGED', total: '500.00' });
    expect((await roundState(roundId))?.round).toBe('pending_approval');

    // Split tender works: card and cash together.
    const split = await staff(cashier, 'POST', `/rounds/${roundId}/accept-and-pay`, {
      payments: [
        { method: 'card_manual', amount: '300' },
        { method: 'cash', amount: '200', tendered: '200' },
      ],
    });
    expect(split.body).toMatchObject({ total: '500.00', change: '0.00' });
    expect((await roundState(roundId))?.payments).toBe(2);

    const t = await staff(owner, 'POST', '/tables', { code: 'TA1', name: 'Takeaway test table' });
    const s = await staff(owner, 'POST', `/tables/${String(t.body['id'])}/sessions`, {});
    const dine = await withTransaction(fx.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cl.order_rounds (session_id, round_no, round_ref, source, status, submitted_by_user_id, quoted_total)
         VALUES ($1, 1, $2, 'waiter', 'pending_approval', $3, 0) RETURNING id::text`,
        [s.body['id'], `R-TA-${randomUUID().slice(0, 6)}`, fx.ownerId],
      );
      return rows[0]?.id ?? '';
    });
    expect(
      (await staff(cashier, 'POST', `/rounds/${dine}/accept-and-pay`, { payments: [] })).body,
    ).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'Accept & pay is for takeaway orders' });
  });

  it('Accept & pay and the 30-minute cancel at once: exactly one happens', async () => {
    await repeatRace(raceRuns(), async () => {
      const { roundId } = await guestOrder(menu.tea);
      const later = new Date(Date.now() + 31 * 60_000);
      const outcomes = await race<unknown>({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: ({ index, pool, barrier }) =>
          index === 0
            ? withTransaction(pool, async (tx) => {
                await barrier.wait();
                return acceptAndPay(
                  tx,
                  { key: randomUUID(), correlationId: randomUUID(), now: new Date() },
                  staffAuth(),
                  roundId,
                  [{ method: 'card_manual', amount: '250' }],
                );
              })
            : (async () => {
                await barrier.wait();
                return expireUnpaidTakeaways(pool, later);
              })(),
      });
      const { failed } = tally(outcomes);
      const state = await roundState(roundId);
      if (failed.length === 0) {
        // Paid first; the cancel found nothing left to do for it.
        expect(state).toMatchObject({ round: 'accepted', invoice: 'settled', payments: 1 });
      } else {
        // Refused either way: the order was cancelled, and with it the visit.
        expect(failed).toHaveLength(1);
        expect(['ROUND_ALREADY_DECIDED', 'VISIT_ENDED']).toContain(failed[0]);
        expect(state).toMatchObject({
          round: 'expired',
          session: 'cancelled',
          payments: 0,
          reservations: 0,
        });
      }
    });
  });
});

describe('unpaid orders cancel themselves (AT-53)', () => {
  it('after 30 minutes, not before; no stock effect; the phone learns its visit ended', async () => {
    const { phone, roundId } = await guestOrder(menu.iced);
    const submitted =
      (
        await fx.pool.query<{ at: Date }>(
          'SELECT submitted_at AS at FROM cl.order_rounds WHERE id = $1',
          [roundId],
        )
      ).rows[0]?.at ?? new Date();
    const before = await fx.pool.query(
      'SELECT reserved::text, on_hand::text FROM cl.inventory_balances WHERE item_id = $1',
      [menu.ice],
    );
    await expireUnpaidTakeaways(fx.pool, new Date(submitted.getTime() + 29 * 60_000));
    expect((await roundState(roundId))?.round).toBe('pending_approval');
    await expireUnpaidTakeaways(fx.pool, new Date(submitted.getTime() + 30 * 60_000 + 1));
    expect(await roundState(roundId)).toMatchObject({
      round: 'expired',
      session: 'cancelled',
      invoice: 'open',
      reservations: 0,
    });
    const after = await fx.pool.query(
      'SELECT reserved::text, on_hand::text FROM cl.inventory_balances WHERE item_id = $1',
      [menu.ice],
    );
    expect(after.rows).toEqual(before.rows);
    const ended = await phone.get('/session');
    expect(ended.statusCode).toBe(401);
    expect(ended.json()).toMatchObject({ code: 'VISIT_ENDED' });
    // A table QR order is never cancelled this way.
    const { rows } = await fx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cl.order_rounds r JOIN cl.dining_sessions s ON s.id = r.session_id
        WHERE r.status = 'expired' AND s.order_type <> 'takeaway'`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe("the cashier's own takeaway", () => {
  it('opens a takeaway session, sends a round straight to the kitchen and is billed at the counter', async () => {
    const s = await staff(cashier, 'POST', '/sessions/takeaway', { customerName: 'Bilal' });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body).toMatchObject({ orderType: 'takeaway', tableId: null });
    const sessionId = String(s.body['id']);
    const round = await staff(cashier, 'POST', `/sessions/${sessionId}/rounds`, {
      lines: [{ variantId: menu.tea, qty: 1, modifierOptionIds: [] }],
    });
    expect(round.body['status']).toBe('accepted');
    const bills = (await staff(cashier, 'GET', '/bills')).body['items'] as Body[];
    const bill = bills.find((b) => b['sessionId'] === sessionId);
    expect(bill).toMatchObject({ orderType: 'takeaway', total: '250.00' });
    const locked = await staff(
      cashier,
      'POST',
      `/invoices/${String(bill?.['invoiceId'])}/lock`,
      {},
    );
    const paid = await staff(cashier, 'POST', `/invoices/${String(bill?.['invoiceId'])}/payments`, {
      lockVersion: locked.body['lockVersion'],
      method: 'cash',
      amount: '250',
      tendered: '500',
    });
    expect(paid.body).toMatchObject({ settled: true, change: '250.00' });
  });
});
