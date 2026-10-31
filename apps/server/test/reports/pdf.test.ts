/**
 * PDF and CSV exports, offline (AT-103; P6-3). The PDFs are made uncompressed and their text
 * read back in drawing order, then compared with reviewed golden files in ./golden: header,
 * table, totals, footer (period, business-day rule, filters, formulas, notes, time) and page
 * numbers. After an intended layout change:
 *   UPDATE_GOLDEN=1 corepack pnpm exec vitest run --project server apps/server/test/reports/pdf.test.ts
 * and review the diff of the .txt files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { csvCell, exportFileName, toCsv } from '../../src/modules/reports/csv.ts';
import type { DayEnd } from '../../src/modules/reports/day-end.ts';
import type { Report } from '../../src/modules/reports/engine.ts';
import {
  pdfText,
  renderDayEndPdf,
  renderReportPdf,
  type PdfBrand,
} from '../../src/modules/reports/pdf.ts';

const GOLDEN = new URL('./golden/', import.meta.url);
const brand: PdfBrand = {
  shopName: 'Coffee Lounge',
  addressLine: '12 Main Boulevard, Gulberg',
  primary: '#7a4b2a',
};
const options = { timeZone: 'Asia/Karachi', compress: false };

/** The text a PDF draws, one line per text run, from its uncompressed content streams. */
function pdfLines(pdf: Buffer): string[] {
  const source = pdf.toString('latin1');
  const decoder = new TextDecoder('windows-1252');
  const lines: string[] = [];
  for (const run of source.matchAll(/\[((?:<[0-9a-f]*>|\s|-?[\d.]+)*)\] TJ/g)) {
    const hex = [...(run[1] ?? '').matchAll(/<([0-9a-f]*)>/g)].map((m) => m[1] ?? '').join('');
    lines.push(decoder.decode(Buffer.from(hex, 'hex')));
  }
  return lines;
}

function golden(name: string, lines: string[]): void {
  const text = `${lines.join('\n')}\n`;
  const file = new URL(`${name}.txt`, GOLDEN);
  if (process.env['UPDATE_GOLDEN'] === '1' || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, text);
  }
  expect(text, `${name} differs from its golden file`).toBe(readFileSync(file, 'utf8'));
}

const report: Report = {
  key: 'sales-by-day',
  title: 'Sales by day',
  period: { from: '2026-10-01', to: '2026-10-02' },
  filters: { categoryId: '3' },
  columns: [
    { key: 'date', label: 'Business date', kind: 'date', total: 'none' },
    { key: 'orders', label: 'Orders', kind: 'int', formula: 'settled bills' },
    { key: 'net_sales', label: 'Net sales', kind: 'money', formula: 'Σ line net − refunds' },
    { key: 'margin', label: 'Gross margin %', kind: 'pct', total: 'derived' },
  ],
  rows: [
    { date: '2026-10-01', orders: 41, net_sales: '28450.00', margin: '61.20' },
    { date: '2026-10-02', orders: 1, net_sales: '450.00', margin: null },
  ],
  totals: { date: null, orders: 42, net_sales: '28900.00', margin: '61.02' },
  footer: {
    period: 'Business dates 2026-10-01 to 2026-10-02',
    businessDay: 'A business day runs from 04:00 to 03:59 the next morning (Asia/Karachi, D-22)',
    filters: ['Category: Hot coffee'],
    formulas: [
      { column: 'Orders', formula: 'settled bills' },
      { column: 'Net sales', formula: 'Σ line net − refunds' },
    ],
    notes: ['COGS coverage 97.50 %: costs are missing for some items'],
    generatedAt: '2026-10-03T04:00:00.000Z',
  },
};

const dayEnd: DayEnd & { generatedAt: string } = {
  date: '2026-10-19',
  generatedAt: '2026-10-19T23:25:00.000Z',
  sales: {
    orders: 42,
    items: 77,
    gross: '31500.00',
    promotions: '500',
    manual: '600',
    comps: '150',
    discounts: '1250.00',
    refunds: '650.00',
    net_sales: '29600.00',
    rounding: '-3.00',
    aov: '720.24',
    collected: '28947.00',
  },
  byOrderType: [
    { type: 'dine_in', label: 'Dine-in', orders: 30, net_sales: '22000.00' },
    { type: 'takeaway', label: 'Takeaway', orders: 9, net_sales: '5100.00' },
    { type: 'delivery', label: 'Delivery', orders: 3, net_sales: '2500.00' },
  ],
  payments: [
    { method: 'Cash', payments: 20, taken: '15500.00', refunded: '650.00', collected: '14850.00' },
    { method: 'Card', payments: 12, taken: '9100.00', refunded: '0.00', collected: '9100.00' },
  ],
  openBills: { count: 2, value: '1700.00' },
  cod: [{ rider: 'Bilal', deliveries: 1, amount: '1250.00' }],
  shifts: [
    {
      till: 'Counter',
      cashier: 'Sara',
      status: 'approved',
      expected: '19850.00',
      counted: '19830.00',
      variance: '-20.00',
      reason: 'Change given twice',
      approved_by: 'Owner',
    },
  ],
  voids: { events: 3, units: 4, value: '1100.00' },
  waste: { records: 2, cost: '310.5' },
  topItems: [{ item: 'Cappuccino Regular', items: 18, net_sales: '11700.00', margin: '72.10' }],
  profit: {
    cogs: '8120.25',
    coverage: '97.50',
    waste: '310.5',
    variance: '45',
    gross_profit: '21124.25',
    margin: '71.36',
    operating_result: '9124.25',
    needs_recipes: null,
  },
  alerts: [{ kind: 'low', label: 'Stock low', open: 2 }],
};

describe('PDF exports (AT-103)', () => {
  it('a report: brand, table with totals, footer with period, filters, formulas, page numbers', async () => {
    const lines = pdfLines(await renderReportPdf(report, brand, options));
    golden('sales-by-day', lines);
    expect(lines).toContain('Coffee Lounge');
    expect(lines).toContain('Filters: Category: Hot coffee.');
    expect(lines).toContain('Net sales: sum of line net - refunds');
    expect(lines).toContain('Made 03 Oct 2026 09:00 (shop clock).');
    expect(lines.at(-1)).toBe('Page 1 of 1');
  });

  it('a long report continues over pages with the table header repeated', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
      orders: i,
      net_sales: `${String(i * 100)}.00`,
      margin: '50.00',
    }));
    const lines = pdfLines(await renderReportPdf({ ...report, rows }, brand, options));
    const pages = lines.filter((l) => /^Page \d+ of \d+$/.test(l));
    expect(pages.length).toBeGreaterThan(1);
    expect(lines.filter((l) => l === 'Business date').length).toBe(pages.length);
    expect(lines.filter((l) => l === 'Coffee Lounge').length).toBe(pages.length);
  });

  it('the day-end, with costs only when they were allowed', async () => {
    golden('day-end', pdfLines(await renderDayEndPdf(dayEnd, brand, options)));
    const without = pdfLines(
      await renderDayEndPdf(
        { ...dayEnd, profit: null, waste: { records: 2, cost: null } },
        brand,
        options,
      ),
    );
    expect(without).not.toContain('Costs and margin');
    expect(without).not.toContain('Waste cost');
    expect(without).not.toContain('Margin');
  });

  it('text the standard fonts cannot draw is spelt out or replaced, never garbled', () => {
    expect(pdfText('Σ net − refunds ≥ 0 · “café” — ok')).toBe(
      'sum of net - refunds >= 0 · “café” — ok',
    );
    expect(pdfText('چائے')).toBe('????');
  });
});

describe('CSV exports (AT-103)', () => {
  it('BOM, header, plain decimals, totals; typed text cannot become a formula', () => {
    const csv = toCsv({
      ...report,
      columns: [...report.columns, { key: 'note', label: 'Note, if any', kind: 'text' }],
      rows: [{ ...report.rows[0], note: '=HYPERLINK("x")' }],
    }).toString('utf8');
    expect(csv).toBe(
      '\uFEFFBusiness date,Orders,Net sales,Gross margin %,"Note, if any"\r\n' +
        `2026-10-01,41,28450.00,61.20,"'=HYPERLINK(""x"")"\r\n` +
        'Total,42,28900.00,61.02,\r\n',
    );
    expect(csvCell('money', '-12.50')).toBe('-12.50');
    expect(csvCell('text', '-12.50')).toBe("'-12.50");
  });

  it('file names: the report, its period and each filter by name, ASCII only', () => {
    expect(exportFileName(report, { categoryId: 'Hot coffee & tea' }, 'csv')).toBe(
      'sales-by-day_2026-10-01_2026-10-02_category-hot-coffee-tea.csv',
    );
    expect(
      exportFileName(
        { ...report, period: { from: '2026-10-01', to: '2026-10-01' }, filters: {} },
        {},
        'pdf',
      ),
    ).toBe('sales-by-day_2026-10-01.pdf');
    expect(
      exportFileName(
        { ...report, filters: { inventoryItemId: '7' } },
        { inventoryItemId: 'Café beans' },
        'csv',
      ),
    ).toBe('sales-by-day_2026-10-01_2026-10-02_inventory-item-cafe-beans.csv');
  });
});
