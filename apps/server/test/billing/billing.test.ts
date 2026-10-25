/**
 * Bills, discounts and payments (step 3.7), through the staff API as the application
 * role; races call the services on their own connections. The till's shift opens in the
 * fourth test and stays open for the rest of the file, as on a real day.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockBill } from '../../src/modules/billing/invoices.ts';
import { takePayment } from '../../src/modules/billing/payments.ts';
import {
  lockActiveSession,
  openOrJoinFromQr,
  type EntryPoint,
} from '../../src/modules/floor/index.ts';
import { submitRound } from '../../src/modules/orders/index.ts';
import { renderReceipt } from '../../src/modules/printing/index.ts';
import { receiptData } from '../../src/modules/printing/receipt-data.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { race, raceRuns, repeatRace, tally } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { decodeEscPos } from '../support/escpos/decoder.ts';

let fx: IdentityFixture;
let owner: Client;
let cashier: Client;
let cashier2: Client;
let manager: Client;
const menu = { coffee: '', cake: '', odd: '' };

const url = (path: string) => `/api/staff/v1${path}`;
type Body = Record<string, unknown>;
async function staff(
  client: Client,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  payload?: object,
  key: string = randomUUID(),
) {
  const res = await client.call({
    method,
    url: url(path),
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': key } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}

let tableNo = 0;
interface Visit {
  sessionId: string;
  tableId: string;
  invoiceId: string;
  token: string;
  lineIds: string[];
}
/** A dine-in table with a QR code, a session and one staff round (accepted at once). */
async function visit(lines: { variantId: string; qty: number }[]): Promise<Visit> {
  tableNo += 1;
  const t = await staff(owner, 'POST', '/tables', {
    code: `B${String(tableNo)}`,
    name: `Bill ${String(tableNo)}`,
  });
  const tableId = String(t.body['id']);
  const qr = await staff(owner, 'POST', '/qr-entry-points/generate', {
    tableIds: [tableId],
    counter: false,
  });
  const token = (qr.body['items'] as { token: string }[])[0]?.token ?? '';
  const sessionId = String(
    (await staff(owner, 'POST', `/tables/${tableId}/sessions`, {})).body['id'],
  );
  const round = await staff(owner, 'POST', `/sessions/${sessionId}/rounds`, {
    lines: lines.map((l) => ({ ...l, modifierOptionIds: [] })),
  });
  expect(round.status, JSON.stringify(round.body)).toBe(201);
  const { rows } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.order_lines WHERE round_id = $1 ORDER BY line_no',
    [round.body['id']],
  );
  const { rows: inv } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.invoices WHERE session_id = $1',
    [sessionId],
  );
  return { sessionId, tableId, invoiceId: inv[0]?.id ?? '', token, lineIds: rows.map((r) => r.id) };
}

const bill = async (v: Visit, client = owner) =>
  (await staff(client, 'GET', `/sessions/${v.sessionId}/bill`)).body as {
    invoice: Body & { total: string; due: string; lockVersion: number; status: string };
    session: Body;
    lines: (Body & { net: string })[];
    discounts: Body[];
    payments: Body[];
  };

async function lock(v: Visit, client = cashier) {
  const res = await staff(client, 'POST', `/invoices/${v.invoiceId}/lock`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Body & { lockVersion: number; total: string };
}

const pay = (v: Visit, body: Body, client = cashier, key?: string) =>
  staff(client, 'POST', `/invoices/${v.invoiceId}/payments`, body, key);

async function stepUp(
  requester: Client,
  action: string,
  invoiceId: string,
  approverUsername: string,
  approverPin: string,
) {
  const res = await staff(requester, 'POST', '/auth/step-up', {
    action,
    entityType: 'invoice',
    entityId: invoiceId,
    approverUsername,
    approverPin,
    reason: 'Regular guest',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body['stepUpId']);
}

const staffAuth = {
  user: {
    id: '',
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
  permissions: new Map([['invoices.lock', { scopes: 'all' as const, sources: ['test'] }]]),
};
const ctxAt = (now = new Date()) => ({ key: randomUUID(), correlationId: randomUUID(), now });

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  staffAuth.user.id = fx.ownerId;
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('cash-b', ['cashier']);
  await fx.addUser('cash-c', ['cashier']);
  await fx.addUser('mgr-b', ['manager'], { pin: '2468' });
  await fx.addUser('owner-b', ['owner'], { pin: '1357' });
  cashier = await fx.loggedIn('cash-b');
  cashier2 = await fx.loggedIn('cash-c');
  manager = await fx.loggedIn('mgr-b');
  const cat = await staff(owner, 'POST', '/menu/categories', { name: 'Bill tests' });
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
  menu.odd = await item('Odd tart', '333');
});
afterAll(async () => {
  await fx.close();
});

describe('the bill of a session (I1, I2)', () => {
  it('exists from the start and follows the accepted lines while open', async () => {
    const v = await visit([
      { variantId: menu.coffee, qty: 2 },
      { variantId: menu.cake, qty: 1 },
    ]);
    let b = await bill(v);
    expect(b.invoice).toMatchObject({
      status: 'open',
      total: '1350.00',
      due: '1350.00',
      taxTotal: '0.00',
    });
    expect(b.lines.map((l) => [l['description'], l['billableQty'], l.net])).toEqual([
      ['Cappuccino Regular', 2, '1000.00'],
      ['Carrot cake Regular', 1, '350.00'],
    ]);
    await staff(owner, 'POST', `/lines/${v.lineIds[0] ?? ''}/cancel`, {
      qty: 1,
      made: false,
      reason: 'Changed mind',
    });
    b = await bill(v);
    expect(b.invoice.total).toBe('850.00');
    const list = await staff(cashier, 'GET', '/bills');
    expect(list.body['items']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: v.sessionId, total: '850.00' }),
      ]),
    );
  });

  it('lock is refused while a guest order waits; once locked, new rounds are refused (AT-10)', async () => {
    const v = await visit([{ variantId: menu.coffee, qty: 1 }]);
    const entry = await entryOf(v.tableId);
    const roundId = await guestRound(v, entry);
    const refused = await staff(cashier, 'POST', `/invoices/${v.invoiceId}/lock`, {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'PENDING_ROUNDS_EXIST' });

    await staff(owner, 'POST', `/rounds/${roundId}/reject`, { reason: 'Kitchen closing' });
    const locked = await lock(v);
    expect(locked).toMatchObject({
      lockVersion: 1,
      total: '500.00',
      unpickedUnits: 1,
      settledNow: false,
    });
    expect((await bill(v)).session['status']).toBe('checkout_locked');
    const late = await staff(owner, 'POST', `/sessions/${v.sessionId}/rounds`, {
      lines: [{ variantId: menu.cake, qty: 1, modifierOptionIds: [] }],
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'SESSION_LOCKED_FOR_CHECKOUT' });
    const cancel = await staff(owner, 'POST', `/lines/${v.lineIds[0] ?? ''}/cancel`, {
      qty: 1,
      made: false,
      reason: 'Not wanted',
    });
    expect(cancel.body).toMatchObject({ code: 'SESSION_LOCKED_FOR_CHECKOUT' });
    expect((await staff(cashier, 'POST', `/invoices/${v.invoiceId}/lock`, {})).body).toMatchObject({
      code: 'STALE_STATE',
    });
  });

  it('a guest submitting while the cashier locks: exactly one of them wins (CT-04)', async () => {
    await repeatRace(raceRuns(), async () => {
      const v = await visit([{ variantId: menu.coffee, qty: 1 }]);
      const entry = await entryOf(v.tableId);
      const { tokenId } = await withTransaction(fx.pool, (tx) => openOrJoinFromQr(tx, entry));
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: ({ index, pool, barrier }) =>
          withTransaction(pool, async (tx) => {
            await barrier.wait();
            if (index === 0) {
              const session = await lockActiveSession(tx, v.sessionId);
              return submitRound(tx, ctxAt(), {
                session,
                submitter: { kind: 'guest', tokenId },
                lines: [{ variantId: menu.cake, qty: 1, modifierOptionIds: [] }],
              });
            }
            return lockBill(tx, ctxAt(), staffAuth, v.invoiceId, () => Promise.resolve());
          }),
      });
      const { ok, failed } = tally(outcomes);
      expect(ok).toHaveLength(1);
      expect(['PENDING_ROUNDS_EXIST', 'SESSION_LOCKED_FOR_CHECKOUT']).toContain(failed[0]);
      const { rows } = await fx.pool.query<{ status: string; pending: number }>(
        `SELECT i.status, (SELECT count(*)::int FROM cl.order_rounds r WHERE r.session_id = i.session_id
                 AND r.status = 'pending_approval') AS pending FROM cl.invoices i WHERE i.id = $1`,
        [v.invoiceId],
      );
      // Never a locked bill with an order still waiting behind it.
      expect(rows[0]?.status === 'locked' ? rows[0].pending : 0).toBe(0);
    });
  });
});

async function entryOf(tableId: string): Promise<EntryPoint> {
  const { rows } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.qr_entry_points WHERE table_id = $1 AND is_active',
    [tableId],
  );
  return { id: rows[0]?.id ?? '', kind: 'table', tableId };
}

async function guestRound(v: Visit, entry: EntryPoint): Promise<string> {
  return withTransaction(fx.pool, async (tx) => {
    const { tokenId, session } = await openOrJoinFromQr(tx, entry);
    const round = await submitRound(tx, ctxAt(), {
      session,
      submitter: { kind: 'guest', tokenId },
      lines: [{ variantId: menu.cake, qty: 1, modifierOptionIds: [] }],
    });
    return round.id;
  });
}

describe('payments (P1) and settlement (I4)', () => {
  it('cash needs the till shift open; one shift at a time', async () => {
    const v = await visit([{ variantId: menu.cake, qty: 1 }]);
    const { lockVersion } = await lock(v);
    const refused = await pay(v, { lockVersion, method: 'cash', amount: '350', tendered: '500' });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'NO_OPEN_CASH_SHIFT' });
    expect((await staff(cashier, 'GET', '/cash-shifts/current')).body).toEqual({ shift: null });

    const opened = await staff(cashier, 'POST', '/cash-shifts', { openingFloat: '2000' });
    expect(opened.status).toBe(201);
    expect(
      (await staff(cashier2, 'POST', '/cash-shifts', { openingFloat: '0' })).body,
    ).toMatchObject({
      code: 'STALE_STATE',
    });
    const paid = await pay(v, { lockVersion, method: 'cash', amount: '350', tendered: '500' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body).toMatchObject({ settled: true, change: '150.00', due: '0.00' });
  });

  it('split tender cash + card settles once; change only on cash; the shift counts the cash kept (AT-35)', async () => {
    const printer = await staff(owner, 'POST', '/printers', {
      name: 'Bill test printer',
      connection: 'tcp',
      address: '127.0.0.1:9',
    });
    const printers = await staff(owner, 'GET', '/printers');
    const tillId = (printers.body['tills'] as { id: string }[])[0]?.id ?? '';
    expect(
      (await staff(owner, 'PUT', `/tills/${tillId}/printer`, { printerId: printer.body['id'] }))
        .status,
    ).toBe(204);

    const before = (await staff(cashier, 'GET', '/cash-shifts/current')).body['shift'] as Body;
    const v = await visit([
      { variantId: menu.coffee, qty: 2 },
      { variantId: menu.cake, qty: 1 },
    ]);
    const phone = await fx.customer.inject({
      method: 'GET',
      url: `/api/customer/v1/entry/${v.token}`,
    });
    const guestCookies = Object.fromEntries(phone.cookies.map((c) => [c.name, c.value]));
    const { lockVersion, total } = await lock(v);
    expect(total).toBe('1350.00');

    const card = await pay(v, {
      lockVersion,
      method: 'card_manual',
      amount: '500',
      reference: 'A12345',
    });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    expect(card.body).toMatchObject({ settled: false, due: '850.00', change: null });
    const tooMuch = await pay(v, {
      lockVersion,
      method: 'card_manual',
      amount: '900',
      reference: 'B1',
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body).toMatchObject({ code: 'AMOUNT_EXCEEDS_DUE' });

    const cash = await pay(v, { lockVersion, method: 'cash', amount: '850', tendered: '1000' });
    expect(cash.body).toMatchObject({ settled: true, change: '150.00', receiptQueued: true });
    const invoiceNo = String(cash.body['invoiceNo']);
    expect(invoiceNo).toMatch(/^INV-\d{4}-\d{6}$/);

    const b = await bill(v);
    expect(b.invoice).toMatchObject({
      status: 'settled',
      invoiceNo,
      paidTotal: '1350.00',
      due: '0.00',
    });
    expect(b.session['status']).toBe('settled');
    expect(b.payments.map((p) => [p['method'], p['amount'], p['change']])).toEqual([
      ['card_manual', '500.00', null],
      ['cash', '850.00', '150.00'],
    ]);
    const after = (await staff(cashier, 'GET', '/cash-shifts/current')).body['shift'] as Body;
    expect(Number(after['cashSales']) - Number(before['cashSales'])).toBe(850);

    // The visit ended: the guest's phone is signed out and the table is free again.
    const ended = await fx.customer.inject({
      method: 'GET',
      url: '/api/customer/v1/session',
      cookies: guestCookies,
    });
    expect(ended.statusCode).toBe(401);
    expect((await staff(owner, 'POST', `/tables/${v.tableId}/sessions`, {})).status).toBe(201);

    // Receipt: queued once at settlement, then a labelled reprint.
    const { rows: jobs } = await fx.pool.query<{ copy_no: number; is_reprint: boolean }>(
      `SELECT copy_no, is_reprint FROM cl.print_jobs WHERE document_type = 'receipt' AND document_id = $1 ORDER BY print_jobs.id`,
      [v.invoiceId],
    );
    expect(jobs).toEqual([{ copy_no: 1, is_reprint: false }]);
    const reprint = await staff(cashier, 'POST', `/invoices/${v.invoiceId}/receipt/reprint`, {});
    expect(reprint.status).toBe(201);
    expect(reprint.body['copyNo']).toBe(2);
    const { text } = decodeEscPos(
      renderReceipt(await receiptData(fx.pool, v.invoiceId), {
        width: 48,
        canCut: true,
        copyNo: 2,
        timeZone: 'Asia/Karachi',
      }),
    );
    expect(text).toContain('REPRINT #2');
    expect(text).toContain(invoiceNo);
    expect(text).toContain('Card ref A12345');
    expect(text).toMatch(/Change\s+150\.00/);
    expect(text).toMatch(/TOTAL\s+Rs 1,350\.00/);
    await staff(owner, 'PUT', `/tills/${tillId}/printer`, { printerId: null });
  });

  it('a retried payment request pays once, even when both arrive together (AT-11)', async () => {
    const v = await visit([{ variantId: menu.coffee, qty: 1 }]);
    const { lockVersion } = await lock(v);
    const key = randomUUID();
    const body = { lockVersion, method: 'card_manual', amount: '200', reference: 'R777' };
    const [a, b] = await Promise.all([pay(v, body, cashier, key), pay(v, body, cashier, key)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body['paymentId']).toBe(b.body['paymentId']);
    const again = await pay(v, body, cashier, key);
    expect(again.body['paymentId']).toBe(a.body['paymentId']);
    const { rows } = await fx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM cl.payments WHERE invoice_id = $1',
      [v.invoiceId],
    );
    expect(rows[0]?.n).toBe(1);
    expect((await bill(v)).invoice.due).toBe('300.00');
  });

  it('a payment against figures that changed gets BILL_CHANGED (AT-34)', async () => {
    const v = await visit([{ variantId: menu.coffee, qty: 2 }]);
    const first = await lock(v);
    // Reopening is for managers (RBAC.md: cashiers only if granted); free while nothing is paid.
    expect((await staff(manager, 'POST', `/invoices/${v.invoiceId}/reopen`, {})).status).toBe(200);
    await staff(owner, 'POST', `/lines/${v.lineIds[0] ?? ''}/cancel`, {
      qty: 1,
      made: false,
      reason: 'One less',
    });
    const second = await lock(v);
    expect(second.lockVersion).toBe(first.lockVersion + 2);
    const stale = await pay(v, {
      lockVersion: first.lockVersion,
      method: 'card_manual',
      amount: '1000',
      reference: 'X1',
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'BILL_CHANGED' });
    const fresh = await pay(v, {
      lockVersion: second.lockVersion,
      method: 'card_manual',
      amount: '500',
      reference: 'X1',
    });
    expect(fresh.body).toMatchObject({ settled: true });
  });

  it('a card number typed as the reference is refused and nothing is stored (AT-42)', async () => {
    const v = await visit([{ variantId: menu.coffee, qty: 1 }]);
    const { lockVersion } = await lock(v);
    const res = await pay(v, {
      lockVersion,
      method: 'card_manual',
      amount: '500',
      reference: '4111 1111 1111 1111',
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'CARD_NUMBER_NOT_ALLOWED' });
    const { rows } = await fx.pool.query(`SELECT 1 FROM cl.payments WHERE reference LIKE '%1111%'`);
    expect(rows).toEqual([]);
  });

  it('a transfer needs its transaction ID and a confirmation; it is not cash in the till (AT-59)', async () => {
    const v = await visit([{ variantId: menu.cake, qty: 2 }]);
    const { lockVersion } = await lock(v);
    const base = { lockVersion, method: 'transfer', amount: '700', provider: 'jazzcash' };
    const noRef = await pay(v, { ...base, confirmed: true });
    expect(noRef.status).toBe(400);
    expect(String(noRef.body['detail'])).toContain('transaction ID');
    expect((await pay(v, { ...base, reference: 'TX99812' })).status).toBe(400);
    const before = (await staff(cashier, 'GET', '/cash-shifts/current')).body['shift'] as Body;
    const ok = await pay(v, { ...base, reference: 'TX99812', confirmed: true });
    expect(ok.body).toMatchObject({ settled: true });
    const { rows } = await fx.pool.query<{
      transfer_provider: string;
      confirmed: boolean;
      cash_shift_id: string | null;
    }>(
      `SELECT p.transfer_provider, p.confirmed_by = u.id AS confirmed, p.cash_shift_id::text
         FROM cl.payments p JOIN cl.users u ON u.username = 'cash-b' WHERE p.invoice_id = $1`,
      [v.invoiceId],
    );
    expect(rows).toEqual([{ transfer_provider: 'jazzcash', confirmed: true, cash_shift_id: null }]);
    const after = (await staff(cashier, 'GET', '/cash-shifts/current')).body['shift'] as Body;
    expect(after['cashSales']).toBe(before['cashSales']);
  });

  it('the business date of a sale settled at 00:30 is the day before (AT-44)', async () => {
    const v = await visit([{ variantId: menu.cake, qty: 1 }]);
    const { lockVersion } = await lock(v);
    const at = new Date('2026-10-22T19:30:00Z'); // 00:30 on 23 Oct in Karachi
    const result = await withTransaction(fx.pool, (tx) =>
      takePayment(tx, ctxAt(at), staffAuth, v.invoiceId, {
        lockVersion,
        method: 'card_manual',
        amount: '350',
        reference: 'NIGHT1',
      }),
    );
    expect(result).toMatchObject({ settled: true, businessDate: '2026-10-22' });
    expect(result.invoiceNo).toMatch(/^INV-2026-/);
  });

  it('two cashiers paying the same bill: one payment, one settlement (CT-06)', async () => {
    await repeatRace(raceRuns(), async () => {
      const v = await visit([{ variantId: menu.coffee, qty: 1 }]);
      const { lockVersion } = await lock(v);
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: ({ pool, barrier }) =>
          withTransaction(pool, async (tx) => {
            await barrier.wait();
            return takePayment(tx, ctxAt(), staffAuth, v.invoiceId, {
              lockVersion,
              method: 'card_manual',
              amount: '500',
              reference: 'DUP',
            });
          }),
      });
      const { ok, failed } = tally(outcomes);
      expect(ok).toHaveLength(1);
      expect(failed).toEqual(['STALE_STATE']);
      const { rows } = await fx.pool.query<{ n: number; paid: string }>(
        `SELECT (SELECT count(*)::int FROM cl.payments WHERE invoice_id = $1) AS n,
                (SELECT paid_total::text FROM cl.invoices WHERE id = $1) AS paid`,
        [v.invoiceId],
      );
      expect(rows[0]).toEqual({ n: 1, paid: '500.00' });
    });
  });

  it('invoice numbers: only at settlement, gapless and unique under concurrent settlements (AT-117)', async () => {
    await repeatRace(raceRuns(), async () => {
      const visits: Visit[] = [];
      const versions: number[] = [];
      for (let i = 0; i < 4; i++) {
        const v = await visit([{ variantId: menu.cake, qty: 1 }]);
        versions.push((await lock(v)).lockVersion);
        visits.push(v);
      }
      const { rows: unnumbered } = await fx.pool.query(
        'SELECT 1 FROM cl.invoices WHERE id = ANY($1::bigint[]) AND invoice_no IS NOT NULL',
        [visits.map((v) => v.invoiceId)],
      );
      expect(unnumbered).toEqual([]);
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 4,
        body: ({ index, pool, barrier }) =>
          withTransaction(pool, async (tx) => {
            await barrier.wait();
            return takePayment(tx, ctxAt(), staffAuth, visits[index]?.invoiceId ?? '', {
              lockVersion: versions[index] ?? 0,
              method: 'card_manual',
              amount: '350',
              reference: `N${String(index)}`,
            });
          }),
      });
      const { ok, failed } = tally(outcomes);
      expect(failed).toEqual([]);
      const numbers = ok.map((r) => Number(String(r.invoiceNo).slice(-6))).sort((a, b) => a - b);
      expect(new Set(numbers).size).toBe(4);
      expect((numbers[3] ?? 0) - (numbers[0] ?? 0)).toBe(3);
    });
    // Across the whole file: every settled invoice of the year, numbered 1…n with no gap.
    const { rows } = await fx.pool.query<{ n: number; max: number }>(
      `SELECT count(*)::int AS n, max(right(invoice_no, 6)::int) AS max FROM cl.invoices
        WHERE invoice_no LIKE 'INV-2026-%'`,
    );
    expect(rows[0]?.max).toBe(rows[0]?.n);
  });
});

describe('reopening and discounts', () => {
  it('reopening a bill that has payments needs another person to approve it (AT-91)', async () => {
    const v = await visit([{ variantId: menu.coffee, qty: 2 }]);
    const { lockVersion } = await lock(v);
    await pay(v, { lockVersion, method: 'card_manual', amount: '300', reference: 'P1' });
    expect(
      (await staff(cashier, 'POST', `/invoices/${v.invoiceId}/reopen`, {})).body,
    ).toMatchObject({
      code: 'FORBIDDEN',
    });
    const refused = await staff(manager, 'POST', `/invoices/${v.invoiceId}/reopen`, {
      reason: 'Guest wants dessert',
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const stepUpId = await stepUp(
      manager,
      'invoice.reopen_with_payments',
      v.invoiceId,
      'owner-b',
      '1357',
    );
    const reopened = await staff(manager, 'POST', `/invoices/${v.invoiceId}/reopen`, {
      reason: 'Guest wants dessert',
      stepUpId,
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect((await bill(v)).invoice).toMatchObject({
      status: 'open',
      paidTotal: '300.00',
      due: '700.00',
    });
    const { rows } = await fx.pool.query<{ approved: boolean }>(
      `SELECT approved_by IS NOT NULL AS approved FROM cl.audit_events
        WHERE action = 'invoice.reopen' AND entity_id = $1`,
      [v.invoiceId],
    );
    expect(rows).toEqual([{ approved: true }]);
    await staff(owner, 'POST', `/sessions/${v.sessionId}/rounds`, {
      lines: [{ variantId: menu.cake, qty: 1, modifierOptionIds: [] }],
    });
    expect((await lock(v)).total).toBe('1350.00');
  });

  it('a discount above the role limit needs a step-up from someone whose limit covers it (AT-93)', async () => {
    const v = await visit([{ variantId: menu.coffee, qty: 2 }]);
    const discount = (value: string, stepUpId?: string) =>
      staff(cashier, 'POST', `/invoices/${v.invoiceId}/discounts`, {
        orderLineId: null,
        kind: 'percent',
        value,
        reason: 'Regular guest',
        ...(stepUpId ? { stepUpId } : {}),
      });
    const ten = await discount('10');
    expect(ten.status, JSON.stringify(ten.body)).toBe(201);
    expect(ten.body['amount']).toBe('100.00');
    // Another 5 % on the bill makes 15 %: over the cashier's 10 %.
    const over = await discount('5');
    expect(over.status).toBe(403);
    expect(over.body).toMatchObject({ code: 'STEP_UP_REQUIRED', limit: '10' });
    const ok = await discount(
      '5',
      await stepUp(cashier, 'discount.over_limit', v.invoiceId, 'mgr-b', '2468'),
    );
    expect(ok.status).toBe(201);
    // 25 % in all: more than the manager may allow; the owner may.
    const big = await discount(
      '10',
      await stepUp(cashier, 'discount.over_limit', v.invoiceId, 'mgr-b', '2468'),
    );
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ code: 'DISCOUNT_OVER_LIMIT' });
    const owned = await discount(
      '10',
      await stepUp(cashier, 'discount.over_limit', v.invoiceId, 'owner-b', '1357'),
    );
    expect(owned.status).toBe(201);
    expect((await bill(v)).invoice).toMatchObject({ discountTotal: '250.00', total: '750.00' });

    // Removing one brings the total back; the rest stay.
    const removed = await staff(
      cashier,
      'POST',
      `/discounts/${String(owned.body['discountId'])}/void`,
      {
        reason: 'Applied twice',
      },
    );
    expect(removed.status).toBe(200);
    expect((await bill(v)).invoice.total).toBe('850.00');
  });

  it('a discount on a locked bill gives it new figures and a new lock version', async () => {
    const v = await visit([{ variantId: menu.coffee, qty: 1 }]);
    const { lockVersion } = await lock(v);
    const d = await staff(cashier, 'POST', `/invoices/${v.invoiceId}/discounts`, {
      orderLineId: v.lineIds[0],
      kind: 'fixed',
      value: '50',
      reason: 'Cold coffee',
    });
    expect(d.body).toMatchObject({ amount: '50.00', lockVersion: lockVersion + 1 });
    expect(
      (await pay(v, { lockVersion, method: 'card_manual', amount: '450', reference: 'C' })).body,
    ).toMatchObject({
      code: 'BILL_CHANGED',
    });
    const b = await bill(v);
    expect(b.invoice).toMatchObject({ total: '450.00', lockVersion: lockVersion + 1 });
    expect(b.lines[0]).toMatchObject({ manualDiscount: '50.00', net: '450.00' });
  });

  it('a paisa total after a % discount is rounded to Rs 1 with its own line (AT-115)', async () => {
    const v = await visit([{ variantId: menu.odd, qty: 1 }]);
    await staff(cashier, 'POST', `/invoices/${v.invoiceId}/discounts`, {
      orderLineId: null,
      kind: 'percent',
      value: '10',
      reason: 'Staff',
    });
    await lock(v);
    const b = await bill(v);
    expect(b.invoice).toMatchObject({
      subtotal: '333.00',
      discountTotal: '33.30',
      roundingAdjustment: '0.30',
      total: '300.00',
    });
    expect(b.lines[0]).toMatchObject({ discountAlloc: '33.30', net: '299.70' });
  });

  it('comps: managers only; a fully comped bill settles when it is prepared (D-21)', async () => {
    const v = await visit([{ variantId: menu.cake, qty: 1 }]);
    const lineId = v.lineIds[0] ?? '';
    const byCashier = await staff(cashier, 'POST', `/invoices/${v.invoiceId}/comps`, {
      orderLineId: lineId,
      reason: 'Birthday',
    });
    expect(byCashier.status).toBe(403);
    const comp = await staff(manager, 'POST', `/invoices/${v.invoiceId}/comps`, {
      orderLineId: lineId,
      reason: 'Birthday',
    });
    expect(comp.status, JSON.stringify(comp.body)).toBe(201);
    expect((await bill(v)).lines[0]).toMatchObject({ isComp: true, net: '0.00' });
    const locked = await lock(v, manager);
    expect(locked).toMatchObject({ total: '0.00', settledNow: true });
    const b = await bill(v);
    expect(b.invoice.status).toBe('settled');
    expect(String(b.invoice['invoiceNo'])).toMatch(/^INV-/);
  });

  it('a session with nothing billable cannot be prepared', async () => {
    const v = await visit([{ variantId: menu.cake, qty: 1 }]);
    await staff(owner, 'POST', `/lines/${v.lineIds[0] ?? ''}/cancel`, {
      qty: 1,
      made: false,
      reason: 'Left',
    });
    const res = await staff(cashier, 'POST', `/invoices/${v.invoiceId}/lock`, {});
    expect(res.status).toBe(400);
    expect(String(res.body['detail'])).toContain('Nothing to bill');
  });
});

describe('the database guards the bill', () => {
  let admin: pg.Client;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: urlFor(fx.db.name) });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
  });

  const refused = async (sql: string, params: unknown[] = []) => {
    const error = await admin.query(sql, params).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    return error?.code ?? 'accepted';
  };

  it('a settled invoice, its lines, discounts and payments never change, even for the table owner (AT-97)', async () => {
    const v = await visit([{ variantId: menu.coffee, qty: 1 }]);
    await staff(cashier, 'POST', `/invoices/${v.invoiceId}/discounts`, {
      orderLineId: null,
      kind: 'fixed',
      value: '20',
      reason: 'Loyalty',
    });
    const { lockVersion } = await lock(v);
    await pay(v, { lockVersion, method: 'card_manual', amount: '480', reference: 'Z9' });
    const id = v.invoiceId;
    expect(await refused('UPDATE cl.invoices SET total = total WHERE id = $1', [id])).toBe('23001');
    expect(await refused('DELETE FROM cl.invoices WHERE id = $1', [id])).toBe('23001');
    expect(await refused('UPDATE cl.invoice_lines SET net = net WHERE invoice_id = $1', [id])).toBe(
      '23001',
    );
    expect(await refused('DELETE FROM cl.invoice_lines WHERE invoice_id = $1', [id])).toBe('23001');
    expect(
      await refused('UPDATE cl.discount_applications SET reason = $2 WHERE invoice_id = $1', [
        id,
        'x y z',
      ]),
    ).toBe('23001');
    expect(
      await refused(
        `INSERT INTO cl.discount_applications (invoice_id, kind, value, amount, reason, applied_by)
         VALUES ($1, 'fixed', 1, 1, 'late one', $2)`,
        [id, fx.ownerId],
      ),
    ).toBe('23001');
    expect(
      await refused('UPDATE cl.payments SET amount = amount WHERE invoice_id = $1', [id]),
    ).toBe('23001');
    expect(await refused('DELETE FROM cl.payments WHERE invoice_id = $1', [id])).toBe('23001');
  });

  it('tax stays zero and a payment needs a locked bill (AT-116)', async () => {
    const v = await visit([{ variantId: menu.cake, qty: 1 }]);
    expect(
      await refused('UPDATE cl.invoices SET tax_total = 10, total = total + 10 WHERE id = $1', [
        v.invoiceId,
      ]),
    ).toBe('23514');
    expect(
      await refused(
        `INSERT INTO cl.payments (invoice_id, method, amount, received_by, idempotency_key, business_date)
         VALUES ($1, 'card_manual', 1, $2, gen_random_uuid(), current_date)`,
        [v.invoiceId, fx.ownerId],
      ),
    ).toBe('23001');
  });
});
