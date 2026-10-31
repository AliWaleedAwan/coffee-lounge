/**
 * Refunds and payment-method corrections (Phase 5 step 5.2, ORDER_STATE_MACHINE.md P2):
 * the invoice never changes, someone else approves (AT-36), never more than was paid
 * (AT-90), back by the payment's method, cash refunds lower expected cash (AT-37 still
 * holds), a correction is a reversal plus a new entry (AT-71), two refunds of one bill at
 * once never pay out twice (CT).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordRefund } from '../../src/modules/billing/refunds.ts';
import { renderRefundSlip } from '../../src/modules/printing/documents.ts';
import { refundSlipData } from '../../src/modules/printing/refund-slip-data.ts';
import { findLedgerMismatches } from '../../src/modules/ledger/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { race, raceRuns, repeatRace, tally } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { decodeEscPos } from '../support/escpos/decoder.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let cashier: Client;
let waiter: Client;
let coffee = '';
let shiftId = '';

type Body = Record<string, unknown>;
async function staff(
  client: Client,
  method: 'GET' | 'POST',
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

let tableNo = 0;
/** A table with `qty` coffees (Rs 500 each), paid in full by `payment`; returns the bill. */
async function paidBill(qty: number, payment: Body) {
  tableNo += 1;
  const t = await staff(owner, 'POST', '/tables', {
    code: `RF${String(tableNo)}`,
    name: `Refund ${String(tableNo)}`,
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
  const paid = await staff(cashier, 'POST', `/invoices/${invoiceId}/payments`, {
    lockVersion: Number(locked.body['lockVersion']),
    amount: String(qty * 500),
    ...payment,
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const view = await staff(cashier, 'GET', `/invoices/${invoiceId}/refunds`);
  return {
    invoiceId,
    paymentId: String(paid.body['paymentId']),
    lineId: String(((view.body['lines'] as Body[])[0] ?? {})['id']),
  };
}

async function approval(
  requester: Client,
  invoiceId: string,
  action = 'refund.approve',
  approver = 'rf-owner',
  pin = '1357',
) {
  return staff(requester, 'POST', '/auth/step-up', {
    action,
    entityType: 'invoice',
    entityId: invoiceId,
    approverUsername: approver,
    approverPin: pin,
    reason: 'Guest complaint',
  });
}
async function approved(requester: Client, invoiceId: string, action = 'refund.approve') {
  const res = await approval(requester, invoiceId, action);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body['stepUpId']);
}

const figures = async () =>
  (
    await fx.pool.query<Body>(
      `SELECT cash_sales::text, cash_refunds::text, expected_cash::text, card::text, jazzcash::text
         FROM cl.cash_shift_figures WHERE shift_id = $1`,
      [shiftId],
    )
  ).rows[0];

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('rf-cash', ['cashier']);
  await fx.addUser('rf-mgr', ['manager'], { pin: '2468' });
  await fx.addUser('rf-owner', ['owner'], { pin: '1357' });
  await fx.addUser('rf-waiter', ['waiter']);
  cashier = await fx.loggedIn('rf-cash');
  waiter = await fx.loggedIn('rf-waiter');
  const cat = await staff(owner, 'POST', '/menu/categories', { name: 'Refund tests' });
  const item = await staff(owner, 'POST', '/menu/items', {
    categoryId: cat.body['id'],
    name: 'Refund coffee',
    variants: [{ name: 'Regular', price: '500' }],
  });
  coffee = (item.body['variantIds'] as string[])[0] ?? '';
  const shift = await staff(cashier, 'POST', '/cash-shifts', { openingFloat: '5000' });
  shiftId = String(shift.body['shiftId']);
});
afterAll(async () => {
  await fx.close();
});

describe('a refund of a settled bill (AT-36)', () => {
  it('leaves the invoice as it was, pays back by cash from the shift, and posts the ledger', async () => {
    const bill = await paidBill(2, { method: 'cash', tendered: '1000' });
    const snapshot = async () =>
      (
        await fx.pool.query(
          `SELECT i.*, (SELECT json_agg(l ORDER BY l.id) FROM cl.invoice_lines l WHERE l.invoice_id = i.id) AS lines
             FROM cl.invoices i WHERE i.id = $1`,
          [bill.invoiceId],
        )
      ).rows[0] as unknown;
    const before = await snapshot();
    const shiftBefore = await figures();

    const stepUpId = await approved(cashier, bill.invoiceId);
    const res = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '500',
      reason: 'Coffee was cold',
      lines: [{ invoiceLineId: bill.lineId, qty: 1, amount: '500' }],
      stepUpId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ kind: 'refund', amount: '500.00', method: 'cash' });
    expect(res.body['refundNo']).toMatch(/^RF-\d{4}-00001$/);
    expect(await snapshot()).toEqual(before);

    // Expected cash = float + cash sales − cash refunds + in − out.
    expect(await figures()).toMatchObject({
      cash_sales: shiftBefore?.['cash_sales'],
      cash_refunds: '500.00',
      expected_cash: (Number(shiftBefore?.['expected_cash']) - 500).toFixed(2),
    });
    const { rows: ledger } = await fx.pool.query(
      `SELECT entry_type, direction, amount::text, channel FROM cl.ledger_entries
        WHERE source_type = 'refund' AND source_id = $1`,
      [res.body['refundId']],
    );
    expect(ledger).toEqual([
      { entry_type: 'refund', direction: 'out', amount: '500.00', channel: 'cash' },
    ]);
    const { rows: audit } = await fx.pool.query<Body>(
      `SELECT a.action, a.reason, u.username AS approver FROM cl.audit_events a JOIN cl.users u ON u.id = a.approved_by
        WHERE a.entity_type = 'invoice' AND a.entity_id = $1 AND a.action = 'payment.refund'`,
      [bill.invoiceId],
    );
    expect(audit).toEqual([
      { action: 'payment.refund', reason: 'Coffee was cold', approver: 'rf-owner' },
    ]);

    // The slip: refund number, original invoice, the line, method and approver.
    const slip = decodeEscPos(
      renderRefundSlip(await refundSlipData(fx.pool, String(res.body['refundId'])), {
        width: 48,
        canCut: true,
        copyNo: 1,
        timeZone: 'Asia/Karachi',
      }),
    ).text;
    const { rows: inv } = await fx.pool.query<{ invoice_no: string }>(
      'SELECT invoice_no FROM cl.invoices WHERE id = $1',
      [bill.invoiceId],
    );
    expect(slip).toContain(String(res.body['refundNo']));
    expect(slip).toContain(`Invoice: ${inv[0]?.invoice_no ?? ''}`);
    expect(slip).toMatch(/1 {2}Refund coffee Regular +500\.00/);
    expect(slip).toMatch(/Paid back by +Cash/);
    expect(slip).toMatch(/Approved by +rf-owner/);

    const view = await staff(cashier, 'GET', `/invoices/${bill.invoiceId}/refunds`);
    expect(view.body['invoice']).toMatchObject({ refunded: '500.00', paidTotal: '1000.00' });
    expect(view.body['lines']).toEqual([
      expect.objectContaining({ qty: 2, refundedQty: 1, refundedAmount: '500.00' }),
    ]);
    expect(view.body['payments']).toEqual([
      expect.objectContaining({ method: 'cash', refunded: '500.00', refundable: '500.00' }),
    ]);
  });

  it('needs someone else with payments.refund to approve, on this device', async () => {
    const bill = await paidBill(1, { method: 'card_manual', reference: 'AP1' });
    // The owner cannot approve their own request.
    const self = await staff(owner, 'POST', '/auth/step-up', {
      action: 'refund.approve',
      entityType: 'invoice',
      entityId: bill.invoiceId,
      approverUsername: OWNER.username,
      approverPin: '0000',
      reason: 'Self',
    });
    expect(self.status).toBe(403);
    // A manager may not approve refunds unless granted (D-13, I-14).
    expect(
      (await approval(cashier, bill.invoiceId, 'refund.approve', 'rf-mgr', '2468')).status,
    ).toBe(403);
    // No approval, or one for another action, is refused.
    const body = {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '100',
      reason: 'Goodwill',
      stepUpId: '999999',
    };
    expect(
      (await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, body)).body,
    ).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    const wrongAction = await approved(cashier, bill.invoiceId, 'payment.correct');
    expect(
      (
        await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
          ...body,
          stepUpId: wrongAction,
        })
      ).body,
    ).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // A waiter may not even ask.
    expect((await staff(waiter, 'POST', `/invoices/${bill.invoiceId}/refunds`, body)).status).toBe(
      403,
    );
    expect((await staff(waiter, 'GET', `/invoices/${bill.invoiceId}/refunds`)).status).toBe(403);
    // An approval is used once.
    const once = await approved(cashier, bill.invoiceId);
    expect(
      (
        await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
          ...body,
          stepUpId: once,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
          ...body,
          stepUpId: once,
        })
      ).body,
    ).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('a retried request with the same key refunds once', async () => {
    const bill = await paidBill(1, { method: 'card_manual', reference: 'AP2' });
    const key = randomUUID();
    const body = {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '500',
      reason: 'Wrong order',
      reference: 'RV22',
      stepUpId: await approved(cashier, bill.invoiceId),
    };
    const first = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, body, key);
    const again = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, body, key);
    expect(first.status).toBe(201);
    expect(again.body).toEqual(first.body);
    const { rows } = await fx.pool.query('SELECT 1 FROM cl.refunds WHERE invoice_id = $1', [
      bill.invoiceId,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('never more than was paid (AT-90)', () => {
  it('refuses a refund above what is left of the payment, and lines above what is left', async () => {
    const bill = await paidBill(2, { method: 'card_manual' });
    const over = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '1000.01',
      reason: 'Too much',
      stepUpId: await approved(cashier, bill.invoiceId),
    });
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject({ code: 'REFUND_EXCEEDS_PAID', refundable: '1000.00' });

    const ok = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '700',
      reason: 'Partly',
      lines: [{ invoiceLineId: bill.lineId, qty: 1, amount: '500' }],
      stepUpId: await approved(cashier, bill.invoiceId),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const rest = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '300.01',
      reason: 'Rest',
      stepUpId: await approved(cashier, bill.invoiceId),
    });
    expect(rest.body).toMatchObject({ code: 'REFUND_EXCEEDS_PAID', refundable: '300.00' });
    const lines = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '300',
      reason: 'Two more',
      lines: [{ invoiceLineId: bill.lineId, qty: 2, amount: '300' }],
      stepUpId: await approved(cashier, bill.invoiceId),
    });
    expect(lines.body).toMatchObject({ code: 'REFUND_EXCEEDS_PAID', refundableQty: 1 });
    const moreThanRefund = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '100',
      reason: 'Lines more than refund',
      lines: [{ invoiceLineId: bill.lineId, qty: 1, amount: '200' }],
      stepUpId: await approved(cashier, bill.invoiceId),
    });
    expect(moreThanRefund.status).toBe(400);
    const last = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '300',
      reason: 'The rest',
      stepUpId: await approved(cashier, bill.invoiceId),
    });
    expect(last.status).toBe(201);
  });

  it('refunds only settled bills, and only their own payments', async () => {
    tableNo += 1;
    const t = await staff(owner, 'POST', '/tables', {
      code: `RF${String(tableNo)}`,
      name: 'Open bill',
    });
    const s = await staff(owner, 'POST', `/tables/${String(t.body['id'])}/sessions`, {});
    const { rows } = await fx.pool.query<{ id: string }>(
      'SELECT id::text FROM cl.invoices WHERE session_id = $1',
      [s.body['id']],
    );
    const open = rows[0]?.id ?? '';
    const other = await paidBill(1, { method: 'card_manual' });
    const refused = await staff(cashier, 'POST', `/invoices/${open}/refunds`, {
      kind: 'refund',
      paymentId: other.paymentId,
      amount: '1',
      reason: 'Not settled',
      stepUpId: await approved(cashier, open),
    });
    expect(refused.status).toBe(409);
    const mine = await paidBill(1, { method: 'card_manual' });
    const foreign = await staff(cashier, 'POST', `/invoices/${mine.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: other.paymentId,
      amount: '1',
      reason: 'Wrong payment',
      stepUpId: await approved(cashier, mine.invoiceId),
    });
    expect(foreign.status).toBe(400);
  });
});

describe('back by the payment method', () => {
  it('a transfer refund names the transaction; a card number is never accepted', async () => {
    const bill = await paidBill(1, {
      method: 'transfer',
      provider: 'jazzcash',
      reference: 'TX9',
      confirmed: true,
    });
    const base = {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '500',
      reason: 'Order wrong',
    };
    const noRef = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      ...base,
      stepUpId: await approved(cashier, bill.invoiceId),
    });
    expect(noRef.status).toBe(400);
    const card = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      ...base,
      reference: '4111111111111111',
      stepUpId: await approved(cashier, bill.invoiceId),
    });
    expect(card.body).toMatchObject({ code: 'CARD_NUMBER_NOT_ALLOWED' });
    const ok = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      ...base,
      reference: 'TXBACK1',
      stepUpId: await approved(cashier, bill.invoiceId),
    });
    expect(ok.body).toMatchObject({ method: 'transfer', provider: 'jazzcash' });
    const { rows } = await fx.pool.query(
      `SELECT channel, transfer_provider FROM cl.ledger_entries WHERE source_key = 'refund:' || $1`,
      [ok.body['refundId']],
    );
    expect(rows).toEqual([{ channel: 'transfer', transfer_provider: 'jazzcash' }]);
  });
});

describe('payment-method corrections', () => {
  it('cash recorded, card taken: the drawer and the card total follow; the ledger reverses and posts again', async () => {
    const bill = await paidBill(1, { method: 'cash', tendered: '500' });
    const before = await figures();
    const res = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'method_correction',
      paymentId: bill.paymentId,
      method: 'card_manual',
      reference: 'AP77',
      reason: 'Guest paid by card',
      stepUpId: await approved(cashier, bill.invoiceId, 'payment.correct'),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'method_correction',
      amount: '500.00',
      method: 'card_manual',
    });
    const after = await figures();
    expect(Number(after?.['cash_sales'])).toBe(Number(before?.['cash_sales']) - 500);
    expect(Number(after?.['expected_cash'])).toBe(Number(before?.['expected_cash']) - 500);
    expect(Number(after?.['card'])).toBe(Number(before?.['card']) + 500);

    // Card turns out to be JazzCash: the correction's own entry is reversed this time.
    const again = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'method_correction',
      paymentId: bill.paymentId,
      method: 'transfer',
      provider: 'jazzcash',
      reference: 'TX55',
      reason: 'It was JazzCash after all',
      stepUpId: await approved(cashier, bill.invoiceId, 'payment.correct'),
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const { rows } = await fx.pool.query<Body>(
      `SELECT e.source_key, e.entry_type, e.direction, e.channel, e.transfer_provider, o.source_key AS reverses
         FROM cl.ledger_entries e LEFT JOIN cl.ledger_entries o ON o.id = e.reverses_entry_id
        WHERE e.source_key = 'payment:' || $1 OR e.source_key LIKE 'refund:' || $2 || '%'
           OR e.source_key LIKE 'refund:' || $3 || '%'
        ORDER BY e.id`,
      [bill.paymentId, res.body['refundId'], again.body['refundId']],
    );
    const first = String(res.body['refundId']);
    const second = String(again.body['refundId']);
    expect(rows).toEqual([
      {
        source_key: `payment:${bill.paymentId}`,
        entry_type: 'sale_receipt',
        direction: 'in',
        channel: 'cash',
        transfer_provider: null,
        reverses: null,
      },
      {
        source_key: `refund:${first}:reversal`,
        entry_type: 'reversal',
        direction: 'out',
        channel: 'cash',
        transfer_provider: null,
        reverses: `payment:${bill.paymentId}`,
      },
      {
        source_key: `refund:${first}`,
        entry_type: 'sale_receipt',
        direction: 'in',
        channel: 'card',
        transfer_provider: null,
        reverses: null,
      },
      {
        source_key: `refund:${second}:reversal`,
        entry_type: 'reversal',
        direction: 'out',
        channel: 'card',
        transfer_provider: null,
        reverses: `refund:${first}`,
      },
      {
        source_key: `refund:${second}`,
        entry_type: 'sale_receipt',
        direction: 'in',
        channel: 'transfer',
        transfer_provider: 'jazzcash',
        reverses: null,
      },
    ]);
    const final = await figures();
    expect(Number(final?.['card'])).toBe(Number(before?.['card']));
    expect(Number(final?.['jazzcash'])).toBe(Number(before?.['jazzcash']) + 500);

    // A refund now goes back by JazzCash; after it the method can no longer change.
    const refund = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: bill.paymentId,
      amount: '200',
      reference: 'TXB2',
      reason: 'Partly',
      stepUpId: await approved(cashier, bill.invoiceId),
    });
    expect(refund.body).toMatchObject({ method: 'transfer', provider: 'jazzcash' });
    const late = await staff(cashier, 'POST', `/invoices/${bill.invoiceId}/refunds`, {
      kind: 'method_correction',
      paymentId: bill.paymentId,
      method: 'cash',
      reason: 'Too late',
      stepUpId: await approved(cashier, bill.invoiceId, 'payment.correct'),
    });
    expect(late.status).toBe(400);
    const same = await paidBill(1, { method: 'card_manual' });
    const unchanged = await staff(cashier, 'POST', `/invoices/${same.invoiceId}/refunds`, {
      kind: 'method_correction',
      paymentId: same.paymentId,
      method: 'card_manual',
      reason: 'Same method',
      stepUpId: await approved(cashier, same.invoiceId, 'payment.correct'),
    });
    expect(unchanged.status).toBe(400);
    expect(await findLedgerMismatches(fx.pool)).toEqual([]);
  });
});

describe('two refunds of one bill at once (CT)', () => {
  it('never pays out more than the payment', async () => {
    const { rows: users } = await fx.pool.query<{ id: string; username: string }>(
      `SELECT id::text, username FROM cl.users WHERE username IN ('rf-cash', 'rf-owner')`,
    );
    const cashierId = users.find((u) => u.username === 'rf-cash')?.id ?? '';
    const ownerB = users.find((u) => u.username === 'rf-owner')?.id ?? '';
    const { rows: devices } = await fx.pool.query<{ id: string }>(
      'SELECT id::text FROM cl.devices LIMIT 1',
    );
    const deviceId = devices[0]?.id ?? '';
    const auth = {
      user: {
        id: cashierId,
        displayName: 'Cashier',
        username: 'rf-cash',
        isOwner: false,
        mustChangePassword: false,
      },
      device: {
        id: deviceId,
        name: 'test',
        kind: 'reception' as const,
        ownership: 'shop' as const,
        status: 'active' as const,
      },
      permissions: new Map([
        ['payments.refund_request', { scopes: 'all' as const, sources: ['test'] }],
      ]),
    };
    await repeatRace(raceRuns(), async () => {
      const bill = await paidBill(1, { method: 'card_manual' });
      const stepUps: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const { rows } = await fx.pool.query<{ id: string }>(
          `INSERT INTO cl.step_up_approvals (action, requested_by, approved_by, device_id, entity_type, entity_id, reason)
           VALUES ('refund.approve', $1, $2, $3, 'invoice', $4, 'race') RETURNING id::text`,
          [cashierId, ownerB, deviceId, bill.invoiceId],
        );
        stepUps.push(rows[0]?.id ?? '');
      }
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: ({ index, pool, barrier }) =>
          withTransaction(pool, async (tx) => {
            await barrier.wait();
            return recordRefund(
              tx,
              { key: randomUUID(), correlationId: randomUUID(), now: new Date() },
              auth,
              bill.invoiceId,
              {
                kind: 'refund',
                paymentId: bill.paymentId,
                amount: '500',
                reason: 'Race',
                stepUpId: stepUps[index] ?? '',
              },
            );
          }),
      });
      const { ok, failed } = tally(outcomes);
      expect(ok).toHaveLength(1);
      expect(failed).toEqual(['REFUND_EXCEEDS_PAID']);
      const { rows } = await fx.pool.query<{ s: string }>(
        `SELECT sum(amount)::text AS s FROM cl.refunds WHERE invoice_id = $1`,
        [bill.invoiceId],
      );
      expect(rows[0]?.s).toBe('500.00');
    });
  });
});

describe('the shift', () => {
  it('a cash refund needs an open shift; a correction to or from cash only in the payment’s own shift', async () => {
    const old = await paidBill(1, { method: 'cash', tendered: '500' });
    const card = await paidBill(1, { method: 'card_manual' });
    const current = await staff(cashier, 'GET', '/cash-shifts/current');
    const expected = String((current.body['shift'] as Body)['expectedCash']);
    const closed = await staff(cashier, 'POST', `/cash-shifts/${shiftId}/close`, {
      countedCash: expected,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const noShift = await staff(cashier, 'POST', `/invoices/${old.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: old.paymentId,
      amount: '100',
      reason: 'No shift',
      stepUpId: await approved(cashier, old.invoiceId),
    });
    expect(noShift.body).toMatchObject({ code: 'NO_OPEN_CASH_SHIFT' });

    await staff(cashier, 'POST', '/cash-shifts', { openingFloat: '3000' });
    const earlier = await staff(cashier, 'POST', `/invoices/${old.invoiceId}/refunds`, {
      kind: 'method_correction',
      paymentId: old.paymentId,
      method: 'card_manual',
      reason: 'Too late for the drawer',
      stepUpId: await approved(cashier, old.invoiceId, 'payment.correct'),
    });
    expect(earlier.status).toBe(400);
    const toCash = await staff(cashier, 'POST', `/invoices/${card.invoiceId}/refunds`, {
      kind: 'method_correction',
      paymentId: card.paymentId,
      method: 'cash',
      reason: 'Was cash',
      stepUpId: await approved(cashier, card.invoiceId, 'payment.correct'),
    });
    expect(toCash.status).toBe(400);
    // Never more cash out than the till should hold.
    const shiftNow = String(
      ((await staff(cashier, 'GET', '/cash-shifts/current')).body['shift'] as Body)['id'],
    );
    await staff(cashier, 'POST', `/cash-shifts/${shiftNow}/movements`, {
      kind: 'paid_out',
      amount: '2950',
      reason: 'To the bank',
    });
    const short = await staff(cashier, 'POST', `/invoices/${old.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: old.paymentId,
      amount: '100',
      reason: 'Till too low',
      stepUpId: await approved(cashier, old.invoiceId),
    });
    expect(short.status).toBe(400);
    expect(String(short.body['detail'])).toContain('Only Rs 50.00 should be in the till');
    await staff(cashier, 'POST', `/cash-shifts/${shiftNow}/movements`, {
      kind: 'paid_in',
      amount: '2950',
      reason: 'Back from the bank',
    });
    // A cash refund of yesterday's sale is paid from today's drawer.
    const refund = await staff(cashier, 'POST', `/invoices/${old.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: old.paymentId,
      amount: '100',
      reason: 'Came back next day',
      stepUpId: await approved(cashier, old.invoiceId),
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const now = await staff(cashier, 'GET', '/cash-shifts/current');
    expect(now.body['shift']).toMatchObject({ cashRefunds: '100.00', expectedCash: '2900.00' });
    expect(await findLedgerMismatches(fx.pool)).toEqual([]);
  });

  it('a correction out of cash needs that cash still in the till (found by the ×100 run, step 6.7)', async () => {
    const sale = await paidBill(1, { method: 'cash', tendered: '500' });
    const shift = String(
      ((await staff(cashier, 'GET', '/cash-shifts/current')).body['shift'] as Body)['id'],
    );
    const expected = async () =>
      String(
        ((await staff(cashier, 'GET', '/cash-shifts/current')).body['shift'] as Body)[
          'expectedCash'
        ],
      );
    const all = await expected();
    // Everything but Rs 100 goes to the bank; the Rs 500 sale cannot leave the cash total now.
    const out = (Number(all) - 100).toFixed(2);
    await staff(cashier, 'POST', `/cash-shifts/${shift}/movements`, {
      kind: 'paid_out',
      amount: out,
      reason: 'To the bank',
    });
    const correct = async () =>
      staff(cashier, 'POST', `/invoices/${sale.invoiceId}/refunds`, {
        kind: 'method_correction',
        paymentId: sale.paymentId,
        method: 'card_manual',
        reason: 'Was card',
        stepUpId: await approved(cashier, sale.invoiceId, 'payment.correct'),
      });
    const refused = await correct();
    expect(refused.status).toBe(400);
    expect(String(refused.body['detail'])).toContain('Only Rs 100.00 should be in the till');
    expect(await expected()).toBe('100.00');
    await staff(cashier, 'POST', `/cash-shifts/${shift}/movements`, {
      kind: 'paid_in',
      amount: out,
      reason: 'Back from the bank',
    });
    expect((await correct()).status).toBe(201);
    expect(await expected()).toBe((Number(all) - 500).toFixed(2));
  });

  it('finds settled bills to refund by number or table', async () => {
    const found = await staff(cashier, 'GET', '/refunds/bills?q=Refund 1');
    const bills = found.body['bills'] as Body[];
    expect(bills.length).toBeGreaterThan(0);
    expect(bills.every((b) => typeof b['invoiceNo'] === 'string')).toBe(true);
    expect((await staff(waiter, 'GET', '/refunds/bills')).status).toBe(403);
  });
});
