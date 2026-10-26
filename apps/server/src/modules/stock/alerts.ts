/**
 * Inventory alerts, the overview and movement history (RECIPE_INVENTORY.md §10; Phase 4
 * step 4.7). Alerts open and resolve themselves with the stock (ledger, expiry scan,
 * nightly check). A person may note an alert as seen; only three kinds are closed by a
 * person, because their condition never clears by itself: a balance mismatch (the owner,
 * after investigating; never auto-fixed, AT-94), found stock at a pickup, and an expired
 * lot that went into an order.
 */
import type { AuditContext } from '../../platform/audit.ts';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf } from '../../platform/settings.ts';

export const ALERT_KINDS = [
  'low',
  'zero',
  'near_expiry',
  'expired',
  'overstock',
  'reservation_shortfall',
  'stale_reservation',
  'balance_mismatch',
  'found_stock',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface InventoryAlert {
  id: string;
  kind: AlertKind;
  state: 'open' | 'acknowledged';
  itemId: string | null;
  itemName: string | null;
  baseUom: string | null;
  lotId: string | null;
  lotCode: string | null;
  expiryDate: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  /** Closed by a person rather than by the stock (see the module comment). */
  manual: boolean;
}

/** Closed by a person: whether this alert is one of them. */
function isManual(kind: string, detail: Record<string, unknown> | null): boolean {
  return (
    kind === 'balance_mismatch' ||
    kind === 'found_stock' ||
    (kind === 'expired' && detail !== null && 'usedBy' in detail)
  );
}

export async function listAlerts(db: Queryable): Promise<InventoryAlert[]> {
  const { rows } = await db.query<Omit<InventoryAlert, 'manual'>>(
    `SELECT a.id::text, a.kind, a.state, a.item_id::text AS "itemId", i.name AS "itemName",
            i.base_uom AS "baseUom", a.lot_id::text AS "lotId", l.lot_code AS "lotCode",
            l.expiry_date::text AS "expiryDate", COALESCE(a.detail, '{}'::jsonb) AS detail,
            a.created_at AS "createdAt"
       FROM cl.inventory_alerts a
       LEFT JOIN cl.inventory_items i ON i.id = a.item_id
       LEFT JOIN cl.inventory_lots l ON l.id = a.lot_id
      WHERE a.state <> 'resolved'
      ORDER BY (a.kind = 'balance_mismatch') DESC, (a.state = 'acknowledged'), a.created_at, a.id`,
  );
  return rows.map((r) => ({ ...r, manual: isManual(r.kind, r.detail) }));
}

async function lockAlert(tx: Tx, alertId: string) {
  const { rows } = await tx.query<{
    kind: string;
    state: string;
    detail: Record<string, unknown> | null;
    item_id: string | null;
  }>(
    'SELECT kind, state, detail, item_id::text FROM cl.inventory_alerts WHERE id = $1 FOR UPDATE',
    [alertId],
  );
  const alert = rows[0];
  if (!alert) throw new AppError('NOT_FOUND', 'Alert not found');
  if (alert.state === 'resolved') throw new AppError('STALE_STATE', 'This alert is already closed');
  return alert;
}

async function announce(tx: Tx, alertId: string): Promise<void> {
  await publish(tx, {
    type: 'alert.changed',
    entityType: 'inventory_alert',
    entityId: alertId,
    topics: ['alerts', 'inventory'],
  });
}

/** Noted as seen: it stays listed, below the unseen ones, until it is closed. */
export async function acknowledgeAlert(
  tx: Tx,
  alertId: string,
): Promise<{ state: 'acknowledged' }> {
  const alert = await lockAlert(tx, alertId);
  if (alert.state === 'acknowledged') throw new AppError('STALE_STATE', 'Already noted as seen');
  await tx.query(`UPDATE cl.inventory_alerts SET state = 'acknowledged' WHERE id = $1`, [alertId]);
  await announce(tx, alertId);
  return { state: 'acknowledged' };
}

/**
 * Closes an alert whose condition never clears by itself. A balance mismatch only by the
 * owner; the others by anyone who counts stock. Every other kind closes with the stock.
 */
export async function closeAlert(
  tx: Tx,
  who: AuditContext & { actor: { kind: 'user'; userId: string } },
  viewer: { isOwner: boolean; canCount: boolean },
  alertId: string,
  note: string,
): Promise<{ state: 'resolved' }> {
  const alert = await lockAlert(tx, alertId);
  if (!isManual(alert.kind, alert.detail)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'This alert closes by itself when the stock is right again',
    );
  }
  if (alert.kind === 'balance_mismatch' && !viewer.isOwner) {
    throw new AppError(
      'FORBIDDEN',
      'Only the owner closes a balance mismatch, after finding the cause',
    );
  }
  if (alert.kind !== 'balance_mismatch' && !viewer.canCount && !viewer.isOwner) {
    throw new AppError('FORBIDDEN', 'Closing this alert needs inventory.count');
  }
  await tx.query(
    `UPDATE cl.inventory_alerts SET state = 'resolved', resolved_at = now(), resolved_by = $2 WHERE id = $1`,
    [alertId, who.actor.userId],
  );
  await writeAudit(tx, who, {
    action: 'stock.alert.close',
    entityType: 'inventory_alert',
    entityId: alertId,
    reason: note,
    after: { kind: alert.kind, itemId: alert.item_id },
  });
  await announce(tx, alertId);
  return { state: 'resolved' };
}

// ------------------------------------------------------------------ overview

export interface StockLine {
  itemId: string;
  name: string;
  sku: string;
  baseUom: string;
  onHand: string;
  reserved: string;
  available: string;
  threshold: string | null;
}

export interface LotLine {
  lotId: string;
  itemId: string;
  name: string;
  baseUom: string;
  lotCode: string | null;
  expiryDate: string;
  qtyRemaining: string;
}

/**
 * What needs attention (UI_UX.md §6 "Overview & alerts"): low and out, short of what is
 * reserved, over the overstock level, lots near expiry and expired, open alerts, and how
 * far stock control has come (D-29: items counted out of all). Stock value only for
 * those who may see costs.
 */
export async function inventoryOverview(db: Queryable, now: Date, costs: boolean) {
  const today = await businessDateOf(db, now);
  const stock = (where: string, threshold: string) =>
    db.query<StockLine>(
      `SELECT i.id::text AS "itemId", i.name, i.sku, i.base_uom AS "baseUom", b.on_hand::text AS "onHand",
              b.reserved::text AS reserved, (b.on_hand - b.reserved)::text AS available,
              ${threshold}::text AS threshold
         FROM cl.inventory_items i JOIN cl.inventory_balances b ON b.item_id = i.id
        WHERE i.stock_control_active AND i.archived_at IS NULL AND ${where}
        ORDER BY (b.on_hand - b.reserved), lower(i.name), i.id`,
    );
  const out = await stock('b.on_hand - b.reserved <= 0', 'i.low_threshold');
  const low = await stock(
    'b.on_hand - b.reserved > 0 AND i.low_threshold IS NOT NULL AND b.on_hand - b.reserved <= i.low_threshold',
    'i.low_threshold',
  );
  const short = await stock('b.on_hand < b.reserved', 'i.low_threshold');
  const overstock = await stock(
    'i.overstock_threshold IS NOT NULL AND b.on_hand >= i.overstock_threshold',
    'i.overstock_threshold',
  );
  const lots = (where: string) =>
    db.query<LotLine>(
      `SELECT l.id::text AS "lotId", i.id::text AS "itemId", i.name, i.base_uom AS "baseUom",
              l.lot_code AS "lotCode", l.expiry_date::text AS "expiryDate", l.qty_remaining::text AS "qtyRemaining"
         FROM cl.inventory_lots l JOIN cl.inventory_items i ON i.id = l.item_id AND i.track_lots
        WHERE l.qty_remaining > 0 AND l.expiry_date IS NOT NULL AND ${where}
        ORDER BY l.expiry_date, lower(i.name), l.id`,
      [today],
    );
  const expired = await lots('l.expiry_date < $1::date');
  const expiring = await lots(
    'l.expiry_date >= $1::date AND i.near_expiry_days IS NOT NULL AND l.expiry_date <= $1::date + i.near_expiry_days',
  );
  const { rows: progress } = await db.query<{ counted: number; total: number; value: string }>(
    `SELECT count(*) FILTER (WHERE i.stock_control_active)::int AS counted, count(*)::int AS total,
            COALESCE(sum(b.inventory_value), 0)::numeric(14,2)::text AS value
       FROM cl.inventory_items i JOIN cl.inventory_balances b ON b.item_id = i.id
      WHERE i.archived_at IS NULL`,
  );
  return {
    businessDate: today,
    out: out.rows,
    low: low.rows,
    short: short.rows,
    overstock: overstock.rows,
    expired: expired.rows,
    expiring: expiring.rows,
    alerts: await listAlerts(db),
    stockControl: { counted: progress[0]?.counted ?? 0, total: progress[0]?.total ?? 0 },
    stockValue: costs ? (progress[0]?.value ?? '0.00') : null,
  };
}

// ------------------------------------------------------------------ movement history

export const MOVEMENT_TYPES = [
  'opening',
  'receipt',
  'consumption',
  'waste',
  'count_adjustment',
  'supplier_return',
  'cost_adjustment',
  'reversal',
] as const;

export interface Movement {
  id: string;
  occurredAt: string;
  businessDate: string;
  type: (typeof MOVEMENT_TYPES)[number] | 'rounding';
  qtyDelta: string;
  /** On hand after this movement. */
  balanceAfter: string;
  /** Only with cost rights. */
  valueDelta: string | null;
  unitCost: string | null;
  /** What it came from, as people name it: GRN, count, order, waste reason. */
  source: string;
  reasonCode: string | null;
  flags: string[];
  note: string | null;
  actor: string | null;
  lots: { lotCode: string | null; qtyDelta: string; expired: boolean }[];
}

/** An item's movements, newest first, with the on-hand after each (RECIPE_INVENTORY.md §10). */
export async function movementHistory(
  db: Queryable,
  itemId: string,
  filter: { from?: string | undefined; to?: string | undefined; type?: string | undefined },
  costs: boolean,
): Promise<Movement[]> {
  const { rows } = await db.query<Movement & { value_delta: string; unit_cost: string | null }>(
    `WITH m AS (
       SELECT mv.*, sum(mv.qty_delta) OVER (ORDER BY mv.id) AS balance_after
         FROM cl.stock_movements mv WHERE mv.item_id = $1)
     SELECT m.id::text, m.occurred_at AS "occurredAt", m.business_date::text AS "businessDate",
            m.movement_type AS type, m.qty_delta::text AS "qtyDelta",
            m.balance_after::numeric(18,4)::text AS "balanceAfter",
            m.value_delta::text AS value_delta, m.unit_cost::text AS unit_cost,
            CASE m.source_type
              WHEN 'purchase_receipt_line' THEN COALESCE(r.receipt_no, 'Receipt')
              WHEN 'stock_count_line' THEN COALESCE(c.count_no, 'Count')
              WHEN 'order_line' THEN COALESCE('Order ' || o.round_ref, 'Order')
              WHEN 'wastage' THEN 'Waste'
              WHEN 'inventory_item' THEN 'Opening balance'
              ELSE m.source_type END AS source,
            m.reason_code AS "reasonCode", m.flags, m.note, u.display_name AS actor,
            COALESCE((SELECT json_agg(json_build_object('lotCode', l.lot_code, 'qtyDelta', s.qty_delta::text,
                                                        'expired', s.expired) ORDER BY s.id)
                        FROM cl.stock_movement_lots s JOIN cl.inventory_lots l ON l.id = s.lot_id
                       WHERE s.movement_id = m.id), '[]'::json) AS lots
       FROM m
       LEFT JOIN cl.purchase_receipt_lines pl ON m.source_type = 'purchase_receipt_line' AND pl.id = m.source_id
       LEFT JOIN cl.purchase_receipts r ON r.id = pl.receipt_id
       LEFT JOIN cl.stock_count_lines cl_ ON m.source_type = 'stock_count_line' AND cl_.id = m.source_id
       LEFT JOIN cl.stock_counts c ON c.id = cl_.count_id
       LEFT JOIN cl.order_lines ol ON m.source_type = 'order_line' AND ol.id = m.source_id
       LEFT JOIN cl.order_rounds o ON o.id = ol.round_id
       LEFT JOIN cl.users u ON u.id = m.actor_user_id
      WHERE ($2::date IS NULL OR m.business_date >= $2) AND ($3::date IS NULL OR m.business_date <= $3)
        AND ($4::text IS NULL OR m.movement_type = $4)
      ORDER BY m.id DESC LIMIT 300`,
    [itemId, filter.from ?? null, filter.to ?? null, filter.type ?? null],
  );
  return rows.map(({ value_delta, unit_cost, ...r }) => ({
    ...r,
    valueDelta: costs ? value_delta : null,
    unitCost: costs ? unit_cost : null,
  }));
}
