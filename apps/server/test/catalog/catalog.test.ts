/**
 * Menu and catalogue API (API.md §5.7) as the application role, so the table grants of
 * migration 0007 are exercised too. The clock is fixed: Wednesday 2026-10-21, 12:00 in
 * Karachi.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as catalog from '../../src/modules/catalog/service.ts';
import { race, raceRuns, repeatRace, tally } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

const NOW = new Date('2026-10-21T12:00:00+05:00');
const url = (path: string): string => `/api/staff/v1${path}`;

let fx: IdentityFixture;
let owner: Client;
beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app', now: () => NOW });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
});
afterAll(async () => {
  await fx.close();
});

interface MenuVariant {
  id: string;
  name: string;
  price: string;
  promotionPrice: string | null;
  promotionId: string | null;
  available: boolean;
  unavailableReason: string | null;
  unavailableNote: string | null;
  version?: number;
}
interface MenuItem {
  id: string;
  name: string;
  dietaryTags: string[];
  version?: number;
  variants: MenuVariant[];
  modifierGroups: { id: string; name: string; options: { id: string; priceDelta: string }[] }[];
}
interface Menu {
  categories: { id: string; name: string; version?: number; items: MenuItem[] }[];
}

async function send(
  client: Client,
  method: 'POST' | 'PATCH',
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await client.call({ method, url: url(path), payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json<Record<string, unknown>>() : {} };
}

async function ok<T>(
  client: Client,
  method: 'POST' | 'PATCH',
  path: string,
  payload: unknown,
): Promise<T> {
  const res = await send(client, method, path, payload);
  if (res.status >= 300)
    throw new Error(`${method} ${path}: ${String(res.status)} ${JSON.stringify(res.body)}`);
  return res.body as T;
}

async function menu(client: Client, path = '/menu'): Promise<Menu> {
  const res = await client.call({ method: 'GET', url: url(path) });
  expect(res.statusCode).toBe(200);
  return res.json<Menu>();
}

function findItem(m: Menu, id: string): MenuItem | undefined {
  return m.categories.flatMap((c) => c.items).find((i) => i.id === id);
}

async function newCategory(name: string): Promise<string> {
  return (await ok<{ id: string }>(owner, 'POST', '/menu/categories', { name })).id;
}

async function newItem(categoryId: string, name: string, extra: object = {}) {
  return ok<{ id: string; variantIds: string[] }>(owner, 'POST', '/menu/items', {
    categoryId,
    name,
    variants: [
      { name: 'Regular', price: '450' },
      { name: 'Large', price: '550' },
    ],
    ...extra,
  });
}

async function auditCount(action: string, entityId: string): Promise<number> {
  const { rows } = await fx.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM cl.audit_events WHERE action = $1 AND entity_id = $2',
    [action, entityId],
  );
  return rows[0]?.n ?? 0;
}

describe('building the menu', () => {
  it('creates categories, modifier groups and items, and shows them on the staff menu', async () => {
    const coffee = await newCategory('Coffee');
    const milk = await ok<{ id: string; optionIds: string[] }>(owner, 'POST', '/modifier-groups', {
      name: 'Milk',
      minSelect: 1,
      maxSelect: 1,
      options: [{ name: 'Whole' }, { name: 'Oat', priceDelta: '80' }],
    });
    const latte = await newItem(coffee, 'Latte', { modifierGroupIds: [milk.id] });

    const view = findItem(await menu(owner), latte.id);
    expect(view?.variants.map((v) => [v.name, v.price, v.available])).toEqual([
      ['Regular', '450.00', true],
      ['Large', '550.00', true],
    ]);
    expect(view?.modifierGroups[0]?.options.map((o) => o.priceDelta)).toEqual(['0.00', '80.00']);
    expect(await auditCount('menu.item.create', latte.id)).toBe(1);

    const { rows } = await fx.pool.query<{ event_type: string; topics: string[] }>(
      `SELECT event_type, topics FROM cl.outbox_events WHERE entity_type = 'menu_item' AND entity_id = $1`,
      [latte.id],
    );
    expect(rows).toEqual([{ event_type: 'menu.changed', topics: ['menu'] }]);
  });

  it('shows dietary tags exactly as entered, and infers none (AT-126, API part)', async () => {
    const cakes = await newCategory('Cakes');
    const tags = ['Contains NUTS', 'egg-free ', 'Halal ✓'];
    const cake = await newItem(cakes, 'Walnut brownie', { dietaryTags: tags });
    const plain = await newItem(cakes, 'Peanut cookie');
    const m = await menu(owner);
    expect(findItem(m, cake.id)?.dietaryTags).toEqual(tags);
    expect(findItem(m, plain.id)?.dietaryTags).toEqual([]); // "peanut" in the name adds nothing

    const blank = await send(owner, 'POST', '/menu/items', {
      categoryId: cakes,
      name: 'Muffin',
      dietaryTags: ['  '],
      variants: [{ name: 'Regular', price: '200' }],
    });
    expect(blank.status).toBe(400);
  });

  it('accepts whole-rupee prices only (D-16)', async () => {
    const tea = await newCategory('Tea');
    const res = await send(owner, 'POST', '/menu/items', {
      categoryId: tea,
      name: 'Chai',
      variants: [{ name: 'Cup', price: '120.50' }],
    });
    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('VALIDATION_FAILED');
  });

  it('refuses a modifier group whose minimum exceeds its maximum', async () => {
    const res = await send(owner, 'POST', '/modifier-groups', {
      name: 'Shots',
      minSelect: 3,
      maxSelect: 2,
      options: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }],
    });
    expect(res.status).toBe(400);
  });
});

describe('editing with versions', () => {
  it('answers 409 STALE_STATE to an edit based on an old version', async () => {
    const cat = await newCategory('Juices');
    const item = await newItem(cat, 'Orange juice');
    const first = await send(owner, 'PATCH', `/menu/items/${item.id}`, {
      expectedVersion: 1,
      name: 'Fresh orange',
    });
    expect(first.status).toBe(200);
    expect(first.body['version']).toBe(2);
    const second = await send(owner, 'PATCH', `/menu/items/${item.id}`, {
      expectedVersion: 1,
      name: 'Orange',
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'STALE_STATE', currentVersion: 2 });
    expect(findItem(await menu(owner), item.id)?.name).toBe('Fresh orange');
  });

  it('lets exactly one of two managers win a simultaneous edit of one item (CT-10)', async () => {
    const cat = await newCategory('Sandwiches');
    await repeatRace(raceRuns(), async (run) => {
      const item = await newItem(cat, `Club ${String(run)}`);
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: async ({ index, pool, barrier }) => {
          await barrier.wait();
          return catalog.updateItem(
            pool,
            {
              actor: { kind: 'user', userId: fx.ownerId },
              correlationId: '00000000-0000-4000-8000-00000000000a',
            },
            item.id,
            { expectedVersion: 1, name: `Club ${String(run)} by manager ${String(index)}` },
          );
        },
      });
      const { ok: winners, failed } = tally(outcomes);
      expect(winners).toHaveLength(1);
      expect(failed).toEqual(['STALE_STATE']);
      expect(await auditCount('menu.item.update', item.id)).toBe(1);
    });
  });

  it('keeps an item with at least one active variant and a category empty before archiving', async () => {
    const cat = await newCategory('Seasonal');
    const item = await newItem(cat, 'Pumpkin latte');
    const [regular, large] = item.variantIds;

    const stillUsed = await send(owner, 'POST', `/menu/categories/${cat}/archive`, {
      expectedVersion: 1,
    });
    expect(stillUsed.status).toBe(400);

    expect(
      (await send(owner, 'POST', `/menu/variants/${large ?? ''}/archive`, { expectedVersion: 1 }))
        .status,
    ).toBe(204);
    const last = await send(owner, 'POST', `/menu/variants/${regular ?? ''}/archive`, {
      expectedVersion: 1,
    });
    expect(last.status).toBe(400);
    expect(String(last.body['detail'])).toMatch(/at least one active variant/);

    expect(
      (await send(owner, 'POST', `/menu/items/${item.id}/archive`, { expectedVersion: 1 })).status,
    ).toBe(204);
    expect(findItem(await menu(owner), item.id)).toBeUndefined();
    expect(
      (await send(owner, 'POST', `/menu/categories/${cat}/archive`, { expectedVersion: 1 })).status,
    ).toBe(204);
  });
});

describe('prices', () => {
  it('changes a price with a reason, keeps history and audits it', async () => {
    const cat = await newCategory('Hot chocolate');
    const item = await newItem(cat, 'Classic');
    const variantId = item.variantIds[0] ?? '';
    const changed = await ok<{ version: number; price: string }>(
      owner,
      'POST',
      `/menu/variants/${variantId}/price`,
      {
        expectedVersion: 1,
        price: '480',
        reason: 'Milk price went up',
      },
    );
    expect(changed).toMatchObject({ version: 2, price: '480.00' });

    const history = await owner.call({
      method: 'GET',
      url: url(`/menu/variants/${variantId}/price-history`),
    });
    expect(
      history.json<{ items: { oldPrice: string | null; newPrice: string; reason: string }[] }>()
        .items,
    ).toMatchObject([
      { oldPrice: '450.00', newPrice: '480.00', reason: 'Milk price went up' },
      { oldPrice: null, newPrice: '450.00', reason: 'initial price' },
    ]);
    expect(await auditCount('menu.price.change', variantId)).toBe(1);

    const same = await send(owner, 'POST', `/menu/variants/${variantId}/price`, {
      expectedVersion: 2,
      price: '480',
      reason: 'No change',
    });
    expect(same.status).toBe(400);
  });

  it('needs the price permission to change a modifier price, not just menu editing', async () => {
    const editor = await fx.addUser('menu-editor', ['inventory_clerk']);
    await fx.pool.query(
      `INSERT INTO cl.user_permission_overrides (user_id, permission_key, effect, reason, granted_by)
       VALUES ($1, 'menu.manage', 'grant', 'Keeps the menu tidy', $2)`,
      [editor, fx.ownerId],
    );
    const client = await fx.loggedIn('menu-editor');
    const group = await ok<{ id: string; optionIds: string[] }>(
      client,
      'POST',
      '/modifier-groups',
      {
        name: 'Syrup',
        minSelect: 0,
        maxSelect: 1,
        options: [{ name: 'Vanilla', priceDelta: '60' }],
      },
    );
    const optionId = group.optionIds[0] ?? '';
    const priced = await send(client, 'PATCH', `/modifier-options/${optionId}`, {
      expectedVersion: 1,
      priceDelta: '70',
    });
    expect(priced.status).toBe(403);
    const renamed = await send(client, 'PATCH', `/modifier-options/${optionId}`, {
      expectedVersion: 1,
      name: 'Vanilla bean',
      priceDelta: '60',
    });
    expect(renamed.status).toBe(200);
    const byOwner = await send(owner, 'PATCH', `/modifier-options/${optionId}`, {
      expectedVersion: 2,
      priceDelta: '70',
    });
    expect(byOwner.status).toBe(200);
    expect(await auditCount('menu.price.change', optionId)).toBe(1);
  });
});

describe('promotions on the menu (AT-112, integration)', () => {
  it('shows the best single promotion that applies now, and none outside its window', async () => {
    const cat = await newCategory('Iced');
    const item = await newItem(cat, 'Iced latte');
    const regularId = item.variantIds[0] ?? '';
    const tenPercent = await ok<{ id: string }>(owner, 'POST', '/promotions', {
      name: 'Midweek 10%',
      kind: 'percent',
      value: '10',
      startsOn: '2026-10-01',
      daysOfWeek: [3],
      itemIds: [item.id],
    });
    const fiftyOff = await ok<{ id: string }>(owner, 'POST', '/promotions', {
      name: 'Iced Rs 50 off',
      kind: 'fixed',
      value: '50',
      startsOn: '2026-10-01',
      categoryIds: [cat],
    });
    const evening = await ok<{ id: string }>(owner, 'POST', '/promotions', {
      name: 'Evening half price',
      kind: 'percent',
      value: '50',
      startsOn: '2026-10-01',
      timeFrom: '18:00',
      timeTo: '21:00',
      itemIds: [item.id],
    });

    const regular = findItem(await menu(owner), item.id)?.variants.find((v) => v.id === regularId);
    // 450: 10% → 405, Rs 50 off → 400 (best), evening 50% not yet (12:00).
    expect(regular).toMatchObject({
      price: '450.00',
      promotionPrice: '400.00',
      promotionId: fiftyOff.id,
    });

    const off = await send(owner, 'PATCH', `/promotions/${fiftyOff.id}`, {
      expectedVersion: 1,
      isActive: false,
    });
    expect(off.status).toBe(200);
    const next = findItem(await menu(owner), item.id)?.variants.find((v) => v.id === regularId);
    expect(next).toMatchObject({ promotionPrice: '405.00', promotionId: tenPercent.id });

    const list = await owner.call({ method: 'GET', url: url('/promotions') });
    expect(list.json<{ items: { id: string }[] }>().items.map((p) => p.id)).toEqual(
      expect.arrayContaining([tenPercent.id, fiftyOff.id, evening.id]),
    );
  });

  it('refuses a promotion without targets or with an impossible percentage', async () => {
    const base = { name: 'Bad', kind: 'percent', startsOn: '2026-10-01' };
    expect((await send(owner, 'POST', '/promotions', { ...base, value: '10' })).status).toBe(400);
    const cat = await newCategory('Promo test');
    expect(
      (await send(owner, 'POST', '/promotions', { ...base, value: '120', categoryIds: [cat] }))
        .status,
    ).toBe(400);
  });
});

describe('temporarily unavailable', () => {
  it('marks a variant unavailable with a note, announces it, and back again', async () => {
    const cashier = await fx.addUser('cashier-1', ['cashier']);
    expect(cashier).not.toBe('');
    const client = await fx.loggedIn('cashier-1');
    const cat = await newCategory('Blended');
    const item = await newItem(cat, 'Frappe');
    const variantId = item.variantIds[0] ?? '';

    const off = await send(client, 'POST', `/menu/variants/${variantId}/availability`, {
      available: false,
      reason: 'Blender broken',
    });
    expect(off.status).toBe(200);
    const view = findItem(await menu(client), item.id)?.variants.find((v) => v.id === variantId);
    expect(view).toMatchObject({
      available: false,
      unavailableReason: 'marked_unavailable',
      unavailableNote: 'Blender broken',
    });
    expect(await auditCount('menu.availability.off', variantId)).toBe(1);
    const { rows } = await fx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cl.outbox_events
        WHERE event_type = 'availability.changed' AND entity_id = $1 AND topics = '{menu}'`,
      [variantId],
    );
    expect(rows[0]?.n).toBe(1);

    expect(
      (await send(client, 'POST', `/menu/variants/${variantId}/availability`, { available: true }))
        .status,
    ).toBe(200);
    const back = findItem(await menu(client), item.id)?.variants.find((v) => v.id === variantId);
    expect(back).toMatchObject({ available: true, unavailableReason: null, unavailableNote: null });
  });

  it('hides inactive items from the staff menu but keeps them in the catalogue view', async () => {
    const cat = await newCategory('Hidden');
    const item = await newItem(cat, 'Secret menu');
    await ok(owner, 'PATCH', `/menu/items/${item.id}`, { expectedVersion: 1, isActive: false });
    expect(findItem(await menu(owner), item.id)).toBeUndefined();
    expect(findItem(await menu(owner, '/menu/catalog'), item.id)).toMatchObject({ version: 2 });
  });
});
