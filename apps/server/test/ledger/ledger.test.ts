/**
 * The operational ledger (Phase 5 step 5.1): one entry per money movement, written in the
 * same transaction as its source (AT-71, AT-110's refund cash-in); running balance per
 * channel = Σ entries for any range (AT-121); entries never change (AT-96); manual entries
 * and reversals by the owner only (AT-18); the nightly check reports, never fixes.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLedgerMismatches } from '../../src/modules/ledger/index.ts';
import { makeTasks } from '../../src/worker/runner.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let cashier: Client;
let clerk: Client;
let manager: Client;
let waiter: Client;
let coffee = '';
let milk = { id: '', packId: '' };
let shiftId = '';
let today = '';
const MIGRATION = new URL('../../migrations/0023_ledger.sql', import.meta.url);

type Body = Record<string, unknown>;
async function call(
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
async function ok(client: Client, method: 'GET' | 'POST', path: string, payload?: object) {
  const res = await call(client, method, path, payload);
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

let tableNo = 0;
/** A table with one coffee (Rs 500) paid by `body`'s method; returns the payment id. */
async function sale(body: Body): Promise<string> {
  tableNo += 1;
  const t = await ok(owner, 'POST', '/tables', {
    code: `LG${String(tableNo)}`,
    name: `Ledger ${String(tableNo)}`,
  });
  const s = await ok(owner, 'POST', `/tables/${String(t['id'])}/sessions`, {});
  await ok(owner, 'POST', `/sessions/${String(s['id'])}/rounds`, {
    lines: [{ variantId: coffee, qty: 1, modifierOptionIds: [] }],
  });
  const { rows } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.invoices WHERE session_id = $1',
    [s['id']],
  );
  const invoiceId = rows[0]?.id ?? '';
  const locked = await ok(owner, 'POST', `/invoices/${invoiceId}/lock`, {});
  await ok(cashier, 'POST', `/invoices/${invoiceId}/payments`, {
    lockVersion: Number(locked['lockVersion']),
    amount: '500',
    ...body,
  });
  const { rows: paid } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.payments WHERE invoice_id = $1',
    [invoiceId],
  );
  return paid[0]?.id ?? '';
}

async function receive(fields: Body, packQty = '6', lineCost = '1650') {
  return ok(clerk, 'POST', '/purchase-receipts', {
    startStockControl: [milk.id],
    ...fields,
    lines: [{ itemId: milk.id, packSizeId: milk.packId, packQty, lineCost }],
  }) as Promise<{ receiptId: string; lines: { lineId: string }[] }>;
}

async function entriesOf(sourceKey: string) {
  const { rows } = await fx.pool.query<Body>(
    `SELECT entry_type, direction, amount::text, channel, transfer_provider, business_date::text AS date
       FROM cl.ledger_entries WHERE source_key = $1`,
    [sourceKey],
  );
  return rows;
}

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('lg-cash', ['cashier']);
  await fx.addUser('lg-clerk', ['inventory_clerk']);
  await fx.addUser('lg-mgr', ['manager'], { pin: '2468' });
  await fx.addUser('lg-waiter', ['waiter']);
  cashier = await fx.loggedIn('lg-cash');
  clerk = await fx.loggedIn('lg-clerk');
  manager = await fx.loggedIn('lg-mgr');
  waiter = await fx.loggedIn('lg-waiter');
  today = await businessDateOf(fx.pool, new Date());
  const cat = await ok(owner, 'POST', '/menu/categories', { name: 'Ledger tests' });
  const item = await ok(owner, 'POST', '/menu/items', {
    categoryId: cat['id'],
    name: 'Ledger coffee',
    variants: [{ name: 'Regular', price: '500' }],
  });
  coffee = (item['variantIds'] as string[])[0] ?? '';
  const inv = await ok(clerk, 'POST', '/inventory/items', {
    sku: 'lg-milk',
    name: 'Ledger milk',
    baseUom: 'ml',
  });
  const pack = await ok(clerk, 'POST', `/inventory/items/${String(inv['id'])}/pack-sizes`, {
    name: '1 L carton',
    qty: '1',
    uom: 'l',
  });
  milk = { id: inv['id'] as string, packId: pack['id'] as string };
  shiftId = String(
    (await ok(cashier, 'POST', '/cash-shifts', { openingFloat: '5000' }))['shiftId'],
  );
});
afterAll(async () => {
  await fx.close();
});

describe('automatic entries (AT-71)', () => {
  it('posts one entry per payment, by its method, on its business date', async () => {
    const cash = await sale({ method: 'cash', tendered: '1000' });
    const card = await sale({ method: 'card_manual', reference: 'AP1' });
    const jazz = await sale({
      method: 'transfer',
      provider: 'jazzcash',
      reference: 'TX1',
      confirmed: true,
    });
    expect(await entriesOf(`payment:${cash}`)).toEqual([
      {
        entry_type: 'sale_receipt',
        direction: 'in',
        amount: '500.00',
        channel: 'cash',
        transfer_provider: null,
        date: today,
      },
    ]);
    expect((await entriesOf(`payment:${card}`))[0]).toMatchObject({
      channel: 'card',
      amount: '500.00',
    });
    expect((await entriesOf(`payment:${jazz}`))[0]).toMatchObject({
      channel: 'transfer',
      transfer_provider: 'jazzcash',
    });
  });

  it('posts cash paid in and out of the drawer', async () => {
    await ok(cashier, 'POST', `/cash-shifts/${shiftId}/movements`, {
      kind: 'paid_in',
      amount: '200',
      reason: 'Change from the bank',
    });
    await ok(cashier, 'POST', `/cash-shifts/${shiftId}/movements`, {
      kind: 'paid_out',
      amount: '150',
      reason: 'Milk top-up',
    });
    const { rows } = await fx.pool.query<Body>(
      `SELECT e.entry_type, e.direction, e.amount::text, e.channel FROM cl.cash_movements m
         JOIN cl.ledger_entries e ON e.source_key = 'cash_movement:' || m.id
        WHERE m.shift_id = $1 ORDER BY m.id`,
      [shiftId],
    );
    expect(rows).toEqual([
      { entry_type: 'cash_in', direction: 'in', amount: '200.00', channel: 'cash' },
      { entry_type: 'cash_out', direction: 'out', amount: '150.00', channel: 'cash' },
    ]);
  });

  it('posts a receipt paid now, not one on credit; reversing it reverses its payment', async () => {
    const paid = await receive({ paidNow: true, paymentChannel: 'cash' });
    const credit = await receive({ paidNow: false });
    expect(await entriesOf(`purchase_receipt:${paid.receiptId}`)).toEqual([
      {
        entry_type: 'purchase_payment',
        direction: 'out',
        amount: '1650.00',
        channel: 'cash',
        transfer_provider: null,
        date: today,
      },
    ]);
    expect(await entriesOf(`purchase_receipt:${credit.receiptId}`)).toEqual([]);

    const wrong = await receive({ paidNow: true, paymentChannel: 'transfer' }, '60', '16500');
    await ok(clerk, 'POST', `/purchase-receipts/${wrong.receiptId}/reverse`, {
      reason: 'Typed 60 instead of 6',
    });
    const { rows } = await fx.pool.query<Body>(
      `SELECT e.entry_type, e.direction, e.amount::text, e.channel, o.source_key AS reverses
         FROM cl.ledger_entries e LEFT JOIN cl.ledger_entries o ON o.id = e.reverses_entry_id
        WHERE e.source_type = 'purchase_receipt' AND e.source_id = $1 ORDER BY e.id`,
      [wrong.receiptId],
    );
    expect(rows).toEqual([
      {
        entry_type: 'purchase_payment',
        direction: 'out',
        amount: '16500.00',
        channel: 'transfer',
        reverses: null,
      },
      {
        entry_type: 'reversal',
        direction: 'in',
        amount: '16500.00',
        channel: 'transfer',
        reverses: `purchase_receipt:${wrong.receiptId}`,
      },
    ]);
  });

  it('posts a supplier refund as cash in by its channel (AT-110 ledger part)', async () => {
    const posted = await receive({ paidNow: false });
    const res = await ok(clerk, 'POST', `/purchase-receipts/${posted.receiptId}/returns`, {
      lineId: posted.lines[0]?.lineId,
      qty: '2',
      uom: 'l',
      reason: 'Two cartons leaking',
      refundAmount: '550',
      refundChannel: 'cash',
    });
    const { rows } = await fx.pool.query<{ id: string }>(
      'SELECT id::text FROM cl.supplier_returns ORDER BY supplier_returns.id DESC LIMIT 1',
    );
    expect(res['qtyBase']).toBe('2000.0000');
    expect(await entriesOf(`supplier_return:${rows[0]?.id ?? ''}`)).toEqual([
      {
        entry_type: 'cash_in',
        direction: 'in',
        amount: '550.00',
        channel: 'cash',
        transfer_provider: null,
        date: today,
      },
    ]);
    // A return without a refund moves no money.
    await ok(clerk, 'POST', `/purchase-receipts/${posted.receiptId}/returns`, {
      lineId: posted.lines[0]?.lineId,
      qty: '1',
      uom: 'l',
      reason: 'Dented, credit next time',
    });
    const { rows: last } = await fx.pool.query<{ id: string }>(
      'SELECT id::text FROM cl.supplier_returns ORDER BY supplier_returns.id DESC LIMIT 1',
    );
    expect(await entriesOf(`supplier_return:${last[0]?.id ?? ''}`)).toEqual([]);
  });

  it('never posts a source twice, and every source has exactly its entry', async () => {
    const { rows: before } = await fx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM cl.ledger_entries',
    );
    // The history backfill and a replayed trigger post nothing new (P5-2).
    await fx.pool.query(
      `SELECT cl.ledger_post('sale_receipt', 'in', p.amount, 'cash', NULL, p.business_date, 'payment', p.id,
                             'payment:' || p.id, p.received_by) FROM cl.payments p`,
    );
    const { rows: after } = await fx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM cl.ledger_entries',
    );
    expect(after).toEqual(before);
    expect(await findLedgerMismatches(fx.pool)).toEqual([]);
  });
});

describe('entries never change (AT-96 ledger part)', () => {
  it('refuses UPDATE and DELETE', async () => {
    await expect(fx.pool.query(`UPDATE cl.ledger_entries SET amount = 1`)).rejects.toThrow();
    await expect(fx.pool.query(`DELETE FROM cl.ledger_entries`)).rejects.toThrow();
  });
});

describe('manual entries and reversals (D-31)', () => {
  it('lets the owner post an entry with a reason and reverse it once', async () => {
    const key = randomUUID();
    const body = {
      direction: 'in',
      amount: '20000',
      channel: 'transfer',
      provider: 'bank',
      memo: 'Bank account at start',
    };
    const posted = await call(owner, 'POST', '/ledger/entries', body, key);
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(posted.body['entryNo']).toMatch(/^LE-\d{4}-\d{6}$/);
    expect((await call(owner, 'POST', '/ledger/entries', body, key)).body).toEqual(posted.body);

    const id = posted.body['id'] as string;
    const reversed = await call(owner, 'POST', `/ledger/entries/${id}/reverse`, {
      reason: 'Wrong account',
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(201);
    const again = await call(owner, 'POST', `/ledger/entries/${id}/reverse`, { reason: 'Again' });
    expect(again.status).toBe(409);
    const { rows } = await fx.pool.query<Body>(
      `SELECT entry_type, direction, amount::text, channel, transfer_provider, memo
         FROM cl.ledger_entries WHERE id IN ($1, $2) ORDER BY id`,
      [id, reversed.body['id']],
    );
    expect(rows).toEqual([
      {
        entry_type: 'adjustment',
        direction: 'in',
        amount: '20000.00',
        channel: 'transfer',
        transfer_provider: 'bank',
        memo: 'Bank account at start',
      },
      {
        entry_type: 'reversal',
        direction: 'out',
        amount: '20000.00',
        channel: 'transfer',
        transfer_provider: 'bank',
        memo: 'Wrong account',
      },
    ]);
    const { rows: audit } = await fx.pool.query<{ action: string }>(
      `SELECT action FROM cl.audit_events WHERE entity_type = 'ledger_entry' AND entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.map((a) => a.action)).toEqual(['ledger.adjustment', 'ledger.reverse']);
  });

  it('refuses a transfer without its provider, a bad amount, and reversing an automatic entry', async () => {
    const noProvider = await call(owner, 'POST', '/ledger/entries', {
      direction: 'in',
      amount: '100',
      channel: 'transfer',
      memo: 'Missing provider',
    });
    expect(noProvider.status).toBe(400);
    const cashProvider = await call(owner, 'POST', '/ledger/entries', {
      direction: 'in',
      amount: '100',
      channel: 'cash',
      provider: 'bank',
      memo: 'Provider on cash',
    });
    expect(cashProvider.status).toBe(400);
    expect(
      (
        await call(owner, 'POST', '/ledger/entries', {
          direction: 'out',
          amount: '0',
          channel: 'cash',
          memo: 'Zero',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(owner, 'POST', '/ledger/entries', {
          direction: 'out',
          amount: '5',
          channel: 'cash',
          memo: 'x',
        })
      ).status,
    ).toBe(400);
    const { rows } = await fx.pool.query<{ id: string }>(
      `SELECT id::text FROM cl.ledger_entries WHERE source_type = 'payment' LIMIT 1`,
    );
    const auto = await call(owner, 'POST', `/ledger/entries/${rows[0]?.id ?? ''}/reverse`, {
      reason: 'Try it',
    });
    expect(auto.status).toBe(400);
    expect(
      (await call(owner, 'POST', '/ledger/entries/999999999/reverse', { reason: 'Nothing' }))
        .status,
    ).toBe(404);
  });

  it('refuses the ledger to a waiter, and manual entries to a manager (AT-18)', async () => {
    expect((await call(waiter, 'GET', '/ledger')).status).toBe(403);
    expect(
      (
        await call(waiter, 'POST', '/ledger/entries', {
          direction: 'in',
          amount: '5',
          channel: 'cash',
          memo: 'Nope',
        })
      ).status,
    ).toBe(403);
    expect((await call(cashier, 'GET', '/ledger')).status).toBe(403);
    // ledger.read is grantable to a manager, not granted by default; ledger.manage is the owner's.
    expect((await call(manager, 'GET', '/ledger')).status).toBe(403);
    expect(
      (
        await call(manager, 'POST', '/ledger/entries', {
          direction: 'in',
          amount: '5',
          channel: 'cash',
          memo: 'Nope',
        })
      ).status,
    ).toBe(403);
  });
});

describe('running balance per channel (AT-121)', () => {
  it('equals the sum of entries for any range', async () => {
    // History on earlier days, as the backfill would have posted it.
    const earlier = (n: number) => {
      const t = new Date(`${today}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() - n);
      return t.toISOString().slice(0, 10);
    };
    for (const [days, direction, amount, channel] of [
      [10, 'in', '3000', 'cash'],
      [9, 'out', '700', 'cash'],
      [5, 'in', '1200', 'card'],
      [2, 'out', '250.50', 'cash'],
    ] as const) {
      await fx.pool.query(
        `INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, business_date,
                                        source_type, source_id, source_key, memo, created_by)
         VALUES ('pending', 'adjustment', $1, $2, $3, $4, 'adjustment', 0, 'pending', 'Earlier day', $5)`,
        [direction, amount, channel, earlier(days), fx.ownerId],
      );
    }
    const sumOf = async (channel: string, from: string | null, to: string) => {
      const { rows } = await fx.pool.query<{ s: string }>(
        `SELECT COALESCE(sum(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)::numeric(14,2)::text AS s
           FROM cl.ledger_entries WHERE channel = $1 AND ($2::date IS NULL OR business_date >= $2) AND business_date <= $3`,
        [channel, from, to],
      );
      return rows[0]?.s ?? '';
    };
    for (const [from, to] of [
      [earlier(10), today],
      [earlier(9), earlier(2)],
      [earlier(4), today],
      [today, today],
    ] as const) {
      const ledger = await ok(owner, 'GET', `/ledger?from=${from}&to=${to}`);
      const balances = ledger['balances'] as Body[];
      const entries = ledger['entries'] as Body[];
      for (const channel of ['cash', 'card']) {
        const b = balances.find((x) => x['channel'] === channel && x['provider'] === null);
        expect(b?.['closing'] ?? '0.00', `${channel} ${from}..${to}`).toBe(
          await sumOf(channel, null, to),
        );
        expect(Number(b?.['opening'] ?? 0)).toBeCloseTo(
          Number(await sumOf(channel, null, to)) - Number(await sumOf(channel, from, to)),
          2,
        );
        expect(Number(b?.['in'] ?? 0) - Number(b?.['out'] ?? 0)).toBeCloseTo(
          Number(await sumOf(channel, from, to)),
          2,
        );
        const mine = entries.filter((e) => e['channel'] === channel);
        if (mine.length > 0) expect(mine.at(-1)?.['balanceAfter']).toBe(b?.['closing']);
        for (const e of mine) {
          const date = e['businessDate'] as string;
          expect(date >= from && date <= to).toBe(true);
          expect(e['source']).toBeTruthy();
        }
      }
    }
    // One channel only.
    const cashOnly = await ok(owner, 'GET', `/ledger?from=${earlier(10)}&to=${today}&channel=cash`);
    expect((cashOnly['entries'] as Body[]).every((e) => e['channel'] === 'cash')).toBe(true);
    expect((await call(owner, 'GET', `/ledger?from=${today}&to=${earlier(1)}`)).status).toBe(400);
  });
});

describe('the nightly ledger check', () => {
  it('reports an entry without its source once, and fixes nothing', async () => {
    const tasks = makeTasks(fx.pool);
    const logged: string[] = [];
    const log = (m: string) => logged.push(m);
    await tasks['ledger:reconcile']?.({}, { logger: { info: log, error: log } } as never);
    expect(logged).toEqual(['ledger check: every source has exactly its entry']);

    await fx.pool.query(
      `SELECT cl.ledger_post('sale_receipt', 'in', 99, 'cash', NULL, $1::date, 'payment', 987654321,
                             'payment:987654321', NULL)`,
      [today],
    );
    await tasks['ledger:reconcile']?.({}, { logger: { info: log, error: log } } as never);
    await tasks['ledger:reconcile']?.({}, { logger: { info: log, error: log } } as never);
    expect(logged.slice(1)).toEqual([
      'ledger check found 1 mismatches',
      'ledger check found 1 mismatches',
    ]);
    const { rows } = await fx.pool.query<Body>(
      `SELECT a.entity_type, a.detail FROM cl.operational_alerts a WHERE a.kind = 'ledger_mismatch'`,
    );
    expect(rows).toEqual([
      { entity_type: 'ledger_entry', detail: { problem: 'its payment 987654321 does not exist' } },
    ]);
    const { rows: still } = await fx.pool.query(
      `SELECT 1 FROM cl.ledger_entries WHERE source_key = 'payment:987654321'`,
    );
    expect(still).toHaveLength(1);
  });
});

describe('the history backfill (P5-2)', () => {
  it('posts exactly the entries the triggers posted, once', async () => {
    const automatic = async () =>
      (
        await fx.pool.query<Body>(
          `SELECT source_key, entry_type, direction, amount::text, channel, transfer_provider,
                  business_date::text AS date, created_by::text, reverses_entry_id IS NOT NULL AS reverses
             FROM cl.ledger_entries
            WHERE source_type <> 'adjustment' AND source_key <> 'payment:987654321'
            ORDER BY source_key`,
        )
      ).rows;
    const posted = await automatic();
    expect(posted).toHaveLength(9); // 3 payments, 2 cash movements, 2 receipt payments + 1 reversal, 1 refund
    // The database as it was before 0023 had entries: no ledger at all.
    const sql = readFileSync(MIGRATION, 'utf8');
    const history = sql.slice(
      sql.indexOf('-- the history (P5-2)'),
      sql.indexOf('-- A ledger that does not match'),
    );
    const admin = fx.db.client;
    await admin.query('ALTER TABLE cl.ledger_entries DISABLE TRIGGER ledger_entries_append_only');
    await admin.query('TRUNCATE cl.ledger_entries');
    await admin.query('ALTER TABLE cl.ledger_entries ENABLE TRIGGER ledger_entries_append_only');

    await admin.query(history);
    expect(await automatic()).toEqual(posted);
    await admin.query(history);
    expect(await automatic()).toEqual(posted);
    expect(await findLedgerMismatches(fx.pool)).toEqual([]);
  });
});
