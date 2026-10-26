/**
 * Units of measure (RECIPE_INVENTORY.md §1): AT-31 (packs → base quantity exactly; unit
 * cost to 8 dp), AT-32 (no conversion across dimensions), PT-04 (kg ↔ g and l ↔ ml
 * round-trip exactly; cross-dimension always refused). The shared table matches cl.uoms.
 * CL_PROP_RUNS / CL_PROP_SEED as in test/support/random.ts.
 */
import {
  Decimal,
  UNIT_CODES,
  UNITS,
  UnitConversionError,
  convertQty,
  packsToBase,
  unitCostOf,
  unitsFor,
} from '@cl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformFixture, type PlatformFixture } from '../support/platform.ts';
import { forEachSeed, propRuns } from '../support/random.ts';

const d = (v: string) => new Decimal(v);

describe('units (RECIPE_INVENTORY.md §1)', () => {
  it('turns 6 × 1 L into 6,000 ml exactly, and the line cost into a unit cost to 8 dp (AT-31)', () => {
    const carton = convertQty(d('1'), 'l', 'ml');
    expect(carton.toFixed(4)).toBe('1000.0000');
    const base = packsToBase(d('6'), carton);
    expect(base.toFixed(4)).toBe('6000.0000');
    expect(unitCostOf(d('1650'), base).toFixed(8)).toBe('0.27500000');
    expect(unitCostOf(d('1000'), base).toFixed(8)).toBe('0.16666667');
    expect(unitCostOf(d('2000'), d('3')).toFixed(8)).toBe('666.66666667');
    expect(() => unitCostOf(d('10'), d('0'))).toThrow(RangeError);
    expect(packsToBase(d('2.5'), d('0.3333')).toFixed(4)).toBe('0.8333'); // half-up
  });

  it('refuses mass ↔ volume and anything to or from count (AT-32)', () => {
    expect(() => convertQty(d('1'), 'g', 'ml')).toThrow(UnitConversionError);
    expect(() => convertQty(d('1'), 'l', 'kg')).toThrow(/mass and volume|volume and mass/);
    expect(() => convertQty(d('1'), 'pcs', 'g')).toThrow(UnitConversionError);
    expect(unitsFor('ml')).toEqual(['ml', 'l']);
    expect(unitsFor('g')).toEqual(['g', 'kg']);
    expect(unitsFor('pcs')).toEqual(['pcs']);
  });

  it('round-trips kg ↔ g and l ↔ ml exactly; every cross-dimension pair is refused (PT-04)', async () => {
    await forEachSeed(propRuns(200), (random) => {
      for (let i = 0; i < 50; i += 1) {
        // Large units at up to 1 dp keep the base value within 4 dp, so nothing is rounded.
        const big = d(random.decimal(0, 1_000_000, random.int(0, 1)));
        for (const [large, small] of [
          ['kg', 'g'],
          ['l', 'ml'],
        ] as const) {
          const down = convertQty(big, large, small);
          expect(down.equals(big.times(1000))).toBe(true);
          expect(convertQty(down, small, large).equals(big)).toBe(true);
        }
        // Base values at 4 dp: base → large → base is exact whenever the large value has
        // no more than 4 dp, i.e. when the base value is a multiple of 0.1.
        const base = d(random.decimal(0, 10_000_000, 1));
        expect(convertQty(convertQty(base, 'g', 'kg'), 'kg', 'g').equals(base)).toBe(true);
        expect(convertQty(convertQty(base, 'ml', 'l'), 'l', 'ml').equals(base)).toBe(true);
        // Same-unit conversion is the identity at 4 dp.
        const any = d(random.decimal(0, 1_000_000, 4));
        const unit = random.pick(UNIT_CODES);
        expect(convertQty(any, unit, unit).equals(any)).toBe(true);
        // Across dimensions: always refused, whatever the value.
        const from = random.pick(UNIT_CODES);
        const to = random.pick(
          UNIT_CODES.filter((u) => UNITS[u].dimension !== UNITS[from].dimension),
        );
        expect(() => convertQty(any, from, to)).toThrow(UnitConversionError);
      }
    });
  });
});

describe('the unit table matches the database', () => {
  let fx: PlatformFixture;
  beforeAll(async () => {
    fx = await platformFixture(2);
  });
  afterAll(async () => {
    await fx.close();
  });

  it('has the same codes, dimensions, bases and factors as cl.uoms', async () => {
    const { rows } = await fx.pool.query<{
      code: string;
      dimension: string;
      base_code: string;
      factor: string;
    }>(
      'SELECT code, dimension, base_code, factor_to_base::text AS factor FROM cl.uoms ORDER BY code',
    );
    expect(rows.map((r) => [r.code, r.dimension, r.base_code, Number(r.factor)])).toEqual(
      [...UNIT_CODES]
        .sort()
        .map((code) => [code, UNITS[code].dimension, UNITS[code].base, UNITS[code].factor]),
    );
  });
});
