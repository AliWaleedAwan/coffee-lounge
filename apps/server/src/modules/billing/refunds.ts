/**
 * Refunds and payment-method corrections (ORDER_STATE_MACHINE.md P2; D-13; FINANCE_REPORTING.md
 * §4–5; Phase 5 step 5.2).
 *
 *  - Only a settled bill, and the bill itself never changes: a refund is a record of its own,
 *    numbered `RF-YYYY-NNNNN` (gapless per year), with an optional list of the lines it is for.
 *  - Always against one payment and back by that payment's method (as corrected, if it was):
 *    never more than that payment less what was refunded from it (REFUND_EXCEEDS_PAID, AT-90).
 *  - The person asking needs `payments.refund_request`; someone else approves on the same
 *    device with `payments.refund` (step-up `refund.approve` or `payment.correct`, AT-36).
 *  - A cash refund is paid from the open shift and lowers its expected cash. A correction
 *    to or from cash is made while the payment's own shift is open, so the drawer it
 *    corrects is the one counted.
 *  - The ledger entries (a refund out; a correction's reversal and new entry) are written by
 *    the database (0024). A refund slip prints on the counter printer.
 *  - Two refunds of one bill queue on the invoice row lock (CT).
 */
import { Decimal, money } from '@cl/shared';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { consumeStepUp } from '../identity/index.ts';
import type { CommandContext, StaffAuth } from '../orders/index.ts';
import { requestPrint } from '../printing/index.ts';
import { looksLikeCardNumber } from './compute.ts';
import { whoOf } from './invoices.ts';
import { PAYMENT_METHODS, TRANSFER_PROVIDERS } from './payments.ts';
import { counterTill, lockOpenShift } from './shifts.ts';

type Method = (typeof PAYMENT_METHODS)[number];
type Provider = (typeof TRANSFER_PROVIDERS)[number];

export interface RefundLineInput {
  invoiceLineId: string;
  qty: number;
  amount: string;
}

export type RefundInput =
  | {
      kind: 'refund';
      paymentId: string;
      amount: string;
      reason: string;
      reference?: string | undefined;
      lines?: RefundLineInput[] | undefined;
      stepUpId: string;
    }
  | {
      kind: 'method_correction';
      paymentId: string;
      method: Method;
      provider?: Provider | undefined;
      reference?: string | undefined;
      reason: string;
      stepUpId: string;
    };

export interface RefundResult {
  refundId: string;
  refundNo: string;
  kind: 'refund' | 'method_correction';
  amount: string;
  method: Method;
  provider: Provider | null;
  businessDate: string;
  /** False when no receipt printer is set. */
  slipQueued: boolean;
}

// ---------------------------------------------------------------- reading

export interface PaymentView {
  id: string;
  /** As taken. */
  takenMethod: Method;
  /** As it stands after corrections; refunds go back by this. */
  method: Method;
  provider: Provider | null;
  reference: string | null;
  amount: string;
  refunded: string;
  refundable: string;
  corrected: boolean;
  takenAt: string;
  /** The cash shift it belongs to (taken in, or corrected into), null for card and transfer. */
  inOpenShift: boolean;
}

export interface RefundView {
  id: string;
  refundNo: string;
  kind: 'refund' | 'method_correction';
  paymentId: string;
  amount: string;
  method: Method;
  provider: Provider | null;
  previousMethod: Method | null;
  previousProvider: Provider | null;
  reference: string | null;
  reason: string;
  requestedBy: string;
  approvedBy: string;
  businessDate: string;
  createdAt: string;
  lines: { invoiceLineId: string; qty: number; amount: string }[];
}

export interface RefundableBill {
  invoice: {
    id: string;
    invoiceNo: string | null;
    status: string;
    total: string;
    paidTotal: string;
    refunded: string;
    businessDate: string | null;
    sessionId: string;
    where: string;
  };
  lines: {
    id: string;
    description: string;
    qty: number;
    net: string;
    refundedQty: number;
    refundedAmount: string;
  }[];
  payments: PaymentView[];
  refunds: RefundView[];
  /** A cancelled prepaid delivery still owed back (P3-1, P5-5). */
  refundDue: string | null;
}

/** Payments of a bill with their method as it now stands and what may still be refunded. */
async function paymentsOf(db: Queryable, invoiceId: string): Promise<PaymentView[]> {
  const { rows } = await db.query<PaymentView>(
    `SELECT p.id::text, p.method AS "takenMethod",
            COALESCE(c.method, p.method) AS method,
            CASE WHEN c.id IS NOT NULL THEN c.transfer_provider ELSE p.transfer_provider END AS provider,
            CASE WHEN c.id IS NOT NULL THEN c.reference ELSE p.reference END AS reference,
            p.amount::text,
            COALESCE(f.refunded, 0)::numeric(14,2)::text AS refunded,
            (p.amount - COALESCE(f.refunded, 0))::numeric(14,2)::text AS refundable,
            c.id IS NOT NULL AS corrected, p.created_at AS "takenAt",
            EXISTS (SELECT 1 FROM cl.cash_shifts s
                     WHERE s.status = 'open' AND p.created_at >= s.opened_at
                       AND (p.cash_shift_id IS NULL OR p.cash_shift_id = s.id)) AS "inOpenShift"
       FROM cl.payments p
       LEFT JOIN LATERAL (SELECT r.id, r.method, r.transfer_provider, r.reference FROM cl.refunds r
                           WHERE r.payment_id = p.id AND r.kind = 'method_correction'
                           ORDER BY r.id DESC LIMIT 1) c ON true
       LEFT JOIN LATERAL (SELECT sum(r.amount) AS refunded FROM cl.refunds r
                           WHERE r.payment_id = p.id AND r.kind = 'refund') f ON true
      WHERE p.invoice_id = $1
      ORDER BY p.id`,
    [invoiceId],
  );
  return rows;
}

export async function readRefundable(db: Queryable, invoiceId: string): Promise<RefundableBill> {
  const { rows } = await db.query<RefundableBill['invoice'] & { refundDue: string | null }>(
    `SELECT i.id::text, i.invoice_no AS "invoiceNo", i.status, i.total::text, i.paid_total::text AS "paidTotal",
            COALESCE((SELECT sum(r.amount) FROM cl.refunds r WHERE r.invoice_id = i.id AND r.kind = 'refund'), 0)
              ::numeric(14,2)::text AS refunded,
            i.business_date::text AS "businessDate", s.id::text AS "sessionId",
            COALESCE(t.name, CASE WHEN d.id IS NOT NULL THEN 'Delivery · ' ELSE 'Takeaway · ' END
                             || COALESCE(s.customer_name, s.session_no)) AS "where",
            CASE WHEN d.refund_due > 0 THEN d.refund_due::text END AS "refundDue"
       FROM cl.invoices i JOIN cl.dining_sessions s ON s.id = i.session_id
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
       LEFT JOIN cl.delivery_orders d ON d.session_id = s.id
      WHERE i.id = $1`,
    [invoiceId],
  );
  const found = rows[0];
  if (!found) throw new AppError('NOT_FOUND', 'Bill not found');
  const { refundDue, ...invoice } = found;
  const { rows: lines } = await db.query<RefundableBill['lines'][number]>(
    `SELECT l.id::text, l.description_snap AS description, l.billable_qty AS qty, l.net::text,
            COALESCE(sum(rl.qty), 0)::int AS "refundedQty",
            COALESCE(sum(rl.amount), 0)::numeric(14,2)::text AS "refundedAmount"
       FROM cl.invoice_lines l LEFT JOIN cl.refund_lines rl ON rl.invoice_line_id = l.id
      WHERE l.invoice_id = $1 AND l.billable_qty > 0
      GROUP BY l.id ORDER BY l.id`,
    [invoiceId],
  );
  const { rows: refunds } = await db.query<RefundView>(
    `SELECT r.id::text, r.refund_no AS "refundNo", r.kind, r.payment_id::text AS "paymentId", r.amount::text,
            r.method, r.transfer_provider AS provider, r.previous_method AS "previousMethod",
            r.previous_provider AS "previousProvider", r.reference, r.reason,
            q.display_name AS "requestedBy", a.display_name AS "approvedBy",
            r.business_date::text AS "businessDate", r.created_at AS "createdAt",
            COALESCE((SELECT json_agg(json_build_object('invoiceLineId', rl.invoice_line_id::text, 'qty', rl.qty,
                                                         'amount', rl.amount::text) ORDER BY rl.id)
                        FROM cl.refund_lines rl WHERE rl.refund_id = r.id), '[]') AS lines
       FROM cl.refunds r JOIN cl.users q ON q.id = r.requested_by JOIN cl.users a ON a.id = r.approved_by
      WHERE r.invoice_id = $1 ORDER BY r.id`,
    [invoiceId],
  );
  return { invoice, lines, payments: await paymentsOf(db, invoiceId), refunds, refundDue };
}

/** Settled bills to refund from: by invoice or order number, table or guest, or a day. */
export async function findSettledBills(
  db: Queryable,
  filter: { q?: string | undefined; date?: string | undefined },
): Promise<{
  bills: {
    invoiceId: string;
    invoiceNo: string;
    where: string;
    total: string;
    refunded: string;
    businessDate: string;
    settledAt: string;
  }[];
}> {
  const q = filter.q?.trim() ?? '';
  const { rows } = await db.query(
    `SELECT i.id::text AS "invoiceId", i.invoice_no AS "invoiceNo",
            COALESCE(t.name, COALESCE(s.customer_name, s.session_no)) AS "where",
            i.total::text,
            COALESCE((SELECT sum(r.amount) FROM cl.refunds r WHERE r.invoice_id = i.id AND r.kind = 'refund'), 0)
              ::numeric(14,2)::text AS refunded,
            i.business_date::text AS "businessDate", i.settled_at AS "settledAt"
       FROM cl.invoices i JOIN cl.dining_sessions s ON s.id = i.session_id
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
      WHERE i.status = 'settled'
        AND ($1 = '' OR i.invoice_no ILIKE '%' || $1 || '%' OR s.session_no ILIKE '%' || $1 || '%'
             OR t.name ILIKE '%' || $1 || '%' OR s.customer_name ILIKE '%' || $1 || '%')
        AND ($2::date IS NULL OR i.business_date = $2::date)
      ORDER BY i.settled_at DESC, i.id DESC
      LIMIT 50`,
    [q, filter.date ?? null],
  );
  return { bills: rows as never };
}

// ---------------------------------------------------------------- writing

function checkReference(reference: string | undefined, method: Method): string | null {
  const ref = reference?.trim() ?? '';
  if (ref && looksLikeCardNumber(ref)) {
    throw new AppError(
      'CARD_NUMBER_NOT_ALLOWED',
      'That looks like a card number. Enter the approval code or transaction ID, never the card number.',
    );
  }
  if (method === 'cash' && ref) throw new AppError('VALIDATION_FAILED', 'Cash takes no reference');
  if (method === 'transfer' && !ref) {
    throw new AppError('VALIDATION_FAILED', 'Enter the transaction ID of the transfer');
  }
  return ref || null;
}

/** P2: a refund or a method correction, approved on this device by someone else. */
export async function recordRefund(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  invoiceId: string,
  input: RefundInput,
): Promise<RefundResult> {
  const [invoice] = await tx.lock<{
    status: string;
    invoice_no: string | null;
    session_id: string;
  }>('invoices', [invoiceId]);
  if (!invoice) throw new AppError('NOT_FOUND', 'Bill not found');
  if (invoice.status !== 'settled') {
    throw new AppError('STALE_STATE', 'Only a settled bill can be refunded or corrected', {
      status: invoice.status,
    });
  }
  const payment = (await paymentsOf(tx, invoiceId)).find((p) => p.id === input.paymentId);
  if (!payment) throw new AppError('VALIDATION_FAILED', 'That payment is not on this bill');

  const approvedBy = await consumeStepUp(tx, auth, {
    stepUpId: input.stepUpId,
    action: input.kind === 'refund' ? 'refund.approve' : 'payment.correct',
    entityType: 'invoice',
    entityId: invoiceId,
  });

  let amount: Decimal;
  let method: Method;
  let provider: Provider | null;
  let reference: string | null;
  let lines: RefundLineInput[] = [];
  if (input.kind === 'refund') {
    amount = money.parse(input.amount);
    if (amount.lte(0)) throw new AppError('VALIDATION_FAILED', 'Enter an amount above zero');
    if (amount.gt(payment.refundable)) {
      throw new AppError(
        'REFUND_EXCEEDS_PAID',
        `Only Rs ${payment.refundable} of this payment can still be refunded`,
        { refundable: payment.refundable },
      );
    }
    method = payment.method;
    provider = payment.provider;
    reference = checkReference(input.reference, method);
    lines = input.lines ?? [];
    await checkLines(tx, invoiceId, lines, amount);
  } else {
    if (new Decimal(payment.refunded).gt(0)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Part of this payment was refunded already, so its method can no longer be corrected',
      );
    }
    method = input.method;
    provider = method === 'transfer' ? (input.provider ?? null) : null;
    if (method === 'transfer' && !provider) {
      throw new AppError('VALIDATION_FAILED', 'Choose JazzCash, Easypaisa or bank');
    }
    if (method !== 'transfer' && input.provider) {
      throw new AppError('VALIDATION_FAILED', 'Only a transfer has a provider');
    }
    if (method === payment.method && provider === payment.provider) {
      throw new AppError('VALIDATION_FAILED', 'The payment already shows that method');
    }
    reference = checkReference(input.reference, method);
    amount = new Decimal(payment.amount);
  }

  // Cash leaves or moves in the open shift; a correction only in the payment's own shift.
  const cashInvolved =
    method === 'cash' || (input.kind === 'method_correction' && payment.method === 'cash');
  let shiftId: string | null = null;
  if (cashInvolved) {
    shiftId = await lockOpenShift(tx);
    if (shiftId === null) {
      throw new AppError(
        'NO_OPEN_CASH_SHIFT',
        input.kind === 'refund'
          ? 'No cash shift is open. Open the shift first: a cash refund is paid from the till.'
          : 'No cash shift is open. A correction to or from cash is made while its shift is open.',
      );
    }
    if (input.kind === 'method_correction' && !payment.inOpenShift) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This payment was taken in an earlier shift, which is closed. A correction to or from cash can only be made in the shift it was taken in; the difference stays as that shift’s variance.',
      );
    }
  }

  const businessDate = await businessDateOf(tx, ctx.now);
  const year = businessDate.slice(0, 4);
  // The till is read before numbering: document_counters is the last lock (DATABASE.md §14).
  const till = await counterTill(tx);
  const refundNo = `RF-${year}-${(await tx.nextNumber('refund', year)).padStart(5, '0')}`;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.refunds (refund_no, kind, invoice_id, payment_id, amount, method, transfer_provider,
       previous_method, previous_provider, reference, reason, requested_by, approved_by, step_up_id,
       cash_shift_id, idempotency_key, business_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id::text`,
    [
      refundNo,
      input.kind,
      invoiceId,
      payment.id,
      money.format(amount),
      method,
      provider,
      input.kind === 'method_correction' ? payment.method : null,
      input.kind === 'method_correction' ? payment.provider : null,
      reference,
      input.reason.trim(),
      auth.user.id,
      approvedBy,
      input.stepUpId,
      shiftId,
      ctx.key,
      businessDate,
    ],
  );
  const refundId = rows[0]?.id ?? '';
  for (const l of lines) {
    await tx.query(
      `INSERT INTO cl.refund_lines (refund_id, invoice_line_id, qty, amount) VALUES ($1, $2, $3, $4)`,
      [refundId, l.invoiceLineId, l.qty, money.format(money.parse(l.amount))],
    );
  }
  await writeAudit(tx, whoOf(auth, ctx), {
    action: input.kind === 'refund' ? 'payment.refund' : 'payment.correct',
    entityType: 'invoice',
    entityId: invoiceId,
    reason: input.reason.trim(),
    approvedBy,
    before:
      input.kind === 'method_correction'
        ? { paymentId: payment.id, method: payment.method, provider: payment.provider }
        : { paymentId: payment.id, refunded: payment.refunded },
    after: {
      refundNo,
      amount: money.format(amount),
      method,
      provider,
      ...(lines.length > 0 ? { lines } : {}),
    },
  });

  if (input.kind === 'refund')
    await closeRefundDue(tx, invoice.session_id, invoiceId, auth.user.id);
  const slipQueued =
    till?.printerId !== null && till?.printerId !== undefined
      ? (await requestPrint(tx, {
          printerId: till.printerId,
          documentType: 'refund_slip',
          documentId: refundId,
          requestedBy: auth.user.id,
        })) !== null
      : false;
  await publish(tx, {
    type: 'refund.recorded',
    entityType: 'invoice',
    entityId: invoiceId,
    topics: ['cashier', 'ledger', 'alerts'],
  });
  return {
    refundId,
    refundNo,
    kind: input.kind,
    amount: money.format(amount),
    method,
    provider,
    businessDate,
    slipQueued,
  };
}

/** Lines refunded: never more pieces or money than the line had, in all; never more than the refund. */
async function checkLines(
  tx: Tx,
  invoiceId: string,
  lines: readonly RefundLineInput[],
  amount: Decimal,
): Promise<void> {
  if (lines.length === 0) return;
  const ids = lines.map((l) => l.invoiceLineId);
  if (new Set(ids).size !== ids.length) {
    throw new AppError('VALIDATION_FAILED', 'Each line can be listed once');
  }
  const { rows } = await tx.query<{
    id: string;
    description: string;
    qty: number;
    net: string;
    refunded_qty: number;
    refunded_amount: string;
  }>(
    `SELECT l.id::text, l.description_snap AS description, l.billable_qty AS qty, l.net::text,
            COALESCE(sum(rl.qty), 0)::int AS refunded_qty, COALESCE(sum(rl.amount), 0)::text AS refunded_amount
       FROM cl.invoice_lines l LEFT JOIN cl.refund_lines rl ON rl.invoice_line_id = l.id
      WHERE l.invoice_id = $1 AND l.id = ANY($2::bigint[])
      GROUP BY l.id`,
    [invoiceId, ids],
  );
  let sum = new Decimal(0);
  for (const l of lines) {
    const line = rows.find((r) => r.id === l.invoiceLineId);
    if (!line) throw new AppError('VALIDATION_FAILED', 'A line is not on this bill');
    const lineAmount = money.parse(l.amount);
    if (!Number.isInteger(l.qty) || l.qty <= 0 || lineAmount.lte(0)) {
      throw new AppError('VALIDATION_FAILED', `${line.description}: enter how many and how much`);
    }
    if (line.refunded_qty + l.qty > line.qty) {
      throw new AppError(
        'REFUND_EXCEEDS_PAID',
        `${line.description}: only ${String(line.qty - line.refunded_qty)} left to refund`,
        { invoiceLineId: line.id, refundableQty: line.qty - line.refunded_qty },
      );
    }
    const left = new Decimal(line.net).minus(line.refunded_amount);
    if (lineAmount.gt(left)) {
      throw new AppError(
        'REFUND_EXCEEDS_PAID',
        `${line.description}: only Rs ${money.format(left)} left to refund`,
        { invoiceLineId: line.id, refundable: money.format(left) },
      );
    }
    sum = sum.plus(lineAmount);
  }
  if (sum.gt(amount)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `The lines add up to Rs ${money.format(sum)}, more than the refund of Rs ${money.format(amount)}`,
    );
  }
}

/** A cancelled prepaid delivery's "refund due" closes once that much is refunded (P5-5). */
async function closeRefundDue(tx: Tx, sessionId: string, invoiceId: string, userId: string) {
  await tx.query(
    `UPDATE cl.operational_alerts a SET state = 'resolved', resolved_at = now(), resolved_by = $3
       FROM cl.delivery_orders d
      WHERE d.session_id = $1 AND d.refund_due > 0
        AND a.kind = 'refund_due' AND a.entity_type = 'delivery_order' AND a.entity_id = d.id
        AND a.state <> 'resolved'
        AND (SELECT sum(r.amount) FROM cl.refunds r WHERE r.invoice_id = $2 AND r.kind = 'refund') >= d.refund_due`,
    [sessionId, invoiceId, userId],
  );
}

/** A labelled copy of a refund slip (`*** REPRINT #n ***`). */
export async function reprintRefundSlip(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  refundId: string,
): Promise<{ jobId: string; copyNo: number }> {
  const { rows } = await tx.query<{ invoice_id: string }>(
    'SELECT invoice_id::text FROM cl.refunds WHERE id = $1',
    [refundId],
  );
  const refund = rows[0];
  if (!refund) throw new AppError('NOT_FOUND', 'Refund not found');
  const till = await counterTill(tx);
  if (!till?.printerId) {
    throw new AppError(
      'VALIDATION_FAILED',
      'No receipt printer is set. Choose one in Settings → Printers.',
    );
  }
  const { rows: copies } = await tx.query<{ n: number }>(
    `SELECT coalesce(max(copy_no), 0)::int AS n FROM cl.print_jobs
      WHERE document_type = 'refund_slip' AND document_id = $1`,
    [refundId],
  );
  const copyNo = Math.max(2, (copies[0]?.n ?? 0) + 1);
  const jobId = await requestPrint(tx, {
    printerId: till.printerId,
    documentType: 'refund_slip',
    documentId: refundId,
    copyNo,
    requestedBy: auth.user.id,
  });
  if (jobId === null) throw new Error('reprint job key already used');
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'refund.slip_reprint',
    entityType: 'invoice',
    entityId: refund.invoice_id,
    after: { refundId, copyNo },
  });
  return { jobId, copyNo };
}
