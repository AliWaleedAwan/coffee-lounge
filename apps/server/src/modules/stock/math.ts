/**
 * Stock arithmetic with no database: weighted-average cost (COST_VALUATION.md §3–§5) and
 * the recipe explosion (RECIPE_INVENTORY.md §4.4). Quantities and values are held to
 * 4 decimal places, unit costs to 8, rounding half-up after every multiplication.
 */
import { Decimal, qty, unitCost } from '@cl/shared';

export const round4 = (d: Decimal): Decimal => qty.round(d);
export const round8 = (d: Decimal): Decimal => unitCost.round(d);

export interface Balance {
  /** Q: on hand, base units. */
  onHand: Decimal;
  /** V: stock value, PKR. */
  value: Decimal;
}

/** A = V ÷ Q to 8 dp, or null when nothing is on hand. */
export function averageCost(b: Balance): Decimal | null {
  return b.onHand.isZero() ? null : round8(b.value.dividedBy(b.onHand));
}

/**
 * Value taken out by an issue of q (consumption, waste, negative adjustment). The drain
 * rule: the last units take all remaining value, so no residue is ever left at zero.
 */
export function issueValue(b: Balance, q: Decimal): Decimal {
  if (q.lessThanOrEqualTo(0)) throw new RangeError('issue quantity must be positive');
  if (q.greaterThan(b.onHand)) throw new RangeError('cannot issue more than is on hand');
  return q.equals(b.onHand) ? b.value : round4(q.times(b.value).dividedBy(b.onHand));
}

/**
 * Unit cost for stock that turns up without a purchase (count found more, or a pickup
 * needing more than the book quantity): the average if any stock is on hand, else the
 * last unit cost, else null (a person must enter one).
 */
export function foundStockUnitCost(b: Balance, lastUnitCost: Decimal | null): Decimal | null {
  return averageCost(b) ?? lastUnitCost;
}

// ---------------------------------------------------------------- recipe explosion

export const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export interface RecipeComponent {
  itemId: string;
  qtyBase: string;
  wasteFactor: string;
  forDineIn: boolean;
  forTakeaway: boolean;
  forDelivery: boolean;
}

export interface ModifierRecipeRule {
  optionId: string;
  action: 'add' | 'remove' | 'replace' | 'scale';
  itemId: string;
  replacementItemId: string | null;
  qtyBase: string | null;
  scaleFactor: string | null;
}

export function componentApplies(c: RecipeComponent, orderType: OrderType): boolean {
  return orderType === 'dine_in'
    ? c.forDineIn
    : orderType === 'takeaway'
      ? c.forTakeaway
      : c.forDelivery;
}

/**
 * Quantity of each ingredient for one unit of a line (`qty_per_unit`). Rules must already
 * be the ones in force for this variant. A modifier picked n times adds n times and
 * scales n times; removes and replaces apply once. Order: remove → replace → scale → add,
 * then each component's waste factor, then the sum per ingredient. Zero results are dropped.
 */
export function explodeRecipe(
  components: readonly RecipeComponent[],
  rules: readonly ModifierRecipeRule[],
  orderType: OrderType,
  selectedOptionIds: readonly string[],
): Map<string, Decimal> {
  const times = new Map<string, number>();
  for (const id of selectedOptionIds) times.set(id, (times.get(id) ?? 0) + 1);
  const chosen = (action: ModifierRecipeRule['action']) =>
    rules.filter((r) => r.action === action && times.has(r.optionId));

  let work = components
    .filter((c) => componentApplies(c, orderType))
    .map((c) => ({
      itemId: c.itemId,
      qty: new Decimal(c.qtyBase),
      waste: new Decimal(c.wasteFactor),
    }));

  for (const rule of chosen('remove')) work = work.filter((c) => c.itemId !== rule.itemId);
  for (const rule of chosen('replace')) {
    const to = rule.replacementItemId;
    if (to === null) continue;
    work = work.map((c) => (c.itemId === rule.itemId ? { ...c, itemId: to } : c));
  }
  for (const rule of chosen('scale')) {
    const factor = new Decimal(rule.scaleFactor ?? 1).pow(times.get(rule.optionId) ?? 1);
    work = work.map((c) =>
      c.itemId === rule.itemId ? { ...c, qty: round4(c.qty.times(factor)) } : c,
    );
  }
  for (const rule of chosen('add')) {
    const n = times.get(rule.optionId) ?? 1;
    work.push({
      itemId: rule.itemId,
      qty: round4(new Decimal(rule.qtyBase ?? 0).times(n)),
      waste: new Decimal(0),
    });
  }

  const perUnit = new Map<string, Decimal>();
  for (const c of work) {
    const needed = round4(c.qty.times(new Decimal(1).plus(c.waste)));
    perUnit.set(c.itemId, (perUnit.get(c.itemId) ?? new Decimal(0)).plus(needed));
  }
  for (const [itemId, q] of perUnit) if (q.lessThanOrEqualTo(0)) perUnit.delete(itemId);
  return perUnit;
}

/** Requirement for a line: qty_per_unit × units, per ingredient (4 dp). */
export function requirement(
  perUnit: ReadonlyMap<string, Decimal>,
  units: number,
): Map<string, Decimal> {
  return new Map([...perUnit].map(([itemId, q]) => [itemId, round4(q.times(units))]));
}
