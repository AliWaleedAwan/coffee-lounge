/**
 * Delivery (ORDER_STATE_MACHINE.md §7, §8.6; D-05, D-41). Orders come by phone, WhatsApp or
 * in person and staff enter them; every customer detail is optional (AT-123). Riders have
 * no login: the cashier records dispatch and return, and every event names both.
 *
 *  D0 pending_dispatch   the session (S3) and its rounds go to the kitchen like any other.
 *  D1 out_for_delivery   everything picked up; prepaid must be settled, COD and card on
 *                        delivery get their bill prepared (locked) here (AT-89); the rider's
 *                        slip prints with the address and what to collect.
 *  D2 delivered          COD / card: the payment goes into the open shift, naming the rider,
 *                        and settles the bill (AT-54, AT-60).
 *  D3 failed             with a reason; a manager decides:
 *  D4 re-attempt · D5 customer will collect at the counter · D6 cancel: the food is waste
 *                        at its cost, no stock credit; prepaid money is marked refund due
 *                        (P3-1, refunds are Phase 5); an unpaid bill is reopened and closed.
 *
 * Lock order (DATABASE.md §14): session → delivery order → rounds → lines → invoices →
 * cash shift → document counters.
 */
import { Decimal, money } from '@cl/shared';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import {
  counterTill,
  lockBill,
  lockInvoice,
  recordPayments,
  reopenBill,
  settle,
  whoOf,
  type PaymentInput,
} from '../billing/index.ts';
import { cancelSession, openStaffSession, type SessionRow } from '../floor/index.ts';
import {
  lockSessionLines,
  markDispatched,
  unpicked,
  writeOffDelivery,
  type CommandContext,
  type StaffAuth,
} from '../orders/index.ts';
import { requestPrint } from '../printing/index.ts';

export const CHANNELS = ['phone', 'whatsapp', 'walk_in'] as const;
export const PAYMENT_MODES = ['prepaid', 'cod_cash', 'card_on_delivery'] as const;
type Status =
  | 'pending_dispatch'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'converted_to_pickup';

interface DeliveryRow {
  id: string;
  session_id: string;
  payment_mode: (typeof PAYMENT_MODES)[number];
  status: Status;
  rider_id: string | null;
  attempt: number;
  dispatched_at: Date | null;
}

/** "0300 1234567" → "•••• •••4567": enough to tell orders apart in a list (AT-123). */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.replace(/\d(?=(?:\D*\d){4})/g, '•');
}

async function lockDelivery(
  tx: Tx,
  deliveryId: string,
): Promise<{ session: SessionRow; delivery: DeliveryRow }> {
  const { rows: found } = await tx.query<{ session_id: string }>(
    'SELECT session_id::text FROM cl.delivery_orders WHERE id = $1',
    [deliveryId],
  );
  const sessionId = found[0]?.session_id;
  if (sessionId === undefined) throw new AppError('NOT_FOUND', 'Delivery not found');
  // A delivery session has no table: the session row is the first lock.
  const { rows: sessions } = await tx.query<SessionRow>(
    `SELECT id::text, session_no, order_type, table_id::text, status, guest_count, opened_at
       FROM cl.dining_sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  const session = sessions[0];
  const [delivery] = await tx.lock<DeliveryRow>('delivery_orders', [deliveryId]);
  if (!session || !delivery) throw new AppError('NOT_FOUND', 'Delivery not found');
  return { session, delivery };
}

async function invoiceOf(tx: Queryable, sessionId: string) {
  const { rows } = await tx.query<{
    id: string;
    status: string;
    total: string;
    paid_total: string;
  }>(
    'SELECT id::text, status, total::text, paid_total::text FROM cl.invoices WHERE session_id = $1',
    [sessionId],
  );
  const invoice = rows[0];
  if (!invoice) throw new Error(`session ${sessionId} has no invoice`);
  return invoice;
}

async function activeRider(tx: Queryable, riderId: string): Promise<string> {
  const { rows } = await tx.query<{ display_name: string }>(
    'SELECT display_name FROM cl.staff_profiles WHERE id = $1 AND is_active',
    [riderId],
  );
  const name = rows[0]?.display_name;
  if (name === undefined) throw new AppError('NOT_FOUND', 'Rider not found');
  return name;
}

async function event(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  e: { delivery: DeliveryRow; to: Status; riderId: string | null; reason?: string | undefined },
): Promise<void> {
  await tx.query(
    `INSERT INTO cl.delivery_events (delivery_order_id, from_status, to_status, actor_user_id, rider_id, reason, event_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.delivery.id,
      e.delivery.status,
      e.to,
      auth.user.id,
      e.riderId,
      e.reason ?? null,
      `${e.to}:${ctx.key}`,
    ],
  );
  await writeAudit(tx, whoOf(auth, ctx), {
    action: `delivery.${e.to}`,
    entityType: 'delivery_order',
    entityId: e.delivery.id,
    before: { status: e.delivery.status },
    after: { status: e.to, riderId: e.riderId },
    ...(e.reason ? { reason: e.reason } : {}),
  });
  await publish(tx, {
    type: 'delivery.changed',
    entityType: 'delivery_order',
    entityId: e.delivery.id,
    topics: ['deliveries', 'cashier', `session:${e.delivery.session_id}`],
  });
}

async function alert(
  tx: Tx,
  kind: 'failed_delivery' | 'refund_due',
  deliveryId: string,
  detail: object,
): Promise<void> {
  await tx.query(
    `INSERT INTO cl.operational_alerts (kind, entity_type, entity_id, detail)
     VALUES ($1, 'delivery_order', $2, $3)
     ON CONFLICT (kind, entity_type, entity_id) WHERE state <> 'resolved' DO NOTHING`,
    [kind, deliveryId, JSON.stringify(detail)],
  );
  await publish(tx, {
    type: 'alert.raised',
    entityType: 'delivery_order',
    entityId: deliveryId,
    topics: ['alerts', 'deliveries'],
  });
}

async function resolveAlert(tx: Tx, kind: string, deliveryId: string, userId: string) {
  await tx.query(
    `UPDATE cl.operational_alerts SET state = 'resolved', resolved_at = now(), resolved_by = $3
      WHERE kind = $1 AND entity_type = 'delivery_order' AND entity_id = $2 AND state <> 'resolved'`,
    [kind, deliveryId, userId],
  );
}

/** The rider's slip: the receipt with the address and what to collect (D1, D4). */
async function printSlip(
  tx: Tx,
  auth: StaffAuth,
  deliveryId: string,
  attempt: number,
  invoiceId: string,
) {
  const till = await counterTill(tx);
  if (!till?.printerId) return false;
  const job = await requestPrint(tx, {
    printerId: till.printerId,
    documentType: 'receipt',
    documentId: invoiceId,
    requestedBy: auth.user.id,
    jobKey: `delivery:${deliveryId}:attempt:${String(attempt)}`,
  });
  return job !== null;
}

// ---------------------------------------------------------------- D0: the order

export interface NewDelivery {
  channel: (typeof CHANNELS)[number];
  paymentMode: (typeof PAYMENT_MODES)[number];
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  customerEmail?: string | undefined;
  address?: string | undefined;
  landmark?: string | undefined;
  notes?: string | undefined;
}

export async function createDelivery(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  input: NewDelivery,
): Promise<{ deliveryId: string; sessionId: string; sessionNo: string }> {
  const session = await openStaffSession(tx, whoOf(auth, ctx), {
    orderType: 'delivery',
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerEmail: input.customerEmail,
  });
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.delivery_orders (session_id, channel, address, landmark, notes, payment_mode, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
    [
      session.id,
      input.channel,
      input.address?.trim() || null,
      input.landmark?.trim() || null,
      input.notes?.trim() || null,
      input.paymentMode,
      auth.user.id,
    ],
  );
  const deliveryId = rows[0]?.id ?? '';
  await publish(tx, {
    type: 'delivery.changed',
    entityType: 'delivery_order',
    entityId: deliveryId,
    topics: ['deliveries', 'cashier'],
  });
  return { deliveryId, sessionId: session.id, sessionNo: session.session_no };
}

// ---------------------------------------------------------------- D1 dispatch

export async function dispatch(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  deliveryId: string,
  input: { riderId: string },
): Promise<{ status: 'out_for_delivery'; slipQueued: boolean }> {
  const { session, delivery } = await lockDelivery(tx, deliveryId);
  if (delivery.status !== 'pending_dispatch') {
    throw new AppError('STALE_STATE', `This delivery is ${delivery.status.replaceAll('_', ' ')}`);
  }
  await activeRider(tx, input.riderId);
  const lines = await lockSessionLines(tx, session.id);
  if (lines.length === 0) throw new AppError('VALIDATION_FAILED', 'Add the items first');
  const waiting = unpicked(lines);
  if (waiting > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${String(waiting)} item${waiting === 1 ? ' is' : 's are'} not picked up yet. Dispatch when everything is ready.`,
      { unpicked: waiting },
    );
  }
  let invoice = await invoiceOf(tx, session.id);
  if (delivery.payment_mode === 'prepaid') {
    if (invoice.status !== 'settled') {
      throw new AppError(
        'VALIDATION_FAILED',
        'This delivery is prepaid: take the payment before it leaves (Bills & payments).',
      );
    }
  } else if (invoice.status === 'open') {
    // COD and card on delivery: the bill is fixed when the food leaves (I2 in this transaction).
    await lockBill(tx, ctx, auth, invoice.id, async (locked) => {
      await settle(tx, ctx, auth, locked);
    });
    invoice = await invoiceOf(tx, session.id);
  }
  await markDispatched(tx, lines);
  const attempt = delivery.attempt + 1;
  await tx.query(
    `UPDATE cl.delivery_orders SET status = 'out_for_delivery', rider_id = $2, dispatched_at = now(), attempt = $3
      WHERE id = $1`,
    [deliveryId, input.riderId, attempt],
  );
  await event(tx, ctx, auth, { delivery, to: 'out_for_delivery', riderId: input.riderId });
  return {
    status: 'out_for_delivery',
    slipQueued: await printSlip(tx, auth, deliveryId, attempt, invoice.id),
  };
}

// ---------------------------------------------------------------- D2 / D3 the rider is back

export type ReturnInput =
  | {
      outcome: 'delivered';
      /** COD / card: how the customer paid; defaults to the delivery's payment mode. */
      method?: 'cash' | 'card_manual' | undefined;
      reference?: string | undefined;
      deliveredAt?: Date | undefined;
    }
  | { outcome: 'failed'; reason: string };

export async function recordReturn(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  deliveryId: string,
  input: ReturnInput,
): Promise<{ status: Status; invoiceNo: string | null; collected: string | null }> {
  const { delivery } = await lockDelivery(tx, deliveryId);
  if (delivery.status !== 'out_for_delivery') {
    throw new AppError('STALE_STATE', `This delivery is ${delivery.status.replaceAll('_', ' ')}`);
  }
  if (input.outcome === 'failed') {
    await tx.query(
      `UPDATE cl.delivery_orders SET status = 'failed', failed_at = now(), failure_reason = $2 WHERE id = $1`,
      [deliveryId, input.reason],
    );
    await alert(tx, 'failed_delivery', deliveryId, {
      reason: input.reason,
      riderId: delivery.rider_id,
    });
    await event(tx, ctx, auth, {
      delivery,
      to: 'failed',
      riderId: delivery.rider_id,
      reason: input.reason,
    });
    return { status: 'failed', invoiceNo: null, collected: null };
  }

  const deliveredAt = input.deliveredAt ?? ctx.now;
  if (
    deliveredAt.getTime() > ctx.now.getTime() + 60_000 ||
    (delivery.dispatched_at && deliveredAt < delivery.dispatched_at)
  ) {
    throw new AppError('VALIDATION_FAILED', 'The delivery time is between dispatch and now');
  }
  let invoiceNo: string | null = null;
  let collected: string | null = null;
  const invoice = await invoiceOf(tx, delivery.session_id);
  if (invoice.status === 'locked') {
    // D2: the rider hands over what they collected, into this shift (AT-54, AT-60).
    const due = new Decimal(invoice.total).minus(invoice.paid_total);
    const method = input.method ?? (delivery.payment_mode === 'cod_cash' ? 'cash' : 'card_manual');
    const payment: PaymentInput = {
      method,
      amount: money.format(due),
      ...(method === 'cash' ? { tendered: money.format(due) } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
      collectedByRiderId: delivery.rider_id ?? undefined,
    };
    const result = await recordPayments(tx, ctx, auth, await lockInvoice(tx, invoice.id), [
      payment,
    ]);
    invoiceNo = result.invoiceNo;
    collected = money.format(due);
  }
  await tx.query(
    `UPDATE cl.delivery_orders SET status = 'delivered', delivered_at = $2 WHERE id = $1`,
    [deliveryId, deliveredAt],
  );
  await event(tx, ctx, auth, { delivery, to: 'delivered', riderId: delivery.rider_id });
  return { status: 'delivered', invoiceNo, collected };
}

// ---------------------------------------------------------------- D4–D6 a manager decides

export type ResolveInput =
  | { action: 'reattempt'; riderId?: string | undefined }
  | { action: 'convert_to_pickup' }
  | { action: 'cancel'; reason: string };

export async function resolveFailed(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  deliveryId: string,
  input: ResolveInput,
): Promise<{ status: Status; refundDue: string | null; wasteValue: string | null }> {
  const { session, delivery } = await lockDelivery(tx, deliveryId);
  if (delivery.status !== 'failed') {
    throw new AppError('STALE_STATE', 'Only a failed delivery waits for this decision');
  }
  const done = async (to: Status, riderId: string | null, reason?: string) => {
    await tx.query('UPDATE cl.delivery_orders SET resolved_by = $2 WHERE id = $1', [
      deliveryId,
      auth.user.id,
    ]);
    await resolveAlert(tx, 'failed_delivery', deliveryId, auth.user.id);
    await event(tx, ctx, auth, { delivery, to, riderId, reason });
  };

  if (input.action === 'reattempt') {
    const riderId = input.riderId ?? delivery.rider_id ?? '';
    await activeRider(tx, riderId);
    const attempt = delivery.attempt + 1;
    await tx.query(
      `UPDATE cl.delivery_orders SET status = 'out_for_delivery', rider_id = $2, dispatched_at = now(),
              attempt = $3, failed_at = NULL, failure_reason = NULL
        WHERE id = $1`,
      [deliveryId, riderId, attempt],
    );
    await done('out_for_delivery', riderId);
    const invoice = await invoiceOf(tx, session.id);
    await printSlip(tx, auth, deliveryId, attempt, invoice.id);
    return { status: 'out_for_delivery', refundDue: null, wasteValue: null };
  }

  if (input.action === 'convert_to_pickup') {
    // The customer collects at the counter; an unpaid bill is paid there like a takeaway.
    await tx.query(`UPDATE cl.delivery_orders SET status = 'converted_to_pickup' WHERE id = $1`, [
      deliveryId,
    ]);
    await done('converted_to_pickup', delivery.rider_id);
    return { status: 'converted_to_pickup', refundDue: null, wasteValue: null };
  }

  // D6: the food is waste; the money is refunded (prepaid) or never taken (COD, card).
  const lines = await lockSessionLines(tx, session.id);
  const waste = await writeOffDelivery(tx, ctx, auth, lines, `Delivery cancelled: ${input.reason}`);
  const invoice = await invoiceOf(tx, session.id);
  let refundDue: string | null = null;
  if (invoice.status === 'settled') {
    refundDue = invoice.paid_total;
  } else {
    if (new Decimal(invoice.paid_total).gt(0)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Part of this bill is paid: settle it at the counter first, then cancel the delivery and refund it.',
      );
    }
    if (invoice.status === 'locked') await reopenBill(tx, ctx, auth, invoice.id, {});
    await cancelSession(
      tx,
      whoOf(auth, ctx),
      { ...session, status: 'open' },
      `Delivery cancelled: ${input.reason}`,
    );
  }
  await tx.query(
    `UPDATE cl.delivery_orders SET status = 'cancelled', refund_due = $2 WHERE id = $1`,
    [deliveryId, refundDue ?? '0'],
  );
  if (refundDue !== null) {
    await alert(tx, 'refund_due', deliveryId, { amount: refundDue, sessionNo: session.session_no });
  }
  await done('cancelled', delivery.rider_id, input.reason);
  return { status: 'cancelled', refundDue, wasteValue: waste.toFixed(4) };
}

// ---------------------------------------------------------------- the board

export async function deliveryBoard(db: Queryable) {
  const { rows } = await db.query<{
    id: string;
    session_id: string;
    session_no: string;
    status: Status;
    channel: string;
    payment_mode: string;
    customer_name: string | null;
    customer_phone: string | null;
    address: string | null;
    landmark: string | null;
    rider_id: string | null;
    rider: string | null;
    attempt: number;
    dispatched_at: Date | null;
    delivered_at: Date | null;
    failure_reason: string | null;
    refund_due: string;
    invoice_status: string;
    invoice_id: string;
    refunded: string;
    total: string;
    paid_total: string;
    items: number;
    unpicked: number;
    created_at: Date;
  }>(
    `SELECT d.id::text, s.id::text AS session_id, s.session_no, d.status, d.channel, d.payment_mode,
            s.customer_name, s.customer_phone, d.address, d.landmark, d.rider_id::text, r.display_name AS rider,
            d.attempt, d.dispatched_at, d.delivered_at, d.failure_reason, d.refund_due::text,
            i.status AS invoice_status, i.id::text AS invoice_id, i.total::text, i.paid_total::text,
            (SELECT coalesce(sum(f.amount), 0)::numeric(14,2)::text FROM cl.refunds f
              WHERE f.invoice_id = i.id AND f.kind = 'refund') AS refunded,
            (SELECT coalesce(sum(l.qty - l.qty_cancelled_unprepared - l.qty_cancelled_prepared), 0)::int
               FROM cl.order_lines l JOIN cl.order_rounds o ON o.id = l.round_id
              WHERE l.session_id = s.id AND o.status = 'accepted') AS items,
            (SELECT coalesce(sum(l.qty - l.qty_picked_up - l.qty_cancelled_unprepared), 0)::int
               FROM cl.order_lines l JOIN cl.order_rounds o ON o.id = l.round_id
              WHERE l.session_id = s.id AND o.status = 'accepted') AS unpicked,
            d.created_at
       FROM cl.delivery_orders d JOIN cl.dining_sessions s ON s.id = d.session_id
       JOIN cl.invoices i ON i.session_id = s.id
       LEFT JOIN cl.staff_profiles r ON r.id = d.rider_id
      WHERE d.status IN ('pending_dispatch','out_for_delivery','failed')
         OR d.updated_at > now() - interval '12 hours'
      ORDER BY d.created_at, d.id`,
  );
  const items = rows.map((d) => {
    const due = Decimal.max(0, new Decimal(d.total).minus(d.paid_total));
    return {
      id: d.id,
      sessionId: d.session_id,
      sessionNo: d.session_no,
      status: d.status,
      channel: d.channel,
      paymentMode: d.payment_mode,
      customerName: d.customer_name,
      phone: maskPhone(d.customer_phone),
      address: d.address,
      landmark: d.landmark,
      riderId: d.rider_id,
      rider: d.rider,
      attempt: d.attempt,
      dispatchedAt: d.dispatched_at?.toISOString() ?? null,
      deliveredAt: d.delivered_at?.toISOString() ?? null,
      failureReason: d.failure_reason,
      refundDue: d.refund_due,
      refunded: d.refunded,
      invoiceId: d.invoice_id,
      invoiceStatus: d.invoice_status,
      // An open bill is worked out when the food leaves; until then the board shows items.
      total: d.invoice_status === 'open' ? null : d.total,
      due: d.invoice_status === 'open' ? null : money.format(due),
      items: d.items,
      unpicked: d.unpicked,
    };
  });
  // What riders are carrying: unpaid COD and card on delivery now out (FINANCE_REPORTING §5).
  const outstanding = new Map<
    string,
    { riderId: string; rider: string; amount: Decimal; deliveries: number }
  >();
  for (const d of items) {
    if (d.status !== 'out_for_delivery' || d.riderId === null || d.due === null || d.due === '0.00')
      continue;
    const o = outstanding.get(d.riderId) ?? {
      riderId: d.riderId,
      rider: d.rider ?? '',
      amount: new Decimal(0),
      deliveries: 0,
    };
    o.amount = o.amount.plus(d.due);
    o.deliveries += 1;
    outstanding.set(d.riderId, o);
  }
  return {
    items,
    outstanding: [...outstanding.values()].map((o) => ({
      riderId: o.riderId,
      rider: o.rider,
      amount: money.format(o.amount),
      deliveries: o.deliveries,
    })),
  };
}

/** One delivery with the customer's details in full (for dispatch and calling them). */
export async function readDelivery(db: Queryable, deliveryId: string) {
  const { rows } = await db.query<{
    id: string;
    session_id: string;
    customer_name: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    address: string | null;
    landmark: string | null;
    notes: string | null;
    channel: string;
    payment_mode: string;
    status: string;
  }>(
    `SELECT d.id::text, s.id::text AS session_id, s.customer_name, s.customer_phone, s.customer_email,
            d.address, d.landmark, d.notes, d.channel, d.payment_mode, d.status
       FROM cl.delivery_orders d JOIN cl.dining_sessions s ON s.id = d.session_id WHERE d.id = $1`,
    [deliveryId],
  );
  const d = rows[0];
  if (!d) throw new AppError('NOT_FOUND', 'Delivery not found');
  return {
    id: d.id,
    sessionId: d.session_id,
    customerName: d.customer_name,
    customerPhone: d.customer_phone,
    customerEmail: d.customer_email,
    address: d.address,
    landmark: d.landmark,
    notes: d.notes,
    channel: d.channel,
    paymentMode: d.payment_mode,
    status: d.status,
  };
}
