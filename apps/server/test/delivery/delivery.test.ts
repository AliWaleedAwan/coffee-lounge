/**
 * Delivery (step 3.10): staff-entered orders with optional details, masked in lists
 * (AT-123); items not offered for delivery refused (AT-114); dispatch rules (AT-89); the
 * rider's return with COD (AT-54) or card (AT-60); a failed delivery resolved by a
 * manager (AT-55 as changed by P3-1: refund due, recorded in Phase 5).
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderReceipt } from '../../src/modules/printing/index.ts';
import { receiptData } from '../../src/modules/printing/receipt-data.ts';
import {
  activateRecipe,
  createInventoryItem,
  createRecipeDraft,
  postOpeningBalance,
  setStockMode,
} from '../../src/modules/stock/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { urlFor } from '../support/db.ts';
import { decodeEscPos } from '../support/escpos/decoder.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let cashier: Client;
let manager: Client;
const menu = { biryani: '', iceCream: '', rice: '' };
const riders = { bilal: '', kamran: '' };

type Body = Record<string, unknown>;
async function staff(
  client: Client,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  payload?: object,
  key = randomUUID(),
) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'GET' ? {} : { headers: { 'idempotency-key': key } }),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}

const audit = () => ({
  actor: { kind: 'user' as const, userId: fx.ownerId },
  correlationId: randomUUID(),
});

interface Delivery {
  deliveryId: string;
  sessionId: string;
  invoiceId: string;
}
async function newDelivery(paymentMode: string, extra: Body = {}, qty = 1): Promise<Delivery> {
  const created = await staff(cashier, 'POST', '/sessions/delivery', {
    channel: 'phone',
    paymentMode,
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const sessionId = String(created.body['sessionId']);
  const round = await staff(cashier, 'POST', `/sessions/${sessionId}/rounds`, {
    lines: [{ variantId: menu.biryani, qty, modifierOptionIds: [] }],
  });
  expect(round.status, JSON.stringify(round.body)).toBe(201);
  const { rows } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.invoices WHERE session_id = $1',
    [sessionId],
  );
  return {
    deliveryId: String(created.body['deliveryId']),
    sessionId,
    invoiceId: rows[0]?.id ?? '',
  };
}

async function pickUpAll(d: Delivery) {
  const { rows } = await fx.pool.query<{ id: string }>(
    `SELECT k.id::text FROM cl.kitchen_tickets k JOIN cl.order_rounds r ON r.id = k.round_id
      WHERE r.session_id = $1 AND k.kind IN ('new','supplement') ORDER BY k.id`,
    [d.sessionId],
  );
  for (const t of rows)
    expect((await staff(cashier, 'POST', `/tickets/${t.id}/pickup`, {})).status).toBe(200);
}

async function state(d: Delivery) {
  const { rows } = await fx.pool.query<{
    delivery: string;
    session: string;
    invoice: string;
    paid: string;
    refund_due: string;
  }>(
    `SELECT d.status AS delivery, s.status AS session, i.status AS invoice, i.paid_total::text AS paid,
            d.refund_due::text
       FROM cl.delivery_orders d JOIN cl.dining_sessions s ON s.id = d.session_id
       JOIN cl.invoices i ON i.session_id = s.id WHERE d.id = $1`,
    [d.deliveryId],
  );
  return rows[0];
}

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('dl-cash', ['cashier']);
  await fx.addUser('dl-mgr', ['manager']);
  await fx.addUser('dl-owner', ['owner'], { pin: '1357' });
  cashier = await fx.loggedIn('dl-cash');
  manager = await fx.loggedIn('dl-mgr');
  const cat = await staff(owner, 'POST', '/menu/categories', { name: 'Delivery tests' });
  const item = async (name: string, price: string, allowDelivery = true) =>
    (
      (
        await staff(owner, 'POST', '/menu/items', {
          categoryId: cat.body['id'],
          name,
          allowDelivery,
          variants: [{ name: 'Plate', price }],
        })
      ).body['variantIds'] as string[]
    )[0] ?? '';
  menu.biryani = await item('Chicken biryani', '800');
  menu.iceCream = await item('Soft ice cream', '300', false);
  await withTransaction(fx.pool, async (tx) => {
    const { id } = await createInventoryItem(tx, audit(), {
      sku: 'DL-RICE',
      name: 'Rice',
      baseUom: 'g',
    });
    menu.rice = id;
    await postOpeningBalance(tx, { actorUserId: fx.ownerId, businessDate: '2026-10-25' }, audit(), {
      itemId: id,
      qty: new Decimal(50_000),
      unitCost: new Decimal('0.4'),
    });
    const draft = await createRecipeDraft(tx, {
      variantId: menu.biryani,
      components: [{ itemId: id, qtyBase: '250' }],
    });
    await activateRecipe(tx, audit(), draft.id);
    await setStockMode(tx, audit(), menu.biryani, 'recipe');
  });
  riders.bilal = String(
    (await staff(owner, 'POST', '/riders', { name: 'Bilal', phone: '0301 1111111' })).body['id'],
  );
  riders.kamran = String((await staff(owner, 'POST', '/riders', { name: 'Kamran' })).body['id']);
  await staff(cashier, 'POST', '/cash-shifts', { openingFloat: '2000' });
});
afterAll(async () => {
  await fx.close();
});

describe('the order (D0)', () => {
  it('needs no customer details; a phone number is masked on the board (AT-123)', async () => {
    const bare = await newDelivery('cod_cash');
    const full = await newDelivery('cod_cash', {
      customerName: 'Ayesha',
      customerPhone: '0300 1234567',
      address: 'House 12, Street 4, DHA Phase 5',
      landmark: 'Near the blue mosque',
    });
    const board = (await staff(cashier, 'GET', '/deliveries')).body['items'] as Body[];
    expect(board.find((d) => d['id'] === bare.deliveryId)).toMatchObject({
      customerName: null,
      phone: null,
      status: 'pending_dispatch',
      items: 1,
    });
    const listed = board.find((d) => d['id'] === full.deliveryId);
    expect(listed?.['phone']).toBe('•••• •••4567');
    expect(JSON.stringify(board)).not.toContain('1234567');
    expect((await staff(cashier, 'GET', `/deliveries/${full.deliveryId}`)).body).toMatchObject({
      customerPhone: '0300 1234567',
      landmark: 'Near the blue mosque',
    });
  });

  it('refuses an item not offered for delivery (AT-114)', async () => {
    const d = await newDelivery('prepaid');
    const res = await staff(cashier, 'POST', `/sessions/${d.sessionId}/rounds`, {
      lines: [{ variantId: menu.iceCream, qty: 1, modifierOptionIds: [] }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Soft ice cream is not offered for delivery');
  });

  it('riders are kept by the owner; names are unique', async () => {
    expect((await staff(cashier, 'POST', '/riders', { name: 'Zia' })).status).toBe(403);
    expect((await staff(owner, 'POST', '/riders', { name: 'bilal' })).status).toBe(400);
    const list = (await staff(cashier, 'GET', '/riders')).body['items'] as Body[];
    expect(list.map((r) => r['name'])).toEqual(['Bilal', 'Kamran']);
  });
});

describe('dispatch (D1, AT-89)', () => {
  it('waits for every item; prepaid waits for the payment; COD prepares the bill', async () => {
    const prepaid = await newDelivery('prepaid', { address: 'Gulberg' });
    const tooEarly = await staff(cashier, 'POST', `/deliveries/${prepaid.deliveryId}/dispatch`, {
      riderId: riders.bilal,
    });
    expect(tooEarly.status).toBe(400);
    expect(String(tooEarly.body['detail'])).toContain('not picked up yet');
    await pickUpAll(prepaid);
    const unpaid = await staff(cashier, 'POST', `/deliveries/${prepaid.deliveryId}/dispatch`, {
      riderId: riders.bilal,
    });
    expect(String(unpaid.body['detail'])).toContain('prepaid');
    const locked = await staff(cashier, 'POST', `/invoices/${prepaid.invoiceId}/lock`, {});
    await staff(cashier, 'POST', `/invoices/${prepaid.invoiceId}/payments`, {
      lockVersion: locked.body['lockVersion'],
      method: 'transfer',
      provider: 'easypaisa',
      amount: '800',
      reference: 'EP5521',
      confirmed: true,
    });
    const sent = await staff(cashier, 'POST', `/deliveries/${prepaid.deliveryId}/dispatch`, {
      riderId: riders.bilal,
    });
    expect(sent.body).toMatchObject({ status: 'out_for_delivery' });

    const cod = await newDelivery('cod_cash', { address: 'Model Town' });
    await pickUpAll(cod);
    expect((await state(cod))?.invoice).toBe('open');
    await staff(cashier, 'POST', `/deliveries/${cod.deliveryId}/dispatch`, {
      riderId: riders.bilal,
    });
    expect(await state(cod)).toMatchObject({
      delivery: 'out_for_delivery',
      invoice: 'locked',
      session: 'checkout_locked',
    });
    // The bill is fixed: nothing more can be added once the food has left.
    const late = await staff(cashier, 'POST', `/sessions/${cod.sessionId}/rounds`, {
      lines: [{ variantId: menu.biryani, qty: 1, modifierOptionIds: [] }],
    });
    expect(late.body).toMatchObject({ code: 'SESSION_LOCKED_FOR_CHECKOUT' });
    const { rows } = await fx.pool.query<{ served: number; picked: number }>(
      'SELECT sum(qty_served)::int AS served, sum(qty_picked_up)::int AS picked FROM cl.order_lines WHERE session_id = $1',
      [cod.sessionId],
    );
    expect(rows[0]?.served).toBe(rows[0]?.picked);

    // The rider's slip: where to, and how much to collect.
    const { text } = decodeEscPos(
      renderReceipt(await receiptData(fx.pool, cod.invoiceId), {
        width: 48,
        canCut: true,
        copyNo: 1,
        timeZone: 'Asia/Karachi',
      }),
    );
    expect(text).toMatch(/DELIVERY\s+Rider: Bilal/);
    expect(text).toContain('Model Town');
    expect(text).toMatch(/CASH TO COLLECT\s+Rs 800\.00/);
    expect(text).toContain('NOT PAID YET');
  });
});

describe('the rider is back (D2)', () => {
  it('COD: the cash goes into this shift, naming the rider; outstanding back to zero (AT-54)', async () => {
    const d = await newDelivery('cod_cash', {}, 2);
    await pickUpAll(d);
    await staff(cashier, 'POST', `/deliveries/${d.deliveryId}/dispatch`, {
      riderId: riders.kamran,
    });
    const board = (await staff(cashier, 'GET', '/deliveries')).body;
    expect(board['outstanding']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rider: 'Kamran', amount: '1600.00', deliveries: 1 }),
      ]),
    );
    const shiftBefore = (await staff(cashier, 'GET', '/cash-shifts/current')).body['shift'] as Body;
    expect(shiftBefore['withRiders']).toEqual(
      expect.arrayContaining([expect.objectContaining({ rider: 'Kamran', amount: '1600.00' })]),
    );

    const back = await staff(cashier, 'POST', `/deliveries/${d.deliveryId}/return`, {
      outcome: 'delivered',
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ status: 'delivered', collected: '1600.00' });
    expect(String(back.body['invoiceNo'])).toMatch(/^INV-/);
    expect(await state(d)).toMatchObject({
      delivery: 'delivered',
      invoice: 'settled',
      session: 'settled',
    });
    const { rows } = await fx.pool.query<{ rider: string; shift: boolean; method: string }>(
      `SELECT r.display_name AS rider, p.cash_shift_id IS NOT NULL AS shift, p.method
         FROM cl.payments p JOIN cl.staff_profiles r ON r.id = p.collected_by_rider_id
        WHERE p.invoice_id = $1`,
      [d.invoiceId],
    );
    expect(rows).toEqual([{ rider: 'Kamran', shift: true, method: 'cash' }]);
    const after = (await staff(cashier, 'GET', '/deliveries')).body['outstanding'] as Body[];
    expect(after.find((o) => o['rider'] === 'Kamran')).toBeUndefined();
    const shiftAfter = (await staff(cashier, 'GET', '/cash-shifts/current')).body['shift'] as Body;
    expect(Number(shiftAfter['cashSales']) - Number(shiftBefore['cashSales'])).toBe(1600);
    const { rows: events } = await fx.pool.query<{
      to_status: string;
      rider: boolean;
      actor: boolean;
    }>(
      `SELECT to_status, rider_id IS NOT NULL AS rider, actor_user_id IS NOT NULL AS actor
         FROM cl.delivery_events WHERE delivery_order_id = $1 ORDER BY delivery_events.id`,
      [d.deliveryId],
    );
    expect(events).toEqual([
      { to_status: 'out_for_delivery', rider: true, actor: true },
      { to_status: 'delivered', rider: true, actor: true },
    ]);
  });

  it('card on delivery: recorded once even when the return is retried (AT-60)', async () => {
    const d = await newDelivery('card_on_delivery');
    await pickUpAll(d);
    await staff(cashier, 'POST', `/deliveries/${d.deliveryId}/dispatch`, { riderId: riders.bilal });
    const key = randomUUID();
    const body = { outcome: 'delivered', reference: 'PT7781' };
    const first = await staff(cashier, 'POST', `/deliveries/${d.deliveryId}/return`, body, key);
    const again = await staff(cashier, 'POST', `/deliveries/${d.deliveryId}/return`, body, key);
    expect(again.body).toEqual(first.body);
    const { rows } = await fx.pool.query<{
      method: string;
      reference: string;
      shift: string | null;
    }>(
      'SELECT method, reference, cash_shift_id::text AS shift FROM cl.payments WHERE invoice_id = $1',
      [d.invoiceId],
    );
    expect(rows).toEqual([{ method: 'card_manual', reference: 'PT7781', shift: null }]);
    // A delivered order is final.
    expect(
      (await staff(cashier, 'POST', `/deliveries/${d.deliveryId}/return`, body)).body,
    ).toMatchObject({
      code: 'STALE_STATE',
    });
  });
});

describe('a failed delivery (D3–D6)', () => {
  async function failed(paymentMode: string) {
    const d = await newDelivery(paymentMode);
    await pickUpAll(d);
    if (paymentMode === 'prepaid') {
      const locked = await staff(cashier, 'POST', `/invoices/${d.invoiceId}/lock`, {});
      await staff(cashier, 'POST', `/invoices/${d.invoiceId}/payments`, {
        lockVersion: locked.body['lockVersion'],
        method: 'card_manual',
        amount: '800',
      });
    }
    await staff(cashier, 'POST', `/deliveries/${d.deliveryId}/dispatch`, { riderId: riders.bilal });
    const res = await staff(cashier, 'POST', `/deliveries/${d.deliveryId}/return`, {
      outcome: 'failed',
      reason: 'Nobody at the address',
    });
    expect(res.body).toMatchObject({ status: 'failed' });
    return d;
  }
  const balance = async () =>
    (
      await fx.pool.query<{ on_hand: string; value: string }>(
        'SELECT on_hand::text, inventory_value::text AS value FROM cl.inventory_balances WHERE item_id = $1',
        [menu.rice],
      )
    ).rows[0];

  it('a manager cancels: the food is waste, no stock credit; prepaid money is a refund due (AT-55, P3-1)', async () => {
    const d = await failed('prepaid');
    const { rows: alerts } = await fx.pool.query<{ kind: string }>(
      `SELECT kind FROM cl.operational_alerts WHERE entity_type = 'delivery_order' AND entity_id = $1 AND state = 'open'`,
      [d.deliveryId],
    );
    expect(alerts).toEqual([{ kind: 'failed_delivery' }]);
    expect(
      (
        await staff(cashier, 'POST', `/deliveries/${d.deliveryId}/resolve`, {
          action: 'cancel',
          reason: 'Wrong number',
        })
      ).status,
    ).toBe(403);
    const before = await balance();
    const res = await staff(manager, 'POST', `/deliveries/${d.deliveryId}/resolve`, {
      action: 'cancel',
      reason: 'Customer unreachable',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: 'cancelled',
      refundDue: '800.00',
      wasteValue: '100.0000',
    });
    expect(await balance()).toEqual(before); // consumed at pickup, never credited back
    expect(await state(d)).toMatchObject({
      delivery: 'cancelled',
      invoice: 'settled',
      refund_due: '800.00',
    });
    const { rows: waste } = await fx.pool.query<{ reason_code: string; qty: string }>(
      `SELECT w.reason_code, w.qty FROM cl.wastage_records w JOIN cl.order_lines l ON l.id = w.order_line_id
        WHERE l.session_id = $1`,
      [d.sessionId],
    );
    expect(waste).toEqual([{ reason_code: 'failed_delivery', qty: '1.0000' }]);
    const { rows: open } = await fx.pool.query<{ kind: string }>(
      `SELECT kind FROM cl.operational_alerts WHERE entity_type = 'delivery_order' AND entity_id = $1 AND state = 'open'`,
      [d.deliveryId],
    );
    expect(open).toEqual([{ kind: 'refund_due' }]);

    // P5-5: the refund to the card it was paid with closes the "refund due".
    const { rows: paid } = await fx.pool.query<{ id: string }>(
      'SELECT id::text FROM cl.payments WHERE invoice_id = $1',
      [d.invoiceId],
    );
    const approval = await staff(manager, 'POST', '/auth/step-up', {
      action: 'refund.approve',
      entityType: 'invoice',
      entityId: d.invoiceId,
      approverUsername: 'dl-owner',
      approverPin: '1357',
      reason: 'Delivery cancelled',
    });
    expect(approval.status, JSON.stringify(approval.body)).toBe(201);
    const refund = await staff(manager, 'POST', `/invoices/${d.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: paid[0]?.id,
      amount: '800',
      reason: 'Delivery cancelled, customer unreachable',
      reference: 'RV1',
      stepUpId: approval.body['stepUpId'],
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body).toMatchObject({ method: 'card_manual', amount: '800.00' });
    const { rows: after } = await fx.pool.query(
      `SELECT kind FROM cl.operational_alerts WHERE entity_type = 'delivery_order' AND entity_id = $1 AND state = 'open'`,
      [d.deliveryId],
    );
    expect(after).toEqual([]);
  });

  it('COD cancelled: the unpaid bill is reopened and the visit closed with nothing to pay', async () => {
    const d = await failed('cod_cash');
    const res = await staff(manager, 'POST', `/deliveries/${d.deliveryId}/resolve`, {
      action: 'cancel',
      reason: 'Customer refused',
    });
    expect(res.body).toMatchObject({ status: 'cancelled', refundDue: null });
    expect(await state(d)).toMatchObject({
      delivery: 'cancelled',
      invoice: 'open',
      session: 'cancelled',
      paid: '0.00',
    });
  });

  it('re-attempt with another rider, or the customer collects at the counter', async () => {
    const again = await failed('cod_cash');
    const re = await staff(manager, 'POST', `/deliveries/${again.deliveryId}/resolve`, {
      action: 'reattempt',
      riderId: riders.kamran,
    });
    expect(re.body).toMatchObject({ status: 'out_for_delivery' });
    const board = (await staff(cashier, 'GET', '/deliveries')).body['items'] as Body[];
    expect(board.find((x) => x['id'] === again.deliveryId)).toMatchObject({
      rider: 'Kamran',
      attempt: 2,
    });

    const pickup = await failed('card_on_delivery');
    const conv = await staff(manager, 'POST', `/deliveries/${pickup.deliveryId}/resolve`, {
      action: 'convert_to_pickup',
    });
    expect(conv.body).toMatchObject({ status: 'converted_to_pickup' });
    // Paid at the counter like any takeaway.
    const bill = (await staff(cashier, 'GET', `/sessions/${pickup.sessionId}/bill`)).body[
      'invoice'
    ] as Body;
    const paid = await staff(cashier, 'POST', `/invoices/${pickup.invoiceId}/payments`, {
      lockVersion: bill['lockVersion'],
      method: 'card_manual',
      amount: '800',
    });
    expect(paid.body).toMatchObject({ settled: true });
  });

  it('the database keeps a finished delivery finished', async () => {
    const { rows } = await fx.pool.query<{ id: string }>(
      `SELECT id::text FROM cl.delivery_orders WHERE status = 'delivered' ORDER BY delivery_orders.id LIMIT 1`,
    );
    const admin = new pg.Client({ connectionString: urlFor(fx.db.name) });
    await admin.connect();
    try {
      const code = await admin
        .query(
          `UPDATE cl.delivery_orders SET status = 'failed', failure_reason = 'x' WHERE id = $1`,
          [rows[0]?.id],
        )
        .then(
          () => 'accepted',
          (e: unknown) => (e as { code?: string }).code,
        );
      expect(code).toBe('23001');
    } finally {
      await admin.end();
    }
  });
});
