/**
 * Stock-based availability (RECIPE_INVENTORY.md §5): advisory, recomputed on every read.
 * A recipe-mode size is available when every ingredient's usable available quantity
 * (on hand − reserved − expired or quarantined lots) covers one unit with no modifiers. A choice is unavailable when
 * the ingredient it adds, or replaces in, is short for one unit of the item's default
 * size. The authoritative check is at acceptance, under row locks (`reserve`).
 * Untracked sizes (D-29) are always available as far as stock is concerned.
 */
import { Decimal } from '@cl/shared';
import type { Queryable } from '../../platform/db/pool.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { unusableQty } from './lots.ts';
import { componentApplies, explodeRecipe, round4, type OrderType } from './math.ts';
import {
  loadActiveRecipes,
  loadModifierRules,
  rulesForVariant,
  type ActiveRecipe,
} from './recipes.ts';

export interface StockAvailability {
  /** false only for a recipe-mode size that stock cannot cover. */
  variantAvailable(variantId: string): boolean;
  /** false only for a choice whose added or replacing ingredient is short. */
  optionAvailable(menuItemId: string, optionId: string): boolean;
}

export async function stockAvailability(
  db: Queryable,
  options: { at: Date; orderType: OrderType },
): Promise<StockAvailability> {
  const recipes = await loadActiveRecipes(db);
  const rules = await loadModifierRules(db, options.at);
  const balances = await db.query<{ item_id: string; available: string }>(
    'SELECT item_id::text, (on_hand - reserved)::text AS available FROM cl.inventory_balances',
  );
  // Expired and quarantined lots are on hand but cannot be used (AT-13).
  const unusable = await unusableQty(db, null, await businessDateOf(db, options.at));
  const available = new Map(
    balances.rows.map((r) => [
      r.item_id,
      new Decimal(r.available).minus(unusable.get(r.item_id) ?? 0),
    ]),
  );
  const enough = (itemId: string, q: Decimal) =>
    (available.get(itemId) ?? new Decimal(0)).greaterThanOrEqualTo(q);

  const shortVariants = new Set<string>();
  const representative = new Map<string, ActiveRecipe>();
  for (const recipe of recipes.values()) {
    const perUnit = explodeRecipe(recipe.components, [], options.orderType, []);
    if ([...perUnit].some(([itemId, q]) => !enough(itemId, q))) shortVariants.add(recipe.variantId);
    const current = representative.get(recipe.menuItemId);
    if (!current || (recipe.isDefault && !current.isDefault))
      representative.set(recipe.menuItemId, recipe);
  }

  const shortOptions = new Set<string>();
  for (const recipe of representative.values()) {
    for (const rule of rulesForVariant(rules, recipe.variantId)) {
      let item: string;
      let need: Decimal;
      if (rule.action === 'add') {
        item = rule.itemId;
        need = new Decimal(rule.qtyBase ?? 0);
      } else if (rule.action === 'replace' && rule.replacementItemId !== null) {
        item = rule.replacementItemId;
        need = recipe.components
          .filter((c) => c.itemId === rule.itemId && componentApplies(c, options.orderType))
          .reduce(
            (sum, c) =>
              sum.plus(round4(new Decimal(c.qtyBase).times(new Decimal(1).plus(c.wasteFactor)))),
            new Decimal(0),
          );
      } else {
        continue;
      }
      if (need.greaterThan(0) && !enough(item, need))
        shortOptions.add(`${recipe.menuItemId}:${rule.optionId}`);
    }
  }

  return {
    variantAvailable: (variantId) => !shortVariants.has(variantId),
    optionAvailable: (menuItemId, optionId) => !shortOptions.has(`${menuItemId}:${optionId}`),
  };
}
