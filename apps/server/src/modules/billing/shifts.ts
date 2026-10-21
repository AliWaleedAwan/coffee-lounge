/**
 * The till and its cash shift, as far as taking cash needs them (step 3.7): the shop has
 * one logical till, "Counter" (no drawer, D-03); cash payments belong to its open shift.
 * Paid-in and paid-out, closing with counted cash and the variance follow in step 3.8.
 */
import { money } from '@cl/shared';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import type { CommandContext, StaffAuth } from '../orders/index.ts';
import { whoOf } from './invoices.ts';

export interface Till {
  id: string;
  name: string;
  printerId: string | null;
  version: number;
}

/** The shop's till, with its receipt printer if that printer is switched on. */
export async function counterTill(db: Queryable): Promise<Till | null> {
  const { rows } = await db.query<Till>(
    `SELECT t.id::text, t.name, CASE WHEN p.is_active THEN p.id::text END AS "printerId", t.version
       FROM cl.tills t LEFT JOIN cl.printers p ON p.id = t.receipt_printer_id
      WHERE t.is_active ORDER BY t.id LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** The till's open shift, locked so it cannot close under a cash payment; null if none. */
export async function lockOpenShift(tx: Tx): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT s.id::text FROM cl.cash_shifts s JOIN cl.tills t ON t.id = s.till_id
      WHERE s.status = 'open' AND t.is_active ORDER BY s.id LIMIT 1`,
  );
  const id = rows[0]?.id;
  if (id === undefined) return null;
  const [locked] = await tx.lock<{ status: string }>('cash_shifts', [id]);
  return locked?.status === 'open' ? id : null;
}

export async function currentShift(db: Queryable) {
  const { rows } = await db.query<{
    id: string;
    till: string;
    cashier: string;
    cashier_user_id: string;
    opened_at: Date;
    opening_float: string;
    cash_sales: string;
    payments: number;
  }>(
    `SELECT s.id::text, t.name AS till, u.display_name AS cashier, s.cashier_user_id::text, s.opened_at,
            s.opening_float::text,
            (SELECT coalesce(sum(p.amount), 0)::text FROM cl.payments p WHERE p.cash_shift_id = s.id) AS cash_sales,
            (SELECT count(*)::int FROM cl.payments p WHERE p.cash_shift_id = s.id) AS payments
       FROM cl.cash_shifts s JOIN cl.tills t ON t.id = s.till_id JOIN cl.users u ON u.id = s.cashier_user_id
      WHERE s.status = 'open' ORDER BY s.id LIMIT 1`,
  );
  const s = rows[0];
  if (!s) return { shift: null };
  return {
    shift: {
      id: s.id,
      till: s.till,
      cashier: s.cashier,
      cashierUserId: s.cashier_user_id,
      openedAt: s.opened_at.toISOString(),
      openingFloat: s.opening_float,
      cashSales: s.cash_sales,
      cashPayments: s.payments,
    },
  };
}

export async function openShift(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  input: { openingFloat: string },
): Promise<{ shiftId: string }> {
  const till = await counterTill(tx);
  if (!till) throw new AppError('NOT_FOUND', 'No till is set up');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.cash_shifts (till_id, cashier_user_id, opening_float) VALUES ($1, $2, $3)
     ON CONFLICT (till_id) WHERE status = 'open' DO NOTHING RETURNING id::text`,
    [till.id, auth.user.id, money.format(money.parse(input.openingFloat))],
  );
  const shiftId = rows[0]?.id;
  if (shiftId === undefined) {
    throw new AppError('STALE_STATE', 'A shift is already open on this till');
  }
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'shift.open',
    entityType: 'cash_shift',
    entityId: shiftId,
    after: { till: till.name, openingFloat: input.openingFloat },
  });
  await publish(tx, {
    type: 'shift.changed',
    entityType: 'cash_shift',
    entityId: shiftId,
    topics: ['cashier'],
  });
  return { shiftId };
}
