/**
 * Reports property (Phase 6 step 6.7; AC-RPT-1). Random sequences of trading through the API
 * (sales by every method, some at a discount; refunds; method corrections; cash in and out;
 * purchases; expenses; waste), and after each sequence the whole oracle: every report's totals
 * are the sums of its rows, its CSV says the same, the reports that count the same money
 * agree and the overview's tiles are their totals. CL_PROP_RUNS sequences (10 per commit).
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { forEachSeed, propRuns, type Random } from '../support/random.ts';
import { checkAgreement, checkEveryReport } from '../support/report-checks.ts';
import { TradingShop, type Method, type Provider } from '../support/trading.ts';

let fx: IdentityFixture;
let owner: Client;
let shop: TradingShop;
let today = '';
let beans = '';

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('rp-cash', ['cashier']);
  await fx.addUser('rp-owner', ['owner'], { pin: '1357' });
  const cashier = await fx.loggedIn('rp-cash');
  today = await businessDateOf(fx.pool, new Date());
  shop = new TradingShop(fx, owner, cashier, { username: 'rp-owner', pin: '1357' }, 'RP');
  await shop.setUp({ recipe: true });
  const { rows } = await fx.pool.query<{ id: string }>(
    `SELECT id::text FROM cl.inventory_items WHERE sku = 'RP-BEANS'`,
  );
  beans = rows[0]?.id ?? '';
  await shop.openShift(5000);
});
afterAll(async () => {
  await fx.close();
});

const METHODS: readonly Method[] = ['cash', 'card_manual', 'transfer'];
const PROVIDERS: readonly Provider[] = ['bank', 'jazzcash', 'easypaisa'];

async function step(random: Random): Promise<void> {
  const roll = random.int(1, 100);
  if (roll <= 40) {
    await shop.sale(
      random.int(1, 4),
      random.pick(METHODS),
      random.pick(PROVIDERS),
      random.chance(0.2) ? { discountPercent: random.pick([5, 10, 25]) } : {},
    );
  } else if (roll <= 52) {
    if (shop.payments.length > 0)
      await shop.refund(random.pick(shop.payments), random.pick([30, 50, 100]));
  } else if (roll <= 58) {
    if (shop.payments.length > 0)
      await shop.correct(random.pick(shop.payments), random.pick(METHODS), random.pick(PROVIDERS));
  } else if (roll <= 66) {
    await shop.cashMovement(random.chance(0.5) ? 'paid_in' : 'paid_out', random.int(50, 400));
  } else if (roll <= 74) {
    await shop.receive(
      random.int(1, 6),
      random.int(500, 3000),
      random.pick(['card', null] as const),
    );
  } else if (roll <= 86) {
    await shop.expense(random.int(100, 3000), random.pick(['cash', 'card', 'transfer'] as const), {
      category: random.pick(['Supplies', 'Rent']),
    });
  } else {
    const res = await owner.call({
      method: 'POST',
      url: '/api/staff/v1/inventory/waste',
      payload: { itemId: beans, qty: String(random.int(5, 80)), reasonCode: 'spilled' },
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    if (res.statusCode >= 300) throw new Error(`waste: ${res.body}`);
  }
}

describe('reports property (AC-RPT-1)', () => {
  it(`after random trading, every report adds up and they agree (${String(propRuns(10))} sequences)`, async () => {
    await forEachSeed(propRuns(10), async (random) => {
      for (let i = 0, steps = random.int(5, 15); i < steps; i++) await step(random);
      await checkEveryReport(owner, today, today);
      await checkAgreement(owner, today, today);
    });
  }, 600_000);
});
