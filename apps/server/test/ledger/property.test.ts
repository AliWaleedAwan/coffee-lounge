/**
 * Ledger property (Phase 5 step 5.7; PLAN.md "ledger property test"): for random sequences
 * of money events through the real API (sales by every method, refunds, method
 * corrections, cash paid in and out, purchases paid now and reversed, supplier refunds,
 * expenses from the bank or the till voided and corrected, owner entries reversed), after
 * every step:
 *   - each channel's ledger balance equals what the shop's own model says it should hold;
 *   - every source has exactly its entry, and every entry its source (nightly check);
 *   - every reversal cancels exactly the entry it reverses (same amount and channel, the
 *     other way);
 *   - the ledger read for the day closes at those balances (AT-121).
 * CL_PROP_RUNS sets the number of sequences, CL_PROP_SEED replays one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLedgerMismatches } from '../../src/modules/ledger/index.ts';
import { identityFixture, OWNER, type IdentityFixture } from '../support/identity.ts';
import { forEachSeed, propRuns, type Random } from '../support/random.ts';
import { TradingShop, type Method, type Provider } from '../support/trading.ts';

let fx: IdentityFixture;
let shop: TradingShop;

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  const owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('pt-cash', ['cashier']);
  await fx.addUser('pt-owner', ['owner'], { pin: '1357' });
  const cashier = await fx.loggedIn('pt-cash');
  shop = new TradingShop(fx, owner, cashier, { username: 'pt-owner', pin: '1357' }, 'PT');
  await shop.setUp();
});
afterAll(async () => {
  await fx.close();
});

const METHODS: readonly Method[] = ['cash', 'card_manual', 'transfer'];
const PROVIDERS: readonly Provider[] = ['bank', 'jazzcash', 'easypaisa'];

async function step(random: Random): Promise<string> {
  const roll = random.int(1, 100);
  if (roll <= 28) {
    await shop.sale(random.int(1, 4), random.pick(METHODS), random.pick(PROVIDERS));
    return 'sale';
  }
  if (roll <= 38) {
    if (shop.payments.length === 0) return 'refund skipped';
    const done = await shop.refund(random.pick(shop.payments), random.pick([30, 50, 100]));
    return done === null ? 'refund skipped' : 'refund';
  }
  if (roll <= 45) {
    if (shop.payments.length === 0) return 'correct skipped';
    const ok = await shop.correct(
      random.pick(shop.payments),
      random.pick(METHODS),
      random.pick(PROVIDERS),
    );
    return ok ? 'correct' : 'correct skipped';
  }
  if (roll <= 52) {
    await shop.cashMovement(random.chance(0.5) ? 'paid_in' : 'paid_out', random.int(50, 400));
    return 'cash movement';
  }
  if (roll <= 60) {
    await shop.receive(
      random.int(2, 8),
      random.int(500, 3000),
      random.pick(['cash', 'card', 'transfer', null] as const),
    );
    return 'receipt';
  }
  if (roll <= 64) {
    if (shop.receipts.length === 0) return 'reverse skipped';
    return (await shop.reverseReceipt(random.pick(shop.receipts)))
      ? 'receipt reversed'
      : 'reverse skipped';
  }
  if (roll <= 69) {
    if (shop.receipts.length === 0) return 'return skipped';
    const ok = await shop.supplierRefund(
      random.pick(shop.receipts),
      random.int(100, 400),
      random.pick(['cash', 'card', 'transfer'] as const),
    );
    return ok ? 'supplier refund' : 'return skipped';
  }
  if (roll <= 79) {
    const channel = random.pick(['cash', 'card', 'transfer', 'other'] as const);
    const fromTill = channel === 'cash' && random.chance(0.5);
    await shop.expense(random.int(100, 5000), channel, {
      provider: random.pick(PROVIDERS),
      fromTill,
    });
    return fromTill ? 'till expense' : 'expense';
  }
  if (roll <= 84) {
    if (shop.expenses.length === 0) return 'void skipped';
    await shop.voidExpense(random.pick(shop.expenses));
    return 'expense voided';
  }
  if (roll <= 88) {
    if (shop.expenses.length === 0) return 'correct expense skipped';
    await shop.correctExpense(random.pick(shop.expenses), random.int(100, 5000));
    return 'expense corrected';
  }
  if (roll <= 94) {
    await shop.adjust(
      random.pick(['in', 'out'] as const),
      random.int(100, 20000),
      random.pick(['cash', 'card', 'transfer', 'other'] as const),
      random.pick(PROVIDERS),
    );
    return 'adjustment';
  }
  if (shop.adjustments.length === 0) return 'reverse adjustment skipped';
  return (await shop.reverseAdjustment(random.int(0, shop.adjustments.length - 1)))
    ? 'adjustment reversed'
    : 'reverse adjustment skipped';
}

async function invariants(history: string[]): Promise<void> {
  const why = `after ${history.join(', ')}`;
  expect(await shop.ledgerBalances(), why).toEqual(shop.expected());
  expect(await findLedgerMismatches(fx.pool), why).toEqual([]);
  const { rows: uneven } = await fx.pool.query(
    `SELECT r.entry_no FROM cl.ledger_entries r JOIN cl.ledger_entries o ON o.id = r.reverses_entry_id
      WHERE r.amount <> o.amount OR r.direction = o.direction OR r.channel <> o.channel
         OR r.transfer_provider IS DISTINCT FROM o.transfer_provider`,
  );
  expect(uneven, why).toEqual([]);
  const ledger = await shop.read('/ledger');
  const closing = new Map(
    (ledger['balances'] as { channel: string; provider: string | null; closing: string }[])
      .map((b): [string, number] => [
        `${b.channel}|${b.provider ?? ''}`,
        Math.round(Number(b.closing) * 100),
      ])
      .filter(([, v]) => v !== 0),
  );
  expect(closing, why).toEqual(shop.expected());
}

describe('ledger under random money events (Phase 5 property)', () => {
  it('balances, sources, reversals and the read all agree after every step', async () => {
    const seen = new Set<string>();
    let sequences = 0;
    await forEachSeed(propRuns(3), async (random) => {
      sequences += 1;
      await shop.openShift();
      const history: string[] = [];
      for (let n = 0; n < 30; n++) {
        history.push(await step(random));
        await invariants(history);
      }
      await shop.closeShift();
      history.push('shift closed');
      await invariants(history);
      for (const h of history) seen.add(h);
    });
    if (sequences > 1) {
      for (const kind of ['sale', 'refund', 'expense', 'receipt', 'adjustment'])
        expect(seen).toContain(kind);
    }
  });
});
