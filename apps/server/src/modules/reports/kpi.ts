/**
 * KPIs (FINANCE_REPORTING.md §2–3; D-19, D-21, D-29; Phase 6 step 6.1), computed per
 * business date from the rows they come from:
 *  - sales on the invoice's settlement date (lines: gross, promotions, manual discounts and
 *    their share of bill discounts, comps), refunds on the refund's date, payments on the
 *    payment's date;
 *  - COGS of each sold line = its frozen consumption cost less the cost of units voided
 *    after pickup (COST_VALUATION.md §7), on the invoice's date;
 *  - waste, stock variance, purchase price variance and expenses on their own dates.
 * A period's figures are the sums of its days; ratios (AOV, coverage, margin) and the
 * recorded operating result are worked out from those sums.
 */
import { Decimal } from '@cl/shared';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Cell, Row } from './engine.ts';

export const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'] as const;

export interface SalesFilter {
  from: string;
  to: string;
  orderType?: (typeof ORDER_TYPES)[number] | undefined;
  categoryId?: string | undefined;
  itemId?: string | undefined;
  /** Who settled the bill (for refunds: who asked for them). */
  staffId?: string | undefined;
}

/** Waste, variance, expenses and rounding belong to the shop, not to an item or order type. */
export const shopWide = (f: SalesFilter) =>
  !f.orderType && !f.categoryId && !f.itemId && !f.staffId;

/** The query parameters every sales query shares ($1…$6). */
export const salesParams = (f: SalesFilter) => [
  f.from,
  f.to,
  f.orderType ?? null,
  f.categoryId ?? null,
  f.itemId ?? null,
  f.staffId ?? null,
];

/** COGS coverage below which the operating result is not shown (FINANCE_REPORTING.md §3). */
export const OPERATING_RESULT_MIN_COVERAGE = 95;

export const LINES = `
  inv AS (
    SELECT i.id, i.business_date AS d, i.rounding_adjustment, i.settled_at
      FROM cl.invoices i JOIN cl.dining_sessions s ON s.id = i.session_id
     WHERE i.status = 'settled' AND i.business_date BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR s.order_type = $3) AND ($6::bigint IS NULL OR i.settled_by = $6)),
  ln AS (
    SELECT inv.d, inv.settled_at, inv.id AS invoice_id, mi.id AS item_id, mi.name AS item, mc.name AS category,
           il.billable_qty, il.gross, il.promotion_discount, il.discount_alloc, il.net, il.is_comp,
           CASE WHEN il.is_comp THEN 0 ELSE il.manual_discount END AS manual,
           CASE WHEN il.is_comp THEN il.manual_discount ELSE 0 END AS comp,
           ol.stock_mode_snap = 'recipe' AS tracked,
           CASE WHEN ol.qty_picked_up > 0
                THEN c.consumption - c.consumption * ol.qty_cancelled_prepared / ol.qty_picked_up
                ELSE 0 END AS cogs
      FROM inv
      JOIN cl.invoice_lines il ON il.invoice_id = inv.id
      JOIN cl.order_lines ol ON ol.id = il.order_line_id
      JOIN cl.menu_variants v ON v.id = ol.variant_id
      JOIN cl.menu_items mi ON mi.id = v.item_id
      JOIN cl.menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN LATERAL (SELECT COALESCE(sum(x.value), 0) AS consumption
                           FROM cl.order_line_costs x WHERE x.order_line_id = ol.id) c ON true
     WHERE il.billable_qty > 0
       AND ($4::bigint IS NULL OR mi.category_id = $4) AND ($5::bigint IS NULL OR mi.id = $5)),
  rf AS (
    -- Refunds on their own date; by item only as far as their lines say (lines are optional).
    SELECT r.business_date AS d,
           CASE WHEN $4::bigint IS NULL AND $5::bigint IS NULL THEN r.amount
                ELSE (SELECT COALESCE(sum(rl.amount), 0) FROM cl.refund_lines rl
                        JOIN cl.invoice_lines il ON il.id = rl.invoice_line_id
                        JOIN cl.order_lines ol ON ol.id = il.order_line_id
                        JOIN cl.menu_variants v ON v.id = ol.variant_id
                        JOIN cl.menu_items mi ON mi.id = v.item_id
                       WHERE rl.refund_id = r.id
                         AND ($4::bigint IS NULL OR mi.category_id = $4) AND ($5::bigint IS NULL OR mi.id = $5))
           END AS amount
      FROM cl.refunds r JOIN cl.invoices i ON i.id = r.invoice_id JOIN cl.dining_sessions s ON s.id = i.session_id
     WHERE r.kind = 'refund' AND r.business_date BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR s.order_type = $3) AND ($6::bigint IS NULL OR r.requested_by = $6))`;

/** One row per business date of the period, every date present (zeros on quiet days). */
export async function salesByDay(db: Queryable, f: SalesFilter): Promise<Row[]> {
  const whole = shopWide(f);
  const { rows } = await db.query<Record<string, string | number | null>>(
    `WITH ${LINES},
       days AS (SELECT g::date AS d FROM generate_series($1::date, $2::date, interval '1 day') g),
       s AS (SELECT d, count(DISTINCT invoice_id)::int AS orders, sum(billable_qty)::int AS items,
                    sum(gross) AS gross, sum(promotion_discount) AS promotions,
                    sum(manual + discount_alloc) AS manual, sum(comp) AS comps,
                    COALESCE(sum(net) FILTER (WHERE tracked), 0) AS tracked_net, sum(cogs) AS cogs
               FROM ln GROUP BY d),
       r AS (SELECT d, sum(amount) AS refunds FROM rf GROUP BY d),
       rd AS (SELECT d, sum(rounding_adjustment) AS rounding FROM inv GROUP BY d),
       pay AS (SELECT p.business_date AS d, sum(p.amount) AS paid
                 FROM cl.payments p JOIN cl.invoices i ON i.id = p.invoice_id
                 JOIN cl.dining_sessions ss ON ss.id = i.session_id
                WHERE p.business_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR ss.order_type = $3)
                GROUP BY p.business_date),
       w AS (SELECT business_date AS d, sum(cost_value) AS waste FROM cl.wastage_records
              WHERE business_date BETWEEN $1::date AND $2::date GROUP BY business_date),
       sv AS (SELECT business_date AS d, -sum(value_delta) AS variance FROM cl.stock_movements
               WHERE movement_type = 'count_adjustment' AND business_date BETWEEN $1::date AND $2::date
               GROUP BY business_date),
       pv AS (SELECT business_date AS d, sum(to_variance) AS ppv FROM cl.cost_adjustments
               WHERE business_date BETWEEN $1::date AND $2::date GROUP BY business_date),
       ex AS (SELECT business_date AS d, sum(amount) AS expenses FROM cl.expenses
               WHERE status = 'recorded' AND business_date BETWEEN $1::date AND $2::date GROUP BY business_date)
     SELECT days.d::text AS date,
            COALESCE(s.orders, 0) AS orders, COALESCE(s.items, 0) AS items,
            COALESCE(s.gross, 0)::text AS gross, COALESCE(s.promotions, 0)::text AS promotions,
            COALESCE(s.manual, 0)::text AS manual, COALESCE(s.comps, 0)::text AS comps,
            COALESCE(r.refunds, 0)::text AS refunds,
            COALESCE(s.tracked_net, 0)::text AS tracked_net, COALESCE(s.cogs, 0)::text AS cogs,
            CASE WHEN $7 THEN COALESCE(rd.rounding, 0)::text END AS rounding,
            CASE WHEN $5::bigint IS NULL AND $4::bigint IS NULL AND $6::bigint IS NULL THEN COALESCE(pay.paid, 0)::text END AS paid,
            CASE WHEN $7 THEN COALESCE(w.waste, 0)::text END AS waste,
            CASE WHEN $7 THEN COALESCE(sv.variance, 0)::text END AS variance,
            CASE WHEN $7 THEN COALESCE(pv.ppv, 0)::text END AS ppv,
            CASE WHEN $7 THEN COALESCE(ex.expenses, 0)::text END AS expenses
       FROM days
       LEFT JOIN s ON s.d = days.d LEFT JOIN r ON r.d = days.d LEFT JOIN rd ON rd.d = days.d
       LEFT JOIN pay ON pay.d = days.d LEFT JOIN w ON w.d = days.d LEFT JOIN sv ON sv.d = days.d
       LEFT JOIN pv ON pv.d = days.d LEFT JOIN ex ON ex.d = days.d
      ORDER BY days.d`,
    [...salesParams(f), whole],
  );
  return rows.map((r) => withDerived(r));
}

/** Sold menu items of the period, best sellers first. */
export async function salesByItem(db: Queryable, f: SalesFilter): Promise<Row[]> {
  const { rows } = await db.query<Record<string, string | number | null>>(
    `WITH ${LINES},
       s AS (SELECT item_id, item, category, count(DISTINCT invoice_id)::int AS orders,
                    sum(billable_qty)::int AS items, sum(gross) AS gross, sum(promotion_discount) AS promotions,
                    sum(manual + discount_alloc) AS manual, sum(comp) AS comps,
                    COALESCE(sum(net) FILTER (WHERE tracked), 0) AS tracked_net, sum(cogs) AS cogs
               FROM ln GROUP BY item_id, item, category),
       r AS (SELECT mi.id AS item_id, sum(rl.amount) AS refunds
               FROM cl.refunds x
               JOIN cl.refund_lines rl ON rl.refund_id = x.id
               JOIN cl.invoices i ON i.id = x.invoice_id
               JOIN cl.dining_sessions ss ON ss.id = i.session_id
               JOIN cl.invoice_lines il ON il.id = rl.invoice_line_id
               JOIN cl.order_lines ol ON ol.id = il.order_line_id
               JOIN cl.menu_variants v ON v.id = ol.variant_id
               JOIN cl.menu_items mi ON mi.id = v.item_id
              WHERE x.kind = 'refund' AND x.business_date BETWEEN $1::date AND $2::date
                AND ($3::text IS NULL OR ss.order_type = $3)
                AND ($4::bigint IS NULL OR mi.category_id = $4) AND ($5::bigint IS NULL OR mi.id = $5)
                AND ($6::bigint IS NULL OR x.requested_by = $6)
              GROUP BY mi.id)
     SELECT s.item_id::text AS item_id, s.item, s.category, s.orders, s.items,
            s.gross::text, s.promotions::text, s.manual::text, s.comps::text,
            COALESCE(r.refunds, 0)::text AS refunds, s.tracked_net::text AS tracked_net, s.cogs::text AS cogs
       FROM s LEFT JOIN r ON r.item_id = s.item_id
      ORDER BY s.gross - s.promotions - s.manual - s.comps DESC, s.item, s.item_id`,
    salesParams(f),
  );
  return rows.map((r) => withDerived(r));
}

/**
 * Sales by the shop's clock hour of settlement, over the period's business dates (FINANCE_REPORTING
 * §1: hourly charts use local clock hours), in business-day order from the 04:00 cutoff. Lines
 * after discounts; refunds belong to their own date, not to an hour, so they are not here.
 */
export async function salesByHour(db: Queryable, f: SalesFilter): Promise<Row[]> {
  const { rows } = await db.query<Record<string, string | number | null>>(
    `WITH ${LINES},
       tz AS (SELECT value #>> '{}' AS zone FROM cl.system_settings WHERE key = 'shop.timezone'),
       cut AS (SELECT extract(hour FROM (value #>> '{}')::time)::int AS h FROM cl.system_settings
                WHERE key = 'shop.business_day_cutoff'),
       hours AS (SELECT g AS h FROM generate_series(0, 23) g),
       s AS (SELECT extract(hour FROM ln.settled_at AT TIME ZONE tz.zone)::int AS h,
                    count(DISTINCT invoice_id)::int AS orders, sum(billable_qty)::int AS items,
                    sum(gross) AS gross, sum(promotion_discount) AS promotions,
                    sum(manual + discount_alloc) AS manual, sum(comp) AS comps
               FROM ln CROSS JOIN tz GROUP BY 1)
     SELECT lpad(hours.h::text, 2, '0') || ':00' AS hour,
            COALESCE(s.orders, 0) AS orders, COALESCE(s.items, 0) AS items,
            COALESCE(s.gross, 0)::text AS gross,
            (COALESCE(s.promotions, 0) + COALESCE(s.manual, 0) + COALESCE(s.comps, 0))::text AS discounts,
            (COALESCE(s.gross, 0) - COALESCE(s.promotions, 0) - COALESCE(s.manual, 0) - COALESCE(s.comps, 0))::text
              AS sales
       FROM hours CROSS JOIN cut LEFT JOIN s ON s.h = hours.h
      ORDER BY (hours.h - cut.h + 24) % 24`,
    salesParams(f),
  );
  return rows;
}

const dec = (v: Cell | undefined): Decimal | null =>
  v === null || v === undefined || v === '' ? null : new Decimal(v);
const str = (d: Decimal | null): string | null => (d === null ? null : d.toString());
const pct = (part: Decimal, whole: Decimal): string | null =>
  whole.isZero() ? null : part.dividedBy(whole).times(100).toDecimalPlaces(2).toString();

/**
 * The figures every sales row and total share, from the summed ones (FINANCE_REPORTING.md
 * §3): discounts, net sales, AOV, COGS coverage, gross profit after waste, margin (over
 * recipe lines only while coverage is below 100 %), and the recorded operating result
 * (only at 95 % coverage or more, otherwise "Needs recipes").
 */
export function derive(v: Record<string, Decimal | null>): Record<string, Cell> {
  const zero = new Decimal(0);
  const gross = v['gross'] ?? zero;
  const discounts = (v['promotions'] ?? zero).plus(v['manual'] ?? zero).plus(v['comps'] ?? zero);
  const before = gross.minus(discounts); // net of lines, before refunds
  const refunds = v['refunds'] ?? zero;
  const net = before.minus(refunds);
  const orders = v['orders'] ?? zero;
  const cogs = v['cogs'] ?? zero;
  const tracked = v['tracked_net'] ?? zero;
  const losses =
    v['waste'] === null && v['variance'] === null && v['ppv'] === null
      ? null
      : (v['waste'] ?? zero).plus(v['variance'] ?? zero).plus(v['ppv'] ?? zero);
  const grossProfit = net.minus(cogs).minus(losses ?? zero);
  const coverage = before.isZero() ? null : tracked.dividedBy(before).times(100);
  const complete = coverage === null || coverage.greaterThanOrEqualTo(100);
  const margin = complete
    ? pct(grossProfit, net)
    : pct(tracked.minus(cogs).minus(losses ?? zero), tracked);
  const expenses = v['expenses'] ?? null;
  const enough = coverage === null || coverage.greaterThanOrEqualTo(OPERATING_RESULT_MIN_COVERAGE);
  return {
    discounts: discounts.toString(),
    net_sales: net.toString(),
    aov: orders.isZero() ? null : before.dividedBy(orders).toDecimalPlaces(2).toString(),
    coverage: coverage === null ? null : coverage.toDecimalPlaces(2).toString(),
    gross_profit: grossProfit.toString(),
    margin,
    collected:
      v['paid'] === null || v['paid'] === undefined ? null : v['paid'].minus(refunds).toString(),
    operating_result: expenses === null || !enough ? null : grossProfit.minus(expenses).toString(),
    needs_recipes: expenses !== null && !enough ? 'Needs recipes' : null,
  };
}

function withDerived(r: Record<string, string | number | null>): Row {
  const values: Record<string, Decimal | null> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)))
      values[k] = dec(v);
  }
  return { ...r, ...derive(values) };
}

/** The KPI tiles of a period: the totals of its days, then the derived figures. */
export async function salesKpis(db: Queryable, f: SalesFilter): Promise<Record<string, Cell>> {
  const days = await salesByDay(db, f);
  const keys = [
    'orders',
    'items',
    'gross',
    'promotions',
    'manual',
    'comps',
    'refunds',
    'tracked_net',
    'cogs',
    'rounding',
    'paid',
    'waste',
    'variance',
    'ppv',
    'expenses',
  ];
  const sums: Record<string, Decimal | null> = {};
  for (const k of keys) {
    let total: Decimal | null = null;
    for (const d of days) {
      const v = d[k];
      if (v !== null && v !== undefined) total = (total ?? new Decimal(0)).plus(new Decimal(v));
    }
    sums[k] = total;
  }
  return {
    ...Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, str(v)])),
    ...derive(sums),
  };
}
