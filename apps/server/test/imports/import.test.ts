/**
 * Template import (Phase 4 step 4.9; docs/templates/README.md; AT-82). The shipped
 * templates, with their example SKUs replaced, go in through all eight files in the
 * weekly order. The preview lists every row error; a file with any error saves nothing;
 * EX- SKUs are refused; importing again updates instead of duplicating; recipes arrive as
 * drafts and the active recipe is untouched; each file needs its on-screen permission.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/modules/imports/csv.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let manager: Client;

type Body = Record<string, unknown>;
async function call(client: Client, method: 'GET' | 'POST', path: string, payload?: object) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}

/** A shipped template with its EX- example SKUs turned into real-looking ones. */
const template = (file: string, real = true) => {
  const text = readFileSync(new URL(`../../../../docs/templates/${file}`, import.meta.url), 'utf8');
  return real ? text.replaceAll('EX-', 'IM-') : text;
};
const preview = (client: Client, key: string, csv: string) =>
  call(client, 'POST', `/imports/${key}/preview`, { csv });
const apply = (client: Client, key: string, csv: string) =>
  call(client, 'POST', `/imports/${key}/apply`, { csv });

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('im-clerk', ['inventory_clerk']);
  clerk = await fx.loggedIn('im-clerk');
  // A manager the owner let edit the menu, but not change prices.
  const managerId = await fx.addUser('im-mgr', ['manager']);
  await fx.pool.query(
    `INSERT INTO cl.user_permission_overrides (user_id, permission_key, effect, reason, granted_by)
     VALUES ($1, 'menu.manage', 'grant', 'Keeps the menu up to date', $2)`,
    [managerId, fx.ownerId],
  );
  manager = await fx.loggedIn('im-mgr');
});
afterAll(async () => {
  await fx.close();
});

describe('reading CSV as spreadsheets save it', () => {
  it('handles a byte-order mark, CRLF, quotes, commas and line breaks inside quotes, and blank lines', () => {
    const csv = '﻿a,b,c\r\n1,"two, three","say ""hi"""\r\n\r\n4,"multi\nline",6\n';
    expect(parseCsv(csv)).toEqual([
      { line: 1, values: ['a', 'b', 'c'] },
      { line: 2, values: ['1', 'two, three', 'say "hi"'] },
      { line: 4, values: ['4', 'multi\nline', '6'] },
    ]);
    expect(() => parseCsv('a,b\n1,"open')).toThrow(/not closed/);
  });
});

describe('the eight templates in the weekly order (AT-82)', () => {
  it('previews without saving, imports everything, and a second import changes nothing', async () => {
    // 1. Items: the preview saves nothing.
    const items = template('01_inventory_items.csv');
    const seen = await preview(clerk, 'items', items);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body).toMatchObject({
      errors: [],
      rows: 5,
      summary: { create: 5, update: 0, unchanged: 0 },
    });
    expect(
      (await fx.pool.query("SELECT 1 FROM cl.inventory_items WHERE sku LIKE 'IM-%'")).rowCount,
    ).toBe(0);
    expect((await apply(clerk, 'items', items)).body).toMatchObject({ summary: { create: 5 } });

    // 2–3. Packs and barcodes; opening stock (the owner: inventory.opening_balance).
    expect(
      (await apply(clerk, 'packs', template('02_pack_sizes_barcodes.csv'))).body,
    ).toMatchObject({
      errors: [],
      summary: { create: 3 },
    });
    const openingCsv = template('03_opening_stock.csv').replace('2026-10-25', '2099-10-25');
    expect((await apply(clerk, 'opening', openingCsv)).status).toBe(403);
    const opened = await apply(owner, 'opening', openingCsv);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const { rows: milk } = await fx.pool.query<{
      on_hand: string;
      inventory_value: string;
      lots: number;
    }>(
      `SELECT b.on_hand::text, b.inventory_value::text,
              (SELECT count(*)::int FROM cl.inventory_lots l WHERE l.item_id = i.id AND l.lot_code = 'L2410A') AS lots
         FROM cl.inventory_items i JOIN cl.inventory_balances b ON b.item_id = i.id WHERE i.sku = 'IM-MILK-WHOLE'`,
    );
    expect(milk[0]).toEqual({ on_hand: '12000.0000', inventory_value: '3240.0000', lots: 1 });
    // Oat milk has no opening yet: count it so the oat-milk rule can be imported.
    await apply(
      owner,
      'opening',
      'sku,lot_code,expiry_date,quantity,uom,total_value\nIM-MILK-OAT,O1,2099-01-01,2,l,800\n',
    );
    await apply(
      owner,
      'opening',
      'sku,lot_code,expiry_date,quantity,uom,total_value\nIM-SUGAR-SACHET,,,500,pcs,500\n',
    );

    // 4–8. Suppliers, menu, modifiers, recipes (drafts), modifier rules.
    expect((await apply(clerk, 'suppliers', template('08_suppliers.csv'))).body).toMatchObject({
      summary: { create: 1 },
    });
    const menuResult = await apply(owner, 'menu', template('04_menu.csv'));
    expect(menuResult.body).toMatchObject({ errors: [], summary: { create: 7 } }); // 2 categories, 2 items, 3 sizes
    expect((await apply(owner, 'modifiers', template('05_modifiers.csv'))).body).toMatchObject({
      errors: [],
    });
    const rec = await apply(clerk, 'recipes', template('06_recipes.csv'));
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect((rec.body['changes'] as Body[])[0]?.['what']).toMatch(
      /^Draft v1 of Cappuccino · Regular \(3 ingredients\)/,
    );
    const { rows: versions } = await fx.pool.query<{ status: string; prep: string | null }>(
      `SELECT r.status, r.prep_instructions AS prep FROM cl.recipe_versions r
         JOIN cl.menu_variants v ON v.id = r.variant_id JOIN cl.menu_items mi ON mi.id = v.item_id
        WHERE mi.name = 'Cappuccino' AND v.name = 'Regular'`,
    );
    expect(versions).toEqual([{ status: 'draft', prep: 'Double shot; Steam to 60-65 C' }]);
    const rules = await apply(clerk, 'modifier-rules', template('07_modifier_recipe_rules.csv'));
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);
    expect(rules.body).toMatchObject({ summary: { create: 3 } });

    // A second import of every file creates nothing and changes nothing.
    for (const [key, csv, client] of [
      ['items', items, clerk],
      ['packs', template('02_pack_sizes_barcodes.csv'), clerk],
      ['suppliers', template('08_suppliers.csv'), clerk],
      ['menu', template('04_menu.csv'), owner],
      ['modifiers', template('05_modifiers.csv'), owner],
      ['modifier-rules', template('07_modifier_recipe_rules.csv'), clerk],
    ] as const) {
      const again = await apply(client, key, csv);
      expect(again.body['summary'], key).toMatchObject({ create: 0, update: 0 });
    }
    expect(
      (await fx.pool.query("SELECT 1 FROM cl.inventory_items WHERE sku LIKE 'IM-%'")).rowCount,
    ).toBe(5);
    expect(
      (await fx.pool.query("SELECT 1 FROM cl.menu_items WHERE name = 'Cappuccino'")).rowCount,
    ).toBe(1);
    // Opening stock is once per item.
    const twice = await apply(owner, 'opening', openingCsv);
    expect(twice.status).toBe(400);
    expect((twice.body['errors'] as Body[])[0]).toMatchObject({
      row: 2,
      column: 'sku',
      message: 'IM-MILK-WHOLE already has its opening stock; correct it with a stock count',
    });
  });

  it('updates what changed on a re-import, with price history, and recipes become new drafts', async () => {
    const items = template('01_inventory_items.csv').replace(
      'IM-BEANS-HOUSE,Espresso beans (house blend),Coffee,g,no,no,2000',
      'IM-BEANS-HOUSE,Espresso beans (house blend),Coffee,g,no,no,2500',
    );
    expect((await apply(clerk, 'items', items)).body).toMatchObject({
      summary: { update: 1, create: 0 },
    });
    const priced = template('04_menu.csv').replace('Large,780.00', 'Large,800.00');
    const res = await apply(owner, 'menu', priced);
    expect(res.body['changes']).toContainEqual({
      row: 3,
      action: 'update',
      what: 'Cappuccino · Large: Rs 780.00 → Rs 800',
    });
    const { rows } = await fx.pool.query<{ reason: string }>(
      `SELECT h.reason FROM cl.menu_variant_price_history h JOIN cl.menu_variants v ON v.id = h.variant_id
        WHERE v.name = 'Large' ORDER BY h.id DESC LIMIT 1`,
    );
    expect(rows[0]?.reason).toBe('Imported from 04_menu.csv');
    // Without menu.price_change a price cannot change by import either; the clerk may not import the menu at all.
    expect((await apply(clerk, 'menu', priced)).status).toBe(403);
    const byManager = await apply(manager, 'menu', priced.replace('Large,800.00', 'Large,820.00'));
    expect((byManager.body['errors'] as Body[])[0]).toMatchObject({
      row: 3,
      column: 'price',
      message: 'Changing a price needs menu.price_change',
    });
    // Activate the imported draft, then import the recipes again: a new draft, the active one untouched.
    const { rows: draft } = await fx.pool.query<{ id: string }>(
      `SELECT r.id::text FROM cl.recipe_versions r JOIN cl.menu_variants v ON v.id = r.variant_id
        WHERE v.name = 'Regular' AND r.status = 'draft' AND v.item_id = (SELECT id FROM cl.menu_items WHERE name = 'Cappuccino')`,
    );
    expect(
      (await call(clerk, 'POST', `/recipes/versions/${draft[0]?.id ?? ''}/activate`, {})).status,
    ).toBe(200);
    await apply(
      clerk,
      'recipes',
      template('06_recipes.csv').replace('Regular,IM-BEANS-HOUSE,18', 'Regular,IM-BEANS-HOUSE,20'),
    );
    const { rows: versions } = await fx.pool.query<{
      version_no: number;
      status: string;
      beans: string;
    }>(
      `SELECT r.version_no, r.status, c.qty_base::text AS beans FROM cl.recipe_versions r
         JOIN cl.recipe_components c ON c.recipe_version_id = r.id
         JOIN cl.inventory_items i ON i.id = c.inventory_item_id AND i.sku = 'IM-BEANS-HOUSE'
        WHERE r.variant_id = (SELECT v.id FROM cl.menu_variants v JOIN cl.menu_items mi ON mi.id = v.item_id
                              WHERE mi.name = 'Cappuccino' AND v.name = 'Regular')
        ORDER BY r.version_no`,
    );
    expect(versions).toEqual([
      { version_no: 1, status: 'active', beans: '18.0000' },
      { version_no: 2, status: 'draft', beans: '20.0000' },
    ]);
  });
});

describe('errors (AT-82)', () => {
  it('lists every problem with its row and column, and a file with any error saves nothing', async () => {
    const csv = [
      'sku,name,category,base_uom,track_lots,track_expiry,low_threshold,overstock_threshold,near_expiry_days',
      'NEW-ONE,Good item,Test,ml,no,no,,,',
      'EX-THING,Example,Test,ml,no,no,,,',
      'NEW-TWO,,Test,litre,maybe,yes,100,50,',
      'NEW-ONE,Duplicate,Test,g,no,no,,,',
    ].join('\n');
    const seen = await preview(clerk, 'items', csv);
    expect(seen.body['errors']).toEqual([
      {
        row: 3,
        column: 'sku',
        message: 'EX- is an example SKU: replace the example rows with your own',
      },
      { row: 4, column: 'name', message: 'Required' },
      { row: 4, column: 'base_uom', message: 'g, ml or pcs (the unit stock is kept in)' },
      { row: 4, column: 'track_lots', message: 'yes or no' },
      { row: 4, column: 'overstock_threshold', message: 'Must be above low_threshold' },
      { row: 5, column: 'sku', message: 'Also on row 2' },
    ]);
    expect(seen.body['changes']).toEqual([]);
    const applied = await apply(clerk, 'items', csv);
    expect(applied.status).toBe(400);
    expect(applied.body['detail']).toBe(
      '6 problems in 01_inventory_items.csv: nothing was imported',
    );
    expect(
      (await fx.pool.query("SELECT 1 FROM cl.inventory_items WHERE sku = 'NEW-ONE'")).rowCount,
    ).toBe(0);
  });

  it('refuses the shipped examples, a wrong header, and rows that name what does not exist', async () => {
    const examples = await preview(clerk, 'items', template('01_inventory_items.csv', false));
    expect((examples.body['errors'] as Body[]).length).toBe(5);
    const header = await preview(clerk, 'items', template('02_pack_sizes_barcodes.csv'));
    expect((header.body['errors'] as Body[])[0]).toMatchObject({
      row: 1,
      message: expect.stringMatching(/^The header must be exactly: sku,name,category/) as string,
    });
    const packs = await preview(
      clerk,
      'packs',
      'sku,pack_name,pack_qty,pack_uom,barcode\nNO-SUCH,Box,1,kg,\nIM-MILK-WHOLE,Sack,1,kg,\n',
    );
    expect(packs.body['errors']).toEqual([
      {
        row: 2,
        column: 'sku',
        message: 'No inventory item NO-SUCH: import it in 01_inventory_items first',
      },
      {
        row: 3,
        column: 'pack_qty',
        message: 'The item is kept in ml (volume); kg cannot be converted',
      },
    ]);
    const recipes = await preview(
      clerk,
      'recipes',
      'item,variant,ingredient_sku,quantity,uom,waste_factor_percent,for_dine_in,for_takeaway,for_delivery,prep_note\nMocha,Regular,IM-BEANS-HOUSE,18,g,0,yes,yes,yes,\n',
    );
    expect((recipes.body['errors'] as Body[])[0]).toMatchObject({
      row: 2,
      column: 'variant',
      message: 'No size Regular of Mocha on the menu: import 04_menu first',
    });
  });
});

describe("the owner's item list (docs/shop-data)", () => {
  it('imports with no errors, and a second import changes nothing', async () => {
    const csv = readFileSync(
      new URL('../../../../docs/shop-data/04_menu_owner.csv', import.meta.url),
      'utf8',
    );
    const first = await apply(owner, 'menu', csv);
    expect(first.body, JSON.stringify(first.body).slice(0, 600)).toMatchObject({ errors: [] });
    const { rows } = await fx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cl.menu_variants v JOIN cl.menu_items i ON i.id = v.item_id
        WHERE i.name = 'Tikka Pizza'`,
    );
    expect(rows[0]?.n).toBe(4);
    const again = await apply(owner, 'menu', csv);
    expect(again.body).toMatchObject({ errors: [], summary: { create: 0, update: 0 } });
  });
});
