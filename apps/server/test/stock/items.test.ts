/**
 * Inventory items through the API (Phase 4 step 4.1): settings (RECIPE_INVENTORY.md §3),
 * pack sizes in the base unit (AT-31, AT-32), barcodes with one active owner and the scan
 * lookup (AT-14, API part), base unit fixed once in use, archive only when nothing is on
 * hand and nothing uses it (§2, D-31). Edits are versioned and audited.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateRecipe,
  createRecipeDraft,
  postOpeningBalance,
} from '../../src/modules/stock/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let manager: Client;
let cashier: Client;

type Body = Record<string, unknown>;
async function call(
  client: Client,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload?: object,
) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}

let skuCounter = 0;
async function newItem(fields: Body = {}): Promise<{ id: string; version: number }> {
  skuCounter += 1;
  const res = await call(clerk, 'POST', '/inventory/items', {
    sku: `t-item-${String(skuCounter)}`,
    name: `Test item ${String(skuCounter)}`,
    baseUom: 'ml',
    ...fields,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body['id'] as string, version: 1 };
}
const item = async (id: string) => (await call(clerk, 'GET', `/inventory/items/${id}`)).body;
const scan = async (code: string) =>
  (await call(clerk, 'GET', `/inventory/scan?code=${encodeURIComponent(code)}`)).body;

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('it-clerk', ['inventory_clerk']);
  await fx.addUser('it-mgr', ['manager']);
  await fx.addUser('it-cash', ['cashier']);
  clerk = await fx.loggedIn('it-clerk');
  manager = await fx.loggedIn('it-mgr');
  cashier = await fx.loggedIn('it-cash');
});
afterAll(async () => {
  await fx.close();
});

describe('items (RECIPE_INVENTORY.md §3)', () => {
  it('creates an item with its settings, upper-cases the SKU and refuses a used one', async () => {
    const res = await call(clerk, 'POST', '/inventory/items', {
      sku: 'milk-whole',
      name: 'دودھ Whole milk', // D-27: any script on screen
      category: 'Dairy',
      baseUom: 'ml',
      trackLots: true,
      trackExpiry: true,
      lowThreshold: '5000',
      overstockThreshold: '60000',
      nearExpiryDays: 2,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const milk = await item(res.body['id'] as string);
    expect(milk).toMatchObject({
      sku: 'MILK-WHOLE',
      name: 'دودھ Whole milk',
      category: 'Dairy',
      baseUom: 'ml',
      trackLots: true,
      trackExpiry: true,
      lowThreshold: '5000.0000',
      overstockThreshold: '60000.0000',
      nearExpiryDays: 2,
      stockControlActive: false,
      archived: false,
      onHand: '0.0000',
      packs: [],
      barcodes: [],
    });
    const again = await call(clerk, 'POST', '/inventory/items', {
      sku: 'MILK-whole',
      name: 'Another milk',
      baseUom: 'ml',
    });
    expect(again.status).toBe(400);
    expect(again.body['detail']).toBe('SKU MILK-WHOLE is already used');
    // The listing finds it by name, by SKU and by category.
    const list = (await call(manager, 'GET', '/inventory/items?q=whole')).body;
    expect((list['items'] as Body[]).map((i) => i['sku'])).toContain('MILK-WHOLE');
    expect(list['categories']).toContain('Dairy');
    const byCategory = (await call(clerk, 'GET', '/inventory/items?category=Dairy')).body;
    expect((byCategory['items'] as Body[]).every((i) => i['category'] === 'Dairy')).toBe(true);
  });

  it('refuses settings that break the rules, and stale edits', async () => {
    const bad = [
      { trackExpiry: true, trackLots: false }, // expiry needs lots
      { lowThreshold: '100', overstockThreshold: '100' }, // overstock above low
      { baseUom: 'kg' }, // base units are g, ml, pcs only
      { lowThreshold: '-1' },
      { nearExpiryDays: 400 },
    ];
    for (const fields of bad) {
      skuCounter += 1;
      const res = await call(clerk, 'POST', '/inventory/items', {
        sku: `bad-${String(skuCounter)}`,
        name: 'Bad',
        baseUom: 'g',
        ...fields,
      });
      expect(res.status, JSON.stringify(fields)).toBe(400);
    }
    const { id } = await newItem({ lowThreshold: '100' });
    const edit = await call(clerk, 'PATCH', `/inventory/items/${id}`, {
      expectedVersion: 1,
      name: 'Renamed',
      overstockThreshold: '900',
      category: 'Syrups',
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body['version']).toBe(2);
    const stale = await call(clerk, 'PATCH', `/inventory/items/${id}`, {
      expectedVersion: 1,
      name: 'Too late',
    });
    expect(stale.status).toBe(409);
    expect(stale.body['code']).toBe('STALE_STATE');
    const merged = await call(clerk, 'PATCH', `/inventory/items/${id}`, {
      expectedVersion: 2,
      lowThreshold: '1000', // now above the overstock level of 900
    });
    expect(merged.status).toBe(400);
    expect(merged.body['detail']).toBe('The overstock level must be above the low level');
    // Clearing a threshold is allowed.
    const cleared = await call(clerk, 'PATCH', `/inventory/items/${id}`, {
      expectedVersion: 2,
      lowThreshold: null,
    });
    expect(cleared.status).toBe(200);
    expect((await item(id))['lowThreshold']).toBeNull();
    const { rows } = await fx.pool.query<{ action: string }>(
      `SELECT action FROM cl.audit_events WHERE entity_type = 'inventory_item' AND entity_id = $1 ORDER BY audit_events.id`,
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'stock.item.create',
      'stock.item.update',
      'stock.item.update',
    ]);
  });

  it('lets only inventory.items_manage edit, and inventory.read read', async () => {
    const { id } = await newItem();
    expect((await call(manager, 'GET', `/inventory/items/${id}`)).status).toBe(200);
    expect((await call(cashier, 'GET', `/inventory/items/${id}`)).status).toBe(403);
    expect(
      (await call(manager, 'PATCH', `/inventory/items/${id}`, { expectedVersion: 1, name: 'x' }))
        .status,
    ).toBe(403);
    expect(
      (await call(owner, 'PATCH', `/inventory/items/${id}`, { expectedVersion: 1, name: 'Owner' }))
        .status,
    ).toBe(200);
  });

  it('announces every change on the inventory topic', async () => {
    const { id } = await newItem();
    await call(clerk, 'POST', `/inventory/items/${id}/pack-sizes`, {
      name: 'Bottle',
      qty: '750',
      uom: 'ml',
    });
    const { rows } = await fx.pool.query<{ topics: string[]; event_type: string }>(
      `SELECT topics, event_type FROM cl.outbox_events WHERE entity_type = 'inventory_item'
          AND entity_id = $1 ORDER BY outbox_events.id`,
      [id],
    );
    expect(rows).toEqual([
      { topics: ['inventory'], event_type: 'inventory.changed' },
      { topics: ['inventory'], event_type: 'inventory.changed' },
    ]);
  });
});

describe('pack sizes (AT-31, AT-32)', () => {
  it('stores a pack in the base unit: 1 L carton = 1000 ml, 1 kg bag = 1000 g', async () => {
    const milk = await newItem();
    const carton = await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: '1 L carton',
      qty: '1',
      uom: 'l',
    });
    expect(carton.status, JSON.stringify(carton.body)).toBe(201);
    expect(carton.body['qtyBase']).toBe('1000.0000');
    const half = await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: 'Half litre',
      qty: '0.5',
      uom: 'l',
    });
    expect(half.body['qtyBase']).toBe('500.0000');
    const beans = await newItem({ baseUom: 'g' });
    const bag = await call(clerk, 'POST', `/inventory/items/${beans.id}/pack-sizes`, {
      name: '1 kg bag',
      qty: '1',
      uom: 'kg',
    });
    expect(bag.body['qtyBase']).toBe('1000.0000');
    expect(
      ((await item(milk.id))['packs'] as Body[]).map((p) => [p['name'], p['qtyBase']]),
    ).toEqual([
      ['Half litre', '500.0000'],
      ['1 L carton', '1000.0000'],
    ]);
  });

  it('refuses a pack in another dimension, a zero pack and a repeated name (AT-32)', async () => {
    const milk = await newItem();
    const kg = await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: 'Sack',
      qty: '1',
      uom: 'kg',
    });
    expect(kg.status).toBe(400);
    expect(kg.body['detail']).toMatch(
      /kept in ml \(volume\); a pack in kg \(mass\) cannot be converted/,
    );
    const pcs = await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: 'Tray',
      qty: '30',
      uom: 'pcs',
    });
    expect(pcs.status).toBe(400);
    const zero = await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: 'Nothing',
      qty: '0.00001',
      uom: 'l',
    });
    expect(zero.status).toBe(400);
    const tiny = await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: 'Drop',
      qty: '0.0001',
      uom: 'l',
    });
    expect(tiny.body['qtyBase']).toBe('0.1000');
    await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: 'Carton',
      qty: '1',
      uom: 'l',
    });
    const same = await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: ' carton ',
      qty: '2',
      uom: 'l',
    });
    expect(same.status).toBe(400);
    expect(same.body['detail']).toMatch(/already has a pack called carton/);
  });

  it('keeps what a pack holds; only its name and active flag change', async () => {
    const milk = await newItem();
    const pack = await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: 'Carton',
      qty: '1',
      uom: 'l',
    });
    const packId = pack.body['id'] as string;
    const renamed = await call(clerk, 'PATCH', `/inventory/pack-sizes/${packId}`, {
      expectedVersion: 1,
      name: '1 L carton',
    });
    expect(renamed.status).toBe(200);
    expect(
      (
        await call(clerk, 'PATCH', `/inventory/pack-sizes/${packId}`, {
          expectedVersion: 2,
          qty: '2',
        })
      ).status,
    ).toBe(400);
    await expect(
      fx.pool.query('UPDATE cl.item_pack_sizes SET qty_base = 2000 WHERE id = $1', [packId]),
    ).rejects.toThrow(/keeps its item and quantity/);
  });
});

describe('barcodes and scanning (AT-14, API part)', () => {
  it('a known code names the exact item and pack; an unknown code names nothing', async () => {
    const milk = await newItem({ name: 'Scan milk' });
    const pack = await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: '1 L carton',
      qty: '1',
      uom: 'l',
    });
    const linked = await call(clerk, 'POST', `/inventory/items/${milk.id}/barcodes`, {
      code: '8960000000017',
      packSizeId: pack.body['id'],
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    expect(await scan('8960000000017')).toEqual({
      code: '8960000000017',
      match: {
        itemId: milk.id,
        sku: expect.stringMatching(/^T-ITEM-/) as string,
        name: 'Scan milk',
        baseUom: 'ml',
        pack: { id: pack.body['id'], name: '1 L carton', qtyBase: '1000.0000' },
      },
    });
    // A code with no pack names the item alone (one base unit per scan).
    await call(clerk, 'POST', `/inventory/items/${milk.id}/barcodes`, { code: 'MILK-LOOSE' });
    expect(((await scan('MILK-LOOSE'))['match'] as Body)['pack']).toBeNull();
    expect(await scan('0000000000000')).toEqual({ code: '0000000000000', match: null });
    // The listing finds an item by its exact barcode.
    const found = (await call(clerk, 'GET', '/inventory/items?q=8960000000017')).body;
    expect((found['items'] as Body[]).map((i) => i['id'])).toEqual([milk.id]);
    // A code with spaces is not a scan.
    expect((await call(clerk, 'GET', '/inventory/scan?code=89%2060')).status).toBe(400);
  });

  it('refuses a code another item owns, naming the owner, also when two link it at once', async () => {
    const cups = await newItem({ name: 'Cup 12 oz', baseUom: 'pcs' });
    const sleeve = await call(clerk, 'POST', `/inventory/items/${cups.id}/pack-sizes`, {
      name: 'Sleeve of 50',
      qty: '50',
      uom: 'pcs',
    });
    await call(clerk, 'POST', `/inventory/items/${cups.id}/barcodes`, {
      code: '8960000000024',
      packSizeId: sleeve.body['id'],
    });
    const other = await newItem({ name: 'Lids', baseUom: 'pcs' });
    const dup = await call(clerk, 'POST', `/inventory/items/${other.id}/barcodes`, {
      code: '8960000000024',
    });
    expect(dup.status).toBe(409);
    expect(dup.body['code']).toBe('BARCODE_IN_USE');
    expect(dup.body['detail']).toMatch(
      /^Barcode 8960000000024 already belongs to Cup 12 oz \(T-ITEM-\d+\), Sleeve of 50$/,
    );
    // Even the same item cannot hold one code twice.
    expect(
      (await call(clerk, 'POST', `/inventory/items/${cups.id}/barcodes`, { code: '8960000000024' }))
        .status,
    ).toBe(409);

    for (let round = 0; round < 10; round += 1) {
      const a = await newItem({ baseUom: 'pcs' });
      const b = await newItem({ baseUom: 'pcs' });
      const code = `RACE-${String(round)}-${randomUUID().slice(0, 8)}`;
      const results = await Promise.all(
        [a, b].map((x) => call(clerk, 'POST', `/inventory/items/${x.id}/barcodes`, { code })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const { rows } = await fx.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM cl.barcodes WHERE code = $1 AND is_active',
        [code],
      );
      expect(rows[0]?.n).toBe(1);
    }
  });

  it("refuses another item's pack; deactivation frees a code for another item", async () => {
    const a = await newItem({ name: 'Item A' });
    const b = await newItem({ name: 'Item B' });
    const packB = await call(clerk, 'POST', `/inventory/items/${b.id}/pack-sizes`, {
      name: 'Bottle',
      qty: '1',
      uom: 'l',
    });
    const wrong = await call(clerk, 'POST', `/inventory/items/${a.id}/barcodes`, {
      code: 'WRONG-PACK',
      packSizeId: packB.body['id'],
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body['detail']).toBe("That pack is not one of Item A's");

    const linked = await call(clerk, 'POST', `/inventory/items/${a.id}/barcodes`, {
      code: 'MOVE-ME',
    });
    const barcodeId = linked.body['id'] as string;
    const off = await call(clerk, 'POST', `/inventory/barcodes/${barcodeId}/deactivate`, {
      expectedVersion: 1,
    });
    expect(off.status).toBe(200);
    expect(await scan('MOVE-ME')).toEqual({ code: 'MOVE-ME', match: null });
    expect(
      (
        await call(clerk, 'POST', `/inventory/barcodes/${barcodeId}/deactivate`, {
          expectedVersion: 2,
        })
      ).status,
    ).toBe(409);
    const moved = await call(clerk, 'POST', `/inventory/items/${b.id}/barcodes`, {
      code: 'MOVE-ME',
      packSizeId: packB.body['id'],
    });
    expect(moved.status).toBe(201);
    expect(((await scan('MOVE-ME'))['match'] as Body)['itemId']).toBe(b.id);
    // A barcode is never reactivated or repointed in place.
    await expect(
      fx.pool.query('UPDATE cl.barcodes SET is_active = true WHERE id = $1', [barcodeId]),
    ).rejects.toThrow(/only ever deactivated/);
  });

  it('deactivating a pack frees its barcodes', async () => {
    const milk = await newItem();
    const pack = await call(clerk, 'POST', `/inventory/items/${milk.id}/pack-sizes`, {
      name: 'Carton',
      qty: '1',
      uom: 'l',
    });
    await call(clerk, 'POST', `/inventory/items/${milk.id}/barcodes`, {
      code: 'PACK-OFF',
      packSizeId: pack.body['id'],
    });
    const off = await call(clerk, 'PATCH', `/inventory/pack-sizes/${pack.body['id'] as string}`, {
      expectedVersion: 1,
      isActive: false,
    });
    expect(off.status).toBe(200);
    expect(await scan('PACK-OFF')).toEqual({ code: 'PACK-OFF', match: null });
    const refused = await call(clerk, 'POST', `/inventory/items/${milk.id}/barcodes`, {
      code: 'PACK-OFF-2',
      packSizeId: pack.body['id'],
    });
    expect(refused.status).toBe(400);
    expect(refused.body['detail']).toBe('That pack is no longer used');
  });
});

describe('base unit and archive (RECIPE_INVENTORY.md §2, D-31)', () => {
  const audit = () => ({
    actor: { kind: 'user' as const, userId: fx.ownerId },
    correlationId: randomUUID(),
  });

  it('lets the base unit change only while nothing counts in it', async () => {
    const x = await newItem();
    const changed = await call(clerk, 'PATCH', `/inventory/items/${x.id}`, {
      expectedVersion: 1,
      baseUom: 'g',
    });
    expect(changed.status).toBe(200);
    await call(clerk, 'POST', `/inventory/items/${x.id}/pack-sizes`, {
      name: 'Bag',
      qty: '1',
      uom: 'kg',
    });
    const refused = await call(clerk, 'PATCH', `/inventory/items/${x.id}`, {
      expectedVersion: 2,
      baseUom: 'ml',
    });
    expect(refused.status).toBe(400);
    expect(refused.body['detail']).toBe('The base unit of an item in use cannot change');
  });

  it('archives only with nothing on hand and no active recipe using it; then frees its codes', async () => {
    const stocked = await newItem({ name: 'Stocked' });
    await withTransaction(fx.pool, (t) =>
      postOpeningBalance(t, { actorUserId: fx.ownerId, businessDate: '2026-10-26' }, audit(), {
        itemId: stocked.id,
        qty: new Decimal('250'),
        unitCost: new Decimal('0.5'),
      }),
    );
    const v = (await item(stocked.id))['version'] as number;
    const withStock = await call(clerk, 'POST', `/inventory/items/${stocked.id}/archive`, {
      expectedVersion: v,
    });
    expect(withStock.status).toBe(400);
    expect(withStock.body['detail']).toBe(
      'Stocked still has stock (250 ml on hand, 0 ml reserved). Waste, count or return it first.',
    );

    // Used by an active recipe.
    const cat = await call(owner, 'POST', '/menu/categories', { name: 'Archive tests' });
    const menuItem = await call(owner, 'POST', '/menu/items', {
      categoryId: cat.body['id'],
      name: 'Archive latte',
      variants: [{ name: 'Regular', price: '500' }],
    });
    const variantId = (menuItem.body['variantIds'] as string[])[0] ?? '';
    const used = await newItem({ name: 'Used' });
    await withTransaction(fx.pool, async (t) => {
      await postOpeningBalance(
        t,
        { actorUserId: fx.ownerId, businessDate: '2026-10-26' },
        audit(),
        { itemId: used.id, qty: new Decimal('0'), unitCost: new Decimal('1') },
      );
      const draft = await createRecipeDraft(t, {
        variantId,
        components: [{ itemId: used.id, qtyBase: '30' }],
      });
      await activateRecipe(t, audit(), draft.id);
    });
    const usedVersion = (await item(used.id))['version'] as number;
    const inUse = await call(clerk, 'POST', `/inventory/items/${used.id}/archive`, {
      expectedVersion: usedVersion,
    });
    expect(inUse.status).toBe(400);
    expect(inUse.body['detail']).toBe(
      'Used is used by Archive latte (Regular). Change those recipes first.',
    );

    // Free to archive: its barcode is freed, its packs retired, edits refused.
    const spare = await newItem({ name: 'Spare' });
    const pack = await call(clerk, 'POST', `/inventory/items/${spare.id}/pack-sizes`, {
      name: 'Carton',
      qty: '1',
      uom: 'l',
    });
    await call(clerk, 'POST', `/inventory/items/${spare.id}/barcodes`, {
      code: 'ARCHIVE-ME',
      packSizeId: pack.body['id'],
    });
    const done = await call(clerk, 'POST', `/inventory/items/${spare.id}/archive`, {
      expectedVersion: 1,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await scan('ARCHIVE-ME')).toEqual({ code: 'ARCHIVE-ME', match: null });
    const archived = await item(spare.id);
    expect(archived).toMatchObject({ archived: true, barcodes: [] });
    expect((archived['packs'] as Body[]).every((p) => p['isActive'] === false)).toBe(true);
    const listed = (await call(clerk, 'GET', '/inventory/items?q=Spare')).body['items'] as Body[];
    expect(listed.map((i) => i['id'])).not.toContain(spare.id);
    const withArchived = (await call(clerk, 'GET', '/inventory/items?q=Spare&includeArchived=true'))
      .body['items'] as Body[];
    expect(withArchived.map((i) => i['id'])).toContain(spare.id);
    const edit = await call(clerk, 'PATCH', `/inventory/items/${spare.id}`, {
      expectedVersion: archived['version'],
      name: 'Back',
    });
    expect(edit.status).toBe(400);
    expect(edit.body['detail']).toBe('Spare is archived');
    await expect(
      fx.pool.query('UPDATE cl.inventory_items SET archived_at = NULL WHERE id = $1', [spare.id]),
    ).rejects.toThrow(/stays archived/);
  });
});
