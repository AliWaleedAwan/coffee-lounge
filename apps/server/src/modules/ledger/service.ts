/**
 * The operational ledger (FINANCE_REPORTING.md §4; DATABASE.md §10; Phase 5 step 5.1).
 * Automatic entries are written by database triggers on their sources (migration 0023);
 * this module reads the ledger with running balances per channel (AT-121), posts the
 * owner's manual adjustments and their reversals (D-31: never an edit), and runs the
 * nightly check that every source has exactly its entry (AT-71). The check only reports.
 */
import { Decimal, money } from '@cl/shared';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';

export const CHANNELS = ['cash', 'card', 'transfer', 'other'] as const;
export type Channel = (typeof CHANNELS)[number];
export const PROVIDERS = ['bank', 'jazzcash', 'easypaisa'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface LedgerEntry {
  id: string;
  entryNo: string;
  entryType: string;
  direction: 'in' | 'out';
  amount: string;
  channel: Channel;
  provider: Provider | null;
  businessDate: string;
  sourceType: string;
  sourceId: string;
  /** What the entry came from, as people name it: an invoice, a GRN, a reason. */
  source: string;
  /** Where the source is seen in the app, when it has a page of its own. */
  link: string | null;
  memo: string | null;
  reversesEntryNo: string | null;
  reversedByEntryNo: string | null;
  createdBy: string | null;
  createdAt: string;
  /** The balance of this entry's channel (and transfer provider) after it. */
  balanceAfter: string;
}

export interface ChannelBalance {
  channel: Channel;
  provider: Provider | null;
  opening: string;
  in: string;
  out: string;
  closing: string;
}

/**
 * Entries of a date range in posting order with the running balance of each channel
 * (transfers per provider), and per channel the balance before the range, the money in
 * and out within it, and the balance after it (AT-121).
 */
export async function readLedger(
  db: Queryable,
  filter: { from: string; to: string; channel?: Channel | undefined },
): Promise<{
  from: string;
  to: string;
  balances: ChannelBalance[];
  entries: LedgerEntry[];
  truncated: boolean;
}> {
  const LIMIT = 3000;
  const { rows: entries } = await db.query<LedgerEntry>(
    `WITH running AS (
       SELECT e.*, sum(CASE e.direction WHEN 'in' THEN e.amount ELSE -e.amount END)
                     OVER (PARTITION BY e.channel, e.transfer_provider ORDER BY e.business_date, e.id) AS balance_after
         FROM cl.ledger_entries e
        WHERE e.business_date <= $2::date AND ($3::text IS NULL OR e.channel = $3))
     SELECT e.id::text, e.entry_no AS "entryNo", e.entry_type AS "entryType", e.direction,
            e.amount::text, e.channel, e.transfer_provider AS provider, e.business_date::text AS "businessDate",
            e.source_type AS "sourceType", e.source_id::text AS "sourceId",
            CASE e.source_type
              WHEN 'payment' THEN 'Payment · ' || COALESCE(i.invoice_no, s.session_no, 'bill')
              WHEN 'cash_movement' THEN CASE cm.kind WHEN 'paid_in' THEN 'Paid in · ' ELSE 'Paid out · ' END || cm.reason
              WHEN 'purchase_receipt' THEN 'Purchase · ' || COALESCE(pr.receipt_no, 'receipt')
              WHEN 'supplier_return' THEN 'Supplier refund · ' || COALESCE(rr.receipt_no, 'return')
              ELSE COALESCE(e.memo, e.source_type) END AS source,
            CASE WHEN s.id IS NOT NULL THEN '/sessions/' || s.id END AS link,
            e.memo, orig.entry_no AS "reversesEntryNo", rev.entry_no AS "reversedByEntryNo",
            u.display_name AS "createdBy", e.created_at AS "createdAt",
            e.balance_after::numeric(14,2)::text AS "balanceAfter"
       FROM running e
       LEFT JOIN cl.payments p ON e.source_type = 'payment' AND p.id = e.source_id
       LEFT JOIN cl.invoices i ON i.id = p.invoice_id
       LEFT JOIN cl.dining_sessions s ON s.id = i.session_id
       LEFT JOIN cl.cash_movements cm ON e.source_type = 'cash_movement' AND cm.id = e.source_id
       LEFT JOIN cl.purchase_receipts pr ON e.source_type = 'purchase_receipt' AND pr.id = e.source_id
       LEFT JOIN cl.supplier_returns sr ON e.source_type = 'supplier_return' AND sr.id = e.source_id
       LEFT JOIN cl.purchase_receipt_lines rl ON rl.id = sr.receipt_line_id
       LEFT JOIN cl.purchase_receipts rr ON rr.id = rl.receipt_id
       LEFT JOIN cl.ledger_entries orig ON orig.id = e.reverses_entry_id
       LEFT JOIN cl.ledger_entries rev ON rev.reverses_entry_id = e.id
       LEFT JOIN cl.users u ON u.id = e.created_by
      WHERE e.business_date >= $1::date
      ORDER BY e.business_date, e.id
      LIMIT ${String(LIMIT + 1)}`,
    [filter.from, filter.to, filter.channel ?? null],
  );
  const { rows: balances } = await db.query<ChannelBalance>(
    `SELECT channel, transfer_provider AS provider,
            COALESCE(sum(CASE WHEN business_date < $1::date THEN signed END), 0)::numeric(14,2)::text AS opening,
            COALESCE(sum(CASE WHEN business_date >= $1::date AND direction = 'in' THEN amount END), 0)::numeric(14,2)::text AS "in",
            COALESCE(sum(CASE WHEN business_date >= $1::date AND direction = 'out' THEN amount END), 0)::numeric(14,2)::text AS "out",
            COALESCE(sum(signed), 0)::numeric(14,2)::text AS closing
       FROM (SELECT *, CASE direction WHEN 'in' THEN amount ELSE -amount END AS signed FROM cl.ledger_entries
              WHERE business_date <= $2::date AND ($3::text IS NULL OR channel = $3)) x
      GROUP BY channel, transfer_provider
      ORDER BY array_position(ARRAY['cash','card','transfer','other'], channel), transfer_provider NULLS FIRST`,
    [filter.from, filter.to, filter.channel ?? null],
  );
  return {
    from: filter.from,
    to: filter.to,
    balances,
    entries: entries.slice(0, LIMIT),
    truncated: entries.length > LIMIT,
  };
}

async function changed(tx: Tx, entryId: string): Promise<void> {
  await publish(tx, {
    type: 'ledger.changed',
    entityType: 'ledger_entry',
    entityId: entryId,
    topics: ['ledger'],
  });
}

/** An owner's manual entry (FINANCE_REPORTING.md §4 "Manual entry"): today, with a reason. */
export async function postAdjustment(
  tx: Tx,
  who: AuditContext & { actor: { kind: 'user'; userId: string } },
  input: {
    direction: 'in' | 'out';
    amount: string;
    channel: Channel;
    provider?: Provider | undefined;
    memo: string;
  },
  businessDate: string,
): Promise<{ id: string; entryNo: string }> {
  const amount = money.parse(input.amount);
  if (amount.lessThanOrEqualTo(0))
    throw new AppError('VALIDATION_FAILED', 'Enter an amount above zero');
  if ((input.channel === 'transfer') !== (input.provider !== undefined)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'A transfer names its provider (bank, JazzCash, Easypaisa), and only a transfer',
    );
  }
  const { rows } = await tx.query<{ id: string; entry_no: string }>(
    `INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, transfer_provider, business_date,
                                    source_type, source_id, source_key, memo, created_by)
     VALUES ('pending', 'adjustment', $1, $2, $3, $4, $5, 'adjustment', 0, 'pending', $6, $7)
     RETURNING id::text, entry_no`,
    [
      input.direction,
      money.format(amount),
      input.channel,
      input.provider ?? null,
      businessDate,
      input.memo,
      who.actor.userId,
    ],
  );
  const entry = rows[0];
  if (!entry) throw new Error('adjustment not posted');
  await writeAudit(tx, who, {
    action: 'ledger.adjustment',
    entityType: 'ledger_entry',
    entityId: entry.id,
    reason: input.memo,
    after: {
      entryNo: entry.entry_no,
      direction: input.direction,
      amount: money.format(amount),
      channel: input.channel,
    },
  });
  await changed(tx, entry.id);
  return { id: entry.id, entryNo: entry.entry_no };
}

/**
 * Reverses a manual entry (D-31). Automatic entries mirror their sources and are
 * reversed through them (a refund, a voided expense, a reversed receipt).
 */
export async function reverseAdjustment(
  tx: Tx,
  who: AuditContext & { actor: { kind: 'user'; userId: string } },
  entryId: string,
  reason: string,
  businessDate: string,
): Promise<{ id: string; entryNo: string }> {
  // No row lock: entries never change, and the unique reverses_entry_id settles a race.
  const { rows } = await tx.query<{
    entry_type: string;
    direction: 'in' | 'out';
    amount: string;
    channel: Channel;
    transfer_provider: Provider | null;
    entry_no: string;
    reversed: boolean;
  }>(
    `SELECT e.entry_type, e.direction, e.amount::text, e.channel, e.transfer_provider, e.entry_no,
            EXISTS (SELECT 1 FROM cl.ledger_entries r WHERE r.reverses_entry_id = e.id) AS reversed
       FROM cl.ledger_entries e WHERE e.id = $1`,
    [entryId],
  );
  const entry = rows[0];
  if (!entry) throw new AppError('NOT_FOUND', 'Entry not found');
  if (entry.entry_type !== 'adjustment') {
    throw new AppError(
      'VALIDATION_FAILED',
      'Only manual entries are reversed here; others follow their source (refund, void, reversed receipt)',
    );
  }
  if (entry.reversed) throw new AppError('STALE_STATE', `${entry.entry_no} is already reversed`);
  try {
    const { rows: created } = await tx.query<{ id: string; entry_no: string }>(
      `INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, transfer_provider, business_date,
                                      source_type, source_id, source_key, reverses_entry_id, memo, created_by)
       VALUES ('pending', 'reversal', $1, $2, $3, $4, $5, 'adjustment', $6::bigint, 'reversal:' || $6::bigint, $6::bigint, $7, $8)
       RETURNING id::text, entry_no`,
      [
        entry.direction === 'in' ? 'out' : 'in',
        entry.amount,
        entry.channel,
        entry.transfer_provider,
        businessDate,
        entryId,
        reason,
        who.actor.userId,
      ],
    );
    const reversal = created[0];
    if (!reversal) throw new Error('reversal not posted');
    await writeAudit(tx, who, {
      action: 'ledger.reverse',
      entityType: 'ledger_entry',
      entityId: entryId,
      reason,
      after: { reversal: reversal.entry_no },
    });
    await changed(tx, reversal.id);
    return { id: reversal.id, entryNo: reversal.entry_no };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AppError('STALE_STATE', `${entry.entry_no} is already reversed`);
    }
    throw error;
  }
}

// ------------------------------------------------------------------ nightly check

export interface LedgerMismatch {
  source: string;
  sourceId: string;
  problem: string;
}

/**
 * Every money source has exactly its entry, with its amount; every automatic entry has
 * its source (AT-71). Reports only: nothing is ever corrected automatically.
 */
export async function findLedgerMismatches(db: Queryable): Promise<LedgerMismatch[]> {
  const { rows } = await db.query<LedgerMismatch>(
    `SELECT 'payment' AS source, p.id::text AS "sourceId",
            CASE WHEN e.id IS NULL THEN 'no ledger entry' ELSE 'amount ' || e.amount || ' ≠ ' || p.amount END AS problem
       FROM cl.payments p LEFT JOIN cl.ledger_entries e ON e.source_key = 'payment:' || p.id
      WHERE e.id IS NULL OR e.amount <> p.amount
     UNION ALL
     SELECT 'cash_movement', m.id::text,
            CASE WHEN e.id IS NULL THEN 'no ledger entry' ELSE 'amount ' || e.amount || ' ≠ ' || m.amount END
       FROM cl.cash_movements m LEFT JOIN cl.ledger_entries e ON e.source_key = 'cash_movement:' || m.id
      WHERE e.id IS NULL OR e.amount <> m.amount
     UNION ALL
     SELECT 'purchase_receipt', r.id::text,
            CASE WHEN e.id IS NULL THEN 'no ledger entry for its payment' ELSE 'amount ' || e.amount || ' ≠ ' || r.total_cost END
       FROM cl.purchase_receipts r LEFT JOIN cl.ledger_entries e ON e.source_key = 'purchase_receipt:' || r.id
      WHERE r.paid_now AND r.status IN ('posted','reversed') AND r.total_cost > 0
        AND (e.id IS NULL OR e.amount <> r.total_cost)
     UNION ALL
     SELECT 'purchase_receipt', r.id::text, 'reversed, but its payment is not'
       FROM cl.purchase_receipts r LEFT JOIN cl.ledger_entries e ON e.source_key = 'purchase_receipt:' || r.id || ':reversal'
      WHERE r.paid_now AND r.status = 'reversed' AND r.total_cost > 0 AND e.id IS NULL
     UNION ALL
     SELECT 'supplier_return', s.id::text,
            CASE WHEN e.id IS NULL THEN 'no ledger entry for its refund' ELSE 'amount ' || e.amount || ' ≠ ' || s.refund_amount END
       FROM cl.supplier_returns s LEFT JOIN cl.ledger_entries e ON e.source_key = 'supplier_return:' || s.id
      WHERE s.refund_amount > 0 AND (e.id IS NULL OR e.amount <> s.refund_amount)
     UNION ALL
     SELECT 'ledger_entry', e.id::text, 'its ' || e.source_type || ' ' || e.source_id || ' does not exist'
       FROM cl.ledger_entries e
      WHERE (e.source_type = 'payment' AND NOT EXISTS (SELECT 1 FROM cl.payments x WHERE x.id = e.source_id))
         OR (e.source_type = 'cash_movement' AND NOT EXISTS (SELECT 1 FROM cl.cash_movements x WHERE x.id = e.source_id))
         OR (e.source_type = 'purchase_receipt' AND NOT EXISTS (SELECT 1 FROM cl.purchase_receipts x WHERE x.id = e.source_id AND x.paid_now))
         OR (e.source_type = 'supplier_return' AND NOT EXISTS (SELECT 1 FROM cl.supplier_returns x WHERE x.id = e.source_id AND x.refund_amount > 0))
     ORDER BY 1, 2`,
  );
  return rows;
}

/** One open `ledger_mismatch` alert per source that fails the check, for the owner. */
export async function raiseLedgerAlerts(tx: Tx): Promise<LedgerMismatch[]> {
  const mismatches = await findLedgerMismatches(tx);
  for (const m of mismatches) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cl.operational_alerts (kind, entity_type, entity_id, detail)
       VALUES ('ledger_mismatch', $1, $2, $3)
       ON CONFLICT (kind, entity_type, entity_id) WHERE state <> 'resolved' DO NOTHING RETURNING id::text`,
      [m.source, m.sourceId, JSON.stringify({ problem: m.problem })],
    );
    const id = rows[0]?.id;
    if (id)
      await publish(tx, {
        type: 'alert.raised',
        entityType: 'alert',
        entityId: id,
        topics: ['alerts'],
      });
  }
  return mismatches;
}

/** Σ of a channel's entries up to a date, for checks and tests. */
export async function channelBalance(
  db: Queryable,
  channel: Channel,
  upTo: string,
): Promise<Decimal> {
  const { rows } = await db.query<{ b: string }>(
    `SELECT COALESCE(sum(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)::text AS b
       FROM cl.ledger_entries WHERE channel = $1 AND business_date <= $2::date`,
    [channel, upTo],
  );
  return new Decimal(rows[0]?.b ?? '0');
}
