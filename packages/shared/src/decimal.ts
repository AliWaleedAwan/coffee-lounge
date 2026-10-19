/**
 * Exact decimal arithmetic for money and stock (DATABASE.md §1, API.md §2).
 *
 * Values travel as strings ("650.00", "150.0000") and are computed with decimal.js;
 * JavaScript numbers are never used for money, quantities or costs. Rounding is
 * half-up at the precision of each kind.
 */
import { Decimal as DecimalJs } from 'decimal.js';

/** Decimal configured for this project: 40 significant digits, half-up rounding. */
export const Decimal = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;

interface Kind {
  readonly name: string;
  readonly places: number;
  readonly pattern: RegExp;
}

const MONEY: Kind = { name: 'money', places: 2, pattern: /^-?\d{1,12}(\.\d{1,2})?$/ };
const QTY: Kind = { name: 'quantity', places: 4, pattern: /^-?\d{1,14}(\.\d{1,4})?$/ };
const UNIT_COST: Kind = { name: 'unit cost', places: 8, pattern: /^-?\d{1,12}(\.\d{1,8})?$/ };

export class DecimalFormatError extends Error {
  override name = 'DecimalFormatError';
}

function parse(kind: Kind, value: unknown): Decimal {
  if (typeof value !== 'string' || !kind.pattern.test(value)) {
    throw new DecimalFormatError(
      `Invalid ${kind.name} "${String(value)}": expected a decimal string with at most ${kind.places} places`,
    );
  }
  return new Decimal(value);
}

function round(kind: Kind, value: Decimal): Decimal {
  return value.toDecimalPlaces(kind.places, Decimal.ROUND_HALF_UP);
}

function format(kind: Kind, value: Decimal): string {
  const rounded = round(kind, value);
  // Avoid "-0.00" after rounding a tiny negative value.
  return (rounded.isZero() ? new Decimal(0) : rounded).toFixed(kind.places);
}

/** Money in PKR, 2 decimal places. */
export const money = {
  parse: (value: string): Decimal => parse(MONEY, value),
  round: (value: Decimal): Decimal => round(MONEY, value),
  format: (value: Decimal): string => format(MONEY, value),
  zero: (): Decimal => new Decimal(0),
};

/** Stock quantity in base units (g, ml, pcs), 4 decimal places. */
export const qty = {
  parse: (value: string): Decimal => parse(QTY, value),
  round: (value: Decimal): Decimal => round(QTY, value),
  format: (value: Decimal): string => format(QTY, value),
};

/** Cost per base unit, 8 decimal places. */
export const unitCost = {
  parse: (value: string): Decimal => parse(UNIT_COST, value),
  round: (value: Decimal): Decimal => round(UNIT_COST, value),
  format: (value: Decimal): string => format(UNIT_COST, value),
};

/**
 * Cash rounding to the nearest unit (D-16: Rs 1), half-up.
 * Returns the rounded total; the difference is shown as an explicit rounding line.
 */
export function roundToUnit(amount: Decimal, unit: Decimal): Decimal {
  if (unit.lte(0)) throw new RangeError('Rounding unit must be positive');
  return amount.div(unit).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(unit);
}
