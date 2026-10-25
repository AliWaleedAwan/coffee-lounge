/**
 * Live operations for managers (UI_UX.md §6 Manager: "Live operations · Approvals inbox").
 * One read of how the shop is doing right now, and the inbox: what is waiting for a
 * manager's decision or attention. Each inbox item links to the screen where it is dealt
 * with; this screen decides nothing itself, except noting an alert as seen.
 */
import { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf, readSetting } from '../../platform/settings.ts';

export interface InboxItem {
  kind:
    | 'escalated_order'
    | 'shift_variance'
    | 'failed_delivery'
    | 'refund_due'
    | 'uncollected_item'
    | 'stale_session'
    | 'printer';
  /** The operational alert behind it, when it can be noted as seen. */
  alertId: string | null;
  acknowledged: boolean;
  title: string;
  detail: string;
  at: string;
  /** Staff app path where it is dealt with. */
  link: string;
}

export async function liveOperations(db: Queryable, now: Date) {
  const businessDate = await businessDateOf(db, now);
  const escalation = await readSetting(db, 'orders.escalation_minutes', z.number().positive());
  const { rows: figures } = await db.query<{
    tables: number;
    occupied: number;
    bill_requested: number;
    pending: number;
    escalated: number;
    open_tickets: number;
    open_bills: number;
    open_value: string;
    sales: string;
    settled: number;
    takeaway_unpaid: number;
    deliveries_out: number;
    deliveries_waiting: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM cl.dining_tables WHERE archived_at IS NULL) AS tables,
       (SELECT count(DISTINCT table_id)::int FROM cl.dining_sessions
         WHERE table_id IS NOT NULL AND status IN ('open','checkout_requested','checkout_locked')) AS occupied,
       (SELECT count(*)::int FROM cl.dining_sessions WHERE status = 'checkout_requested') AS bill_requested,
       (SELECT count(*)::int FROM cl.order_rounds WHERE status = 'pending_approval') AS pending,
       (SELECT count(*)::int FROM cl.order_rounds WHERE status = 'pending_approval'
          AND (escalated_at IS NOT NULL OR submitted_at <= $2::timestamptz - make_interval(mins => $3))) AS escalated,
       (SELECT count(*)::int FROM cl.kitchen_tickets WHERE status = 'open' AND kind IN ('new','supplement')) AS open_tickets,
       (SELECT count(*)::int FROM cl.invoices i JOIN cl.dining_sessions s ON s.id = i.session_id
         WHERE i.status <> 'settled' AND s.status IN ('open','checkout_requested','checkout_locked')) AS open_bills,
       (SELECT coalesce(sum(i.total - i.paid_total), 0)::numeric(14,2)::text FROM cl.invoices i
         WHERE i.status = 'locked') AS open_value,
       (SELECT coalesce(sum(total), 0)::numeric(14,2)::text FROM cl.invoices WHERE status = 'settled' AND business_date = $1) AS sales,
       (SELECT count(*)::int FROM cl.invoices WHERE status = 'settled' AND business_date = $1) AS settled,
       (SELECT count(*)::int FROM cl.order_rounds r JOIN cl.dining_sessions s ON s.id = r.session_id
         WHERE r.status = 'pending_approval' AND s.order_type = 'takeaway' AND s.opened_via = 'qr') AS takeaway_unpaid,
       (SELECT count(*)::int FROM cl.delivery_orders WHERE status = 'out_for_delivery') AS deliveries_out,
       (SELECT count(*)::int FROM cl.delivery_orders WHERE status = 'pending_dispatch') AS deliveries_waiting`,
    [businessDate, now, escalation],
  );
  const f = figures[0];
  if (!f) throw new Error('operations figures missing');
  const { rows: shift } = await db.query<{ cashier: string; opened_at: Date }>(
    `SELECT u.display_name AS cashier, s.opened_at FROM cl.cash_shifts s JOIN cl.users u ON u.id = s.cashier_user_id
      WHERE s.status = 'open' ORDER BY s.id LIMIT 1`,
  );
  return {
    businessDate,
    tables: { total: f.tables, occupied: f.occupied, billRequested: f.bill_requested },
    orders: { pending: f.pending, escalated: f.escalated, openTickets: f.open_tickets },
    bills: { open: f.open_bills, preparedUnpaid: f.open_value },
    sales: { settled: f.settled, total: f.sales },
    takeaway: { unpaid: f.takeaway_unpaid },
    deliveries: { waiting: f.deliveries_waiting, out: f.deliveries_out },
    shift: shift[0]
      ? { cashier: shift[0].cashier, openedAt: shift[0].opened_at.toISOString() }
      : null,
    inbox: await inbox(db, now, escalation),
  };
}

async function inbox(db: Queryable, now: Date, escalation: number): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  const { rows: rounds } = await db.query<{
    id: string;
    round_ref: string;
    submitted_at: Date;
    where_: string;
  }>(
    `SELECT r.id::text, r.round_ref, r.submitted_at, coalesce(t.name, s.session_no) AS where_
       FROM cl.order_rounds r JOIN cl.dining_sessions s ON s.id = r.session_id
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
      WHERE r.status = 'pending_approval'
        AND (r.escalated_at IS NOT NULL OR r.submitted_at <= $1::timestamptz - make_interval(mins => $2))
        AND NOT (s.order_type = 'takeaway' AND s.opened_via = 'qr')
      ORDER BY r.submitted_at`,
    [now, escalation],
  );
  for (const r of rounds) {
    items.push({
      kind: 'escalated_order',
      alertId: null,
      acknowledged: false,
      title: `Order waiting: ${r.where_}`,
      detail: `${r.round_ref} waits for someone to accept it`,
      at: r.submitted_at.toISOString(),
      link: '/approvals',
    });
  }
  const { rows: shifts } = await db.query<{
    cashier: string;
    variance: string;
    reason: string | null;
    closed_at: Date;
  }>(
    `SELECT u.display_name AS cashier, s.variance::text, s.variance_reason AS reason, s.closed_at
       FROM cl.cash_shifts s JOIN cl.users u ON u.id = s.cashier_user_id
      WHERE s.status = 'closed' ORDER BY s.closed_at`,
  );
  for (const s of shifts) {
    items.push({
      kind: 'shift_variance',
      alertId: null,
      acknowledged: false,
      title: `Cash shift of ${s.cashier}: variance Rs ${s.variance}`,
      detail: s.reason ?? '',
      at: s.closed_at.toISOString(),
      link: '/counter/shift',
    });
  }
  const { rows: alerts } = await db.query<{
    id: string;
    kind: InboxItem['kind'];
    state: string;
    detail: Record<string, unknown> | null;
    created_at: Date;
    entity_id: string;
  }>(
    `SELECT a.id::text, a.kind, a.state, a.detail, a.created_at, a.entity_id::text
       FROM cl.operational_alerts a WHERE a.state <> 'resolved' ORDER BY a.created_at, a.id`,
  );
  for (const a of alerts) {
    const d = a.detail ?? {};
    const text = (k: string) => (typeof d[k] === 'string' ? d[k] : '');
    const describe: Record<string, { title: string; detail: string; link: string }> = {
      failed_delivery: { title: 'Delivery failed', detail: text('reason'), link: '/deliveries' },
      refund_due: {
        title: `Refund due: Rs ${text('amount')}`,
        detail: `${text('sessionNo')}: recorded with refunds (a later phase)`,
        link: '/deliveries',
      },
      uncollected_item: {
        title: 'Item waiting for pickup',
        detail: [text('item'), text('where')].filter(Boolean).join(' · '),
        link: '/pickup',
      },
      stale_session: {
        title: `Table open a long time: ${text('sessionNo')}`,
        detail: 'Check the guests have their bill',
        link: '/floor',
      },
    };
    const known = describe[a.kind];
    if (!known) continue;
    items.push({
      kind: a.kind,
      alertId: a.id,
      acknowledged: a.state === 'acknowledged',
      ...known,
      at: a.created_at.toISOString(),
    });
  }
  const { rows: printers } = await db.query<{ name: string; n: number; at: Date }>(
    `SELECT p.name, count(*)::int AS n, min(j.created_at) AS at FROM cl.print_jobs j JOIN cl.printers p ON p.id = j.printer_id
      WHERE j.status IN ('needs_attention','uncertain') GROUP BY p.id, p.name ORDER BY p.name`,
  );
  for (const p of printers) {
    items.push({
      kind: 'printer',
      alertId: null,
      acknowledged: false,
      title: `Printer “${p.name}” needs attention`,
      detail: `${String(p.n)} job${p.n === 1 ? '' : 's'} not printed`,
      at: p.at.toISOString(),
      link: '/print-jobs',
    });
  }
  // Unseen first, then oldest first.
  return items.sort(
    (x, y) => Number(x.acknowledged) - Number(y.acknowledged) || x.at.localeCompare(y.at),
  );
}

/** A manager has seen an alert: it stays listed, below the unseen ones, until it is resolved. */
export async function acknowledgeAlert(
  tx: Tx,
  alertId: string,
): Promise<{ id: string; state: 'acknowledged' }> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE cl.operational_alerts SET state = 'acknowledged' WHERE id = $1 AND state = 'open' RETURNING id::text`,
    [alertId],
  );
  if (rows.length === 0) throw new AppError('STALE_STATE', 'This alert was already dealt with');
  await publish(tx, {
    type: 'alert.changed',
    entityType: 'alert',
    entityId: alertId,
    topics: ['alerts'],
  });
  return { id: alertId, state: 'acknowledged' };
}
