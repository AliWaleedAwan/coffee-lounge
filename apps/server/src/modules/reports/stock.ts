/**
 * Stock and purchase reports (FINANCE_REPORTING.md §6; COST_VALUATION.md; Phase 6 step 6.4):
 * usage per item, waste and expiry, stock on hand and its value, counts and their
 * variances, purchases. Quantities are in each item's base unit (g, ml, pcs), so they are
 * not added across items; values are, and are shown only with `inventory.cost_view`.
 */
import type { Queryable } from '../../platform/db/pool.ts';
import type { Row } from './engine.ts';

type Raw = Record<string, string | number | null>;

export interface StockFilter {
  from: string;
  to: string;
  category?: string | undefined;
  itemId?: string | undefined;
}

/** What moved per item in the period, by kind of movement (the stock ledger, by business date). */
export async function usage(db: Queryable, f: StockFilter): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `SELECT i.id::text AS item_id, i.name AS item, COALESCE(i.category, '') AS category, i.base_uom AS unit,
            COALESCE(sum(m.qty_delta) FILTER (WHERE m.movement_type IN ('opening','receipt')), 0)::text AS received,
            (-COALESCE(sum(m.qty_delta) FILTER (WHERE m.movement_type = 'consumption'), 0))::text AS used,
            (-COALESCE(sum(m.qty_delta) FILTER (WHERE m.movement_type = 'waste'), 0))::text AS wasted,
            COALESCE(sum(m.qty_delta) FILTER (WHERE m.movement_type = 'count_adjustment'), 0)::text AS counted,
            (-COALESCE(sum(m.qty_delta) FILTER (WHERE m.movement_type = 'supplier_return'), 0))::text AS returned,
            sum(m.qty_delta)::text AS net,
            COALESCE(sum(m.value_delta) FILTER (WHERE m.movement_type IN ('opening','receipt')), 0)::text AS received_value,
            (-COALESCE(sum(m.value_delta) FILTER (WHERE m.movement_type = 'consumption'), 0))::text AS used_value,
            (-COALESCE(sum(m.value_delta) FILTER (WHERE m.movement_type = 'waste'), 0))::text AS waste_value,
            (-COALESCE(sum(m.value_delta) FILTER (WHERE m.movement_type = 'count_adjustment'), 0))::text AS variance_value,
            sum(m.value_delta)::text AS net_value
       FROM cl.stock_movements m JOIN cl.inventory_items i ON i.id = m.item_id
      WHERE m.business_date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR lower(i.category) = lower($3)) AND ($4::bigint IS NULL OR i.id = $4)
      GROUP BY i.id
      ORDER BY -COALESCE(sum(m.value_delta) FILTER (WHERE m.movement_type = 'consumption'), 0) DESC, i.name, i.id`,
    [f.from, f.to, f.category ?? null, f.itemId ?? null],
  );
  return rows;
}

export const WASTE_KINDS = [
  'ingredient',
  'prepared_item',
  'expired_lot',
  'failed_delivery',
] as const;

/** Every waste record of the period: ingredients, expired lots, prepared items, failed deliveries. */
export async function waste(
  db: Queryable,
  f: StockFilter & { kind?: (typeof WASTE_KINDS)[number] | undefined },
): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `SELECT w.business_date::text AS date, COALESCE(i.name, ol_name.name, 'Item') AS item,
            replace(w.kind, '_', ' ') AS kind, replace(w.reason_code, '_', ' ') AS reason,
            CASE WHEN w.kind IN ('ingredient','expired_lot') THEN w.qty::text END AS qty,
            CASE WHEN w.kind IN ('ingredient','expired_lot') THEN i.base_uom ELSE 'sold units' END AS unit,
            CASE WHEN w.kind IN ('prepared_item','failed_delivery') THEN w.qty::int END AS units,
            l.lot_code AS lot, u.display_name AS by, w.cost_value::text AS value
       FROM cl.wastage_records w
       LEFT JOIN cl.inventory_items i ON i.id = w.item_id
       LEFT JOIN cl.inventory_lots l ON l.id = w.lot_id
       LEFT JOIN LATERAL (SELECT mi.name || ' ' || v.name AS name FROM cl.order_lines ol
                            JOIN cl.menu_variants v ON v.id = ol.variant_id JOIN cl.menu_items mi ON mi.id = v.item_id
                           WHERE ol.id = w.order_line_id) ol_name ON true
       JOIN cl.users u ON u.id = w.recorded_by
      WHERE w.business_date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR lower(i.category) = lower($3)) AND ($4::bigint IS NULL OR w.item_id = $4)
        AND ($5::text IS NULL OR w.kind = $5)
      ORDER BY w.business_date, w.id`,
    [f.from, f.to, f.category ?? null, f.itemId ?? null, f.kind ?? null],
  );
  return rows;
}

/** Each item's stock now: on hand, held for accepted orders, free, and (with costs) its value. */
export async function onHand(db: Queryable, f: { category?: string | undefined }): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `SELECT i.id::text AS item_id, i.sku, i.name AS item, COALESCE(i.category, '') AS category, i.base_uom AS unit,
            b.on_hand::text, b.reserved::text, (b.on_hand - b.reserved)::text AS available,
            COALESCE(b.avg_unit_cost, b.last_unit_cost)::text AS unit_cost, b.inventory_value::text AS value,
            CASE WHEN NOT i.stock_control_active THEN 'Not counted yet'
                 WHEN b.on_hand = 0 THEN 'Out of stock'
                 WHEN i.low_threshold IS NOT NULL AND b.on_hand <= i.low_threshold THEN 'Low'
                 ELSE '' END AS status
       FROM cl.inventory_items i JOIN cl.inventory_balances b ON b.item_id = i.id
      WHERE i.archived_at IS NULL AND ($1::text IS NULL OR lower(i.category) = lower($1))
      ORDER BY lower(COALESCE(i.category, '')), lower(i.name), i.id`,
    [f.category ?? null],
  );
  return rows;
}

/** Stock counts posted in the period: how many items, how many differed, and what the difference cost. */
export async function counts(db: Queryable, f: { from: string; to: string }): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `SELECT c.id::text AS count_id, c.business_date::text AS date, c.count_no,
            CASE c.scope_kind WHEN 'all' THEN 'All items' WHEN 'category' THEN c.scope_category
                 ELSE cardinality(c.scope_item_ids) || ' items' END AS scope,
            s.display_name AS counted_by, a.display_name AS approved_by,
            (SELECT count(*)::int FROM cl.stock_count_lines l WHERE l.count_id = c.id) AS lines,
            (SELECT count(*)::int FROM cl.stock_count_lines l WHERE l.count_id = c.id AND l.counted_qty <> l.book_qty_snap) AS differed,
            (-COALESCE((SELECT sum(m.value_delta) FROM cl.stock_count_lines l JOIN cl.stock_movements m ON m.id = l.movement_id
                         WHERE l.count_id = c.id), 0))::text AS variance_value
       FROM cl.stock_counts c
       JOIN cl.users s ON s.id = c.submitted_by
       LEFT JOIN cl.users a ON a.id = c.approved_by
      WHERE c.status = 'posted' AND c.business_date BETWEEN $1::date AND $2::date
      ORDER BY c.business_date, c.id`,
    [f.from, f.to],
  );
  return rows;
}

/** Purchase receipts of the period; a reversed one is listed but counts for nothing. */
export async function purchases(
  db: Queryable,
  f: { from: string; to: string; supplierId?: string | undefined },
): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `SELECT r.business_date::text AS date, r.receipt_no, COALESCE(s.name, 'No supplier') AS supplier,
            (SELECT count(*)::int FROM cl.purchase_receipt_lines l WHERE l.receipt_id = r.id) AS lines,
            CASE r.status WHEN 'reversed' THEN 'Reversed' ELSE 'Posted' END AS status,
            CASE WHEN r.paid_now THEN initcap(r.payment_channel) ELSE 'On credit' END AS paid,
            CASE WHEN r.status = 'posted' THEN r.total_cost::text END AS cost,
            CASE WHEN r.status = 'posted' THEN 1 ELSE 0 END AS receipts
       FROM cl.purchase_receipts r LEFT JOIN cl.suppliers s ON s.id = r.supplier_id
      WHERE r.status IN ('posted','reversed') AND r.business_date BETWEEN $1::date AND $2::date
        AND ($3::bigint IS NULL OR r.supplier_id = $3)
      ORDER BY r.business_date, r.receipt_no`,
    [f.from, f.to, f.supplierId ?? null],
  );
  return rows;
}
