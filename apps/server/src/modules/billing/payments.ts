/**
 * Taking payment and settling (ORDER_STATE_MACHINE.md §6 P1, I4; D-13, D-21).
 *
 *  P1 A payment lands only on a prepared (locked) bill whose lock_version the counter saw
 *     (else BILL_CHANGED, AT-34), for no more than is still due (AMOUNT_EXCEEDS_DUE).
 *     Cash goes into the till's open shift (NO_OPEN_CASH_SHIFT) and records the change;
 *     card may carry the terminal's approval code and a transfer must carry its
 *     transaction ID; neither may look like a card number (AT-42);
 *     a transfer names its provider and the person who saw it arrive (AT-59).
 *     Several payments may settle one bill (split tender, AT-35); the bill is never split.
 *  I4 The payment that brings paid_total to total settles the bill in the same
 *     transaction: the next gapless invoice number of its year (AT-117), the business
 *     date with the 04:00 cutoff (AT-44), the session ends (S7) and the receipt prints.
 *
 * The Idempotency-Key is the payment's own key, so a retried request never pays twice
 * (AT-11); two cashiers on one bill queue on the invoice row lock (CT-06).
 */
import { Decimal, money } from '@cl/shared';
import { writeAudit } from '../../platform/audit.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { settleSession, type SessionRow } from '../floor/index.ts';
import type { CommandContext, StaffAuth } from '../orders/index.ts';
import { requestPrint } from '../printing/index.ts';
import { looksLikeCardNumber } from './compute.ts';
import { invoiceChanged, lockInvoice, whoOf, type InvoiceRow } from './invoices.ts';
import { counterTill, lockOpenShift } from './shifts.ts';

export const PAYMENT_METHODS = ['cash', 'card_manual', 'transfer'] as const;
export const TRANSFER_PROVIDERS = ['bank', 'jazzcash', 'easypaisa'] as const;

export interface PaymentRequest {
  lockVersion: number;
  method: (typeof PAYMENT_METHODS)[number];
  amount: string;
  tendered?: string | undefined;
  provider?: (typeof TRANSFER_PROVIDERS)[number] | undefined;
  reference?: string | undefined;
  /** Transfers: the person taking payment saw the money arrive in the shop's account. */
  confirmed?: boolean | undefined;
}

export interface PaymentResult {
  paymentId: string;
  invoiceId: string;
  paidTotal: string;
  due: string;
  change: string | null;
  settled: boolean;
  invoiceNo: string | null;
  businessDate: string | null;
  /** False when no receipt printer is set: the receipt can be reprinted later. */
  receiptQueued: boolean;
}

function checkDetails(input: PaymentRequest): void {
  const reference = input.reference?.trim() ?? '';
  if (reference && looksLikeCardNumber(reference)) {
    throw new AppError(
      'CARD_NUMBER_NOT_ALLOWED',
      'That looks like a card number. Enter the approval code from the terminal slip, never the card number.',
    );
  }
  if (input.method === 'cash') {
    if (input.tendered === undefined) {
      throw new AppError('VALIDATION_FAILED', 'Enter the cash received');
    }
    if (money.parse(input.tendered).lt(money.parse(input.amount))) {
      throw new AppError('VALIDATION_FAILED', 'The cash received is less than the amount');
    }
    if (input.provider !== undefined || reference) {
      throw new AppError('VALIDATION_FAILED', 'Cash takes no provider or reference');
    }
    return;
  }
  if (input.tendered !== undefined) {
    throw new AppError('VALIDATION_FAILED', 'Only cash has cash received and change');
  }
  if (input.method === 'card_manual') {
    // The terminal slip's approval code is optional (Counter prototype); a card number never.
    if (input.provider !== undefined) {
      throw new AppError('VALIDATION_FAILED', 'A card payment has no transfer provider');
    }
    return;
  }
  if (!input.provider)
    throw new AppError('VALIDATION_FAILED', 'Choose JazzCash, Easypaisa or bank');
  if (!reference) {
    throw new AppError('VALIDATION_FAILED', 'Enter the transaction ID shown on the transfer');
  }
  if (input.confirmed !== true) {
    throw new AppError(
      'VALIDATION_FAILED',
      "Check the shop's account or app shows the money, then confirm",
    );
  }
}

export async function takePayment(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  invoiceId: string,
  input: PaymentRequest,
): Promise<PaymentResult> {
  checkDetails(input);
  const amount = money.parse(input.amount);
  if (amount.lte(0)) throw new AppError('VALIDATION_FAILED', 'Enter an amount above zero');

  const { session, invoice } = await lockInvoice(tx, invoiceId);
  if (invoice.status !== 'locked') {
    throw new AppError('BILL_CHANGED', 'Prepare the bill before taking payment', {
      status: invoice.status,
    });
  }
  if (invoice.lock_version !== input.lockVersion) {
    throw new AppError(
      'BILL_CHANGED',
      'The bill changed since you opened it. Check the new total and take payment again.',
      { lockVersion: invoice.lock_version, total: invoice.total },
    );
  }
  const due = new Decimal(invoice.total).minus(invoice.paid_total);
  if (amount.gt(due)) {
    throw new AppError(
      'AMOUNT_EXCEEDS_DUE',
      `Only Rs ${money.format(due)} is due. For cash, enter what the guest gave under cash received.`,
      { due: money.format(due) },
    );
  }
  const shiftId = input.method === 'cash' ? await lockOpenShift(tx) : null;
  if (input.method === 'cash' && shiftId === null) {
    throw new AppError(
      'NO_OPEN_CASH_SHIFT',
      'No cash shift is open. Open the shift with its float first, or take card or transfer.',
    );
  }

  const businessDate = await businessDateOf(tx, ctx.now);
  const tendered = input.method === 'cash' ? money.parse(input.tendered ?? '0') : null;
  const change = tendered ? tendered.minus(amount) : null;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.payments (invoice_id, method, transfer_provider, amount, tendered, change_due, reference,
       confirmed_by, received_by, cash_shift_id, idempotency_key, business_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id::text`,
    [
      invoice.id,
      input.method,
      input.method === 'transfer' ? (input.provider ?? null) : null,
      money.format(amount),
      tendered ? money.format(tendered) : null,
      change ? money.format(change) : null,
      input.reference?.trim() || null,
      input.method === 'transfer' ? auth.user.id : null,
      auth.user.id,
      shiftId,
      ctx.key,
      businessDate,
    ],
  );
  const paymentId = rows[0]?.id ?? '';
  const paidTotal = new Decimal(invoice.paid_total).plus(amount);
  await tx.query('UPDATE cl.invoices SET paid_total = $2 WHERE id = $1', [
    invoice.id,
    money.format(paidTotal),
  ]);
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'payment.take',
    entityType: 'invoice',
    entityId: invoice.id,
    after: {
      paymentId,
      method: input.method,
      provider: input.provider ?? null,
      amount: money.format(amount),
    },
  });

  let settled: Settlement | null = null;
  if (paidTotal.eq(invoice.total)) {
    settled = await settle(tx, ctx, auth, { session, invoice }, businessDate);
  } else {
    await invoiceChanged(tx, invoice, session);
  }
  return {
    paymentId,
    invoiceId: invoice.id,
    paidTotal: money.format(paidTotal),
    due: money.format(new Decimal(invoice.total).minus(paidTotal)),
    change: change ? money.format(change) : null,
    settled: settled !== null,
    invoiceNo: settled?.invoiceNo ?? null,
    businessDate: settled ? businessDate : null,
    receiptQueued: settled?.receiptQueued ?? false,
  };
}

interface Settlement {
  invoiceNo: string;
  receiptQueued: boolean;
}

/** I4 + S7, inside the transaction of the last payment (or of locking a Rs 0 bill). */
export async function settle(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  locked: { session: SessionRow; invoice: InvoiceRow },
  businessDate?: string,
): Promise<Settlement> {
  const { session, invoice } = locked;
  const date = businessDate ?? (await businessDateOf(tx, ctx.now));
  const year = date.slice(0, 4);
  // The till is read before numbering: document_counters is the last lock (DATABASE.md §14).
  const till = await counterTill(tx);
  const n = await tx.nextNumber('invoice', year);
  const invoiceNo = `INV-${year}-${n.padStart(6, '0')}`;
  await tx.query(
    `UPDATE cl.invoices SET status = 'settled', invoice_no = $2, business_date = $3,
            settled_at = now(), settled_by = $4 WHERE id = $1`,
    [invoice.id, invoiceNo, date, auth.user.id],
  );
  const who = whoOf(auth, ctx);
  await settleSession(tx, who, session);
  await writeAudit(tx, who, {
    action: 'invoice.settle',
    entityType: 'invoice',
    entityId: invoice.id,
    after: { invoiceNo, businessDate: date, total: invoice.total },
  });
  const receiptQueued =
    till?.printerId !== null && till?.printerId !== undefined
      ? (await requestPrint(tx, {
          printerId: till.printerId,
          documentType: 'receipt',
          documentId: invoice.id,
          requestedBy: auth.user.id,
        })) !== null
      : false;
  await invoiceChanged(tx, invoice, session);
  return { invoiceNo, receiptQueued };
}

/** A labelled copy of a settled invoice's receipt (`*** REPRINT #n ***`). */
export async function reprintReceipt(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  invoiceId: string,
): Promise<{ jobId: string; copyNo: number }> {
  const [inv] = await tx.lock<{ status: string }>('invoices', [invoiceId]);
  if (!inv) throw new AppError('NOT_FOUND', 'Bill not found');
  if (inv.status !== 'settled') {
    throw new AppError('STALE_STATE', 'Only a settled bill has a receipt to reprint');
  }
  const till = await counterTill(tx);
  if (!till?.printerId) {
    throw new AppError(
      'VALIDATION_FAILED',
      'No receipt printer is set. Choose one in Settings → Printers.',
    );
  }
  const { rows: copies } = await tx.query<{ n: number }>(
    `SELECT coalesce(max(copy_no), 0)::int AS n FROM cl.print_jobs WHERE document_type = 'receipt' AND document_id = $1`,
    [invoiceId],
  );
  const copyNo = Math.max(2, (copies[0]?.n ?? 0) + 1);
  const jobId = await requestPrint(tx, {
    printerId: till.printerId,
    documentType: 'receipt',
    documentId: invoiceId,
    copyNo,
    requestedBy: auth.user.id,
  });
  if (jobId === null) throw new Error('reprint job key already used');
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'receipt.reprint',
    entityType: 'invoice',
    entityId: invoiceId,
    after: { copyNo },
  });
  return { jobId, copyNo };
}
