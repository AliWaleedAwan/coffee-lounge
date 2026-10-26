/**
 * The stock ledger against PostgreSQL, as the application role (so 0008's grants are
 * exercised): opening balances, reserve → consume / release, found stock, waste, alerts,
 * recipes and stock mode, menu availability, the nightly check and the sample shop.
 */
import { randomUUID } from 'node:crypto';
import { Decimal } from '@cl/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSampleShop, readSampleShop } from '../../scripts/sample-shop.ts';
import {
  activateRecipe,
  addModifierRule,
  consume,
  createInventoryItem,
  createRecipeDraft,
  findStockMismatches,
  postOpeningBalance,
  raiseMismatchAlerts,
  release,
  reserve,
  setStockMode,
  wasteIngredient,
} from '../../src/modules/stock/index.ts';
import { withTransaction, type Tx } from '../../src/platform/db/tx.ts';
import { makeTasks } from '../../src/worker/runner.ts';
import { urlFor } from '../support/db.ts';
import { testOrderLines } from '../support/orders.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

const NOW = new Date('2026-10-21T12:00:00+05:00');
const BDATE = '2026-10-21';
const d = (v: string | number) => new Decimal(v);

let fx: IdentityFixture;
let owner: Client;
let audit: { actor: { kind: 'user'; userId: string }; correlationId: string };
let ctx: { actorUserId: string; businessDate: string };
beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app', now: () => NOW });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  audit = { actor: { kind: 'user', userId: fx.ownerId }, correlationId: randomUUID() };
  ctx = { actorUserId: fx.ownerId, businessDate: BDATE };
});
afterAll(async () => {
  await fx.close();
});

const tx = <T>(fn: (t: Tx) => Promise<T>) => withTransaction(fx.pool, fn);
let skuCounter = 0;

async function newItem(opening?: { qty: string; cost: string }, low?: string): Promise<string> {
  skuCounter += 1;
  return tx(async (t) => {
    const { id } = await createInventoryItem(t, audit, {
      sku: `T-${String(skuCounter)}`,
      name: `Ingredient ${String(skuCounter)}`,
      baseUom: 'ml',
      ...(low ? { lowThreshold: low } : {}),
    });
    if (opening) {
      await postOpeningBalance(t, ctx, audit, {
        itemId: id,
        qty: d(opening.qty),
        unitCost: d(opening.cost),
      });
    }
    return id;
  });
}

async function balance(itemId: string) {
  const { rows } = await fx.pool.query<{
    on_hand: string;
    reserved: string;
    inventory_value: string;
  }>(
    'SELECT on_hand::text, reserved::text, inventory_value::text FROM cl.inventory_balances WHERE item_id = $1',
    [itemId],
  );
  return rows[0];
}

async function openAlerts(itemId: string): Promise<string[]> {
  const { rows } = await fx.pool.query<{ kind: string }>(
    `SELECT kind FROM cl.inventory_alerts WHERE item_id = $1 AND state <> 'resolved' ORDER BY kind`,
    [itemId],
  );
  return rows.map((r) => r.kind);
}

const nextLine = async (): Promise<string> => (await testOrderLines(fx.pool, fx.ownerId))[0] ?? '';

describe('opening balances (D-29)', () => {
  it('posts the first quantity and cost once and switches the item to stock control', async () => {
    const id = await newItem();
    const { rows } = await fx.pool.query(
      'SELECT stock_control_active FROM cl.inventory_items WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ stock_control_active: false });
    await tx((t) =>
      postOpeningBalance(t, ctx, audit, { itemId: id, qty: d('3000'), unitCost: d('0.26833333') }),
    );
    expect(await balance(id)).toEqual({
      on_hand: '3000.0000',
      reserved: '0.0000',
      inventory_value: '805.0000',
    });
    await expect(
      tx((t) => postOpeningBalance(t, ctx, audit, { itemId: id, qty: d('1'), unitCost: d('1') })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('reserve, consume and release', () => {
  it('refuses a shortfall with per-ingredient detail and reserves nothing', async () => {
    const milk = await newItem({ qty: '300', cost: '0.3' });
    const beans = await newItem({ qty: '100', cost: '9' });
    const line = await nextLine();
    const attempt = tx((t) =>
      reserve(t, {
        orderLineId: line,
        requirement: new Map([
          [milk, d('315')],
          [beans, d('54')],
        ]),
      }),
    );
    await expect(attempt).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      extra: { shortages: [{ itemId: milk, needed: '315.0000', available: '300.0000' }] },
    });
    expect((await balance(milk))?.reserved).toBe('0.0000');
    expect((await balance(beans))?.reserved).toBe('0.0000');
  });

  it('consumes part, then the exact rest, freezing each cost; the drain rule leaves no value (AT-65)', async () => {
    const milk = await newItem({ qty: '315', cost: '0.26833333' }); // value 84.5250
    const line = await nextLine();
    await tx((t) => reserve(t, { orderLineId: line, requirement: new Map([[milk, d('315')]]) }));
    expect(await balance(milk)).toMatchObject({ on_hand: '315.0000', reserved: '315.0000' });

    const first = await tx((t) =>
      consume(t, ctx, {
        orderLineId: line,
        eventKey: `e-${line}-1`,
        takes: [{ itemId: milk, qty: d('157.5') }],
      }),
    );
    expect(first.value.toFixed(4)).toBe('42.2625');
    const rest = await tx((t) =>
      consume(t, ctx, {
        orderLineId: line,
        eventKey: `e-${line}-2`,
        takes: [{ itemId: milk, qty: 'rest' }],
      }),
    );
    expect(rest.value.toFixed(4)).toBe('42.2625');
    expect(await balance(milk)).toEqual({
      on_hand: '0.0000',
      reserved: '0.0000',
      inventory_value: '0.0000',
    });

    const { rows } = await fx.pool.query<{ value: string; status: string }>(
      `SELECT c.value::text, r.status FROM cl.order_line_costs c
         JOIN cl.stock_reservations r ON r.order_line_id = c.order_line_id AND r.item_id = c.item_id
        WHERE c.order_line_id = $1 ORDER BY c.id`,
      [line],
    );
    expect(rows).toEqual([
      { value: '42.2625', status: 'closed' },
      { value: '42.2625', status: 'closed' },
    ]);
    expect(await openAlerts(milk)).toEqual(['zero']);
  });

  it('never consumes the same event twice (unique source key)', async () => {
    const milk = await newItem({ qty: '500', cost: '0.3' });
    const line = await nextLine();
    await tx((t) => reserve(t, { orderLineId: line, requirement: new Map([[milk, d('300')]]) }));
    const once = () =>
      tx((t) =>
        consume(t, ctx, {
          orderLineId: line,
          eventKey: `dup-${line}`,
          takes: [{ itemId: milk, qty: d('100') }],
        }),
      );
    await once();
    await expect(once()).rejects.toMatchObject({ code: '23505' });
    expect((await balance(milk))?.on_hand).toBe('400.0000');
  });

  it('releases units cancelled before they were made, and refuses taking more than is open', async () => {
    const milk = await newItem({ qty: '500', cost: '0.3' });
    const line = await nextLine();
    await tx((t) => reserve(t, { orderLineId: line, requirement: new Map([[milk, d('300')]]) }));
    await tx((t) => release(t, { orderLineId: line, takes: [{ itemId: milk, qty: d('100') }] }));
    expect(await balance(milk)).toMatchObject({ on_hand: '500.0000', reserved: '200.0000' });
    await expect(
      tx((t) => release(t, { orderLineId: line, takes: [{ itemId: milk, qty: d('250') }] })),
    ).rejects.toThrow(/cannot take/);
    await tx((t) => release(t, { orderLineId: line, takes: [{ itemId: milk, qty: 'rest' }] }));
    expect((await balance(milk))?.reserved).toBe('0.0000');
  });

  it('never blocks a pickup the book cannot cover: posts found stock first and alerts the owner (AT-67)', async () => {
    const milk = await newItem({ qty: '300', cost: '0.3' });
    const line = await nextLine();
    await tx((t) => reserve(t, { orderLineId: line, requirement: new Map([[milk, d('300')]]) }));
    // Spilled stock recorded while the drink was waiting: book now below reserved.
    await tx((t) =>
      wasteIngredient(t, ctx, audit, {
        itemId: milk,
        qty: d('100'),
        reasonCode: 'spilled',
        key: randomUUID(),
      }),
    );
    expect(await openAlerts(milk)).toEqual(['reservation_shortfall', 'zero']);

    await tx((t) =>
      consume(t, ctx, {
        orderLineId: line,
        eventKey: `f-${line}`,
        takes: [{ itemId: milk, qty: 'rest' }],
      }),
    );
    expect(await balance(milk)).toEqual({
      on_hand: '0.0000',
      reserved: '0.0000',
      inventory_value: '0.0000',
    });
    const { rows } = await fx.pool.query<{
      movement_type: string;
      qty_delta: string;
      flags: string[];
    }>(
      'SELECT movement_type, qty_delta::text, flags FROM cl.stock_movements WHERE item_id = $1 ORDER BY id',
      [milk],
    );
    expect(rows.map((r) => [r.movement_type, r.qty_delta, r.flags])).toEqual([
      ['opening', '300.0000', []],
      ['waste', '-100.0000', []],
      ['count_adjustment', '100.0000', ['auto_found_stock']],
      ['consumption', '-300.0000', []],
    ]);
    expect(await openAlerts(milk)).toEqual(['found_stock', 'zero']);
  });
});

describe('ingredient waste', () => {
  it('values waste at the average, records it, and refuses more than the book quantity or "other" without a note', async () => {
    const cream = await newItem({ qty: '1000', cost: '1.6' });
    const { value } = await tx((t) =>
      wasteIngredient(t, ctx, audit, {
        itemId: cream,
        qty: d('250'),
        reasonCode: 'expired',
        key: randomUUID(),
      }),
    );
    expect(value.toFixed(4)).toBe('400.0000');
    const { rows } = await fx.pool.query(
      'SELECT kind, qty::text, cost_value::text FROM cl.wastage_records WHERE item_id = $1',
      [cream],
    );
    expect(rows).toEqual([{ kind: 'ingredient', qty: '250.0000', cost_value: '400.0000' }]);
    await expect(
      tx((t) =>
        wasteIngredient(t, ctx, audit, {
          itemId: cream,
          qty: d('751'),
          reasonCode: 'spilled',
          key: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      tx((t) =>
        wasteIngredient(t, ctx, audit, {
          itemId: cream,
          qty: d('1'),
          reasonCode: 'other',
          key: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses "other" without a note in the database too', async () => {
    await expect(
      fx.pool.query(
        `INSERT INTO cl.wastage_records (kind, order_line_id, qty, reason_code, cost_value, recorded_by, business_date)
         VALUES ('prepared_item', 1, 1, 'other', 0, $1, $2)`,
        [fx.ownerId, BDATE],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('opens and resolves the low alert as stock crosses its threshold', async () => {
    const syrup = await newItem({ qty: '500', cost: '2' }, '200');
    expect(await openAlerts(syrup)).toEqual([]);
    await tx((t) =>
      wasteIngredient(t, ctx, audit, {
        itemId: syrup,
        qty: d('350'),
        reasonCode: 'damaged',
        key: randomUUID(),
      }),
    );
    expect(await openAlerts(syrup)).toEqual(['low']);
    const { rows } = await fx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cl.outbox_events WHERE event_type = 'alert.raised' AND topics = '{alerts}'`,
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });
});

describe('recipes and stock mode (D-29)', () => {
  async function variantWithRecipe(
    ingredients: { itemId: string; qty: string; takeawayOnly?: boolean }[],
  ) {
    const cat = await owner.call({
      method: 'POST',
      url: '/api/staff/v1/menu/categories',
      payload: { name: `Cat ${randomUUID()}` },
    });
    const created = await owner.call({
      method: 'POST',
      url: '/api/staff/v1/menu/items',
      payload: {
        categoryId: cat.json<{ id: string }>().id,
        name: 'Recipe drink',
        variants: [{ name: 'Regular', price: '500' }],
      },
    });
    const { id: menuItemId, variantIds } = created.json<{ id: string; variantIds: string[] }>();
    const variantId = variantIds[0] ?? '';
    const draft = await tx((t) =>
      createRecipeDraft(t, {
        variantId,
        components: ingredients.map((i) => ({
          itemId: i.itemId,
          qtyBase: i.qty,
          ...(i.takeawayOnly ? { forDineIn: false } : {}),
        })),
      }),
    );
    return { menuItemId, variantId, draftId: draft.id };
  }

  it('activates a recipe only when every ingredient is counted, then freezes it (AT-63)', async () => {
    const counted = await newItem({ qty: '1000', cost: '1' });
    const uncounted = await newItem();
    const { variantId, draftId } = await variantWithRecipe([
      { itemId: counted, qty: '10' },
      { itemId: uncounted, qty: '5' },
    ]);
    await expect(tx((t) => activateRecipe(t, audit, draftId))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(tx((t) => setStockMode(t, audit, variantId, 'recipe'))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    await tx((t) =>
      postOpeningBalance(t, ctx, audit, { itemId: uncounted, qty: d('100'), unitCost: d('1') }),
    );
    await tx((t) => activateRecipe(t, audit, draftId));
    await tx((t) => setStockMode(t, audit, variantId, 'recipe'));
    await expect(
      fx.pool.query('UPDATE cl.recipe_components SET qty_base = 99 WHERE recipe_version_id = $1', [
        draftId,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      fx.pool.query(`UPDATE cl.recipe_versions SET status = 'draft' WHERE id = $1`, [draftId]),
    ).rejects.toMatchObject({ code: '23001' });

    // A new version retires the old one.
    const second = await tx((t) =>
      createRecipeDraft(t, { variantId, components: [{ itemId: counted, qtyBase: '12' }] }),
    );
    expect(second.versionNo).toBe(2);
    await tx((t) => activateRecipe(t, audit, second.id));
    const { rows } = await fx.pool.query<{ version_no: number; status: string }>(
      'SELECT version_no, status FROM cl.recipe_versions WHERE variant_id = $1 ORDER BY version_no',
      [variantId],
    );
    expect(rows).toEqual([
      { version_no: 1, status: 'retired' },
      { version_no: 2, status: 'active' },
    ]);
  });

  it('shows a recipe size out of stock per order type, and a choice whose ingredient is short', async () => {
    const coffee = await newItem({ qty: '100', cost: '9' });
    const cups = await newItem({ qty: '1', cost: '12' });
    const oat = await newItem({ qty: '50', cost: '1' });
    const milk = await newItem({ qty: '5000', cost: '0.3' });
    const { menuItemId, variantId, draftId } = await variantWithRecipe([
      { itemId: coffee, qty: '18' },
      { itemId: milk, qty: '150' },
      { itemId: cups, qty: '1', takeawayOnly: true },
    ]);
    const group = await owner.call({
      method: 'POST',
      url: '/api/staff/v1/modifier-groups',
      payload: {
        name: 'Milk',
        minSelect: 0,
        maxSelect: 1,
        options: [{ name: 'Oat', priceDelta: '80' }],
      },
    });
    const optionId = group.json<{ optionIds: string[] }>().optionIds[0] ?? '';
    await owner.call({
      method: 'PATCH',
      url: `/api/staff/v1/menu/items/${menuItemId}`,
      payload: { expectedVersion: 1, modifierGroupIds: [group.json<{ id: string }>().id] },
    });
    await tx(async (t) => {
      await addModifierRule(t, {
        optionId,
        action: 'replace',
        itemId: milk,
        replacementItemId: oat,
        effectiveFrom: new Date('2026-01-01'),
      });
      await activateRecipe(t, audit, draftId);
      await setStockMode(t, audit, variantId, 'recipe');
    });

    const view = async (orderType?: string) => {
      const res = await owner.call({
        method: 'GET',
        url: `/api/staff/v1/menu${orderType ? `?orderType=${orderType}` : ''}`,
      });
      expect(res.statusCode).toBe(200);
      const item = res
        .json<{
          categories: {
            items: {
              id: string;
              variants: { id: string; available: boolean; unavailableReason: string | null }[];
              modifierGroups: { options: { id: string; available: boolean }[] }[];
            }[];
          }[];
        }>()
        .categories.flatMap((c) => c.items)
        .find((i) => i.id === menuItemId);
      return {
        variant: item?.variants.find((v) => v.id === variantId),
        option: item?.modifierGroups[0]?.options.find((o) => o.id === optionId),
      };
    };

    expect((await view()).variant).toMatchObject({ available: true, unavailableReason: null });
    expect((await view()).option?.available).toBe(false); // 50 ml oat < 150 ml
    const line = await nextLine();
    await tx((t) => reserve(t, { orderLineId: line, requirement: new Map([[cups, d('1')]]) }));
    expect((await view('takeaway')).variant).toMatchObject({
      available: false,
      unavailableReason: 'out_of_stock',
    });
    expect((await view('dine_in')).variant).toMatchObject({ available: true });
    await tx((t) => release(t, { orderLineId: line, takes: [{ itemId: cups, qty: 'rest' }] }));
    expect((await view('takeaway')).variant?.available).toBe(true);
    expect(
      (await owner.call({ method: 'GET', url: '/api/staff/v1/menu?orderType=pickup' })).statusCode,
    ).toBe(400);
  });
});

describe('the nightly stock check (COST_VALUATION.md §11, AT-94)', () => {
  it('finds nothing wrong after real work, and reports a tampered balance without fixing it', async () => {
    expect(await findStockMismatches(fx.pool)).toEqual([]);
    const victim = await newItem({ qty: '100', cost: '1' });
    const admin = new pg.Client({ connectionString: urlFor(fx.db.name) });
    await admin.connect();
    try {
      await admin.query(
        'UPDATE cl.inventory_balances SET on_hand = 90, inventory_value = 90 WHERE item_id = $1',
        [victim],
      );
    } finally {
      await admin.end();
    }
    const tasks = makeTasks(fx.pool);
    const task = tasks['stock:reconcile'];
    if (!task) throw new Error('stock:reconcile task missing');
    const logged: string[] = [];
    const log = (m: string) => logged.push(m);
    await task({}, { logger: { info: log, error: log } } as never);
    expect(logged.join('\n')).toMatch(/found 2 mismatches/);
    expect(await openAlerts(victim)).toContain('balance_mismatch');
    expect((await balance(victim))?.on_hand).toBe('90.0000'); // never auto-corrected
    const again = await tx((t) => raiseMismatchAlerts(t));
    expect(again.map((m) => m.itemId)).toEqual([victim, victim]);
  });
});

describe('sample shop (P3-5)', () => {
  it('loads ~40 items and 15 ingredients through the services, with consistent stock', async () => {
    const fresh = await identityFixture({ sessionRole: 'cl_app', now: () => NOW });
    try {
      const shop = readSampleShop();
      const summary = await loadSampleShop(fresh.pool, fresh.ownerId, shop);
      expect(summary.ingredients.size).toBe(15);
      expect(summary.items).toBe(40);
      expect(summary.trackedVariants).toBeGreaterThan(20);
      expect(await findStockMismatches(fresh.pool)).toEqual([]);
      await expect(loadSampleShop(fresh.pool, fresh.ownerId, shop)).rejects.toThrow(
        /already has a menu/,
      );

      const client = await fresh.loggedIn(OWNER.username, OWNER.password);
      const menu = await client.call({
        method: 'GET',
        url: '/api/staff/v1/menu?orderType=takeaway',
      });
      const names = menu
        .json<{ categories: { items: { name: string }[] }[] }>()
        .categories.flatMap((c) => c.items.map((i) => i.name));
      expect(names).toHaveLength(40);
      expect(names).toContain('Latte');
    } finally {
      await fresh.close();
    }
  });
});
