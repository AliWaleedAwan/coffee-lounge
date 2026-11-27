/** The old POS menu import against a real database: scannable products, idempotent, audited. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMenuPlan, planMenu } from '../../src/modules/oldpos/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let ownerId = '';

const plan = planMenu([
  { name: 'Old Fries', barcode: '1', price: 250, inStock: true, category: 'Old Starter' },
  { name: 'Old Lays', barcode: '', price: 20, inStock: true, category: 'Old Snacks' },
  { name: 'Old Lays', barcode: '', price: 50, inStock: true, category: 'Old Snacks' },
  { name: 'Old Cone', barcode: '', price: 90, inStock: false, category: 'Old Snacks' },
  {
    name: 'Old Pepsi',
    barcode: '8990000000017',
    price: 120,
    inStock: true,
    category: 'Old Drinks',
  },
  { name: '', barcode: '', price: 10, inStock: true, category: 'Old Drinks' },
]);

const run = () =>
  withTransaction(fx.pool, (tx) =>
    applyMenuPlan(
      tx,
      { actor: { kind: 'user', userId: ownerId }, correlationId: randomUUID() },
      plan,
    ),
  );

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  const { rows } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.users WHERE is_owner LIMIT 1',
  );
  ownerId = rows[0]?.id ?? '';
});
afterAll(async () => {
  await fx.close();
});

describe('importing the old POS menu', () => {
  it('makes categories, items with sizes, off-sale items and scannable products', async () => {
    expect(await run()).toEqual({
      categoriesCreated: 3,
      itemsCreated: 3,
      productsCreated: 1,
      alreadyThere: 0,
      offSale: 1,
    });
    const { rows } = await fx.pool.query<{ name: string; sizes: string; on: boolean }>(
      `SELECT i.name, string_agg(v.name || '=' || v.price::int, ',' ORDER BY v.sort) AS sizes,
              i.is_active AS on
         FROM cl.menu_items i JOIN cl.menu_variants v ON v.item_id = i.id
        WHERE i.name LIKE 'Old %' GROUP BY i.id ORDER BY i.name`,
    );
    expect(rows).toEqual([
      { name: 'Old Cone', sizes: 'Regular=90', on: false },
      { name: 'Old Fries', sizes: 'Regular=250', on: true },
      { name: 'Old Lays', sizes: 'Rs 20=20,Rs 50=50', on: true },
      { name: 'Old Pepsi', sizes: 'Regular=120', on: true },
    ]);
  });

  it('a scan of the old barcode sells the product at the counter', async () => {
    const res = await owner.call({
      method: 'GET',
      url: '/api/staff/v1/products/sell-scan?code=8990000000017',
    });
    expect(res.json<{ variantId: string | null; problem: string | null }>()).toMatchObject({
      problem: null,
    });
  });

  it('running it again changes nothing', async () => {
    expect(await run()).toEqual({
      categoriesCreated: 0,
      itemsCreated: 0,
      productsCreated: 0,
      alreadyThere: 4,
      offSale: 0,
    });
  });
});
