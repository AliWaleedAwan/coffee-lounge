/**
 * Phase 5 exit demo (PLAN.md): a month of simulated trading through the real API, one
 * cash shift a day. Sales by cash, card and each transfer provider; refunds and method
 * corrections approved by a second owner; cash paid in and out; purchases paid at receipt,
 * one reversed; a supplier refund; rent, wages from the till, utilities voided and an
 * expense corrected; the owner's starting balances (P5-8) and an entry reversed. Then:
 *   - each channel's running balance equals the sum of its entries for every day and for
 *     the whole month (AT-121), and equals the shop's own model of what it should hold;
 *   - every entry traces to its source (a label, and a link for bills and expenses);
 *   - the nightly ledger check reports nothing (AT-71).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLedgerMismatches } from '../../src/modules/ledger/index.ts';
import { makeTasks } from '../../src/worker/runner.ts';
import { identityFixture, OWNER, type IdentityFixture } from '../support/identity.ts';
import { Random } from '../support/random.ts';
import { TradingShop, type Method, type Provider } from '../support/trading.ts';

const DAYS = 30;
let fx: IdentityFixture;
let shop: TradingShop;
// Noon in Karachi on the day being traded; the API takes its business dates from it.
let clock = new Date();
const start = new Date();
start.setUTCDate(start.getUTCDate() - (DAYS - 1));
start.setUTCHours(7, 0, 0, 0);
const dayOf = (n: number) => {
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app', now: () => clock });
  const owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('mo-cash', ['cashier']);
  await fx.addUser('mo-partner', ['owner'], { pin: '1357' });
  const cashier = await fx.loggedIn('mo-cash');
  shop = new TradingShop(fx, owner, cashier, { username: 'mo-partner', pin: '1357' }, 'MO');
  await shop.setUp();
});
afterAll(async () => {
  await fx.close();
});

describe('a month of trading (Phase 5 exit demo)', () => {
  it('reconciles every day and the month, with every entry traced to its source', async () => {
    const random = new Random(20261027);
    const methods: readonly Method[] = ['cash', 'cash', 'card_manual', 'transfer'];
    const providers: readonly Provider[] = ['jazzcash', 'easypaisa', 'bank'];
    for (let n = 0; n < DAYS; n++) {
      clock = dayOf(n);
      await shop.openShift(5000);
      if (n === 0) {
        // P5-8: what is in the cash box and the bank on the first day.
        await shop.adjust('in', 20000, 'cash');
        await shop.adjust('in', 150000, 'transfer', 'bank');
      }
      for (let s = 0, sales = random.int(4, 8); s < sales; s++) {
        await shop.sale(random.int(1, 3), random.pick(methods), random.pick(providers));
      }
      const today = shop.payments.slice(-3);
      if (n % 3 === 2) await shop.refund(random.pick(today), 50);
      if (n % 5 === 4) {
        const p = today.find((x) => x.method === 'cash') ?? today[0];
        if (p) await shop.correct(p, 'card_manual');
      }
      if (n % 2 === 0) await shop.cashMovement('paid_out', random.int(100, 300));
      if (n % 6 === 3) await shop.cashMovement('paid_in', 500);
      if (n % 7 === 1) await shop.receive(6, 1650, 'cash');
      if (n === 10) await shop.receive(12, 3300, 'transfer');
      if (n === 12) {
        const r = shop.receipts.find((x) => x.channel === 'transfer');
        if (r) expect(await shop.supplierRefund(r, 550, 'transfer')).toBe(true);
      }
      if (n === 15) {
        const wrong = await shop.receive(60, 16500, null);
        expect(await shop.reverseReceipt(wrong)).toBe(true);
      }
      if (n === 1) await shop.expense(45000, 'transfer', { provider: 'bank', category: 'Rent' });
      if (n % 7 === 6) await shop.expense(1500, 'cash', { fromTill: true, category: 'Wages' });
      if (n === 20) {
        await shop.expense(12500, 'transfer', { provider: 'bank', category: 'Utilities' });
        const twice = await shop.expense(12500, 'transfer', {
          provider: 'bank',
          category: 'Utilities',
        });
        if (twice) await shop.voidExpense(twice);
      }
      if (n === 25) {
        const e = await shop.expense(3000, 'card', { category: 'Repairs & maintenance' });
        if (e) await shop.correctExpense(e, 2800);
      }
      if (n === 18) {
        await shop.adjust('out', 999, 'cash');
        expect(await shop.reverseAdjustment(shop.adjustments.length - 1)).toBe(true);
      }
      await shop.closeShift();
    }

    // The month against the shop's own model.
    expect(await shop.ledgerBalances()).toEqual(shop.expected());

    // Every day: it opens where the day before closed, and closes at opening + in − out.
    const first = iso(dayOf(0));
    const last = iso(dayOf(DAYS - 1));
    let previous = new Map<string, number>();
    const cents = (v: string) => Math.round(Number(v) * 100);
    for (let n = 0; n < DAYS; n++) {
      const day = iso(dayOf(n));
      const ledger = await shop.read(`/ledger?from=${day}&to=${day}`);
      const balances = ledger['balances'] as {
        channel: string;
        provider: string | null;
        opening: string;
        in: string;
        out: string;
        closing: string;
      }[];
      const closing = new Map<string, number>();
      const opening = new Map<string, number>();
      for (const b of balances) {
        const k = `${b.channel}|${b.provider ?? ''}`;
        expect(cents(b.opening), `${day} ${k} opening`).toBe(previous.get(k) ?? 0);
        expect(cents(b.closing), `${day} ${k}`).toBe(cents(b.opening) + cents(b.in) - cents(b.out));
        closing.set(k, cents(b.closing));
        opening.set(k, cents(b.opening));
      }
      for (const [k, v] of previous)
        if (v !== 0) expect(opening.get(k), `${day} ${k} carried`).toBe(v);
      previous = closing;
      // Each entry names what it came from; bills and expenses link to their page.
      for (const e of ledger['entries'] as {
        source: string;
        sourceType: string;
        link: string | null;
      }[]) {
        expect(e.source, day).toBeTruthy();
        if (['payment', 'refund', 'expense'].includes(e.sourceType))
          expect(e.link, day).toMatch(/^\//);
      }
    }
    const month = await shop.read(`/ledger?from=${first}&to=${last}`);
    const monthClosing = new Map(
      (month['balances'] as { channel: string; provider: string | null; closing: string }[])
        .map((b): [string, number] => [`${b.channel}|${b.provider ?? ''}`, cents(b.closing)])
        .filter(([, v]) => v !== 0),
    );
    expect(monthClosing).toEqual(shop.expected());

    // The nightly check finds nothing.
    expect(await findLedgerMismatches(fx.pool)).toEqual([]);
    const logged: string[] = [];
    const log = (m: string) => logged.push(m);
    await makeTasks(fx.pool)['ledger:reconcile']?.({}, {
      logger: { info: log, error: log },
    } as never);
    expect(logged).toEqual(['ledger check: every source has exactly its entry']);

    // What the month held, for the acceptance record.
    const { rows } = await fx.pool.query<{ entry_type: string; n: number }>(
      'SELECT entry_type, count(*)::int AS n FROM cl.ledger_entries GROUP BY entry_type ORDER BY entry_type',
    );
    const types = Object.fromEntries(rows.map((r) => [r.entry_type, r.n]));
    for (const t of [
      'sale_receipt',
      'refund',
      'purchase_payment',
      'expense',
      'cash_in',
      'cash_out',
      'adjustment',
      'reversal',
    ]) {
      expect(types[t], t).toBeGreaterThan(0);
    }
    const { rows: dates } = await fx.pool.query<{ n: number }>(
      'SELECT count(DISTINCT business_date)::int AS n FROM cl.ledger_entries',
    );
    expect(dates[0]?.n).toBeGreaterThanOrEqual(DAYS - 1);
  });
});
