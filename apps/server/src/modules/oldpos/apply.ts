/**
 * Puts a menu plan (menu.ts) into the shop, inside the caller's transaction. Safe to run again:
 * a category, item or barcode already there is left as it is and counted, never doubled.
 * Products are made as the New product screen makes them (products/routes.ts, step 8.1) for a
 * product without a counted quantity: the recipe stays a draft until stock is received.
 */
import { createItemIn, type Who } from '../catalog/index.ts';
import { addBarcodeIn, createInventoryItem, createRecipeDraft } from '../stock/index.ts';
import { writeAudit } from '../../platform/audit.ts';
import type { Tx } from '../../platform/db/tx.ts';
import type { MenuPlan } from './menu.ts';

export interface MenuImportResult {
  categoriesCreated: number;
  itemsCreated: number;
  productsCreated: number;
  alreadyThere: number;
  offSale: number;
}

export async function applyMenuPlan(tx: Tx, who: Who, plan: MenuPlan): Promise<MenuImportResult> {
  const result: MenuImportResult = {
    categoriesCreated: 0,
    itemsCreated: 0,
    productsCreated: 0,
    alreadyThere: 0,
    offSale: 0,
  };
  const categoryIds = new Map<string, string>();
  for (const [sort, name] of plan.categories.entries()) {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id::text FROM cl.menu_categories WHERE lower(name) = lower($1) AND archived_at IS NULL
        ORDER BY id LIMIT 1`,
      [name],
    );
    let id = rows[0]?.id;
    if (id === undefined) {
      const { rows: made } = await tx.query<{ id: string }>(
        'INSERT INTO cl.menu_categories (name, sort) VALUES ($1, $2) RETURNING id::text',
        [name, sort],
      );
      id = made[0]?.id ?? '';
      await writeAudit(tx, who, {
        action: 'menu.category.create',
        entityType: 'menu_category',
        entityId: id,
        after: { name, from: 'old POS' },
      });
      result.categoriesCreated += 1;
    }
    categoryIds.set(name, id);
  }

  for (const item of plan.items) {
    const categoryId = categoryIds.get(item.category) ?? '';
    const { rows: same } = await tx.query(
      `SELECT 1 FROM cl.menu_items WHERE category_id = $1 AND lower(name) = lower($2)
          AND archived_at IS NULL`,
      [categoryId, item.name],
    );
    const { rows: code } = item.barcode
      ? await tx.query('SELECT 1 FROM cl.barcodes WHERE code = $1', [item.barcode])
      : { rows: [] };
    if (same.length > 0 || code.length > 0) {
      result.alreadyThere += 1;
      continue;
    }

    const menu = await createItemIn(tx, who, {
      categoryId,
      name: item.name,
      variants: item.variants.map((v, i) => ({ ...v, isDefault: i === 0, sort: i })),
    });
    if (item.barcode) {
      const { id: itemId } = await createInventoryItem(tx, who, {
        sku: `BC-${item.barcode}`,
        name: item.name,
        baseUom: 'pcs',
        trackLots: false,
        trackExpiry: false,
      });
      await addBarcodeIn(tx, who, itemId, { code: item.barcode });
      await createRecipeDraft(tx, {
        variantId: menu.variantIds[0] ?? '',
        components: [{ itemId, qtyBase: '1', wasteFactor: '0' }],
      });
      result.productsCreated += 1;
    } else {
      result.itemsCreated += 1;
    }
    if (!item.onSale) {
      await tx.query('UPDATE cl.menu_items SET is_active = false WHERE id = $1', [menu.id]);
      result.offSale += 1;
    }
  }
  await writeAudit(tx, who, {
    action: 'oldpos.menu_import',
    entityType: 'menu_category',
    entityId: '0',
    after: { ...result, skipped: plan.skipped.length },
  });
  return result;
}
