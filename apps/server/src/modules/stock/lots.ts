/**
 * Lots (RECIPE_INVENTORY.md §3, §5, §6 "FEFO"; DATABASE.md §5). Only items with
 * `track_lots` have them, and for those Σ lots' remaining = on hand. Every function here
 * runs inside a ledger operation that already holds the item's balance lock, so lots of
 * one item never change in two transactions at once (DATABASE.md §14).
 *
 * A lot is expired when its expiry date is before the shop's business date: the date
 * printed is the last day it may be used. Expired and quarantined lots are not usable:
 * they do not count as available and cannot be reserved (AT-13). Picking is FEFO: usable
 * lots by expiry date (unknown last), then received date; only if they cannot cover a
 * pickup does the rest come from expired lots, earliest first, flagged (AT-30, AT-129).
 */
import { Decimal } from '@cl/shared';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';

export interface LotSettings {
  name: string;
  trackLots: boolean;
  trackExpiry: boolean;
}

export async function lotSettings(
  db: Queryable,
  itemIds: readonly string[],
): Promise<Map<string, LotSettings>> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    track_lots: boolean;
    track_expiry: boolean;
  }>(
    'SELECT id::text, name, track_lots, track_expiry FROM cl.inventory_items WHERE id = ANY($1::bigint[])',
    [itemIds],
  );
  return new Map(
    rows.map((r) => [r.id, { name: r.name, trackLots: r.track_lots, trackExpiry: r.track_expiry }]),
  );
}

/**
 * Quantity on hand that cannot be used, per item: lots past expiry or quarantined.
 * `itemIds` null means every item (menus).
 */
export async function unusableQty(
  db: Queryable,
  itemIds: readonly string[] | null,
  asOf: string,
): Promise<Map<string, Decimal>> {
  const { rows } = await db.query<{ item_id: string; q: string }>(
    `SELECT l.item_id::text, sum(l.qty_remaining)::text AS q
       FROM cl.inventory_lots l JOIN cl.inventory_items i ON i.id = l.item_id AND i.track_lots
      WHERE l.qty_remaining > 0 AND (l.status = 'quarantined' OR l.expiry_date < $2::date)
        AND ($1::bigint[] IS NULL OR l.item_id = ANY($1::bigint[]))
      GROUP BY l.item_id`,
    [itemIds, asOf],
  );
  return new Map(rows.map((r) => [r.item_id, new Decimal(r.q)]));
}

export interface NewLot {
  itemId: string;
  qty: Decimal;
  origin: 'receipt' | 'opening' | 'found' | 'count';
  lotCode?: string | null;
  expiryDate?: string | null;
  receiptLineId?: string;
  receivedAt?: Date;
}

export async function createLot(tx: Tx, lot: NewLot): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.inventory_lots (item_id, lot_code, received_at, expiry_date, qty_received,
                                    qty_remaining, receipt_line_id, origin)
     VALUES ($1, $2, COALESCE($3, now()), $4, $5, $5, $6, $7) RETURNING id::text`,
    [
      lot.itemId,
      lot.lotCode ?? null,
      lot.receivedAt ?? null,
      lot.expiryDate ?? null,
      lot.qty.toFixed(4),
      lot.receiptLineId ?? null,
      lot.origin,
    ],
  );
  return rows[0]?.id ?? '';
}

export interface LotTake {
  lotId: string;
  qty: Decimal;
  expired: boolean;
}

interface LotRow {
  id: string;
  qty_remaining: string;
  expired: boolean;
}

/**
 * Takes `q` from an item's lots, FEFO, and lowers their remaining quantity. With `lotId`
 * only that lot is used (waste of a named lot, reversal of a receipt). Throws if the lots
 * cannot cover `q`, which would mean lots and balance disagree.
 */
export async function takeFromLots(
  tx: Tx,
  itemId: string,
  q: Decimal,
  asOf: string,
  lotId?: string,
): Promise<LotTake[]> {
  const { rows } = await tx.query<LotRow>(
    `SELECT id::text, qty_remaining::text, COALESCE(expiry_date < $2::date, false) AS expired
       FROM cl.inventory_lots
      WHERE item_id = $1 AND qty_remaining > 0 AND ($3::bigint IS NULL OR id = $3)
      ORDER BY (status = 'quarantined'), COALESCE(expiry_date < $2::date, false),
               expiry_date NULLS LAST, received_at, inventory_lots.id`,
    [itemId, asOf, lotId ?? null],
  );
  const takes: LotTake[] = [];
  let left = q;
  for (const lot of rows) {
    if (left.lessThanOrEqualTo(0)) break;
    const take = Decimal.min(left, new Decimal(lot.qty_remaining));
    takes.push({ lotId: lot.id, qty: take, expired: lot.expired });
    left = left.minus(take);
  }
  if (left.greaterThan(0)) {
    throw new Error(
      `lots of item ${itemId} hold less than ${q.toFixed(4)}: lots and balance disagree`,
    );
  }
  for (const t of takes) {
    await tx.query(
      'UPDATE cl.inventory_lots SET qty_remaining = qty_remaining - $2 WHERE id = $1',
      [t.lotId, t.qty.toFixed(4)],
    );
  }
  return takes;
}

/** Writes a movement's share per lot (negative for takes, positive for additions). */
export async function recordLotShares(
  tx: Tx,
  movementId: string,
  shares: readonly { lotId: string; qty: Decimal; expired?: boolean }[],
  sign: 1 | -1,
): Promise<void> {
  for (const s of shares) {
    await tx.query(
      'INSERT INTO cl.stock_movement_lots (movement_id, lot_id, qty_delta, expired) VALUES ($1, $2, $3, $4)',
      [movementId, s.lotId, (sign < 0 ? s.qty.negated() : s.qty).toFixed(4), s.expired ?? false],
    );
  }
}

/**
 * Expiry alerts of lots that are now empty no longer apply, except the record that an
 * expired lot went into an order (AT-30): a person closes that one.
 */
export async function resolveEmptyLotAlerts(tx: Tx, itemId: string): Promise<void> {
  await tx.query(
    `UPDATE cl.inventory_alerts a SET state = 'resolved', resolved_at = now()
       FROM cl.inventory_lots l
      WHERE a.lot_id = l.id AND l.item_id = $1 AND l.qty_remaining = 0
        AND a.kind IN ('near_expiry','expired') AND a.state <> 'resolved'
        AND NOT (a.detail ? 'usedBy')`,
    [itemId],
  );
}
