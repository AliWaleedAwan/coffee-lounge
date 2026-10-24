/**
 * The counter's list of open bills (API.md §5.5 `GET /bills`): every active session with
 * its bill status and total, the ones asking for the bill first. A waiter limited to
 * their own tables (RBAC.md §1.3) sees only those.
 */
import type { Queryable } from '../../platform/db/pool.ts';
import type { StaffAuth } from '../orders/index.ts';
import { readBill } from './invoices.ts';

export async function openBills(db: Queryable, auth: Pick<StaffAuth, 'user' | 'permissions'>) {
  const grant = auth.permissions.get('invoices.read');
  const own = grant !== undefined && grant.scopes !== 'all';
  const { rows } = await db.query<{ id: string; checkout_requested_at: Date | null }>(
    `SELECT s.id::text, s.checkout_requested_at FROM cl.dining_sessions s
      WHERE s.status IN ('open','checkout_requested','checkout_locked')
        -- Counter-QR orders wait in the takeaway queue until they are paid and accepted.
        AND NOT (s.order_type = 'takeaway' AND s.opened_via = 'qr'
                 AND NOT EXISTS (SELECT 1 FROM cl.order_rounds r WHERE r.session_id = s.id AND r.status = 'accepted'))
        AND (NOT $2::boolean OR EXISTS (SELECT 1 FROM cl.table_assignments a
              WHERE a.table_id = s.table_id AND a.user_id = $1 AND a.ended_at IS NULL))
      ORDER BY s.checkout_requested_at NULLS LAST, s.opened_at`,
    [auth.user.id, own],
  );
  const items = [];
  for (const r of rows) {
    const bill = await readBill(db, r.id); // one connection: one query at a time
    items.push({
      sessionId: r.id,
      sessionNo: bill.session.sessionNo,
      sessionStatus: bill.session.status,
      orderType: bill.session.orderType,
      tableName: bill.session.tableName,
      customerName: bill.session.customerName,
      invoiceId: bill.invoice.id,
      invoiceStatus: bill.invoice.status,
      lockVersion: bill.invoice.lockVersion,
      total: bill.invoice.total,
      due: bill.invoice.due,
      items: bill.lines.reduce((n, l) => n + l.billableQty, 0),
      pendingRounds: bill.pendingRounds,
      billRequested: r.checkout_requested_at !== null,
    });
  }
  return { items };
}
