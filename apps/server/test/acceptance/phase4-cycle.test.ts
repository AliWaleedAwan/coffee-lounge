/**
 * Phase 4 exit cycle (PLAN.md §4 step 4.10, roadmap §9), on the sample data until the
 * shop's own arrives (I-7…I-9): the shipped templates are imported through step 4.9 (their
 * example SKUs renamed), a recipe is checked and activated, then a working day: a delivery
 * received by barcode with lot and expiry, cappuccinos sold and picked up (one with oat
 * milk and an extra shot), milk spilled, a count of the dairy shelf approved by the owner;
 * the nightly expiry scan and stock check then find nothing wrong, and every sale has its
 * frozen cost.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findStockMismatches } from '../../src/modules/stock/index.ts';
import { makeTasks } from '../../src/worker/runner.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;

type Body = Record<string, unknown>;
async function call(client: Client, method: 'GET' | 'POST', path: string, payload?: object) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  expect(res.statusCode, `${method} ${path}: ${res.body}`).toBeLessThan(300);
  return res.body ? res.json<Body>() : {};
}
const template = (file: string) =>
  readFileSync(new URL(`../../../../docs/templates/${file}`, import.meta.url), 'utf8').replaceAll(
    'EX-',
    'SAMP-',
  );
const importFile = (client: Client, key: string, csv: string) =>
  call(client, 'POST', `/imports/${key}/apply`, { csv });
const sku = async (code: string) =>
  (
    await fx.pool.query<{ id: string }>('SELECT id::text FROM cl.inventory_items WHERE sku = $1', [
      code,
    ])
  ).rows[0]?.id ?? '';
const balance = async (id: string) =>
  (
    await fx.pool.query<{ on_hand: string; reserved: string }>(
      'SELECT on_hand::text, reserved::text FROM cl.inventory_balances WHERE item_id = $1',
      [id],
    )
  ).rows[0];

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('cyc-clerk', ['inventory_clerk']);
  clerk = await fx.loggedIn('cyc-clerk');
});
afterAll(async () => {
  await fx.close();
});

describe('Phase 4 exit cycle on the sample data', () => {
  it('imports, activates, receives, sells, wastes and counts, and the nightly check finds nothing', async () => {
    // ---- The data, through the import (step 4.9).
    await importFile(clerk, 'items', template('01_inventory_items.csv'));
    await importFile(clerk, 'packs', template('02_pack_sizes_barcodes.csv'));
    await importFile(
      owner,
      'opening',
      template('03_opening_stock.csv').replace('2026-10-25', '2099-10-25'),
    );
    await importFile(
      owner,
      'opening',
      'sku,lot_code,expiry_date,quantity,uom,total_value\nSAMP-MILK-OAT,OAT1,2099-03-01,3,l,1200\nSAMP-SUGAR-SACHET,,,300,pcs,300\n',
    );
    await importFile(clerk, 'suppliers', template('08_suppliers.csv'));
    await importFile(owner, 'menu', template('04_menu.csv'));
    await importFile(owner, 'modifiers', template('05_modifiers.csv'));
    await importFile(clerk, 'recipes', template('06_recipes.csv'));
    await importFile(clerk, 'modifier-rules', template('07_modifier_recipe_rules.csv'));

    // ---- The recipe, checked and activated; the size tracks stock.
    const overview = (await call(clerk, 'GET', '/recipes'))['items'] as {
      name: string;
      variants: Body[];
    }[];
    const regular = overview
      .find((i) => i.name === 'Cappuccino')
      ?.variants.find((v) => v['name'] === 'Regular');
    const variantId = regular?.['id'] as string;
    const recipe = await call(clerk, 'GET', `/recipes/variants/${variantId}`);
    const draft = (recipe['versions'] as Body[]).find((v) => v['status'] === 'draft');
    const preview = await call(clerk, 'POST', '/recipes/preview', {
      variantId,
      orderType: 'takeaway',
      optionIds: (recipe['options'] as Body[])
        .filter((o) => ['Oat milk', 'Extra shot'].includes(o['name'] as string))
        .map((o) => o['id']),
      draft: true,
    });
    expect((preview['lines'] as Body[]).map((l) => [l['name'], l['qtyPerUnit']])).toEqual([
      ['Espresso beans (house blend)', '27.0000'],
      ['Oat milk', '157.5000'],
      ['Takeaway cup 12 oz with lid', '1.0000'],
    ]); // AT-64 with the shipped data
    await call(clerk, 'POST', `/recipes/versions/${draft?.['id'] as string}/activate`, {});
    await call(clerk, 'POST', `/recipes/variants/${variantId}/stock-mode`, { mode: 'recipe' });

    // ---- Morning delivery: 6 cartons by barcode, with lot and expiry.
    const scan = await call(clerk, 'GET', '/inventory/scan?code=8960000000017');
    const match = scan['match'] as { itemId: string; pack: { id: string } };
    const milk = match.itemId;
    await call(clerk, 'POST', '/purchase-receipts', {
      paidNow: true,
      paymentChannel: 'cash',
      lines: [
        {
          itemId: milk,
          packSizeId: match.pack.id,
          packQty: '6',
          lineCost: '1650',
          lotCode: 'L2410B',
          expiryDate: '2099-11-02',
        },
      ],
    });
    expect((await balance(milk))?.on_hand).toBe('18000.0000');

    // ---- Service: three cappuccinos, one with oat milk and an extra shot, all picked up.
    const table = await call(owner, 'POST', '/tables', { code: 'C1', name: 'Cycle table' });
    const session = await call(owner, 'POST', `/tables/${table['id'] as string}/sessions`, {});
    const oat = (recipe['options'] as Body[]).find((o) => o['name'] === 'Oat milk')?.['id'];
    const shot = (recipe['options'] as Body[]).find((o) => o['name'] === 'Extra shot')?.['id'];
    const round = await call(owner, 'POST', `/sessions/${session['id'] as string}/rounds`, {
      lines: [
        { variantId, qty: 2, modifierOptionIds: [] },
        { variantId, qty: 1, modifierOptionIds: [oat, shot] },
      ],
    });
    const { rows: lines } = await fx.pool.query<{ id: string; qty: number }>(
      'SELECT id::text, qty FROM cl.order_lines WHERE round_id = $1 ORDER BY line_no',
      [round['id']],
    );
    for (const l of lines) await call(owner, 'POST', `/lines/${l.id}/pickup`, { qty: l.qty });
    // Dine-in: 2 × 157.5 ml whole milk; the oat one uses oat milk; no cups.
    expect((await balance(milk))?.on_hand).toBe('17685.0000');
    expect((await balance(await sku('SAMP-MILK-OAT')))?.on_hand).toBe('2842.5000');
    expect((await balance(await sku('SAMP-BEANS-HOUSE')))?.on_hand).toBe('3437.0000'); // 3500 − 18 − 18 − 27
    expect((await balance(await sku('SAMP-CUP-12OZ')))?.on_hand).toBe('400.0000'); // dine-in takes no cup

    // ---- Waste and a count of the dairy shelf.
    await call(clerk, 'POST', '/inventory/waste', {
      itemId: milk,
      qty: '200',
      reasonCode: 'spilled',
    });
    const count = await call(clerk, 'POST', '/stock-counts', {
      scope: 'category',
      category: 'Dairy',
    });
    const view = await call(clerk, 'GET', `/stock-counts/${count['id'] as string}`);
    const milkLots = ((view['items'] as Body[]).find((i) => i['id'] === milk)?.['lots'] ??
      []) as Body[];
    expect(milkLots).toHaveLength(2);
    for (const lot of milkLots) {
      await call(clerk, 'POST', `/stock-counts/${count['id'] as string}/lines`, {
        itemId: milk,
        lotId: lot['id'],
        countedQty: lot['lotCode'] === 'L2410A' ? '11400' : '6000',
      });
    }
    const submitted = await call(
      clerk,
      'POST',
      `/stock-counts/${count['id'] as string}/submit`,
      {},
    );
    if (submitted['status'] === 'submitted') {
      await call(owner, 'POST', `/stock-counts/${count['id'] as string}/approve`, {});
    }
    expect((await balance(milk))?.on_hand).toBe('17400.0000');

    // ---- Night: expiry scan and stock check.
    const tasks = makeTasks(fx.pool);
    const logged: string[] = [];
    const log = (m: string) => logged.push(m);
    await tasks['stock:expiry_scan']?.({}, { logger: { info: log, error: log } } as never);
    await tasks['stock:reconcile']?.({}, { logger: { info: log, error: log } } as never);
    expect(logged).toContain('stock check: every balance matches its movements');
    expect(await findStockMismatches(fx.pool)).toEqual([]);
    const { rows: mismatch } = await fx.pool.query(
      `SELECT 1 FROM cl.inventory_alerts WHERE kind = 'balance_mismatch' AND state <> 'resolved'`,
    );
    expect(mismatch).toEqual([]);
    // Every sale has its frozen cost (COGS); the consumption of each line is costed.
    const { rows: costs } = await fx.pool.query<{ line: string; value: string }>(
      `SELECT order_line_id::text AS line, sum(value)::text AS value FROM cl.order_line_costs
        WHERE order_line_id = ANY($1::bigint[]) GROUP BY order_line_id ORDER BY order_line_id`,
      [lines.map((l) => l.id)],
    );
    expect(costs).toHaveLength(2);
    for (const c of costs) expect(Number(c.value)).toBeGreaterThan(0);
  });
});
