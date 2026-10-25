/**
 * The till and its cash shifts (FINANCE_REPORTING.md §5, RBAC.md §1.3–1.4, D-22). The shop
 * has one logical till, "Counter" (no drawer, D-03), and one shift open on it at a time.
 *
 *  open     with a counted float; cash payments and paid-in/out belong to it.
 *  close    the cashier counts the till. Expected cash = float + cash payments − cash
 *           refunds + paid-in − paid-out (the `cl.cash_shift_figures` view); variance =
 *           counted − expected. A shift that balances is done; any variance needs a
 *           reason and someone other than the cashier to approve it (AT-37), either with
 *           their PIN at the counter or later from their own login.
 *
 * A cashier acts on their own shift only (`{"shift":"own"}`); managers and the owner on
 * any. The shift row is locked for every change, and cash payments lock it too, so a
 * payment and a close cannot cross. The report prints at close on the receipt printer.
 */
import { Decimal, money } from '@cl/shared';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { consumeStepUp } from '../identity/index.ts';
import type { CommandContext, StaffAuth } from '../orders/index.ts';
import { requestPrint } from '../printing/index.ts';
import { whoOf } from './invoices.ts';

export interface Till {
  id: string;
  name: string;
  printerId: string | null;
  version: number;
}

/** The shop's till, with its receipt printer if that printer is switched on. */
export async function counterTill(db: Queryable): Promise<Till | null> {
  const { rows } = await db.query<Till>(
    `SELECT t.id::text, t.name, CASE WHEN p.is_active THEN p.id::text END AS "printerId", t.version
       FROM cl.tills t LEFT JOIN cl.printers p ON p.id = t.receipt_printer_id
      WHERE t.is_active ORDER BY t.id LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** The till's open shift, locked so it cannot close under a cash payment; null if none. */
export async function lockOpenShift(tx: Tx): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT s.id::text FROM cl.cash_shifts s JOIN cl.tills t ON t.id = s.till_id
      WHERE s.status = 'open' AND t.is_active ORDER BY s.id LIMIT 1`,
  );
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const [locked] = await tx.lock<{ status: string }>('cash_shifts', [id]);
  return locked?.status === 'open' ? id : null;
}

// ---------------------------------------------------------------- reading

interface ShiftRow {
  id: string;
  till: string;
  cashier: string;
  cashier_user_id: string;
  status: 'open' | 'closed' | 'approved';
  opened_at: Date;
  closed_at: Date | null;
  closed_by: string | null;
  counted_cash: string | null;
  expected_cash_at_close: string | null;
  variance: string | null;
  variance_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  opening_float: string;
  cash_sales: string;
  cash_payments: number;
  cash_refunds: string;
  paid_in: string;
  paid_out: string;
  expected_cash: string;
  card: string;
  jazzcash: string;
  easypaisa: string;
  bank: string;
}

const SHIFT_SELECT = `
  SELECT s.id::text, t.name AS till, u.display_name AS cashier, s.cashier_user_id::text, s.status,
         s.opened_at, s.closed_at, cb.display_name AS closed_by, s.counted_cash::text,
         s.expected_cash::text AS expected_cash_at_close, s.variance::text, s.variance_reason,
         ab.display_name AS approved_by, s.approved_at,
         f.opening_float::text, f.cash_sales::text, f.cash_payments, f.cash_refunds::text,
         f.paid_in::text, f.paid_out::text, f.expected_cash::text,
         f.card::text, f.jazzcash::text, f.easypaisa::text, f.bank::text
    FROM cl.cash_shifts s
    JOIN cl.cash_shift_figures f ON f.shift_id = s.id
    JOIN cl.tills t ON t.id = s.till_id
    JOIN cl.users u ON u.id = s.cashier_user_id
    LEFT JOIN cl.users cb ON cb.id = s.closed_by
    LEFT JOIN cl.users ab ON ab.id = s.approved_by`;

function shiftView(s: ShiftRow) {
  return {
    id: s.id,
    till: s.till,
    cashier: s.cashier,
    cashierUserId: s.cashier_user_id,
    status: s.status,
    openedAt: s.opened_at.toISOString(),
    closedAt: s.closed_at?.toISOString() ?? null,
    closedBy: s.closed_by,
    openingFloat: s.opening_float,
    cashSales: s.cash_sales,
    cashPayments: s.cash_payments,
    cashRefunds: s.cash_refunds,
    paidIn: s.paid_in,
    paidOut: s.paid_out,
    // Once closed, the figures are those the cashier counted against.
    expectedCash: s.expected_cash_at_close ?? s.expected_cash,
    countedCash: s.counted_cash,
    variance: s.variance,
    varianceReason: s.variance_reason,
    approvedBy: s.approved_by,
    approvedAt: s.approved_at?.toISOString() ?? null,
    card: s.card,
    transfers: { jazzcash: s.jazzcash, easypaisa: s.easypaisa, bank: s.bank },
  };
}

export type ShiftView = ReturnType<typeof shiftView>;

async function movementsOf(db: Queryable, shiftId: string) {
  const { rows } = await db.query<{
    id: string;
    kind: 'paid_in' | 'paid_out';
    amount: string;
    reason: string;
    actor: string;
    created_at: Date;
  }>(
    `SELECT m.id::text, m.kind, m.amount::text, m.reason, u.display_name AS actor, m.created_at
       FROM cl.cash_movements m JOIN cl.users u ON u.id = m.actor
      WHERE m.shift_id = $1 ORDER BY m.id`,
    [shiftId],
  );
  return rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    amount: m.amount,
    reason: m.reason,
    by: m.actor,
    at: m.created_at.toISOString(),
  }));
}

/**
 * Cash and card still with riders: unpaid COD and card-on-delivery bills out now. Not in
 * the till yet, so the close warns about it (API.md §5.5, step 3.10).
 */
export async function outstandingWithRiders(db: Queryable) {
  const { rows } = await db.query<{ rider: string; amount: string; deliveries: number }>(
    `SELECT r.display_name AS rider, sum(i.total - i.paid_total)::text AS amount, count(*)::int AS deliveries
       FROM cl.delivery_orders d JOIN cl.staff_profiles r ON r.id = d.rider_id
       JOIN cl.invoices i ON i.session_id = d.session_id
      WHERE d.status = 'out_for_delivery' AND d.payment_mode <> 'prepaid' AND i.status = 'locked'
      GROUP BY r.id, r.display_name ORDER BY r.display_name`,
  );
  return rows;
}

export async function readShift(db: Queryable, shiftId: string) {
  const { rows } = await db.query<ShiftRow>(`${SHIFT_SELECT} WHERE s.id = $1`, [shiftId]);
  const s = rows[0];
  if (!s) throw new AppError('NOT_FOUND', 'Cash shift not found');
  return {
    ...shiftView(s),
    movements: await movementsOf(db, shiftId),
    withRiders: s.status === 'open' ? await outstandingWithRiders(db) : [],
  };
}

export async function currentShift(db: Queryable) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id::text FROM cl.cash_shifts WHERE status = 'open' ORDER BY cash_shifts.id LIMIT 1`,
  );
  const id = rows[0]?.id;
  return { shift: id === undefined ? null : await readShift(db, id) };
}

/** Is this grant limited to the caller's own shift (a cashier, RBAC.md §1.3)? */
function ownOnly(auth: Pick<StaffAuth, 'permissions'>): boolean {
  const grant = auth.permissions.get('cash_shifts.operate');
  return grant !== undefined && grant.scopes !== 'all';
}

/** Recent shifts, newest first; closed ones waiting for approval first. Cashiers see their own. */
export async function listShifts(db: Queryable, auth: Pick<StaffAuth, 'user' | 'permissions'>) {
  const { rows } = await db.query<ShiftRow>(
    `${SHIFT_SELECT}
      WHERE (NOT $2::boolean OR s.cashier_user_id = $1)
      ORDER BY (s.status = 'closed') DESC, s.opened_at DESC LIMIT 30`,
    [auth.user.id, ownOnly(auth)],
  );
  return { items: rows.map(shiftView) };
}

// ---------------------------------------------------------------- changes

async function shiftChanged(tx: Tx, shiftId: string) {
  await publish(tx, {
    type: 'shift.changed',
    entityType: 'cash_shift',
    entityId: shiftId,
    topics: ['cashier'],
  });
}

interface LockedShift {
  id: string;
  status: 'open' | 'closed' | 'approved';
  cashier_user_id: string;
}

async function lockShift(tx: Tx, auth: StaffAuth, shiftId: string): Promise<LockedShift> {
  const [shift] = await tx.lock<LockedShift>('cash_shifts', [shiftId]);
  if (!shift) throw new AppError('NOT_FOUND', 'Cash shift not found');
  if (ownOnly(auth) && shift.cashier_user_id !== auth.user.id) {
    throw new AppError('FORBIDDEN', 'This is another cashier’s shift');
  }
  return shift;
}

async function expectedCash(tx: Tx, shiftId: string): Promise<Decimal> {
  const { rows } = await tx.query<{ expected: string }>(
    'SELECT expected_cash::text AS expected FROM cl.cash_shift_figures WHERE shift_id = $1',
    [shiftId],
  );
  return new Decimal(rows[0]?.expected ?? 0);
}

export async function openShift(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  input: { openingFloat: string },
): Promise<{ shiftId: string }> {
  const till = await counterTill(tx);
  if (!till) throw new AppError('NOT_FOUND', 'No till is set up');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.cash_shifts (till_id, cashier_user_id, opening_float) VALUES ($1, $2, $3)
     ON CONFLICT (till_id) WHERE status = 'open' DO NOTHING RETURNING id::text`,
    [till.id, auth.user.id, money.format(money.parse(input.openingFloat))],
  );
  const shiftId = rows[0]?.id;
  if (shiftId === undefined) {
    throw new AppError(
      'STALE_STATE',
      'A shift is already open on this till. The cashier on it closes it first.',
    );
  }
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'shift.open',
    entityType: 'cash_shift',
    entityId: shiftId,
    after: { till: till.name, openingFloat: input.openingFloat },
  });
  await shiftChanged(tx, shiftId);
  return { shiftId };
}

/** Paid-in (e.g. change brought from the bank) or paid-out (e.g. milk top-up), with a reason. */
export async function addMovement(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  shiftId: string,
  input: { kind: 'paid_in' | 'paid_out'; amount: string; reason: string },
): Promise<{ movementId: string; expectedCash: string }> {
  const shift = await lockShift(tx, auth, shiftId);
  if (shift.status !== 'open') throw new AppError('STALE_STATE', 'This shift is already closed');
  const amount = money.parse(input.amount);
  if (amount.lte(0)) throw new AppError('VALIDATION_FAILED', 'Enter an amount above zero');
  const expected = await expectedCash(tx, shiftId);
  if (input.kind === 'paid_out' && amount.gt(expected)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Only Rs ${money.format(expected)} should be in the till; a larger paid-out is not possible.`,
    );
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.cash_movements (shift_id, kind, amount, reason, actor)
     VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
    [shiftId, input.kind, money.format(amount), input.reason, auth.user.id],
  );
  const movementId = rows[0]?.id ?? '';
  await writeAudit(tx, whoOf(auth, ctx), {
    action: `shift.${input.kind}`,
    entityType: 'cash_shift',
    entityId: shiftId,
    after: { movementId, amount: money.format(amount) },
    reason: input.reason,
  });
  await shiftChanged(tx, shiftId);
  const after = input.kind === 'paid_in' ? expected.plus(amount) : expected.minus(amount);
  return { movementId, expectedCash: money.format(after) };
}

/** Queues the shift report on the receipt printer; null when no printer is set. */
async function printReport(tx: Tx, auth: StaffAuth, shiftId: string, copyNo: number) {
  const till = await counterTill(tx);
  if (!till?.printerId) return null;
  return requestPrint(tx, {
    printerId: till.printerId,
    documentType: 'shift_report',
    documentId: shiftId,
    copyNo,
    requestedBy: auth.user.id,
  });
}

export interface CloseResult {
  shiftId: string;
  status: 'closed' | 'approved';
  expectedCash: string;
  countedCash: string;
  variance: string;
  reportQueued: boolean;
  /** Cash and card still with riders when the shift closed: collect it in the next shift. */
  withRiders: { rider: string; amount: string; deliveries: number }[];
}

export async function closeShift(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  shiftId: string,
  input: {
    countedCash: string;
    varianceReason?: string | undefined;
    stepUpId?: string | undefined;
  },
): Promise<CloseResult> {
  const shift = await lockShift(tx, auth, shiftId);
  if (shift.status !== 'open') throw new AppError('STALE_STATE', 'This shift is already closed');
  const counted = money.parse(input.countedCash);
  const expected = await expectedCash(tx, shiftId);
  const variance = counted.minus(expected);
  const reason = input.varianceReason?.trim() ?? '';
  if (!variance.isZero() && reason.length < 3) {
    throw new AppError(
      'VALIDATION_FAILED',
      `The till is Rs ${money.format(variance.abs())} ${variance.isNegative() ? 'short' : 'over'}. Say why before closing.`,
      { expectedCash: money.format(expected), variance: money.format(variance) },
    );
  }
  let approvedBy: string | null = null;
  if (!variance.isZero() && input.stepUpId) {
    approvedBy = await consumeStepUp(tx, auth, {
      stepUpId: input.stepUpId,
      action: 'shift.variance',
      entityType: 'cash_shift',
      entityId: shiftId,
    });
    if (approvedBy === shift.cashier_user_id) {
      throw new AppError('FORBIDDEN', 'Someone other than the cashier approves a variance');
    }
  }
  const status = variance.isZero() || approvedBy !== null ? 'approved' : 'closed';
  await tx.query(
    `UPDATE cl.cash_shifts SET status = $2, closed_at = now(), closed_by = $3, counted_cash = $4,
            expected_cash = $5, variance = $6, variance_reason = $7, approved_by = $8,
            approved_at = CASE WHEN $2 = 'approved' THEN now() END
      WHERE id = $1`,
    [
      shiftId,
      status,
      auth.user.id,
      money.format(counted),
      money.format(expected),
      money.format(variance),
      reason || null,
      approvedBy,
    ],
  );
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'shift.close',
    entityType: 'cash_shift',
    entityId: shiftId,
    after: {
      countedCash: money.format(counted),
      expectedCash: money.format(expected),
      variance: money.format(variance),
      status,
    },
    ...(reason ? { reason } : {}),
    ...(approvedBy ? { approvedBy } : {}),
  });
  await shiftChanged(tx, shiftId);
  const jobId = await printReport(tx, auth, shiftId, 1);
  return {
    shiftId,
    status,
    expectedCash: money.format(expected),
    countedCash: money.format(counted),
    variance: money.format(variance),
    reportQueued: jobId !== null,
    withRiders: await outstandingWithRiders(tx),
  };
}

/** A manager or the owner approves a closed shift's variance from their own login. */
export async function approveShift(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  shiftId: string,
  input: { note?: string | undefined },
): Promise<{ shiftId: string; status: 'approved' }> {
  const shift = await lockShift(tx, auth, shiftId);
  if (shift.status !== 'closed') {
    throw new AppError(
      'STALE_STATE',
      shift.status === 'open' ? 'Close the shift first' : 'This shift is already approved',
    );
  }
  if (shift.cashier_user_id === auth.user.id) {
    throw new AppError('FORBIDDEN', 'Someone other than the cashier approves a variance');
  }
  await tx.query(
    `UPDATE cl.cash_shifts SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
    [shiftId, auth.user.id],
  );
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'shift.approve',
    entityType: 'cash_shift',
    entityId: shiftId,
    ...(input.note ? { reason: input.note } : {}),
  });
  await shiftChanged(tx, shiftId);
  return { shiftId, status: 'approved' };
}

/** A labelled copy of a closed shift's report. */
export async function reprintShiftReport(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  shiftId: string,
): Promise<{ jobId: string; copyNo: number }> {
  const shift = await lockShift(tx, auth, shiftId);
  if (shift.status === 'open')
    throw new AppError('STALE_STATE', 'The report prints when the shift closes');
  const { rows } = await tx.query<{ n: number }>(
    `SELECT coalesce(max(copy_no), 0)::int AS n FROM cl.print_jobs WHERE document_type = 'shift_report' AND document_id = $1`,
    [shiftId],
  );
  const copyNo = Math.max(2, (rows[0]?.n ?? 0) + 1);
  const jobId = await printReport(tx, auth, shiftId, copyNo);
  if (jobId === null) {
    throw new AppError(
      'VALIDATION_FAILED',
      'No receipt printer is set. Choose one in Settings → Printers.',
    );
  }
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'shift.report_reprint',
    entityType: 'cash_shift',
    entityId: shiftId,
    after: { copyNo },
  });
  return { jobId, copyNo };
}
