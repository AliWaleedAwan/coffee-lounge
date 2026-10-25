/**
 * Inventory items and modifier recipe rules, the parts the Phase 3 fixture needs. The
 * inventory screens (Phase 4) add editing, packs, barcodes and archiving on top.
 */
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';

export interface InventoryItemInput {
  sku: string;
  name: string;
  category?: string;
  baseUom: 'g' | 'ml' | 'pcs';
  lowThreshold?: string;
}

/** A new item starts outside stock control until its opening balance is posted (D-29). */
export async function createInventoryItem(
  tx: Tx,
  audit: AuditContext,
  input: InventoryItemInput,
): Promise<{ id: string }> {
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cl.inventory_items (sku, name, category, base_uom, low_threshold)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
      [input.sku, input.name, input.category ?? null, input.baseUom, input.lowThreshold ?? null],
    );
    const id = rows[0]?.id ?? '';
    await writeAudit(tx, audit, {
      action: 'stock.item.create',
      entityType: 'inventory_item',
      entityId: id,
      after: input,
    });
    return { id };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AppError('VALIDATION_FAILED', `SKU ${input.sku} is already used`);
    }
    throw error;
  }
}

export interface ModifierRuleInput {
  optionId: string;
  /** Omit for every size of the item. */
  variantId?: string;
  action: 'add' | 'remove' | 'replace' | 'scale';
  itemId: string;
  replacementItemId?: string;
  qtyBase?: string;
  scaleFactor?: string;
  effectiveFrom?: Date;
}

export async function addModifierRule(tx: Tx, input: ModifierRuleInput): Promise<{ id: string }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.modifier_recipe_rules
       (modifier_option_id, variant_id, action, inventory_item_id, replacement_item_id, qty_base,
        scale_factor, effective_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now())) RETURNING id::text`,
    [
      input.optionId,
      input.variantId ?? null,
      input.action,
      input.itemId,
      input.replacementItemId ?? null,
      input.qtyBase ?? null,
      input.scaleFactor ?? null,
      input.effectiveFrom ?? null,
    ],
  );
  return { id: rows[0]?.id ?? '' };
}
