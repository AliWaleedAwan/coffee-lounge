/**
 * Stock counts (RECIPE_INVENTORY.md §9, D-18, P4-5; AT-108, AT-29). A count has a scope,
 * is blind by default (counters do not see the book quantity while counting), and takes
 * the book quantity of each line at the moment it is entered. Submitting posts at once
 * when every line is within the thresholds (2 % or Rs 1,000 by default); otherwise
 * someone other than the submitter with `inventory.count_approve` approves (here, or by
 * PIN on the counting device) or sends lines back for recount. Posting writes each
 * variance as a delta. The count's row lock comes before the balances (DATABASE.md §14).
 */
import {
  convertQty,
  Decimal,
  unitCost,
  UnitConversionError,
  UNITS,
  type UnitCode,
} from '@cl/shared';
import { z } from 'zod';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf, readSetting } from '../../platform/settings.ts';
import { postCountLines } from './ledger.ts';
import { averageCost, round4 } from './math.ts';

export interface Counter {
  userId: string;
  permissions: { has(key: string): boolean };
  audit: AuditContext;
}

export interface CountScope {
  scope: 'all' | 'category' | 'items';
  category?: string | undefined;
  itemIds?: readonly string[] | undefined;
}

interface CountRow {
  id: string;
  count_no: string;
  status: 'draft' | 'submitted' | 'posted' | 'cancelled';
  blind: boolean;
  scope_kind: 'all' | 'category' | 'items';
  scope_category: string | null;
  scope_item_ids: string[] | null;
  submitted_by: string | null;
}

async function lockCount(tx: Tx, countId: string): Promise<CountRow> {
  const { rows } = await tx.query<CountRow>(
    `SELECT id::text, count_no, status, blind, scope_kind, scope_category,
            scope_item_ids::text[] AS scope_item_ids, submitted_by::text
       FROM cl.stock_counts WHERE id = $1 FOR UPDATE`,
    [countId],
  );
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'Count not found');
  return row;
}

function mustBe(count: CountRow, status: CountRow['status']): void {
  if (count.status !== status) {
    throw new AppError('STALE_STATE', `This count is ${count.status}`, { status: count.status });
  }
}

async function changed(tx: Tx, who: AuditContext, countId: string, action: string, after: object) {
  await writeAudit(tx, who, { action, entityType: 'stock_count', entityId: countId, after });
  await publish(tx, {
    type: 'count.changed',
    entityType: 'stock_count',
    entityId: countId,
    topics: ['inventory'],
  });
}

/** The items a count covers: stock-controlled, not archived, inside the scope. */
const SCOPE_ITEMS = `
  SELECT i.id, i.name, i.sku, i.category, i.base_uom, i.track_lots
    FROM cl.inventory_items i, cl.stock_counts c
   WHERE c.id = $1 AND i.stock_control_active AND i.archived_at IS NULL
     AND (c.scope_kind = 'all'
          OR (c.scope_kind = 'category' AND i.category = c.scope_category)
          OR (c.scope_kind = 'items' AND i.id = ANY(c.scope_item_ids)))`;

export async function startCount(
  tx: Tx,
  who: Counter,
  input: CountScope & { blind?: boolean | undefined; note?: string | undefined; now: Date },
): Promise<{ id: string; countNo: string }> {
  const businessDate = await businessDateOf(tx, input.now);
  const year = businessDate.slice(0, 4);
  const { rows: open } = await tx.query<{ count_no: string }>(
    `SELECT count_no FROM cl.stock_counts WHERE status IN ('draft','submitted')
      ORDER BY stock_counts.id LIMIT 1`,
  );
  // One count at a time keeps book snapshots and approvals easy to follow.
  if (open[0]) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Count ${open[0].count_no} is still open: finish or cancel it first`,
    );
  }
  const countNo = `CNT-${year}-${(await tx.nextNumber('stock_count', year)).padStart(5, '0')}`;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.stock_counts (count_no, blind, scope_kind, scope_category, scope_item_ids, note, started_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
    [
      countNo,
      input.blind ?? true,
      input.scope,
      input.scope === 'category' ? (input.category ?? null) : null,
      input.scope === 'items' ? (input.itemIds ?? []) : null,
      input.note?.trim() || null,
      who.userId,
    ],
  );
  const id = rows[0]?.id ?? '';
  const { rowCount } = await tx.query(SCOPE_ITEMS, [id]);
  if (!rowCount)
    throw new AppError('VALIDATION_FAILED', 'Nothing counted in stock is in that scope');
  await changed(tx, who.audit, id, 'stock.count.start', { countNo, scope: input.scope });
  return { id, countNo };
}

export interface LineInput {
  itemId: string;
  lotId?: string | undefined;
  countedQty: string;
  uom?: UnitCode | undefined;
  /** For stock found in no known lot of a lot-tracked item. */
  newLotExpiry?: string | undefined;
}

const PCT = z.number();
const AMOUNT = z.string();

/** Enters or re-enters one line; its book quantity is taken now (RECIPE_INVENTORY.md §9). */
export async function enterLine(
  tx: Tx,
  who: Counter,
  countId: string,
  input: LineInput,
): Promise<{ lineId: string }> {
  const count = await lockCount(tx, countId);
  mustBe(count, 'draft');
  const { rows: items } = await tx.query<{
    id: string;
    name: string;
    base_uom: 'g' | 'ml' | 'pcs';
    track_lots: boolean;
  }>(`SELECT id::text, name, base_uom, track_lots FROM (${SCOPE_ITEMS}) s WHERE s.id = $2`, [
    countId,
    input.itemId,
  ]);
  const item = items[0];
  if (!item) throw new AppError('VALIDATION_FAILED', 'That item is not part of this count');
  let counted: Decimal;
  try {
    counted = convertQty(new Decimal(input.countedQty), input.uom ?? item.base_uom, item.base_uom);
  } catch (error) {
    if (error instanceof UnitConversionError) {
      const uom = input.uom ?? item.base_uom;
      throw new AppError(
        'VALIDATION_FAILED',
        `${item.name} is kept in ${item.base_uom} (${UNITS[item.base_uom].dimension}); ` +
          `${uom} (${UNITS[uom].dimension}) cannot be converted`,
      );
    }
    throw error;
  }
  if (input.lotId !== undefined && !item.track_lots) {
    throw new AppError('VALIDATION_FAILED', `${item.name} has no lots`);
  }
  if (input.newLotExpiry !== undefined && (!item.track_lots || input.lotId !== undefined)) {
    throw new AppError('VALIDATION_FAILED', 'An expiry is only for stock found in no known lot');
  }
  const { rows: bal } = await tx.query<{
    on_hand: string;
    inventory_value: string;
    last_unit_cost: string | null;
  }>(
    'SELECT on_hand::text, inventory_value::text, last_unit_cost::text FROM cl.inventory_balances WHERE item_id = $1',
    [item.id],
  );
  const balance = bal[0];
  let book = new Decimal(balance?.on_hand ?? '0');
  if (item.track_lots) {
    if (input.lotId === undefined) {
      book = new Decimal(0); // stock in no known lot
    } else {
      const { rows } = await tx.query<{ q: string }>(
        'SELECT qty_remaining::text AS q FROM cl.inventory_lots WHERE id = $1 AND item_id = $2',
        [input.lotId, item.id],
      );
      if (!rows[0])
        throw new AppError('VALIDATION_FAILED', `That lot is not one of ${item.name}'s`);
      book = new Decimal(rows[0].q);
    }
  }
  const cost =
    averageCost({
      onHand: new Decimal(balance?.on_hand ?? '0'),
      value: new Decimal(balance?.inventory_value ?? '0'),
    }) ?? (balance?.last_unit_cost ? new Decimal(balance.last_unit_cost) : null);
  const variance = counted.minus(book);
  const value = round4(variance.times(cost ?? 0));
  const pct = await readSetting(tx, 'inventory.count_variance_pct', PCT);
  const amount = new Decimal(await readSetting(tx, 'inventory.count_variance_amount', AMOUNT));
  const needsApproval =
    !variance.isZero() &&
    (value.abs().greaterThan(amount) ||
      book.isZero() ||
      variance.abs().dividedBy(book).times(100).greaterThan(pct));
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.stock_count_lines
       (count_id, item_id, lot_id, book_qty_snap, counted_qty, unit_cost_snap, variance_qty,
        variance_value, needs_approval, new_lot_expiry, entered_by, entered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (count_id, item_id, lot_id) DO UPDATE SET
       book_qty_snap = EXCLUDED.book_qty_snap, counted_qty = EXCLUDED.counted_qty,
       unit_cost_snap = EXCLUDED.unit_cost_snap, variance_qty = EXCLUDED.variance_qty,
       variance_value = EXCLUDED.variance_value, needs_approval = EXCLUDED.needs_approval,
       new_lot_expiry = EXCLUDED.new_lot_expiry, entered_by = EXCLUDED.entered_by, entered_at = now()
     RETURNING id::text`,
    [
      countId,
      item.id,
      input.lotId ?? null,
      book.toFixed(4),
      counted.toFixed(4),
      cost === null ? null : unitCost.format(cost),
      variance.toFixed(4),
      value.toFixed(4),
      needsApproval,
      input.newLotExpiry ?? null,
      who.userId,
    ],
  );
  return { lineId: rows[0]?.id ?? '' };
}

export async function removeLine(tx: Tx, countId: string, lineId: string): Promise<void> {
  const count = await lockCount(tx, countId);
  mustBe(count, 'draft');
  const { rowCount } = await tx.query(
    'DELETE FROM cl.stock_count_lines WHERE id = $1 AND count_id = $2',
    [lineId, countId],
  );
  if (!rowCount) throw new AppError('NOT_FOUND', 'Line not found');
}

async function post(tx: Tx, who: Counter, count: CountRow, now: Date): Promise<void> {
  const businessDate = await businessDateOf(tx, now);
  const { rows } = await tx.query<{
    id: string;
    item_id: string;
    lot_id: string | null;
    variance_qty: string;
    new_lot_expiry: string | null;
  }>(
    `SELECT id::text, item_id::text, lot_id::text, variance_qty::text, new_lot_expiry::text
       FROM cl.stock_count_lines WHERE count_id = $1 ORDER BY stock_count_lines.id`,
    [count.id],
  );
  const posted = await postCountLines(
    tx,
    { actorUserId: who.userId, businessDate },
    rows.map((r) => ({
      lineId: r.id,
      itemId: r.item_id,
      lotId: r.lot_id,
      variance: new Decimal(r.variance_qty),
      newLotExpiry: r.new_lot_expiry,
    })),
  );
  for (const [lineId, p] of posted) {
    await tx.query(
      'UPDATE cl.stock_count_lines SET posted_qty = $2, movement_id = $3 WHERE id = $1',
      [lineId, p.posted.toFixed(4), p.movementId],
    );
  }
  await tx.query(
    `UPDATE cl.stock_counts SET status = 'posted', posted_at = now(), business_date = $2 WHERE id = $1`,
    [count.id, businessDate],
  );
}

/** Submits; posts at once when no line needs approval (D-18). */
export async function submitCount(
  tx: Tx,
  who: Counter,
  countId: string,
  now: Date,
): Promise<{ status: 'submitted' | 'posted'; needsApproval: number }> {
  const count = await lockCount(tx, countId);
  mustBe(count, 'draft');
  const { rows } = await tx.query<{ lines: number; flagged: number }>(
    `SELECT count(*)::int AS lines, count(*) FILTER (WHERE needs_approval)::int AS flagged
       FROM cl.stock_count_lines WHERE count_id = $1`,
    [countId],
  );
  const { lines = 0, flagged = 0 } = rows[0] ?? {};
  if (lines === 0) throw new AppError('VALIDATION_FAILED', 'Count at least one item first');
  await tx.query(
    `UPDATE cl.stock_counts SET status = 'submitted', submitted_by = $2, submitted_at = now(),
            sent_back_reason = NULL
      WHERE id = $1`,
    [countId, who.userId],
  );
  if (flagged === 0) {
    await post(tx, who, { ...count, submitted_by: who.userId }, now);
    await changed(tx, who.audit, countId, 'stock.count.post', { lines, approvedBy: null });
    return { status: 'posted', needsApproval: 0 };
  }
  await changed(tx, who.audit, countId, 'stock.count.submit', { lines, flagged });
  return { status: 'submitted', needsApproval: flagged };
}

/**
 * Approves and posts. The approver is the caller when they hold `inventory.count_approve`,
 * else whoever approved by PIN on this device (`approvedBy` from a step-up); never the
 * submitter (D-18; the database refuses it too).
 */
export async function approveCount(
  tx: Tx,
  who: Counter,
  countId: string,
  now: Date,
  approvedBy: string,
): Promise<{ status: 'posted' }> {
  const count = await lockCount(tx, countId);
  mustBe(count, 'submitted');
  if (approvedBy === count.submitted_by) {
    throw new AppError(
      'FORBIDDEN',
      'Someone other than the person who submitted the count must approve it',
    );
  }
  await tx.query('UPDATE cl.stock_counts SET approved_by = $2 WHERE id = $1', [
    countId,
    approvedBy,
  ]);
  await post(tx, who, count, now);
  await writeAudit(tx, who.audit, {
    action: 'stock.count.approve',
    entityType: 'stock_count',
    entityId: countId,
    approvedBy,
  });
  await changed(tx, who.audit, countId, 'stock.count.post', { approvedBy });
  return { status: 'posted' };
}

/** Back to draft; the named lines (default: those over the thresholds) are counted again. */
export async function sendBack(
  tx: Tx,
  who: Counter,
  countId: string,
  input: { reason: string; lineIds?: readonly string[] | undefined },
): Promise<{ status: 'draft'; recount: number }> {
  const count = await lockCount(tx, countId);
  mustBe(count, 'submitted');
  const { rowCount } = await tx.query(
    `DELETE FROM cl.stock_count_lines
      WHERE count_id = $1 AND (CASE WHEN $2::bigint[] IS NULL THEN needs_approval ELSE id = ANY($2::bigint[]) END)`,
    [countId, input.lineIds ?? null],
  );
  await tx.query(
    `UPDATE cl.stock_counts SET status = 'draft', submitted_by = NULL, submitted_at = NULL,
            sent_back_reason = $2
      WHERE id = $1`,
    [countId, input.reason],
  );
  await changed(tx, who.audit, countId, 'stock.count.send_back', {
    reason: input.reason,
    recount: rowCount ?? 0,
  });
  return { status: 'draft', recount: rowCount ?? 0 };
}

export async function cancelCount(
  tx: Tx,
  who: Counter,
  countId: string,
): Promise<{ status: 'cancelled' }> {
  const count = await lockCount(tx, countId);
  mustBe(count, 'draft');
  await tx.query(`UPDATE cl.stock_counts SET status = 'cancelled' WHERE id = $1`, [countId]);
  await changed(tx, who.audit, countId, 'stock.count.cancel', {});
  return { status: 'cancelled' };
}

// ------------------------------------------------------------------ reading

export interface CountSummary {
  id: string;
  countNo: string;
  status: CountRow['status'];
  blind: boolean;
  scope: CountRow['scope_kind'];
  category: string | null;
  startedBy: string;
  startedAt: string;
  submittedBy: string | null;
  approvedBy: string | null;
  postedAt: string | null;
  sentBackReason: string | null;
  lineCount: number;
}

const SUMMARY = `
  SELECT c.id::text, c.count_no AS "countNo", c.status, c.blind, c.scope_kind AS scope,
         c.scope_category AS category, s.display_name AS "startedBy", c.started_at AS "startedAt",
         sb.display_name AS "submittedBy", ab.display_name AS "approvedBy", c.posted_at AS "postedAt",
         c.sent_back_reason AS "sentBackReason",
         (SELECT count(*)::int FROM cl.stock_count_lines l WHERE l.count_id = c.id) AS "lineCount"
    FROM cl.stock_counts c
    JOIN cl.users s ON s.id = c.started_by
    LEFT JOIN cl.users sb ON sb.id = c.submitted_by
    LEFT JOIN cl.users ab ON ab.id = c.approved_by`;

export async function listCounts(db: Queryable): Promise<CountSummary[]> {
  const { rows } = await db.query<CountSummary>(
    `${SUMMARY} ORDER BY c.started_at DESC, c.id DESC LIMIT 50`,
  );
  return rows;
}

export interface CountLineView {
  id: string;
  itemId: string;
  lotId: string | null;
  countedQty: string;
  /** Hidden (null) while a blind count is being counted. */
  bookQty: string | null;
  varianceQty: string | null;
  /** Only with `inventory.cost_view`. */
  varianceValue: string | null;
  needsApproval: boolean | null;
  newLotExpiry: string | null;
  postedQty: string | null;
  enteredBy: string;
}

export interface CountItemView {
  id: string;
  name: string;
  sku: string;
  category: string | null;
  baseUom: 'g' | 'ml' | 'pcs';
  trackLots: boolean;
  /** Lots with stock, earliest expiry first (quantities hidden while blind). */
  lots: {
    id: string;
    lotCode: string | null;
    expiryDate: string | null;
    qtyRemaining: string | null;
  }[];
}

export async function readCount(
  db: Queryable,
  countId: string,
  viewer: { costs: boolean },
): Promise<CountSummary & { items: CountItemView[]; lines: CountLineView[] }> {
  const { rows } = await db.query<CountSummary>(`${SUMMARY} WHERE c.id = $1`, [countId]);
  const count = rows[0];
  if (!count) throw new AppError('NOT_FOUND', 'Count not found');
  const hidden = count.blind && count.status === 'draft';
  const { rows: items } = await db.query<Omit<CountItemView, 'lots'>>(
    `SELECT s.id::text, s.name, s.sku, s.category, s.base_uom AS "baseUom", s.track_lots AS "trackLots"
       FROM (${SCOPE_ITEMS}) s ORDER BY s.category NULLS LAST, lower(s.name), s.id`,
    [countId],
  );
  const { rows: lots } = await db.query<{
    item_id: string;
    id: string;
    lot_code: string | null;
    expiry_date: string | null;
    qty: string;
  }>(
    `SELECT l.item_id::text, l.id::text, l.lot_code, l.expiry_date::text, l.qty_remaining::text AS qty
       FROM cl.inventory_lots l
      WHERE l.item_id = ANY($1::bigint[])
        AND (l.qty_remaining > 0 OR EXISTS (
              SELECT 1 FROM cl.stock_count_lines x WHERE x.count_id = $2 AND x.lot_id = l.id))
      ORDER BY l.expiry_date NULLS LAST, l.received_at, l.id`,
    [items.filter((i) => i.trackLots).map((i) => i.id), countId],
  );
  const { rows: lines } = await db.query<CountLineView & { variance_value: string }>(
    `SELECT l.id::text, l.item_id::text AS "itemId", l.lot_id::text AS "lotId",
            l.counted_qty::text AS "countedQty", l.book_qty_snap::text AS "bookQty",
            l.variance_qty::text AS "varianceQty", l.variance_value::text AS "varianceValue",
            l.needs_approval AS "needsApproval", l.new_lot_expiry::text AS "newLotExpiry",
            l.posted_qty::text AS "postedQty", u.display_name AS "enteredBy"
       FROM cl.stock_count_lines l JOIN cl.users u ON u.id = l.entered_by
      WHERE l.count_id = $1 ORDER BY l.id`,
    [countId],
  );
  return {
    ...count,
    items: items.map((i) => ({
      ...i,
      lots: lots
        .filter((l) => l.item_id === i.id)
        .map((l) => ({
          id: l.id,
          lotCode: l.lot_code,
          expiryDate: l.expiry_date,
          qtyRemaining: hidden ? null : l.qty,
        })),
    })),
    lines: lines.map((l) => ({
      ...l,
      bookQty: hidden ? null : l.bookQty,
      varianceQty: hidden ? null : l.varianceQty,
      varianceValue: hidden || !viewer.costs ? null : l.varianceValue,
      needsApproval: hidden ? null : l.needsApproval,
    })),
  };
}
