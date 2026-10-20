/**
 * Order rounds (ORDER_STATE_MACHINE.md §2, §8.1, §8.2): guest rounds wait for approval
 * (R1); staff rounds are accepted as they are submitted (R2); exactly one accept, reject
 * or withdrawal decides a pending round (R3–R5). Acceptance prices each line (price lock,
 * D-08), freezes its recipe explosion and reserves stock for the whole round at once,
 * or saves nothing (INSUFFICIENT_STOCK). Kitchen tickets join acceptance in step 3.5.
 *
 * Lock order (DATABASE.md §14): table → session → round → lines → balances → counters.
 */
import { Decimal, money } from '@cl/shared';
import { z } from 'zod';
import { writeAudit, type Actor } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf, readSetting } from '../../platform/settings.ts';
import { discountedPrice } from '../catalog/index.ts';
import type { SessionRow } from '../floor/index.ts';
import type { AuthContext } from '../identity/index.ts';
import {
  explodeRecipe,
  holdStock,
  loadActiveRecipes,
  loadModifierRules,
  requirement,
  rulesForVariant,
  type LineRequirement,
  type OrderType,
} from '../stock/index.ts';
import { priceLines, type LineInput, type PricedLine } from './pricing.ts';

export const MAX_PENDING_PER_SESSION = 3;

export type Submitter =
  | { kind: 'guest'; tokenId: string }
  | { kind: 'user'; userId: string; deviceId?: string; source: 'waiter' | 'reception' };

export interface CommandContext {
  /** The request's Idempotency-Key: event keys are `<event>:<key>`. */
  key: string;
  correlationId: string;
  now: Date;
  ip?: string | undefined;
}

interface RoundRow {
  id: string;
  session_id: string;
  round_no: number;
  round_ref: string;
  source: string;
  status: string;
  submitted_at: Date;
  submitted_by_guest_token_id: string | null;
  escalated_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
}

const ACTIVE = ['open', 'checkout_requested', 'checkout_locked'];

async function settingMinutes(db: Queryable, key: string): Promise<number> {
  return readSetting(db, key, z.number().positive());
}

function roundTopics(session: { id: string; table_id: string | null }): string[] {
  return [
    'approvals',
    `session:${session.id}`,
    ...(session.table_id ? [`table:${session.table_id}`] : []),
  ];
}

async function orderEvent(
  tx: Tx,
  ctx: CommandContext,
  e: { roundId: string; type: string; actor: Actor; reason?: string; data?: unknown },
): Promise<void> {
  await tx.query(
    `INSERT INTO cl.order_events (round_id, event_type, actor_kind, actor_user_id, reason, data, event_key, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.roundId,
      e.type,
      e.actor.kind,
      e.actor.kind === 'user' ? e.actor.userId : null,
      e.reason ?? null,
      e.data === undefined ? null : JSON.stringify(e.data),
      `${e.type}:${ctx.key}`,
      ctx.correlationId,
    ],
  );
}

function sessionGuard(session: SessionRow): void {
  if (session.status === 'checkout_locked') {
    throw new AppError(
      'SESSION_LOCKED_FOR_CHECKOUT',
      'The bill is being prepared. Ask a member of staff to reopen it.',
    );
  }
  if (!ACTIVE.includes(session.status)) throw new AppError('VISIT_ENDED', 'This visit has ended.');
}

// ---------------------------------------------------------------- stock at acceptance

interface LineForStock {
  key: string;
  variantId: string;
  qty: number;
  optionIds: string[];
}

interface StockPlan {
  /** Per line key: stock mode, recipe version and qty_per_unit per ingredient. */
  lines: Map<
    string,
    { mode: 'untracked' | 'recipe'; recipeVersionId: string | null; perUnit: Map<string, Decimal> }
  >;
  requirements: LineRequirement[];
}

/** Explodes each recipe-mode line with the active recipe and the rules in force now. */
async function planStock(
  db: Queryable,
  lines: readonly LineForStock[],
  orderType: OrderType,
  now: Date,
): Promise<StockPlan> {
  const recipes = await loadActiveRecipes(db, [...new Set(lines.map((l) => l.variantId))]);
  const rules = recipes.size > 0 ? await loadModifierRules(db, now) : [];
  const plan: StockPlan = { lines: new Map(), requirements: [] };
  for (const line of lines) {
    const recipe = recipes.get(line.variantId);
    if (!recipe) {
      plan.lines.set(line.key, { mode: 'untracked', recipeVersionId: null, perUnit: new Map() });
      continue;
    }
    const perUnit = explodeRecipe(
      recipe.components,
      rulesForVariant(rules, line.variantId),
      orderType,
      line.optionIds,
    );
    plan.lines.set(line.key, { mode: 'recipe', recipeVersionId: recipe.recipeVersionId, perUnit });
    plan.requirements.push({ key: line.key, requirement: requirement(perUnit, line.qty) });
  }
  return plan;
}

async function writeComponents(
  tx: Tx,
  lineId: string,
  perUnit: ReadonlyMap<string, Decimal>,
): Promise<void> {
  for (const [itemId, q] of perUnit) {
    await tx.query(
      'INSERT INTO cl.order_line_components (line_id, inventory_item_id, qty_per_unit) VALUES ($1, $2, $3)',
      [lineId, itemId, q.toFixed(4)],
    );
  }
}

// ---------------------------------------------------------------- submit (R1 / R2)

export interface SubmittedRound {
  id: string;
  roundRef: string;
  roundNo: number;
  status: 'pending_approval' | 'accepted';
  quotedTotal: string;
  afterBillRequest: boolean;
}

/**
 * R1 (guest) or R2 (staff: accepted at once, stock reserved, all or nothing). `session`
 * must already be locked by the caller (table, then session).
 */
export async function submitRound(
  tx: Tx,
  ctx: CommandContext,
  input: { session: SessionRow; submitter: Submitter; lines: readonly LineInput[] },
): Promise<SubmittedRound> {
  const { session, submitter } = input;
  sessionGuard(session);
  if (submitter.kind === 'guest') {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cl.order_rounds WHERE session_id = $1 AND status = 'pending_approval'`,
      [session.id],
    );
    if ((rows[0]?.n ?? 0) >= MAX_PENDING_PER_SESSION) {
      throw new AppError(
        'RATE_LIMITED',
        `${String(MAX_PENDING_PER_SESSION)} orders from this table are already waiting for staff. Please wait for them to be accepted.`,
      );
    }
  }
  const priced = await priceLines(tx, input.lines, { orderType: session.order_type, now: ctx.now });

  // Staff rounds: plan and hold the stock before taking the round number (DATABASE.md §14).
  let plan: StockPlan | null = null;
  let hold: Awaited<ReturnType<typeof holdStock>> | null = null;
  if (submitter.kind === 'user') {
    plan = await planStock(
      tx,
      priced.lines.map((l) => ({
        key: `line:${String(l.lineNo)}`,
        variantId: l.variantId,
        qty: l.qty,
        optionIds: optionIds(l),
      })),
      session.order_type,
      ctx.now,
    );
    try {
      hold = await holdStock(tx, plan.requirements);
    } catch (error) {
      // Name the short lines by their number so the composer can flag them (AT-26).
      if (error instanceof AppError && error.code === 'INSUFFICIENT_STOCK') {
        const shortages = (error.extra['shortages'] ?? []) as { lineKeys: string[] }[];
        throw new AppError('INSUFFICIENT_STOCK', error.message, {
          shortages: shortages.map(({ lineKeys, ...rest }) => ({
            ...rest,
            lineNos: lineKeys.map((k) => Number(k.replace('line:', ''))),
          })),
        });
      }
      throw error;
    }
  }

  const { rows: next } = await tx.query<{ n: number }>(
    'SELECT COALESCE(max(round_no), 0) + 1 AS n FROM cl.order_rounds WHERE session_id = $1',
    [session.id],
  );
  const roundNo = next[0]?.n ?? 1;
  const businessDate = await businessDateOf(tx, ctx.now);
  const roundRef = `R-${businessDate.slice(5, 7)}${businessDate.slice(8, 10)}-${(await tx.nextNumber('round', businessDate)).padStart(3, '0')}`;
  const afterBillRequest = session.status === 'checkout_requested';
  const accepted = submitter.kind === 'user';
  const { rows: inserted } = await tx.query<{ id: string }>(
    `INSERT INTO cl.order_rounds
       (session_id, round_no, round_ref, source, status, submitted_at, submitted_by_user_id, submitted_by_guest_token_id,
        quoted_total, after_bill_request, decided_at, decided_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id::text`,
    [
      session.id,
      roundNo,
      roundRef,
      submitter.kind === 'guest' ? 'qr' : submitter.source,
      accepted ? 'accepted' : 'pending_approval',
      ctx.now,
      submitter.kind === 'user' ? submitter.userId : null,
      submitter.kind === 'guest' ? submitter.tokenId : null,
      money.format(priced.total),
      afterBillRequest,
      accepted ? ctx.now : null,
      submitter.kind === 'user' ? submitter.userId : null,
    ],
  );
  const roundId = inserted[0]?.id ?? '';
  const lineIds = new Map<string, string>();
  for (const line of priced.lines) {
    const stock = plan?.lines.get(`line:${String(line.lineNo)}`);
    const lineId = await insertLine(tx, roundId, session.id, line, stock ?? null);
    lineIds.set(`line:${String(line.lineNo)}`, lineId);
    if (stock) await writeComponents(tx, lineId, stock.perUnit);
  }
  await hold?.commit((key) => lineIds.get(key) ?? '');

  const actor: Actor =
    submitter.kind === 'user'
      ? {
          kind: 'user',
          userId: submitter.userId,
          ...(submitter.deviceId ? { deviceId: submitter.deviceId } : {}),
        }
      : { kind: 'guest' };
  await orderEvent(tx, ctx, { roundId, type: 'round_submitted', actor });
  if (accepted) await orderEvent(tx, ctx, { roundId, type: 'round_accepted', actor });
  await writeAudit(
    tx,
    { actor, correlationId: ctx.correlationId, ...(ctx.ip ? { ip: ctx.ip } : {}) },
    {
      action: accepted ? 'round.submit_accepted' : 'round.submit',
      entityType: 'order_round',
      entityId: roundId,
      after: { roundRef, total: money.format(priced.total), lines: priced.lines.length },
    },
  );
  await publish(tx, {
    type: accepted ? 'round.decided' : 'round.submitted',
    entityType: 'order_round',
    entityId: roundId,
    topics: [...roundTopics(session), ...(accepted ? ['kitchen'] : [])],
  });
  return {
    id: roundId,
    roundRef,
    roundNo,
    status: accepted ? 'accepted' : 'pending_approval',
    quotedTotal: money.format(priced.total),
    afterBillRequest,
  };
}

function optionIds(line: PricedLine): string[] {
  return line.modifiers.flatMap((m) => Array.from({ length: m.qty }, () => m.optionId));
}

async function insertLine(
  tx: Tx,
  roundId: string,
  sessionId: string,
  line: PricedLine,
  acceptedStock: { mode: 'untracked' | 'recipe'; recipeVersionId: string | null } | null,
): Promise<string> {
  // A staff round is accepted now: catalog price = quoted price, no lock.
  const discount = line.promotionDiscount.times(line.qty);
  const gross = line.unitPrice.plus(line.modifiersUnitTotal).times(line.qty);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.order_lines
       (round_id, session_id, line_no, variant_id, item_name_snap, variant_name_snap, qty, notes,
        unit_price_quoted, modifiers_unit_total, promotion_id, promotion_discount,
        catalog_unit_price, unit_price, line_gross, stock_mode_snap, recipe_version_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id::text`,
    [
      roundId,
      sessionId,
      line.lineNo,
      line.variantId,
      line.itemName,
      line.variantName,
      line.qty,
      line.notes,
      money.format(line.unitPrice),
      money.format(line.modifiersUnitTotal),
      line.promotionId,
      money.format(discount),
      acceptedStock ? money.format(line.unitPrice) : null,
      acceptedStock ? money.format(line.unitPrice) : null,
      acceptedStock ? money.format(gross) : null,
      acceptedStock?.mode ?? null,
      acceptedStock?.recipeVersionId ?? null,
    ],
  );
  const lineId = rows[0]?.id ?? '';
  for (const m of line.modifiers) {
    await tx.query(
      `INSERT INTO cl.order_line_modifiers (line_id, modifier_option_id, name_snap, price_delta_snap, qty)
       VALUES ($1, $2, $3, $4, $5)`,
      [lineId, m.optionId, m.name, money.format(m.priceDelta), m.qty],
    );
  }
  return lineId;
}

// ---------------------------------------------------------------- deciding (R3 / R4 / R5)

interface LockedRound {
  round: RoundRow;
  session: SessionRow;
  /** The waiter assigned to the table now, read under the table lock. */
  assignedTo: string | null;
}

/** Locks table → session → round, in that order (DATABASE.md §14). */
async function lockRound(tx: Tx, roundId: string): Promise<LockedRound> {
  const { rows: found } = await tx.query<{ session_id: string; table_id: string | null }>(
    `SELECT r.session_id::text, s.table_id::text FROM cl.order_rounds r JOIN cl.dining_sessions s ON s.id = r.session_id
      WHERE r.id = $1`,
    [roundId],
  );
  const where = found[0];
  if (!where) throw new AppError('NOT_FOUND', 'Order not found');
  if (where.table_id) await tx.lock('dining_tables', [where.table_id]);
  const { rows: sessions } = await tx.query<SessionRow>(
    `SELECT id::text, session_no, order_type, table_id::text, status, guest_count, opened_at
       FROM cl.dining_sessions WHERE id = $1 FOR UPDATE`,
    [where.session_id],
  );
  const session = sessions[0];
  if (!session) throw new AppError('NOT_FOUND', 'Order not found');
  const { rows: assignment } = session.table_id
    ? await tx.query<{ user_id: string }>(
        'SELECT user_id::text FROM cl.table_assignments WHERE table_id = $1 AND ended_at IS NULL',
        [session.table_id],
      )
    : { rows: [] };
  const [round] = await tx.lock<RoundRow>('order_rounds', [roundId]);
  if (!round) throw new AppError('NOT_FOUND', 'Order not found');
  return { round, session, assignedTo: assignment[0]?.user_id ?? null };
}

/** Exactly one decision per round: later ones learn who decided and when. */
async function assertPending(tx: Tx, round: RoundRow): Promise<void> {
  if (round.status !== 'pending_approval') {
    const { rows: who } = await tx.query<{ display_name: string }>(
      'SELECT display_name FROM cl.users WHERE id = $1',
      [round.decided_by],
    );
    throw new AppError(
      'ROUND_ALREADY_DECIDED',
      `This order was already ${round.status.replace('_', ' ')}`,
      {
        status: round.status,
        decidedBy: who[0]?.display_name ?? null,
        decidedAt: round.decided_at?.toISOString() ?? null,
      },
    );
  }
}

function isEscalated(round: RoundRow, now: Date, escalationMinutes: number): boolean {
  return (
    round.escalated_at !== null ||
    now.getTime() - round.submitted_at.getTime() >= escalationMinutes * 60_000
  );
}

/**
 * D-07 acceptance scope, evaluated under the locks: owner/manager any round; waiter only
 * at a table assigned to them now; cashier takeaway and delivery, unassigned tables, and
 * any escalated round (D-36).
 */
export function mayDecide(
  auth: Pick<AuthContext, 'user' | 'permissions'>,
  where: { orderType: OrderType; assignedTo: string | null; escalated: boolean },
): boolean {
  const grant = auth.permissions.get('orders.accept');
  if (!grant) return false;
  if (grant.scopes === 'all') return true;
  return grant.scopes.some((scope) => {
    if (scope['acceptance'] === 'assigned_tables')
      return where.orderType === 'dine_in' && where.assignedTo === auth.user.id;
    if (scope['acceptance'] === 'cashier') {
      return where.orderType !== 'dine_in' || where.assignedTo === null || where.escalated;
    }
    return false;
  });
}

interface LineRow {
  id: string;
  line_no: number;
  variant_id: string;
  qty: number;
  unit_price_quoted: string;
  modifiers_unit_total: string;
  promotion_id: string | null;
}

/** R3: price lock, recipe explosion and stock for the whole round, or nothing. */
export async function acceptRound(
  tx: Tx,
  ctx: CommandContext,
  auth: Pick<AuthContext, 'user' | 'device' | 'permissions'>,
  roundId: string,
): Promise<{ id: string; roundRef: string; status: 'accepted'; priceLockedLines: number }> {
  const { round, session, assignedTo } = await lockRound(tx, roundId);
  sessionGuard(session);
  const escalated = isEscalated(
    round,
    ctx.now,
    await settingMinutes(tx, 'orders.escalation_minutes'),
  );
  if (!mayDecide(auth, { orderType: session.order_type, assignedTo, escalated })) {
    throw new AppError(
      'NOT_IN_ACCEPTANCE_SCOPE',
      'This order is for a table assigned to someone else',
      {
        assignedTo,
        escalated,
      },
    );
  }
  await assertPending(tx, round);
  const { rows: ids } = await tx.query<{ id: string }>(
    'SELECT id::text FROM cl.order_lines WHERE round_id = $1',
    [roundId],
  );
  const lines = await tx.lock<LineRow>(
    'order_lines',
    ids.map((r) => r.id),
  );
  const { rows: mods } = await tx.query<{ line_id: string; option_id: string; qty: number }>(
    `SELECT line_id::text, modifier_option_id::text AS option_id, qty FROM cl.order_line_modifiers
      WHERE line_id = ANY($1::bigint[])`,
    [ids.map((r) => r.id)],
  );

  // Price lock (D-08): a price that rose is honoured within the lock window.
  const lockMinutes = await settingMinutes(tx, 'orders.price_lock_minutes');
  const withinLock = ctx.now.getTime() - round.submitted_at.getTime() <= lockMinutes * 60_000;
  const { rows: catalog } = await tx.query<{ id: string; price: string }>(
    'SELECT id::text, price::text FROM cl.menu_variants WHERE id = ANY($1::bigint[])',
    [lines.map((l) => l.variant_id)],
  );
  const catalogPrice = new Map(catalog.map((c) => [c.id, new Decimal(c.price)]));
  const promoIds = lines.flatMap((l) => (l.promotion_id ? [l.promotion_id] : []));
  const { rows: promos } = await tx.query<{ id: string; kind: 'percent' | 'fixed'; value: string }>(
    'SELECT id::text, kind, value::text FROM cl.promotions WHERE id = ANY($1::bigint[])',
    [promoIds],
  );
  const promoById = new Map(promos.map((p) => [p.id, p]));
  const pricing = new Map<
    string,
    { catalog: Decimal; unit: Decimal; locked: boolean; discount: Decimal; gross: Decimal }
  >();
  const expired: number[] = [];
  for (const l of lines) {
    const quoted = new Decimal(l.unit_price_quoted);
    const now = catalogPrice.get(l.variant_id) ?? quoted;
    let unit = now;
    let locked = false;
    if (now.greaterThan(quoted)) {
      if (!withinLock) expired.push(l.line_no);
      unit = quoted;
      locked = true;
    }
    const promo = l.promotion_id ? promoById.get(l.promotion_id) : undefined;
    const unitDiscount = promo ? unit.minus(discountedPrice(unit, promo)) : new Decimal(0);
    pricing.set(l.id, {
      catalog: now,
      unit,
      locked,
      discount: unitDiscount.times(l.qty),
      gross: unit.plus(l.modifiers_unit_total).times(l.qty),
    });
  }
  if (expired.length > 0) {
    throw new AppError(
      'PRICE_CHANGED_LOCK_EXPIRED',
      `Prices went up more than ${String(lockMinutes)} minutes after this order was sent. Reject it so the guest can order again.`,
      { lines: expired },
    );
  }

  const plan = await planStock(
    tx,
    lines.map((l) => ({
      key: l.id,
      variantId: l.variant_id,
      qty: l.qty,
      optionIds: mods
        .filter((m) => m.line_id === l.id)
        .flatMap((m) => Array.from({ length: m.qty }, () => m.option_id)),
    })),
    session.order_type,
    ctx.now,
  );
  const hold = await holdStock(tx, plan.requirements);
  for (const l of lines) {
    const p = pricing.get(l.id);
    const stock = plan.lines.get(l.id);
    if (!p || !stock) continue;
    await tx.query(
      `UPDATE cl.order_lines SET catalog_unit_price = $2, unit_price = $3, price_locked = $4, promotion_discount = $5,
              line_gross = $6, stock_mode_snap = $7, recipe_version_id = $8
        WHERE id = $1`,
      [
        l.id,
        money.format(p.catalog),
        money.format(p.unit),
        p.locked,
        money.format(p.discount),
        money.format(p.gross),
        stock.mode,
        stock.recipeVersionId,
      ],
    );
    await writeComponents(tx, l.id, stock.perUnit);
  }
  await hold.commit();
  await tx.query(
    `UPDATE cl.order_rounds SET status = 'accepted', decided_at = $2, decided_by = $3 WHERE id = $1`,
    [roundId, ctx.now, auth.user.id],
  );
  const actor: Actor = { kind: 'user', userId: auth.user.id, deviceId: auth.device.id };
  const priceLockedLines = [...pricing.values()].filter((p) => p.locked).length;
  await orderEvent(tx, ctx, { roundId, type: 'round_accepted', actor, data: { priceLockedLines } });
  await writeAudit(
    tx,
    { actor, correlationId: ctx.correlationId, ...(ctx.ip ? { ip: ctx.ip } : {}) },
    {
      action: 'round.accept',
      entityType: 'order_round',
      entityId: roundId,
      after: { roundRef: round.round_ref, priceLockedLines, escalated },
    },
  );
  await publish(tx, {
    type: 'round.decided',
    entityType: 'order_round',
    entityId: roundId,
    topics: [...roundTopics(session), 'kitchen'],
  });
  return { id: roundId, roundRef: round.round_ref, status: 'accepted', priceLockedLines };
}

/** R4: the whole round, with a reason the guest sees (D-06). */
export async function rejectRound(
  tx: Tx,
  ctx: CommandContext,
  auth: Pick<AuthContext, 'user' | 'device' | 'permissions'>,
  roundId: string,
  reason: string,
): Promise<{ id: string; status: 'rejected' }> {
  const { round, session, assignedTo } = await lockRound(tx, roundId);
  const escalated = isEscalated(
    round,
    ctx.now,
    await settingMinutes(tx, 'orders.escalation_minutes'),
  );
  if (!mayDecide(auth, { orderType: session.order_type, assignedTo, escalated })) {
    throw new AppError(
      'NOT_IN_ACCEPTANCE_SCOPE',
      'This order is for a table assigned to someone else',
      { assignedTo, escalated },
    );
  }
  await assertPending(tx, round);
  await tx.query(
    `UPDATE cl.order_rounds SET status = 'rejected', decided_at = $2, decided_by = $3, decision_reason = $4 WHERE id = $1`,
    [roundId, ctx.now, auth.user.id, reason],
  );
  const actor: Actor = { kind: 'user', userId: auth.user.id, deviceId: auth.device.id };
  await orderEvent(tx, ctx, { roundId, type: 'round_rejected', actor, reason });
  await writeAudit(
    tx,
    { actor, correlationId: ctx.correlationId },
    {
      action: 'round.reject',
      entityType: 'order_round',
      entityId: roundId,
      reason,
    },
  );
  await publish(tx, {
    type: 'round.decided',
    entityType: 'order_round',
    entityId: roundId,
    topics: roundTopics(session),
  });
  return { id: roundId, status: 'rejected' };
}

/** R5 by the guest who sent it. */
export async function withdrawRound(
  tx: Tx,
  ctx: CommandContext,
  guest: { tokenId: string },
  roundId: string,
): Promise<{ id: string; status: 'cancelled' }> {
  const { round, session } = await lockRound(tx, roundId);
  if (round.submitted_by_guest_token_id !== guest.tokenId) {
    throw new AppError('NOT_FOUND', 'Order not found'); // not this phone's: reveal nothing
  }
  await assertPending(tx, round);
  await tx.query(`UPDATE cl.order_rounds SET status = 'cancelled', decided_at = $2 WHERE id = $1`, [
    roundId,
    ctx.now,
  ]);
  await orderEvent(tx, ctx, { roundId, type: 'round_withdrawn', actor: { kind: 'guest' } });
  await publish(tx, {
    type: 'round.decided',
    entityType: 'order_round',
    entityId: roundId,
    topics: roundTopics(session),
  });
  return { id: roundId, status: 'cancelled' };
}

// ---------------------------------------------------------------- escalation (T2)

/** Marks rounds pending longer than the setting as escalated (D-36); once each. */
export async function escalateOverdue(tx: Tx, now: Date): Promise<number> {
  const minutes = await settingMinutes(tx, 'orders.escalation_minutes');
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE cl.order_rounds SET escalated_at = $1
      WHERE status = 'pending_approval' AND escalated_at IS NULL
        AND submitted_at <= $1::timestamptz - make_interval(mins => $2)
      RETURNING id::text`,
    [now, minutes],
  );
  for (const r of rows) {
    await publish(tx, {
      type: 'round.escalated',
      entityType: 'order_round',
      entityId: r.id,
      topics: ['approvals'],
    });
  }
  return rows.length;
}
