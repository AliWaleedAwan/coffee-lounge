/**
 * The day-end report (FINANCE_REPORTING.md §7; P6-9; Phase 6 step 6.5; AT-122). One fixed
 * report per completed business date: the worker makes it after the 04:00 cutoff (or the
 * first request does, if the worker missed it) and stores it, so the screen, the PDF, the
 * 80 mm print and the e-mail show the same numbers. Its figures come from the same report
 * definitions as the screens (AC-RPT-1): sales by day, by order type, payment mix and the
 * top items; plus what stood open when the day ended (bills, rider cash, alerts), the cash
 * shifts of the day, voids and waste. Costs and margins are stored, and shown only with
 * `reports.profit`.
 */
import { AppError } from '../../platform/errors.ts';
import { businessDateOf } from '../../platform/settings.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import { paymentMixReport, salesByDayReport, salesByItemReport } from './catalog.ts';
import { runReport, type Cell, type ReportContext } from './engine.ts';
import { salesKpis } from './kpi.ts';
import { addDays } from './periods.ts';

type Text = string | null;

export interface DayEnd {
  date: string;
  sales: {
    orders: number;
    items: number;
    gross: string;
    promotions: string;
    manual: string;
    comps: string;
    discounts: string;
    refunds: string;
    net_sales: string;
    rounding: string;
    aov: Text;
    collected: Text;
  };
  byOrderType: { type: string; label: string; orders: number; net_sales: string }[];
  payments: {
    method: string;
    payments: number;
    taken: string;
    refunded: string;
    collected: string;
  }[];
  openBills: { count: number; value: string };
  cod: { rider: string; deliveries: number; amount: string }[];
  shifts: {
    till: string;
    cashier: string;
    status: string;
    expected: Text;
    counted: Text;
    variance: Text;
    reason: Text;
    approved_by: Text;
  }[];
  voids: { events: number; units: number; value: string };
  waste: { records: number; cost: Text };
  topItems: { item: string; items: number; net_sales: string; margin: Text }[];
  /** Costs and margins (FINANCE_REPORTING.md §3); null for those without `reports.profit`. */
  profit: {
    cogs: Text;
    coverage: Text;
    waste: Text;
    variance: Text;
    gross_profit: Text;
    margin: Text;
    operating_result: Text;
    needs_recipes: Text;
  } | null;
  alerts: { kind: string; label: string; open: number }[];
}

export interface StoredDayEnd {
  date: string;
  generatedAt: string;
  generatedBy: 'worker' | 'on_request';
  report: DayEnd;
}

const ORDER_TYPES = [
  { type: 'dine_in', label: 'Dine-in' },
  { type: 'takeaway', label: 'Takeaway' },
  { type: 'delivery', label: 'Delivery' },
] as const;

const ALERT_LABELS: Record<string, string> = {
  low: 'Stock low',
  zero: 'Out of stock',
  near_expiry: 'Near expiry',
  expired: 'Expired lots',
  overstock: 'Overstock',
  reservation_shortfall: 'Not enough stock for orders',
  stale_reservation: 'Stock held too long',
  balance_mismatch: 'Stock balance mismatch',
  found_stock: 'Stock found at a count',
  stale_session: 'Tables open too long',
  uncollected_item: 'Items not picked up',
  failed_delivery: 'Failed deliveries',
  refund_due: 'Refunds due',
  ledger_mismatch: 'Ledger mismatch',
};

const s = (v: Cell | undefined): string => (v === null || v === undefined ? '0' : String(v));
const t = (v: Cell | undefined): Text => (v === null || v === undefined ? null : String(v));

/** Works the day-end out from the data as it stands (every figure, costs included). */
export async function buildDayEnd(db: Queryable, date: string): Promise<DayEnd> {
  const period = { from: date, to: date };
  const ctx: ReportContext = { db, can: () => true, today: date };
  const kpis = await salesKpis(db, period);
  const day = (await runReport(salesByDayReport, ctx, period)).totals;
  const byOrderType = [];
  for (const o of ORDER_TYPES) {
    const totals = (await runReport(salesByDayReport, ctx, { ...period, orderType: o.type }))
      .totals;
    byOrderType.push({
      type: o.type,
      label: o.label,
      orders: Number(totals['orders'] ?? 0),
      net_sales: s(totals['net_sales']),
    });
  }
  const mix = await runReport(paymentMixReport, ctx, period);
  const items = await runReport(salesByItemReport, ctx, period);

  // Bills begun by the end of the day and not settled within it (settled later, or still open).
  const { rows: open } = await db.query<{ count: number; value: string }>(
    `SELECT count(*)::int AS count, COALESCE(sum(i.total - i.paid_total), 0)::text AS value
       FROM cl.invoices i
      WHERE i.total > 0 AND cl.shop_business_date(i.created_at) <= $1::date
        AND (i.status <> 'settled' OR i.business_date > $1::date)`,
    [date],
  );
  const { rows: cod } = await db.query<{ rider: string; deliveries: number; amount: string }>(
    `SELECT r.display_name AS rider, count(*)::int AS deliveries, sum(i.total - i.paid_total)::text AS amount
       FROM cl.delivery_orders d JOIN cl.staff_profiles r ON r.id = d.rider_id
       JOIN cl.invoices i ON i.session_id = d.session_id
      WHERE d.status = 'out_for_delivery' AND d.payment_mode <> 'prepaid' AND i.status = 'locked'
      GROUP BY r.id, r.display_name ORDER BY r.display_name, r.id`,
  );
  const { rows: shifts } = await db.query<DayEnd['shifts'][number]>(
    `SELECT t.name AS till, u.display_name AS cashier, s.status,
            COALESCE(s.expected_cash, f.expected_cash)::text AS expected, s.counted_cash::text AS counted,
            s.variance::text, s.variance_reason AS reason, ab.display_name AS approved_by
       FROM cl.cash_shifts s JOIN cl.cash_shift_figures f ON f.shift_id = s.id
       JOIN cl.tills t ON t.id = s.till_id JOIN cl.users u ON u.id = s.cashier_user_id
       LEFT JOIN cl.users ab ON ab.id = s.approved_by
      WHERE cl.shop_business_date(s.opened_at) = $1::date
      ORDER BY s.opened_at, s.id`,
    [date],
  );
  const { rows: voids } = await db.query<{ events: number; units: number; value: string }>(
    `SELECT count(*)::int AS events, COALESCE(sum(e.qty), 0)::int AS units,
            COALESCE(sum(e.qty * (COALESCE(l.unit_price, l.unit_price_quoted) + l.modifiers_unit_total)), 0)::text AS value
       FROM cl.order_events e JOIN cl.order_lines l ON l.id = e.line_id
      WHERE e.event_type IN ('voided','cancelled_made','cancelled_unmade')
        AND cl.shop_business_date(e.occurred_at) = $1::date`,
    [date],
  );
  const { rows: waste } = await db.query<{ records: number }>(
    'SELECT count(*)::int AS records FROM cl.wastage_records WHERE business_date = $1::date',
    [date],
  );
  const { rows: alerts } = await db.query<{ kind: string; open: number }>(
    `SELECT kind, count(*)::int AS open FROM (
       SELECT kind FROM cl.inventory_alerts WHERE state <> 'resolved'
       UNION ALL SELECT kind FROM cl.operational_alerts WHERE state <> 'resolved') a
      GROUP BY kind ORDER BY kind`,
  );

  return {
    date,
    sales: {
      orders: Number(kpis['orders'] ?? 0),
      items: Number(kpis['items'] ?? 0),
      gross: s(day['gross']),
      promotions: s(kpis['promotions']),
      manual: s(kpis['manual']),
      comps: s(kpis['comps']),
      discounts: s(day['discounts']),
      refunds: s(day['refunds']),
      net_sales: s(day['net_sales']),
      rounding: s(day['rounding']),
      aov: t(day['aov']),
      collected: t(day['collected']),
    },
    byOrderType,
    payments: mix.rows.map((r) => ({
      method: String(r['method']),
      payments: Number(r['payments'] ?? 0),
      taken: s(r['taken']),
      refunded: s(r['refunded']),
      collected: s(r['collected']),
    })),
    openBills: { count: open[0]?.count ?? 0, value: s(open[0]?.value) },
    cod,
    shifts,
    voids: voids[0] ?? { events: 0, units: 0, value: '0' },
    waste: { records: waste[0]?.records ?? 0, cost: t(day['waste']) },
    topItems: items.rows.slice(0, 10).map((r) => ({
      item: String(r['item']),
      items: Number(r['items'] ?? 0),
      net_sales: s(r['net_sales']),
      margin: t(r['margin']),
    })),
    profit: {
      cogs: t(day['cogs']),
      coverage: t(day['coverage']),
      waste: t(day['waste']),
      variance: t(day['variance']),
      gross_profit: t(day['gross_profit']),
      margin: t(day['margin']),
      operating_result: t(day['operating_result']),
      needs_recipes: t(day['needs_recipes']),
    },
    alerts: alerts.map((a) => ({
      kind: a.kind,
      label: ALERT_LABELS[a.kind] ?? a.kind,
      open: a.open,
    })),
  };
}

interface DayEndRow {
  id: string;
  business_date: string;
  data: DayEnd;
  generated_by: 'worker' | 'on_request';
  generated_at: Date;
}

async function stored(db: Queryable, date: string): Promise<DayEndRow | null> {
  const { rows } = await db.query<DayEndRow>(
    `SELECT id::text, business_date::text, data, generated_by, generated_at
       FROM cl.day_end_reports WHERE business_date = $1::date`,
    [date],
  );
  return rows[0] ?? null;
}

/**
 * The day-end of a completed business date: the stored one, or made and stored now. Two
 * makers at once both work it out; the first insert wins and both return that one.
 */
export async function dayEndOf(
  db: Queryable,
  date: string,
  today: string,
  by: 'worker' | 'on_request',
): Promise<StoredDayEnd & { id: string }> {
  if (date >= today) {
    throw new AppError(
      'VALIDATION_FAILED',
      'The day-end is made once the business day is over (after 04:00 the next morning)',
    );
  }
  let row = await stored(db, date);
  if (!row) {
    const data = await buildDayEnd(db, date);
    await db.query(
      `INSERT INTO cl.day_end_reports (business_date, data, generated_by) VALUES ($1::date, $2, $3)
       ON CONFLICT (business_date) DO NOTHING`,
      [date, JSON.stringify(data), by],
    );
    row = await stored(db, date);
  }
  if (!row) throw new Error(`day-end for ${date} was not stored`);
  return {
    id: row.id,
    date: row.business_date,
    generatedAt: row.generated_at.toISOString(),
    generatedBy: row.generated_by,
    report: row.data,
  };
}

/** What a person may see of it: costs and margins only with `reports.profit`. */
export function dayEndView(d: DayEnd, canProfit: boolean): DayEnd {
  if (canProfit) return d;
  return {
    ...d,
    waste: { ...d.waste, cost: null },
    topItems: d.topItems.map((i) => ({ ...i, margin: null })),
    profit: null,
  };
}

/** The business date the worker closes after the cutoff: yesterday's. */
export const completedDay = (today: string): string => addDays(today, -1);

/** The worker's nightly run: the day that just ended, made if it is not there yet. */
export async function closeDay(db: Queryable, at: Date): Promise<StoredDayEnd> {
  const today = await businessDateOf(db, at);
  return dayEndOf(db, completedDay(today), today, 'worker');
}
