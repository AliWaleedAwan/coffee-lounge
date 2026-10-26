/**
 * The recipe editor through the API (Phase 4 step 4.8; RECIPE_INVENTORY.md §2, §4).
 * AT-63: a recipe with an ingredient not yet counted is not activated. AT-64: the preview
 * of a takeaway cappuccino with oat milk and an extra shot gives 27 g beans, 157.5 ml oat
 * milk and a cup; dine-in no cup. AT-19 (recipe part): a sale keeps the recipe it was
 * accepted with when a new version goes live. AT-61: an untracked size sells with no
 * reservation and no consumption.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postOpeningBalance } from '../../src/modules/stock/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let today = '';
const ing: Record<string, string> = {};
let latte = { itemId: '', regular: '', large: '' };
let milkGroup = { oat: '', shot: '' };

type Body = Record<string, unknown>;
async function call(
  client: Client,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  payload?: object,
) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}

async function ingredient(
  sku: string,
  baseUom: 'g' | 'ml' | 'pcs',
  opening?: string,
): Promise<string> {
  const res = await call(clerk, 'POST', '/inventory/items', { sku, name: sku, baseUom });
  const id = res.body['id'] as string;
  if (opening) {
    await withTransaction(fx.pool, (t) =>
      postOpeningBalance(
        t,
        { actorUserId: fx.ownerId, businessDate: today },
        { actor: { kind: 'user', userId: fx.ownerId }, correlationId: randomUUID() },
        { itemId: id, qty: new Decimal(opening), unitCost: new Decimal('0.5') },
      ),
    );
  }
  return id;
}

const view = async (variantId: string) =>
  (await call(clerk, 'GET', `/recipes/variants/${variantId}`)).body;
const draftOf = async (variantId: string) => {
  const res = await call(clerk, 'POST', `/recipes/variants/${variantId}/draft`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body['id'] as string;
};
const versionOf = async (variantId: string, id: string) =>
  ((await view(variantId))['versions'] as Body[]).find((v) => v['id'] === id)?.[
    'version'
  ] as number;
const save = async (variantId: string, id: string, components: Body[]) =>
  call(clerk, 'PUT', `/recipes/versions/${id}`, {
    expectedVersion: await versionOf(variantId, id),
    components,
  });
const all = { forDineIn: true, forTakeaway: true, forDelivery: true };

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('rc-clerk', ['inventory_clerk']);
  clerk = await fx.loggedIn('rc-clerk');
  today = await businessDateOf(fx.pool, new Date());
  ing['beans'] = await ingredient('RE-BEANS', 'g', '5000');
  ing['milk'] = await ingredient('RE-MILK', 'ml', '20000');
  ing['oat'] = await ingredient('RE-OAT', 'ml', '5000');
  ing['cup'] = await ingredient('RE-CUP', 'pcs', '100');
  ing['syrup'] = await ingredient('RE-SYRUP', 'ml'); // not counted yet
  const cat = await call(owner, 'POST', '/menu/categories', { name: 'Recipe tests' });
  const group = await call(owner, 'POST', '/modifier-groups', {
    name: 'Latte extras',
    minSelect: 0,
    maxSelect: 3,
    options: [
      { name: 'Oat milk', priceDelta: '80' },
      { name: 'Extra shot', priceDelta: '100' },
    ],
  });
  const [oat = '', shot = ''] = group.body['optionIds'] as string[];
  milkGroup = { oat, shot };
  const item = await call(owner, 'POST', '/menu/items', {
    categoryId: cat.body['id'],
    name: 'Recipe latte',
    modifierGroupIds: [group.body['id']],
    variants: [
      { name: 'Regular', price: '500' },
      { name: 'Large', price: '650' },
    ],
  });
  const [regular = '', large = ''] = item.body['variantIds'] as string[];
  latte = { itemId: item.body['id'] as string, regular, large };
});
afterAll(async () => {
  await fx.close();
});

describe('drafts and activation (RECIPE_INVENTORY.md §4.1, AT-63)', () => {
  it('builds a draft in any unit of each ingredient, refuses bad lines, and activates only counted ingredients', async () => {
    const id = await draftOf(latte.regular);
    expect(await draftOf(latte.regular)).toBe(id); // one draft at a time
    const bad = async (components: Body[]) =>
      (await save(latte.regular, id, components)).body['detail'];
    expect(await bad([{ itemId: ing['milk'], qty: '1', uom: 'kg', ...all }])).toMatch(/kept in ml/);
    expect(
      await bad([
        { itemId: ing['milk'], qty: '1', ...all },
        { itemId: ing['milk'], qty: '2', ...all },
      ]),
    ).toBe('Each ingredient once: add the quantities together');
    expect(
      await bad([
        { itemId: ing['cup'], qty: '1', forDineIn: false, forTakeaway: false, forDelivery: false },
      ]),
    ).toBe('RE-CUP must apply to at least one kind of order');
    const ok = await save(latte.regular, id, [
      { itemId: ing['beans'], qty: '18', ...all },
      { itemId: ing['milk'], qty: '0.15', uom: 'l', wastePercent: '5', ...all },
      { itemId: ing['cup'], qty: '1', forDineIn: false, forTakeaway: true, forDelivery: true },
      { itemId: ing['syrup'], qty: '10', ...all },
    ]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const draft = ((await view(latte.regular))['versions'] as Body[])[0];
    expect(draft).toMatchObject({ status: 'draft', versionNo: 1 });
    expect(
      (draft?.['components'] as Body[]).map((c) => [c['name'], c['qtyBase'], c['wasteFactor']]),
    ).toEqual([
      ['RE-BEANS', '18.0000', '0.0000'],
      ['RE-MILK', '150.0000', '0.0500'],
      ['RE-CUP', '1.0000', '0.0000'],
      ['RE-SYRUP', '10.0000', '0.0000'],
    ]);
    // AT-63: the syrup is not counted.
    const refused = await call(clerk, 'POST', `/recipes/versions/${id}/activate`, {});
    expect(refused.status).toBe(400);
    expect(refused.body['detail']).toBe('Count these ingredients first: RE-SYRUP');
    await save(latte.regular, id, [
      { itemId: ing['beans'], qty: '18', ...all },
      { itemId: ing['milk'], qty: '150', wastePercent: '5', ...all },
      { itemId: ing['cup'], qty: '1', forDineIn: false, forTakeaway: true, forDelivery: true },
    ]);
    expect((await call(clerk, 'POST', `/recipes/versions/${id}/activate`, {})).status).toBe(200);
    expect((await call(clerk, 'POST', `/recipes/versions/${id}/activate`, {})).status).toBe(400);
    const switched = await call(clerk, 'POST', `/recipes/variants/${latte.regular}/stock-mode`, {
      mode: 'recipe',
    });
    expect(switched.body).toEqual({ stockMode: 'recipe' });
    // Large has no recipe: it cannot be switched.
    const noRecipe = await call(clerk, 'POST', `/recipes/variants/${latte.large}/stock-mode`, {
      mode: 'recipe',
    });
    expect(noRecipe.body['detail']).toBe('Activate a recipe for this size first');
    const overview = (await call(clerk, 'GET', '/recipes')).body['items'] as Body[];
    expect(overview.find((i) => i['menuItemId'] === latte.itemId)?.['variants']).toEqual([
      {
        id: latte.regular,
        name: 'Regular',
        stockMode: 'recipe',
        activeVersion: 1,
        draftVersion: null,
      },
      {
        id: latte.large,
        name: 'Large',
        stockMode: 'untracked',
        activeVersion: null,
        draftVersion: null,
      },
    ]);
  });
});

describe('modifier rules and the preview (RECIPE_INVENTORY.md §4.3–§4.4, AT-64)', () => {
  it('explodes a takeaway cappuccino with oat milk and an extra shot exactly', async () => {
    const replace = await call(clerk, 'POST', '/recipes/rules', {
      optionId: milkGroup.oat,
      action: 'replace',
      itemId: ing['milk'],
      replacementItemId: ing['oat'],
    });
    expect(replace.status, JSON.stringify(replace.body)).toBe(201);
    await call(clerk, 'POST', '/recipes/rules', {
      optionId: milkGroup.shot,
      variantId: latte.regular,
      action: 'add',
      itemId: ing['beans'],
      qty: '9',
    });
    const preview = (orderType: string, optionIds: string[]) =>
      call(clerk, 'POST', '/recipes/preview', { variantId: latte.regular, orderType, optionIds });
    const takeaway = await preview('takeaway', [milkGroup.oat, milkGroup.shot]);
    expect(takeaway.body['lines']).toEqual([
      { itemId: ing['beans'], name: 'RE-BEANS', baseUom: 'g', qtyPerUnit: '27.0000' },
      { itemId: ing['oat'], name: 'RE-OAT', baseUom: 'ml', qtyPerUnit: '157.5000' },
      { itemId: ing['cup'], name: 'RE-CUP', baseUom: 'pcs', qtyPerUnit: '1.0000' },
    ]);
    const dineIn = await preview('dine_in', [milkGroup.oat, milkGroup.shot]);
    expect((dineIn.body['lines'] as Body[]).map((l) => l['name'])).toEqual(['RE-BEANS', 'RE-OAT']);
    const twoShots = await preview('dine_in', [milkGroup.shot, milkGroup.shot]);
    expect((twoShots.body['lines'] as Body[])[0]?.['qtyPerUnit']).toBe('36.0000');
    const rules = (await view(latte.regular))['rules'] as Body[];
    expect(
      rules.map((r) => [r['optionName'], r['action'], r['itemName'], r['replacementName']]),
    ).toEqual([
      ['Oat milk', 'replace', 'RE-MILK', 'RE-OAT'],
      ['Extra shot', 'add', 'RE-BEANS', null],
    ]);
    // Rules end from now on; the preview follows.
    const shotRule = rules.find((r) => r['optionName'] === 'Extra shot')?.['id'] as string;
    expect((await call(clerk, 'POST', `/recipes/rules/${shotRule}/retire`, {})).status).toBe(200);
    expect((await call(clerk, 'POST', `/recipes/rules/${shotRule}/retire`, {})).status).toBe(409);
    expect(
      ((await preview('dine_in', [milkGroup.shot])).body['lines'] as Body[])[0]?.['qtyPerUnit'],
    ).toBe('18.0000');
  });

  it('refuses rules that add uncounted stock or swap across kinds of unit', async () => {
    const add = await call(clerk, 'POST', '/recipes/rules', {
      optionId: milkGroup.shot,
      action: 'add',
      itemId: ing['syrup'],
      qty: '10',
    });
    expect(add.body['detail']).toBe('Count RE-SYRUP first: a choice can only add counted stock');
    const swap = await call(clerk, 'POST', '/recipes/rules', {
      optionId: milkGroup.oat,
      action: 'replace',
      itemId: ing['milk'],
      replacementItemId: ing['beans'],
    });
    expect(swap.body['detail']).toBe('RE-MILK and RE-BEANS are not kept in the same kind of unit');
  });
});

describe('a new version after a sale (AT-19) and untracked sizes (AT-61)', () => {
  it('keeps the accepted recipe for the sale; an untracked size reserves nothing', async () => {
    const t = await call(owner, 'POST', '/tables', { code: 'RE1', name: 'Recipe table' });
    const sessionId = (await call(owner, 'POST', `/tables/${t.body['id'] as string}/sessions`, {}))
      .body['id'] as string;
    const round = await call(owner, 'POST', `/sessions/${sessionId}/rounds`, {
      lines: [
        { variantId: latte.regular, qty: 1, modifierOptionIds: [] },
        { variantId: latte.large, qty: 1, modifierOptionIds: [] },
      ],
    });
    expect(round.status, JSON.stringify(round.body)).toBe(201);
    const { rows: lines } = await fx.pool.query<{ id: string }>(
      'SELECT id::text FROM cl.order_lines WHERE round_id = $1 ORDER BY line_no',
      [round.body['id']],
    );
    const [tracked = '', untracked = ''] = lines.map((l) => l.id);
    const components = async (lineId: string) =>
      (
        await fx.pool.query<{ item: string; q: string }>(
          `SELECT inventory_item_id::text AS item, qty_per_unit::text AS q FROM cl.order_line_components
            WHERE line_id = $1 ORDER BY inventory_item_id`,
          [lineId],
        )
      ).rows;
    const before = await components(tracked);
    expect(before).toContainEqual({ item: ing['milk'], q: '157.5000' });
    // Version 2: more milk. The sale keeps version 1.
    const v2 = await draftOf(latte.regular);
    await save(latte.regular, v2, [
      { itemId: ing['beans'], qty: '18', ...all },
      { itemId: ing['milk'], qty: '200', wastePercent: '5', ...all },
    ]);
    await call(clerk, 'POST', `/recipes/versions/${v2}/activate`, {});
    const versions = ((await view(latte.regular))['versions'] as Body[]).map((v) => [
      v['versionNo'],
      v['status'],
    ]);
    expect(versions).toEqual([
      [2, 'active'],
      [1, 'retired'],
    ]);
    expect(await components(tracked)).toEqual(before);
    await call(owner, 'POST', `/lines/${tracked}/pickup`, { qty: 1 });
    const { rows: used } = await fx.pool.query<{ q: string }>(
      `SELECT (-m.qty_delta)::text AS q FROM cl.stock_movements m
        WHERE m.source_type = 'order_line' AND m.source_id = $1 AND m.item_id = $2`,
      [tracked, ing['milk']],
    );
    expect(used).toEqual([{ q: '157.5000' }]);
    // AT-61: the untracked size reserved and consumed nothing.
    await call(owner, 'POST', `/lines/${untracked}/pickup`, { qty: 1 });
    const { rows: none } = await fx.pool.query(
      `SELECT 1 FROM cl.stock_reservations WHERE order_line_id = $1
       UNION ALL SELECT 1 FROM cl.stock_movements WHERE source_type = 'order_line' AND source_id = $1`,
      [untracked],
    );
    expect(none).toEqual([]);
  });
});
