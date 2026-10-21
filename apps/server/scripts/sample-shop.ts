/**
 * Loads the sample shop (scripts/sample-shop.json, Phase 3 proposal P3-5) through the same
 * services the app uses: ingredients with opening balances, choice groups with their
 * recipe rules, ~40 menu items, and active recipes for the tracked sizes. Sizes without
 * a recipe stay untracked (D-29). Refuses a database that already has a menu.
 * Development and tests only: the owner's real menu replaces it.
 *
 *   node --env-file=../../.env scripts/sample-shop.ts      (loads into DATABASE_URL)
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Decimal } from '@cl/shared';
import type pg from 'pg';
import {
  createCategory,
  createItem,
  createModifierGroup,
  type Who,
} from '../src/modules/catalog/index.ts';
import {
  activateRecipe,
  addModifierRule,
  createInventoryItem,
  createRecipeDraft,
  postOpeningBalance,
  setStockMode,
  type ComponentInput,
} from '../src/modules/stock/index.ts';
import { loadConfig } from '../src/platform/config.ts';
import { createPool } from '../src/platform/db/pool.ts';
import { withTransaction } from '../src/platform/db/tx.ts';
import { businessDateOf } from '../src/platform/settings.ts';

type OrderType = 'dine_in' | 'takeaway' | 'delivery';

interface SampleShop {
  ingredients: {
    sku: string;
    name: string;
    category: string;
    uom: 'g' | 'ml' | 'pcs';
    low: string;
    opening: string;
    unitCost: string;
  }[];
  modifierGroups: {
    name: string;
    min: number;
    max: number;
    options: {
      name: string;
      priceDelta: string;
      rules: {
        action: 'add' | 'remove' | 'replace' | 'scale';
        sku: string;
        replacement?: string;
        qty?: string;
        factor?: string;
      }[];
    }[];
  }[];
  takeawayPackaging: Record<string, string[]>;
  categories: {
    name: string;
    items: {
      name: string;
      tags?: string[];
      allow?: OrderType[];
      groups?: string[];
      variants: { name: string; price: string; recipe?: Record<string, string>; cup?: string }[];
    }[];
  }[];
}

export const SAMPLE_SHOP_FILE = fileURLToPath(new URL('./sample-shop.json', import.meta.url));

export function readSampleShop(file = SAMPLE_SHOP_FILE): SampleShop {
  return JSON.parse(readFileSync(file, 'utf8')) as SampleShop;
}

export interface SampleSummary {
  ingredients: Map<string, string>;
  items: number;
  trackedVariants: number;
}

/** "150@0.05" → 150 with a 5 % waste factor. */
function component(
  itemId: string,
  spec: string,
  extra: Partial<ComponentInput> = {},
): ComponentInput {
  const [qtyBase = spec, wasteFactor = '0'] = spec.split('@');
  return { itemId, qtyBase, wasteFactor, ...extra };
}

export async function loadSampleShop(
  pool: pg.Pool,
  ownerId: string,
  shop: SampleShop = readSampleShop(),
): Promise<SampleSummary> {
  const { rows } = await pool.query('SELECT 1 FROM cl.menu_categories LIMIT 1');
  if (rows.length > 0)
    throw new Error('This database already has a menu; the sample shop is for an empty one.');
  const who: Who = { actor: { kind: 'user', userId: ownerId }, correlationId: randomUUID() };
  const ctx = { actorUserId: ownerId, businessDate: await businessDateOf(pool, new Date()) };
  const sku = new Map<string, string>();
  const idOf = (code: string): string => {
    const id = sku.get(code);
    if (id === undefined) throw new Error(`sample shop: unknown ingredient ${code}`);
    return id;
  };

  await withTransaction(pool, async (tx) => {
    for (const i of shop.ingredients) {
      const { id } = await createInventoryItem(tx, who, {
        sku: i.sku,
        name: i.name,
        category: i.category,
        baseUom: i.uom,
        lowThreshold: i.low,
      });
      sku.set(i.sku, id);
      await postOpeningBalance(tx, ctx, who, {
        itemId: id,
        qty: new Decimal(i.opening),
        unitCost: new Decimal(i.unitCost),
      });
    }
  });

  const groups = new Map<string, string>();
  for (const g of shop.modifierGroups) {
    const created = await createModifierGroup(pool, who, {
      name: g.name,
      minSelect: g.min,
      maxSelect: g.max,
      options: g.options.map((o) => ({ name: o.name, priceDelta: o.priceDelta })),
    });
    groups.set(g.name, created.id);
    await withTransaction(pool, async (tx) => {
      for (const [i, o] of g.options.entries()) {
        const optionId = created.optionIds[i] ?? '';
        for (const r of o.rules) {
          await addModifierRule(tx, {
            optionId,
            action: r.action,
            itemId: idOf(r.sku),
            ...(r.replacement ? { replacementItemId: idOf(r.replacement) } : {}),
            ...(r.qty ? { qtyBase: r.qty } : {}),
            ...(r.factor ? { scaleFactor: r.factor } : {}),
          });
        }
      }
    });
  }

  let items = 0;
  let trackedVariants = 0;
  for (const category of shop.categories) {
    const { id: categoryId } = await createCategory(pool, who, { name: category.name });
    for (const item of category.items) {
      const allow = item.allow ?? ['dine_in', 'takeaway', 'delivery'];
      const created = await createItem(pool, who, {
        categoryId,
        name: item.name,
        dietaryTags: item.tags ?? [],
        allowDineIn: allow.includes('dine_in'),
        allowTakeaway: allow.includes('takeaway'),
        allowDelivery: allow.includes('delivery'),
        modifierGroupIds: (item.groups ?? []).map((name) => groups.get(name) ?? ''),
        variants: item.variants.map((v) => ({ name: v.name, price: v.price })),
      });
      items += 1;
      await withTransaction(pool, async (tx) => {
        for (const [i, v] of item.variants.entries()) {
          if (!v.recipe) continue;
          const variantId = created.variantIds[i] ?? '';
          const components = Object.entries(v.recipe).map(([code, spec]) =>
            component(idOf(code), spec),
          );
          for (const code of v.cup ? (shop.takeawayPackaging[v.cup] ?? []) : []) {
            components.push(component(idOf(code), '1', { forDineIn: false }));
          }
          const draft = await createRecipeDraft(tx, { variantId, components });
          await activateRecipe(tx, who, draft.id);
          await setStockMode(tx, who, variantId, 'recipe');
          trackedVariants += 1;
        }
      });
    }
  }
  return { ingredients: sku, items, trackedVariants };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.env);
  const pool = createPool({ connectionString: config.DATABASE_URL, max: 4 });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id::text FROM cl.users WHERE is_owner AND status = 'active' ORDER BY users.id LIMIT 1`,
    );
    const ownerId = rows[0]?.id;
    if (ownerId === undefined)
      throw new Error('Create the owner account first (corepack pnpm admin create-owner).');
    const summary = await loadSampleShop(pool, ownerId);
    console.log(
      `Sample shop loaded: ${String(summary.ingredients.size)} ingredients, ${String(summary.items)} menu items, ${String(summary.trackedVariants)} sizes with recipes.`,
    );
  } finally {
    await pool.end();
  }
}
