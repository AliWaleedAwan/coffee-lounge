/**
 * People reports (FINANCE_REPORTING.md §6; Phase 6 step 6.4): what each person did in the
 * period (bills settled and payments taken, orders accepted, discounts given, refunds asked
 * for and approved, waste recorded), and the audit log as a report for the CSV export.
 */
import type { Queryable } from '../../platform/db/pool.ts';
import type { Row } from './engine.ts';

type Raw = Record<string, string | number | null>;

export async function staffActivity(
  db: Queryable,
  f: { from: string; to: string; staffId?: string | undefined },
): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `WITH settled AS (SELECT settled_by AS u, count(*)::int AS n, sum(total) AS amount FROM cl.invoices
                        WHERE status = 'settled' AND business_date BETWEEN $1::date AND $2::date GROUP BY settled_by),
          taken AS (SELECT received_by AS u, count(*)::int AS n, sum(amount) AS amount FROM cl.payments
                     WHERE business_date BETWEEN $1::date AND $2::date GROUP BY received_by),
          accepted AS (SELECT r.decided_by AS u, count(*)::int AS n FROM cl.order_rounds r
                        WHERE r.status = 'accepted' AND cl.shop_business_date(r.decided_at) BETWEEN $1::date AND $2::date
                        GROUP BY r.decided_by),
          discounts AS (SELECT d.applied_by AS u, count(*)::int AS n, sum(d.amount) AS amount
                          FROM cl.discount_applications d JOIN cl.invoices i ON i.id = d.invoice_id
                         WHERE i.status = 'settled' AND i.business_date BETWEEN $1::date AND $2::date
                           AND d.voided_at IS NULL AND d.amount > 0 GROUP BY d.applied_by),
          asked AS (SELECT requested_by AS u, count(*)::int AS n, sum(amount) AS amount FROM cl.refunds
                     WHERE kind = 'refund' AND business_date BETWEEN $1::date AND $2::date GROUP BY requested_by),
          approved AS (SELECT approved_by AS u, count(*)::int AS n FROM cl.refunds
                        WHERE business_date BETWEEN $1::date AND $2::date GROUP BY approved_by),
          wasted AS (SELECT recorded_by AS u, count(*)::int AS n FROM cl.wastage_records
                      WHERE business_date BETWEEN $1::date AND $2::date GROUP BY recorded_by)
     SELECT us.display_name AS person,
            COALESCE(settled.n, 0) AS bills, COALESCE(settled.amount, 0)::text AS bills_amount,
            COALESCE(taken.n, 0) AS payments, COALESCE(taken.amount, 0)::text AS taken,
            COALESCE(accepted.n, 0) AS orders_accepted,
            COALESCE(discounts.n, 0) AS discounts, COALESCE(discounts.amount, 0)::text AS discounts_amount,
            COALESCE(asked.n, 0) AS refunds, COALESCE(asked.amount, 0)::text AS refunds_amount,
            COALESCE(approved.n, 0) AS approvals, COALESCE(wasted.n, 0) AS waste_records
       FROM cl.users us
       LEFT JOIN settled ON settled.u = us.id LEFT JOIN taken ON taken.u = us.id
       LEFT JOIN accepted ON accepted.u = us.id LEFT JOIN discounts ON discounts.u = us.id
       LEFT JOIN asked ON asked.u = us.id LEFT JOIN approved ON approved.u = us.id
       LEFT JOIN wasted ON wasted.u = us.id
      WHERE ($3::bigint IS NULL OR us.id = $3)
        AND COALESCE(settled.n, taken.n, accepted.n, discounts.n, asked.n, approved.n, wasted.n) IS NOT NULL
      ORDER BY COALESCE(settled.amount, 0) DESC, lower(us.display_name), us.id`,
    [f.from, f.to, f.staffId ?? null],
  );
  return rows;
}

/** The audit events of the period (shop days), oldest first, at most 20,000 for one report. */
export async function auditEvents(
  db: Queryable,
  f: { from: string; to: string; staffId?: string | undefined; entityType?: string | undefined },
): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `WITH tz AS (SELECT value #>> '{}' AS zone FROM cl.system_settings WHERE key = 'shop.timezone')
     SELECT to_char(a.occurred_at AT TIME ZONE tz.zone, 'YYYY-MM-DD HH24:MI:SS') AS at,
            COALESCE(u.display_name, initcap(a.actor_kind)) AS who, d.name AS device, a.action,
            a.entity_type || COALESCE(' #' || a.entity_id, '') AS record, a.reason, ap.display_name AS approved_by,
            1 AS events
       FROM cl.audit_events a CROSS JOIN tz
       LEFT JOIN cl.users u ON u.id = a.actor_user_id
       LEFT JOIN cl.users ap ON ap.id = a.approved_by
       LEFT JOIN cl.devices d ON d.id = a.device_id
      WHERE a.occurred_at >= ($1::date::timestamp AT TIME ZONE tz.zone)
        AND a.occurred_at < (($2::date + 1)::timestamp AT TIME ZONE tz.zone)
        AND ($3::bigint IS NULL OR a.actor_user_id = $3 OR a.approved_by = $3)
        AND ($4::text IS NULL OR a.entity_type = $4)
      ORDER BY a.id
      LIMIT 20000`,
    [f.from, f.to, f.staffId ?? null, f.entityType ?? null],
  );
  return rows;
}
