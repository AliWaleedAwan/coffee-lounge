/**
 * Supplier returns (RECIPE_INVENTORY.md §11, AT-110): unused stock back to the supplier
 * against the receipt line it came on, at the current average. Never more than the line
 * brought in; the receipt's row lock serialises returns of one receipt and its reversal.
 * A refund, if any, is recorded with channel and reference for Phase 5's ledger (P4-2).
 */
import { convertQty, Decimal, money, UnitConversionError, UNITS, type UnitCode } from '@cl/shared';
import { writeAudit } from '../../platform/audit.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { looksLikeCardNumber } from '../billing/index.ts';
import type { CommandContext, StaffAuth } from '../orders/index.ts';
import { returnStock } from '../stock/index.ts';
import type { PaymentChannel } from './receipts.ts';

export interface ReturnInput {
  lineId: string;
  qty: string;
  uom?: UnitCode | undefined;
  reason: string;
  refundAmount?: string | undefined;
  refundChannel?: PaymentChannel | undefined;
  refundReference?: string | undefined;
}

export async function returnToSupplier(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  receiptId: string,
  input: ReturnInput,
): Promise<{ returnId: string; qtyBase: string; value: string; returnedSoFar: string }> {
  if ((input.refundAmount === undefined) !== (input.refundChannel === undefined)) {
    throw new AppError('VALIDATION_FAILED', 'A refund needs both its amount and how it was paid');
  }
  if (input.refundReference && input.refundAmount === undefined) {
    throw new AppError('VALIDATION_FAILED', 'A reference belongs to a refund');
  }
  if (input.refundReference && looksLikeCardNumber(input.refundReference)) {
    throw new AppError(
      'CARD_NUMBER_NOT_ALLOWED',
      'That looks like a card number. Enter the approval or transfer reference instead',
    );
  }
  const { rows: receipts } = await tx.query<{ status: string; receipt_no: string | null }>(
    'SELECT status, receipt_no FROM cl.purchase_receipts WHERE id = $1 FOR UPDATE',
    [receiptId],
  );
  const receipt = receipts[0];
  if (!receipt) throw new AppError('NOT_FOUND', 'Receipt not found');
  if (receipt.status !== 'posted') {
    throw new AppError('STALE_STATE', `This receipt is ${receipt.status}`);
  }
  const { rows: lines } = await tx.query<{
    item_id: string;
    name: string;
    base_uom: 'g' | 'ml' | 'pcs';
    qty_base: string;
    returned: string;
  }>(
    `SELECT l.item_id::text, i.name, i.base_uom, l.qty_base::text,
            COALESCE((SELECT sum(r.qty_base) FROM cl.supplier_returns r WHERE r.receipt_line_id = l.id), 0)::text
              AS returned
       FROM cl.purchase_receipt_lines l JOIN cl.inventory_items i ON i.id = l.item_id
      WHERE l.id = $1 AND l.receipt_id = $2`,
    [input.lineId, receiptId],
  );
  const line = lines[0];
  if (!line) throw new AppError('NOT_FOUND', 'That line is not on this receipt');
  const uom = input.uom ?? line.base_uom;
  let q: Decimal;
  try {
    q = convertQty(new Decimal(input.qty), uom, line.base_uom);
  } catch (error) {
    if (error instanceof UnitConversionError) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${line.name} is kept in ${line.base_uom} (${UNITS[line.base_uom].dimension}); ` +
          `${uom} (${UNITS[uom].dimension}) cannot be converted`,
      );
    }
    throw error;
  }
  const left = new Decimal(line.qty_base).minus(line.returned);
  if (q.greaterThan(left)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `This line has ${left.toString()} ${line.base_uom} of ${line.name} left to return`,
    );
  }
  const businessDate = await businessDateOf(tx, ctx.now);
  const reason = input.reason.trim();
  const { movementId, value, lotId } = await returnStock(
    tx,
    { actorUserId: auth.user.id, businessDate },
    { itemId: line.item_id, qty: q, receiptLineId: input.lineId, key: ctx.key, note: reason },
  );
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.supplier_returns (receipt_line_id, item_id, lot_id, qty_base, value, reason,
       refund_amount, refund_channel, refund_reference, movement_id, returned_by, business_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id::text`,
    [
      input.lineId,
      line.item_id,
      lotId,
      q.toFixed(4),
      value.toFixed(4),
      reason,
      input.refundAmount === undefined ? null : money.format(new Decimal(input.refundAmount)),
      input.refundChannel ?? null,
      input.refundReference?.trim() || null,
      movementId,
      auth.user.id,
      businessDate,
    ],
  );
  const returnId = rows[0]?.id ?? '';
  await writeAudit(
    tx,
    {
      actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
      correlationId: ctx.correlationId,
      ...(ctx.ip ? { ip: ctx.ip } : {}),
    },
    {
      action: 'purchase.receipt.return',
      entityType: 'purchase_receipt',
      entityId: receiptId,
      reason,
      after: {
        returnId,
        lineId: input.lineId,
        qty: q.toFixed(4),
        value: value.toFixed(4),
        refund: input.refundAmount ?? null,
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
    returnId,
    qtyBase: q.toFixed(4),
    value: value.toFixed(4),
    returnedSoFar: new Decimal(line.returned).plus(q).toFixed(4),
  };
}
