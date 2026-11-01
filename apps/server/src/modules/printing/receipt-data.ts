/**
 * What a customer receipt shows (PRINTING_HARDWARE.md §4), read from the settled invoice
 * and its payments. The receipt never changes after settlement: reprints read the same
 * frozen rows (AT-97) and only add their REPRINT banner.
 *
 * Subtotal is the items at their prices; promotions, discounts and comps follow as
 * negative lines, then the rounding line, so the receipt adds up line by line.
 */
import { Decimal, money } from '@cl/shared';
import { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import type { ReceiptData } from './documents.ts';
import { receiptLayout } from './receipt-design.ts';

const template = z.object({
  shopName: z.string().min(1),
  addressLine: z.string().nullable(),
  phone: z.string().nullable(),
  footer: z.string(),
  layout: receiptLayout.optional(),
});

const PROVIDER: Record<string, string> = {
  bank: 'Bank transfer',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
};

export async function receiptData(db: Queryable, invoiceId: string): Promise<ReceiptData> {
  const { rows } = await db.query<{
    invoice_no: string | null;
    status: string;
    at: Date | null;
    session_no: string;
    table_name: string | null;
    cashier: string | null;
    rounding_adjustment: string;
    total: string;
    paid_total: string;
    customer_name: string | null;
    customer_phone: string | null;
    address: string | null;
    landmark: string | null;
    notes: string | null;
    payment_mode: string | null;
    rider: string | null;
  }>(
    `SELECT i.invoice_no, i.status, coalesce(i.settled_at, i.locked_at) AS at, s.session_no, t.name AS table_name,
            u.display_name AS cashier, i.rounding_adjustment::text, i.total::text, i.paid_total::text,
            s.customer_name, s.customer_phone, d.address, d.landmark, d.notes, d.payment_mode,
            r.display_name AS rider
       FROM cl.invoices i JOIN cl.dining_sessions s ON s.id = i.session_id
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
       LEFT JOIN cl.users u ON u.id = coalesce(i.settled_by, i.locked_by)
       LEFT JOIN cl.delivery_orders d ON d.session_id = s.id
       LEFT JOIN cl.staff_profiles r ON r.id = d.rider_id
      WHERE i.id = $1`,
    [invoiceId],
  );
  const inv = rows[0];
  // A settled bill's receipt, or the rider's slip of a prepared (locked) delivery bill.
  if (!inv?.at || (inv.status !== 'settled' && !(inv.status === 'locked' && inv.rider))) {
    throw new Error(`invoice ${invoiceId} has no receipt to print`);
  }

  const { rows: tpl } = await db.query<{ definition: unknown }>(
    `SELECT definition FROM cl.ticket_templates WHERE kind = 'receipt' AND is_active`,
  );
  const shop = template.parse(tpl[0]?.definition);

  const { rows: lines } = await db.query<{
    order_line_id: string;
    description_snap: string;
    billable_qty: number;
    unit_price: string;
    promotion_discount: string;
  }>(
    `SELECT order_line_id::text, description_snap, billable_qty, unit_price::text, promotion_discount::text
       FROM cl.invoice_lines WHERE invoice_id = $1 ORDER BY invoice_lines.id`,
    [invoiceId],
  );
  const { rows: mods } = await db.query<{
    line_id: string;
    name: string;
    qty: number;
    delta: string;
  }>(
    `SELECT m.line_id::text, m.name_snap AS name, m.qty, m.price_delta_snap::text AS delta
       FROM cl.order_line_modifiers m JOIN cl.invoice_lines il ON il.order_line_id = m.line_id
      WHERE il.invoice_id = $1 ORDER BY m.id`,
    [invoiceId],
  );
  const { rows: discounts } = await db.query<{
    kind: string;
    value: string;
    amount: string;
    reason: string;
  }>(
    `SELECT kind, value::text, amount::text, reason FROM cl.discount_applications
      WHERE invoice_id = $1 AND voided_at IS NULL AND amount > 0 ORDER BY discount_applications.id`,
    [invoiceId],
  );
  const { rows: payments } = await db.query<{
    method: string;
    transfer_provider: string | null;
    amount: string;
    tendered: string | null;
    change_due: string | null;
    reference: string | null;
  }>(
    `SELECT method, transfer_provider, amount::text, tendered::text, change_due::text, reference
       FROM cl.payments WHERE invoice_id = $1 ORDER BY payments.id`,
    [invoiceId],
  );

  let subtotal = new Decimal(0);
  let promotions = new Decimal(0);
  const receiptLines = lines.map((l) => {
    const own = new Decimal(l.unit_price).times(l.billable_qty);
    const modifiers = mods
      .filter((m) => m.line_id === l.order_line_id)
      .map((m) => {
        const value = new Decimal(m.delta).times(m.qty).times(l.billable_qty);
        subtotal = subtotal.plus(value);
        return {
          name: m.qty > 1 ? `${m.name} ×${String(m.qty)}` : m.name,
          amount: money.format(value),
        };
      });
    subtotal = subtotal.plus(own);
    promotions = promotions.plus(l.promotion_discount);
    return { qty: l.billable_qty, name: l.description_snap, amount: money.format(own), modifiers };
  });

  const change = payments.reduce(
    (sum, p) => (p.change_due ? sum.plus(p.change_due) : sum),
    new Decimal(0),
  );
  return {
    shop: { name: shop.shopName, addressLine: shop.addressLine, phone: shop.phone },
    invoiceNo: inv.status === 'settled' ? inv.invoice_no : null,
    where: inv.table_name ? `Table: ${inv.table_name}` : inv.session_no,
    at: inv.at,
    cashier: inv.cashier ?? '',
    lines: receiptLines,
    subtotal: money.format(subtotal),
    discounts: [
      ...(promotions.gt(0) ? [{ label: 'Promotions', amount: money.format(promotions) }] : []),
      ...discounts.map((d) => ({
        label:
          d.kind === 'comp'
            ? `Comp (${d.reason})`
            : d.kind === 'percent'
              ? `Discount (${d.reason} ${new Decimal(d.value).toString()}%)`
              : `Discount (${d.reason})`,
        amount: d.amount,
      })),
    ],
    rounding: inv.rounding_adjustment,
    total: inv.total,
    payments: payments.map((p) => ({
      label:
        p.method === 'cash'
          ? 'Cash'
          : p.method === 'card_manual'
            ? `Card ref ${p.reference ?? ''}`
            : `${PROVIDER[p.transfer_provider ?? ''] ?? 'Transfer'} ref ${p.reference ?? ''}`,
      amount: p.method === 'cash' ? (p.tendered ?? p.amount) : p.amount,
    })),
    change: payments.some((p) => p.method === 'cash') ? money.format(change) : null,
    delivery: inv.rider
      ? {
          rider: inv.rider,
          deliverTo: [
            inv.customer_name,
            inv.customer_phone,
            inv.address,
            inv.landmark,
            inv.notes,
          ].filter((x): x is string => Boolean(x)),
          collect:
            inv.status === 'settled' || inv.payment_mode === 'prepaid'
              ? null
              : {
                  amount: money.format(new Decimal(inv.total).minus(inv.paid_total)),
                  by: inv.payment_mode === 'cod_cash' ? ('cash' as const) : ('card' as const),
                },
        }
      : null,
    footer: shop.footer,
    layout: shop.layout,
  };
}
