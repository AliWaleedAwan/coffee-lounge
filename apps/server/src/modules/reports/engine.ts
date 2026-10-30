/**
 * The report engine (FINANCE_REPORTING.md §6; P6-2; Phase 6 step 6.1). A report is one
 * definition: its filters, its columns and one query that returns its rows. Totals are
 * worked out here, from those same rows (sums at full precision, rounded only for
 * display), and ratios from the totals, so a tile, its rows, the CSV and the PDF can never
 * disagree (AC-RPT-1). Columns that show costs or margins need `reports.profit`; without it
 * they are left out of rows, totals and footer alike.
 */
import { Decimal } from '@cl/shared';
import type { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Period } from './periods.ts';

export type ColumnKind = 'date' | 'text' | 'int' | 'money' | 'cost' | 'pct' | 'qty';

export interface Column {
  key: string;
  label: string;
  kind: ColumnKind;
  /** Shown only to those with `reports.profit` (costs, margins, coverage). */
  profit?: boolean;
  /** Shown only with this permission (e.g. stock values with `inventory.cost_view`). */
  needs?: string;
  /** How the total is made: summed (default for numbers), worked out from other totals, or none. */
  total?: 'sum' | 'derived' | 'none';
  /** The formula, printed in the footer (FINANCE_REPORTING.md §6). */
  formula?: string;
}

/** A cell: numbers travel as decimal strings at full precision; null = not applicable. */
export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface ReportContext {
  db: Queryable;
  can: (permission: string) => boolean;
  /** Today's business date (for "to date" defaults). */
  today: string;
}

export interface ReportDefinition<F extends { from: string; to: string }> {
  key: string;
  title: string;
  /** The permission to open the report at all. */
  permission: string;
  filters: z.ZodType<F>;
  columns: readonly Column[];
  /** A row field passed through as `id`, for drilling down (e.g. the item's id). */
  rowId?: string;
  /** Row fields summed for `derive` without being shown (e.g. promotions, recipe sales). */
  sumAlso?: readonly string[];
  /** The rows, in display order. */
  rows: (ctx: ReportContext, filters: F) => Promise<Row[]>;
  /** Derived totals (ratios, results) from the summed ones. */
  derive?: (totals: Record<string, Decimal | null>, ctx: ReportContext) => Record<string, Cell>;
  /** Notes printed with the report, e.g. COGS coverage. */
  notes?: (totals: Record<string, Decimal | null>, filters: F) => string[];
}

export interface Report {
  key: string;
  title: string;
  period: Period;
  filters: Record<string, string>;
  columns: Column[];
  rows: Row[];
  totals: Row;
  footer: {
    period: string;
    businessDay: string;
    filters: string[];
    formulas: { column: string; formula: string }[];
    notes: string[];
    generatedAt: string;
  };
}

const NUMERIC: readonly ColumnKind[] = ['int', 'money', 'cost', 'pct', 'qty'];

/** One shape per kind: money and percentages with 2 decimals, costs at full precision. */
export function shape(kind: ColumnKind, v: Cell | undefined): Cell {
  if (v === null || v === undefined || v === '') return null;
  if (kind === 'money' || kind === 'pct') return new Decimal(v).toFixed(2);
  if (kind === 'cost' || kind === 'qty') return new Decimal(v).toString();
  if (kind === 'int') return Number(v);
  return v;
}

/** Σ of a column at full precision; null when every row is null (not applicable). */
export function sumColumn(rows: readonly Row[], key: string): Decimal | null {
  let total: Decimal | null = null;
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined || v === '') continue;
    total = (total ?? new Decimal(0)).plus(new Decimal(v));
  }
  return total;
}

export async function runReport<F extends { from: string; to: string }>(
  def: ReportDefinition<F>,
  ctx: ReportContext,
  filters: F,
  labels: Record<string, string> = {},
): Promise<Report> {
  const visible = def.columns.filter(
    (c) => (!c.profit || ctx.can('reports.profit')) && (!c.needs || ctx.can(c.needs)),
  );
  const raw = await def.rows(ctx, filters);
  const rows = raw.map((r) => ({
    ...(def.rowId ? { id: r[def.rowId] ?? null } : {}),
    ...Object.fromEntries(visible.map((c) => [c.key, shape(c.kind, r[c.key])])),
  }));
  const sums: Record<string, Decimal | null> = {};
  for (const c of def.columns) {
    if (NUMERIC.includes(c.kind) && (c.total ?? 'sum') === 'sum')
      sums[c.key] = sumColumn(raw, c.key);
  }
  for (const key of def.sumAlso ?? []) sums[key] = sumColumn(raw, key);
  const derived = def.derive?.(sums, ctx) ?? {};
  const totals: Row = {};
  for (const c of visible) {
    if (c.total === 'derived') totals[c.key] = shape(c.kind, derived[c.key]);
    else if (c.total === 'none' || !NUMERIC.includes(c.kind)) totals[c.key] = null;
    else totals[c.key] = shape(c.kind, sums[c.key]?.toString());
  }
  const { from, to, ...rest } = filters as Record<string, unknown> & { from: string; to: string };
  const shown = Object.entries(rest).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return {
    key: def.key,
    title: def.title,
    period: { from, to },
    filters: Object.fromEntries(shown.map(([k, v]) => [k, String(v)])),
    columns: visible,
    rows,
    totals,
    footer: {
      period: from === to ? `Business date ${from}` : `Business dates ${from} to ${to}`,
      businessDay: 'A business day runs from 04:00 to 03:59 the next morning (Asia/Karachi, D-22)',
      filters: shown.map(([k, v]) => `${k}: ${labels[k] ?? String(v)}`),
      formulas: visible
        .filter((c) => c.formula)
        .map((c) => ({ column: c.label, formula: c.formula ?? '' })),
      notes:
        def
          .notes?.(sums, filters)
          .filter((n) => ctx.can('reports.profit') || !n.startsWith('Costs')) ?? [],
      generatedAt: new Date().toISOString(),
    },
  };
}
