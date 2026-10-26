/**
 * Supplier price corrections on a posted receipt line (COST_VALUATION.md §6; AT-68). The
 * owner enters what the line really cost; the difference from what is on record (the
 * line cost plus earlier corrections) is split between stock still on hand and purchase
 * price variance today. Needs `inventory.cost_adjust` (owner only, RBAC.md).
 */
import { Decimal, money } from '@cl/shared';
import { writeAudit } from '../../platform/audit.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf } from '../../platform/settings.ts';
import type { CommandContext, StaffAuth } from '../orders/index.ts';
import { adjustCost } from '../stock/index.ts';

export async function correctLineCost(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  receiptId: string,
  input: { lineId: string; correctLineCost: string; reason: string },
): Promise<{ delta: string; toInventory: string; toVariance: string; lineCostNow: string }> {
  const { rows: receipts } = await tx.query<{ status: string }>(
    'SELECT status FROM cl.purchase_receipts WHERE id = $1 FOR UPDATE',
    [receiptId],
  );
  const receipt = receipts[0];
  if (!receipt) throw new AppError('NOT_FOUND', 'Receipt not found');
  if (receipt.status !== 'posted') {
    throw new AppError('STALE_STATE', `This receipt is ${receipt.status}`);
  }
  const { rows } = await tx.query<{ item_id: string; qty_base: string; on_record: string }>(
    `SELECT l.item_id::text, l.qty_base::text,
            (l.line_cost + COALESCE((SELECT sum(a.amount) FROM cl.cost_adjustments a
                                       WHERE a.receipt_line_id = l.id), 0))::text AS on_record
       FROM cl.purchase_receipt_lines l WHERE l.id = $1 AND l.receipt_id = $2`,
    [input.lineId, receiptId],
  );
  const line = rows[0];
  if (!line) throw new AppError('NOT_FOUND', 'That line is not on this receipt');
  const correct = money.parse(input.correctLineCost);
  const delta = correct.minus(line.on_record);
  if (delta.isZero()) {
    throw new AppError('VALIDATION_FAILED', `That line already costs ${money.format(correct)}`);
  }
  const reason = input.reason.trim();
  const businessDate = await businessDateOf(tx, ctx.now);
  const { toInventory, toVariance, movementId } = await adjustCost(
    tx,
    { actorUserId: auth.user.id, businessDate },
    {
      itemId: line.item_id,
      receiptLineId: input.lineId,
      qtyReceived: new Decimal(line.qty_base),
      delta,
      key: ctx.key,
      note: reason,
    },
  );
  await tx.query(
    `INSERT INTO cl.cost_adjustments (item_id, receipt_line_id, amount, to_inventory, to_variance,
       reason, movement_id, actor_user_id, business_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      line.item_id,
      input.lineId,
      money.format(delta),
      toInventory.toFixed(4),
      toVariance.toFixed(4),
      reason,
      movementId,
      auth.user.id,
      businessDate,
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
      action: 'purchase.receipt.cost_correction',
      entityType: 'purchase_receipt',
      entityId: receiptId,
      reason,
      before: { lineId: input.lineId, lineCost: line.on_record },
      after: {
        lineCost: money.format(correct),
        toInventory: toInventory.toFixed(4),
        toVariance: toVariance.toFixed(4),
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
    delta: money.format(delta),
    toInventory: toInventory.toFixed(4),
    toVariance: toVariance.toFixed(4),
    lineCostNow: money.format(correct),
  };
}
