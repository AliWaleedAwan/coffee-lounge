/**
 * Printed documents (PRINTING_HARDWARE.md §4): the kitchen ticket, the customer receipt,
 * the cash shift report, the day-end summary and a test page, each rendered to ESC/POS for a given line width (48 on 80 mm paper).
 *
 * The kitchen ticket is rendered from `KitchenTicketData`, which has no field for a
 * price, a payment or a guest's details: such things cannot reach the kitchen (AT-99,
 * AT-83). Golden files in test/printing/golden pin every layout (AT-83, AT-84).
 */
import { amount, columns, EscPos, rule, toPrintable, twoCols, wrap, type Align } from './escpos.ts';

export interface PrintOptions {
  width: number;
  canCut: boolean;
  /** Copies after the first are reprints, labelled "REPRINT #n". */
  copyNo: number;
  timeZone: string;
}

export function shopTime(at: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return `${p['day'] ?? ''} ${p['month'] ?? ''} ${p['year'] ?? ''} ${p['hour'] ?? ''}:${p['minute'] ?? ''}`;
}

function reprintBanner(doc: EscPos, copyNo: number): void {
  if (copyNo <= 1) return;
  doc
    .align('center')
    .bold(true)
    .line(`*** REPRINT #${String(copyNo)} ***`)
    .bold(false)
    .align('left');
}

// ---------------------------------------------------------------- kitchen ticket

export interface KitchenTicketData {
  ticketNo: string;
  kind: 'new' | 'supplement' | 'correction' | 'void';
  /** The ticket a correction or void replaces. */
  supersedes: string | null;
  /** The table ("Patio"), or the visit number for takeaway and delivery: never a guest's name. */
  where: string;
  orderType: 'dine_in' | 'takeaway' | 'delivery';
  roundNo: number;
  at: Date;
  acceptedBy: string | null;
  lines: {
    qty: number;
    item: string;
    variant: string;
    modifiers: string[];
    notes: string | null;
  }[];
}

const ORDER_TYPE: Record<KitchenTicketData['orderType'], string> = {
  dine_in: 'DINE-IN',
  takeaway: 'TAKEAWAY',
  delivery: 'DELIVERY',
};

export function renderKitchenTicket(t: KitchenTicketData, o: PrintOptions): Buffer {
  const w = o.width;
  const doc = new EscPos();
  reprintBanner(doc, o.copyNo);
  const changes = t.kind === 'correction' || t.kind === 'void';
  if (changes) {
    doc
      .align('center')
      .bold(true)
      .size({ width: true, height: true })
      .line(t.kind === 'void' ? 'VOID' : 'CORRECTION');
    doc.size({}).bold(false).align('left');
  }
  doc.line(rule(w, '='));
  doc
    .bold(true)
    .line(twoCols('KITCHEN', t.ticketNo, w))
    .bold(false);
  const place =
    t.orderType === 'dine_in'
      ? `${t.where.toUpperCase()} · DINE-IN`
      : `${ORDER_TYPE[t.orderType]} · ${t.where}`;
  const round = `ROUND ${String(t.roundNo)}${t.kind === 'supplement' ? ' · ADD-ON' : ''}`;
  for (const text of columns(place, round, w)) doc.line(text);
  for (const text of columns(
    shopTime(t.at, o.timeZone),
    t.acceptedBy ? `Accepted: ${t.acceptedBy}` : '',
    w,
  ))
    doc.line(text);
  if (changes && t.supersedes) doc.line(`Replaces ${t.supersedes}`);
  doc.line(rule(w));
  for (const l of t.lines) {
    doc.bold(true);
    for (const text of wrap(
      `${changes ? 'CANCEL ' : ''}${String(l.qty)} x ${l.item} (${l.variant})`,
      w,
      '    ',
    ))
      doc.line(text);
    doc.bold(false);
    for (const m of l.modifiers)
      for (const text of wrap(`+ ${m}`, w - 4, '  ')) doc.line(`    ${text}`);
    if (l.notes)
      for (const text of wrap(`** NOTE: ${l.notes} **`, w - 4, '   ')) doc.line(`    ${text}`);
  }
  doc.line(rule(w));
  if (!changes) doc.line('Collect & tap "Picked up"');
  doc.line(rule(w, '='));
  return doc.cut(o.canCut).bytes();
}

// ---------------------------------------------------------------- receipt (printed from step 3.7)

export interface ReceiptData {
  shop: { name: string; addressLine: string | null; phone: string | null };
  /** null on a delivery slip printed before the bill is paid (COD, card on delivery). */
  invoiceNo: string | null;
  where: string;
  at: Date;
  cashier: string;
  lines: {
    qty: number;
    name: string;
    amount: string;
    modifiers: { name: string; amount: string }[];
  }[];
  subtotal: string;
  discounts: { label: string; amount: string }[];
  rounding: string;
  total: string;
  payments: { label: string; amount: string }[];
  change: string | null;
  /** The rider's copy (ORDER_STATE_MACHINE.md D1): who takes it where, and what to collect. */
  delivery: {
    rider: string;
    deliverTo: string[];
    collect: { amount: string; by: 'cash' | 'card' } | null;
  } | null;
  footer: string;
  /** The owner's receipt design (Settings → Receipt design); without one, the standard layout. */
  layout?: ReceiptLayout | undefined;
}

/** A block of the owner's own text: each line of `text` is printed, wrapped to the paper. */
export interface ReceiptBlock {
  text: string;
  align: Align;
  bold: boolean;
  size: 'normal' | 'wide' | 'big';
}

export interface ReceiptLayout {
  /** Printed under the shop name and contact line. */
  header: ReceiptBlock[];
  /** Printed after the totals, in place of the one-line footer. */
  footer: ReceiptBlock[];
  shopNameSize: 'normal' | 'wide' | 'big';
  showContact: boolean;
  showCashier: boolean;
}

const SIZE = {
  normal: {},
  wide: { width: true },
  big: { width: true, height: true },
} as const;

function block(doc: EscPos, b: ReceiptBlock, w: number): void {
  // Double width halves the characters a line holds.
  const width = b.size === 'normal' ? w : Math.floor(w / 2);
  doc.align(b.align).bold(b.bold).size(SIZE[b.size]);
  for (const part of b.text.split('\n')) {
    const lines = part.trim() ? wrap(part.trim(), width) : [''];
    for (const text of lines) doc.line(text);
  }
  doc.size({}).bold(false).align('left');
}

export function renderReceipt(r: ReceiptData, o: PrintOptions): Buffer {
  return composeReceipt(r, o).bytes();
}

/** The receipt as the printer receives it; `.preview()` gives the lines for a screen. */
export function composeReceipt(r: ReceiptData, o: PrintOptions): EscPos {
  const w = o.width;
  const doc = new EscPos();
  const layout = r.layout;
  reprintBanner(doc, o.copyNo);
  doc
    .align('center')
    .bold(true)
    .size(SIZE[layout?.shopNameSize ?? 'wide'])
    .line(r.shop.name.toUpperCase())
    .size({})
    .bold(false);
  const contact = [r.shop.addressLine, r.shop.phone]
    .filter((x): x is string => Boolean(x))
    .join('  ·  ');
  if (layout?.showContact ?? true)
    for (const text of contact ? wrap(contact, w) : []) doc.line(text);
  doc.align('left');
  for (const b of layout?.header ?? []) block(doc, b, w);
  doc.line(rule(w));
  doc.line(
    r.invoiceNo === null
      ? twoCols(`Order: ${r.where}`, 'NOT PAID YET', w)
      : twoCols(`Invoice: ${r.invoiceNo}`, r.where, w),
  );
  doc.line(
    layout && !layout.showCashier
      ? shopTime(r.at, o.timeZone)
      : twoCols(shopTime(r.at, o.timeZone), `Cashier: ${r.cashier}`, w),
  );
  if (r.delivery) {
    doc.line(rule(w));
    doc
      .bold(true)
      .line(twoCols('DELIVERY', `Rider: ${r.delivery.rider}`, w))
      .bold(false);
    for (const part of r.delivery.deliverTo) for (const text of wrap(part, w)) doc.line(text);
  }
  doc.line(rule(w));
  for (const l of r.lines) {
    const price = amount(l.amount);
    const names = wrap(l.name, w - price.length - 4);
    doc.line(twoCols(`${String(l.qty).padEnd(3)}${names[0] ?? ''}`, price, w));
    for (const more of names.slice(1)) doc.line(`   ${more}`);
    for (const mod of l.modifiers) doc.line(twoCols(`     ${mod.name}`, amount(mod.amount), w));
  }
  doc.line(rule(w));
  doc.line(twoCols('Subtotal', amount(r.subtotal), w));
  for (const d of r.discounts) doc.line(twoCols(d.label, amount(`-${d.amount}`), w));
  doc.line(twoCols('Rounding', amount(r.rounding), w));
  doc
    .bold(true)
    .line(twoCols('TOTAL', `Rs ${amount(r.total)}`, w))
    .bold(false);
  for (const p of r.payments) doc.line(twoCols(p.label, amount(p.amount), w));
  if (r.change !== null) doc.line(twoCols('Change', amount(r.change), w));
  if (r.delivery?.collect)
    doc
      .bold(true)
      .line(
        twoCols(
          r.delivery.collect.by === 'cash' ? 'CASH TO COLLECT' : 'CARD TO COLLECT',
          `Rs ${amount(r.delivery.collect.amount)}`,
          w,
        ),
      )
      .bold(false);
  doc.line(rule(w));
  if (layout) for (const b of layout.footer) block(doc, b, w);
  else {
    doc.align('center');
    for (const text of wrap(r.footer, w)) doc.line(text);
    doc.align('left');
  }
  return doc.cut(o.canCut);
}

// ---------------------------------------------------------------- refund slip (step 5.2)

export interface RefundSlipData {
  shop: { name: string; addressLine: string | null; phone: string | null };
  refundNo: string;
  kind: 'refund' | 'method_correction';
  invoiceNo: string;
  where: string;
  at: Date;
  lines: { qty: number; name: string; amount: string }[];
  amount: string;
  /** How the money went back (refund), or how it was really taken (correction). */
  method: string;
  /** Correction only: what the payment showed before. */
  previousMethod: string | null;
  reason: string;
  requestedBy: string;
  approvedBy: string;
}

/**
 * Printed when a refund or a payment-method correction is recorded (PRINTING_HARDWARE.md
 * §4): the refund number, the original invoice, lines and amount, method and approver.
 */
export function renderRefundSlip(r: RefundSlipData, o: PrintOptions): Buffer {
  const w = o.width;
  const doc = new EscPos();
  reprintBanner(doc, o.copyNo);
  doc
    .align('center')
    .bold(true)
    .size({ width: true })
    .line(r.shop.name.toUpperCase())
    .size({})
    .bold(false);
  const contact = [r.shop.addressLine, r.shop.phone]
    .filter((x): x is string => Boolean(x))
    .join('  ·  ');
  for (const text of contact ? wrap(contact, w) : []) doc.line(text);
  doc.align('left').line(rule(w));
  doc
    .bold(true)
    .line(twoCols(r.kind === 'refund' ? 'REFUND' : 'PAYMENT CORRECTED', r.refundNo, w))
    .bold(false);
  doc.line(twoCols(`Invoice: ${r.invoiceNo}`, r.where, w));
  doc.line(shopTime(r.at, o.timeZone));
  doc.line(rule(w));
  if (r.kind === 'refund') {
    for (const l of r.lines) {
      const price = amount(l.amount);
      const names = wrap(l.name, w - price.length - 4);
      doc.line(twoCols(`${String(l.qty).padEnd(3)}${names[0] ?? ''}`, price, w));
      for (const more of names.slice(1)) doc.line(`   ${more}`);
    }
    if (r.lines.length > 0) doc.line(rule(w));
    doc
      .bold(true)
      .line(twoCols('REFUNDED', `Rs ${amount(r.amount)}`, w))
      .bold(false);
    doc.line(twoCols('Paid back by', r.method, w));
  } else {
    doc.line(twoCols('Payment', `Rs ${amount(r.amount)}`, w));
    doc.line(twoCols('Recorded as', r.previousMethod ?? '', w));
    doc
      .bold(true)
      .line(twoCols('Taken by', r.method, w))
      .bold(false);
  }
  for (const text of wrap(`Reason: ${r.reason}`, w)) doc.line(text);
  doc.line(twoCols('Asked by', r.requestedBy, w));
  doc.line(twoCols('Approved by', r.approvedBy, w));
  if (r.kind === 'refund') {
    doc.line(rule(w));
    doc.line('');
    doc.line('Customer signature: ____________________');
  }
  doc.line(rule(w, '='));
  return doc.cut(o.canCut).bytes();
}

// ---------------------------------------------------------------- cash shift report

export interface ShiftReportData {
  shiftId: string;
  till: string;
  cashier: string;
  openedAt: Date;
  closedAt: Date;
  closedBy: string;
  openingFloat: string;
  cashSales: string;
  cashRefunds: string;
  paidIn: string;
  paidOut: string;
  expectedCash: string;
  countedCash: string;
  variance: string;
  varianceReason: string | null;
  /** Who approved a variance; null when it balanced or is still waiting. */
  approvedBy: string | null;
  status: 'closed' | 'approved';
  card: string;
  transfers: { label: string; amount: string }[];
  movements: { kind: 'paid_in' | 'paid_out'; amount: string; reason: string }[];
}

/** A deduction: "-1,200.00", but a plain "0.00" when there is none. */
const minus = (value: string): string => amount(/^0+\.00$/.test(value) ? value : `-${value}`);

/** Printed at shift close (FINANCE_REPORTING.md §5): what the till should hold, and why. */
export function renderShiftReport(r: ShiftReportData, o: PrintOptions): Buffer {
  const w = o.width;
  const doc = new EscPos();
  reprintBanner(doc, o.copyNo);
  doc.align('center').bold(true).size({ width: true }).line('CASH SHIFT').size({}).bold(false);
  doc.line(`${r.till} · shift ${r.shiftId}`);
  doc.align('left').line(rule(w));
  doc.line(twoCols('Cashier', r.cashier, w));
  doc.line(twoCols('Opened', shopTime(r.openedAt, o.timeZone), w));
  doc.line(twoCols('Closed', shopTime(r.closedAt, o.timeZone), w));
  doc.line(twoCols('Closed by', r.closedBy, w));
  doc.line(rule(w));
  doc.line(twoCols('Opening float', amount(r.openingFloat), w));
  doc.line(twoCols('Cash sales', amount(r.cashSales), w));
  doc.line(twoCols('Cash refunds', minus(r.cashRefunds), w));
  doc.line(twoCols('Paid in', amount(r.paidIn), w));
  doc.line(twoCols('Paid out', minus(r.paidOut), w));
  doc
    .bold(true)
    .line(twoCols('EXPECTED CASH', amount(r.expectedCash), w))
    .bold(false);
  doc.line(twoCols('Counted cash', amount(r.countedCash), w));
  doc
    .bold(true)
    .line(twoCols('VARIANCE', amount(r.variance), w))
    .bold(false);
  if (r.varianceReason) for (const text of wrap(`Reason: ${r.varianceReason}`, w)) doc.line(text);
  doc.line(
    r.variance.replace('-', '') === '0.00'
      ? 'Balanced.'
      : r.approvedBy
        ? `Variance approved by ${r.approvedBy}.`
        : 'Variance waiting for approval by a manager.',
  );
  doc.line(rule(w));
  doc.line('Not in the till (check against the slips):');
  doc.line(twoCols('Card', amount(r.card), w));
  for (const t of r.transfers) doc.line(twoCols(t.label, amount(t.amount), w));
  if (r.movements.length > 0) {
    doc.line(rule(w));
    for (const m of r.movements) {
      const sign = m.kind === 'paid_out' ? '-' : '';
      for (const line of columns(
        `${m.kind === 'paid_out' ? 'Paid out' : 'Paid in'}: ${m.reason}`,
        amount(`${sign}${m.amount}`),
        w,
      ))
        doc.line(line);
    }
  }
  doc.line(rule(w, '='));
  return doc.cut(o.canCut).bytes();
}

// ---------------------------------------------------------------- day-end summary

/** The 80 mm day-end (FINANCE_REPORTING.md §7, P6-9): sales and cash only, no costs. */
export interface DayEndPrintData {
  date: string;
  generatedAt: Date;
  sales: {
    orders: number;
    gross: string;
    discounts: string;
    refunds: string;
    net_sales: string;
    rounding: string;
    aov: string | null;
  };
  byOrderType: { label: string; orders: number; net_sales: string }[];
  payments: { method: string; collected: string }[];
  openBills: { count: number; value: string };
  cod: { rider: string; amount: string }[];
  shifts: { till: string; cashier: string; status: string; variance: string | null }[];
  voids: { events: number; value: string };
  waste: { records: number };
  topItems: { item: string; items: number }[];
  alerts: { label: string; open: number }[];
}

export function renderDayEnd(r: DayEndPrintData, o: PrintOptions): Buffer {
  const w = o.width;
  const doc = new EscPos();
  reprintBanner(doc, o.copyNo);
  doc.align('center').bold(true).size({ width: true }).line('DAY-END').size({}).bold(false);
  doc.line(`Business date ${r.date}`);
  doc.align('left').line(rule(w));
  doc.line(twoCols('Gross sales', amount(r.sales.gross), w));
  doc.line(twoCols('Discounts', minus(r.sales.discounts), w));
  doc.line(twoCols('Refunds', minus(r.sales.refunds), w));
  doc
    .bold(true)
    .line(twoCols('NET SALES', amount(r.sales.net_sales), w))
    .bold(false);
  doc.line(twoCols('Cash rounding', amount(r.sales.rounding), w));
  doc.line(twoCols('Orders', String(r.sales.orders), w));
  doc.line(twoCols('Average order', r.sales.aov === null ? '-' : amount(r.sales.aov), w));
  for (const t of r.byOrderType)
    doc.line(twoCols(`  ${t.label} (${String(t.orders)})`, amount(t.net_sales), w));
  doc.line(rule(w));
  doc.line('Collected by method:');
  for (const p of r.payments) doc.line(twoCols(`  ${p.method}`, amount(p.collected), w));
  doc.line(rule(w));
  doc.line(twoCols(`Open bills (${String(r.openBills.count)})`, amount(r.openBills.value), w));
  for (const c of r.cod) doc.line(twoCols(`  COD with ${c.rider}`, amount(c.amount), w));
  for (const s of r.shifts) {
    for (const line of columns(
      `Shift ${s.till}, ${s.cashier}: ${s.status}`,
      s.variance === null ? 'open' : `var ${amount(s.variance)}`,
      w,
    ))
      doc.line(line);
  }
  doc.line(twoCols(`Voids (${String(r.voids.events)})`, amount(r.voids.value), w));
  doc.line(twoCols('Waste records', String(r.waste.records), w));
  if (r.topItems.length > 0) {
    doc.line(rule(w));
    doc.line('Top items:');
    for (const i of r.topItems) doc.line(twoCols(`  ${i.item}`, String(i.items), w));
  }
  if (r.alerts.length > 0) {
    doc.line(rule(w));
    doc.line('Alerts open at day end:');
    for (const a of r.alerts) doc.line(twoCols(`  ${a.label}`, String(a.open), w));
  }
  doc.line(rule(w));
  for (const text of wrap('Costs and margins are on the day-end PDF.', w)) doc.line(text);
  doc.line(`Made ${shopTime(r.generatedAt, o.timeZone)}`);
  doc.line(rule(w, '='));
  return doc.cut(o.canCut).bytes();
}

// ---------------------------------------------------------------- test page (W-4)

export function renderTestPage(
  p: { printerName: string; connection: string; at: Date },
  o: PrintOptions,
): Buffer {
  const w = o.width;
  const doc = new EscPos();
  doc
    .align('center')
    .bold(true)
    .size({ width: true, height: true })
    .line('TEST PRINT')
    .size({})
    .bold(false);
  doc.line('Coffee Lounge');
  doc.align('left').line(rule(w));
  doc.line(twoCols('Printer', toPrintable(p.printerName), w));
  doc.line(twoCols('Connection', p.connection, w));
  doc.line(twoCols('Time', shopTime(p.at, o.timeZone), w));
  doc.line(rule(w));
  doc.line('1234567890'.repeat(Math.ceil(w / 10)).slice(0, w));
  doc.line(`${String(w)} characters fit on each line.`);
  doc.line('If this page printed and cut cleanly, printing works.');
  doc.line(rule(w, '='));
  return doc.cut(o.canCut).bytes();
}
