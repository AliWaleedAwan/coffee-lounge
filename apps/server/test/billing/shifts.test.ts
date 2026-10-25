/**
 * Cash shifts (step 3.8): paid-in and paid-out, the expected-cash formula
 * (FINANCE_REPORTING.md §5), closing with a counted till, and a variance approved by
 * someone other than the cashier (AT-37). One shift is open at a time, so each test
 * opens and closes its own.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeShift } from '../../src/modules/billing/shifts.ts';
import { takePayment } from '../../src/modules/billing/payments.ts';
import { renderShiftReport } from '../../src/modules/printing/index.ts';
import { shiftReportData } from '../../src/modules/printing/shift-report-data.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { race, raceRuns, repeatRace, tally } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { decodeEscPos } from '../support/escpos/decoder.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let cashier: Client;
let cashier2: Client;
let manager: Client;
let coffee = '';

type Body = Record<string, unknown>;
async function staff(
  client: Client,
  method: 'GET' | 'POST' | 'PUT',
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

let tableNo = 0;
/** A table with one coffee (Rs 500), its bill prepared; returns the invoice and lock version. */
async function preparedBill(qty = 1): Promise<{ invoiceId: string; lockVersion: number }> {
  tableNo += 1;
  const t = await staff(owner, 'POST', '/tables', {
    code: `SH${String(tableNo)}`,
    name: `Shift ${String(tableNo)}`,
  });
  const s = await staff(owner, 'POST', `/tables/${String(t.body['id'])}/sessions`, {});
  await staff(owner, 'POST', `/sessions/${String(s.body['id'])}/rounds`, {
    lines: [{ variantId: coffee, qty, modifierOptionIds: [] }],
  });
  const { rows } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.invoices WHERE session_id = $1',
    [s.body['id']],
  );
  const invoiceId = rows[0]?.id ?? '';
  const locked = await staff(owner, 'POST', `/invoices/${invoiceId}/lock`, {});
  return { invoiceId, lockVersion: Number(locked.body['lockVersion']) };
}

async function pay(client: Client, body: Body) {
  const { invoiceId, lockVersion } = await preparedBill();
  return staff(client, 'POST', `/invoices/${invoiceId}/payments`, {
    lockVersion,
    amount: '500',
    ...body,
  });
}

async function openShift(client: Client, openingFloat = '5000') {
  const res = await staff(client, 'POST', '/cash-shifts', { openingFloat });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body['shiftId']);
}

const current = async (client: Client = owner) =>
  (await staff(client, 'GET', '/cash-shifts/current')).body['shift'] as Body | null;

const staffAuth = (userId: string) => ({
  user: {
    id: userId,
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
  permissions: new Map([['cash_shifts.operate', { scopes: 'all' as const, sources: ['test'] }]]),
});

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('till-a', ['cashier']);
  await fx.addUser('till-b', ['cashier']);
  await fx.addUser('till-mgr', ['manager'], { pin: '2468' });
  cashier = await fx.loggedIn('till-a');
  cashier2 = await fx.loggedIn('till-b');
  manager = await fx.loggedIn('till-mgr');
  const cat = await staff(owner, 'POST', '/menu/categories', { name: 'Shift tests' });
  const item = await staff(owner, 'POST', '/menu/items', {
    categoryId: cat.body['id'],
    name: 'Shift coffee',
    variants: [{ name: 'Regular', price: '500' }],
  });
  coffee = (item.body['variantIds'] as string[])[0] ?? '';
});
afterAll(async () => {
  await fx.close();
});

describe('a shift from float to approved count (AT-37)', () => {
  it('expected cash follows the formula; a variance waits for someone other than the cashier', async () => {
    const shiftId = await openShift(cashier);
    expect((await pay(cashier, { method: 'cash', tendered: '1000' })).body).toMatchObject({
      change: '500.00',
    });
    await pay(cashier, { method: 'card_manual', reference: 'AP1' });
    await pay(cashier, {
      method: 'transfer',
      provider: 'jazzcash',
      reference: 'TX1',
      confirmed: true,
    });
    const paidIn = await staff(cashier, 'POST', `/cash-shifts/${shiftId}/movements`, {
      kind: 'paid_in',
      amount: '200',
      reason: 'Change from the bank',
    });
    expect(paidIn.status, JSON.stringify(paidIn.body)).toBe(201);
    await staff(cashier, 'POST', `/cash-shifts/${shiftId}/movements`, {
      kind: 'paid_out',
      amount: '150',
      reason: 'Milk top-up, receipt kept',
    });
    // 5000 float + 500 cash − 0 refunds + 200 in − 150 out
    expect(await current(cashier)).toMatchObject({
      id: shiftId,
      status: 'open',
      cashSales: '500.00',
      paidIn: '200.00',
      paidOut: '150.00',
      expectedCash: '5550.00',
      card: '500.00',
      transfers: { jazzcash: '500.00', easypaisa: '0.00', bank: '0.00' },
    });

    const noReason = await staff(cashier, 'POST', `/cash-shifts/${shiftId}/close`, {
      countedCash: '5530',
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body).toMatchObject({ expectedCash: '5550.00', variance: '-20.00' });
    const closed = await staff(cashier, 'POST', `/cash-shifts/${shiftId}/close`, {
      countedCash: '5530',
      varianceReason: 'Gave too much change once',
    });
    expect(closed.body).toMatchObject({
      status: 'closed',
      expectedCash: '5550.00',
      countedCash: '5530.00',
      variance: '-20.00',
    });

    // Cash stops with the shift.
    expect((await pay(cashier, { method: 'cash', tendered: '500' })).body).toMatchObject({
      code: 'NO_OPEN_CASH_SHIFT',
    });
    expect(
      (
        await staff(cashier, 'POST', `/cash-shifts/${shiftId}/movements`, {
          kind: 'paid_in',
          amount: '1',
          reason: 'Late',
        })
      ).body,
    ).toMatchObject({ code: 'STALE_STATE' });

    expect((await staff(cashier, 'POST', `/cash-shifts/${shiftId}/approve`, {})).status).toBe(403);
    const approved = await staff(manager, 'POST', `/cash-shifts/${shiftId}/approve`, {
      note: 'Checked',
    });
    expect(approved.body).toMatchObject({ status: 'approved' });
    const shift = (await staff(manager, 'GET', `/cash-shifts/${shiftId}`)).body;
    expect(shift).toMatchObject({ status: 'approved', approvedBy: 'till-mgr', variance: '-20.00' });
    expect(shift['movements']).toHaveLength(2);
  });

  it('a manager PIN at the counter approves the variance at close; a balanced till needs nobody', async () => {
    const first = await openShift(cashier);
    await pay(cashier, { method: 'cash', tendered: '500' });
    const refused = await staff(cashier, 'POST', '/auth/step-up', {
      action: 'shift.variance',
      entityType: 'cash_shift',
      entityId: first,
      approverUsername: 'till-b',
      approverPin: '0000',
      reason: 'Over by 10',
    });
    expect(refused.status).not.toBe(201); // another cashier cannot approve
    const approval = await staff(cashier, 'POST', '/auth/step-up', {
      action: 'shift.variance',
      entityType: 'cash_shift',
      entityId: first,
      approverUsername: 'till-mgr',
      approverPin: '2468',
      reason: 'Over by 10',
    });
    expect(approval.status, JSON.stringify(approval.body)).toBe(201);
    const closed = await staff(cashier, 'POST', `/cash-shifts/${first}/close`, {
      countedCash: '5510',
      varianceReason: 'Guest left a tip in the till',
      stepUpId: approval.body['stepUpId'],
    });
    expect(closed.body).toMatchObject({ status: 'approved', variance: '10.00' });

    const second = await openShift(cashier2, '3000');
    const balanced = await staff(cashier2, 'POST', `/cash-shifts/${second}/close`, {
      countedCash: '3000',
    });
    expect(balanced.body).toMatchObject({ status: 'approved', variance: '0.00' });
    const { rows } = await fx.pool.query<{ approved_by: string | null }>(
      'SELECT approved_by::text FROM cl.cash_shifts WHERE id = $1',
      [second],
    );
    expect(rows).toEqual([{ approved_by: null }]);
  });

  it('nobody approves their own variance', async () => {
    const shiftId = await openShift(manager);
    const closed = await staff(manager, 'POST', `/cash-shifts/${shiftId}/close`, {
      countedCash: '4990',
      varianceReason: 'Counting error',
    });
    expect(closed.body).toMatchObject({ status: 'closed' });
    const own = await staff(manager, 'POST', `/cash-shifts/${shiftId}/approve`, {});
    expect(own.status).toBe(403);
    expect((await staff(owner, 'POST', `/cash-shifts/${shiftId}/approve`, {})).body).toMatchObject({
      status: 'approved',
    });
  });
});

describe('who may act on a shift', () => {
  it('a cashier works on their own shift only and sees only their own shifts', async () => {
    const shiftId = await openShift(cashier);
    expect(
      (await staff(cashier2, 'POST', '/cash-shifts', { openingFloat: '100' })).body,
    ).toMatchObject({
      code: 'STALE_STATE',
    });
    const foreign = await staff(cashier2, 'POST', `/cash-shifts/${shiftId}/close`, {
      countedCash: '5000',
    });
    expect(foreign.status).toBe(403);
    expect((await staff(cashier2, 'GET', `/cash-shifts/${shiftId}`)).status).toBe(403);
    const mine = (await staff(cashier2, 'GET', '/cash-shifts')).body['items'] as Body[];
    expect(mine.every((s) => s['cashier'] === 'till-b')).toBe(true);
    const all = (await staff(manager, 'GET', '/cash-shifts')).body['items'] as Body[];
    expect(new Set(all.map((s) => s['cashier'])).size).toBeGreaterThan(1);

    const tooMuch = await staff(cashier, 'POST', `/cash-shifts/${shiftId}/movements`, {
      kind: 'paid_out',
      amount: '5000.01',
      reason: 'More than the till holds',
    });
    expect(tooMuch.status).toBe(400);
    // A manager may close any shift (e.g. the cashier went home).
    expect(
      (await staff(manager, 'POST', `/cash-shifts/${shiftId}/close`, { countedCash: '5000' })).body,
    ).toMatchObject({ status: 'approved' });
  });
});

describe('the till count is final', () => {
  it('a cash payment and a close at once: the count includes the payment or the payment is refused', async () => {
    await repeatRace(raceRuns(), async () => {
      const shiftId = await openShift(owner, '1000');
      const bill = await preparedBill();
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: ({ index, pool, barrier }) =>
          withTransaction(pool, async (tx) => {
            await barrier.wait();
            const ctx = { key: randomUUID(), correlationId: randomUUID(), now: new Date() };
            return index === 0
              ? takePayment(tx, ctx, staffAuth(fx.ownerId), bill.invoiceId, {
                  lockVersion: bill.lockVersion,
                  method: 'cash',
                  amount: '500',
                  tendered: '500',
                })
              : closeShift(tx, ctx, staffAuth(fx.ownerId), shiftId, {
                  countedCash: '1000',
                  varianceReason: 'Race test',
                });
          }),
      });
      const { failed } = tally(outcomes);
      expect(failed.filter((f) => f !== 'NO_OPEN_CASH_SHIFT')).toEqual([]);
      const { rows } = await fx.pool.query<{ expected: string; paid: string }>(
        `SELECT s.expected_cash::text AS expected,
                (SELECT coalesce(sum(amount), 0)::text FROM cl.payments WHERE cash_shift_id = s.id) AS paid
           FROM cl.cash_shifts s WHERE s.id = $1`,
        [shiftId],
      );
      // The figures the cashier counted against include exactly the cash the shift holds.
      expect(Number(rows[0]?.expected)).toBe(1000 + Number(rows[0]?.paid));
    });
  });

  it('the database refuses changes to a closed count and cash into a closed shift', async () => {
    const shiftId = await openShift(cashier);
    await staff(cashier, 'POST', `/cash-shifts/${shiftId}/close`, { countedCash: '5000' });
    const admin = new pg.Client({ connectionString: urlFor(fx.db.name) });
    await admin.connect();
    try {
      const code = (sql: string, params: unknown[]) =>
        admin.query(sql, params).then(
          () => 'accepted',
          (e: unknown) => (e as { code?: string }).code ?? 'error',
        );
      expect(
        await code('UPDATE cl.cash_shifts SET counted_cash = 1 WHERE id = $1', [shiftId]),
      ).toBe('23001');
      expect(await code(`UPDATE cl.cash_shifts SET status = 'open' WHERE id = $1`, [shiftId])).toBe(
        '23001',
      );
      expect(await code('DELETE FROM cl.cash_shifts WHERE id = $1', [shiftId])).toBe('23001');
      expect(
        await code(
          `INSERT INTO cl.cash_movements (shift_id, kind, amount, reason, actor) VALUES ($1, 'paid_in', 1, 'x', $2)`,
          [shiftId, fx.ownerId],
        ),
      ).toBe('23001');
      const { invoiceId } = await preparedBill();
      expect(
        await code(
          `INSERT INTO cl.payments (invoice_id, method, amount, tendered, change_due, received_by, cash_shift_id,
             idempotency_key, business_date)
           VALUES ($1, 'cash', 1, 1, 0, $2, $3, gen_random_uuid(), current_date)`,
          [invoiceId, fx.ownerId, shiftId],
        ),
      ).toBe('23001');
    } finally {
      await admin.end();
    }
  });
});

describe('the shift report', () => {
  it('prints at close on the receipt printer, and reprints labelled', async () => {
    const printer = await staff(owner, 'POST', '/printers', {
      name: 'Shift test printer',
      connection: 'tcp',
      address: '127.0.0.1:9',
    });
    const tillId =
      ((await staff(owner, 'GET', '/printers')).body['tills'] as { id: string }[])[0]?.id ?? '';
    await staff(owner, 'PUT', `/tills/${tillId}/printer`, { printerId: printer.body['id'] });
    try {
      const shiftId = await openShift(cashier, '2000');
      await pay(cashier, { method: 'cash', tendered: '500' });
      await staff(cashier, 'POST', `/cash-shifts/${shiftId}/movements`, {
        kind: 'paid_out',
        amount: '120',
        reason: 'Ice from the shop next door',
      });
      const closed = await staff(cashier, 'POST', `/cash-shifts/${shiftId}/close`, {
        countedCash: '2370',
        varianceReason: 'Short by 10, not found',
      });
      expect(closed.body).toMatchObject({ reportQueued: true, variance: '-10.00' });
      const reprint = await staff(cashier, 'POST', `/cash-shifts/${shiftId}/report/reprint`, {});
      expect(reprint.body).toMatchObject({ copyNo: 2 });
      const { text } = decodeEscPos(
        renderShiftReport(await shiftReportData(fx.pool, shiftId), {
          width: 48,
          canCut: true,
          copyNo: 1,
          timeZone: 'Asia/Karachi',
        }),
      );
      expect(text).toMatch(/EXPECTED CASH\s+2,380\.00/);
      expect(text).toMatch(/Counted cash\s+2,370\.00/);
      expect(text).toMatch(/VARIANCE\s+-10\.00/);
      expect(text).toContain('Variance waiting for approval by a manager.');
      expect(text).toContain('Paid out: Ice from the shop next door');
    } finally {
      await staff(owner, 'PUT', `/tills/${tillId}/printer`, { printerId: null });
    }
  });
});
