/**
 * The recipe editor (RECIPE_INVENTORY.md §2, §4; Phase 4 step 4.8). A size has at most one
 * draft at a time, started empty or as a copy of the active recipe; the draft's
 * components are replaced as a whole when saved; activating it retires the active one for
 * future acceptances while earlier sales keep theirs (AT-19). Activation needs every
 * ingredient counted (AT-63). Modifier rules are effective-dated: retiring one keeps it
 * for the sales already made. The preview explodes a recipe exactly as acceptance does.
 */
import { convertQty, Decimal, qty, UnitConversionError, UNITS, type UnitCode } from '@cl/shared';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { addModifierRule } from './items.ts';
import { explodeRecipe, type OrderType } from './math.ts';
import { activateRecipe, loadModifierRules, rulesForVariant, setStockMode } from './recipes.ts';

type Who = AuditContext & { actor: { kind: 'user'; userId: string } };

// ------------------------------------------------------------------ reading

export interface RecipeOverviewItem {
  menuItemId: string;
  name: string;
  category: string;
  variants: {
    id: string;
    name: string;
    stockMode: 'untracked' | 'recipe';
    activeVersion: number | null;
    draftVersion: number | null;
  }[];
}

/** Every menu item and size with its recipe state; tracked = recipe mode (COGS coverage). */
export async function recipeOverview(db: Queryable): Promise<RecipeOverviewItem[]> {
  const { rows } = await db.query<{
    item_id: string;
    item_name: string;
    category: string;
    variant_id: string;
    variant_name: string;
    stock_mode: 'untracked' | 'recipe';
    active: number | null;
    draft: number | null;
  }>(
    `SELECT mi.id::text AS item_id, mi.name AS item_name, c.name AS category, v.id::text AS variant_id,
            v.name AS variant_name, v.stock_mode,
            (SELECT version_no FROM cl.recipe_versions r WHERE r.variant_id = v.id AND r.status = 'active') AS active,
            (SELECT max(version_no) FROM cl.recipe_versions r WHERE r.variant_id = v.id AND r.status = 'draft') AS draft
       FROM cl.menu_items mi
       JOIN cl.menu_categories c ON c.id = mi.category_id
       JOIN cl.menu_variants v ON v.item_id = mi.id
      WHERE mi.archived_at IS NULL AND v.archived_at IS NULL
      ORDER BY c.sort, c.id, mi.sort, lower(mi.name), mi.id, v.sort, v.id`,
  );
  const items = new Map<string, RecipeOverviewItem>();
  for (const r of rows) {
    const item = items.get(r.item_id) ?? {
      menuItemId: r.item_id,
      name: r.item_name,
      category: r.category,
      variants: [],
    };
    item.variants.push({
      id: r.variant_id,
      name: r.variant_name,
      stockMode: r.stock_mode,
      activeVersion: r.active,
      draftVersion: r.draft,
    });
    items.set(r.item_id, item);
  }
  return [...items.values()];
}

export interface ComponentView {
  itemId: string;
  name: string;
  baseUom: 'g' | 'ml' | 'pcs';
  qtyBase: string;
  wasteFactor: string;
  forDineIn: boolean;
  forTakeaway: boolean;
  forDelivery: boolean;
  stockControlActive: boolean;
}

export interface VersionView {
  id: string;
  versionNo: number;
  status: 'draft' | 'active' | 'retired';
  prepInstructions: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
  retiredAt: string | null;
  components: ComponentView[];
  version: number;
}

export interface RuleView {
  id: string;
  optionId: string;
  optionName: string;
  groupName: string;
  variantId: string | null;
  action: 'add' | 'remove' | 'replace' | 'scale';
  itemId: string;
  itemName: string;
  replacementItemId: string | null;
  replacementName: string | null;
  qtyBase: string | null;
  scaleFactor: string | null;
  baseUom: string;
}

export async function variantRecipes(db: Queryable, variantId: string) {
  const { rows: v } = await db.query<{
    id: string;
    name: string;
    item_id: string;
    item_name: string;
    stock_mode: 'untracked' | 'recipe';
  }>(
    `SELECT v.id::text, v.name, mi.id::text AS item_id, mi.name AS item_name, v.stock_mode
       FROM cl.menu_variants v JOIN cl.menu_items mi ON mi.id = v.item_id WHERE v.id = $1`,
    [variantId],
  );
  const variant = v[0];
  if (!variant) throw new AppError('NOT_FOUND', 'Size not found');
  const { rows: versions } = await db.query<Omit<VersionView, 'components'>>(
    `SELECT r.id::text, r.version_no AS "versionNo", r.status, r.prep_instructions AS "prepInstructions",
            r.activated_at AS "activatedAt", u.display_name AS "activatedBy", r.retired_at AS "retiredAt",
            r.version
       FROM cl.recipe_versions r LEFT JOIN cl.users u ON u.id = r.activated_by
      WHERE r.variant_id = $1 ORDER BY r.version_no DESC`,
    [variantId],
  );
  const { rows: components } = await db.query<ComponentView & { version_id: string }>(
    `SELECT c.recipe_version_id::text AS version_id, c.inventory_item_id::text AS "itemId", i.name,
            i.base_uom AS "baseUom", c.qty_base::text AS "qtyBase", c.waste_factor::text AS "wasteFactor",
            c.for_dine_in AS "forDineIn", c.for_takeaway AS "forTakeaway", c.for_delivery AS "forDelivery",
            i.stock_control_active AS "stockControlActive"
       FROM cl.recipe_components c JOIN cl.inventory_items i ON i.id = c.inventory_item_id
      WHERE c.recipe_version_id = ANY($1::bigint[]) ORDER BY c.id`,
    [versions.map((x) => x.id)],
  );
  const { rows: rules } = await db.query<RuleView>(
    `SELECT r.id::text, r.modifier_option_id::text AS "optionId", o.name AS "optionName", g.name AS "groupName",
            r.variant_id::text AS "variantId", r.action, r.inventory_item_id::text AS "itemId", i.name AS "itemName",
            r.replacement_item_id::text AS "replacementItemId", ri.name AS "replacementName",
            r.qty_base::text AS "qtyBase", r.scale_factor::text AS "scaleFactor", i.base_uom AS "baseUom"
       FROM cl.modifier_recipe_rules r
       JOIN cl.modifier_options o ON o.id = r.modifier_option_id
       JOIN cl.modifier_groups g ON g.id = o.group_id
       JOIN cl.menu_item_modifier_groups mg ON mg.group_id = g.id AND mg.item_id = $2
       JOIN cl.inventory_items i ON i.id = r.inventory_item_id
       LEFT JOIN cl.inventory_items ri ON ri.id = r.replacement_item_id
      WHERE r.retired_at IS NULL AND (r.variant_id IS NULL OR r.variant_id = $1)
      ORDER BY g.name, o.sort, r.id`,
    [variantId, variant.item_id],
  );
  const { rows: options } = await db.query<{ id: string; name: string; groupName: string }>(
    `SELECT o.id::text, o.name, g.name AS "groupName"
       FROM cl.menu_item_modifier_groups mg
       JOIN cl.modifier_groups g ON g.id = mg.group_id
       JOIN cl.modifier_options o ON o.group_id = g.id AND o.is_active
      WHERE mg.item_id = $1 ORDER BY mg.sort, g.id, o.sort, o.id`,
    [variant.item_id],
  );
  return {
    variantId: variant.id,
    variantName: variant.name,
    menuItemId: variant.item_id,
    menuItemName: variant.item_name,
    stockMode: variant.stock_mode,
    versions: versions.map((x) => ({
      ...x,
      components: components
        .filter((c) => c.version_id === x.id)
        .map((c) => ({
          itemId: c.itemId,
          name: c.name,
          baseUom: c.baseUom,
          qtyBase: c.qtyBase,
          wasteFactor: c.wasteFactor,
          forDineIn: c.forDineIn,
          forTakeaway: c.forTakeaway,
          forDelivery: c.forDelivery,
          stockControlActive: c.stockControlActive,
        })),
    })),
    rules,
    options,
  };
}

// ------------------------------------------------------------------ drafts

/** The size's draft: the existing one, or a new one (a copy of the active recipe if any). */
export async function startDraft(
  tx: Tx,
  who: Who,
  variantId: string,
): Promise<{ id: string; versionNo: number }> {
  const { rows: v } = await tx.query<{ id: string }>(
    'SELECT id::text FROM cl.menu_variants WHERE id = $1 AND archived_at IS NULL FOR UPDATE',
    [variantId],
  );
  if (!v[0]) throw new AppError('NOT_FOUND', 'Size not found');
  const { rows: existing } = await tx.query<{ id: string; version_no: number }>(
    `SELECT id::text, version_no FROM cl.recipe_versions WHERE variant_id = $1 AND status = 'draft'
      ORDER BY recipe_versions.version_no DESC LIMIT 1`,
    [variantId],
  );
  if (existing[0]) return { id: existing[0].id, versionNo: existing[0].version_no };
  const { rows } = await tx.query<{ id: string; version_no: number }>(
    `INSERT INTO cl.recipe_versions (variant_id, version_no, prep_instructions)
     SELECT $1, COALESCE(max(version_no), 0) + 1,
            (SELECT prep_instructions FROM cl.recipe_versions WHERE variant_id = $1 AND status = 'active')
       FROM cl.recipe_versions WHERE variant_id = $1
     RETURNING id::text, version_no`,
    [variantId],
  );
  const draft = rows[0];
  if (!draft) throw new Error('draft not created');
  await tx.query(
    `INSERT INTO cl.recipe_components
       (recipe_version_id, inventory_item_id, qty_base, waste_factor, for_dine_in, for_takeaway, for_delivery)
     SELECT $1, c.inventory_item_id, c.qty_base, c.waste_factor, c.for_dine_in, c.for_takeaway, c.for_delivery
       FROM cl.recipe_components c JOIN cl.recipe_versions r ON r.id = c.recipe_version_id
      WHERE r.variant_id = $2 AND r.status = 'active' ORDER BY c.id`,
    [draft.id, variantId],
  );
  await writeAudit(tx, who, {
    action: 'recipe.draft',
    entityType: 'recipe_version',
    entityId: draft.id,
    after: { variantId, versionNo: draft.version_no },
  });
  await changed(tx, variantId);
  return { id: draft.id, versionNo: draft.version_no };
}

export interface ComponentInput {
  itemId: string;
  qty: string;
  uom?: UnitCode | undefined;
  /** Percent lost in preparation, e.g. "5" for 5 % (RECIPE_INVENTORY.md §4.2). */
  wastePercent?: string | undefined;
  forDineIn: boolean;
  forTakeaway: boolean;
  forDelivery: boolean;
}

/** Replaces a draft's components and instructions (the whole list, as the editor holds it). */
export async function saveDraft(
  tx: Tx,
  who: Who,
  versionId: string,
  input: {
    expectedVersion: number;
    components: readonly ComponentInput[];
    prepInstructions?: string | null | undefined;
  },
): Promise<{ id: string; version: number }> {
  const { rows } = await tx.query<{ status: string; version: number; variant_id: string }>(
    'SELECT status, version, variant_id::text FROM cl.recipe_versions WHERE id = $1 FOR UPDATE',
    [versionId],
  );
  const draft = rows[0];
  if (!draft) throw new AppError('NOT_FOUND', 'Recipe not found');
  if (draft.status !== 'draft')
    throw new AppError('VALIDATION_FAILED', 'Only a draft can be edited');
  if (draft.version !== input.expectedVersion) {
    throw new AppError(
      'STALE_STATE',
      'This draft was changed by someone else. Reload it and try again.',
      {
        currentVersion: draft.version,
      },
    );
  }
  if (input.components.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A recipe needs at least one ingredient');
  }
  const ids = [...new Set(input.components.map((c) => c.itemId))];
  if (ids.length !== input.components.length) {
    throw new AppError('VALIDATION_FAILED', 'Each ingredient once: add the quantities together');
  }
  const { rows: items } = await tx.query<{
    id: string;
    name: string;
    base_uom: 'g' | 'ml' | 'pcs';
    archived: boolean;
  }>(
    `SELECT id::text, name, base_uom, archived_at IS NOT NULL AS archived
       FROM cl.inventory_items WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  const byId = new Map(items.map((i) => [i.id, i]));
  const rowsToInsert = input.components.map((c) => {
    const item = byId.get(c.itemId);
    if (!item) throw new AppError('VALIDATION_FAILED', `Ingredient ${c.itemId} does not exist`);
    if (item.archived) throw new AppError('VALIDATION_FAILED', `${item.name} is archived`);
    let q: Decimal;
    try {
      q = convertQty(new Decimal(c.qty), c.uom ?? item.base_uom, item.base_uom);
    } catch (error) {
      if (error instanceof UnitConversionError) {
        const uom = c.uom ?? item.base_uom;
        throw new AppError(
          'VALIDATION_FAILED',
          `${item.name} is kept in ${item.base_uom} (${UNITS[item.base_uom].dimension}); ` +
            `${uom} (${UNITS[uom].dimension}) cannot be converted`,
        );
      }
      throw error;
    }
    if (q.lessThanOrEqualTo(0))
      throw new AppError('VALIDATION_FAILED', `Enter how much ${item.name}`);
    const waste = new Decimal(c.wastePercent ?? '0').dividedBy(100);
    if (waste.isNegative() || waste.greaterThanOrEqualTo(1)) {
      throw new AppError('VALIDATION_FAILED', 'Waste is a percentage from 0 to under 100');
    }
    if (!c.forDineIn && !c.forTakeaway && !c.forDelivery) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${item.name} must apply to at least one kind of order`,
      );
    }
    return { ...c, qtyBase: qty.format(q), waste: waste.toDecimalPlaces(4).toFixed(4) };
  });
  await tx.query('DELETE FROM cl.recipe_components WHERE recipe_version_id = $1', [versionId]);
  for (const c of rowsToInsert) {
    await tx.query(
      `INSERT INTO cl.recipe_components
         (recipe_version_id, inventory_item_id, qty_base, waste_factor, for_dine_in, for_takeaway, for_delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [versionId, c.itemId, c.qtyBase, c.waste, c.forDineIn, c.forTakeaway, c.forDelivery],
    );
  }
  const { rows: updated } = await tx.query<{ version: number }>(
    `UPDATE cl.recipe_versions SET prep_instructions = CASE WHEN $3 THEN $2 ELSE prep_instructions END
      WHERE id = $1 RETURNING version`,
    [versionId, input.prepInstructions ?? null, input.prepInstructions !== undefined],
  );
  await writeAudit(tx, who, {
    action: 'recipe.draft.save',
    entityType: 'recipe_version',
    entityId: versionId,
    after: {
      components: rowsToInsert.map((c) => ({
        itemId: c.itemId,
        qtyBase: c.qtyBase,
        waste: c.waste,
      })),
    },
  });
  await changed(tx, draft.variant_id);
  return { id: versionId, version: updated[0]?.version ?? 0 };
}

/**
 * Activates a draft (AT-63: every ingredient counted). The ingredients are locked for
 * share first, so an item cannot be archived while a recipe using it goes live.
 */
export async function activateDraft(
  tx: Tx,
  who: Who,
  versionId: string,
): Promise<{ variantId: string }> {
  const { rows } = await tx.query<{ variant_id: string }>(
    'SELECT variant_id::text FROM cl.recipe_versions WHERE id = $1',
    [versionId],
  );
  const variantId = rows[0]?.variant_id;
  if (variantId === undefined) throw new AppError('NOT_FOUND', 'Recipe not found');
  await tx.query(
    `SELECT 1 FROM cl.inventory_items WHERE id IN
       (SELECT inventory_item_id FROM cl.recipe_components WHERE recipe_version_id = $1)
     ORDER BY inventory_items.id FOR SHARE`,
    [versionId],
  );
  const { rowCount } = await tx.query(
    'SELECT 1 FROM cl.recipe_components WHERE recipe_version_id = $1',
    [versionId],
  );
  if (!rowCount) throw new AppError('VALIDATION_FAILED', 'A recipe needs at least one ingredient');
  await activateRecipe(tx, who, versionId);
  await changed(tx, variantId);
  return { variantId };
}

export async function changeStockMode(
  tx: Tx,
  who: Who,
  variantId: string,
  mode: 'untracked' | 'recipe',
): Promise<{ stockMode: 'untracked' | 'recipe' }> {
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id::text FROM cl.menu_variants WHERE id = $1 FOR UPDATE',
    [variantId],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Size not found');
  await setStockMode(tx, who, variantId, mode);
  await changed(tx, variantId);
  return { stockMode: mode };
}

// ------------------------------------------------------------------ modifier rules

export interface RuleInput {
  optionId: string;
  variantId?: string | undefined;
  action: 'add' | 'remove' | 'replace' | 'scale';
  itemId: string;
  replacementItemId?: string | undefined;
  qty?: string | undefined;
  uom?: UnitCode | undefined;
  scaleFactor?: string | undefined;
}

/** A modifier recipe rule from now on (RECIPE_INVENTORY.md §4.3); added items must be counted. */
export async function addRule(tx: Tx, who: Who, input: RuleInput): Promise<{ id: string }> {
  const needs = [
    input.action === 'add' ? input.itemId : null,
    input.replacementItemId ?? null,
  ].filter((x): x is string => x !== null);
  const { rows: items } = await tx.query<{
    id: string;
    name: string;
    base_uom: 'g' | 'ml' | 'pcs';
    stock_control_active: boolean;
    archived: boolean;
  }>(
    `SELECT id::text, name, base_uom, stock_control_active, archived_at IS NOT NULL AS archived
       FROM cl.inventory_items WHERE id = ANY($1::bigint[]) ORDER BY inventory_items.id FOR SHARE`,
    [[input.itemId, ...(input.replacementItemId ? [input.replacementItemId] : [])]],
  );
  const item = items.find((i) => i.id === input.itemId);
  if (!item) throw new AppError('VALIDATION_FAILED', 'That ingredient does not exist');
  for (const i of items) {
    if (i.archived) throw new AppError('VALIDATION_FAILED', `${i.name} is archived`);
    if (needs.includes(i.id) && !i.stock_control_active) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Count ${i.name} first: a choice can only add counted stock`,
      );
    }
  }
  if (input.action === 'replace') {
    const to = items.find((i) => i.id === input.replacementItemId);
    if (!to) throw new AppError('VALIDATION_FAILED', 'Choose what replaces it');
    if (UNITS[to.base_uom].dimension !== UNITS[item.base_uom].dimension) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${item.name} and ${to.name} are not kept in the same kind of unit`,
      );
    }
  }
  let qtyBase: string | undefined;
  if (input.action === 'add') {
    try {
      const q = convertQty(
        new Decimal(input.qty ?? '0'),
        input.uom ?? item.base_uom,
        item.base_uom,
      );
      if (q.lessThanOrEqualTo(0)) throw new AppError('VALIDATION_FAILED', 'Enter how much it adds');
      qtyBase = qty.format(q);
    } catch (error) {
      if (error instanceof UnitConversionError) {
        throw new AppError('VALIDATION_FAILED', `${item.name} is kept in ${item.base_uom}`);
      }
      throw error;
    }
  }
  if (input.action === 'scale' && !(Number(input.scaleFactor) > 0)) {
    throw new AppError('VALIDATION_FAILED', 'A scale factor above zero, e.g. 1.5');
  }
  const { rows: option } = await tx.query<{ item_ok: boolean }>(
    `SELECT ($2::bigint IS NULL OR EXISTS (
              SELECT 1 FROM cl.menu_variants v JOIN cl.menu_item_modifier_groups mg ON mg.item_id = v.item_id
               WHERE v.id = $2 AND mg.group_id = o.group_id)) AS item_ok
       FROM cl.modifier_options o WHERE o.id = $1`,
    [input.optionId, input.variantId ?? null],
  );
  if (!option[0]) throw new AppError('VALIDATION_FAILED', 'That choice does not exist');
  if (!option[0].item_ok)
    throw new AppError('VALIDATION_FAILED', 'That choice is not offered on this size');
  const created = await addModifierRule(tx, {
    optionId: input.optionId,
    ...(input.variantId ? { variantId: input.variantId } : {}),
    action: input.action,
    itemId: input.itemId,
    ...(input.replacementItemId ? { replacementItemId: input.replacementItemId } : {}),
    ...(qtyBase ? { qtyBase } : {}),
    ...(input.action === 'scale' && input.scaleFactor ? { scaleFactor: input.scaleFactor } : {}),
  });
  await writeAudit(tx, who, {
    action: 'recipe.rule.add',
    entityType: 'modifier_recipe_rule',
    entityId: created.id,
    after: input,
  });
  await publish(tx, {
    type: 'menu.changed',
    entityType: 'modifier_recipe_rule',
    entityId: created.id,
    topics: ['menu'],
  });
  return created;
}

/** Ends a rule from now; sales already made keep what it did. */
export async function retireRule(tx: Tx, who: Who, ruleId: string): Promise<{ id: string }> {
  const { rowCount } = await tx.query(
    `UPDATE cl.modifier_recipe_rules SET retired_at = GREATEST(now(), effective_from + interval '1 millisecond')
      WHERE id = $1 AND retired_at IS NULL`,
    [ruleId],
  );
  if (!rowCount) throw new AppError('STALE_STATE', 'This rule was already ended');
  await writeAudit(tx, who, {
    action: 'recipe.rule.retire',
    entityType: 'modifier_recipe_rule',
    entityId: ruleId,
  });
  await publish(tx, {
    type: 'menu.changed',
    entityType: 'modifier_recipe_rule',
    entityId: ruleId,
    topics: ['menu'],
  });
  return { id: ruleId };
}

// ------------------------------------------------------------------ preview

/**
 * What one unit of a size takes for an order type and choices (RECIPE_INVENTORY.md §4.4,
 * AT-64), from the active recipe or the draft, with the rules in force now.
 */
export async function previewRecipe(
  db: Queryable,
  input: {
    variantId: string;
    orderType: OrderType;
    optionIds: readonly string[];
    draft: boolean;
    at: Date;
  },
) {
  const { rows } = await db.query<{
    item_id: string;
    qty_base: string;
    waste_factor: string;
    for_dine_in: boolean;
    for_takeaway: boolean;
    for_delivery: boolean;
  }>(
    `SELECT c.inventory_item_id::text AS item_id, c.qty_base::text, c.waste_factor::text,
            c.for_dine_in, c.for_takeaway, c.for_delivery
       FROM cl.recipe_components c JOIN cl.recipe_versions r ON r.id = c.recipe_version_id
      WHERE r.variant_id = $1 AND r.status = $2 ORDER BY c.id`,
    [input.variantId, input.draft ? 'draft' : 'active'],
  );
  if (rows.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      input.draft ? 'There is no draft' : 'There is no active recipe',
    );
  }
  const rules = rulesForVariant(await loadModifierRules(db, input.at), input.variantId);
  const result = explodeRecipe(
    rows.map((r) => ({
      itemId: r.item_id,
      qtyBase: r.qty_base,
      wasteFactor: r.waste_factor,
      forDineIn: r.for_dine_in,
      forTakeaway: r.for_takeaway,
      forDelivery: r.for_delivery,
    })),
    rules,
    input.orderType,
    input.optionIds,
  );
  const { rows: names } = await db.query<{ id: string; name: string; base_uom: string }>(
    'SELECT id::text, name, base_uom FROM cl.inventory_items WHERE id = ANY($1::bigint[])',
    [[...result.keys()]],
  );
  const name = new Map(names.map((n) => [n.id, n]));
  return {
    lines: [...result].map(([itemId, q]) => ({
      itemId,
      name: name.get(itemId)?.name ?? itemId,
      baseUom: name.get(itemId)?.base_uom ?? '',
      qtyPerUnit: q.toFixed(4),
    })),
  };
}

async function changed(tx: Tx, variantId: string): Promise<void> {
  await publish(tx, {
    type: 'menu.changed',
    entityType: 'menu_variant',
    entityId: variantId,
    topics: ['menu'],
  });
}
