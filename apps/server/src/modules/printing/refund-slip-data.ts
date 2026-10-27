/**
 * What a refund slip prints (step 5.2), read from the refund, its lines and the original
 * invoice. The shop header comes from the active receipt template.
 */
import { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import type { RefundSlipData } from './documents.ts';

const template = z.object({
  shopName: z.string().min(1),
  addressLine: z.string().nullable(),
  phone: z.string().nullable(),
});

const PROVIDER: Record<string, string> = {
  bank: 'Bank transfer',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
};

function methodLabel(method: string, provider: string | null, reference: string | null): string {
  const ref = reference ? ` ref ${reference}` : '';
  if (method === 'cash') return 'Cash';
  if (method === 'card_manual') return `Card${ref}`;
  return `${PROVIDER[provider ?? ''] ?? 'Transfer'}${ref}`;
}

export async function refundSlipData(db: Queryable, refundId: string): Promise<RefundSlipData> {
  const { rows } = await db.query<{
    refund_no: string;
    kind: 'refund' | 'method_correction';
    invoice_no: string;
    table_name: string | null;
    session_no: string;
    created_at: Date;
    amount: string;
    method: string;
    transfer_provider: string | null;
    previous_method: string | null;
    previous_provider: string | null;
    reference: string | null;
    reason: string;
    requested_by: string;
    approved_by: string;
  }>(
    `SELECT r.refund_no, r.kind, i.invoice_no, t.name AS table_name, s.session_no, r.created_at, r.amount::text,
            r.method, r.transfer_provider, r.previous_method, r.previous_provider, r.reference,
            r.reason,
            q.display_name AS requested_by, a.display_name AS approved_by
       FROM cl.refunds r
       JOIN cl.invoices i ON i.id = r.invoice_id
       JOIN cl.dining_sessions s ON s.id = i.session_id
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
       JOIN cl.users q ON q.id = r.requested_by
       JOIN cl.users a ON a.id = r.approved_by
      WHERE r.id = $1`,
    [refundId],
  );
  const r = rows[0];
  if (!r) throw new Error(`refund ${refundId} not found`);
  const { rows: tpl } = await db.query<{ definition: unknown }>(
    `SELECT definition FROM cl.ticket_templates WHERE kind = 'receipt' AND is_active`,
  );
  const shop = template.parse(tpl[0]?.definition);
  const { rows: lines } = await db.query<{ qty: number; name: string; amount: string }>(
    `SELECT rl.qty, l.description_snap AS name, rl.amount::text
       FROM cl.refund_lines rl JOIN cl.invoice_lines l ON l.id = rl.invoice_line_id
      WHERE rl.refund_id = $1 ORDER BY rl.id`,
    [refundId],
  );
  return {
    shop: { name: shop.shopName, addressLine: shop.addressLine, phone: shop.phone },
    refundNo: r.refund_no,
    kind: r.kind,
    invoiceNo: r.invoice_no,
    where: r.table_name ? `Table: ${r.table_name}` : r.session_no,
    at: r.created_at,
    lines,
    amount: r.amount,
    method: methodLabel(r.method, r.transfer_provider, r.reference),
    previousMethod: r.previous_method
      ? methodLabel(r.previous_method, r.previous_provider, null)
      : null,
    reason: r.reason,
    requestedBy: r.requested_by,
    approvedBy: r.approved_by,
  };
}
