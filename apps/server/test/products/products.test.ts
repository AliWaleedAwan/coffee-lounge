/**
 * New product from a scan (step 8.1): everything or nothing; selling takes one off stock; a
 * retry creates no duplicate; a clerk without price rights saves it not on sale (P8-3).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

const url = (p: string) => `/api/staff/v1${p}`;
let fx: IdentityFixture;
let owner: Client;
let categoryId: string;

const post = (c: Client, path: string, payload: object, key: string = randomUUID()) =>
  c.call({ method: 'POST', url: url(path), payload, headers: { 'idempotency-key': key } });

beforeAll(async () => {
  fx = await identityFixture();
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  const c = await post(owner, '/menu/categories', { name: 'Drinks' });
  categoryId = c.json<{ id: string }>().id;
});
afterAll(async () => {
  await fx.close();
});

const count = async (sql: string, ...args: unknown[]) => (await fx.pool.query(sql, args)).rowCount;

describe('POST /products', () => {
  it('creates all of it, and a retry changes nothing', async () => {
    const key = randomUUID();
    const body = {
      barcode: '8964000103289',
      name: 'Pepsi NR',
      categoryId,
      price: '80',
      opening: { qty: '24', unitCost: '55' },
    };
    const first = await post(owner, '/products', body, key);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ onSale: true });
    expect((await post(owner, '/products', body, key)).statusCode).toBe(201);
    expect(await count(`SELECT 1 FROM cl.inventory_items WHERE name = 'Pepsi NR'`)).toBe(1);
    expect(await count(`SELECT 1 FROM cl.menu_items WHERE name = 'Pepsi NR'`)).toBe(1);
    expect(await count(`SELECT 1 FROM cl.barcodes WHERE code = '8964000103289'`)).toBe(1);
    expect(
      await count(`SELECT 1 FROM cl.menu_variants WHERE stock_mode = 'recipe' AND price = 80`),
    ).toBe(1);
  });

  it('leaves nothing behind when the barcode is taken', async () => {
    const res = await post(owner, '/products', {
      barcode: '8964000103289',
      name: 'Copy of Pepsi',
      categoryId,
      price: '80',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await count(`SELECT 1 FROM cl.inventory_items WHERE name = 'Copy of Pepsi'`)).toBe(0);
    expect(await count(`SELECT 1 FROM cl.menu_items WHERE name = 'Copy of Pepsi'`)).toBe(0);
  });

  it('saves a clerk’s product not on sale, whatever price is sent', async () => {
    await fx.addUser('clerk_scan', ['inventory_clerk']);
    const clerk = await fx.loggedIn('clerk_scan');
    const res = await post(clerk, '/products', {
      barcode: '012000002946',
      name: 'Pepsi 1Ltr',
      categoryId,
      price: '180',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ onSale: false });
    expect(
      await count(`SELECT 1 FROM cl.menu_items WHERE name = 'Pepsi 1Ltr' AND NOT is_active`),
    ).toBe(1);
  });
});

describe('the item card', () => {
  it('sets the price, which puts it on sale, and corrects an expiry date with a reason', async () => {
    const { rows } = await fx.pool.query<{ id: string }>(
      `SELECT id::text FROM cl.inventory_items WHERE name = 'Pepsi 1Ltr'`,
    );
    const itemId = rows[0]?.id ?? '';
    const priced = await post(owner, `/products/by-item/${itemId}/price`, {
      price: '180',
      reason: 'First price',
    });
    expect(priced.json()).toMatchObject({ soldAs: { onSale: true, price: '180.00' } });

    const made = await post(owner, '/products', {
      barcode: '8964000999999',
      name: 'Juice box',
      categoryId,
      trackExpiry: true,
      opening: { qty: '5', unitCost: '40', expiryDate: '2027-01-01' },
    });
    expect(made.statusCode).toBe(201);
    const lot = await fx.pool.query<{ id: string }>(
      `SELECT l.id::text FROM cl.inventory_lots l JOIN cl.inventory_items i ON i.id = l.item_id
        WHERE i.name = 'Juice box'`,
    );
    const lotId = lot.rows[0]?.id ?? '';
    const fixed = await post(owner, `/inventory/lots/${lotId}/expiry`, {
      expiryDate: '2027-02-02',
      reason: 'Misread',
    });
    expect(fixed.statusCode).toBe(200);
    expect(
      await count(
        `SELECT 1 FROM cl.inventory_lots WHERE id = $1 AND expiry_date = '2027-02-02'`,
        lotId,
      ),
    ).toBe(1);
    expect(
      await count(`SELECT 1 FROM cl.audit_events WHERE action = 'stock.lot.expiry_corrected'`),
    ).toBe(1);
  });
});
