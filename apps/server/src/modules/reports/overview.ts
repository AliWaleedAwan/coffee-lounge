/**
 * The owner overview (UI_UX.md §5 "headline tiles"; FINANCE_REPORTING.md §6; Phase 6 step
 * 6.2). Every figure comes from a report on the engine, so a tile equals the total of the
 * report it opens (AT-20, AC-RPT-1): Net sales, Orders and Average order from sales by day;
 * Gross margin %, Waste and the Recorded operating result too, with `reports.profit`.
 * Each tile is shown against the same weekday(s) a week earlier (P6-8). Also the days and
 * hours of the period, the top items by sales and (with `reports.profit`) by margin, and
 * what is open in the inboxes.
 */
import type { Queryable } from '../../platform/db/pool.ts';
import { salesByDayReport, salesByHourReport, salesByItemReport } from './catalog.ts';
import { runReport, shape, type Cell, type ColumnKind, type ReportContext } from './engine.ts';
import { sameDaysLastWeek, type Period } from './periods.ts';

interface Tile {
  key: string;
  label: string;
  kind: ColumnKind;
  value: Cell;
  compare: Cell;
  /** Change against the comparison, in %, when both are numbers and the comparison is not 0. */
  change: string | null;
  /** The report the tile opens, and its column. */
  report: string;
  note: string | null;
}

const TILES: readonly { key: string; label: string; kind: ColumnKind; profit?: true }[] = [
  { key: 'net_sales', label: 'Net sales', kind: 'money' },
  { key: 'orders', label: 'Orders', kind: 'int' },
  { key: 'aov', label: 'Average order', kind: 'money' },
  { key: 'margin', label: 'Gross margin % (after waste)', kind: 'pct', profit: true },
  { key: 'waste', label: 'Waste cost', kind: 'cost', profit: true },
  { key: 'operating_result', label: 'Recorded operating result', kind: 'money', profit: true },
];

function change(value: Cell, compare: Cell): string | null {
  if (value === null || compare === null) return null;
  const before = Number(compare);
  if (before === 0) return null;
  return (((Number(value) - before) / Math.abs(before)) * 100).toFixed(1);
}

export async function overview(db: Queryable, ctx: ReportContext, period: Period) {
  const compare = sameDaysLastWeek(period);
  const profit = ctx.can('reports.profit');
  const [days, before, hours, items] = [
    await runReport(salesByDayReport, ctx, period),
    await runReport(salesByDayReport, ctx, compare),
    await runReport(salesByHourReport, ctx, period),
    await runReport(salesByItemReport, ctx, period),
  ];
  const tiles: Tile[] = TILES.filter((t) => !t.profit || profit).map((t) => {
    const value = days.totals[t.key] ?? null;
    const was = before.totals[t.key] ?? null;
    return {
      key: t.key,
      label: t.label,
      kind: t.kind,
      value,
      compare: was,
      change: change(value, was),
      report: 'sales-by-day',
      note:
        t.key === 'operating_result' && days.totals['needs_recipes']
          ? 'Needs recipes: costs are missing for more than 5 % of sales'
          : t.key === 'margin' &&
              days.totals['coverage'] !== null &&
              Number(days.totals['coverage']) < 100
            ? `Over recipe items only (COGS coverage ${String(days.totals['coverage'])} %)`
            : null,
    };
  });
  const top = items.rows.slice(0, 10).map((r) => ({
    item: r['item'],
    items: r['items'],
    net_sales: r['net_sales'],
    ...(profit ? { margin: r['margin'] } : {}),
  }));
  const byMargin = profit
    ? items.rows
        .filter((r) => r['margin'] !== null)
        .sort((a, b) => Number(b['margin']) - Number(a['margin']))
        .slice(0, 5)
        .map((r) => ({
          item: r['item'],
          items: r['items'],
          net_sales: r['net_sales'],
          margin: r['margin'],
        }))
    : null;
  const { rows: open } = await db.query<{ operational: number; stock: number; ledger: number }>(
    `SELECT (SELECT count(*)::int FROM cl.operational_alerts WHERE state <> 'resolved' AND kind <> 'ledger_mismatch') AS operational,
            (SELECT count(*)::int FROM cl.inventory_alerts WHERE state = 'open') AS stock,
            (SELECT count(*)::int FROM cl.operational_alerts WHERE state <> 'resolved' AND kind = 'ledger_mismatch') AS ledger`,
  );
  return {
    period,
    compare,
    tiles,
    coverage: profit ? shape('pct', days.totals['coverage']) : null,
    byDay: days.rows.map((r) => ({
      date: r['date'],
      net_sales: r['net_sales'],
      orders: r['orders'],
    })),
    byHour: hours.rows.map((r) => ({ hour: r['hour'], sales: r['sales'], orders: r['orders'] })),
    topItems: top,
    topByMargin: byMargin,
    alerts: open[0] ?? { operational: 0, stock: 0, ledger: 0 },
  };
}
