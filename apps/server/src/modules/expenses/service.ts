/**
 * Expenses (FINANCE_REPORTING.md §3–4; DATABASE.md §10; Phase 5 step 5.3).
 *
 *  - Recorded with a category, payee, reference, how it was paid and the business date it
 *    belongs to (today or up to 31 days back); numbered `EXP-YYYY-NNNNN`, gapless per year.
 *  - Never changed: voided with a reason (a reversal entry in the ledger, the original kept,
 *    AT-107), and corrected by voiding and recording again in one step, the new one naming
 *    the one it replaces (AT-23).
 *  - Cash from the till while a shift is open (P5-6) is also that shift's paid-out, so
 *    expected cash follows; voiding it while the shift is open pays it back in. The
 *    expense's own ledger entry is the only one (0025).
 *  - Ingredient purchases are not expenses: they are received as stock (step 4.2).
 */
import { Decimal, money } from '@cl/shared';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { assertCashInTill, lockOpenShift } from '../billing/index.ts';
import type { CommandContext, StaffAuth } from '../orders/index.ts';

export const PAID_VIA = ['cash', 'card', 'transfer', 'other'] as const;
export const PROVIDERS = ['bank', 'jazzcash', 'easypaisa'] as const;
type PaidVia = (typeof PAID_VIA)[number];
type Provider = (typeof PROVIDERS)[number];

/** How far back an expense may be dated (a bill paid last month, entered late). */
export const MAX_BACKDATE_DAYS = 31;

export interface ExpenseInput {
  categoryId: string;
  amount: string;
  payee?: string | undefined;
  reference?: string | undefined;
  note?: string | undefined;
  businessDate?: string | undefined;
  paidVia: PaidVia;
  provider?: Provider | undefined;
  /** Cash out of the till of the open shift (P5-6). */
  fromTill?: boolean | undefined;
}

export interface Expense {
  id: string;
  expenseNo: string;
  categoryId: string;
  category: string;
  amount: string;
  payee: string | null;
  reference: string | null;
  note: string | null;
  businessDate: string;
  paidVia: PaidVia;
  provider: Provider | null;
  fromTill: boolean;
  status: 'recorded' | 'voided';
  attachment: { type: string; size: number } | null;
  createdBy: string;
  createdAt: string;
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  replacesNo: string | null;
  replacedByNo: string | null;
}

const who = (auth: StaffAuth, ctx: CommandContext) => ({
  actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
  correlationId: ctx.correlationId,
  ...(ctx.ip ? { ip: ctx.ip } : {}),
});

async function changed(tx: Tx, expenseId: string, till: boolean): Promise<void> {
  await publish(tx, {
    type: 'expense.changed',
    entityType: 'expense',
    entityId: expenseId,
    topics: ['expenses', 'ledger', ...(till ? ['cashier'] : [])],
  });
}

// ---------------------------------------------------------------- categories

export interface Category {
  id: string;
  name: string;
  isActive: boolean;
  used: number;
}

export async function listCategories(db: Queryable): Promise<{ items: Category[] }> {
  const { rows } = await db.query<Category>(
    `SELECT c.id::text, c.name, c.is_active AS "isActive",
            (SELECT count(*)::int FROM cl.expenses e WHERE e.category_id = c.id) AS used
       FROM cl.expense_categories c ORDER BY c.is_active DESC, lower(c.name), c.id`,
  );
  return { items: rows };
}

function duplicateName(error: unknown, name: string): never {
  if ((error as { code?: string }).code === '23505') {
    throw new AppError('VALIDATION_FAILED', `There is already a category called ${name}`);
  }
  throw error;
}

export async function createCategory(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  name: string,
): Promise<{ id: string }> {
  const { rows } = await tx
    .query<{ id: string }>(
      'INSERT INTO cl.expense_categories (name) VALUES ($1) RETURNING id::text',
      [name.trim()],
    )
    .catch((error: unknown) => duplicateName(error, name.trim()));
  const id = rows[0]?.id ?? '';
  await writeAudit(tx, who(auth, ctx), {
    action: 'expense_category.create',
    entityType: 'expense_category',
    entityId: id,
    after: { name: name.trim() },
  });
  await publish(tx, {
    type: 'expense.changed',
    entityType: 'expense_category',
    entityId: id,
    topics: ['expenses'],
  });
  return { id };
}

/** Renamed or switched off; a category in use is never deleted, only made inactive. */
export async function updateCategory(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  id: string,
  input: { name?: string | undefined; isActive?: boolean | undefined },
): Promise<Category> {
  const { rows: before } = await tx.query<{ name: string; is_active: boolean }>(
    'SELECT name, is_active FROM cl.expense_categories WHERE id = $1 FOR UPDATE',
    [id],
  );
  const old = before[0];
  if (!old) throw new AppError('NOT_FOUND', 'Category not found');
  const name = input.name?.trim() ?? old.name;
  const isActive = input.isActive ?? old.is_active;
  await tx
    .query(
      'UPDATE cl.expense_categories SET name = $2, is_active = $3, updated_at = now() WHERE id = $1',
      [id, name, isActive],
    )
    .catch((error: unknown) => duplicateName(error, name));
  await writeAudit(tx, who(auth, ctx), {
    action: 'expense_category.update',
    entityType: 'expense_category',
    entityId: id,
    before: { name: old.name, isActive: old.is_active },
    after: { name, isActive },
  });
  await publish(tx, {
    type: 'expense.changed',
    entityType: 'expense_category',
    entityId: id,
    topics: ['expenses'],
  });
  const { items } = await listCategories(tx);
  const found = items.find((c) => c.id === id);
  if (!found) throw new Error('category vanished');
  return found;
}

// ---------------------------------------------------------------- reading

const SELECT_EXPENSE = `
  SELECT e.id::text, e.expense_no AS "expenseNo", e.category_id::text AS "categoryId", c.name AS category,
         e.amount::text, e.payee, e.reference, e.note, e.business_date::text AS "businessDate",
         e.paid_via AS "paidVia", e.transfer_provider AS provider, e.from_till AS "fromTill", e.status,
         CASE WHEN e.attachment_path IS NOT NULL
              THEN json_build_object('type', e.attachment_type, 'size', e.attachment_size) END AS attachment,
         u.display_name AS "createdBy", e.created_at AS "createdAt",
         v.display_name AS "voidedBy", e.voided_at AS "voidedAt", e.void_reason AS "voidReason",
         r.expense_no AS "replacesNo", n.expense_no AS "replacedByNo"
    FROM cl.expenses e
    JOIN cl.expense_categories c ON c.id = e.category_id
    JOIN cl.users u ON u.id = e.created_by
    LEFT JOIN cl.users v ON v.id = e.voided_by
    LEFT JOIN cl.expenses r ON r.id = e.replaces_expense_id
    LEFT JOIN cl.expenses n ON n.replaces_expense_id = e.id`;

export async function readExpense(db: Queryable, id: string): Promise<Expense> {
  const { rows } = await db.query<Expense>(`${SELECT_EXPENSE} WHERE e.id = $1`, [id]);
  const found = rows[0];
  if (!found) throw new AppError('NOT_FOUND', 'Expense not found');
  return found;
}

/** A period's expenses, newest first, with the recorded total per category (voided excluded). */
export async function listExpenses(
  db: Queryable,
  filter: {
    from: string;
    to: string;
    categoryId?: string | undefined;
    status?: 'recorded' | 'voided' | undefined;
  },
): Promise<{
  from: string;
  to: string;
  items: Expense[];
  totals: { categoryId: string; category: string; amount: string; count: number }[];
  total: string;
}> {
  const { rows } = await db.query<Expense>(
    `${SELECT_EXPENSE}
      WHERE e.business_date BETWEEN $1::date AND $2::date
        AND ($3::bigint IS NULL OR e.category_id = $3::bigint)
        AND ($4::text IS NULL OR e.status = $4)
      ORDER BY e.business_date DESC, e.id DESC
      LIMIT 1000`,
    [filter.from, filter.to, filter.categoryId ?? null, filter.status ?? null],
  );
  const { rows: totals } = await db.query<{
    categoryId: string;
    category: string;
    amount: string;
    count: number;
  }>(
    `SELECT c.id::text AS "categoryId", c.name AS category, sum(e.amount)::numeric(14,2)::text AS amount,
            count(*)::int AS count
       FROM cl.expenses e JOIN cl.expense_categories c ON c.id = e.category_id
      WHERE e.status = 'recorded' AND e.business_date BETWEEN $1::date AND $2::date
        AND ($3::bigint IS NULL OR e.category_id = $3::bigint)
      GROUP BY c.id ORDER BY sum(e.amount) DESC, c.id`,
    [filter.from, filter.to, filter.categoryId ?? null],
  );
  const total = totals.reduce((s, t) => s.plus(t.amount), new Decimal(0));
  return { from: filter.from, to: filter.to, items: rows, totals, total: money.format(total) };
}

// ---------------------------------------------------------------- writing

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Carried {
  replacesExpenseId?: string;
  /** The open shift this transaction already holds (a correction of a till expense). */
  lockedOpenShiftId?: string | null;
  attachment?: { path: string; type: string; size: number; sha256: string } | null;
}

async function insertExpense(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  input: ExpenseInput,
  carried: Carried = {},
): Promise<{ id: string; expenseNo: string; businessDate: string; shiftId: string | null }> {
  const amount = money.parse(input.amount);
  if (amount.lte(0)) throw new AppError('VALIDATION_FAILED', 'Enter an amount above zero');
  const { rows: cats } = await tx.query<{ name: string; is_active: boolean }>(
    'SELECT name, is_active FROM cl.expense_categories WHERE id = $1',
    [input.categoryId],
  );
  const category = cats[0];
  if (!category?.is_active) throw new AppError('VALIDATION_FAILED', 'Choose an active category');
  if ((input.paidVia === 'transfer') !== (input.provider !== undefined)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'A transfer names its provider (bank, JazzCash, Easypaisa), and only a transfer',
    );
  }
  const today = await businessDateOf(tx, ctx.now);
  const businessDate = input.businessDate ?? today;
  if (businessDate > today)
    throw new AppError('VALIDATION_FAILED', 'An expense cannot be dated in the future');
  if (businessDate < addDays(today, -MAX_BACKDATE_DAYS)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `An expense can be dated at most ${String(MAX_BACKDATE_DAYS)} days back`,
    );
  }
  let shiftId: string | null = null;
  if (input.fromTill) {
    if (input.paidVia !== 'cash')
      throw new AppError('VALIDATION_FAILED', 'Only cash comes out of the till');
    if (businessDate !== today) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Cash from the till is today’s: leave the date as today',
      );
    }
    shiftId = carried.lockedOpenShiftId ?? (await lockOpenShift(tx));
    if (shiftId === null) {
      throw new AppError(
        'NO_OPEN_CASH_SHIFT',
        'No cash shift is open. Open the shift, or record it as paid from elsewhere.',
      );
    }
  }
  if (shiftId !== null) await assertCashInTill(tx, shiftId, amount, 'paying more from it');
  const year = businessDate.slice(0, 4);
  const expenseNo = `EXP-${year}-${(await tx.nextNumber('expense', year)).padStart(5, '0')}`;
  const attachment = carried.attachment ?? null;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.expenses (expense_no, category_id, amount, payee, reference, note, business_date, paid_via,
       transfer_provider, from_till, cash_shift_id, replaces_expense_id, attachment_path, attachment_type,
       attachment_size, attachment_sha256, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id::text`,
    [
      expenseNo,
      input.categoryId,
      money.format(amount),
      input.payee?.trim() || null,
      input.reference?.trim() || null,
      input.note?.trim() || null,
      businessDate,
      input.paidVia,
      input.provider ?? null,
      input.fromTill === true,
      shiftId,
      carried.replacesExpenseId ?? null,
      attachment?.path ?? null,
      attachment?.type ?? null,
      attachment?.size ?? null,
      attachment?.sha256 ?? null,
      auth.user.id,
    ],
  );
  const id = rows[0]?.id ?? '';
  if (shiftId !== null) {
    await tx.query(
      `INSERT INTO cl.cash_movements (shift_id, kind, amount, reason, actor, expense_id)
       VALUES ($1, 'paid_out', $2, $3, $4, $5)`,
      [
        shiftId,
        money.format(amount),
        `Expense ${expenseNo}: ${category.name}${input.payee?.trim() ? ` · ${input.payee.trim()}` : ''}`,
        auth.user.id,
        id,
      ],
    );
  }
  await writeAudit(tx, who(auth, ctx), {
    action: 'expense.record',
    entityType: 'expense',
    entityId: id,
    after: {
      expenseNo,
      category: category.name,
      amount: money.format(amount),
      paidVia: input.paidVia,
      provider: input.provider ?? null,
      businessDate,
      fromTill: input.fromTill === true,
      ...(carried.replacesExpenseId ? { replacesExpenseId: carried.replacesExpenseId } : {}),
    },
  });
  await changed(tx, id, shiftId !== null);
  return { id, expenseNo, businessDate, shiftId };
}

export async function recordExpense(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  input: ExpenseInput,
): Promise<{ id: string; expenseNo: string; businessDate: string; paidOutOfShift: boolean }> {
  const result = await insertExpense(tx, ctx, auth, input);
  return {
    id: result.id,
    expenseNo: result.expenseNo,
    businessDate: result.businessDate,
    paidOutOfShift: result.shiftId !== null,
  };
}

interface LockedExpense {
  id: string;
  expense_no: string;
  status: string;
  amount: string;
  from_till: boolean;
  cash_shift_id: string | null;
  attachment_path: string | null;
  attachment_type: string | null;
  attachment_size: number | null;
  attachment_sha256: string | null;
}

/** AT-107: the original stays; the ledger gets a reversal; a till expense goes back in while its shift is open. */
export async function voidExpense(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  id: string,
  reason: string,
): Promise<{
  id: string;
  expenseNo: string;
  backInTill: boolean;
  expense: LockedExpense;
  lockedOpenShiftId: string | null;
}> {
  const [expense] = await tx.lock<LockedExpense>('expenses', [id]);
  if (!expense) throw new AppError('NOT_FOUND', 'Expense not found');
  if (expense.status !== 'recorded') {
    throw new AppError('STALE_STATE', `${expense.expense_no} is already voided`);
  }
  let backInTill = false;
  if (expense.from_till && expense.cash_shift_id !== null) {
    const [shift] = await tx.lock<{ status: string }>('cash_shifts', [expense.cash_shift_id]);
    if (shift?.status === 'open') {
      await tx.query(
        `INSERT INTO cl.cash_movements (shift_id, kind, amount, reason, actor, expense_id)
         VALUES ($1, 'paid_in', $2, $3, $4, $5)`,
        [
          expense.cash_shift_id,
          expense.amount,
          `Expense ${expense.expense_no} voided`,
          auth.user.id,
          id,
        ],
      );
      backInTill = true;
    }
  }
  await tx.query(
    `UPDATE cl.expenses SET status = 'voided', voided_by = $2, voided_at = now(), void_reason = $3 WHERE id = $1`,
    [id, auth.user.id, reason.trim()],
  );
  await writeAudit(tx, who(auth, ctx), {
    action: 'expense.void',
    entityType: 'expense',
    entityId: id,
    reason: reason.trim(),
    before: { status: 'recorded', amount: expense.amount },
    after: { status: 'voided', backInTill },
  });
  await changed(tx, id, backInTill);
  return {
    id,
    expenseNo: expense.expense_no,
    backInTill,
    expense,
    lockedOpenShiftId: backInTill ? expense.cash_shift_id : null,
  };
}

/** AT-23: void with the reason and record the right figures, naming the one replaced. */
export async function correctExpense(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  id: string,
  reason: string,
  input: ExpenseInput,
): Promise<{ voidedNo: string; id: string; expenseNo: string; businessDate: string }> {
  const voided = await voidExpense(tx, ctx, auth, id, reason);
  const e = voided.expense;
  const result = await insertExpense(tx, ctx, auth, input, {
    replacesExpenseId: id,
    lockedOpenShiftId: voided.lockedOpenShiftId,
    attachment:
      e.attachment_path && e.attachment_type && e.attachment_size !== null && e.attachment_sha256
        ? {
            path: e.attachment_path,
            type: e.attachment_type,
            size: e.attachment_size,
            sha256: e.attachment_sha256,
          }
        : null,
  });
  return {
    voidedNo: voided.expenseNo,
    id: result.id,
    expenseNo: result.expenseNo,
    businessDate: result.businessDate,
  };
}
