/**
 * The bill of a session (ORDER_STATE_MACHINE.md §6, API.md §5.5).
 *
 *  I1 open: the live bill is worked out on every read from the accepted lines.
 *  I2 lock ("Prepare bill"): refused while a round waits for approval (AT-10, CT-04: the
 *     session row lock orders it against a submission); the lines are snapshotted into
 *     invoice_lines with discounts and Rs 1 rounding; lock_version goes up; the session
 *     becomes checkout_locked, so no new rounds and no cancels change it underneath.
 *  I3 reopen: free while nothing is paid; with payments a manager approves (AT-91).
 *  Discounts (D-14): % or fixed, on a line or the bill, with a reason, within the role's
 *     limit or with a step-up from someone whose limit covers it (AT-93). Comps are
 *     100 % line discounts (D-21). A locked bill is worked out again, with a new
 *     lock_version, so a payment against the old figures gets BILL_CHANGED (AT-34).
 *
 * Lock order (DATABASE.md §14): table → session → rounds → invoices → cash_shifts →
 * document_counters.
 */
import { Decimal, money } from '@cl/shared';
import { z } from 'zod';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { readSetting } from '../../platform/settings.ts';
import { lockActiveSession, setCheckoutLocked, type SessionRow } from '../floor/index.ts';
import { consumeStepUp } from '../identity/index.ts';
import { requireOwnTable, type CommandContext, type StaffAuth } from '../orders/index.ts';
import {
  computeBill,
  discountPercentOf,
  type BillLineInput,
  type ComputedBill,
  type DiscountInput,
  type DiscountKind,
} from './compute.ts';

export interface InvoiceRow {
  id: string;
  session_id: string;
  invoice_no: string | null;
  status: 'open' | 'locked' | 'settled';
  lock_version: number;
  subtotal: string;
  discount_total: string;
  rounding_adjustment: string;
  total: string;
  paid_total: string;
  business_date: string | null;
}

export const whoOf = (auth: StaffAuth, ctx: CommandContext) => ({
  actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
  correlationId: ctx.correlationId,
  ...(ctx.ip ? { ip: ctx.ip } : {}),
});

export async function invoiceChanged(tx: Tx, invoice: InvoiceRow, session: SessionRow) {
  await publish(tx, {
    type: 'invoice.changed',
    entityType: 'invoice',
    entityId: invoice.id,
    topics: [
      'cashier',
      'floor',
      `session:${session.id}`,
      ...(session.table_id ? [`table:${session.table_id}`] : []),
    ],
  });
}

// ---------------------------------------------------------------- loading

async function billInputs(db: Queryable, sessionId: string): Promise<BillLineInput[]> {
  const { rows } = await db.query<{
    id: string;
    item: string;
    variant: string;
    qty: number;
    cancelled: number;
    unit_price: string;
    modifiers_unit_total: string;
    promotion_discount: string;
  }>(
    `SELECT l.id::text, l.item_name_snap AS item, l.variant_name_snap AS variant, l.qty,
            l.qty_cancelled_unprepared + l.qty_cancelled_prepared AS cancelled,
            l.unit_price::text, l.modifiers_unit_total::text, l.promotion_discount::text
       FROM cl.order_lines l JOIN cl.order_rounds r ON r.id = l.round_id
      WHERE l.session_id = $1 AND r.status = 'accepted' AND l.unit_price IS NOT NULL
      ORDER BY r.round_no, l.line_no`,
    [sessionId],
  );
  return rows.map((l) => ({
    orderLineId: l.id,
    description: describe(l.item, l.variant),
    qty: l.qty,
    billableQty: l.qty - l.cancelled,
    unitPrice: l.unit_price,
    modifiersUnitTotal: l.modifiers_unit_total,
    promotionDiscount: l.promotion_discount,
  }));
}

/** "Cappuccino Regular"; an item with one unnamed variant is just its name. */
export function describe(item: string, variant: string): string {
  return variant && variant !== item ? `${item} ${variant}` : item;
}

interface DiscountRow {
  id: string;
  order_line_id: string | null;
  kind: DiscountKind;
  value: string;
  amount: string;
  reason: string;
  applied_by: string;
  applied_by_name: string;
  approved_by_name: string | null;
  created_at: Date;
}

async function activeDiscounts(db: Queryable, invoiceId: string): Promise<DiscountRow[]> {
  const { rows } = await db.query<DiscountRow>(
    `SELECT d.id::text, d.order_line_id::text, d.kind, d.value::text, d.amount::text, d.reason,
            d.applied_by::text, u.display_name AS applied_by_name, a.display_name AS approved_by_name, d.created_at
       FROM cl.discount_applications d
       JOIN cl.users u ON u.id = d.applied_by
       LEFT JOIN cl.step_up_approvals s ON s.id = d.step_up_id
       LEFT JOIN cl.users a ON a.id = s.approved_by
      WHERE d.invoice_id = $1 AND d.voided_at IS NULL ORDER BY d.id`,
    [invoiceId],
  );
  return rows;
}

const asInput = (d: DiscountRow): DiscountInput => ({
  id: d.id,
  orderLineId: d.order_line_id,
  kind: d.kind,
  value: d.value,
});

async function roundingUnit(db: Queryable): Promise<Decimal> {
  return money.parse(
    await readSetting(db, 'billing.cash_rounding_unit', z.string().regex(/^\d+\.\d{2}$/)),
  );
}

async function liveBill(
  db: Queryable,
  invoiceId: string,
  sessionId: string,
  extra?: DiscountInput,
) {
  const inputs = await billInputs(db, sessionId);
  const discounts = (await activeDiscounts(db, invoiceId)).map(asInput);
  return computeBill(inputs, extra ? [...discounts, extra] : discounts, await roundingUnit(db));
}

// ---------------------------------------------------------------- reading (I1)

export async function readBill(db: Queryable, sessionId: string) {
  const { rows } = await db.query<
    InvoiceRow & {
      session_no: string;
      session_status: string;
      order_type: string;
      table_name: string | null;
      table_id: string | null;
      settled_at: Date | null;
    }
  >(
    `SELECT i.id::text, i.session_id::text, i.invoice_no, i.status, i.lock_version, i.subtotal::text,
            i.discount_total::text, i.rounding_adjustment::text, i.total::text, i.paid_total::text,
            i.business_date, i.settled_at,
            s.session_no, s.status AS session_status, s.order_type, s.table_id::text, t.name AS table_name
       FROM cl.invoices i JOIN cl.dining_sessions s ON s.id = i.session_id
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
      WHERE i.session_id = $1`,
    [sessionId],
  );
  const inv = rows[0];
  if (!inv) throw new AppError('NOT_FOUND', 'Bill not found');
  const discounts = await activeDiscounts(db, inv.id);

  let bill: ComputedBill;
  if (inv.status === 'open') {
    bill = await liveBill(db, inv.id, sessionId);
  } else {
    const { rows: lines } = await db.query<{
      order_line_id: string;
      description_snap: string;
      billable_qty: number;
      unit_price: string;
      modifiers_unit_total: string;
      gross: string;
      promotion_discount: string;
      manual_discount: string;
      discount_alloc: string;
      net: string;
      is_comp: boolean;
    }>(
      `SELECT order_line_id::text, description_snap, billable_qty, unit_price::text, modifiers_unit_total::text,
              gross::text, promotion_discount::text, manual_discount::text, discount_alloc::text, net::text, is_comp
         FROM cl.invoice_lines WHERE invoice_id = $1 ORDER BY invoice_lines.id`,
      [inv.id],
    );
    bill = {
      lines: lines.map((l) => ({
        orderLineId: l.order_line_id,
        description: l.description_snap,
        billableQty: l.billable_qty,
        unitPrice: l.unit_price,
        modifiersUnitTotal: l.modifiers_unit_total,
        gross: l.gross,
        promotionDiscount: l.promotion_discount,
        manualDiscount: l.manual_discount,
        discountAlloc: l.discount_alloc,
        net: l.net,
        isComp: l.is_comp,
      })),
      discounts: discounts.map((d) => ({ id: d.id, amount: d.amount })),
      subtotal: inv.subtotal,
      discountTotal: inv.discount_total,
      roundingAdjustment: inv.rounding_adjustment,
      total: inv.total,
    };
  }
  const amountOf = new Map(bill.discounts.map((d) => [d.id, d.amount]));

  const { rows: mods } = await db.query<{ line_id: string; name: string; qty: number }>(
    `SELECT m.line_id::text, m.name_snap AS name, m.qty FROM cl.order_line_modifiers m
       JOIN cl.order_lines l ON l.id = m.line_id WHERE l.session_id = $1 ORDER BY m.id`,
    [sessionId],
  );
  const { rows: payments } = await db.query<{
    id: string;
    method: string;
    transfer_provider: string | null;
    amount: string;
    tendered: string | null;
    change_due: string | null;
    reference: string | null;
    received_by: string;
    created_at: Date;
  }>(
    `SELECT p.id::text, p.method, p.transfer_provider, p.amount::text, p.tendered::text, p.change_due::text,
            p.reference, u.display_name AS received_by, p.created_at
       FROM cl.payments p JOIN cl.users u ON u.id = p.received_by
      WHERE p.invoice_id = $1 ORDER BY p.id`,
    [inv.id],
  );
  const { rows: waiting } = await db.query<{ pending: number; unpicked: number }>(
    `SELECT (SELECT count(*)::int FROM cl.order_rounds WHERE session_id = $1 AND status = 'pending_approval') AS pending,
            (SELECT coalesce(sum(l.qty - l.qty_picked_up - l.qty_cancelled_unprepared), 0)::int
               FROM cl.order_lines l JOIN cl.order_rounds r ON r.id = l.round_id
              WHERE l.session_id = $1 AND r.status = 'accepted') AS unpicked`,
    [sessionId],
  );
  const paid = new Decimal(inv.paid_total);
  return {
    invoice: {
      id: inv.id,
      status: inv.status,
      lockVersion: inv.lock_version,
      invoiceNo: inv.invoice_no,
      businessDate: inv.business_date,
      settledAt: inv.settled_at?.toISOString() ?? null,
      subtotal: bill.subtotal,
      discountTotal: bill.discountTotal,
      taxTotal: '0.00',
      roundingAdjustment: bill.roundingAdjustment,
      total: bill.total,
      paidTotal: inv.paid_total,
      due: money.format(Decimal.max(0, new Decimal(bill.total).minus(paid))),
    },
    session: {
      id: sessionId,
      sessionNo: inv.session_no,
      status: inv.session_status,
      orderType: inv.order_type,
      tableId: inv.table_id,
      tableName: inv.table_name,
    },
    lines: bill.lines.map((l) => ({
      ...l,
      modifiers: mods
        .filter((m) => m.line_id === l.orderLineId)
        .map((m) => (m.qty > 1 ? `${m.name} ×${String(m.qty)}` : m.name)),
    })),
    discounts: discounts.map((d) => ({
      id: d.id,
      orderLineId: d.order_line_id,
      kind: d.kind,
      value: d.value,
      amount: amountOf.get(d.id) ?? d.amount,
      reason: d.reason,
      appliedBy: d.applied_by_name,
      approvedBy: d.approved_by_name,
      at: d.created_at.toISOString(),
    })),
    payments: payments.map((p) => ({
      id: p.id,
      method: p.method,
      provider: p.transfer_provider,
      amount: p.amount,
      tendered: p.tendered,
      change: p.change_due,
      reference: p.reference,
      receivedBy: p.received_by,
      at: p.created_at.toISOString(),
    })),
    pendingRounds: waiting[0]?.pending ?? 0,
    unpickedUnits: waiting[0]?.unpicked ?? 0,
  };
}

export type BillView = Awaited<ReturnType<typeof readBill>>;

// ---------------------------------------------------------------- locking helpers

/** The session (and its table) then the invoice, locked in the global order. */
export async function lockInvoice(
  tx: Tx,
  invoiceId: string,
): Promise<{ session: SessionRow; invoice: InvoiceRow }> {
  const { rows } = await tx.query<{
    session_id: string;
    status: string;
    invoice_no: string | null;
  }>('SELECT session_id::text, status, invoice_no FROM cl.invoices WHERE id = $1', [invoiceId]);
  const found = rows[0];
  if (!found) throw new AppError('NOT_FOUND', 'Bill not found');
  if (found.status === 'settled') {
    throw new AppError('STALE_STATE', `This bill is already settled (${found.invoice_no ?? ''})`, {
      status: 'settled',
      invoiceNo: found.invoice_no,
    });
  }
  const session = await lockActiveSession(tx, found.session_id);
  const [invoice] = await tx.lock<InvoiceRow>('invoices', [invoiceId]);
  if (!invoice) throw new AppError('NOT_FOUND', 'Bill not found');
  return { session, invoice };
}

/** Writes a worked-out bill as the locked snapshot (I2), with a new lock_version. */
async function writeSnapshot(
  tx: Tx,
  auth: StaffAuth,
  invoice: InvoiceRow,
  bill: ComputedBill,
): Promise<number> {
  if (new Decimal(bill.total).lt(invoice.paid_total)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Rs ${invoice.paid_total} is already paid, more than the new total of Rs ${bill.total}. Refunds arrive in a later phase.`,
    );
  }
  await tx.query('DELETE FROM cl.invoice_lines WHERE invoice_id = $1', [invoice.id]);
  for (const l of bill.lines) {
    await tx.query(
      `INSERT INTO cl.invoice_lines (invoice_id, order_line_id, description_snap, billable_qty, unit_price,
         modifiers_unit_total, gross, promotion_discount, manual_discount, discount_alloc, net, is_comp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        invoice.id,
        l.orderLineId,
        l.description,
        l.billableQty,
        l.unitPrice,
        l.modifiersUnitTotal,
        l.gross,
        l.promotionDiscount,
        l.manualDiscount,
        l.discountAlloc,
        l.net,
        l.isComp,
      ],
    );
  }
  for (const d of bill.discounts) {
    await tx.query(
      'UPDATE cl.discount_applications SET amount = $2 WHERE id = $1 AND amount <> $2',
      [d.id, d.amount],
    );
  }
  const { rows } = await tx.query<{ lock_version: number }>(
    `UPDATE cl.invoices SET status = 'locked', lock_version = lock_version + 1, subtotal = $2,
            discount_total = $3, rounding_adjustment = $4, total = $5, locked_at = now(), locked_by = $6
      WHERE id = $1 RETURNING lock_version`,
    [
      invoice.id,
      bill.subtotal,
      bill.discountTotal,
      bill.roundingAdjustment,
      bill.total,
      auth.user.id,
    ],
  );
  return rows[0]?.lock_version ?? 0;
}

// ---------------------------------------------------------------- I2 lock

export interface LockResult {
  invoiceId: string;
  sessionId: string;
  lockVersion: number;
  total: string;
  /** Items accepted but not yet picked up: a warning, not a block (D-12). */
  unpickedUnits: number;
  /** A bill of Rs 0 (everything comped) settles straight away. */
  settledNow: boolean;
}

export async function lockBill(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  invoiceId: string,
  settleZero: (locked: { session: SessionRow; invoice: InvoiceRow }) => Promise<void>,
): Promise<LockResult> {
  const { session, invoice } = await lockInvoice(tx, invoiceId);
  await requireOwnTable(tx, auth, 'invoices.lock', session);
  if (invoice.status !== 'open' || session.status === 'checkout_locked') {
    throw new AppError('STALE_STATE', 'This bill is already prepared', {
      lockVersion: invoice.lock_version,
    });
  }
  const { rows: pending } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cl.order_rounds WHERE session_id = $1 AND status = 'pending_approval'`,
    [session.id],
  );
  const waiting = pending[0]?.n ?? 0;
  if (waiting > 0) {
    throw new AppError(
      'PENDING_ROUNDS_EXIST',
      `${String(waiting)} order${waiting === 1 ? '' : 's'} still waiting for approval. Accept or reject first.`,
      { pendingRounds: waiting },
    );
  }
  const bill = await liveBill(tx, invoice.id, session.id);
  if (bill.lines.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Nothing to bill yet. If the guests left without ordering, close the table instead.',
    );
  }
  const lockVersion = await writeSnapshot(tx, auth, invoice, bill);
  await setCheckoutLocked(tx, session, true);
  const { rows: unpicked } = await tx.query<{ n: number }>(
    `SELECT coalesce(sum(l.qty - l.qty_picked_up - l.qty_cancelled_unprepared), 0)::int AS n
       FROM cl.order_lines l JOIN cl.order_rounds r ON r.id = l.round_id
      WHERE l.session_id = $1 AND r.status = 'accepted'`,
    [session.id],
  );
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'invoice.lock',
    entityType: 'invoice',
    entityId: invoice.id,
    after: { lockVersion, total: bill.total, lines: bill.lines.length },
  });
  await invoiceChanged(tx, invoice, session);
  const settledNow = new Decimal(bill.total).isZero();
  if (settledNow) {
    await settleZero({
      session: { ...session, status: 'checkout_locked' },
      invoice: { ...invoice, status: 'locked', lock_version: lockVersion, total: bill.total },
    });
  }
  return {
    invoiceId: invoice.id,
    sessionId: session.id,
    lockVersion,
    total: bill.total,
    unpickedUnits: unpicked[0]?.n ?? 0,
    settledNow,
  };
}

// ---------------------------------------------------------------- I3 reopen

export async function reopenBill(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  invoiceId: string,
  input: { reason?: string | undefined; stepUpId?: string | undefined },
): Promise<{ invoiceId: string; lockVersion: number }> {
  const { session, invoice } = await lockInvoice(tx, invoiceId);
  if (invoice.status !== 'locked') {
    throw new AppError('STALE_STATE', 'This bill is not prepared, so there is nothing to reopen');
  }
  let approvedBy: string | null = null;
  if (new Decimal(invoice.paid_total).gt(0)) {
    if (!input.stepUpId || !input.reason) {
      throw new AppError(
        'STEP_UP_REQUIRED',
        'Part of this bill is paid. A manager must approve reopening it, with a reason.',
        { action: 'invoice.reopen_with_payments', entityType: 'invoice', entityId: invoice.id },
      );
    }
    approvedBy = await consumeStepUp(tx, auth, {
      stepUpId: input.stepUpId,
      action: 'invoice.reopen_with_payments',
      entityType: 'invoice',
      entityId: invoice.id,
    });
  }
  await tx.query('DELETE FROM cl.invoice_lines WHERE invoice_id = $1', [invoice.id]);
  const { rows } = await tx.query<{ lock_version: number }>(
    `UPDATE cl.invoices SET status = 'open', lock_version = lock_version + 1, locked_at = NULL, locked_by = NULL
      WHERE id = $1 RETURNING lock_version`,
    [invoice.id],
  );
  await setCheckoutLocked(tx, session, false);
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'invoice.reopen',
    entityType: 'invoice',
    entityId: invoice.id,
    before: { lockVersion: invoice.lock_version, total: invoice.total, paid: invoice.paid_total },
    ...(input.reason ? { reason: input.reason } : {}),
    ...(approvedBy ? { approvedBy } : {}),
  });
  await invoiceChanged(tx, invoice, session);
  return { invoiceId: invoice.id, lockVersion: rows[0]?.lock_version ?? 0 };
}

// ---------------------------------------------------------------- discounts (D-14)

/** The largest discount % a user may give alone: the owner any, others their roles' limit. */
async function discountLimit(db: Queryable, userId: string): Promise<Decimal> {
  const { rows } = await db.query<{ is_owner: boolean; max_percent: string | null }>(
    `SELECT u.is_owner, (SELECT max(l.max_percent)::text FROM cl.user_roles ur
                           JOIN cl.role_discount_limits l ON l.role_id = ur.role_id
                          WHERE ur.user_id = u.id) AS max_percent
       FROM cl.users u WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return new Decimal(0);
  if (row.is_owner) return new Decimal(100);
  return new Decimal(row.max_percent ?? 0);
}

/** Changes to discounts are refused once money was taken on the prepared bill. */
function discountsChangeable(invoice: InvoiceRow): void {
  if (invoice.status === 'locked' && new Decimal(invoice.paid_total).gt(0)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Part of this bill is paid already. Reopen it (with a manager) to change discounts.',
    );
  }
}

/** A locked bill is worked out again so its figures and lock_version follow the change. */
async function refreshLocked(tx: Tx, auth: StaffAuth, invoice: InvoiceRow, session: SessionRow) {
  if (invoice.status !== 'locked') return invoice.lock_version;
  return writeSnapshot(tx, auth, invoice, await liveBill(tx, invoice.id, session.id));
}

export interface DiscountRequest {
  orderLineId: string | null;
  kind: DiscountKind;
  value: string;
  reason: string;
  stepUpId?: string | undefined;
}

export async function applyDiscount(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  invoiceId: string,
  input: DiscountRequest,
) {
  const { session, invoice } = await lockInvoice(tx, invoiceId);
  discountsChangeable(invoice);
  const permission = input.kind === 'comp' ? 'discounts.comp' : 'discounts.apply';
  if (!auth.permissions.has(permission)) {
    throw new AppError('FORBIDDEN', `You need the ${permission} permission for this`);
  }
  const before = await liveBill(tx, invoice.id, session.id);
  if (input.orderLineId !== null) {
    const line = before.lines.find((l) => l.orderLineId === input.orderLineId);
    if (!line) throw new AppError('NOT_FOUND', 'That item is not on this bill');
    if (line.isComp) throw new AppError('VALIDATION_FAILED', 'That item is already free (comp)');
  }
  if (input.kind === 'fixed' && new Decimal(input.value).lte(0)) {
    throw new AppError('VALIDATION_FAILED', 'Enter an amount above zero');
  }

  // Comps have no % limit (the permission is the limit); other discounts are measured
  // with everything already on the same target (two 10 % discounts make 20 %).
  let approvedBy: string | null = null;
  if (input.kind !== 'comp') {
    const probe = { id: '9223372036854775807', ...input } satisfies DiscountInput;
    const after = await liveBill(tx, invoice.id, session.id, probe);
    const sameTarget = [
      probe.id,
      ...(await activeDiscounts(tx, invoice.id))
        .filter((d) => d.order_line_id === input.orderLineId && d.kind !== 'comp')
        .map((d) => d.id),
    ];
    const percent = discountPercentOf(after, input.orderLineId, sameTarget);
    const limit = await discountLimit(tx, auth.user.id);
    if (percent.gt(limit)) {
      if (!input.stepUpId) {
        throw new AppError(
          'STEP_UP_REQUIRED',
          `That is ${percent.toDecimalPlaces(1).toString()} % off; you may give up to ${limit.toString()} %. A manager must approve it.`,
          {
            action: 'discount.over_limit',
            entityType: 'invoice',
            entityId: invoice.id,
            percent: percent.toDecimalPlaces(2).toString(),
            limit: limit.toString(),
          },
        );
      }
      approvedBy = await consumeStepUp(tx, auth, {
        stepUpId: input.stepUpId,
        action: 'discount.over_limit',
        entityType: 'invoice',
        entityId: invoice.id,
      });
      const approverLimit = await discountLimit(tx, approvedBy);
      if (percent.gt(approverLimit)) {
        throw new AppError(
          'DISCOUNT_OVER_LIMIT',
          `The approver may allow up to ${approverLimit.toString()} %; this is ${percent.toDecimalPlaces(1).toString()} %. Ask the owner.`,
          { percent: percent.toDecimalPlaces(2).toString(), limit: approverLimit.toString() },
        );
      }
    }
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.discount_applications (invoice_id, order_line_id, kind, value, amount, reason, applied_by, step_up_id)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7) RETURNING id::text`,
    [
      invoice.id,
      input.orderLineId,
      input.kind,
      input.kind === 'comp' ? '100' : input.value,
      input.reason,
      auth.user.id,
      approvedBy ? (input.stepUpId ?? null) : null,
    ],
  );
  const discountId = rows[0]?.id ?? '';
  const bill = await liveBill(tx, invoice.id, session.id);
  const amount = bill.discounts.find((d) => d.id === discountId)?.amount ?? '0.00';
  await tx.query('UPDATE cl.discount_applications SET amount = $2 WHERE id = $1', [
    discountId,
    amount,
  ]);
  const lockVersion = await refreshLocked(tx, auth, invoice, session);
  await writeAudit(tx, whoOf(auth, ctx), {
    action: input.kind === 'comp' ? 'discount.comp' : 'discount.apply',
    entityType: 'invoice',
    entityId: invoice.id,
    after: {
      discountId,
      orderLineId: input.orderLineId,
      kind: input.kind,
      value: input.value,
      amount,
    },
    reason: input.reason,
    ...(approvedBy ? { approvedBy } : {}),
  });
  await invoiceChanged(tx, invoice, session);
  return { discountId, amount, lockVersion };
}

export async function voidDiscount(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  discountId: string,
  reason: string,
) {
  const { rows } = await tx.query<{ invoice_id: string }>(
    'SELECT invoice_id::text FROM cl.discount_applications WHERE id = $1',
    [discountId],
  );
  const invoiceId = rows[0]?.invoice_id;
  if (!invoiceId) throw new AppError('NOT_FOUND', 'Discount not found');
  const { session, invoice } = await lockInvoice(tx, invoiceId);
  discountsChangeable(invoice);
  const { rows: found } = await tx.query<{ kind: DiscountKind; voided_at: Date | null }>(
    'SELECT kind, voided_at FROM cl.discount_applications WHERE id = $1 FOR UPDATE',
    [discountId],
  );
  const d = found[0];
  if (!d) throw new AppError('NOT_FOUND', 'Discount not found');
  if (d.voided_at) throw new AppError('STALE_STATE', 'This discount was already removed');
  const permission = d.kind === 'comp' ? 'discounts.comp' : 'discounts.apply';
  if (!auth.permissions.has(permission)) {
    throw new AppError('FORBIDDEN', `You need the ${permission} permission for this`);
  }
  await tx.query(
    'UPDATE cl.discount_applications SET voided_at = now(), voided_by = $2 WHERE id = $1',
    [discountId, auth.user.id],
  );
  const lockVersion = await refreshLocked(tx, auth, invoice, session);
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'discount.void',
    entityType: 'invoice',
    entityId: invoice.id,
    after: { discountId },
    reason,
  });
  await invoiceChanged(tx, invoice, session);
  return { discountId, lockVersion };
}
