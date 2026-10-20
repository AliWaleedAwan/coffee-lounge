/**
 * Recipe versions and stock mode (RECIPE_INVENTORY.md §2, §4). There is no recipe editor
 * in Phase 3: recipes come from a fixture through these functions, which hold the same
 * rules the Phase 4 editor will use.
 *
 * - A version is draft → active → retired; activating one retires the previous version.
 * - A recipe can go live only when every ingredient is stock-controlled (D-29).
 * - A variant switches to stock mode `recipe` only with an active recipe.
 */
import type { AuditContext } from '../../platform/audit.ts';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import type { ModifierRecipeRule, RecipeComponent } from './math.ts';

export interface ComponentInput {
  itemId: string;
  qtyBase: string;
  wasteFactor?: string;
  forDineIn?: boolean;
  forTakeaway?: boolean;
  forDelivery?: boolean;
}

export async function createRecipeDraft(
  tx: Tx,
  input: { variantId: string; components: readonly ComponentInput[]; prepInstructions?: string },
): Promise<{ id: string; versionNo: number }> {
  if (input.components.length === 0)
    throw new AppError('VALIDATION_FAILED', 'A recipe needs at least one ingredient');
  const { rows } = await tx.query<{ id: string; version_no: number }>(
    `INSERT INTO cl.recipe_versions (variant_id, version_no, prep_instructions)
     SELECT $1, COALESCE(max(version_no), 0) + 1, $2 FROM cl.recipe_versions WHERE variant_id = $1
     RETURNING id::text, version_no`,
    [input.variantId, input.prepInstructions ?? null],
  );
  const draft = rows[0];
  if (!draft) throw new Error('recipe draft not created');
  for (const c of input.components) {
    await tx.query(
      `INSERT INTO cl.recipe_components
         (recipe_version_id, inventory_item_id, qty_base, waste_factor, for_dine_in, for_takeaway, for_delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        draft.id,
        c.itemId,
        c.qtyBase,
        c.wasteFactor ?? '0',
        c.forDineIn ?? true,
        c.forTakeaway ?? true,
        c.forDelivery ?? true,
      ],
    );
  }
  return { id: draft.id, versionNo: draft.version_no };
}

export async function activateRecipe(
  tx: Tx,
  audit: AuditContext & { actor: { kind: 'user'; userId: string } },
  versionId: string,
): Promise<void> {
  const { rows } = await tx.query<{ variant_id: string; status: string }>(
    'SELECT variant_id::text, status FROM cl.recipe_versions WHERE id = $1 FOR UPDATE',
    [versionId],
  );
  const version = rows[0];
  if (!version) throw new AppError('NOT_FOUND', 'Recipe version not found');
  if (version.status !== 'draft')
    throw new AppError('VALIDATION_FAILED', 'Only a draft recipe can be activated');
  const { rows: uncounted } = await tx.query<{ name: string }>(
    `SELECT i.name FROM cl.recipe_components c JOIN cl.inventory_items i ON i.id = c.inventory_item_id
      WHERE c.recipe_version_id = $1 AND (NOT i.stock_control_active OR NOT i.is_active)
      ORDER BY i.name`,
    [versionId],
  );
  if (uncounted.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Count these ingredients first: ${uncounted.map((r) => r.name).join(', ')}`,
    );
  }
  await tx.query(
    `UPDATE cl.recipe_versions SET status = 'retired', retired_at = now()
      WHERE variant_id = $1 AND status = 'active'`,
    [version.variant_id],
  );
  await tx.query(
    `UPDATE cl.recipe_versions SET status = 'active', activated_by = $2, activated_at = now() WHERE id = $1`,
    [versionId, audit.actor.userId],
  );
  await writeAudit(tx, audit, {
    action: 'recipe.activate',
    entityType: 'recipe_version',
    entityId: versionId,
  });
  await publish(tx, {
    type: 'availability.changed',
    entityType: 'menu_variant',
    entityId: version.variant_id,
    topics: ['menu'],
  });
}

/** Untracked ↔ recipe (D-29). Recipe mode needs an active recipe. */
export async function setStockMode(
  tx: Tx,
  audit: AuditContext,
  variantId: string,
  mode: 'untracked' | 'recipe',
): Promise<void> {
  if (mode === 'recipe') {
    const { rows } = await tx.query(
      `SELECT 1 FROM cl.recipe_versions WHERE variant_id = $1 AND status = 'active'`,
      [variantId],
    );
    if (rows.length === 0)
      throw new AppError('VALIDATION_FAILED', 'Activate a recipe for this size first');
  }
  const { rowCount } = await tx.query(
    'UPDATE cl.menu_variants SET stock_mode = $2 WHERE id = $1 AND stock_mode <> $2',
    [variantId, mode],
  );
  if (!rowCount) return;
  await writeAudit(tx, audit, {
    action: 'menu.variant.stock_mode',
    entityType: 'menu_variant',
    entityId: variantId,
    after: { stockMode: mode },
  });
  await publish(tx, {
    type: 'menu.changed',
    entityType: 'menu_variant',
    entityId: variantId,
    topics: ['menu'],
  });
}

// ---------------------------------------------------------------- reading recipes

export interface ActiveRecipe {
  variantId: string;
  menuItemId: string;
  isDefault: boolean;
  recipeVersionId: string;
  components: RecipeComponent[];
}

/** Active recipes of the variants in stock mode `recipe`. */
export async function loadActiveRecipes(
  db: Queryable,
  variantIds?: readonly string[],
): Promise<Map<string, ActiveRecipe>> {
  const { rows } = await db.query<{
    variant_id: string;
    item_id: string;
    is_default: boolean;
    recipe_version_id: string;
    inventory_item_id: string;
    qty_base: string;
    waste_factor: string;
    for_dine_in: boolean;
    for_takeaway: boolean;
    for_delivery: boolean;
  }>(
    `SELECT v.id::text AS variant_id, v.item_id::text, v.is_default, r.id::text AS recipe_version_id,
            c.inventory_item_id::text, c.qty_base::text, c.waste_factor::text,
            c.for_dine_in, c.for_takeaway, c.for_delivery
       FROM cl.menu_variants v
       JOIN cl.recipe_versions r ON r.variant_id = v.id AND r.status = 'active'
       JOIN cl.recipe_components c ON c.recipe_version_id = r.id
      WHERE v.stock_mode = 'recipe' AND ($1::bigint[] IS NULL OR v.id = ANY($1::bigint[]))
      ORDER BY v.id, c.id`,
    [variantIds ?? null],
  );
  const recipes = new Map<string, ActiveRecipe>();
  for (const r of rows) {
    const recipe = recipes.get(r.variant_id) ?? {
      variantId: r.variant_id,
      menuItemId: r.item_id,
      isDefault: r.is_default,
      recipeVersionId: r.recipe_version_id,
      components: [],
    };
    recipe.components.push({
      itemId: r.inventory_item_id,
      qtyBase: r.qty_base,
      wasteFactor: r.waste_factor,
      forDineIn: r.for_dine_in,
      forTakeaway: r.for_takeaway,
      forDelivery: r.for_delivery,
    });
    recipes.set(r.variant_id, recipe);
  }
  return recipes;
}

export interface ScopedRule extends ModifierRecipeRule {
  /** null = every variant of the item. */
  variantId: string | null;
}

/** Modifier recipe rules in force at `at` (effective-dated, RECIPE_INVENTORY.md §4.3). */
export async function loadModifierRules(db: Queryable, at: Date): Promise<ScopedRule[]> {
  const { rows } = await db.query<{
    modifier_option_id: string;
    variant_id: string | null;
    action: ModifierRecipeRule['action'];
    inventory_item_id: string;
    replacement_item_id: string | null;
    qty_base: string | null;
    scale_factor: string | null;
  }>(
    `SELECT modifier_option_id::text, variant_id::text, action, inventory_item_id::text,
            replacement_item_id::text, qty_base::text, scale_factor::text
       FROM cl.modifier_recipe_rules
      WHERE effective_from <= $1 AND (retired_at IS NULL OR retired_at > $1)
      ORDER BY id`,
    [at],
  );
  return rows.map((r) => ({
    optionId: r.modifier_option_id,
    variantId: r.variant_id,
    action: r.action,
    itemId: r.inventory_item_id,
    replacementItemId: r.replacement_item_id,
    qtyBase: r.qty_base,
    scaleFactor: r.scale_factor,
  }));
}

/** The rules that apply to one variant. */
export function rulesForVariant(rules: readonly ScopedRule[], variantId: string): ScopedRule[] {
  return rules.filter((r) => r.variantId === null || r.variantId === variantId);
}
