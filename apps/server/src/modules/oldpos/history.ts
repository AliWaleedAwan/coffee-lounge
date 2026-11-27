/**
 * The old POS's customers and sales (owner's request, Nov 2026). Customers are known by their
 * mobile number, written one way (03xx...), so the same person typed as +92 300... and 0300...
 * is one customer; the newest name and location win. Sales go in as history, as they were.
 */
import type { Tx } from '../../platform/db/tx.ts';

export interface OldBill {
  /** The old database's own id (its bill numbers repeat). */
  id: number;
  billNo: number;
  /** Shop time as the old POS wrote it: YYYY-MM-DDTHH:mm:ss. */
  at: string;
  total: number;
  discount: number;
  payable: number;
  paid: number;
  balance: number;
  status: string;
  customerName: string;
  mobile: string;
  location: string;
  cashier: string;
}

export interface OldLine {
  id: number;
  billNo: number;
  at: string;
  barcode: string;
  name: string;
  category: string;
  qty: number;
  price: number;
  amount: number;
  status: string;
}

export interface PlannedCustomer {
  mobile: string;
  name: string | null;
  location: string | null;
  lastSeen: string;
}

/** Digits only, Pakistani mobiles as 03xx...; null when it cannot be a phone number. */
export function normalizeMobile(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (/^0092\d{10}$/.test(digits)) digits = digits.slice(2);
  if (/^92\d{10}$/.test(digits)) digits = `0${digits.slice(2)}`;
  if (/^3\d{9}$/.test(digits)) digits = `0${digits}`;
  return /^\d{7,15}$/.test(digits) ? digits : null;
}

const text = (raw: string, max: number): string | null => {
  const t = raw.replace(/\s+/g, ' ').trim().slice(0, max);
  return t ? t : null;
};

export function planCustomers(bills: readonly OldBill[]): PlannedCustomer[] {
  const byMobile = new Map<string, PlannedCustomer>();
  const ordered = [...bills].sort((a, b) => a.at.localeCompare(b.at));
  for (const b of ordered) {
    const mobile = normalizeMobile(b.mobile);
    if (!mobile) continue;
    const seen = b.at.slice(0, 10);
    const known = byMobile.get(mobile);
    byMobile.set(mobile, {
      mobile,
      name: text(b.customerName, 60) ?? known?.name ?? null,
      location: text(b.location, 300) ?? known?.location ?? null,
      lastSeen: seen,
    });
  }
  return [...byMobile.values()];
}

const BATCH = 2000;

function* chunks<T>(rows: readonly T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += BATCH) yield rows.slice(i, i + BATCH);
}

/** Adds what is not there yet; returns how many were new. */
export async function applyHistory(
  tx: Tx,
  data: { bills: readonly OldBill[]; lines: readonly OldLine[] },
  timeZone: string,
): Promise<{ bills: number; lines: number }> {
  let bills = 0;
  for (const part of chunks(data.bills)) {
    const res = await tx.query(
      `INSERT INTO cl.old_pos_bills (old_id, bill_no, sold_at, total, discount, payable, paid, balance,
                                    status, customer_mobile, cashier)
       SELECT b.id, b.bill_no, b.at::timestamp AT TIME ZONE $12, b.total, b.discount, b.payable,
              b.paid, b.balance, b.status, b.mobile, b.cashier
         FROM unnest($1::int[], $2::int[], $3::text[], $4::int[], $5::int[], $6::int[], $7::int[],
                     $8::int[], $9::text[], $10::text[], $11::text[])
              AS b(id, bill_no, at, total, discount, payable, paid, balance, status, mobile, cashier)
       ON CONFLICT (old_id) DO NOTHING`,
      [
        part.map((b) => b.id),
        part.map((b) => b.billNo),
        part.map((b) => b.at),
        part.map((b) => b.total),
        part.map((b) => b.discount),
        part.map((b) => b.payable),
        part.map((b) => b.paid),
        part.map((b) => b.balance),
        part.map((b) => b.status.trim().toLowerCase().slice(0, 20) || 'unknown'),
        part.map((b) => normalizeMobile(b.mobile)),
        part.map((b) => text(b.cashier, 60)),
        timeZone,
      ],
    );
    bills += res.rowCount ?? 0;
  }
  let lines = 0;
  for (const part of chunks(data.lines)) {
    const res = await tx.query(
      `INSERT INTO cl.old_pos_bill_lines (old_id, bill_no, sold_at, item, category, barcode, qty,
                                         price, amount, status)
       SELECT l.id, l.bill_no, l.at::timestamp AT TIME ZONE $11, l.item, l.category, l.barcode,
              l.qty, l.price, l.amount, l.status
         FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[],
                     $7::int[], $8::int[], $9::int[], $10::text[])
              AS l(id, bill_no, at, item, category, barcode, qty, price, amount, status)
       ON CONFLICT (old_id) DO NOTHING`,
      [
        part.map((l) => l.id),
        part.map((l) => l.billNo),
        part.map((l) => l.at),
        part.map((l) => text(l.name, 120) ?? '(no name)'),
        part.map((l) => text(l.category, 60)),
        part.map((l) => text(l.barcode, 40)),
        part.map((l) => l.qty),
        part.map((l) => l.price),
        part.map((l) => l.amount),
        part.map((l) => l.status.trim().toLowerCase().slice(0, 20) || 'unknown'),
        timeZone,
      ],
    );
    lines += res.rowCount ?? 0;
  }
  return { bills, lines };
}

/** New customers are added; a known one takes a newer name or location. */
export async function applyCustomers(
  tx: Tx,
  customers: readonly PlannedCustomer[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const part of chunks(customers)) {
    const { rows } = await tx.query<{ created: boolean }>(
      `INSERT INTO cl.customers (mobile, name, location, last_seen)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::date[])
       ON CONFLICT (mobile) DO UPDATE
          SET name = coalesce(EXCLUDED.name, customers.name),
              location = coalesce(EXCLUDED.location, customers.location),
              last_seen = EXCLUDED.last_seen,
              updated_at = now()
        WHERE customers.last_seen IS NULL OR EXCLUDED.last_seen > customers.last_seen
       RETURNING (xmax = 0) AS created`,
      [
        part.map((c) => c.mobile),
        part.map((c) => c.name),
        part.map((c) => c.location),
        part.map((c) => c.lastSeen),
      ],
    );
    for (const r of rows) {
      if (r.created) created += 1;
      else updated += 1;
    }
  }
  return { created, updated };
}
