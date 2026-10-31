/**
 * Money and sales reports (FINANCE_REPORTING.md §6; Phase 6 step 6.3): the bills behind the
 * sales and their lines, sales by category, menu engineering, discounts, comps and refunds,
 * payment mix and collections, deliveries, and the recorded operating result. Each query
 * returns the rows a report shows; the engine works out the totals from them.
 */
import { Decimal } from '@cl/shared';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Row } from './engine.ts';
import { derive, LINES, salesKpis, salesParams, type SalesFilter } from './kpi.ts';

type Raw = Record<string, string | number | null>;

/** Settled bills of the period (the rows behind each day's sales). */
export async function bills(db: Queryable, f: SalesFilter): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `WITH ${LINES},
       b AS (SELECT invoice_id, sum(billable_qty)::int AS items, sum(gross) AS gross,
                    sum(promotion_discount + manual + discount_alloc + comp) AS discounts, sum(net) AS lines_net,
                    sum(cogs) AS cogs
               FROM ln GROUP BY invoice_id)
     SELECT i.id::text AS invoice_id, i.business_date::text AS date, i.invoice_no,
            COALESCE(t.name, initcap(replace(s.order_type, '_', ' ')) || ' ' || s.session_no) AS "where",
            s.order_type, u.display_name AS settled_by, b.items,
            b.gross::text, b.discounts::text, b.lines_net::text AS net, b.cogs::text,
            CASE WHEN $4::bigint IS NULL AND $5::bigint IS NULL THEN i.rounding_adjustment::text END AS rounding,
            CASE WHEN $4::bigint IS NULL AND $5::bigint IS NULL THEN i.total::text END AS total
       FROM b JOIN cl.invoices i ON i.id = b.invoice_id
       JOIN cl.dining_sessions s ON s.id = i.session_id
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
       LEFT JOIN cl.users u ON u.id = i.settled_by
      ORDER BY i.business_date, i.settled_at, i.id`,
    salesParams(f),
  );
  return rows;
}

/** One bill's lines: what was sold, at what discount, and (with costs) at what cost. */
export async function billLines(db: Queryable, invoiceId: string): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `SELECT il.id::text AS line_id, il.description_snap AS item, il.billable_qty AS items,
            il.gross::text, (il.promotion_discount + il.manual_discount + il.discount_alloc)::text AS discounts,
            il.net::text AS net,
            CASE WHEN ol.stock_mode_snap = 'recipe' THEN
              (CASE WHEN ol.qty_picked_up > 0 THEN c.consumption - c.consumption * ol.qty_cancelled_prepared / ol.qty_picked_up
                    ELSE 0 END)::text END AS cogs,
            CASE WHEN il.is_comp THEN 'Comp' WHEN ol.stock_mode_snap = 'recipe' THEN 'Recipe' ELSE 'No recipe' END AS note,
            COALESCE((SELECT sum(rl.amount) FROM cl.refund_lines rl WHERE rl.invoice_line_id = il.id), 0)::text AS refunded
       FROM cl.invoice_lines il
       JOIN cl.invoices i ON i.id = il.invoice_id
       JOIN cl.order_lines ol ON ol.id = il.order_line_id
       LEFT JOIN LATERAL (SELECT COALESCE(sum(x.value), 0) AS consumption FROM cl.order_line_costs x
                           WHERE x.order_line_id = ol.id) c ON true
      WHERE il.invoice_id = $1 AND i.status = 'settled' AND il.billable_qty > 0
      ORDER BY il.id`,
    [invoiceId],
  );
  return rows;
}

/** Sales by menu category, with costs and margin for those who may see them. */
export async function byCategory(db: Queryable, f: SalesFilter): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `WITH ${LINES},
       s AS (SELECT category, count(DISTINCT invoice_id)::int AS orders, sum(billable_qty)::int AS items,
                    sum(gross) AS gross, sum(promotion_discount) AS promotions, sum(manual + discount_alloc) AS manual,
                    sum(comp) AS comps, COALESCE(sum(net) FILTER (WHERE tracked), 0) AS tracked_net, sum(cogs) AS cogs
               FROM ln GROUP BY category),
       r AS (SELECT mc.name AS category, sum(rl.amount) AS refunds
               FROM cl.refunds x JOIN cl.refund_lines rl ON rl.refund_id = x.id
               JOIN cl.invoices i ON i.id = x.invoice_id JOIN cl.dining_sessions ss ON ss.id = i.session_id
               JOIN cl.invoice_lines il ON il.id = rl.invoice_line_id
               JOIN cl.order_lines ol ON ol.id = il.order_line_id
               JOIN cl.menu_variants v ON v.id = ol.variant_id JOIN cl.menu_items mi ON mi.id = v.item_id
               JOIN cl.menu_categories mc ON mc.id = mi.category_id
              WHERE x.kind = 'refund' AND x.business_date BETWEEN $1::date AND $2::date
                AND ($3::text IS NULL OR ss.order_type = $3)
                AND ($4::bigint IS NULL OR mi.category_id = $4) AND ($5::bigint IS NULL OR mi.id = $5)
                AND ($6::bigint IS NULL OR x.requested_by = $6)
              GROUP BY mc.name)
     SELECT s.category, s.items, s.gross::text, s.promotions::text, s.manual::text, s.comps::text,
            COALESCE(r.refunds, 0)::text AS refunds, s.tracked_net::text, s.cogs::text
       FROM s LEFT JOIN r ON r.category = s.category
      ORDER BY s.gross - s.promotions - s.manual - s.comps DESC, s.category`,
    salesParams(f),
  );
  return rows.map((r) => ({ ...r, ...derive(decimals(r)) }));
}

function decimals(r: Raw): Record<string, Decimal | null> {
  const out: Record<string, Decimal | null> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)))
      out[k] = new Decimal(v);
  }
  return out;
}

/**
 * Menu engineering (popularity × contribution, the 70 % rule): an item is popular when its
 * share of items sold is at least 70 % of an equal share; profitable when its contribution
 * per unit (net − COGS) is at least the average. Only items sold with a recipe can be
 * classed; others say "No recipe".
 */
export async function menuEngineering(db: Queryable, f: SalesFilter): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `WITH ${LINES}
     SELECT item_id::text AS item_id, item, category, sum(billable_qty)::int AS items,
            sum(net)::text AS net, sum(cogs)::text AS cogs, bool_and(tracked)::int AS tracked
       FROM ln GROUP BY item_id, item, category
      ORDER BY sum(billable_qty) DESC, item`,
    salesParams(f),
  );
  const tracked = rows.filter((r) => r['tracked'] === 1);
  const totalQty = tracked.reduce((s, r) => s + Number(r['items']), 0);
  const totalContribution = tracked.reduce(
    (s, r) => s.plus(new Decimal(String(r['net']))).minus(new Decimal(String(r['cogs']))),
    new Decimal(0),
  );
  const avgUnit = totalQty === 0 ? new Decimal(0) : totalContribution.dividedBy(totalQty);
  const popularShare = tracked.length === 0 ? 0 : (0.7 / tracked.length) * 100;
  return rows.map((r) => {
    const qty = Number(r['items']);
    const contribution = new Decimal(String(r['net'])).minus(new Decimal(String(r['cogs'])));
    const unit = qty === 0 ? null : contribution.dividedBy(qty);
    const isTracked = r['tracked'] === 1;
    const share = isTracked && totalQty > 0 ? (qty / totalQty) * 100 : null;
    const popular = share !== null && share >= popularShare;
    const profitable = unit !== null && unit.greaterThanOrEqualTo(avgUnit);
    return {
      item_id: r['item_id'] ?? null,
      item: r['item'] ?? null,
      category: r['category'] ?? null,
      items: qty,
      share: share === null ? null : share.toFixed(2),
      contribution: isTracked ? contribution.toString() : null,
      unit_contribution: isTracked && unit !== null ? unit.toDecimalPlaces(2).toString() : null,
      class: !isTracked
        ? 'No recipe'
        : popular
          ? profitable
            ? 'Star'
            : 'Plowhorse'
          : profitable
            ? 'Puzzle'
            : 'Dog',
    };
  });
}

export const DISCOUNT_KINDS = ['promotion', 'discount', 'comp', 'refund'] as const;

/**
 * Every discount, comp and refund of the period, with who and why: promotions, manual
 * discounts and comps on the settlement date of their bill, refunds on their own date.
 */
export async function discountsAndRefunds(
  db: Queryable,
  f: {
    from: string;
    to: string;
    staffId?: string | undefined;
    kind?: (typeof DISCOUNT_KINDS)[number] | undefined;
  },
): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `SELECT * FROM (
       SELECT i.business_date::text AS date, i.invoice_no, i.id::text AS invoice_id, 'promotion' AS kind,
              'Scheduled promotion' AS reason, NULL::text AS by, NULL::text AS approved_by,
              sum(il.promotion_discount)::text AS amount, NULL::bigint AS staff
         FROM cl.invoices i JOIN cl.invoice_lines il ON il.invoice_id = i.id
        WHERE i.status = 'settled' AND i.business_date BETWEEN $1::date AND $2::date AND il.promotion_discount > 0
        GROUP BY i.id
       UNION ALL
       SELECT i.business_date::text, i.invoice_no, i.id::text, CASE d.kind WHEN 'comp' THEN 'comp' ELSE 'discount' END,
              d.reason, u.display_name, ap.display_name, d.amount::text, d.applied_by
         FROM cl.discount_applications d JOIN cl.invoices i ON i.id = d.invoice_id
         JOIN cl.users u ON u.id = d.applied_by
         LEFT JOIN cl.step_up_approvals sa ON sa.id = d.step_up_id LEFT JOIN cl.users ap ON ap.id = sa.approved_by
        WHERE i.status = 'settled' AND i.business_date BETWEEN $1::date AND $2::date
          AND d.voided_at IS NULL AND d.amount > 0
       UNION ALL
       SELECT r.business_date::text, i.invoice_no, i.id::text, 'refund', r.reason, u.display_name, ap.display_name,
              r.amount::text, r.requested_by
         FROM cl.refunds r JOIN cl.invoices i ON i.id = r.invoice_id
         JOIN cl.users u ON u.id = r.requested_by JOIN cl.users ap ON ap.id = r.approved_by
        WHERE r.kind = 'refund' AND r.business_date BETWEEN $1::date AND $2::date
     ) x
     WHERE ($3::bigint IS NULL OR x.staff = $3) AND ($4::text IS NULL OR x.kind = $4)
     ORDER BY x.date, x.invoice_no, x.kind`,
    [f.from, f.to, f.staffId ?? null, f.kind ?? null],
  );
  return rows.map((r) => {
    const out = { ...r };
    delete out['staff'];
    return out;
  });
}

/**
 * What came in by each method (as corrected) and what went back, on their own dates:
 * collected = taken − refunded, by cash, card and each transfer provider.
 */
export async function paymentMix(db: Queryable, f: { from: string; to: string }): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `WITH eff AS (
       SELECT p.id, p.amount, p.business_date,
              COALESCE(c.method, p.method) AS method,
              CASE WHEN c.id IS NOT NULL THEN c.transfer_provider ELSE p.transfer_provider END AS provider
         FROM cl.payments p
         LEFT JOIN LATERAL (SELECT r.id, r.method, r.transfer_provider FROM cl.refunds r
                             WHERE r.payment_id = p.id AND r.kind = 'method_correction'
                             ORDER BY r.id DESC LIMIT 1) c ON true
        WHERE p.business_date BETWEEN $1::date AND $2::date),
     ways AS (SELECT * FROM (VALUES ('cash', NULL, 1), ('card_manual', NULL, 2), ('transfer', 'bank', 3),
                                    ('transfer', 'jazzcash', 4), ('transfer', 'easypaisa', 5)) w(method, provider, sort)),
     taken AS (SELECT method, provider, count(*)::int AS payments, sum(amount) AS taken FROM eff GROUP BY method, provider),
     back AS (SELECT method, transfer_provider AS provider, count(*)::int AS refunds, sum(amount) AS refunded
                FROM cl.refunds WHERE kind = 'refund' AND business_date BETWEEN $1::date AND $2::date
               GROUP BY method, transfer_provider)
     SELECT CASE w.method WHEN 'cash' THEN 'Cash' WHEN 'card_manual' THEN 'Card'
                 ELSE CASE w.provider WHEN 'bank' THEN 'Bank transfer' WHEN 'jazzcash' THEN 'JazzCash' ELSE 'Easypaisa' END
            END AS method,
            COALESCE(t.payments, 0) AS payments, COALESCE(t.taken, 0)::text AS taken,
            COALESCE(b.refunds, 0) AS refunds, COALESCE(b.refunded, 0)::text AS refunded,
            (COALESCE(t.taken, 0) - COALESCE(b.refunded, 0))::text AS collected
       FROM ways w
       LEFT JOIN taken t ON t.method = w.method AND t.provider IS NOT DISTINCT FROM w.provider
       LEFT JOIN back b ON b.method = w.method AND b.provider IS NOT DISTINCT FROM w.provider
      ORDER BY w.sort`,
    [f.from, f.to],
  );
  return rows;
}

export const DELIVERY_STATUSES = [
  'pending_dispatch',
  'out_for_delivery',
  'delivered',
  'failed',
  'cancelled',
  'converted_to_pickup',
] as const;

/** Deliveries taken in the period, with their rider, outcome and bill (no customer details). */
export async function deliveries(
  db: Queryable,
  f: { from: string; to: string; riderId?: string | undefined; status?: string | undefined },
): Promise<Row[]> {
  const { rows } = await db.query<Raw>(
    `SELECT s.business_date::text AS date, s.session_no AS "order", d.channel, d.payment_mode,
            r.display_name AS rider, d.status, d.attempt AS attempts, 1 AS deliveries,
            CASE WHEN d.status = 'delivered' THEN 1 ELSE 0 END AS delivered,
            CASE WHEN i.status = 'open' THEN NULL ELSE i.total::text END AS bill,
            i.paid_total::text AS paid, d.refund_due::text
       FROM cl.delivery_orders d
       JOIN cl.dining_sessions s ON s.id = d.session_id
       JOIN cl.invoices i ON i.session_id = s.id
       LEFT JOIN cl.staff_profiles r ON r.id = d.rider_id
      WHERE s.business_date BETWEEN $1::date AND $2::date
        AND ($3::bigint IS NULL OR d.rider_id = $3) AND ($4::text IS NULL OR d.status = $4)
      ORDER BY s.business_date, d.id`,
    [f.from, f.to, f.riderId ?? null, f.status ?? null],
  );
  return rows;
}

/**
 * The recorded operating result as a statement (D-19): each line signed so that the lines
 * add up to the result; expenses by category.
 */
export async function operatingStatement(
  db: Queryable,
  f: { from: string; to: string },
): Promise<{ rows: Row[]; coverage: string | null; needsRecipes: boolean }> {
  const k = await salesKpis(db, { from: f.from, to: f.to });
  const neg = (v: string | number | null | undefined) =>
    v === null || v === undefined ? '0' : new Decimal(v).negated().toString();
  const { rows: expenses } = await db.query<{ category: string; amount: string }>(
    `SELECT c.name AS category, sum(e.amount)::text AS amount
       FROM cl.expenses e JOIN cl.expense_categories c ON c.id = e.category_id
      WHERE e.status = 'recorded' AND e.business_date BETWEEN $1::date AND $2::date
      GROUP BY c.name ORDER BY sum(e.amount) DESC, c.name`,
    [f.from, f.to],
  );
  const rows: Row[] = [
    { line: 'Net sales', group: 'Sales', amount: String(k['net_sales']) },
    { line: 'Cost of goods sold', group: 'Costs of sales', amount: neg(k['cogs']) },
    { line: 'Waste', group: 'Costs of sales', amount: neg(k['waste']) },
    { line: 'Stock variance', group: 'Costs of sales', amount: neg(k['variance']) },
    { line: 'Purchase price variance', group: 'Costs of sales', amount: neg(k['ppv']) },
    ...expenses.map((e) => ({
      line: e.category,
      group: 'Recorded expenses',
      amount: neg(e.amount),
    })),
  ];
  return {
    rows,
    coverage: k['coverage'] === null ? null : String(k['coverage']),
    needsRecipes: k['needs_recipes'] !== null,
  };
}
