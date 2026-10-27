/**
 * Delivery privacy (D-25; SECURITY.md §2.6; Phase 5 step 5.6). A finished delivery's
 * customer name, phone, e-mail, address, landmark and notes are removed once its business
 * date is older than `privacy.delivery_pii_retention_months`. The sale itself (session,
 * bill, payments, refunds, ledger, stock) stays as it was (AT-105). Run nightly; each run
 * leaves one audit line with how many were redacted, never the details themselves.
 */
import { z } from 'zod';
import { writeAudit } from '../../platform/audit.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { businessDateOf, readSetting } from '../../platform/settings.ts';

export async function redactDeliveryDetails(
  tx: Tx,
  now: Date,
): Promise<{ redacted: number; olderThan: string }> {
  const months = await readSetting(
    tx,
    'privacy.delivery_pii_retention_months',
    z.number().int().min(1),
  );
  const today = await businessDateOf(tx, now);
  const { rows: cut } = await tx.query<{ d: string }>(
    `SELECT ($1::date - make_interval(months => $2))::date::text AS d`,
    [today, months],
  );
  const olderThan = cut[0]?.d ?? today;
  // Finished deliveries only; one still on the road keeps its address.
  const { rows: due } = await tx.query<{ delivery_id: string; session_id: string }>(
    `SELECT d.id::text AS delivery_id, s.id::text AS session_id
       FROM cl.delivery_orders d JOIN cl.dining_sessions s ON s.id = d.session_id
      WHERE d.redacted_at IS NULL AND d.status IN ('delivered', 'cancelled', 'converted_to_pickup')
        AND s.status IN ('settled', 'cancelled') AND s.business_date < $1::date
      ORDER BY s.id`,
    [olderThan],
  );
  if (due.length === 0) return { redacted: 0, olderThan };
  // Lock order (DATABASE.md §14): sessions before deliveries.
  await tx.query(
    `UPDATE cl.dining_sessions SET customer_name = NULL, customer_phone = NULL, customer_email = NULL
      WHERE id = ANY($1::bigint[])`,
    [due.map((r) => r.session_id)],
  );
  await tx.query(
    `UPDATE cl.delivery_orders SET address = NULL, landmark = NULL, notes = NULL, redacted_at = now()
      WHERE id = ANY($1::bigint[])`,
    [due.map((r) => r.delivery_id)],
  );
  await writeAudit(
    tx,
    { actor: { kind: 'system' }, correlationId: crypto.randomUUID() },
    {
      action: 'privacy.redact',
      entityType: 'delivery_order',
      after: { redacted: due.length, olderThan, months },
    },
  );
  return { redacted: due.length, olderThan };
}
