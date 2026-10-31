/**
 * PDF exports (FINANCE_REPORTING.md §8; P6-3; AT-103), made on the server with pdfkit and
 * its built-in Helvetica, so nothing is fetched and no browser is needed. A4 portrait, or
 * landscape for wide tables; the shop's name in its brand colour on every page (a logo
 * when the owner sends one, I-19); page numbers; and the footer FINANCE_REPORTING.md §6
 * asks for: period and business-day rule, filters, each total's formula, COGS coverage
 * notes and when it was made. The rows and totals are the report's own (AC-RPT-1).
 */
import PDFDocument from 'pdfkit';
import { shopTime } from '../printing/index.ts';
import type { Cell, Column, Report } from './engine.ts';
import type { DayEnd } from './day-end.ts';

export interface PdfBrand {
  shopName: string;
  addressLine: string | null;
  /** "#RRGGBB" */
  primary: string;
}

export interface PdfOptions {
  timeZone: string;
  /** Tests switch compression off to read the text back. */
  compress?: boolean;
}

/**
 * The standard PDF fonts cover Windows-1252 only: common symbols are spelt out, anything
 * else (Urdu, emoji) becomes "?" rather than garbage.
 */
const SPELT: Record<string, string> = {
  Σ: 'sum of ',
  '−': '-',
  '≥': '>=',
  '≤': '<=',
  '→': '->',
  '✓': 'yes',
};
const WIN_1252_EXTRA = new Set(Array.from('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'));
export function pdfText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (SPELT[ch] !== undefined) out += SPELT[ch];
    else if (
      (code >= 0x20 && code < 0x7f) ||
      (code >= 0xa0 && code <= 0xff) ||
      WIN_1252_EXTRA.has(ch)
    )
      out += ch;
    else if (ch === '\n') out += ch;
    else out += '?';
  }
  return out.replace(/sum of \s+/g, 'sum of ');
}

const grouped = (v: string, digits: number): string =>
  Number(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** A cell as printed: amounts with separators, 2 decimals; quantities up to 3. */
export function pdfCell(kind: Column['kind'], v: Cell | undefined): string {
  if (v === null || v === undefined || v === '') return '-';
  if (kind === 'money' || kind === 'cost') return grouped(String(v), 2);
  if (kind === 'pct') return `${grouped(String(v), 2)} %`;
  if (kind === 'int') return grouped(String(v), 0);
  if (kind === 'qty') return Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 });
  return pdfText(String(v));
}

const MARGIN = 36;
const ROW = 14;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';

interface TableColumn {
  label: string;
  /** Relative width. */
  weight: number;
  right: boolean;
}

/** A page writer with a running header and tables that continue across pages. */
class Layout {
  readonly doc: PDFKit.PDFDocument;
  private readonly brand: PdfBrand;
  private readonly heading: { title: string; subtitle: string };
  private y = 0;

  constructor(
    brand: PdfBrand,
    heading: { title: string; subtitle: string },
    landscape: boolean,
    compress: boolean,
  ) {
    this.brand = brand;
    this.heading = heading;
    this.doc = new PDFDocument({
      size: 'A4',
      layout: landscape ? 'landscape' : 'portrait',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
      compress,
      info: {
        Title: pdfText(`${heading.title} - ${heading.subtitle}`),
        Author: pdfText(brand.shopName),
        Creator: 'Coffee Lounge',
        CreationDate: new Date(0),
      },
    });
    this.header();
  }

  private get width(): number {
    return this.doc.page.width - 2 * MARGIN;
  }
  private get bottom(): number {
    return this.doc.page.height - MARGIN - 24; // room for the page number
  }

  private header(): void {
    const { doc } = this;
    doc
      .font(BOLD)
      .fontSize(15)
      .fillColor(/^#[0-9a-f]{6}$/i.test(this.brand.primary) ? this.brand.primary : '#000000');
    doc.text(pdfText(this.brand.shopName), MARGIN, MARGIN, { width: this.width, lineBreak: false });
    doc.fillColor('#000000').font(FONT).fontSize(8);
    if (this.brand.addressLine)
      doc.text(pdfText(this.brand.addressLine), MARGIN, MARGIN + 18, {
        width: this.width,
        lineBreak: false,
      });
    doc
      .font(BOLD)
      .fontSize(12)
      .text(pdfText(this.heading.title), MARGIN, MARGIN + 32, {
        width: this.width,
        lineBreak: false,
      });
    doc
      .font(FONT)
      .fontSize(9)
      .text(pdfText(this.heading.subtitle), MARGIN, MARGIN + 48, {
        width: this.width,
        lineBreak: false,
      });
    this.y = MARGIN + 66;
  }

  private newPage(): void {
    this.doc.addPage();
    this.header();
  }

  /** Makes sure `height` fits; otherwise continues on a new page. Returns true on a new page. */
  room(height: number): boolean {
    if (this.y + height <= this.bottom) return false;
    this.newPage();
    return true;
  }

  section(title: string): void {
    this.room(ROW * 3);
    this.y += 6;
    this.doc.font(BOLD).fontSize(10).fillColor('#000000');
    this.doc.text(pdfText(title), MARGIN, this.y, { width: this.width, lineBreak: false });
    this.y += ROW + 2;
  }

  paragraph(text: string, size = 8): void {
    this.doc.font(FONT).fontSize(size);
    const clean = pdfText(text);
    const height = this.doc.heightOfString(clean, { width: this.width });
    this.room(height);
    this.doc.text(clean, MARGIN, this.y, { width: this.width });
    this.y += height + 2;
  }

  private fit(text: string, width: number): string {
    if (this.doc.widthOfString(text) <= width) return text;
    let cut = text;
    while (cut.length > 1 && this.doc.widthOfString(`${cut}…`) > width) cut = cut.slice(0, -1);
    return `${cut}…`;
  }

  private row(columns: TableColumn[], cells: string[], bold: boolean, shade: boolean): void {
    const { doc } = this;
    const total = columns.reduce((sum, c) => sum + c.weight, 0);
    if (shade)
      doc
        .rect(MARGIN, this.y - 2, this.width, ROW)
        .fill('#eeeeee')
        .fillColor('#000000');
    doc.font(bold ? BOLD : FONT).fontSize(columns.length > 10 ? 7 : 8);
    let x = MARGIN;
    columns.forEach((c, i) => {
      const w = (c.weight / total) * this.width;
      const text = this.fit(cells[i] ?? '', w - 4);
      doc.text(text, x + 2, this.y + 1, {
        width: w - 4,
        align: c.right ? 'right' : 'left',
        lineBreak: false,
      });
      x += w;
    });
    this.y += ROW;
  }

  table(columns: TableColumn[], rows: string[][], totals?: string[]): void {
    const head = columns.map((c) => c.label);
    this.room(ROW * 2);
    this.row(columns, head, true, true);
    for (const r of rows) {
      if (this.room(ROW)) this.row(columns, head, true, true);
      this.row(columns, r, false, false);
    }
    if (totals) {
      if (this.room(ROW)) this.row(columns, head, true, true);
      this.doc
        .moveTo(MARGIN, this.y - 1)
        .lineTo(MARGIN + this.width, this.y - 1)
        .lineWidth(0.5)
        .stroke();
      this.row(columns, totals, true, false);
    }
    this.y += 4;
  }

  /** Label and value pairs in two columns of the page. */
  pairs(items: [string, string][]): void {
    const half = this.width / 2;
    for (let i = 0; i < items.length; i += 2) {
      this.room(ROW);
      [items[i], items[i + 1]].forEach((pair, j) => {
        if (!pair) return;
        const x = MARGIN + j * half;
        this.doc
          .font(FONT)
          .fontSize(9)
          .text(pdfText(pair[0]), x, this.y, { width: half * 0.6, lineBreak: false });
        this.doc.font(BOLD).text(pdfText(pair[1]), x + half * 0.6, this.y, {
          width: half * 0.4 - 8,
          align: 'right',
          lineBreak: false,
        });
      });
      this.y += ROW;
    }
    this.y += 4;
  }

  /** Page numbers on every page, then the finished file. */
  async finish(): Promise<Buffer> {
    const { doc } = this;
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      doc.font(FONT).fontSize(8).fillColor('#555555');
      doc.text(
        `Page ${String(i - range.start + 1)} of ${String(range.count)}`,
        MARGIN,
        doc.page.height - MARGIN - 10,
        { width: this.width, align: 'right', lineBreak: false },
      );
    }
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      doc.on('error', reject);
    });
    doc.end();
    return done;
  }
}

const isNumber = (kind: Column['kind']) => kind !== 'text' && kind !== 'date';
const weightOf = (c: Column) => (c.kind === 'text' ? 2 : c.kind === 'date' ? 1.3 : 1);

/** A report as a PDF: its table (continued over pages), totals, then the footer notes. */
export async function renderReportPdf(
  report: Report,
  brand: PdfBrand,
  options: PdfOptions,
): Promise<Buffer> {
  const layout = new Layout(
    brand,
    { title: report.title, subtitle: report.footer.period },
    report.columns.length > 7,
    options.compress ?? true,
  );
  const columns = report.columns.map((c) => ({
    label: pdfText(c.label),
    weight: weightOf(c),
    right: isNumber(c.kind),
  }));
  const rows = report.rows.map((r) => report.columns.map((c) => pdfCell(c.kind, r[c.key])));
  const hasTotals =
    report.rows.length > 0 && report.columns.some((c) => report.totals[c.key] !== null);
  const totals = hasTotals
    ? report.columns.map((c, i) =>
        i === 0 && report.totals[c.key] === null
          ? 'Total'
          : report.totals[c.key] === null
            ? ''
            : pdfCell(c.kind, report.totals[c.key]),
      )
    : undefined;
  if (rows.length === 0) layout.paragraph('Nothing in this period.', 9);
  else layout.table(columns, rows, totals);
  footer(layout, report.footer, options.timeZone);
  return layout.finish();
}

function footer(layout: Layout, f: Report['footer'], timeZone: string): void {
  layout.section('How these figures are worked out');
  layout.paragraph(`${f.period}. ${f.businessDay}.`);
  layout.paragraph(f.filters.length > 0 ? `Filters: ${f.filters.join('; ')}.` : 'Filters: none.');
  for (const m of f.formulas) layout.paragraph(`${m.column}: ${m.formula}`);
  for (const n of f.notes) layout.paragraph(n);
  layout.paragraph(`Made ${shopTime(new Date(f.generatedAt), timeZone)} (shop clock).`);
}

const money = (v: string | null): string => (v === null ? '-' : pdfCell('money', v));

/** The day-end as a PDF (FINANCE_REPORTING.md §7), from its stored figures. */
export async function renderDayEndPdf(
  d: DayEnd & { generatedAt: string },
  brand: PdfBrand,
  options: PdfOptions,
): Promise<Buffer> {
  const layout = new Layout(
    brand,
    { title: 'Day-end report', subtitle: `Business date ${d.date}` },
    false,
    options.compress ?? true,
  );
  const s = d.sales;
  layout.section('Sales');
  layout.pairs([
    ['Gross sales', money(s.gross)],
    ['Orders', pdfCell('int', s.orders)],
    ['Promotions', money(s.promotions)],
    ['Items sold', pdfCell('int', s.items)],
    ['Manual discounts', money(s.manual)],
    ['Average order', money(s.aov)],
    ['Comps', money(s.comps)],
    ['Cash rounding', money(s.rounding)],
    ['Refunds', money(s.refunds)],
    ['Collected', money(s.collected)],
    ['Net sales', money(s.net_sales)],
  ]);
  layout.section('By order type');
  layout.table(
    [
      { label: 'Order type', weight: 2, right: false },
      { label: 'Orders', weight: 1, right: true },
      { label: 'Net sales', weight: 1, right: true },
    ],
    d.byOrderType.map((o) => [o.label, pdfCell('int', o.orders), money(o.net_sales)]),
  );
  layout.section('Payment mix');
  layout.table(
    [
      { label: 'Method', weight: 2, right: false },
      { label: 'Payments', weight: 1, right: true },
      { label: 'Taken', weight: 1, right: true },
      { label: 'Refunded', weight: 1, right: true },
      { label: 'Collected', weight: 1, right: true },
    ],
    d.payments.map((p) => [
      p.method,
      pdfCell('int', p.payments),
      money(p.taken),
      money(p.refunded),
      money(p.collected),
    ]),
  );
  layout.section('Still open when the day ended');
  layout.pairs([
    ['Open bills', pdfCell('int', d.openBills.count)],
    ['Left to pay on them', money(d.openBills.value)],
    ...d.cod.map((c): [string, string] => [
      `COD with ${c.rider} (${String(c.deliveries)})`,
      money(c.amount),
    ]),
  ]);
  layout.section('Cash shifts');
  if (d.shifts.length === 0) layout.paragraph('No cash shift was opened this day.', 9);
  else
    layout.table(
      [
        { label: 'Till', weight: 1, right: false },
        { label: 'Cashier', weight: 1.2, right: false },
        { label: 'Status', weight: 1, right: false },
        { label: 'Expected', weight: 1, right: true },
        { label: 'Counted', weight: 1, right: true },
        { label: 'Variance', weight: 1, right: true },
        { label: 'Reason / approved by', weight: 3.2, right: false },
      ],
      d.shifts.map((x) =>
        [
          x.till,
          x.cashier,
          x.status,
          money(x.expected),
          money(x.counted),
          money(x.variance),
          [x.reason, x.approved_by ? `approved by ${x.approved_by}` : null]
            .filter(Boolean)
            .join(' · '),
        ].map(pdfText),
      ),
    );
  layout.section('Voids and waste');
  layout.pairs([
    [
      'Voids and cancellations',
      `${pdfCell('int', d.voids.events)} (${pdfCell('int', d.voids.units)} items)`,
    ],
    ['Value of voided items', money(d.voids.value)],
    ['Waste records', pdfCell('int', d.waste.records)],
    ...(d.waste.cost === null ? [] : [['Waste cost', money(d.waste.cost)] as [string, string]]),
  ]);
  layout.section('Top 10 items');
  const margins = d.profit !== null;
  layout.table(
    [
      { label: 'Item', weight: 3, right: false },
      { label: 'Sold', weight: 1, right: true },
      { label: 'Net sales', weight: 1, right: true },
      ...(margins ? [{ label: 'Margin', weight: 1, right: true }] : []),
    ],
    d.topItems.map((i) => [
      pdfText(i.item),
      pdfCell('int', i.items),
      money(i.net_sales),
      ...(margins ? [pdfCell('pct', i.margin)] : []),
    ]),
  );
  if (d.profit) {
    const p = d.profit;
    layout.section('Costs and margin');
    layout.pairs([
      ['COGS', money(p.cogs)],
      ['COGS coverage', pdfCell('pct', p.coverage)],
      ['Waste', money(p.waste)],
      ['Stock variance', money(p.variance)],
      ['Gross profit after waste', money(p.gross_profit)],
      ['Gross margin', pdfCell('pct', p.margin)],
      ['Recorded operating result', p.needs_recipes ?? money(p.operating_result)],
    ]);
  }
  layout.section('Alerts open at day end');
  if (d.alerts.length === 0) layout.paragraph('None.', 9);
  else layout.pairs(d.alerts.map((a) => [a.label, pdfCell('int', a.open)]));
  layout.section('About this report');
  layout.paragraph(
    `Business date ${d.date}. A business day runs from 04:00 to 03:59 the next morning (Asia/Karachi, D-22). ` +
      'Sales count on the date the bill was settled, refunds on their own date. Made once, after the day ended; ' +
      'later changes to that day appear in the reports, not here.',
  );
  layout.paragraph(`Made ${shopTime(new Date(d.generatedAt), options.timeZone)} (shop clock).`);
  return layout.finish();
}
