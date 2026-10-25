/**
 * What the cash shift report shows (PRINTING_HARDWARE.md §4, FINANCE_REPORTING.md §5): the
 * closed shift's count against the expected cash from `cl.cash_shift_figures`, the card
 * and transfer totals to check against their slips, and every paid-in and paid-out.
 */
import type { Queryable } from '../../platform/db/pool.ts';
import type { ShiftReportData } from './documents.ts';

export async function shiftReportData(db: Queryable, shiftId: string): Promise<ShiftReportData> {
  const { rows } = await db.query<{
    till: string;
    cashier: string;
    status: string;
    opened_at: Date;
    closed_at: Date | null;
    closed_by: string | null;
    counted_cash: string | null;
    expected_cash: string | null;
    variance: string | null;
    variance_reason: string | null;
    approved_by: string | null;
    opening_float: string;
    cash_sales: string;
    cash_refunds: string;
    paid_in: string;
    paid_out: string;
    card: string;
    jazzcash: string;
    easypaisa: string;
    bank: string;
  }>(
    `SELECT t.name AS till, u.display_name AS cashier, s.status, s.opened_at, s.closed_at,
            cb.display_name AS closed_by, s.counted_cash::text, s.expected_cash::text, s.variance::text,
            s.variance_reason, ab.display_name AS approved_by,
            f.opening_float::text, f.cash_sales::text, f.cash_refunds::text, f.paid_in::text, f.paid_out::text,
            f.card::text, f.jazzcash::text, f.easypaisa::text, f.bank::text
       FROM cl.cash_shifts s JOIN cl.cash_shift_figures f ON f.shift_id = s.id
       JOIN cl.tills t ON t.id = s.till_id JOIN cl.users u ON u.id = s.cashier_user_id
       LEFT JOIN cl.users cb ON cb.id = s.closed_by LEFT JOIN cl.users ab ON ab.id = s.approved_by
      WHERE s.id = $1`,
    [shiftId],
  );
  const s = rows[0];
  if (!s || s.status === 'open' || !s.closed_at || s.counted_cash === null) {
    throw new Error(`cash shift ${shiftId} is not closed`);
  }
  const { rows: movements } = await db.query<{
    kind: 'paid_in' | 'paid_out';
    amount: string;
    reason: string;
  }>(
    'SELECT kind, amount::text, reason FROM cl.cash_movements WHERE shift_id = $1 ORDER BY cash_movements.id',
    [shiftId],
  );
  return {
    shiftId,
    till: s.till,
    cashier: s.cashier,
    openedAt: s.opened_at,
    closedAt: s.closed_at,
    closedBy: s.closed_by ?? '',
    openingFloat: s.opening_float,
    cashSales: s.cash_sales,
    cashRefunds: s.cash_refunds,
    paidIn: s.paid_in,
    paidOut: s.paid_out,
    expectedCash: s.expected_cash ?? '0.00',
    countedCash: s.counted_cash,
    variance: s.variance ?? '0.00',
    varianceReason: s.variance_reason,
    approvedBy: s.approved_by,
    status: s.status === 'approved' ? 'approved' : 'closed',
    card: s.card,
    transfers: [
      { label: 'JazzCash', amount: s.jazzcash },
      { label: 'Easypaisa', amount: s.easypaisa },
      { label: 'Bank transfer', amount: s.bank },
    ],
    movements,
  };
}
