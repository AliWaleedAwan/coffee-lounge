/**
 * Server-side pricing of a submitted round (ORDER_STATE_MACHINE.md §8.1 step 4, API.md §2
 * "Server prices"). Every line is checked and priced here; the client's prices are used
 * only to notice that what the guest saw has changed.
 *
 * Per unit: size price − promotion discount + choice charges. One promotion at most per
 * line, the best one (D-14); choices are never discounted.
 */
import { Decimal, money } from '@cl/shared';
import { AppError } from '../../platform/errors.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import { shopTimeZone } from '../../platform/settings.ts';
import {
  bestPromotion,
  checkModifierSelection,
  describeModifierProblem,
  loadPromotionRules,
  localMoment,
  type ModifierGroupRule,
} from '../catalog/index.ts';
import type { OrderType } from '../stock/index.ts';

export interface LineInput {
  variantId: string;
  qty: number;
  /** Choice option ids; an option listed twice was picked twice. */
  modifierOptionIds: string[];
  notes?: string | undefined;
  /** What the client showed for one unit, choices and promotion included (drift check). */
  quotedUnitPrice?: string | undefined;
}

export interface PricedLine {
  lineNo: number;
  variantId: string;
  itemName: string;
  variantName: string;
  qty: number;
  notes: string | null;
  unitPrice: Decimal;
  promotionId: string | null;
  /** Per unit. */
  promotionDiscount: Decimal;
  modifiers: { optionId: string; name: string; priceDelta: Decimal; qty: number }[];
  modifiersUnitTotal: Decimal;
  /** (unit price − promotion + choices) × qty. */
  lineTotal: Decimal;
}

/** C0 and C1 control characters and the Unicode line and paragraph separators. */
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Notes print on kitchen tickets: control characters become spaces (AT-124). */
export function cleanNotes(notes: string | undefined): string | null {
  if (notes === undefined) return null;
  const cleaned = notes.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length > 120)
    throw new AppError('VALIDATION_FAILED', 'A note can be at most 120 characters');
  return cleaned === '' ? null : cleaned;
}

type Group = ModifierGroupRule & { options: { id: string; isActive: boolean }[] };

interface VariantRow {
  id: string;
  name: string;
  price: string;
  orderable: boolean;
  manual_unavailable: boolean;
  item_id: string;
  item_name: string;
  category_id: string;
  allow_dine_in: boolean;
  allow_takeaway: boolean;
  allow_delivery: boolean;
}

export async function priceLines(
  db: Queryable,
  lines: readonly LineInput[],
  options: { orderType: OrderType; now: Date },
): Promise<{ lines: PricedLine[]; total: Decimal }> {
  if (lines.length === 0) throw new AppError('VALIDATION_FAILED', 'Add at least one item');
  const variantIds = [...new Set(lines.map((l) => l.variantId))];
  const { rows: variants } = await db.query<VariantRow>(
    `SELECT v.id::text, v.name, v.price::text, v.manual_unavailable,
            (v.is_active AND v.archived_at IS NULL AND i.is_active AND i.archived_at IS NULL
             AND c.is_active AND c.archived_at IS NULL) AS orderable,
            i.id::text AS item_id, i.name AS item_name, i.category_id::text,
            i.allow_dine_in, i.allow_takeaway, i.allow_delivery
       FROM cl.menu_variants v JOIN cl.menu_items i ON i.id = v.item_id JOIN cl.menu_categories c ON c.id = i.category_id
      WHERE v.id = ANY($1::bigint[])`,
    [variantIds],
  );
  const byId = new Map(variants.map((v) => [v.id, v]));
  const itemIds = [...new Set(variants.map((v) => v.item_id))];
  const { rows: options_ } = await db.query<{
    item_id: string;
    group_id: string;
    group_name: string;
    min_select: number;
    max_select: number;
    option_id: string | null;
    option_name: string | null;
    price_delta: string | null;
    option_active: boolean | null;
  }>(
    `SELECT l.item_id::text, g.id::text AS group_id, g.name AS group_name, g.min_select, g.max_select,
            o.id::text AS option_id, o.name AS option_name, o.price_delta::text, o.is_active AS option_active
       FROM cl.menu_item_modifier_groups l
       JOIN cl.modifier_groups g ON g.id = l.group_id AND g.is_active
       LEFT JOIN cl.modifier_options o ON o.group_id = g.id
      WHERE l.item_id = ANY($1::bigint[])
      ORDER BY l.sort, g.id, o.sort, o.id`,
    [itemIds],
  );
  const groupsByItem = new Map<string, Map<string, Group>>();
  const optionInfo = new Map<string, { name: string; priceDelta: Decimal }>();
  for (const r of options_) {
    const groups: Map<string, Group> = groupsByItem.get(r.item_id) ?? new Map<string, Group>();
    const group = groups.get(r.group_id) ?? {
      id: r.group_id,
      name: r.group_name,
      minSelect: r.min_select,
      maxSelect: r.max_select,
      options: [],
    };
    if (r.option_id !== null) {
      group.options.push({ id: r.option_id, isActive: r.option_active === true });
      optionInfo.set(r.option_id, {
        name: r.option_name ?? '',
        priceDelta: new Decimal(r.price_delta ?? 0),
      });
    }
    groups.set(r.group_id, group);
    groupsByItem.set(r.item_id, groups);
  }
  const [rules, timeZone] = await Promise.all([loadPromotionRules(db), shopTimeZone(db)]);
  const moment = localMoment(options.now, timeZone);

  const problems: { lineNo: number; problem: string }[] = [];
  const drift: { lineNo: number; unitPrice: string }[] = [];
  const priced: PricedLine[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const v = byId.get(line.variantId);
    if (!v || !v.orderable) {
      problems.push({ lineNo, problem: 'This item is no longer on the menu' });
      continue;
    }
    const allowed =
      options.orderType === 'dine_in'
        ? v.allow_dine_in
        : options.orderType === 'takeaway'
          ? v.allow_takeaway
          : v.allow_delivery;
    if (!allowed) {
      problems.push({
        lineNo,
        problem: `${v.item_name} is not offered for ${options.orderType.replace('_', '-')}`,
      });
      continue;
    }
    if (v.manual_unavailable) {
      problems.push({ lineNo, problem: `${v.item_name} (${v.name}) is unavailable right now` });
      continue;
    }
    const groups = [...(groupsByItem.get(v.item_id)?.values() ?? [])];
    const choiceProblems = checkModifierSelection(groups, line.modifierOptionIds);
    if (choiceProblems.length > 0) {
      for (const p of choiceProblems)
        problems.push({ lineNo, problem: describeModifierProblem(p) });
      continue;
    }
    const counts = new Map<string, number>();
    for (const id of line.modifierOptionIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const modifiers = [...counts].map(([optionId, qty]) => {
      const info = optionInfo.get(optionId);
      return {
        optionId,
        name: info?.name ?? '',
        priceDelta: info?.priceDelta ?? new Decimal(0),
        qty,
      };
    });
    const modifiersUnitTotal = modifiers.reduce(
      (sum, m) => sum.plus(m.priceDelta.times(m.qty)),
      new Decimal(0),
    );
    const unitPrice = new Decimal(v.price);
    const promo = bestPromotion(
      unitPrice,
      { itemId: v.item_id, categoryId: v.category_id },
      rules,
      moment,
    );
    const promotionDiscount = promo ? unitPrice.minus(promo.price) : new Decimal(0);
    const unitTotal = unitPrice.minus(promotionDiscount).plus(modifiersUnitTotal);
    if (
      line.quotedUnitPrice !== undefined &&
      !new Decimal(line.quotedUnitPrice).equals(unitTotal)
    ) {
      drift.push({ lineNo, unitPrice: money.format(unitTotal) });
    }
    priced.push({
      lineNo,
      variantId: v.id,
      itemName: v.item_name,
      variantName: v.name,
      qty: line.qty,
      notes: cleanNotes(line.notes),
      unitPrice,
      promotionId: promo?.promotionId ?? null,
      promotionDiscount,
      modifiers,
      modifiersUnitTotal,
      lineTotal: money.round(unitTotal.times(line.qty)),
    });
  }
  if (problems.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      problems.map((p) => `Line ${String(p.lineNo)}: ${p.problem}`).join('. '),
      {
        lines: problems,
      },
    );
  }
  if (drift.length > 0) {
    throw new AppError('STALE_STATE', 'Some prices changed. Check your order and send it again.', {
      lines: drift,
    });
  }
  return { lines: priced, total: priced.reduce((sum, l) => sum.plus(l.lineTotal), new Decimal(0)) };
}
