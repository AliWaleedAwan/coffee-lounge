/**
 * Purchase receipts (RECIPE_INVENTORY.md §7, COST_VALUATION.md §3, DATABASE.md §5). A
 * receipt is posted in one transaction: draft row, lines, stock in (balances locked once,
 * ascending item id), then the gapless `GRN-YYYY-NNNNN` number last (DATABASE.md §14).
 * A posted receipt is never edited; a wrong one is reversed as a whole while its stock is
 * still available, and a new one posted. Payment is recorded for Phase 5's ledger (P4-2).
 */
import {
  Decimal,
  convertQty,
  money,
  packsToBase,
  qty,
  unitCost,
  unitCostOf,
  UNITS,
  UnitConversionError,
  type BaseUnit,
  type UnitCode,
} from '@cl/shared';
import type pg from 'pg';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { looksLikeCardNumber } from '../billing/index.ts';
import type { CommandContext, StaffAuth } from '../orders/index.ts';
import { receiveStock, reverseReceiptStock } from '../stock/index.ts';

export const PAYMENT_CHANNELS = ['cash', 'card', 'transfer'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

export interface ReceiptLineInput {
  itemId: string;
  /** A pack of the item and how many of them (up to 3 dp)… */
  packSizeId?: string | undefined;
  packQty?: string | undefined;
  /** …or a loose quantity in any unit of the item's dimension. */
  qty?: string | undefined;
  uom?: UnitCode | undefined;
  /** Total paid for the line, PKR. */
  lineCost: string;
  lotCode?: string | undefined;
  /** YYYY-MM-DD; required for expiry-tracked items. */
  expiryDate?: string | undefined;
}

export interface ReceiptInput {
  supplierId?: string | undefined;
  supplierInvoiceRef?: string | undefined;
  note?: string | undefined;
  paidNow: boolean;
  paymentChannel?: PaymentChannel | undefined;
  paymentReference?: string | undefined;
  /** Items with no opening count whose shelf was empty: stock control starts here (D-29). */
  startStockControl?: readonly string[] | undefined;
  lines: readonly ReceiptLineInput[];
}

export interface PostedLine {
  lineId: string;
  itemId: string;
  name: string;
  baseUom: BaseUnit;
  packName: string | null;
  packQty: string | null;
  qtyBase: string;
  lineCost: string;
  unitCost: string;
  onHandAfter: string;
}

export interface PostedReceipt {
  receiptId: string;
  receiptNo: string;
  businessDate: string;
  totalCost: string;
  lines: PostedLine[];
}

interface ItemFacts {
  id: string;
  name: string;
  base_uom: BaseUnit;
  track_lots: boolean;
  track_expiry: boolean;
  archived: boolean;
}

interface PackFacts {
  id: string;
  item_id: string;
  name: string;
  qty_base: string;
  is_active: boolean;
}

/** What a line brings in, in base units, from its packs or its loose quantity. */
function baseQuantity(
  line: ReceiptLineInput,
  item: ItemFacts,
  pack: PackFacts | undefined,
): { qtyBase: Decimal; packQty: string | null } {
  if (line.packSizeId !== undefined) {
    if (!pack || pack.item_id !== item.id) {
      throw new AppError('VALIDATION_FAILED', `That pack is not one of ${item.name}'s`);
    }
    if (!pack.is_active) {
      throw new AppError('VALIDATION_FAILED', `${pack.name} of ${item.name} is no longer used`);
    }
    const packs = new Decimal(line.packQty ?? '0');
    return { qtyBase: packsToBase(packs, new Decimal(pack.qty_base)), packQty: packs.toFixed(3) };
  }
  const uom = line.uom ?? item.base_uom;
  try {
    return { qtyBase: convertQty(new Decimal(line.qty ?? '0'), uom, item.base_uom), packQty: null };
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
}

export async function postReceipt(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  input: ReceiptInput,
): Promise<PostedReceipt> {
  if (input.lines.length === 0) throw new AppError('VALIDATION_FAILED', 'Add at least one line');
  if (input.paidNow !== (input.paymentChannel !== undefined)) {
    throw new AppError('VALIDATION_FAILED', 'Paid now needs a payment channel, and only then');
  }
  if (input.paymentReference && looksLikeCardNumber(input.paymentReference)) {
    throw new AppError(
      'CARD_NUMBER_NOT_ALLOWED',
      'That looks like a card number. Enter the approval or transfer reference instead',
    );
  }
  const start = new Set(input.startStockControl ?? []);
  if (start.size > 0 && !auth.permissions.has('inventory.stock_control_activate')) {
    throw new AppError(
      'FORBIDDEN',
      'Starting stock control needs inventory.stock_control_activate',
    );
  }
  const businessDate = await businessDateOf(tx, ctx.now);

  const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
  const { rows: itemRows } = await tx.query<ItemFacts>(
    `SELECT id::text, name, base_uom, track_lots, track_expiry, archived_at IS NOT NULL AS archived
       FROM cl.inventory_items WHERE id = ANY($1::bigint[])`,
    [itemIds],
  );
  const items = new Map(itemRows.map((i) => [i.id, i]));
  const packIds = input.lines.flatMap((l) => (l.packSizeId ? [l.packSizeId] : []));
  const { rows: packRows } = await tx.query<PackFacts>(
    `SELECT id::text, item_id::text, name, qty_base::text, is_active
       FROM cl.item_pack_sizes WHERE id = ANY($1::bigint[])`,
    [packIds],
  );
  const packs = new Map(packRows.map((p) => [p.id, p]));
  if (input.supplierId !== undefined) {
    const { rows } = await tx.query<{ is_active: boolean }>(
      'SELECT is_active FROM cl.suppliers WHERE id = $1',
      [input.supplierId],
    );
    if (!rows[0]?.is_active) throw new AppError('VALIDATION_FAILED', 'That supplier is not active');
  }

  const prepared = input.lines.map((line) => {
    const item = items.get(line.itemId);
    if (!item) throw new AppError('VALIDATION_FAILED', `Item ${line.itemId} does not exist`);
    if (item.archived) throw new AppError('VALIDATION_FAILED', `${item.name} is archived`);
    const pack = line.packSizeId ? packs.get(line.packSizeId) : undefined;
    const { qtyBase, packQty } = baseQuantity(line, item, pack);
    if (qtyBase.lessThanOrEqualTo(0)) {
      throw new AppError('VALIDATION_FAILED', `Enter how much ${item.name} arrived`);
    }
    const lineCost = money.parse(line.lineCost);
    if (lineCost.isNegative()) throw new AppError('VALIDATION_FAILED', 'A cost cannot be negative');
    const lotCode = line.lotCode?.trim() ? line.lotCode.trim() : null;
    if (lotCode !== null && !item.track_lots) {
      throw new AppError('VALIDATION_FAILED', `${item.name} does not track lots`);
    }
    if (line.expiryDate !== undefined && !item.track_expiry) {
      throw new AppError('VALIDATION_FAILED', `${item.name} does not track expiry dates`);
    }
    if (item.track_expiry && line.expiryDate === undefined) {
      throw new AppError('VALIDATION_FAILED', `Enter the expiry date of ${item.name}`);
    }
    if (line.expiryDate !== undefined && line.expiryDate < businessDate) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${item.name} expired on ${line.expiryDate}: do not receive expired stock`,
      );
    }
    return {
      line,
      item,
      pack,
      qtyBase,
      packQty,
      lineCost,
      lotCode,
      unitCost: unitCostOf(lineCost, qtyBase),
    };
  });
  for (const id of start) {
    if (!items.has(id))
      throw new AppError('VALIDATION_FAILED', 'Start stock control only for items on this receipt');
  }

  const { rows: created } = await tx.query<{ id: string }>(
    `INSERT INTO cl.purchase_receipts (supplier_id, supplier_invoice_ref, note, received_at, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
    [
      input.supplierId ?? null,
      input.supplierInvoiceRef?.trim() || null,
      input.note?.trim() || null,
      ctx.now,
      auth.user.id,
    ],
  );
  const receiptId = created[0]?.id ?? '';
  const lineIds: string[] = [];
  for (const p of prepared) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cl.purchase_receipt_lines
         (receipt_id, item_id, pack_size_id, pack_qty, qty_base, line_cost, unit_cost_base, lot_code, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id::text`,
      [
        receiptId,
        p.item.id,
        p.pack?.id ?? null,
        p.packQty,
        qty.format(p.qtyBase),
        money.format(p.lineCost),
        unitCost.format(p.unitCost),
        p.lotCode,
        p.line.expiryDate ?? null,
      ],
    );
    lineIds.push(rows[0]?.id ?? '');
  }

  await receiveStock(
    tx,
    { actorUserId: auth.user.id, businessDate },
    prepared.map((p, i) => ({
      itemId: p.item.id,
      qty: p.qtyBase,
      lineCost: p.lineCost,
      sourceId: lineIds[i] ?? '',
      lotCode: p.lotCode,
      expiryDate: p.line.expiryDate ?? null,
    })),
    start,
  );
  const { rows: after } = await tx.query<{ item_id: string; on_hand: string }>(
    'SELECT item_id::text, on_hand::text FROM cl.inventory_balances WHERE item_id = ANY($1::bigint[])',
    [itemIds],
  );
  const onHand = new Map(after.map((r) => [r.item_id, r.on_hand]));

  const total = prepared.reduce((sum, p) => sum.plus(p.lineCost), new Decimal(0));
  const year = businessDate.slice(0, 4);
  const receiptNo = `GRN-${year}-${(await tx.nextNumber('purchase_receipt', year)).padStart(5, '0')}`;
  await tx.query(
    `UPDATE cl.purchase_receipts
        SET status = 'posted', receipt_no = $2, business_date = $3, total_cost = $4, paid_now = $5,
            payment_channel = $6, payment_reference = $7, posted_by = $8, posted_at = now()
      WHERE id = $1`,
    [
      receiptId,
      receiptNo,
      businessDate,
      money.format(total),
      input.paidNow,
      input.paymentChannel ?? null,
      input.paymentReference?.trim() || null,
      auth.user.id,
    ],
  );
  await writeAudit(
    tx,
    {
      actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
      correlationId: ctx.correlationId,
      ...(ctx.ip ? { ip: ctx.ip } : {}),
    },
    {
      action: 'purchase.receipt.post',
      entityType: 'purchase_receipt',
      entityId: receiptId,
      after: {
        receiptNo,
        total: money.format(total),
        lines: prepared.length,
        startStockControl: [...start],
      },
    },
  );
  await publish(tx, {
    type: 'receipt.changed',
    entityType: 'purchase_receipt',
    entityId: receiptId,
    topics: ['inventory'],
  });
  return {
    receiptId,
    receiptNo,
    businessDate,
    totalCost: money.format(total),
    lines: prepared.map((p, i) => ({
      lineId: lineIds[i] ?? '',
      itemId: p.item.id,
      name: p.item.name,
      baseUom: p.item.base_uom,
      packName: p.pack?.name ?? null,
      packQty: p.packQty,
      qtyBase: qty.format(p.qtyBase),
      lineCost: money.format(p.lineCost),
      unitCost: unitCost.format(p.unitCost),
      onHandAfter: onHand.get(p.item.id) ?? '0.0000',
    })),
  };
}

/** Reverses a whole posted receipt; refused unless its stock is still available. */
export async function reverseReceipt(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  receiptId: string,
  reason: string,
): Promise<{ receiptId: string; receiptNo: string; status: 'reversed' }> {
  const { rows } = await tx.query<{ status: string; receipt_no: string | null }>(
    'SELECT status, receipt_no FROM cl.purchase_receipts WHERE id = $1 FOR UPDATE',
    [receiptId],
  );
  const receipt = rows[0];
  if (!receipt) throw new AppError('NOT_FOUND', 'Receipt not found');
  if (receipt.status !== 'posted' || receipt.receipt_no === null) {
    throw new AppError('STALE_STATE', `This receipt is ${receipt.status}`);
  }
  const { rowCount: returned } = await tx.query(
    `SELECT 1 FROM cl.purchase_receipt_lines l
      WHERE l.receipt_id = $1
        AND (EXISTS (SELECT 1 FROM cl.supplier_returns r WHERE r.receipt_line_id = l.id)
             OR EXISTS (SELECT 1 FROM cl.cost_adjustments a WHERE a.receipt_line_id = l.id))
      LIMIT 1`,
    [receiptId],
  );
  if (returned) {
    throw new AppError(
      'VALIDATION_FAILED',
      'This receipt has returns or cost corrections. Return or waste the rest instead.',
    );
  }
  const { rows: lines } = await tx.query<{
    id: string;
    item_id: string;
    qty_base: string;
    line_cost: string;
    movement_id: string;
  }>(
    `SELECT l.id::text, l.item_id::text, l.qty_base::text, l.line_cost::text, m.id::text AS movement_id
       FROM cl.purchase_receipt_lines l
       JOIN cl.stock_movements m ON m.source_key = 'receipt:line:' || l.id::text
      WHERE l.receipt_id = $1 ORDER BY l.id`,
    [receiptId],
  );
  const businessDate = await businessDateOf(tx, ctx.now);
  await reverseReceiptStock(
    tx,
    { actorUserId: auth.user.id, businessDate },
    lines.map((l) => ({
      itemId: l.item_id,
      qty: new Decimal(l.qty_base),
      lineCost: new Decimal(l.line_cost),
      sourceId: l.id,
      movementId: l.movement_id,
    })),
  );
  await tx.query(
    `UPDATE cl.purchase_receipts
        SET status = 'reversed', reversed_by = $2, reversed_at = now(), reversal_reason = $3
      WHERE id = $1`,
    [receiptId, auth.user.id, reason],
  );
  await writeAudit(
    tx,
    {
      actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
      correlationId: ctx.correlationId,
      ...(ctx.ip ? { ip: ctx.ip } : {}),
    },
    {
      action: 'purchase.receipt.reverse',
      entityType: 'purchase_receipt',
      entityId: receiptId,
      reason,
      after: { receiptNo: receipt.receipt_no },
    },
  );
  await publish(tx, {
    type: 'receipt.changed',
    entityType: 'purchase_receipt',
    entityId: receiptId,
    topics: ['inventory'],
  });
  return { receiptId, receiptNo: receipt.receipt_no, status: 'reversed' };
}

// ------------------------------------------------------------------ reading

export interface ReceiptSummary {
  id: string;
  receiptNo: string;
  status: 'posted' | 'reversed';
  businessDate: string;
  postedAt: string;
  supplierName: string | null;
  supplierInvoiceRef: string | null;
  totalCost: string;
  lineCount: number;
  paidNow: boolean;
  paymentChannel: PaymentChannel | null;
  postedBy: string;
}

const SUMMARY = `
  SELECT r.id::text, r.receipt_no AS "receiptNo", r.status, r.business_date::text AS "businessDate",
         r.posted_at AS "postedAt", s.name AS "supplierName", r.supplier_invoice_ref AS "supplierInvoiceRef",
         r.total_cost::text AS "totalCost",
         (SELECT count(*)::int FROM cl.purchase_receipt_lines l WHERE l.receipt_id = r.id) AS "lineCount",
         r.paid_now AS "paidNow", r.payment_channel AS "paymentChannel", u.display_name AS "postedBy"
    FROM cl.purchase_receipts r
    LEFT JOIN cl.suppliers s ON s.id = r.supplier_id
    JOIN cl.users u ON u.id = r.posted_by`;

/** Posted and reversed receipts, newest first (the last 100, or one business day). */
export async function listReceipts(
  db: Queryable,
  filter: { date?: string | undefined; supplierId?: string | undefined },
): Promise<ReceiptSummary[]> {
  const { rows } = await db.query<ReceiptSummary>(
    `${SUMMARY}
     WHERE r.status <> 'draft' AND ($1::date IS NULL OR r.business_date = $1)
       AND ($2::bigint IS NULL OR r.supplier_id = $2)
     ORDER BY r.posted_at DESC, r.id DESC LIMIT 100`,
    [filter.date ?? null, filter.supplierId ?? null],
  );
  return rows;
}

export async function readReceipt(
  db: pg.Pool,
  id: string,
): Promise<
  ReceiptSummary & {
    paymentReference: string | null;
    note: string | null;
    reversedAt: string | null;
    reversalReason: string | null;
    lines: ReceiptLineDetail[];
    returns: SupplierReturn[];
  }
> {
  const { rows } = await db.query<
    ReceiptSummary & {
      paymentReference: string | null;
      note: string | null;
      reversedAt: string | null;
      reversalReason: string | null;
    }
  >(
    `${SUMMARY.replace(
      'r.paid_now AS "paidNow"',
      `r.payment_reference AS "paymentReference", r.note, r.reversed_at AS "reversedAt",
       r.reversal_reason AS "reversalReason", r.paid_now AS "paidNow"`,
    )}
     WHERE r.id = $1 AND r.status <> 'draft'`,
    [id],
  );
  const receipt = rows[0];
  if (!receipt) throw new AppError('NOT_FOUND', 'Receipt not found');
  const { rows: lines } = await db.query<ReceiptLineDetail>(
    `SELECT l.id::text AS "lineId", l.item_id::text AS "itemId", i.name, i.base_uom AS "baseUom",
            p.name AS "packName", l.pack_qty::text AS "packQty", l.qty_base::text AS "qtyBase",
            l.line_cost::text AS "lineCost", l.unit_cost_base::text AS "unitCost",
            l.lot_code AS "lotCode", l.expiry_date::text AS "expiryDate",
            COALESCE((SELECT sum(r.qty_base) FROM cl.supplier_returns r WHERE r.receipt_line_id = l.id), 0)::numeric(18,4)::text
              AS "returnedQty",
            (l.line_cost + COALESCE((SELECT sum(a.amount) FROM cl.cost_adjustments a
                                       WHERE a.receipt_line_id = l.id), 0))::numeric(14,2)::text
              AS "lineCostNow"
       FROM cl.purchase_receipt_lines l
       JOIN cl.inventory_items i ON i.id = l.item_id
       LEFT JOIN cl.item_pack_sizes p ON p.id = l.pack_size_id
      WHERE l.receipt_id = $1 ORDER BY l.id`,
    [id],
  );
  const { rows: returns } = await db.query<SupplierReturn>(
    `SELECT r.id::text, r.receipt_line_id::text AS "lineId", i.name, i.base_uom AS "baseUom",
            r.qty_base::text AS "qtyBase", r.value::text AS value, r.reason,
            r.refund_amount::text AS "refundAmount", r.refund_channel AS "refundChannel",
            r.refund_reference AS "refundReference", u.display_name AS "returnedBy",
            r.business_date::text AS "businessDate"
       FROM cl.supplier_returns r
       JOIN cl.purchase_receipt_lines l ON l.id = r.receipt_line_id
       JOIN cl.inventory_items i ON i.id = r.item_id
       JOIN cl.users u ON u.id = r.returned_by
      WHERE l.receipt_id = $1 ORDER BY r.id`,
    [id],
  );
  return { ...receipt, lines, returns };
}

export type ReceiptLineDetail = Omit<PostedLine, 'onHandAfter'> & {
  lotCode: string | null;
  expiryDate: string | null;
  /** How much of the line went back to the supplier. */
  returnedQty: string;
  /** The line cost after supplier price corrections; null without cost rights. */
  lineCostNow: string | null;
};

export interface SupplierReturn {
  id: string;
  lineId: string;
  name: string;
  baseUom: BaseUnit;
  qtyBase: string;
  /** Stock value out at the average; null for readers without cost rights. */
  value: string | null;
  reason: string;
  refundAmount: string | null;
  refundChannel: PaymentChannel | null;
  refundReference: string | null;
  returnedBy: string;
  businessDate: string;
}
