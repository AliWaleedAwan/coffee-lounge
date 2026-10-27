/**
 * The report catalogue (FINANCE_REPORTING.md §6). Step 6.1 brings the engine with the first
 * two reports; steps 6.3 and 6.4 add the rest of the catalogue on the same engine.
 */
import { z } from 'zod';
import { derive, ORDER_TYPES, salesByDay, salesByItem, shopWide, type SalesFilter } from './kpi.ts';
import type { Column, ReportDefinition } from './engine.ts';
import type { Decimal } from '@cl/shared';

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');

export const salesFilter = z
  .object({
    from: localDate,
    to: localDate,
    orderType: z.enum(ORDER_TYPES).optional(),
    categoryId: id.optional(),
    itemId: id.optional(),
  })
  .strict();

const F = {
  gross: 'Σ line gross (menu price × quantity, before any discount; comped items at menu price)',
  discounts: 'promotions + manual discounts (incl. each line’s share of bill discounts) + comps',
  refunds: 'Σ refunds paid, on the refund’s business date (method corrections excluded)',
  net: 'gross − discounts − refunds',
  aov: '(gross − discounts) ÷ orders',
  rounding: 'Σ cash rounding of the settled bills',
  collected: 'Σ payments received − Σ refunds paid',
  cogs: 'Σ frozen consumption cost of the sold units (comped included, voided-after-pickup excluded)',
  coverage: 'net of recipe-tracked lines ÷ net of all lines × 100',
  waste: 'Σ waste at cost',
  variance: 'stock counted short (+) or found (−), at cost',
  ppv: 'purchase price variance from supplier price corrections',
  grossProfit: 'net sales − COGS − waste − stock variance − purchase price variance',
  margin: 'gross profit ÷ net sales × 100; over recipe-tracked lines only while coverage < 100 %',
  expenses: 'Σ recorded expenses (voided excluded)',
  operating:
    'gross profit − recorded expenses; shown only at 95 % coverage or more. Based only on expenses entered; excludes unrecorded costs such as unpaid wages or depreciation (D-19)',
};

const money = (
  key: string,
  label: string,
  formula?: string,
  extra: Partial<Column> = {},
): Column => ({
  key,
  label,
  kind: 'money',
  ...(formula ? { formula } : {}),
  ...extra,
});

function salesNotes() {
  return (totals: Record<string, Decimal | null>, f: SalesFilter): string[] => {
    const notes: string[] = [];
    const coverage = derive(totals)['coverage'];
    if (coverage !== null && Number(coverage) < 100) {
      notes.push(
        `Costs incomplete: ${(100 - Number(coverage)).toFixed(2)} % of sales have no recipe yet; the margin is over recipe items only`,
      );
    }
    if (!shopWide(f)) {
      notes.push(
        'Waste, stock variance, expenses and cash rounding belong to the whole shop: left out when filtering by order type, category or item',
      );
    }
    return notes;
  };
}

const SALES_SUMS = ['promotions', 'manual', 'comps', 'tracked_net', 'paid'] as const;

export const salesByDayReport: ReportDefinition<z.infer<typeof salesFilter>> = {
  key: 'sales-by-day',
  title: 'Sales by day',
  permission: 'reports.sales',
  filters: salesFilter,
  sumAlso: SALES_SUMS,
  columns: [
    { key: 'date', label: 'Business date', kind: 'date', total: 'none' },
    { key: 'orders', label: 'Orders', kind: 'int', formula: 'settled bills' },
    { key: 'items', label: 'Items sold', kind: 'int' },
    money('gross', 'Gross sales', F.gross),
    money('discounts', 'Discounts', F.discounts),
    money('refunds', 'Refunds', F.refunds),
    money('net_sales', 'Net sales', F.net),
    money('aov', 'Average order', F.aov, { total: 'derived' }),
    money('rounding', 'Cash rounding', F.rounding),
    money('collected', 'Collected', F.collected),
    { key: 'cogs', label: 'COGS', kind: 'cost', profit: true, formula: F.cogs },
    {
      key: 'coverage',
      label: 'COGS coverage %',
      kind: 'pct',
      profit: true,
      total: 'derived',
      formula: F.coverage,
    },
    { key: 'waste', label: 'Waste', kind: 'cost', profit: true, formula: F.waste },
    { key: 'variance', label: 'Stock variance', kind: 'cost', profit: true, formula: F.variance },
    { key: 'ppv', label: 'Price variance', kind: 'cost', profit: true, formula: F.ppv },
    {
      key: 'gross_profit',
      label: 'Gross profit after waste',
      kind: 'cost',
      profit: true,
      formula: F.grossProfit,
    },
    {
      key: 'margin',
      label: 'Gross margin %',
      kind: 'pct',
      profit: true,
      total: 'derived',
      formula: F.margin,
    },
    money('expenses', 'Recorded expenses', F.expenses, { profit: true }),
    money('operating_result', 'Recorded operating result', F.operating, {
      profit: true,
      total: 'derived',
    }),
    { key: 'needs_recipes', label: '', kind: 'text', profit: true, total: 'derived' },
  ],
  rows: (ctx, f) => salesByDay(ctx.db, f),
  derive: (totals) => derive(totals),
  notes: salesNotes(),
};

export const salesByItemReport: ReportDefinition<z.infer<typeof salesFilter>> = {
  key: 'sales-by-item',
  title: 'Sales by item',
  permission: 'reports.sales',
  filters: salesFilter,
  sumAlso: SALES_SUMS,
  columns: [
    { key: 'item', label: 'Item', kind: 'text', total: 'none' },
    { key: 'category', label: 'Category', kind: 'text', total: 'none' },
    { key: 'items', label: 'Sold', kind: 'int' },
    money('gross', 'Gross sales', F.gross),
    money('discounts', 'Discounts', F.discounts),
    money('refunds', 'Refunds', 'Σ refund lines of the item, on the refund’s business date'),
    money('net_sales', 'Net sales', F.net),
    { key: 'cogs', label: 'COGS', kind: 'cost', profit: true, formula: F.cogs },
    {
      key: 'coverage',
      label: 'COGS coverage %',
      kind: 'pct',
      profit: true,
      total: 'derived',
      formula: F.coverage,
    },
    {
      key: 'gross_profit',
      label: 'Gross profit',
      kind: 'cost',
      profit: true,
      formula: 'net sales − COGS',
    },
    {
      key: 'margin',
      label: 'Gross margin %',
      kind: 'pct',
      profit: true,
      total: 'derived',
      formula: F.margin,
    },
  ],
  rows: (ctx, f) => salesByItem(ctx.db, f),
  derive: (totals) => derive(totals),
  notes: (totals, f) => [
    ...salesNotes()(totals, f),
    'Refunds by item count only refunds recorded with their items',
  ],
};

export const REPORTS = [salesByDayReport, salesByItemReport] as const;
