/**
 * Golden outputs of the printed documents (TEST_PLAN.md AT-83, AT-84). Each document is
 * rendered to ESC/POS, decoded the way a printer would print it, and compared with the
 * reviewed text in ./golden. After an intended layout change:
 *   UPDATE_GOLDEN=1 corepack pnpm exec vitest run --project server apps/server/test/printing
 * and review the diff of the .txt files (input I-5: the owner reviews them).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  renderDayEnd,
  renderKitchenTicket,
  renderReceipt,
  renderRefundSlip,
  renderShiftReport,
  renderTestPage,
  type DayEndPrintData,
  type KitchenTicketData,
  type PrintOptions,
  type ReceiptData,
  type RefundSlipData,
  type ShiftReportData,
} from '../../src/modules/printing/documents.ts';
import { toPrintable, wrap } from '../../src/modules/printing/escpos.ts';
import { decodeEscPos } from '../support/escpos/decoder.ts';

const GOLDEN = new URL('./golden/', import.meta.url);
const AT = new Date('2026-10-19T09:02:00Z'); // 14:02 in Karachi
const options: PrintOptions = { width: 48, canCut: true, copyNo: 1, timeZone: 'Asia/Karachi' };

function golden(name: string, bytes: Buffer): string {
  const decoded = decodeEscPos(bytes);
  expect(decoded.unknown, `${name}: unknown commands`).toEqual([]);
  expect(decoded.drawerKicks, `${name}: no drawer (D-03)`).toBe(0);
  const file = new URL(`${name}.txt`, GOLDEN);
  if (process.env['UPDATE_GOLDEN'] === '1' || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, `${decoded.text}\n`);
  }
  expect(`${decoded.text}\n`, `${name} differs from its golden file`).toBe(
    readFileSync(file, 'utf8'),
  );
  return decoded.text;
}

const ticket: KitchenTicketData = {
  ticketNo: 'K-1019-118',
  kind: 'supplement',
  supersedes: null,
  where: 'T5',
  orderType: 'dine_in',
  roundNo: 3,
  at: AT,
  acceptedBy: 'Sara',
  lines: [
    {
      qty: 2,
      item: 'Cappuccino',
      variant: 'Regular',
      modifiers: ['Oat milk', 'Extra shot'],
      notes: 'less foam, very hot',
    },
    { qty: 1, item: 'Club Sandwich', variant: 'Regular', modifiers: [], notes: null },
    {
      qty: 1,
      item: 'Chocolate fudge brownie with extra walnuts and salted caramel',
      variant: 'Slice',
      modifiers: [],
      notes: 'Please cut into four pieces for the children at the table, thank you very much',
    },
  ],
};

const receipt: ReceiptData = {
  shop: { name: 'Coffee Lounge', addressLine: '12 Main Boulevard, Gulberg', phone: '0300 0000000' },
  invoiceNo: 'INV-2026-000123',
  where: 'Table: T5',
  at: AT,
  cashier: 'Ali',
  lines: [
    {
      qty: 2,
      name: 'Cappuccino Regular',
      amount: '1300.00',
      modifiers: [{ name: 'Oat milk ×2', amount: '300.00' }],
    },
    { qty: 1, name: 'Club Sandwich', amount: '950.00', modifiers: [] },
    {
      qty: 12,
      name: 'Chocolate chip cookie with a very long name indeed',
      amount: '3000.00',
      modifiers: [],
    },
  ],
  subtotal: '5550.00',
  discounts: [{ label: 'Discount (Staff 10%)', amount: '555.00' }],
  rounding: '0.00',
  total: '4995.00',
  payments: [{ label: 'Cash', amount: '5000.00' }],
  change: '5.00',
  delivery: null,
  footer: 'Thank you — see you again!',
};

/** Decimal amounts like 650.00 or 1,300.00, and the currency marker. */
const MONEY = /(\bRs\b)|(\d[\d,]*\.\d{2}\b)/;

describe('kitchen tickets (AT-83)', () => {
  it('a supplement ticket: names, choices and notes, never a price', () => {
    const text = golden('kitchen-supplement', renderKitchenTicket(ticket, options));
    expect(text).not.toMatch(MONEY);
    expect(text).toContain('ROUND 3 · ADD-ON');
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48);
  });

  it('correction, void and reprint banners', () => {
    const correction = golden(
      'kitchen-correction',
      renderKitchenTicket(
        {
          ...ticket,
          kind: 'correction',
          ticketNo: 'K-1019-121',
          supersedes: 'K-1019-118',
          lines: ticket.lines.slice(0, 1),
        },
        options,
      ),
    );
    expect(correction).toMatch(/^CORRECTION$/m);
    expect(correction).toContain('Replaces K-1019-118');
    expect(correction).toContain('CANCEL 2 x Cappuccino (Regular)');
    const voided = golden(
      'kitchen-void',
      renderKitchenTicket(
        { ...ticket, kind: 'void', ticketNo: 'K-1019-122', supersedes: 'K-1019-118' },
        options,
      ),
    );
    expect(voided).toMatch(/^VOID$/m);
    const reprint = golden(
      'kitchen-reprint',
      renderKitchenTicket({ ...ticket, kind: 'new' }, { ...options, copyNo: 2 }),
    );
    expect(reprint.split('\n')[0]).toBe('*** REPRINT #2 ***');
    for (const t of [correction, voided, reprint]) expect(t).not.toMatch(MONEY);
  });

  it('a takeaway ticket on 58 mm paper (32 characters)', () => {
    const text = golden(
      'kitchen-takeaway-58mm',
      renderKitchenTicket(
        {
          ...ticket,
          kind: 'new',
          where: 'S-20261019-0031',
          orderType: 'takeaway',
          roundNo: 1,
        },
        { ...options, width: 32 },
      ),
    );
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(32);
  });
});

describe('receipt (AT-84)', () => {
  it('every line fits in 48 characters and amounts line up on the right', () => {
    const text = golden('receipt', renderReceipt(receipt, options));
    const lines = text.split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(48);
    for (const line of lines.filter((l) => /\d\.\d{2}$/.test(l)))
      expect(line.length, line).toBe(48);
    expect(text).toContain('TOTAL');
    expect(text).toMatch(/Rs 4,995\.00$/m);
  });

  it('a reprint is labelled', () => {
    const text = golden('receipt-reprint', renderReceipt(receipt, { ...options, copyNo: 3 }));
    expect(text.split('\n')[0]).toBe('*** REPRINT #3 ***');
  });
});

const shift: ShiftReportData = {
  shiftId: '12',
  till: 'Counter',
  cashier: 'Ali',
  openedAt: new Date('2026-10-19T04:00:00Z'), // 09:00 in Karachi
  closedAt: new Date('2026-10-19T12:05:00Z'),
  closedBy: 'Ali',
  openingFloat: '5000.00',
  cashSales: '41620.00',
  cashRefunds: '0.00',
  paidIn: '0.00',
  paidOut: '1200.00',
  expectedCash: '45420.00',
  countedCash: '45350.00',
  variance: '-70.00',
  varianceReason: 'Change given twice to table 4, guest returned only part of it',
  approvedBy: 'Sara',
  status: 'approved',
  card: '28450.00',
  transfers: [
    { label: 'JazzCash', amount: '6300.00' },
    { label: 'Easypaisa', amount: '2100.00' },
    { label: 'Bank transfer', amount: '0.00' },
  ],
  movements: [{ kind: 'paid_out', amount: '1200.00', reason: 'Milk top-up, receipt kept' }],
};

describe('cash shift report (step 3.8)', () => {
  it('float, sales, movements, expected, counted, variance and the slips to check', () => {
    const text = golden('shift-report', renderShiftReport(shift, options));
    expect(text).toContain('Variance approved by Sara.');
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48);
  });
});

const refund: RefundSlipData = {
  shop: { name: 'Coffee Lounge', addressLine: '12 Main Boulevard, Gulberg', phone: '0300 0000000' },
  refundNo: 'RF-2026-00007',
  kind: 'refund',
  invoiceNo: 'INV-2026-000123',
  where: 'Table: T5',
  at: AT,
  lines: [{ qty: 1, name: 'Cappuccino Regular', amount: '650.00' }],
  amount: '650.00',
  method: 'Card ref 482910',
  previousMethod: null,
  reason: 'Wrong milk, guest did not drink it',
  requestedBy: 'Ali',
  approvedBy: 'Owner',
};

describe('refund slip (step 5.2)', () => {
  it('refund number, invoice, lines and amount, method, reason and approver', () => {
    const text = golden('refund-slip', renderRefundSlip(refund, options));
    expect(text).toContain('RF-2026-00007');
    expect(text).toContain('Invoice: INV-2026-000123');
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48);
  });

  it('a payment-method correction says what it was and what it is', () => {
    const text = golden(
      'refund-slip-correction',
      renderRefundSlip(
        {
          ...refund,
          refundNo: 'RF-2026-00008',
          kind: 'method_correction',
          lines: [],
          amount: '4995.00',
          method: 'Card ref 112233',
          previousMethod: 'Cash',
          reason: 'Paid by card, recorded as cash by mistake',
        },
        options,
      ),
    );
    expect(text).toContain('PAYMENT CORRECTED');
    expect(text).not.toContain('signature');
  });
});

const dayEnd: DayEndPrintData = {
  date: '2026-10-19',
  generatedAt: new Date('2026-10-19T23:25:00Z'), // 04:25 next morning in Karachi
  sales: {
    orders: 42,
    gross: '31500.00',
    discounts: '1250.00',
    refunds: '650.00',
    net_sales: '29600.00',
    rounding: '-3.00',
    aov: '720.24',
  },
  byOrderType: [
    { label: 'Dine-in', orders: 30, net_sales: '22000.00' },
    { label: 'Takeaway', orders: 9, net_sales: '5100.00' },
    { label: 'Delivery', orders: 3, net_sales: '2500.00' },
  ],
  payments: [
    { method: 'Cash', collected: '14850.00' },
    { method: 'Card', collected: '9100.00' },
    { method: 'JazzCash', collected: '5000.00' },
  ],
  openBills: { count: 2, value: '1700.00' },
  cod: [{ rider: 'Bilal', amount: '1250.00' }],
  shifts: [{ till: 'Counter', cashier: 'Sara', status: 'approved', variance: '-20.00' }],
  voids: { events: 3, value: '1100.00' },
  waste: { records: 2 },
  topItems: [
    { item: 'Cappuccino Regular', items: 18 },
    { item: 'Chicken club sandwich', items: 7 },
  ],
  alerts: [{ label: 'Stock low', open: 2 }],
};

describe('day-end summary (step 6.5)', () => {
  it('sales, payments, what stood open, shifts, voids and alerts; no costs on paper', () => {
    const text = golden('day-end', renderDayEnd(dayEnd, options));
    expect(text).toContain('Costs and margins are on the day-end PDF.');
    expect(text).not.toMatch(/COGS|margin %/i);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48);
  });
});

describe('test page and text safety', () => {
  it('prints a test page with the printer and the line width', () => {
    const text = golden(
      'test-page',
      renderTestPage({ printerName: 'Counter printer', connection: 'spooler', at: AT }, options),
    );
    expect(text).toContain('TEST PRINT');
    expect(text).toContain('48 characters fit on each line.');
  });

  it('never sends control characters; text CP437 lacks becomes ASCII or ?', () => {
    expect(toPrintable('no\u001b[2J foam\u0007 × 2 — “hot”')).toBe('no [2J foam  x 2 - "hot"');
    expect(toPrintable('چائے')).toBe('????');
    expect(wrap('a verylongwordthatdoesnotfit here', 10, '  ')).toEqual([
      'a',
      '  verylong',
      '  wordthat',
      '  doesnotf',
      '  it here',
    ]);
  });
});
