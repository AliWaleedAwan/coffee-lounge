/**
 * Reading rounds: a session with all its rounds and lines (staff and guest views), and
 * the approvals queue (API.md §5.4 `GET /approvals`): pending rounds the caller may decide,
 * oldest first, each with an advisory stock check (the real one happens at acceptance).
 */
import { Decimal, money } from '@cl/shared';
import { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import { readSetting } from '../../platform/settings.ts';
import type { AuthContext } from '../identity/index.ts';
import {
  explodeRecipe,
  loadActiveRecipes,
  loadModifierRules,
  requirement,
  rulesForVariant,
  type OrderType,
} from '../stock/index.ts';
import { mayDecide } from './rounds.ts';

interface RoundRow {
  id: string;
  session_id: string;
  round_no: number;
  round_ref: string;
  source: string;
  status: string;
  submitted_at: Date;
  quoted_total: string;
  after_bill_request: boolean;
  escalated_at: Date | null;
  decided_at: Date | null;
  decision_reason: string | null;
  submitted_by_guest_token_id: string | null;
}

interface LineRow {
  id: string;
  round_id: string;
  line_no: number;
  variant_id: string;
  item_name_snap: string;
  variant_name_snap: string;
  qty: number;
  notes: string | null;
  unit_price_quoted: string;
  unit_price: string | null;
  price_locked: boolean;
  modifiers_unit_total: string;
  promotion_discount: string;
  qty_picked_up: number;
  qty_served: number;
  qty_cancelled_unprepared: number;
  qty_cancelled_prepared: number;
}

interface ModRow {
  line_id: string;
  option_id: string;
  name_snap: string;
  price_delta_snap: string;
  qty: number;
}

async function loadRounds(db: Queryable, where: string, params: unknown[]) {
  const { rows: rounds } = await db.query<RoundRow>(
    `SELECT id::text, session_id::text, round_no, round_ref, source, status, submitted_at, quoted_total::text,
            after_bill_request, escalated_at, decided_at, decision_reason, submitted_by_guest_token_id::text
       FROM cl.order_rounds WHERE ${where} ORDER BY submitted_at, id`,
    params,
  );
  const roundIds = rounds.map((r) => r.id);
  const { rows: lines } = await db.query<LineRow>(
    `SELECT id::text, round_id::text, line_no, variant_id::text, item_name_snap, variant_name_snap, qty, notes,
            unit_price_quoted::text, unit_price::text, price_locked, modifiers_unit_total::text,
            promotion_discount::text,
            qty_picked_up, qty_served, qty_cancelled_unprepared, qty_cancelled_prepared
       FROM cl.order_lines WHERE round_id = ANY($1::bigint[]) ORDER BY round_id, line_no`,
    [roundIds],
  );
  const { rows: mods } = await db.query<ModRow>(
    `SELECT line_id::text, modifier_option_id::text AS option_id, name_snap, price_delta_snap::text, qty
       FROM cl.order_line_modifiers WHERE line_id = ANY($1::bigint[]) ORDER BY id`,
    [lines.map((l) => l.id)],
  );
  return { rounds, lines, mods };
}

function lineView(l: LineRow, mods: ModRow[]) {
  const unit = new Decimal(l.unit_price ?? l.unit_price_quoted);
  const gross = unit.plus(l.modifiers_unit_total).times(l.qty);
  // ORDER_STATE_MACHINE.md §3: billable = qty − cancelled (unmade and made); comps stay billable.
  const billable = l.qty - l.qty_cancelled_unprepared - l.qty_cancelled_prepared;
  const net = gross.minus(l.promotion_discount).dividedBy(l.qty).times(billable);
  return {
    id: l.id,
    lineNo: l.line_no,
    variantId: l.variant_id,
    item: l.item_name_snap,
    variant: l.variant_name_snap,
    qty: l.qty,
    notes: l.notes,
    modifiers: mods
      .filter((m) => m.line_id === l.id)
      .map((m) => ({ name: m.name_snap, qty: m.qty, priceDelta: m.price_delta_snap })),
    unitPrice: money.format(unit),
    priceLocked: l.price_locked,
    promotionDiscount: l.promotion_discount,
    lineTotal: money.format(net),
    pickedUp: l.qty_picked_up,
    served: l.qty_served,
    cancelled: l.qty_cancelled_unprepared + l.qty_cancelled_prepared,
    /** Accepted units not yet picked up or cancelled. */
    open: l.qty - l.qty_picked_up - l.qty_cancelled_unprepared,
    /** Picked-up units that can still be voided. */
    voidable: l.qty_picked_up - l.qty_cancelled_prepared,
  };
}

function roundView(r: RoundRow, lines: LineRow[], mods: ModRow[]) {
  return {
    id: r.id,
    roundNo: r.round_no,
    roundRef: r.round_ref,
    source: r.source,
    status: r.status,
    submittedAt: r.submitted_at.toISOString(),
    quotedTotal: r.quoted_total,
    afterBillRequest: r.after_bill_request,
    escalated: r.escalated_at !== null,
    decidedAt: r.decided_at?.toISOString() ?? null,
    reason: r.decision_reason,
    lines: lines.filter((l) => l.round_id === r.id).map((l) => lineView(l, mods)),
  };
}

/** Every round of a session; `guestTokenId` marks the rounds this phone sent. */
export async function sessionRounds(db: Queryable, sessionId: string, guestTokenId?: string) {
  const { rounds, lines, mods } = await loadRounds(db, 'session_id = $1', [sessionId]);
  const views = rounds.map((r) => ({
    ...roundView(r, lines, mods),
    ...(guestTokenId !== undefined ? { mine: r.submitted_by_guest_token_id === guestTokenId } : {}),
  }));
  const accepted = views.filter((r) => r.status === 'accepted');
  const total = accepted
    .flatMap((r) => r.lines)
    .reduce((sum, l) => sum.plus(l.lineTotal), new Decimal(0));
  return { rounds: views, acceptedTotal: money.format(total) };
}

/** Pending rounds the caller may decide, oldest first, with an advisory stock check. */
export async function approvals(
  db: Queryable,
  auth: Pick<AuthContext, 'user' | 'permissions'>,
  now: Date,
) {
  const minutes = await readSetting(db, 'orders.escalation_minutes', z.number().positive());
  const { rounds, lines, mods } = await loadRounds(db, `status = 'pending_approval'`, []);
  const { rows: sessions } = await db.query<{
    id: string;
    session_no: string;
    order_type: OrderType;
    table_id: string | null;
    table_name: string | null;
    assigned_to: string | null;
  }>(
    `SELECT s.id::text, s.session_no, s.order_type, s.table_id::text, t.name AS table_name, a.user_id::text AS assigned_to
       FROM cl.dining_sessions s
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
       LEFT JOIN cl.table_assignments a ON a.table_id = s.table_id AND a.ended_at IS NULL
      WHERE s.id = ANY($1::bigint[])`,
    [[...new Set(rounds.map((r) => r.session_id))]],
  );
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  // Advisory stock: what accepting each round alone would need against what is free now.
  const recipes = await loadActiveRecipes(db, [...new Set(lines.map((l) => l.variant_id))]);
  const rules = recipes.size > 0 ? await loadModifierRules(db, now) : [];
  const { rows: balances } = await db.query<{ item_id: string; name: string; available: string }>(
    `SELECT b.item_id::text, i.name, (b.on_hand - b.reserved)::text AS available
       FROM cl.inventory_balances b JOIN cl.inventory_items i ON i.id = b.item_id`,
  );
  const available = new Map(
    balances.map((b) => [b.item_id, { name: b.name, q: new Decimal(b.available) }]),
  );

  const items = [];
  for (const r of rounds) {
    const s = sessionById.get(r.session_id);
    if (!s) continue;
    const escalated =
      r.escalated_at !== null || now.getTime() - r.submitted_at.getTime() >= minutes * 60_000;
    if (!mayDecide(auth, { orderType: s.order_type, assignedTo: s.assigned_to, escalated }))
      continue;
    const need = new Map<string, Decimal>();
    for (const l of lines.filter((x) => x.round_id === r.id)) {
      const recipe = recipes.get(l.variant_id);
      if (!recipe) continue;
      const options = mods
        .filter((m) => m.line_id === l.id)
        .flatMap((m) => Array.from({ length: m.qty }, () => m.option_id));
      const perUnit = explodeRecipe(
        recipe.components,
        rulesForVariant(rules, l.variant_id),
        s.order_type,
        options,
      );
      for (const [itemId, q] of requirement(perUnit, l.qty))
        need.set(itemId, (need.get(itemId) ?? new Decimal(0)).plus(q));
    }
    const short = [...need].flatMap(([itemId, q]) => {
      const a = available.get(itemId);
      return a && a.q.lessThan(q) ? [a.name] : [];
    });
    items.push({
      ...roundView(r, lines, mods),
      escalated,
      session: {
        id: s.id,
        sessionNo: s.session_no,
        orderType: s.order_type,
        tableId: s.table_id,
        tableName: s.table_name,
      },
      stockShort: short,
    });
  }
  return { items };
}
