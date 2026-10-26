/**
 * The stock ledger (DATABASE.md §8, ORDER_STATE_MACHINE.md §5, COST_VALUATION.md).
 *
 * Every function runs inside the caller's transaction and locks `inventory_balances`
 * rows in ascending item id before touching reservations (DATABASE.md §14), so stock,
 * value, reservations, movements and line costs always change together or not at all.
 * Quantities are base units (g, ml, pcs) as Decimals.
 */
import { Decimal, unitCostOf } from '@cl/shared';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf } from '../../platform/settings.ts';
import {
  createLot,
  lotSettings,
  recordLotShares,
  resolveEmptyLotAlerts,
  takeFromLots,
  unusableQty,
  type LotTake,
} from './lots.ts';
import { averageCost, foundStockUnitCost, issueValue, round4, type Balance } from './math.ts';

/** Who and when, for every movement. */
export interface StockContext {
  actorUserId: string | null;
  /** YYYY-MM-DD (platform/settings businessDateOf). */
  businessDate: string;
}

interface BalanceRow {
  item_id: string;
  on_hand: string;
  reserved: string;
  inventory_value: string;
  last_unit_cost: string | null;
}

interface LockedBalance {
  itemId: string;
  onHand: Decimal;
  reserved: Decimal;
  value: Decimal;
  lastUnitCost: Decimal | null;
}

async function lockBalances(
  tx: Tx,
  itemIds: readonly string[],
): Promise<Map<string, LockedBalance>> {
  const rows = await tx.lock<BalanceRow>('inventory_balances', itemIds);
  const found = new Map(
    rows.map((r) => [
      r.item_id,
      {
        itemId: r.item_id,
        onHand: new Decimal(r.on_hand),
        reserved: new Decimal(r.reserved),
        value: new Decimal(r.inventory_value),
        lastUnitCost: r.last_unit_cost === null ? null : new Decimal(r.last_unit_cost),
      },
    ]),
  );
  for (const id of itemIds)
    if (!found.has(id)) throw new AppError('NOT_FOUND', `Stock item ${id} not found`);
  return found;
}

async function saveBalance(tx: Tx, b: LockedBalance): Promise<void> {
  await tx.query(
    `UPDATE cl.inventory_balances
        SET on_hand = $2, reserved = $3, inventory_value = $4, last_unit_cost = $5
      WHERE item_id = $1`,
    [
      b.itemId,
      b.onHand.toFixed(4),
      b.reserved.toFixed(4),
      b.value.toFixed(4),
      b.lastUnitCost?.toFixed(8) ?? null,
    ],
  );
}

interface MovementInput {
  itemId: string;
  type: 'opening' | 'receipt' | 'reversal' | 'consumption' | 'waste' | 'count_adjustment';
  qtyDelta: Decimal;
  unitCost: Decimal | null;
  valueDelta: Decimal;
  sourceType: string;
  sourceId: string;
  sourceKey: string;
  reasonCode?: string;
  flags?: string[];
  note?: string;
  reversesMovementId?: string;
}

async function insertMovement(tx: Tx, ctx: StockContext, m: MovementInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.stock_movements
       (item_id, movement_type, qty_delta, unit_cost, value_delta, source_type, source_id, source_key,
        reason_code, flags, actor_user_id, business_date, note, reverses_movement_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id::text`,
    [
      m.itemId,
      m.type,
      m.qtyDelta.toFixed(4),
      m.unitCost?.toFixed(8) ?? null,
      m.valueDelta.toFixed(4),
      m.sourceType,
      m.sourceId,
      m.sourceKey,
      m.reasonCode ?? null,
      m.flags ?? [],
      ctx.actorUserId,
      ctx.businessDate,
      m.note ?? null,
      m.reversesMovementId ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('movement insert returned no id');
  return id;
}

/** Issues q at the current average (drain rule at zero); returns the value taken. */
function issue(b: LockedBalance, q: Decimal): { value: Decimal; unitCost: Decimal | null } {
  const before: Balance = { onHand: b.onHand, value: b.value };
  const unitCost = averageCost(before);
  const value = issueValue(before, q);
  b.onHand = b.onHand.minus(q);
  b.value = b.value.minus(value);
  if (unitCost !== null) b.lastUnitCost = unitCost;
  return { value, unitCost };
}

/** Stock changed: menus refetch availability (API.md §7 `availability.changed`). */
async function announce(tx: Tx, itemIds: Iterable<string>): Promise<void> {
  for (const itemId of new Set(itemIds)) {
    await publish(tx, {
      type: 'availability.changed',
      entityType: 'inventory_item',
      entityId: itemId,
      topics: ['menu'],
    });
  }
}

// ---------------------------------------------------------------- alerts

type AlertKind =
  | 'low'
  | 'zero'
  | 'reservation_shortfall'
  | 'found_stock'
  | 'balance_mismatch'
  | 'stale_reservation'
  | 'near_expiry'
  | 'expired';

export async function openAlert(
  tx: Tx,
  itemId: string,
  kind: AlertKind,
  detail: object,
  lotId?: string,
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.inventory_alerts (item_id, lot_id, kind, detail) VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, item_id, lot_id) WHERE state <> 'resolved' DO NOTHING
     RETURNING id::text`,
    [itemId, lotId ?? null, kind, JSON.stringify(detail)],
  );
  const id = rows[0]?.id;
  if (id !== undefined) {
    await publish(tx, {
      type: 'alert.raised',
      entityType: 'inventory_alert',
      entityId: id,
      topics: ['alerts'],
    });
  }
}

async function resolveAlert(tx: Tx, itemId: string, kind: AlertKind): Promise<void> {
  await tx.query(
    `UPDATE cl.inventory_alerts SET state = 'resolved', resolved_at = now()
      WHERE item_id = $1 AND kind = $2 AND state <> 'resolved'`,
    [itemId, kind],
  );
}

/**
 * Opens or resolves the alerts that follow from a balance (RECIPE_INVENTORY.md §10):
 * low (available ≤ threshold), zero (available ≤ 0), reservation shortfall (on hand
 * below reserved). Called with the balance still locked.
 */
async function evaluateAlerts(tx: Tx, b: LockedBalance): Promise<void> {
  const { rows } = await tx.query<{ low_threshold: string | null; stock_control_active: boolean }>(
    'SELECT low_threshold, stock_control_active FROM cl.inventory_items WHERE id = $1',
    [b.itemId],
  );
  const item = rows[0];
  if (!item?.stock_control_active) return;
  const available = b.onHand.minus(b.reserved);
  const detail = {
    onHand: b.onHand.toFixed(4),
    reserved: b.reserved.toFixed(4),
    available: available.toFixed(4),
  };
  if (available.lessThanOrEqualTo(0)) await openAlert(tx, b.itemId, 'zero', detail);
  else await resolveAlert(tx, b.itemId, 'zero');
  if (item.low_threshold !== null && available.lessThanOrEqualTo(item.low_threshold)) {
    await openAlert(tx, b.itemId, 'low', { ...detail, threshold: item.low_threshold });
  } else {
    await resolveAlert(tx, b.itemId, 'low');
  }
  if (b.onHand.lessThan(b.reserved)) await openAlert(tx, b.itemId, 'reservation_shortfall', detail);
  else await resolveAlert(tx, b.itemId, 'reservation_shortfall');
}

// ---------------------------------------------------------------- opening balance

/**
 * Opening balance of an item (COST_VALUATION.md §3): its first known quantity and unit
 * cost. Switches the item on for stock control (D-29). Once per item.
 */
export async function postOpeningBalance(
  tx: Tx,
  ctx: StockContext,
  audit: AuditContext,
  input: {
    itemId: string;
    qty: Decimal;
    unitCost: Decimal;
    /** Lot-tracked items: the opening lot. */
    lotCode?: string | null;
    expiryDate?: string | null;
  },
): Promise<void> {
  if (input.qty.isNegative() || input.unitCost.isNegative()) {
    throw new AppError('VALIDATION_FAILED', 'Opening quantity and cost cannot be negative');
  }
  const b = (await lockBalances(tx, [input.itemId])).get(input.itemId);
  if (!b) throw new AppError('NOT_FOUND', 'Stock item not found');
  const { rows } = await tx.query<{ stock_control_active: boolean }>(
    'SELECT stock_control_active FROM cl.inventory_items WHERE id = $1 FOR UPDATE',
    [input.itemId],
  );
  if (rows[0]?.stock_control_active) {
    throw new AppError(
      'VALIDATION_FAILED',
      'This item already has its opening balance; use a stock count',
    );
  }
  const q = round4(input.qty);
  const value = round4(q.times(input.unitCost));
  if (q.greaterThan(0)) {
    const movementId = await insertMovement(tx, ctx, {
      itemId: input.itemId,
      type: 'opening',
      qtyDelta: q,
      unitCost: input.unitCost,
      valueDelta: value,
      sourceType: 'inventory_item',
      sourceId: input.itemId,
      sourceKey: `opening:item:${input.itemId}`,
    });
    if ((await lotSettings(tx, [input.itemId])).get(input.itemId)?.trackLots) {
      const lotId = await createLot(tx, {
        itemId: input.itemId,
        qty: q,
        origin: 'opening',
        lotCode: input.lotCode ?? null,
        expiryDate: input.expiryDate ?? null,
      });
      await recordLotShares(tx, movementId, [{ lotId, qty: q }], 1);
    }
  }
  b.onHand = b.onHand.plus(q);
  b.value = b.value.plus(value);
  b.lastUnitCost = input.unitCost;
  await saveBalance(tx, b);
  await tx.query('UPDATE cl.inventory_items SET stock_control_active = true WHERE id = $1', [
    input.itemId,
  ]);
  await writeAudit(tx, audit, {
    action: 'stock.opening',
    entityType: 'inventory_item',
    entityId: input.itemId,
    after: { qty: q.toFixed(4), unitCost: input.unitCost.toFixed(8), value: value.toFixed(4) },
  });
  await evaluateAlerts(tx, b);
  await announce(tx, [input.itemId]);
}

// ---------------------------------------------------------------- purchase receipts

export interface ReceiptLineStock {
  itemId: string;
  /** Base units, > 0. */
  qty: Decimal;
  /** What was paid for the line (PKR, 2 dp), ≥ 0. */
  lineCost: Decimal;
  /** The purchase receipt line. */
  sourceId: string;
  /** For lot-tracked items: the lot as received. */
  lotCode?: string | null;
  expiryDate?: string | null;
}

/**
 * Stock in from a purchase receipt (COST_VALUATION.md §3): per line, unit cost = line
 * cost ÷ quantity to 8 dp, Q + q, V + line cost, L = unit cost; one `receipt` movement
 * each. Balances are locked once, in ascending item id, before anything is written.
 * `startStockControl` lists items that had no opening count and start from this receipt
 * (their shelf was empty, D-29). Returns the movement id per line.
 */
export async function receiveStock(
  tx: Tx,
  ctx: StockContext,
  lines: readonly ReceiptLineStock[],
  startStockControl: ReadonlySet<string> = new Set(),
): Promise<Map<string, string>> {
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const balances = await lockBalances(tx, itemIds);
  const { rows: items } = await tx.query<{
    id: string;
    name: string;
    stock_control_active: boolean;
    archived: boolean;
  }>(
    `SELECT id::text, name, stock_control_active, archived_at IS NOT NULL AS archived
       FROM cl.inventory_items WHERE id = ANY($1::bigint[]) ORDER BY inventory_items.id FOR UPDATE`,
    [itemIds],
  );
  for (const item of items) {
    if (item.archived) throw new AppError('VALIDATION_FAILED', `${item.name} is archived`);
    if (!item.stock_control_active && !startStockControl.has(item.id)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${item.name} is not counted yet: confirm its shelf was empty to start stock control ` +
          'from this receipt, or post its opening count first',
        { itemId: item.id },
      );
    }
  }
  const lots = await lotSettings(tx, itemIds);
  const movements = new Map<string, string>();
  for (const line of lines) {
    const b = balances.get(line.itemId);
    if (!b) continue;
    if (line.qty.lessThanOrEqualTo(0) || line.lineCost.isNegative()) {
      throw new AppError('VALIDATION_FAILED', 'A receipt line needs a quantity and a cost');
    }
    const unitCost = unitCostOf(line.lineCost, line.qty);
    const movementId = await insertMovement(tx, ctx, {
      itemId: line.itemId,
      type: 'receipt',
      qtyDelta: line.qty,
      unitCost,
      valueDelta: line.lineCost,
      sourceType: 'purchase_receipt_line',
      sourceId: line.sourceId,
      sourceKey: `receipt:line:${line.sourceId}`,
    });
    movements.set(line.sourceId, movementId);
    if (lots.get(line.itemId)?.trackLots) {
      const lotId = await createLot(tx, {
        itemId: line.itemId,
        qty: line.qty,
        origin: 'receipt',
        lotCode: line.lotCode ?? null,
        expiryDate: line.expiryDate ?? null,
        receiptLineId: line.sourceId,
      });
      await recordLotShares(tx, movementId, [{ lotId, qty: line.qty }], 1);
    }
    b.onHand = b.onHand.plus(line.qty);
    b.value = b.value.plus(line.lineCost);
    b.lastUnitCost = unitCost;
  }
  const started = items.filter((i) => !i.stock_control_active).map((i) => i.id);
  if (started.length > 0) {
    await tx.query(
      'UPDATE cl.inventory_items SET stock_control_active = true WHERE id = ANY($1::bigint[])',
      [started],
    );
  }
  for (const b of balances.values()) {
    await saveBalance(tx, b);
    await evaluateAlerts(tx, b);
  }
  await announce(tx, itemIds);
  return movements;
}

export interface ReceiptLineReversal extends ReceiptLineStock {
  /** The line's `receipt` movement. */
  movementId: string;
}

/**
 * Takes a whole receipt back out (RECIPE_INVENTORY.md §7 "Corrections"), only while its
 * stock is still available: what is reserved for accepted orders stays covered. When
 * nothing else has moved an item since the receipt, the item returns exactly to its
 * quantity, value and last cost from before the receipt; otherwise the quantity leaves at
 * the current average like any issue (COST_VALUATION.md §4), so value never goes negative.
 * One `reversal` movement per line.
 */
export async function reverseReceiptStock(
  tx: Tx,
  ctx: StockContext,
  lines: readonly ReceiptLineReversal[],
): Promise<void> {
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const balances = await lockBalances(tx, itemIds);
  const { rows: names } = await tx.query<{ id: string; name: string; base_uom: string }>(
    'SELECT id::text, name, base_uom FROM cl.inventory_items WHERE id = ANY($1::bigint[])',
    [itemIds],
  );
  const name = new Map(names.map((n) => [n.id, n]));
  const { rows: ownLots } = await tx.query<{
    id: string;
    receipt_line_id: string;
    qty_remaining: string;
    qty_received: string;
  }>(
    `SELECT id::text, receipt_line_id::text, qty_remaining::text, qty_received::text
       FROM cl.inventory_lots WHERE receipt_line_id = ANY($1::bigint[])`,
    [lines.map((l) => l.sourceId)],
  );
  const lotOf = new Map(ownLots.map((l) => [l.receipt_line_id, l]));
  for (const line of lines) {
    const lot = lotOf.get(line.sourceId);
    if (lot && new Decimal(lot.qty_remaining).lessThan(line.qty)) {
      const item = name.get(line.itemId);
      throw new AppError(
        'VALIDATION_FAILED',
        `Part of the ${item?.name ?? 'item'} lot from this receipt is already used ` +
          `(${new Decimal(lot.qty_remaining).toString()} of ${line.qty.toString()} ${item?.base_uom ?? ''} left). ` +
          'Record a waste or a supplier return instead.',
      );
    }
  }
  for (const itemId of itemIds) {
    const b = balances.get(itemId);
    const q = lines
      .filter((l) => l.itemId === itemId)
      .reduce((sum, l) => sum.plus(l.qty), new Decimal(0));
    if (!b) continue;
    const available = b.onHand.minus(b.reserved);
    if (available.lessThan(q)) {
      const item = name.get(itemId);
      throw new AppError(
        'VALIDATION_FAILED',
        `Only ${available.toString()} ${item?.base_uom ?? ''} of ${item?.name ?? 'an item'} is ` +
          `still available, and this receipt brought in ${q.toString()}. ` +
          'Record a waste or a supplier return instead.',
      );
    }
  }
  for (const itemId of itemIds) {
    const b = balances.get(itemId);
    if (!b) continue;
    const own = lines.filter((l) => l.itemId === itemId);
    const ownIds = own.map((l) => l.movementId);
    const { rows } = await tx.query<{ later: boolean; previous_cost: string | null }>(
      `SELECT EXISTS (SELECT 1 FROM cl.stock_movements
                       WHERE item_id = $1 AND id > $2 AND NOT (id = ANY($3::bigint[]))) AS later,
              (SELECT unit_cost::text FROM cl.stock_movements
                WHERE item_id = $1 AND id < $2 AND unit_cost IS NOT NULL
                ORDER BY stock_movements.id DESC LIMIT 1) AS previous_cost`,
      [itemId, minId(ownIds), ownIds],
    );
    const exact = rows[0]?.later === false;
    for (const line of own) {
      let value: Decimal;
      let unitCost: Decimal | null;
      if (exact) {
        value = line.lineCost;
        unitCost = unitCostOf(line.lineCost, line.qty);
        b.onHand = b.onHand.minus(line.qty);
        b.value = b.value.minus(value);
      } else {
        ({ value, unitCost } = issue(b, line.qty));
      }
      const reversalId = await insertMovement(tx, ctx, {
        itemId,
        type: 'reversal',
        qtyDelta: line.qty.negated(),
        unitCost,
        valueDelta: value.negated(),
        sourceType: 'purchase_receipt_line',
        sourceId: line.sourceId,
        sourceKey: `receipt:reverse:line:${line.sourceId}`,
        reversesMovementId: line.movementId,
        ...(exact ? {} : { flags: ['at_average'] }),
      });
      const lot = lotOf.get(line.sourceId);
      if (lot) {
        const takes = await takeFromLots(tx, itemId, line.qty, ctx.businessDate, lot.id);
        await recordLotShares(tx, reversalId, takes, -1);
      }
    }
    await resolveEmptyLotAlerts(tx, itemId);
    if (exact) {
      const previous = rows[0]?.previous_cost;
      b.lastUnitCost = previous ? new Decimal(previous) : null;
    }
    await saveBalance(tx, b);
    await evaluateAlerts(tx, b);
  }
  await announce(tx, itemIds);
}

function minId(ids: readonly string[]): string {
  return ids.reduce((a, b) => (BigInt(a) <= BigInt(b) ? a : b));
}

// ---------------------------------------------------------------- reservations

export interface Shortage {
  itemId: string;
  name: string;
  needed: string;
  available: string;
  /** Keys of the lines that needed the ingredient (order line ids, or the caller's keys). */
  lineKeys: string[];
}

/**
 * One line's needs at acceptance: ingredient id → quantity for the whole line. `key` is
 * the order line id, or any caller key when the lines are not inserted yet.
 */
export interface LineRequirement {
  key: string;
  requirement: ReadonlyMap<string, Decimal>;
}

export interface StockHold {
  /** Writes the reservations; `lineIdOf` maps each key to its order line id. */
  commit(lineIdOf?: (key: string) => string): Promise<void>;
}

/**
 * First half of a reservation (V1): locks the balances once, in ascending item id, and
 * checks them against the **total** need of all the lines. When any ingredient is short
 * it throws INSUFFICIENT_STOCK with each short ingredient and the keys of the lines that
 * needed it, and nothing is written. The caller then inserts its lines (taking document
 * numbers last, DATABASE.md §14) and commits the hold.
 */
export async function holdStock(
  tx: Tx,
  lines: readonly LineRequirement[],
  /** Business date for expiry (default: today's). */
  asOf?: string,
): Promise<StockHold> {
  const total = new Map<string, Decimal>();
  const users = new Map<string, string[]>();
  for (const line of lines) {
    for (const [itemId, q] of line.requirement) {
      if (q.lessThanOrEqualTo(0)) continue;
      total.set(itemId, (total.get(itemId) ?? new Decimal(0)).plus(q));
      users.set(itemId, [...(users.get(itemId) ?? []), line.key]);
    }
  }
  if (total.size === 0) return { commit: () => Promise.resolve() };
  const itemIds = [...total.keys()];
  const balances = await lockBalances(tx, itemIds);
  const { rows: untracked } = await tx.query<{ name: string }>(
    'SELECT name FROM cl.inventory_items WHERE id = ANY($1::bigint[]) AND NOT stock_control_active',
    [itemIds],
  );
  if (untracked.length > 0) {
    // Cannot happen through the services: a recipe goes live only when every ingredient is counted.
    throw new Error(`not stock-controlled: ${untracked.map((r) => r.name).join(', ')}`);
  }
  // Expired and quarantined lots are on hand but not usable (AT-13).
  const unusable = await unusableQty(tx, itemIds, asOf ?? (await businessDateOf(tx, new Date())));
  const shortages: Shortage[] = [];
  for (const [itemId, q] of total) {
    const b = balances.get(itemId);
    if (!b) continue;
    const available = b.onHand.minus(b.reserved).minus(unusable.get(itemId) ?? 0);
    if (available.lessThan(q)) {
      shortages.push({
        itemId,
        name: '',
        needed: q.toFixed(4),
        available: available.toFixed(4),
        lineKeys: users.get(itemId) ?? [],
      });
    }
  }
  if (shortages.length > 0) {
    const { rows } = await tx.query<{ id: string; name: string }>(
      'SELECT id::text, name FROM cl.inventory_items WHERE id = ANY($1::bigint[])',
      [shortages.map((s) => s.itemId)],
    );
    const names = new Map(rows.map((r) => [r.id, r.name]));
    for (const sh of shortages) sh.name = names.get(sh.itemId) ?? '';
    throw new AppError(
      'INSUFFICIENT_STOCK',
      `Not enough ${shortages.map((sh) => sh.name).join(', ')}`,
      { shortages },
    );
  }
  return {
    async commit(lineIdOf = (key) => key) {
      for (const line of lines) {
        for (const [itemId, q] of line.requirement) {
          if (q.lessThanOrEqualTo(0)) continue;
          await tx.query(
            'INSERT INTO cl.stock_reservations (order_line_id, item_id, qty_reserved) VALUES ($1, $2, $3)',
            [lineIdOf(line.key), itemId, q.toFixed(4)],
          );
        }
      }
      for (const [itemId, q] of total) {
        const b = balances.get(itemId);
        if (!b) continue;
        b.reserved = b.reserved.plus(q);
        await saveBalance(tx, b);
        await evaluateAlerts(tx, b);
      }
      await announce(tx, itemIds);
    },
  };
}

/** Holds and commits at once, for lines that already exist (keys are order line ids). */
export async function reserve(
  tx: Tx,
  input: { orderLineId: string; requirement: ReadonlyMap<string, Decimal> },
): Promise<void> {
  const hold = await holdStock(tx, [{ key: input.orderLineId, requirement: input.requirement }]);
  await hold.commit();
}

/** One ingredient to consume or release: a quantity, or 'rest' for the line's last units. */
export interface Take {
  itemId: string;
  qty: Decimal | 'rest';
}

interface ReservationRow {
  id: string;
  item_id: string;
  qty_reserved: string;
  qty_consumed: string;
  qty_released: string;
}

/** One order line's share of a pickup or a cancellation. */
export interface LineTakes {
  orderLineId: string;
  takes: readonly Take[];
}

const pair = (lineId: string, itemId: string) => `${lineId}:${itemId}`;

/** Locks the reservations of several lines at once, in ascending id (DATABASE.md §14). */
async function lockReservations(
  tx: Tx,
  lines: readonly LineTakes[],
): Promise<Map<string, ReservationRow>> {
  const lineIds = lines.flatMap((l) => l.takes.map(() => l.orderLineId));
  const itemIds = lines.flatMap((l) => l.takes.map((t) => t.itemId));
  const { rows: ids } = await tx.query<{ id: string }>(
    `SELECT r.id::text FROM cl.stock_reservations r
       JOIN unnest($1::bigint[], $2::bigint[]) AS w(line_id, item_id)
         ON r.order_line_id = w.line_id AND r.item_id = w.item_id`,
    [lineIds, itemIds],
  );
  const rows = await tx.lock<ReservationRow & { order_line_id: string }>(
    'stock_reservations',
    ids.map((r) => r.id),
  );
  const byPair = new Map(rows.map((r) => [pair(r.order_line_id, r.item_id), r]));
  for (const l of lines) {
    for (const t of l.takes) {
      if (!byPair.has(pair(l.orderLineId, t.itemId))) {
        throw new Error(`line ${l.orderLineId} has no reservation for item ${t.itemId}`);
      }
    }
  }
  return byPair;
}

function openQty(r: ReservationRow): Decimal {
  return new Decimal(r.qty_reserved).minus(r.qty_consumed).minus(r.qty_released);
}

function takeQty(r: ReservationRow, take: Take): Decimal {
  const open = openQty(r);
  const q = take.qty === 'rest' ? open : round4(take.qty);
  if (q.isNegative() || q.greaterThan(open)) {
    throw new Error(
      `cannot take ${q.toFixed(4)} of item ${take.itemId}: ${open.toFixed(4)} reserved and open`,
    );
  }
  return q;
}

async function moveReservation(
  tx: Tx,
  r: ReservationRow,
  column: 'qty_consumed' | 'qty_released',
  q: Decimal,
) {
  await tx.query(
    `UPDATE cl.stock_reservations SET ${column} = ${column} + $2,
            status = CASE WHEN qty_consumed + qty_released + $2 = qty_reserved THEN 'closed' ELSE 'active' END
      WHERE id = $1`,
    [r.id, q.toFixed(4)],
  );
  // Several takes of one reservation in one call see their own updates.
  if (column === 'qty_consumed') r.qty_consumed = new Decimal(r.qty_consumed).plus(q).toFixed(4);
  else r.qty_released = new Decimal(r.qty_released).plus(q).toFixed(4);
}

const byItemId = (a: Take, b: Take) =>
  BigInt(a.itemId) < BigInt(b.itemId) ? -1 : BigInt(a.itemId) > BigInt(b.itemId) ? 1 : 0;

/**
 * Consumes reserved ingredients when units are picked up (V2, D-33), for one line or a
 * whole ticket at once. Each ingredient is issued at the current average and its value
 * frozen in `order_line_costs`. If the book quantity is short (only after a count
 * recorded too little) the pickup is never blocked: the missing quantity is first posted
 * as found stock and the owner is alerted. `eventKey` makes the movements idempotent
 * (unique source keys). Returns the value consumed, in total and per line.
 */
export async function consume(
  tx: Tx,
  ctx: StockContext,
  input: { eventKey: string } & (LineTakes | { lines: readonly LineTakes[] }),
): Promise<{ value: Decimal; byLine: Map<string, Decimal> }> {
  const lines =
    'lines' in input ? input.lines : [{ orderLineId: input.orderLineId, takes: input.takes }];
  const itemIds = [...new Set(lines.flatMap((l) => l.takes.map((t) => t.itemId)))];
  const byLine = new Map<string, Decimal>();
  if (itemIds.length === 0) return { value: new Decimal(0), byLine };
  const balances = await lockBalances(tx, itemIds);
  const reservations = await lockReservations(tx, lines);
  const lots = await lotSettings(tx, itemIds);
  let total = new Decimal(0);
  for (const line of lines) {
    for (const take of [...line.takes].sort(byItemId)) {
      const b = balances.get(take.itemId);
      const r = reservations.get(pair(line.orderLineId, take.itemId));
      if (!b || !r) continue;
      const q = takeQty(r, take);
      if (q.isZero()) continue;
      const key = `${input.eventKey}:line:${line.orderLineId}:item:${take.itemId}`;

      if (b.onHand.lessThan(q)) {
        const missing = q.minus(b.onHand);
        const cost = foundStockUnitCost(b, b.lastUnitCost) ?? new Decimal(0);
        const value = round4(missing.times(cost));
        const foundId = await insertMovement(tx, ctx, {
          itemId: take.itemId,
          type: 'count_adjustment',
          qtyDelta: missing,
          unitCost: cost,
          valueDelta: value,
          sourceType: 'order_line',
          sourceId: line.orderLineId,
          sourceKey: `found:${key}`,
          flags: ['auto_found_stock'],
        });
        if (lots.get(take.itemId)?.trackLots) {
          const lotId = await createLot(tx, { itemId: take.itemId, qty: missing, origin: 'found' });
          await recordLotShares(tx, foundId, [{ lotId, qty: missing }], 1);
        }
        b.onHand = b.onHand.plus(missing);
        b.value = b.value.plus(value);
        await openAlert(tx, take.itemId, 'found_stock', {
          orderLineId: line.orderLineId,
          qty: missing.toFixed(4),
          unitCost: cost.toFixed(8),
        });
      }

      const { value, unitCost } = issue(b, q);
      const lotTakes: LotTake[] = lots.get(take.itemId)?.trackLots
        ? await takeFromLots(tx, take.itemId, q, ctx.businessDate)
        : [];
      const expiredUsed = lotTakes.filter((t) => t.expired);
      const movementId = await insertMovement(tx, ctx, {
        itemId: take.itemId,
        type: 'consumption',
        qtyDelta: q.negated(),
        unitCost,
        valueDelta: value.negated(),
        sourceType: 'order_line',
        sourceId: line.orderLineId,
        sourceKey: `consume:${key}:lot:0`,
        ...(expiredUsed.length > 0 ? { flags: ['expired_lot_used'] } : {}),
      });
      await recordLotShares(tx, movementId, lotTakes, -1);
      // Physical reality is recorded, not hidden (RECIPE_INVENTORY.md §6, AT-30).
      for (const t of expiredUsed) {
        await openAlert(
          tx,
          take.itemId,
          'expired',
          { usedBy: line.orderLineId, qty: t.qty.toFixed(4), movementId },
          t.lotId,
        );
      }
      await tx.query(
        'INSERT INTO cl.order_line_costs (order_line_id, item_id, movement_id, qty_base, value) VALUES ($1, $2, $3, $4, $5)',
        [line.orderLineId, take.itemId, movementId, q.toFixed(4), value.toFixed(4)],
      );
      b.reserved = b.reserved.minus(q);
      await moveReservation(tx, r, 'qty_consumed', q);
      total = total.plus(value);
      byLine.set(line.orderLineId, (byLine.get(line.orderLineId) ?? new Decimal(0)).plus(value));
    }
  }
  for (const b of balances.values()) {
    await saveBalance(tx, b);
    await evaluateAlerts(tx, b);
    if (lots.get(b.itemId)?.trackLots) await resolveEmptyLotAlerts(tx, b.itemId);
  }
  await announce(tx, itemIds);
  return { value: total, byLine };
}

/** Releases reserved ingredients for units cancelled before they were made (V3). */
export async function release(
  tx: Tx,
  input: LineTakes | { lines: readonly LineTakes[] },
): Promise<void> {
  const lines = 'lines' in input ? input.lines : [input];
  const itemIds = [...new Set(lines.flatMap((l) => l.takes.map((t) => t.itemId)))];
  if (itemIds.length === 0) return;
  const balances = await lockBalances(tx, itemIds);
  const reservations = await lockReservations(tx, lines);
  for (const line of lines) {
    for (const take of line.takes) {
      const b = balances.get(take.itemId);
      const r = reservations.get(pair(line.orderLineId, take.itemId));
      if (!b || !r) continue;
      const q = takeQty(r, take);
      if (q.isZero()) continue;
      b.reserved = b.reserved.minus(q);
      await moveReservation(tx, r, 'qty_released', q);
    }
  }
  for (const b of balances.values()) {
    await saveBalance(tx, b);
    await evaluateAlerts(tx, b);
  }
  await announce(tx, itemIds);
}

// ---------------------------------------------------------------- waste

export const WASTE_REASONS = [
  'spilled',
  'remade',
  'expired',
  'damaged',
  'quality',
  'other',
] as const;

/**
 * Ingredient waste (RECIPE_INVENTORY.md §8): a `waste` movement at the current average and
 * a wastage record. Cannot waste more than the book quantity (record a count instead).
 */
export async function wasteIngredient(
  tx: Tx,
  ctx: StockContext & { actorUserId: string },
  audit: AuditContext,
  input: {
    itemId: string;
    qty: Decimal;
    reasonCode: string;
    note?: string;
    key: string;
    /** Lot-tracked items: waste from this lot (e.g. the expired one); else FEFO. */
    lotId?: string;
  },
): Promise<{ value: Decimal }> {
  const q = round4(input.qty);
  if (q.lessThanOrEqualTo(0))
    throw new AppError('VALIDATION_FAILED', 'Waste quantity must be more than zero');
  if (!(WASTE_REASONS as readonly string[]).includes(input.reasonCode)) {
    throw new AppError('VALIDATION_FAILED', `Unknown waste reason ${input.reasonCode}`);
  }
  if (input.reasonCode === 'other' && !input.note?.trim()) {
    throw new AppError('VALIDATION_FAILED', 'Say what happened when the reason is "other"');
  }
  const b = (await lockBalances(tx, [input.itemId])).get(input.itemId);
  if (!b) throw new AppError('NOT_FOUND', 'Stock item not found');
  if (q.greaterThan(b.onHand)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'That is more than the book quantity. Record a stock count instead.',
      {
        onHand: b.onHand.toFixed(4),
      },
    );
  }
  const tracked = (await lotSettings(tx, [input.itemId])).get(input.itemId)?.trackLots ?? false;
  if (input.lotId !== undefined && !tracked) {
    throw new AppError('VALIDATION_FAILED', 'This item has no lots');
  }
  let lotTakes: LotTake[] = [];
  if (tracked) {
    if (input.lotId !== undefined) {
      const { rows } = await tx.query<{ q: string }>(
        'SELECT qty_remaining::text AS q FROM cl.inventory_lots WHERE id = $1 AND item_id = $2',
        [input.lotId, input.itemId],
      );
      const left = rows[0]?.q;
      if (left === undefined)
        throw new AppError('VALIDATION_FAILED', 'That lot belongs to another item');
      if (q.greaterThan(left)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `That lot holds only ${new Decimal(left).toString()}`,
        );
      }
    }
    lotTakes = await takeFromLots(tx, input.itemId, q, ctx.businessDate, input.lotId);
  }
  const { value, unitCost } = issue(b, q);
  const movementId = await insertMovement(tx, ctx, {
    itemId: input.itemId,
    type: 'waste',
    qtyDelta: q.negated(),
    unitCost,
    valueDelta: value.negated(),
    sourceType: 'wastage',
    sourceId: input.itemId,
    sourceKey: `waste:${input.key}`,
    reasonCode: input.reasonCode,
    ...(input.note ? { note: input.note } : {}),
  });
  await tx.query(
    `INSERT INTO cl.wastage_records (kind, item_id, qty, reason_code, cost_value, movement_id, recorded_by, business_date, note, lot_id)
     VALUES ($9, $1, $2, $3, $4, $5, $6, $7, $8, $10)`,
    [
      input.itemId,
      q.toFixed(4),
      input.reasonCode,
      value.toFixed(4),
      movementId,
      ctx.actorUserId,
      ctx.businessDate,
      input.note ?? null,
      lotTakes.length > 0 && lotTakes.every((t) => t.expired) ? 'expired_lot' : 'ingredient',
      lotTakes.length === 1 ? (lotTakes[0]?.lotId ?? null) : null,
    ],
  );
  await recordLotShares(tx, movementId, lotTakes, -1);
  if (tracked) await resolveEmptyLotAlerts(tx, input.itemId);
  await saveBalance(tx, b);
  await writeAudit(tx, audit, {
    action: 'stock.waste',
    entityType: 'inventory_item',
    entityId: input.itemId,
    after: { qty: q.toFixed(4), value: value.toFixed(4), reason: input.reasonCode },
    ...(input.note ? { reason: input.note } : {}),
  });
  await evaluateAlerts(tx, b);
  await announce(tx, [input.itemId]);
  return { value };
}

// ---------------------------------------------------------------- reconciliation

export interface StockMismatch {
  itemId: string;
  problem: string;
}

/**
 * The integrity check of COST_VALUATION.md §11 (nightly job, restore check, tests):
 * balance = Σ movements in quantity and value; nothing negative; no value without
 * quantity; reserved = Σ open reservations; on hand = Σ lots for lot-tracked items (and
 * no lot stock for others); one equal line cost per consumption.
 * Reports only: nothing is ever corrected automatically.
 */
export async function findStockMismatches(db: Queryable): Promise<StockMismatch[]> {
  const { rows } = await db.query<{ item_id: string; problem: string }>(
    `WITH m AS (
       SELECT item_id, sum(qty_delta) AS q, sum(value_delta) AS v FROM cl.stock_movements GROUP BY item_id),
     r AS (
       SELECT item_id, sum(qty_reserved - qty_consumed - qty_released) AS open
         FROM cl.stock_reservations WHERE status = 'active' GROUP BY item_id)
     SELECT b.item_id::text, 'on hand ' || b.on_hand || ' ≠ movements ' || COALESCE(m.q, 0) AS problem
       FROM cl.inventory_balances b LEFT JOIN m USING (item_id) WHERE b.on_hand <> COALESCE(m.q, 0)
     UNION ALL
     SELECT b.item_id::text, 'value ' || b.inventory_value || ' ≠ movements ' || COALESCE(m.v, 0)
       FROM cl.inventory_balances b LEFT JOIN m USING (item_id) WHERE b.inventory_value <> COALESCE(m.v, 0)
     UNION ALL
     SELECT b.item_id::text, 'reserved ' || b.reserved || ' ≠ open reservations ' || COALESCE(r.open, 0)
       FROM cl.inventory_balances b LEFT JOIN r USING (item_id) WHERE b.reserved <> COALESCE(r.open, 0)
     UNION ALL
     SELECT b.item_id::text, 'negative or orphan value'
       FROM cl.inventory_balances b
      WHERE b.on_hand < 0 OR b.inventory_value < 0 OR (b.on_hand = 0 AND b.inventory_value <> 0)
     UNION ALL
     SELECT b.item_id::text, 'on hand ' || b.on_hand || ' ≠ lots ' || COALESCE(l.q, 0)
       FROM cl.inventory_balances b JOIN cl.inventory_items i ON i.id = b.item_id
       LEFT JOIN (SELECT item_id, sum(qty_remaining) AS q FROM cl.inventory_lots GROUP BY item_id) l
         ON l.item_id = b.item_id
      WHERE (i.track_lots AND b.on_hand <> COALESCE(l.q, 0)) OR (NOT i.track_lots AND COALESCE(l.q, 0) <> 0)
     UNION ALL
     SELECT mv.item_id::text, 'consumption ' || mv.id || ' has no equal line cost'
       FROM cl.stock_movements mv LEFT JOIN cl.order_line_costs c ON c.movement_id = mv.id
      WHERE mv.movement_type = 'consumption' AND (c.id IS NULL OR c.value <> -mv.value_delta)
     ORDER BY 1, 2`,
  );
  return rows.map((r) => ({ itemId: r.item_id, problem: r.problem }));
}

/** Raises a critical `balance_mismatch` alert per item that fails the check. */
export async function raiseMismatchAlerts(tx: Tx): Promise<StockMismatch[]> {
  const mismatches = await findStockMismatches(tx);
  const byItem = new Map<string, string[]>();
  for (const m of mismatches) byItem.set(m.itemId, [...(byItem.get(m.itemId) ?? []), m.problem]);
  for (const [itemId, problems] of byItem)
    await openAlert(tx, itemId, 'balance_mismatch', { problems });
  return mismatches;
}

/**
 * Reservations open longer than 12 hours (ORDER_STATE_MACHINE.md §5, INV-016): one
 * `stale_reservation` alert per ingredient, listing the lines, for a manager to pick up
 * or cancel. Reservations never expire by themselves; the alert resolves when none is left.
 */
export async function raiseStaleReservationAlerts(tx: Tx, now: Date, hours = 12): Promise<number> {
  const { rows } = await tx.query<{ item_id: string; lines: string[] }>(
    `SELECT item_id::text, array_agg(DISTINCT order_line_id::text) AS lines
       FROM cl.stock_reservations
      WHERE status = 'active' AND created_at < $1::timestamptz - make_interval(hours => $2)
      GROUP BY item_id ORDER BY stock_reservations.item_id`,
    [now, hours],
  );
  for (const r of rows)
    await openAlert(tx, r.item_id, 'stale_reservation', { orderLineIds: r.lines });
  await tx.query(
    `UPDATE cl.inventory_alerts a SET state = 'resolved', resolved_at = now()
      WHERE a.kind = 'stale_reservation' AND a.state <> 'resolved'
        AND NOT EXISTS (SELECT 1 FROM cl.stock_reservations r
                         WHERE r.item_id = a.item_id AND r.status = 'active'
                           AND r.created_at < $1::timestamptz - make_interval(hours => $2))`,
    [now, hours],
  );
  return rows.length;
}

// ---------------------------------------------------------------- expiry

/**
 * The expiry scan (RECIPE_INVENTORY.md §10; nightly at 04:05, after the business-day
 * cutoff): one `expired` alert per lot past its expiry that still holds stock, one
 * `near_expiry` alert per lot within the item's near-expiry days; alerts whose condition
 * cleared are resolved. Menus are told to refetch for items with lots that just expired,
 * since those lots stop counting as available (AT-13).
 */
export async function scanExpiry(
  tx: Tx,
  asOf: string,
): Promise<{ expired: number; nearExpiry: number }> {
  const { rows } = await tx.query<{
    lot_id: string;
    item_id: string;
    expiry_date: string;
    qty: string;
    state: 'expired' | 'near_expiry';
  }>(
    `SELECT l.id::text AS lot_id, l.item_id::text, l.expiry_date::text, l.qty_remaining::text AS qty,
            CASE WHEN l.expiry_date < $1::date THEN 'expired' ELSE 'near_expiry' END AS state
       FROM cl.inventory_lots l JOIN cl.inventory_items i ON i.id = l.item_id AND i.track_lots
      WHERE l.qty_remaining > 0 AND l.expiry_date IS NOT NULL
        AND (l.expiry_date < $1::date
             OR (i.near_expiry_days IS NOT NULL AND l.expiry_date <= $1::date + i.near_expiry_days))
      ORDER BY l.item_id, l.id`,
    [asOf],
  );
  // Clear what no longer applies: near expiry that is now expired or empty, expired that is empty.
  await tx.query(
    `UPDATE cl.inventory_alerts a SET state = 'resolved', resolved_at = now()
      WHERE a.kind IN ('near_expiry','expired') AND a.state <> 'resolved' AND a.lot_id IS NOT NULL
        AND NOT (a.detail ? 'usedBy')
        AND NOT (a.lot_id::text, a.kind) IN (SELECT x, y FROM unnest($1::text[], $2::text[]) AS t(x, y))`,
    [rows.map((r) => r.lot_id), rows.map((r) => r.state)],
  );
  const newlyExpired = new Set<string>();
  for (const r of rows) {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM cl.inventory_alerts
        WHERE lot_id = $1 AND kind = $2 AND state <> 'resolved' AND NOT (detail ? 'usedBy')`,
      [r.lot_id, r.state],
    );
    if (rowCount) continue;
    await openAlert(tx, r.item_id, r.state, { expiryDate: r.expiry_date, qty: r.qty }, r.lot_id);
    if (r.state === 'expired') newlyExpired.add(r.item_id);
  }
  await announce(tx, newlyExpired);
  return {
    expired: rows.filter((r) => r.state === 'expired').length,
    nearExpiry: rows.filter((r) => r.state === 'near_expiry').length,
  };
}
