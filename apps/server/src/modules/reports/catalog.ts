/**
 * The report catalogue (FINANCE_REPORTING.md §6). Step 6.1 brings the engine with the first
 * two reports; steps 6.3 and 6.4 add the rest of the catalogue on the same engine.
 */
import { z } from 'zod';
import {
  derive,
  ORDER_TYPES,
  salesByDay,
  salesByHour,
  salesByItem,
  shopWide,
  type SalesFilter,
} from './kpi.ts';
import type { Column, ReportDefinition } from './engine.ts';
import {
  billLines,
  bills,
  byCategory,
  deliveries,
  DELIVERY_STATUSES,
  DISCOUNT_KINDS,
  discountsAndRefunds,
  menuEngineering,
  operatingStatement,
  paymentMix,
} from './money.ts';
import { readLedger } from '../ledger/index.ts';
import { auditEvents, staffActivity } from './people.ts';
import { counts, onHand, purchases, usage, waste, WASTE_KINDS } from './stock.ts';
import { listExpenses } from '../expenses/index.ts';
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
    staffId: id.optional(),
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
  rowId: 'item_id',
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

export const salesByHourReport: ReportDefinition<z.infer<typeof salesFilter>> = {
  key: 'sales-by-hour',
  title: 'Sales by hour',
  permission: 'reports.sales',
  filters: salesFilter,
  columns: [
    { key: 'hour', label: 'Hour (shop clock)', kind: 'text', total: 'none' },
    {
      key: 'orders',
      label: 'Orders',
      kind: 'int',
      formula: 'settled bills, by the hour they were settled',
    },
    { key: 'items', label: 'Items sold', kind: 'int' },
    money('gross', 'Gross sales', F.gross),
    money('discounts', 'Discounts', F.discounts),
    money(
      'sales',
      'Sales after discounts',
      'gross − discounts (refunds are counted on their own date, not by hour)',
    ),
  ],
  rows: (ctx, f) => salesByHour(ctx.db, f),
};

const period = { from: localDate, to: localDate };
const text = (key: string, label: string): Column => ({ key, label, kind: 'text', total: 'none' });

export const billsReport: ReportDefinition<z.infer<typeof salesFilter>> = {
  key: 'bills',
  title: 'Bills',
  permission: 'reports.sales',
  filters: salesFilter,
  rowId: 'invoice_id',
  columns: [
    { key: 'date', label: 'Business date', kind: 'date', total: 'none' },
    text('invoice_no', 'Invoice'),
    text('where', 'Where'),
    text('settled_by', 'Settled by'),
    { key: 'items', label: 'Items', kind: 'int' },
    money('gross', 'Gross', F.gross),
    money('discounts', 'Discounts', F.discounts),
    money('net', 'Net of lines', 'gross − discounts, before refunds'),
    money('rounding', 'Rounding', F.rounding),
    money('total', 'Bill total', 'net of lines + rounding'),
    { key: 'cogs', label: 'COGS', kind: 'cost', profit: true, formula: F.cogs },
  ],
  rows: (ctx, f) => bills(ctx.db, f),
};

const billLinesFilter = z.object({ ...period, invoiceId: id }).strict();
export const billLinesReport: ReportDefinition<z.infer<typeof billLinesFilter>> = {
  key: 'bill-lines',
  title: 'Bill lines',
  permission: 'reports.sales',
  filters: billLinesFilter,
  columns: [
    text('item', 'Item'),
    { key: 'items', label: 'Qty', kind: 'int' },
    money('gross', 'Gross', F.gross),
    money('discounts', 'Discounts', F.discounts),
    money('net', 'Net', 'gross − discounts'),
    money('refunded', 'Refunded', 'refund lines recorded against this line'),
    { key: 'cogs', label: 'COGS', kind: 'cost', profit: true, formula: F.cogs },
    text('note', ''),
  ],
  rows: (ctx, f) => billLines(ctx.db, f.invoiceId),
};

export const salesByCategoryReport: ReportDefinition<z.infer<typeof salesFilter>> = {
  key: 'sales-by-category',
  title: 'Sales by category',
  permission: 'reports.sales',
  filters: salesFilter,
  sumAlso: SALES_SUMS,
  columns: [
    text('category', 'Category'),
    { key: 'items', label: 'Sold', kind: 'int' },
    money('gross', 'Gross sales', F.gross),
    money('discounts', 'Discounts', F.discounts),
    money('refunds', 'Refunds', 'Σ refund lines of the category, on the refund’s business date'),
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
  rows: (ctx, f) => byCategory(ctx.db, f),
  derive: (totals) => derive(totals),
  notes: (totals, f) => [
    ...salesNotes()(totals, f),
    'Refunds by category count only refunds recorded with their items',
  ],
};

export const menuEngineeringReport: ReportDefinition<z.infer<typeof salesFilter>> = {
  key: 'menu-engineering',
  title: 'Menu engineering',
  permission: 'reports.profit',
  filters: salesFilter,
  rowId: 'item_id',
  columns: [
    text('item', 'Item'),
    text('category', 'Category'),
    { key: 'items', label: 'Sold', kind: 'int' },
    {
      key: 'share',
      label: 'Share of items %',
      kind: 'pct',
      formula: 'items sold ÷ all recipe items sold × 100',
    },
    { key: 'contribution', label: 'Contribution', kind: 'cost', formula: 'net of lines − COGS' },
    {
      key: 'unit_contribution',
      label: 'Per item',
      kind: 'money',
      total: 'none',
      formula: 'contribution ÷ items sold',
    },
    text('class', 'Class'),
  ],
  rows: (ctx, f) => menuEngineering(ctx.db, f),
  notes: () => [
    'Popular: share of items at least 70 % of an equal share. Profitable: contribution per item at least the average. Star = both, Plowhorse = popular only, Puzzle = profitable only, Dog = neither. Items without a recipe cannot be classed',
  ],
};

const discountsFilter = z
  .object({ ...period, staffId: id.optional(), kind: z.enum(DISCOUNT_KINDS).optional() })
  .strict();
export const discountsReport: ReportDefinition<z.infer<typeof discountsFilter>> = {
  key: 'discounts',
  title: 'Discounts, comps & refunds',
  permission: 'reports.sales',
  filters: discountsFilter,
  rowId: 'invoice_id',
  columns: [
    { key: 'date', label: 'Business date', kind: 'date', total: 'none' },
    text('invoice_no', 'Invoice'),
    text('kind', 'What'),
    text('reason', 'Reason'),
    text('by', 'By'),
    text('approved_by', 'Approved by'),
    money(
      'amount',
      'Amount',
      'promotions, discounts and comps on the bill’s settlement date; refunds on their own date',
    ),
  ],
  rows: (ctx, f) => discountsAndRefunds(ctx.db, f),
};

const periodFilter = z.object(period).strict();
export const paymentMixReport: ReportDefinition<z.infer<typeof periodFilter>> = {
  key: 'payment-mix',
  title: 'Payment mix & collections',
  permission: 'reports.sales',
  filters: periodFilter,
  columns: [
    text('method', 'Method'),
    { key: 'payments', label: 'Payments', kind: 'int' },
    money('taken', 'Taken', 'Σ payments on their business date, by the method as corrected'),
    { key: 'refunds', label: 'Refunds', kind: 'int' },
    money('refunded', 'Refunded', 'Σ refunds paid back by this method, on their business date'),
    money('collected', 'Collected', F.collected),
  ],
  rows: (ctx, f) => paymentMix(ctx.db, f),
};

const deliveriesFilter = z
  .object({ ...period, riderId: id.optional(), status: z.enum(DELIVERY_STATUSES).optional() })
  .strict();
export const deliveriesReport: ReportDefinition<z.infer<typeof deliveriesFilter>> = {
  key: 'deliveries',
  title: 'Deliveries',
  permission: 'reports.sales',
  filters: deliveriesFilter,
  columns: [
    { key: 'date', label: 'Business date', kind: 'date', total: 'none' },
    text('order', 'Order'),
    text('channel', 'Taken by'),
    text('payment_mode', 'Payment'),
    text('rider', 'Rider'),
    text('status', 'Outcome'),
    { key: 'attempts', label: 'Attempts', kind: 'int' },
    { key: 'deliveries', label: 'Deliveries', kind: 'int' },
    { key: 'delivered', label: 'Delivered', kind: 'int' },
    money('bill', 'Bill', 'the bill’s total once prepared'),
    money('paid', 'Paid', 'Σ payments on the bill'),
    money('refund_due', 'Refund due', 'cancelled prepaid deliveries'),
  ],
  rows: (ctx, f) => deliveries(ctx.db, f),
};

export const operatingResultReport: ReportDefinition<z.infer<typeof periodFilter>> = {
  key: 'operating-result',
  title: 'Recorded operating result',
  permission: 'reports.profit',
  filters: periodFilter,
  columns: [text('group', ''), text('line', ''), money('amount', 'Amount', F.operating)],
  sumAlso: ['coverage_ok'],
  rows: async (ctx, f) => {
    const statement = await operatingStatement(ctx.db, f);
    // Each line carries whether the result may be shown, for the total.
    return statement.rows.map((r) => ({ ...r, coverage_ok: statement.needsRecipes ? null : 1 }));
  },
  // The lines add up to the result, which is shown only at 95 % COGS coverage (D-19).
  derive: (totals) => ({
    amount: totals['coverage_ok'] === null ? null : (totals['amount']?.toString() ?? null),
  }),
  notes: (totals) =>
    totals['coverage_ok'] === null
      ? ['Needs recipes: costs are missing for more than 5 % of sales, so no result is shown']
      : [
          'Based only on expenses entered; excludes unrecorded costs such as unpaid wages or depreciation (D-19)',
        ],
};

const ledgerFilter = z
  .object({ ...period, channel: z.enum(['cash', 'card', 'transfer', 'other']).optional() })
  .strict();
export const ledgerReport: ReportDefinition<z.infer<typeof ledgerFilter>> = {
  key: 'ledger',
  title: 'Ledger',
  permission: 'ledger.read',
  filters: ledgerFilter,
  columns: [
    { key: 'date', label: 'Business date', kind: 'date', total: 'none' },
    text('entry_no', 'Entry'),
    text('what', 'What'),
    text('source', 'From'),
    text('channel', 'Channel'),
    money('in', 'In', 'money in'),
    money('out', 'Out', 'money out'),
    money('balance', 'Balance', 'the channel’s balance after the entry', { total: 'none' }),
  ],
  rows: async (ctx, f) =>
    (await readLedger(ctx.db, f)).entries.map((e) => ({
      date: e.businessDate,
      entry_no: e.entryNo,
      what: e.entryType.replace('_', ' '),
      source: e.source,
      channel: e.provider ? `${e.channel} · ${e.provider}` : e.channel,
      in: e.direction === 'in' ? e.amount : null,
      out: e.direction === 'out' ? e.amount : null,
      balance: e.balanceAfter,
    })),
};

const expensesFilter = z.object({ ...period, categoryId: id.optional() }).strict();
export const expensesReport: ReportDefinition<z.infer<typeof expensesFilter>> = {
  key: 'expenses',
  title: 'Expenses',
  permission: 'expenses.read',
  filters: expensesFilter,
  columns: [
    { key: 'date', label: 'Business date', kind: 'date', total: 'none' },
    text('expense_no', 'Number'),
    text('category', 'Category'),
    text('payee', 'Paid to'),
    text('paid_via', 'Paid by'),
    money('amount', 'Amount', F.expenses),
  ],
  rows: async (ctx, f) =>
    (await listExpenses(ctx.db, { ...f, status: 'recorded' })).items
      .map((e) => ({
        date: e.businessDate,
        expense_no: e.expenseNo,
        category: e.category,
        payee: e.payee,
        paid_via: e.provider
          ? `${e.paidVia} · ${e.provider}`
          : e.fromTill
            ? 'cash from the till'
            : e.paidVia,
        amount: e.amount,
      }))
      .reverse(),
};

const COSTS = 'inventory.cost_view';
const stockFilter = z
  .object({
    ...period,
    stockCategory: z.string().trim().max(60).optional(),
    inventoryItemId: id.optional(),
  })
  .strict();
const toStock = (f: z.infer<typeof stockFilter>) => ({
  from: f.from,
  to: f.to,
  category: f.stockCategory,
  itemId: f.inventoryItemId,
});
const qty = (key: string, label: string, formula?: string): Column => ({
  key,
  label,
  kind: 'qty',
  total: 'none',
  ...(formula ? { formula } : {}),
});
const value = (key: string, label: string, formula: string): Column => ({
  key,
  label,
  kind: 'cost',
  needs: COSTS,
  formula,
});

export const usageReport: ReportDefinition<z.infer<typeof stockFilter>> = {
  key: 'inventory-usage',
  title: 'Inventory usage',
  permission: 'reports.inventory',
  filters: stockFilter,
  rowId: 'item_id',
  columns: [
    text('item', 'Item'),
    text('category', 'Category'),
    text('unit', 'Unit'),
    qty('received', 'Received', 'opening counts and receipts, in the item’s unit'),
    qty('used', 'Used in sales', 'consumed when items were picked up'),
    qty('wasted', 'Wasted'),
    qty('counted', 'Count difference', 'found (+) or short (−) at counts'),
    qty('returned', 'Returned to supplier'),
    qty('net', 'Net change', 'Σ of every movement'),
    value('received_value', 'Received value', 'at purchase cost'),
    value('used_value', 'Used value', 'at the average cost when used (the COGS of the sales)'),
    value('waste_value', 'Waste value', 'at the average cost'),
    value('variance_value', 'Count variance', 'short (+) or found (−), at cost'),
    value('net_value', 'Net value change', 'Σ of every movement’s value'),
  ],
  rows: (ctx, f) => usage(ctx.db, toStock(f)),
  notes: () => [
    'Quantities are in each item’s own unit (g, ml or pieces), so they are not added up across items',
  ],
};

const wasteFilter = stockFilter.extend({ kind: z.enum(WASTE_KINDS).optional() }).strict();
export const wasteReport: ReportDefinition<z.infer<typeof wasteFilter>> = {
  key: 'waste',
  title: 'Waste & expiry',
  permission: 'reports.inventory',
  filters: wasteFilter,
  columns: [
    { key: 'date', label: 'Business date', kind: 'date', total: 'none' },
    text('item', 'Item'),
    text('kind', 'Kind'),
    text('reason', 'Reason'),
    qty('qty', 'Quantity'),
    text('unit', 'Unit'),
    {
      key: 'units',
      label: 'Sold items',
      kind: 'int',
      formula: 'prepared items and failed deliveries',
    },
    text('lot', 'Lot'),
    text('by', 'Recorded by'),
    value('value', 'Value', 'Σ waste at cost (FINANCE_REPORTING.md §3)'),
  ],
  rows: (ctx, f) => waste(ctx.db, { ...toStock(f), kind: f.kind }),
};

const onHandFilter = z
  .object({ ...period, stockCategory: z.string().trim().max(60).optional() })
  .strict();
export const onHandReport: ReportDefinition<z.infer<typeof onHandFilter>> = {
  key: 'stock-on-hand',
  title: 'Stock on hand',
  permission: 'reports.inventory',
  filters: onHandFilter,
  rowId: 'item_id',
  columns: [
    text('sku', 'SKU'),
    text('item', 'Item'),
    text('category', 'Category'),
    text('unit', 'Unit'),
    qty('on_hand', 'On hand'),
    qty('reserved', 'Held for orders', 'accepted, not yet picked up'),
    qty('available', 'Free', 'on hand − held'),
    {
      key: 'unit_cost',
      label: 'Average cost',
      kind: 'cost',
      needs: COSTS,
      total: 'none',
      formula: 'weighted average per unit (last cost when none is left)',
    },
    value('value', 'Value', 'Σ stock value at weighted average cost (COST_VALUATION.md)'),
    text('status', ''),
  ],
  rows: (ctx, f) => onHand(ctx.db, { category: f.stockCategory }),
  notes: () => [
    'As of now, whatever the period: stock has no past state on this report (use Inventory usage for the period)',
  ],
};

export const countsReport: ReportDefinition<z.infer<typeof periodFilter>> = {
  key: 'stock-counts',
  title: 'Stock counts & variances',
  permission: 'reports.inventory',
  filters: periodFilter,
  columns: [
    { key: 'date', label: 'Business date', kind: 'date', total: 'none' },
    text('count_no', 'Count'),
    text('scope', 'What was counted'),
    text('counted_by', 'Counted by'),
    text('approved_by', 'Approved by'),
    { key: 'lines', label: 'Items counted', kind: 'int' },
    { key: 'differed', label: 'Items different', kind: 'int' },
    value(
      'variance_value',
      'Variance',
      'short (+) or found (−) at cost (stock variance, FINANCE_REPORTING.md §3)',
    ),
  ],
  rows: (ctx, f) => counts(ctx.db, f),
};

const purchasesFilter = z.object({ ...period, supplierId: id.optional() }).strict();
export const purchasesReport: ReportDefinition<z.infer<typeof purchasesFilter>> = {
  key: 'purchases',
  title: 'Purchases',
  permission: 'reports.inventory',
  filters: purchasesFilter,
  columns: [
    { key: 'date', label: 'Business date', kind: 'date', total: 'none' },
    text('receipt_no', 'Receipt'),
    text('supplier', 'Supplier'),
    { key: 'lines', label: 'Lines', kind: 'int' },
    text('status', 'Status'),
    text('paid', 'Paid'),
    {
      key: 'receipts',
      label: 'Receipts',
      kind: 'int',
      formula: 'posted receipts (reversed ones count for nothing)',
    },
    {
      key: 'cost',
      label: 'Cost',
      kind: 'money',
      needs: COSTS,
      formula: 'Σ receipt totals of posted receipts',
    },
  ],
  rows: (ctx, f) => purchases(ctx.db, f),
};

const staffFilter = z.object({ ...period, staffId: id.optional() }).strict();
export const staffActivityReport: ReportDefinition<z.infer<typeof staffFilter>> = {
  key: 'staff-activity',
  title: 'Staff activity',
  permission: 'reports.staff',
  filters: staffFilter,
  columns: [
    text('person', 'Person'),
    { key: 'bills', label: 'Bills settled', kind: 'int' },
    money('bills_amount', 'Bills total', 'Σ totals of the bills they settled'),
    { key: 'payments', label: 'Payments taken', kind: 'int' },
    money('taken', 'Taken', 'Σ payments they took'),
    { key: 'orders_accepted', label: 'Orders accepted', kind: 'int' },
    { key: 'discounts', label: 'Discounts & comps', kind: 'int' },
    money('discounts_amount', 'Discounts given', 'on bills settled in the period'),
    { key: 'refunds', label: 'Refunds asked', kind: 'int' },
    money('refunds_amount', 'Refunded', 'refunds they asked for'),
    { key: 'approvals', label: 'Refunds approved', kind: 'int' },
    { key: 'waste_records', label: 'Waste recorded', kind: 'int' },
  ],
  rows: (ctx, f) => staffActivity(ctx.db, f),
};

const auditFilter = z
  .object({
    ...period,
    staffId: id.optional(),
    entityType: z
      .string()
      .regex(/^[a-z_]+$/)
      .optional(),
  })
  .strict();
export const auditReport: ReportDefinition<z.infer<typeof auditFilter>> = {
  key: 'audit-log',
  title: 'Audit log',
  permission: 'audit.read',
  filters: auditFilter,
  columns: [
    text('at', 'When (shop clock)'),
    text('who', 'Who'),
    text('device', 'Device'),
    text('action', 'Action'),
    text('record', 'Record'),
    text('reason', 'Reason'),
    text('approved_by', 'Approved by'),
    { key: 'events', label: 'Events', kind: 'int' },
  ],
  rows: (ctx, f) => auditEvents(ctx.db, f),
  notes: () => [
    'Before and after values are on the Audit log page; at most 20,000 events per report',
  ],
};

export const REPORTS = [
  salesByDayReport,
  billsReport,
  salesByItemReport,
  salesByCategoryReport,
  salesByHourReport,
  menuEngineeringReport,
  discountsReport,
  paymentMixReport,
  deliveriesReport,
  operatingResultReport,
  ledgerReport,
  expensesReport,
  usageReport,
  wasteReport,
  onHandReport,
  countsReport,
  purchasesReport,
  staffActivityReport,
  auditReport,
  billLinesReport,
] as const;
