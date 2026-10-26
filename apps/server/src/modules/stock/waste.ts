/**
 * Ingredient waste as the clerk or a manager records it (RECIPE_INVENTORY.md §8; AT-109):
 * an item, a quantity in any unit of its dimension, a reason, and for lot-tracked items
 * the lot (or earliest expiry first). Valued at the current average by the ledger.
 * Prepared-item waste stays with line voids and cancels (orders module).
 */
import { convertQty, Decimal, UnitConversionError, UNITS, type UnitCode } from '@cl/shared';
import type { AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { wasteIngredient } from './ledger.ts';

export interface WasteInput {
  itemId: string;
  qty: string;
  uom?: UnitCode | undefined;
  reasonCode: string;
  note?: string | undefined;
  lotId?: string | undefined;
}

export async function recordWaste(
  tx: Tx,
  ctx: { actorUserId: string; businessDate: string; key: string },
  audit: AuditContext,
  input: WasteInput,
): Promise<{ itemId: string; qtyBase: string; value: string }> {
  const { rows } = await tx.query<{
    name: string;
    base_uom: 'g' | 'ml' | 'pcs';
    archived: boolean;
  }>(
    'SELECT name, base_uom, archived_at IS NOT NULL AS archived FROM cl.inventory_items WHERE id = $1',
    [input.itemId],
  );
  const item = rows[0];
  if (!item) throw new AppError('NOT_FOUND', 'Item not found');
  const uom = input.uom ?? item.base_uom;
  let q: Decimal;
  try {
    q = convertQty(new Decimal(input.qty), uom, item.base_uom);
  } catch (error) {
    if (error instanceof UnitConversionError) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${item.name} is kept in ${item.base_uom} (${UNITS[item.base_uom].dimension}); ` +
          `${uom} (${UNITS[uom].dimension}) cannot be converted`,
      );
    }
    throw error;
  }
  const { value } = await wasteIngredient(
    tx,
    { actorUserId: ctx.actorUserId, businessDate: ctx.businessDate },
    audit,
    {
      itemId: input.itemId,
      qty: q,
      reasonCode: input.reasonCode,
      key: ctx.key,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      ...(input.lotId !== undefined ? { lotId: input.lotId } : {}),
    },
  );
  return { itemId: input.itemId, qtyBase: q.toFixed(4), value: value.toFixed(4) };
}

export interface WasteRecord {
  id: string;
  kind: 'ingredient' | 'expired_lot' | 'prepared_item' | 'failed_delivery';
  itemId: string | null;
  name: string;
  baseUom: string | null;
  qty: string;
  reasonCode: string;
  note: string | null;
  lotCode: string | null;
  /** Null for readers without cost rights. */
  value: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** Everything wasted on a business day, newest first: ingredients, lots and prepared items. */
export async function listWaste(db: Queryable, businessDate: string): Promise<WasteRecord[]> {
  const { rows } = await db.query<WasteRecord>(
    `SELECT w.id::text, w.kind, w.item_id::text AS "itemId",
            COALESCE(i.name, ol.item_name_snap || ' (' || ol.variant_name_snap || ')') AS name,
            i.base_uom AS "baseUom", w.qty::text, w.reason_code AS "reasonCode", w.note,
            l.lot_code AS "lotCode", w.cost_value::text AS value, u.display_name AS "recordedBy",
            w.created_at AS "recordedAt"
       FROM cl.wastage_records w
       LEFT JOIN cl.inventory_items i ON i.id = w.item_id
       LEFT JOIN cl.order_lines ol ON ol.id = w.order_line_id
       LEFT JOIN cl.inventory_lots l ON l.id = w.lot_id
       JOIN cl.users u ON u.id = w.recorded_by
      WHERE w.business_date = $1
      ORDER BY w.created_at DESC, w.id DESC`,
    [businessDate],
  );
  return rows;
}
