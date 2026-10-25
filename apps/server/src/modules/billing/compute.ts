/**
 * Working out a bill (ORDER_STATE_MACHINE.md §6 I1/I2; D-14, D-16, D-21). Pure: the same
 * function prices the live bill on every read and the snapshot taken when it is locked.
 *
 *  1. Each line: gross = (unit price + modifiers) × billable units; its promotion discount
 *     scales with the units still billed; base = gross − promotion.
 *  2. Line discounts: a comp takes the whole base (D-21: 100 % discount, the cost stays);
 *     otherwise % of the base or a fixed amount, in the order applied, never below zero.
 *  3. Bill discounts: % of what is left after line discounts, or a fixed amount, then
 *     shared across lines in proportion to what each line still costs, to the paisa,
 *     so the shares add up to the discount exactly (AT-69).
 *  4. Total rounded half-up to the cash rounding unit (Rs 1); the difference is its own
 *     line (AT-115). Tax is always zero (D-16, AT-116).
 */
import { Decimal, money, roundToUnit } from '@cl/shared';

export type DiscountKind = 'percent' | 'fixed' | 'comp';

export interface BillLineInput {
  orderLineId: string;
  description: string;
  /** Units ordered on the line; its promotion discount covers all of them. */
  qty: number;
  billableQty: number;
  unitPrice: string;
  modifiersUnitTotal: string;
  promotionDiscount: string;
}

export interface DiscountInput {
  id: string;
  /** null = the whole bill. */
  orderLineId: string | null;
  kind: DiscountKind;
  value: string;
}

export interface ComputedLine {
  orderLineId: string;
  description: string;
  billableQty: number;
  unitPrice: string;
  modifiersUnitTotal: string;
  gross: string;
  promotionDiscount: string;
  manualDiscount: string;
  discountAlloc: string;
  net: string;
  isComp: boolean;
}

export interface ComputedBill {
  lines: ComputedLine[];
  /** What each discount takes off now (0 when its line is no longer billed). */
  discounts: { id: string; amount: string }[];
  subtotal: string;
  discountTotal: string;
  roundingAdjustment: string;
  total: string;
}

const PAISA = 100;

/** Splits `amount` across `weights` in proportion, in paisa, largest remainders first. */
export function allocate(amount: Decimal, weights: readonly Decimal[]): Decimal[] {
  const total = weights.reduce((s, w) => s.plus(w), new Decimal(0));
  if (amount.isZero() || total.isZero()) return weights.map(() => new Decimal(0));
  if (amount.gt(total)) throw new RangeError('cannot allocate more than the weights add up to');
  const paisa = amount.times(PAISA);
  const exact = weights.map((w) => paisa.times(w).dividedBy(total));
  const shares = exact.map((e) => e.floor());
  let left = paisa.minus(shares.reduce((s, x) => s.plus(x), new Decimal(0))).toNumber();
  const order = exact
    .map((e, i) => ({ i, frac: e.minus(e.floor()) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] = (shares[i] ?? new Decimal(0)).plus(1);
    left -= 1;
  }
  return shares.map((s) => s.dividedBy(PAISA));
}

const byApplication = (a: DiscountInput, b: DiscountInput): number => {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
};

export function computeBill(
  inputs: readonly BillLineInput[],
  discounts: readonly DiscountInput[],
  roundingUnit: Decimal,
): ComputedBill {
  const taken = new Map<string, Decimal>(discounts.map((d) => [d.id, new Decimal(0)]));
  const sorted = [...discounts].sort(byApplication);

  const work = inputs
    .filter((l) => l.billableQty > 0)
    .map((l) => {
      const unit = money.parse(l.unitPrice);
      const mods = money.parse(l.modifiersUnitTotal);
      const gross = unit.plus(mods).times(l.billableQty);
      const promo = Decimal.min(
        gross,
        money.round(money.parse(l.promotionDiscount).times(l.billableQty).dividedBy(l.qty)),
      );
      return {
        input: l,
        gross,
        promo,
        base: gross.minus(promo),
        manual: new Decimal(0),
        comp: false,
      };
    });

  // 2. Line discounts: a comp first (it takes everything), then the rest in order.
  for (const w of work) {
    const mine = sorted.filter((d) => d.orderLineId === w.input.orderLineId);
    const comp = mine.find((d) => d.kind === 'comp');
    if (comp) {
      w.comp = true;
      w.manual = w.base;
      taken.set(comp.id, w.base);
      continue;
    }
    for (const d of mine) {
      const left = w.base.minus(w.manual);
      const want =
        d.kind === 'percent'
          ? money.round(w.base.times(d.value).dividedBy(100))
          : money.parse(d.value);
      const amount = Decimal.min(left, want);
      w.manual = w.manual.plus(amount);
      taken.set(d.id, amount);
    }
  }

  // 3. Bill discounts on what is left, shared pro-rata.
  const afterLines = work.map((w) => w.base.minus(w.manual));
  const billBase = afterLines.reduce((s, x) => s.plus(x), new Decimal(0));
  let billDiscount = new Decimal(0);
  for (const d of sorted.filter((x) => x.orderLineId === null)) {
    const left = billBase.minus(billDiscount);
    const want =
      d.kind === 'percent'
        ? money.round(billBase.times(d.value).dividedBy(100))
        : money.parse(d.value);
    const amount = Decimal.min(left, want);
    billDiscount = billDiscount.plus(amount);
    taken.set(d.id, amount);
  }
  const shares = allocate(billDiscount, afterLines);

  const lines: ComputedLine[] = work.map((w, i) => {
    const alloc = shares[i] ?? new Decimal(0);
    return {
      orderLineId: w.input.orderLineId,
      description: w.input.description,
      billableQty: w.input.billableQty,
      unitPrice: money.format(money.parse(w.input.unitPrice)),
      modifiersUnitTotal: money.format(money.parse(w.input.modifiersUnitTotal)),
      gross: money.format(w.gross),
      promotionDiscount: money.format(w.promo),
      manualDiscount: money.format(w.manual),
      discountAlloc: money.format(alloc),
      net: money.format(w.base.minus(w.manual).minus(alloc)),
      isComp: w.comp,
    };
  });

  const subtotal = work.reduce((s, w) => s.plus(w.base), new Decimal(0));
  const discountTotal = work.reduce((s, w) => s.plus(w.manual), billDiscount);
  const before = subtotal.minus(discountTotal);
  const total = roundToUnit(before, roundingUnit);
  return {
    lines,
    discounts: sorted.map((d) => ({
      id: d.id,
      amount: money.format(taken.get(d.id) ?? new Decimal(0)),
    })),
    subtotal: money.format(subtotal),
    discountTotal: money.format(discountTotal),
    roundingAdjustment: money.format(total.minus(before)),
    total: money.format(total),
  };
}

/**
 * The share of its target a set of discounts takes, in % (D-14 role limits). A line's
 * target is its base; the bill's is what is left after line discounts.
 */
export function discountPercentOf(
  bill: ComputedBill,
  target: string | null,
  discountIds: readonly string[],
): Decimal {
  const amounts = bill.discounts.filter((d) => discountIds.includes(d.id));
  const taken = amounts.reduce((s, d) => s.plus(d.amount), new Decimal(0));
  let base: Decimal;
  if (target === null) {
    base = bill.lines.reduce(
      (s, l) => s.plus(l.gross).minus(l.promotionDiscount).minus(l.manualDiscount),
      new Decimal(0),
    );
  } else {
    const line = bill.lines.find((l) => l.orderLineId === target);
    base = line ? new Decimal(line.gross).minus(line.promotionDiscount) : new Decimal(0);
  }
  if (base.isZero()) return new Decimal(0);
  return taken.times(100).dividedBy(base);
}

/**
 * A payment reference that looks like a card number (13–19 digits, spaces or dashes
 * allowed, passing the Luhn check) is refused: card numbers are never stored (AT-42).
 */
export function looksLikeCardNumber(reference: string): boolean {
  const digits = reference.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
