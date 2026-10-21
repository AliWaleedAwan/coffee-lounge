/**
 * What happens to accepted units (ORDER_STATE_MACHINE.md §3, §8.3). Four counters per
 * line only move forward:
 *
 *  L1 Picked up = prepared = consumption (D-33); dine-in also counts as served.
 *  L2 Served / collected.
 *  L3 Cancelled, not made yet: the reservation is released.
 *  L4 Cancelled, already made: consumed (L1) and written off as waste (L5) at once.
 *  L5 Void of picked-up units (spilled, remade, refused): waste at the line's own cost,
 *     with no stock credit.
 *
 * Every change locks session → round → lines → balances → reservations
 * (DATABASE.md §14), so a pickup and a cancel of the same units cannot both win (CT-05).
 * Comps are discounts on the bill and join with billing (step 3.7).
 */
import { Decimal, qty as qtyKind } from '@cl/shared';
import { z } from 'zod';
import { writeAudit, type Actor } from '../../platform/audit.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { businessDateOf, readSetting } from '../../platform/settings.ts';
import type { SessionRow } from '../floor/index.ts';
import { consumeStepUp, type AuthContext } from '../identity/index.ts';
import { consume, release, WASTE_REASONS, type LineTakes } from '../stock/index.ts';
import type { CommandContext } from './rounds.ts';
import { correctionTicket, kitchenChanged, settleTickets } from './tickets.ts';

export type StaffAuth = Pick<AuthContext, 'user' | 'device' | 'permissions'>;

interface LineRow {
  id: string;
  round_id: string;
  session_id: string;
  qty: number;
  qty_picked_up: number;
  qty_served: number;
  qty_cancelled_unprepared: number;
  qty_cancelled_prepared: number;
  stock_mode_snap: string | null;
}

interface Locked {
  session: SessionRow;
  lines: LineRow[];
}

const open = (l: LineRow) => l.qty - l.qty_picked_up - l.qty_cancelled_unprepared;

/** Locks the visit's table and session, the round, then the lines (all of one round). */
async function lockLines(tx: Tx, lineIds: readonly string[]): Promise<Locked> {
  const { rows: where } = await tx.query<{
    round_id: string;
    session_id: string;
    table_id: string | null;
    status: string;
  }>(
    `SELECT DISTINCT l.round_id::text, l.session_id::text, s.table_id::text, r.status
       FROM cl.order_lines l JOIN cl.dining_sessions s ON s.id = l.session_id JOIN cl.order_rounds r ON r.id = l.round_id
      WHERE l.id = ANY($1::bigint[])`,
    [lineIds],
  );
  const first = where[0];
  if (!first || where.length !== 1) {
    if (where.length > 1) throw new Error('lines of one change must belong to one round');
    throw new AppError('NOT_FOUND', 'Item not found');
  }
  if (first.status !== 'accepted')
    throw new AppError('STALE_STATE', 'This order has not been accepted', { status: first.status });
  if (first.table_id) await tx.lock('dining_tables', [first.table_id]);
  const { rows: sessions } = await tx.query<SessionRow>(
    `SELECT id::text, session_no, order_type, table_id::text, status, guest_count, opened_at
       FROM cl.dining_sessions WHERE id = $1 FOR UPDATE`,
    [first.session_id],
  );
  const session = sessions[0];
  if (!session) throw new AppError('NOT_FOUND', 'Item not found');
  await tx.lock('order_rounds', [first.round_id]);
  const lines = await tx.lock<LineRow>('order_lines', lineIds);
  return { session, lines };
}

/** Ingredient takes for n units: qty_per_unit × n, or the exact rest for the line's last units. */
async function takesFor(tx: Tx, line: LineRow, n: number): Promise<LineTakes> {
  if (line.stock_mode_snap !== 'recipe') return { orderLineId: line.id, takes: [] };
  const { rows } = await tx.query<{ item_id: string; qty_per_unit: string }>(
    'SELECT inventory_item_id::text AS item_id, qty_per_unit::text FROM cl.order_line_components WHERE line_id = $1',
    [line.id],
  );
  const last = line.qty_picked_up + line.qty_cancelled_unprepared + n === line.qty;
  return {
    orderLineId: line.id,
    takes: rows.map((c) => ({
      itemId: c.item_id,
      qty: last ? ('rest' as const) : qtyKind.round(new Decimal(c.qty_per_unit).times(n)),
    })),
  };
}

async function lineEvent(
  tx: Tx,
  ctx: CommandContext,
  e: { line: LineRow; type: string; qty: number; actor: Actor; reason?: string; data?: unknown },
): Promise<void> {
  await tx.query(
    `INSERT INTO cl.order_events (round_id, line_id, event_type, qty, actor_kind, actor_user_id, reason, data, event_key, correlation_id)
     VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9)`,
    [
      e.line.round_id,
      e.line.id,
      e.type,
      e.qty,
      e.actor.kind === 'user' ? e.actor.userId : null,
      e.reason ?? null,
      e.data === undefined ? null : JSON.stringify(e.data),
      `${e.type}:${ctx.key}:line:${e.line.id}`,
      ctx.correlationId,
    ],
  );
}

async function resolveUncollected(
  tx: Tx,
  lines: readonly LineRow[],
  userId: string,
): Promise<void> {
  const done = lines.filter((l) => open(l) === 0).map((l) => l.id);
  if (done.length === 0) return;
  await tx.query(
    `UPDATE cl.operational_alerts SET state = 'resolved', resolved_at = now(), resolved_by = $2
      WHERE kind = 'uncollected_item' AND entity_type = 'order_line' AND entity_id = ANY($1::bigint[]) AND state <> 'resolved'`,
    [done, userId],
  );
}

const actorOf = (auth: StaffAuth): Actor => ({
  kind: 'user',
  userId: auth.user.id,
  deviceId: auth.device.id,
});

/** Bill-changing actions stop once the bill is being prepared or the visit has ended. */
function billable(session: SessionRow): void {
  if (session.status === 'checkout_locked') {
    throw new AppError(
      'SESSION_LOCKED_FOR_CHECKOUT',
      'The bill is being prepared. Reopen it first.',
    );
  }
  if (session.status === 'settled' || session.status === 'cancelled') {
    throw new AppError('STALE_STATE', 'This visit is closed; changes now go through a refund.', {
      status: session.status,
    });
  }
}

/** RBAC.md §1.3 own_tables: a waiter may cancel only at tables assigned to them now. */
async function requireOwnTable(
  tx: Tx,
  auth: StaffAuth,
  permission: string,
  session: SessionRow,
): Promise<void> {
  const grant = auth.permissions.get(permission);
  if (!grant) throw new AppError('FORBIDDEN', 'You do not have permission for this');
  if (grant.scopes === 'all') return;
  if (session.table_id !== null && grant.scopes.some((s) => s['tables'] === 'own')) {
    const { rows } = await tx.query(
      'SELECT 1 FROM cl.table_assignments WHERE table_id = $1 AND user_id = $2 AND ended_at IS NULL',
      [session.table_id, auth.user.id],
    );
    if (rows.length > 0) return;
  }
  throw new AppError('FORBIDDEN', 'This table is not assigned to you');
}

/** Voiding made items needs orders.void_prepared, or a manager's approval on this device. */
async function approvedVoid(
  tx: Tx,
  auth: StaffAuth,
  lineId: string,
  stepUpId: string | undefined,
): Promise<string | null> {
  if (auth.permissions.has('orders.void_prepared')) return null;
  if (!stepUpId) {
    throw new AppError(
      'STEP_UP_REQUIRED',
      'A manager must approve writing off items that were already made',
      {
        action: 'line.void_prepared',
        entityType: 'order_line',
        entityId: lineId,
      },
    );
  }
  return consumeStepUp(tx, auth, {
    stepUpId,
    action: 'line.void_prepared',
    entityType: 'order_line',
    entityId: lineId,
  });
}

// ---------------------------------------------------------------- L1 pickup

export interface PickupResult {
  lines: { orderLineId: string; pickedUp: number; open: number }[];
  costValue: string;
}

/** L1 for one line (`qty`) or a whole ticket (every open unit). */
export async function pickUp(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  wanted: readonly { lineId: string; qty: number | 'rest' }[],
): Promise<PickupResult> {
  const { session, lines } = await lockLines(
    tx,
    wanted.map((w) => w.lineId),
  );
  const servedToo =
    session.order_type === 'dine_in' &&
    (await readSetting(tx, 'orders.pickup_marks_served_dine_in', z.boolean()));
  const plan: { line: LineRow; n: number }[] = [];
  for (const w of wanted) {
    const line = lines.find((l) => l.id === w.lineId);
    if (!line) continue;
    const n = w.qty === 'rest' ? open(line) : w.qty;
    if (n === 0 && w.qty === 'rest') continue;
    if (n < 1 || n > open(line)) {
      throw new AppError('QTY_EXCEEDS_REMAINING', `Only ${String(open(line))} left to pick up`, {
        lineId: line.id,
        open: open(line),
      });
    }
    plan.push({ line, n });
  }
  if (plan.length === 0) throw new AppError('QTY_EXCEEDS_REMAINING', 'Nothing is left to pick up');
  const takes: LineTakes[] = [];
  for (const p of plan) takes.push(await takesFor(tx, p.line, p.n)); // one connection: one query at a time
  const stockCtx = { actorUserId: auth.user.id, businessDate: await businessDateOf(tx, ctx.now) };
  const { value } = await consume(tx, stockCtx, { eventKey: `pickup:${ctx.key}`, lines: takes });
  const actor = actorOf(auth);
  for (const { line, n } of plan) {
    await tx.query(
      'UPDATE cl.order_lines SET qty_picked_up = qty_picked_up + $2, qty_served = qty_served + $3 WHERE id = $1',
      [line.id, n, servedToo ? n : 0],
    );
    line.qty_picked_up += n;
    await lineEvent(tx, ctx, { line, type: 'picked_up', qty: n, actor });
  }
  await settleTickets(tx, [...new Set(plan.map((p) => p.line.round_id))]);
  await resolveUncollected(
    tx,
    plan.map((p) => p.line),
    auth.user.id,
  );
  await kitchenChanged(tx, session, plan[0]?.line.id ?? '');
  return {
    lines: plan.map(({ line }) => ({
      orderLineId: line.id,
      pickedUp: line.qty_picked_up,
      open: open(line),
    })),
    costValue: value.toFixed(4),
  };
}

// ---------------------------------------------------------------- L2 served

export async function serve(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  lineId: string,
  n: number,
) {
  const { session, lines } = await lockLines(tx, [lineId]);
  const line = lines[0];
  if (!line) throw new AppError('NOT_FOUND', 'Item not found');
  if (n < 1 || line.qty_served + n > line.qty_picked_up) {
    throw new AppError(
      'QTY_EXCEEDS_REMAINING',
      `Only ${String(line.qty_picked_up - line.qty_served)} picked up and not yet served`,
    );
  }
  await tx.query('UPDATE cl.order_lines SET qty_served = qty_served + $2 WHERE id = $1', [
    lineId,
    n,
  ]);
  await lineEvent(tx, ctx, { line, type: 'served', qty: n, actor: actorOf(auth) });
  await kitchenChanged(tx, session, lineId);
  return { orderLineId: lineId, served: line.qty_served + n };
}

// ---------------------------------------------------------------- L3 / L4 cancel

/**
 * Cancel accepted units that were not picked up. "Not made yet" (L3) releases their
 * stock; "already made" (L4) consumes it and writes the units off as waste. Either way
 * the kitchen gets a correction (or void) ticket.
 */
export async function cancelUnits(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  input: {
    lineId: string;
    qty: number;
    made: boolean;
    reason: string;
    stepUpId?: string | undefined;
  },
) {
  const { session, lines } = await lockLines(tx, [input.lineId]);
  const line = lines[0];
  if (!line) throw new AppError('NOT_FOUND', 'Item not found');
  await requireOwnTable(tx, auth, 'orders.void', session);
  billable(session);
  if (input.qty < 1 || input.qty > open(line)) {
    throw new AppError('QTY_EXCEEDS_REMAINING', `Only ${String(open(line))} not yet picked up`, {
      open: open(line),
    });
  }
  const actor = actorOf(auth);
  const take = await takesFor(tx, line, input.qty);
  let wasteValue: Decimal | null = null;
  let approvedBy: string | null = null;
  if (input.made) {
    approvedBy = await approvedVoid(tx, auth, line.id, input.stepUpId);
    const businessDate = await businessDateOf(tx, ctx.now);
    const { byLine } = await consume(
      tx,
      { actorUserId: auth.user.id, businessDate },
      { eventKey: `cancel_made:${ctx.key}`, lines: [take] },
    );
    wasteValue = byLine.get(line.id) ?? new Decimal(0);
    await tx.query(
      `UPDATE cl.order_lines SET qty_picked_up = qty_picked_up + $2, qty_cancelled_prepared = qty_cancelled_prepared + $2 WHERE id = $1`,
      [line.id, input.qty],
    );
    await tx.query(
      `INSERT INTO cl.wastage_records (kind, order_line_id, qty, reason_code, cost_value, recorded_by, business_date, note)
       VALUES ('prepared_item', $1, $2, 'other', $3, $4, $5, $6)`,
      [line.id, input.qty, wasteValue.toFixed(4), auth.user.id, businessDate, input.reason],
    );
    line.qty_picked_up += input.qty;
    line.qty_cancelled_prepared += input.qty;
  } else {
    await release(tx, take);
    await tx.query(
      'UPDATE cl.order_lines SET qty_cancelled_unprepared = qty_cancelled_unprepared + $2 WHERE id = $1',
      [line.id, input.qty],
    );
    line.qty_cancelled_unprepared += input.qty;
  }
  await lineEvent(tx, ctx, {
    line,
    type: input.made ? 'cancelled_made' : 'cancelled_unmade',
    qty: input.qty,
    actor,
    reason: input.reason,
    ...(wasteValue ? { data: { wasteValue: wasteValue.toFixed(4) } } : {}),
  });
  const ticketId = await correctionTicket(tx, line.id, input.qty, ctx.now);
  await settleTickets(tx, [line.round_id]);
  await resolveUncollected(tx, [line], auth.user.id);
  await writeAudit(
    tx,
    { actor, correlationId: ctx.correlationId },
    {
      action: input.made ? 'line.cancel_made' : 'line.cancel',
      entityType: 'order_line',
      entityId: line.id,
      after: { qty: input.qty, ...(wasteValue ? { wasteValue: wasteValue.toFixed(4) } : {}) },
      reason: input.reason,
      ...(approvedBy ? { approvedBy } : {}),
    },
  );
  await kitchenChanged(tx, session, line.id);
  return {
    orderLineId: line.id,
    open: open(line),
    correctionTicketId: ticketId,
    wasteValue: wasteValue?.toFixed(4) ?? null,
  };
}

// ---------------------------------------------------------------- L5 void

/** Void picked-up units: waste at the line's own consumption cost, no stock back (AT-07). */
export async function voidUnits(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  input: {
    lineId: string;
    qty: number;
    reasonCode: (typeof WASTE_REASONS)[number];
    note?: string | undefined;
    stepUpId?: string | undefined;
  },
) {
  const { session, lines } = await lockLines(tx, [input.lineId]);
  const line = lines[0];
  if (!line) throw new AppError('NOT_FOUND', 'Item not found');
  await requireOwnTable(tx, auth, 'orders.void', session);
  billable(session);
  if (input.qty < 1 || line.qty_cancelled_prepared + input.qty > line.qty_picked_up) {
    throw new AppError(
      'QTY_EXCEEDS_REMAINING',
      `Only ${String(line.qty_picked_up - line.qty_cancelled_prepared)} picked up and not voided`,
    );
  }
  if (input.reasonCode === 'other' && !input.note?.trim()) {
    throw new AppError('VALIDATION_FAILED', 'Say what happened when the reason is "other"');
  }
  const approvedBy = await approvedVoid(tx, auth, line.id, input.stepUpId);
  const { rows } = await tx.query<{ value: string }>(
    'SELECT COALESCE(sum(value), 0)::text AS value FROM cl.order_line_costs WHERE order_line_id = $1',
    [line.id],
  );
  // COST_VALUATION.md §7: the line's cost per picked-up unit × the voided units.
  const perUnit = new Decimal(rows[0]?.value ?? 0).dividedBy(line.qty_picked_up);
  const cost = qtyKind.round(perUnit.times(input.qty));
  const businessDate = await businessDateOf(tx, ctx.now);
  await tx.query(
    'UPDATE cl.order_lines SET qty_cancelled_prepared = qty_cancelled_prepared + $2 WHERE id = $1',
    [line.id, input.qty],
  );
  await tx.query(
    `INSERT INTO cl.wastage_records (kind, order_line_id, qty, reason_code, cost_value, recorded_by, business_date, note)
     VALUES ('prepared_item', $1, $2, $3, $4, $5, $6, $7)`,
    [
      line.id,
      input.qty,
      input.reasonCode,
      cost.toFixed(4),
      auth.user.id,
      businessDate,
      input.note ?? null,
    ],
  );
  const actor = actorOf(auth);
  await lineEvent(tx, ctx, {
    line,
    type: 'voided',
    qty: input.qty,
    actor,
    reason: input.reasonCode,
    data: { cost: cost.toFixed(4) },
  });
  await writeAudit(
    tx,
    { actor, correlationId: ctx.correlationId },
    {
      action: 'line.void',
      entityType: 'order_line',
      entityId: line.id,
      after: { qty: input.qty, cost: cost.toFixed(4), reasonCode: input.reasonCode },
      ...(input.note ? { reason: input.note } : {}),
      ...(approvedBy ? { approvedBy } : {}),
    },
  );
  await kitchenChanged(tx, session, line.id);
  return {
    orderLineId: line.id,
    voided: line.qty_cancelled_prepared + input.qty,
    wasteValue: cost.toFixed(4),
  };
}
