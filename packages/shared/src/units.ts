/**
 * Units of measure (RECIPE_INVENTORY.md §1). Every item is kept in one base unit, g, ml
 * or pcs; kg ↔ g and l ↔ ml convert by 1000; mass and volume never convert into each
 * other, and count has no other unit. Quantities are rounded half-up to 4 dp after every
 * multiplication. The same table is seeded in `cl.uoms` (a test keeps them equal).
 */
import { Decimal, qty, unitCost } from './decimal.ts';

export const BASE_UNITS = ['g', 'ml', 'pcs'] as const;
export type BaseUnit = (typeof BASE_UNITS)[number];
export const UNIT_CODES = ['g', 'kg', 'ml', 'l', 'pcs'] as const;
export type UnitCode = (typeof UNIT_CODES)[number];
export type Dimension = 'mass' | 'volume' | 'count';

export const UNITS: Readonly<
  Record<UnitCode, { dimension: Dimension; base: BaseUnit; factor: number }>
> = {
  g: { dimension: 'mass', base: 'g', factor: 1 },
  kg: { dimension: 'mass', base: 'g', factor: 1000 },
  ml: { dimension: 'volume', base: 'ml', factor: 1 },
  l: { dimension: 'volume', base: 'ml', factor: 1000 },
  pcs: { dimension: 'count', base: 'pcs', factor: 1 },
};

export function isUnitCode(value: string): value is UnitCode {
  return Object.hasOwn(UNITS, value);
}

/** Thrown for a conversion the rules forbid, e.g. g → ml (AT-32). */
export class UnitConversionError extends Error {
  override name = 'UnitConversionError';
}

/** The units an item kept in `base` may be entered in. */
export function unitsFor(base: BaseUnit): UnitCode[] {
  return UNIT_CODES.filter((code) => UNITS[code].base === base);
}

/** Converts `value` from one unit to another of the same dimension, to 4 dp. */
export function convertQty(value: Decimal, from: UnitCode, to: UnitCode): Decimal {
  const a = UNITS[from];
  const b = UNITS[to];
  if (a.dimension !== b.dimension) {
    throw new UnitConversionError(
      `${from} cannot be converted to ${to}: ${a.dimension} and ${b.dimension} do not convert`,
    );
  }
  return qty.round(value.times(a.factor).dividedBy(b.factor));
}

/** Packs → base quantity: `6 × 1000 ml = 6000 ml`, to 4 dp. */
export function packsToBase(packs: Decimal, packQtyBase: Decimal): Decimal {
  return qty.round(packs.times(packQtyBase));
}

/** Cost per base unit of a purchase line: line cost ÷ base quantity, to 8 dp. */
export function unitCostOf(lineCost: Decimal, qtyBase: Decimal): Decimal {
  if (qtyBase.lessThanOrEqualTo(0)) throw new RangeError('base quantity must be positive');
  return unitCost.round(lineCost.dividedBy(qtyBase));
}
