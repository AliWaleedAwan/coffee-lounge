/**
 * Expenses (Phase 5 step 5.3): one ledger entry per expense (AT-71); void = a reversal entry,
 * the original kept (AT-107); a correction voids and records again, traceable both ways
 * (AT-23, expense part); cash from the till is also the shift's paid-out with no second
 * entry (P5-6); attached bills are checked, kept on disk and read back (P5-3); categories;
 * access by permission.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLedgerMismatches } from '../../src/modules/ledger/index.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let cashier: Client;
let manager: Client;
let clerk: Client;
let waiter: Client;
let today = '';
const category: Record<string, string> = {};

type Body = Record<string, unknown>;
async function call(
  client: Client,
  method: 'GET' | 'POST' | 'PATCH',
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
async function record(body: Body, client: Client = owner) {
  return call(client, 'POST', '/expenses', {
    categoryId: category['Rent'],
    amount: '45000',
    paidVia: 'transfer',
    provider: 'bank',
    ...body,
  });
}
async function attach(client: Client, expenseId: string, bytes: Buffer, type: string) {
  const res = await client.call({
    method: 'PUT',
    url: `/api/staff/v1/expenses/${expenseId}/attachment`,
    headers: { 'content-type': type },
    payload: bytes,
  });
  return { status: res.statusCode, body: res.json<Body>() };
}
const day = (n: number) => {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('a small photo of a bill'),
]);
const PDF = Buffer.from('%PDF-1.4\n% the electricity bill\n');

const entries = async (expenseId: string) =>
  (
    await fx.pool.query<Body>(
      `SELECT e.source_key, e.entry_type, e.direction, e.amount::text, e.channel, e.transfer_provider,
              c.name AS category, o.source_key AS reverses
         FROM cl.ledger_entries e LEFT JOIN cl.expense_categories c ON c.id = e.category_id
         LEFT JOIN cl.ledger_entries o ON o.id = e.reverses_entry_id
        WHERE e.source_type = 'expense' AND e.source_id = $1 ORDER BY e.id`,
      [expenseId],
    )
  ).rows;

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('ex-cash', ['cashier']);
  await fx.addUser('ex-mgr', ['manager']);
  await fx.addUser('ex-clerk', ['inventory_clerk']);
  await fx.addUser('ex-waiter', ['waiter']);
  cashier = await fx.loggedIn('ex-cash');
  manager = await fx.loggedIn('ex-mgr');
  clerk = await fx.loggedIn('ex-clerk');
  waiter = await fx.loggedIn('ex-waiter');
  today = await businessDateOf(fx.pool, new Date());
  const list = await call(owner, 'GET', '/expense-categories');
  for (const c of list.body['items'] as { id: string; name: string }[]) category[c.name] = c.id;
});
afterAll(async () => {
  await fx.close();
});

describe('categories', () => {
  it('starts with a list the owner edits; a used category is switched off, never deleted', async () => {
    expect(Object.keys(category)).toEqual(
      expect.arrayContaining(['Rent', 'Utilities', 'Wages', 'Repairs & maintenance', 'Other']),
    );
    const created = await call(owner, 'POST', '/expense-categories', { name: 'Internet' });
    expect(created.status).toBe(201);
    expect((await call(owner, 'POST', '/expense-categories', { name: ' internet ' })).status).toBe(
      400,
    );
    const renamed = await call(
      owner,
      'PATCH',
      `/expense-categories/${String(created.body['id'])}`,
      {
        name: 'Internet & phone',
      },
    );
    expect(renamed.body).toMatchObject({ name: 'Internet & phone', isActive: true });
    await call(owner, 'PATCH', `/expense-categories/${String(created.body['id'])}`, {
      isActive: false,
    });
    const refused = await record({ categoryId: created.body['id'] });
    expect(refused.status).toBe(400);
  });
});

describe('recording and the ledger (AT-71)', () => {
  it('numbers the expense and posts one entry out by its channel and category', async () => {
    const res = await record({ payee: 'Landlord', reference: 'OCT-RENT', note: 'October rent' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ businessDate: today, paidOutOfShift: false });
    expect(res.body['expenseNo']).toMatch(/^EXP-\d{4}-00001$/);
    const id = String(res.body['id']);
    expect(await entries(id)).toEqual([
      {
        source_key: `expense:${id}`,
        entry_type: 'expense',
        direction: 'out',
        amount: '45000.00',
        channel: 'transfer',
        transfer_provider: 'bank',
        category: 'Rent',
        reverses: null,
      },
    ]);
    const read = await call(owner, 'GET', `/expenses/${id}`);
    expect(read.body).toMatchObject({
      category: 'Rent',
      payee: 'Landlord',
      status: 'recorded',
      attachment: null,
    });
  });

  it('dates an expense today or up to 31 days back, never ahead', async () => {
    expect(
      (await record({ businessDate: day(-31), paidVia: 'cash', provider: undefined })).status,
    ).toBe(201);
    expect(
      (await record({ businessDate: day(-32), paidVia: 'cash', provider: undefined })).status,
    ).toBe(400);
    expect(
      (await record({ businessDate: day(1), paidVia: 'cash', provider: undefined })).status,
    ).toBe(400);
    expect((await record({ paidVia: 'transfer', provider: undefined })).status).toBe(400);
    expect((await record({ paidVia: 'card' })).status).toBe(400);
    expect((await record({ amount: '0' })).status).toBe(400);
  });
});

describe('void and correction (AT-107, AT-23)', () => {
  it('a void posts the reversal and keeps the original as it was', async () => {
    const res = await record({
      categoryId: category['Utilities'],
      amount: '12500',
      payee: 'LESCO',
    });
    const id = String(res.body['id']);
    const voided = await call(owner, 'POST', `/expenses/${id}/void`, { reason: 'Entered twice' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await call(owner, 'POST', `/expenses/${id}/void`, { reason: 'Again' })).status).toBe(
      409,
    );
    expect(await entries(id)).toEqual([
      expect.objectContaining({ entry_type: 'expense', direction: 'out', amount: '12500.00' }),
      expect.objectContaining({
        source_key: `expense:${id}:void`,
        entry_type: 'reversal',
        direction: 'in',
        amount: '12500.00',
        category: 'Utilities',
        reverses: `expense:${id}`,
      }),
    ]);
    expect((await call(owner, 'GET', `/expenses/${id}`)).body).toMatchObject({
      status: 'voided',
      amount: '12500.00',
      payee: 'LESCO',
      voidReason: 'Entered twice',
      voidedBy: 'Owner',
    });
    // Never edited, never deleted.
    await expect(
      fx.pool.query('UPDATE cl.expenses SET amount = 1 WHERE id = $1', [id]),
    ).rejects.toThrow();
    await expect(fx.pool.query('DELETE FROM cl.expenses WHERE id = $1', [id])).rejects.toThrow();
  });

  it('a correction voids and records again, each pointing at the other, with the bill carried over', async () => {
    const res = await record({
      categoryId: category['Repairs & maintenance'],
      amount: '8000',
      payee: 'Fridge man',
    });
    const id = String(res.body['id']);
    expect((await attach(owner, id, JPEG, 'image/jpeg')).status).toBe(200);
    const corrected = await call(owner, 'POST', `/expenses/${id}/correct`, {
      reason: 'The bill says 6,800',
      categoryId: category['Repairs & maintenance'],
      amount: '6800',
      payee: 'Fridge man',
      paidVia: 'cash',
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    const newId = String(corrected.body['id']);
    expect((await call(owner, 'GET', `/expenses/${id}`)).body).toMatchObject({
      status: 'voided',
      amount: '8000.00',
      replacedByNo: corrected.body['expenseNo'],
    });
    const fresh = await call(owner, 'GET', `/expenses/${newId}`);
    expect(fresh.body).toMatchObject({
      status: 'recorded',
      amount: '6800.00',
      paidVia: 'cash',
      replacesNo: res.body['expenseNo'],
      attachment: { type: 'image/jpeg', size: JPEG.length },
    });
    const file = await owner.call({
      method: 'GET',
      url: `/api/staff/v1/expenses/${newId}/attachment`,
    });
    expect(file.rawPayload).toEqual(JPEG);
    const { rows } = await fx.pool.query<{ action: string }>(
      `SELECT action FROM cl.audit_events WHERE entity_type = 'expense' AND entity_id IN ($1, $2) ORDER BY id`,
      [id, newId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'expense.record',
      'expense.attach',
      'expense.void',
      'expense.record',
    ]);
  });

  it('the period lists both, with totals of what is recorded only', async () => {
    const list = await call(owner, 'GET', `/expenses?from=${day(-40)}&to=${today}`);
    const items = list.body['items'] as Body[];
    expect(items.some((e) => e['status'] === 'voided')).toBe(true);
    const recorded = items.filter((e) => e['status'] === 'recorded');
    const sum = recorded.reduce((s, e) => s + Number(e['amount']), 0);
    expect(Number(list.body['total'])).toBe(sum);
    const voidedOnly = await call(
      owner,
      'GET',
      `/expenses?from=${day(-40)}&to=${today}&status=voided`,
    );
    expect((voidedOnly.body['items'] as Body[]).every((e) => e['status'] === 'voided')).toBe(true);
  });
});

describe('cash from the till (P5-6)', () => {
  it('is the open shift’s paid-out with one ledger entry; a void while the shift is open pays it back', async () => {
    const noShift = await record({
      categoryId: category['Supplies'],
      amount: '600',
      paidVia: 'cash',
      provider: undefined,
      fromTill: true,
    });
    expect(noShift.body).toMatchObject({ code: 'NO_OPEN_CASH_SHIFT' });

    const shift = await call(cashier, 'POST', '/cash-shifts', { openingFloat: '5000' });
    const shiftId = String(shift.body['shiftId']);
    expect((await record({ paidVia: 'card', provider: undefined, fromTill: true })).status).toBe(
      400,
    );
    const tooMuch = await record({
      amount: '5000.01',
      paidVia: 'cash',
      provider: undefined,
      fromTill: true,
    });
    expect(String(tooMuch.body['detail'])).toContain('Only Rs 5000.00 should be in the till');
    expect(
      (
        await record({
          paidVia: 'cash',
          provider: undefined,
          fromTill: true,
          businessDate: day(-1),
        })
      ).status,
    ).toBe(400);
    const res = await record({
      categoryId: category['Supplies'],
      amount: '600',
      paidVia: 'cash',
      provider: undefined,
      fromTill: true,
      payee: 'Hardware shop',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body['paidOutOfShift']).toBe(true);
    const current = await call(cashier, 'GET', '/cash-shifts/current');
    expect(current.body['shift']).toMatchObject({ paidOut: '600.00', expectedCash: '4400.00' });
    const { rows: movements } = await fx.pool.query<Body>(
      `SELECT kind, amount::text, reason FROM cl.cash_movements WHERE shift_id = $1 ORDER BY id`,
      [shiftId],
    );
    expect(movements).toEqual([
      {
        kind: 'paid_out',
        amount: '600.00',
        reason: `Expense ${String(res.body['expenseNo'])}: Supplies · Hardware shop`,
      },
    ]);
    const { rows: cashEntries } = await fx.pool.query(
      `SELECT 1 FROM cl.ledger_entries WHERE source_type = 'cash_movement'`,
    );
    expect(cashEntries).toEqual([]);

    const id = String(res.body['id']);
    const voided = await call(owner, 'POST', `/expenses/${id}/void`, {
      reason: 'Shop gave the money back',
    });
    expect(voided.body).toMatchObject({ backInTill: true });
    expect((await call(cashier, 'GET', '/cash-shifts/current')).body['shift']).toMatchObject({
      paidIn: '600.00',
      expectedCash: '5000.00',
    });

    // A till expense corrected in the same shift: back in, and out again at the right amount.
    const again = await record({
      categoryId: category['Supplies'],
      amount: '300',
      paidVia: 'cash',
      provider: undefined,
      fromTill: true,
    });
    const corrected = await call(owner, 'POST', `/expenses/${String(again.body['id'])}/correct`, {
      reason: 'It was 350',
      categoryId: category['Supplies'],
      amount: '350',
      paidVia: 'cash',
      fromTill: true,
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    expect((await call(cashier, 'GET', '/cash-shifts/current')).body['shift']).toMatchObject({
      expectedCash: '4650.00',
    });
    expect(await findLedgerMismatches(fx.pool)).toEqual([]);
  });
});

describe('attached bills (P5-3)', () => {
  it('takes a JPEG, PNG or PDF up to 5 MB, by its content, and keeps it on disk', async () => {
    const res = await record({ categoryId: category['Utilities'], amount: '9100', payee: 'SNGPL' });
    const id = String(res.body['id']);
    const fake = await attach(owner, id, Buffer.from('not really a png'), 'image/png');
    expect(fake.status).toBe(400);
    const big = await attach(
      owner,
      id,
      Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]),
      'application/pdf',
    );
    expect([400, 413]).toContain(big.status);
    expect((await attach(owner, id, PDF, 'text/plain')).status).toBe(400);
    const ok = await attach(owner, id, PDF, 'application/pdf');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ type: 'application/pdf', size: PDF.length });
    const { rows } = await fx.pool.query<{ attachment_path: string }>(
      'SELECT attachment_path FROM cl.expenses WHERE id = $1',
      [id],
    );
    const path = rows[0]?.attachment_path ?? '';
    expect(path).toMatch(
      new RegExp(`^expenses/${String(res.body['expenseNo'])}-[0-9a-f]{12}\\.pdf$`),
    );
    expect(readFileSync(join(fx.filesDir, path))).toEqual(PDF);
    const file = await owner.call({
      method: 'GET',
      url: `/api/staff/v1/expenses/${id}/attachment`,
    });
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.rawPayload).toEqual(PDF);
    await call(owner, 'POST', `/expenses/${id}/void`, { reason: 'Wrong month' });
    expect((await attach(owner, id, JPEG, 'image/jpeg')).status).toBe(409);
    expect(
      (await owner.call({ method: 'GET', url: `/api/staff/v1/expenses/${id}/attachment` }))
        .statusCode,
    ).toBe(200);
  });
});

describe('who may (RBAC.md: expenses.read / expenses.manage)', () => {
  it('only the owner by default; a manager or clerk once granted', async () => {
    for (const client of [waiter, cashier, clerk, manager]) {
      expect((await call(client, 'GET', '/expenses')).status).toBe(403);
      expect((await record({}, client)).status).toBe(403);
      expect((await call(client, 'GET', '/expense-categories')).status).toBe(403);
    }
    const { rows } = await fx.pool.query<{ id: string }>(
      `SELECT id::text FROM cl.users WHERE username = 'ex-mgr'`,
    );
    const granted = await owner.call({
      method: 'PUT',
      url: `/api/staff/v1/users/${rows[0]?.id ?? ''}/permission-overrides/expenses.read`,
      payload: { effect: 'grant', reason: 'Keeps the books' },
    });
    expect(granted.statusCode, granted.body).toBe(204);
    expect((await call(manager, 'GET', '/expenses')).status).toBe(200);
    expect((await record({}, manager)).status).toBe(403);
  });
});
