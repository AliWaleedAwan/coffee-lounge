/**
 * Takeaway pay-first (ORDER_STATE_MACHINE.md §8.5, D-40). A guest orders with the counter
 * QR and pays at the counter; the cashier takes the money, then presses **Accept & pay**:
 *
 *   R3 accept (price lock, stock reserved, kitchen ticket) → I2 lock → P1 payments → I4
 *   settle (invoice number, receipt)
 *
 * in one transaction. If anything fails (an ingredient just ran out, the total is not what
 * the cashier was paid) nothing is saved: no reservation, no ticket, no payment (AT-52).
 * The request's Idempotency-Key makes a retry replay the first answer, so the ticket and
 * the receipt print once (AT-51).
 */
import { Decimal, money } from '@cl/shared';
import { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { readSetting } from '../../platform/settings.ts';
import type { SessionRow } from '../floor/index.ts';
import { acceptRound, type CommandContext, type StaffAuth } from '../orders/index.ts';
import { describe, lockBill, type InvoiceRow, type LockResult } from './invoices.ts';
import { recordPayments, settle, type PaymentInput } from './payments.ts';

export interface AcceptAndPayResult {
  roundId: string;
  roundRef: string;
  invoiceId: string;
  invoiceNo: string | null;
  total: string;
  change: string | null;
  receiptQueued: boolean;
}

export async function acceptAndPay(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  roundId: string,
  payments: readonly PaymentInput[],
): Promise<AcceptAndPayResult> {
  for (const permission of ['orders.accept', 'invoices.lock']) {
    if (!auth.permissions.has(permission)) {
      throw new AppError('FORBIDDEN', `You need the ${permission} permission for this`);
    }
  }
  const { rows: found } = await tx.query<{ order_type: string; invoice_id: string }>(
    `SELECT s.order_type, i.id::text AS invoice_id FROM cl.order_rounds r
       JOIN cl.dining_sessions s ON s.id = r.session_id JOIN cl.invoices i ON i.session_id = s.id
      WHERE r.id = $1`,
    [roundId],
  );
  const where = found[0];
  if (!where) throw new AppError('NOT_FOUND', 'Order not found');
  if (where.order_type !== 'takeaway') {
    throw new AppError('VALIDATION_FAILED', 'Accept & pay is for takeaway orders');
  }

  // Filled in by the hook, inside acceptance.
  const state: { lock: LockResult | null; change: string | null; paidInFull: boolean } = {
    lock: null,
    change: null,
    paidInFull: false,
  };
  const accepted = await acceptRound(tx, ctx, auth, roundId, {
    beforeTicket: async () => {
      const lock = await lockBill(tx, ctx, auth, where.invoice_id, async (locked) => {
        await settle(tx, ctx, auth, locked);
      });
      state.lock = lock;
      if (lock.settledNow) {
        if (payments.length > 0) {
          throw new AppError('BILL_CHANGED', 'This order costs nothing: take no payment', {
            total: lock.total,
          });
        }
        return;
      }
      const paid = payments.reduce((s, p) => s.plus(money.parse(p.amount)), new Decimal(0));
      if (!paid.eq(lock.total)) {
        throw new AppError(
          'BILL_CHANGED',
          `The total is Rs ${lock.total}, not Rs ${money.format(paid)}. No payment was recorded: check the order and take the right amount.`,
          { total: lock.total },
        );
      }
      const result = await recordPayments(
        tx,
        ctx,
        auth,
        await lockedBill(tx, lock.invoiceId),
        payments,
        false,
      );
      state.change = result.change;
      state.paidInFull = result.due === '0.00';
    },
  });
  const done = state.lock;
  if (!done) throw new Error('accept & pay: the bill was not locked');
  // I4 last: the invoice number is taken after the kitchen ticket's.
  const settled = state.paidInFull
    ? await settle(tx, ctx, auth, await lockedBill(tx, done.invoiceId))
    : null;
  return {
    roundId,
    roundRef: accepted.roundRef,
    invoiceId: done.invoiceId,
    invoiceNo: settled?.invoiceNo ?? (await invoiceNo(tx, done.invoiceId)),
    total: done.total,
    change: state.change,
    receiptQueued: settled?.receiptQueued ?? false,
  };
}

/** The bill and session this transaction has just locked, read again after the lock. */
async function lockedBill(
  tx: Tx,
  invoiceId: string,
): Promise<{ session: SessionRow; invoice: InvoiceRow }> {
  const { rows: invoices } = await tx.query<InvoiceRow>(
    `SELECT id::text, session_id::text, invoice_no, status, lock_version, subtotal::text, discount_total::text,
            rounding_adjustment::text, total::text, paid_total::text, business_date
       FROM cl.invoices WHERE id = $1`,
    [invoiceId],
  );
  const invoice = invoices[0];
  if (!invoice) throw new Error(`invoice ${invoiceId} vanished`);
  const { rows: sessions } = await tx.query<SessionRow>(
    `SELECT id::text, session_no, order_type, table_id::text, status, guest_count, opened_at
       FROM cl.dining_sessions WHERE id = $1`,
    [invoice.session_id],
  );
  const session = sessions[0];
  if (!session) throw new Error(`session ${invoice.session_id} vanished`);
  return { session, invoice };
}

async function invoiceNo(tx: Tx, invoiceId: string): Promise<string | null> {
  const { rows } = await tx.query<{ invoice_no: string | null }>(
    'SELECT invoice_no FROM cl.invoices WHERE id = $1',
    [invoiceId],
  );
  return rows[0]?.invoice_no ?? null;
}

/**
 * The counter's takeaway queue: counter-QR orders waiting to be paid and accepted, oldest
 * first, each with when it cancels itself (D-40).
 */
export async function takeawayQueue(db: Queryable) {
  const minutes = await readSetting(
    db,
    'orders.takeaway_unpaid_expiry_minutes',
    z.number().positive(),
  );
  const { rows } = await db.query<{
    id: string;
    round_ref: string;
    session_id: string;
    session_no: string;
    customer_name: string | null;
    submitted_at: Date;
    quoted_total: string;
  }>(
    `SELECT r.id::text, r.round_ref, s.id::text AS session_id, s.session_no, s.customer_name, r.submitted_at,
            r.quoted_total::text
       FROM cl.order_rounds r JOIN cl.dining_sessions s ON s.id = r.session_id
      WHERE r.status = 'pending_approval' AND s.order_type = 'takeaway' AND s.status = 'open'
      ORDER BY r.submitted_at, r.id`,
  );
  const { rows: lines } = await db.query<{
    round_id: string;
    item: string;
    variant: string;
    qty: number;
    unit: string;
    mods: string;
    names: string[];
  }>(
    `SELECT l.round_id::text, l.item_name_snap AS item, l.variant_name_snap AS variant, l.qty,
            l.unit_price_quoted::text AS unit, l.modifiers_unit_total::text AS mods,
            coalesce(array_agg(m.name_snap ORDER BY m.id) FILTER (WHERE m.id IS NOT NULL), '{}') AS names
       FROM cl.order_lines l LEFT JOIN cl.order_line_modifiers m ON m.line_id = l.id
      WHERE l.round_id = ANY($1::bigint[])
      GROUP BY l.id ORDER BY l.round_id, l.line_no`,
    [rows.map((r) => r.id)],
  );
  return {
    expiryMinutes: minutes,
    items: rows.map((r) => ({
      roundId: r.id,
      roundRef: r.round_ref,
      sessionId: r.session_id,
      sessionNo: r.session_no,
      customerName: r.customer_name,
      submittedAt: r.submitted_at.toISOString(),
      expiresAt: new Date(r.submitted_at.getTime() + minutes * 60_000).toISOString(),
      total: r.quoted_total,
      lines: lines
        .filter((l) => l.round_id === r.id)
        .map((l) => ({
          qty: l.qty,
          description: describe(l.item, l.variant),
          modifiers: l.names,
          amount: money.format(new Decimal(l.unit).plus(l.mods).times(l.qty)),
        })),
    })),
  };
}
