import { Decimal } from '@cl/shared';
import { describe, expect, it } from 'vitest';
import {
  explodeRecipe,
  issueValue,
  requirement,
  type RecipeComponent,
} from '../../src/modules/stock/index.ts';
import { averageCost, foundStockUnitCost, round4 } from '../../src/modules/stock/math.ts';
import { forEachSeed, propRuns } from '../support/random.ts';

const d = (v: string | number) => new Decimal(v);

describe('weighted-average costing (COST_VALUATION.md §10 worked example)', () => {
  it('follows the example to the last decimal, including the drain rule and found stock', () => {
    // 1. Receipt 3,000 ml for Rs 805.
    let b = { onHand: d(3000), value: d('805.0000') };
    let last: Decimal | null = d(805).dividedBy(3000).toDecimalPlaces(8);
    expect(averageCost(b)?.toFixed(8)).toBe('0.26833333');

    const take = (q: string) => {
      const v = issueValue(b, d(q));
      last = averageCost(b) ?? last;
      b = { onHand: b.onHand.minus(q), value: b.value.minus(v) };
      return v.toFixed(4);
    };
    expect(take('157.5')).toBe('42.2625'); // 2. consume
    expect(take('157.5')).toBe('42.2625'); // 3. consume
    expect(b.value.toFixed(4)).toBe('720.4750');
    expect(take('85')).toBe('22.8083'); // 4. count variance −85
    expect(b.value.toFixed(4)).toBe('697.6667');
    expect(averageCost(b)?.toFixed(8)).toBe('0.26833335');
    expect(take('2600')).toBe('697.6667'); // 5. waste everything: drain rule
    expect(b).toEqual({ onHand: d(0), value: d(0) });
    expect(averageCost(b)).toBeNull();

    // 6. Count finds 500 ml with nothing on hand: valued at the last unit cost.
    const cost = foundStockUnitCost(b, last);
    expect(cost?.toFixed(8)).toBe('0.26833335');
    expect(round4(d(500).times(cost ?? 0)).toFixed(4)).toBe('134.1667');
  });

  it('refuses to issue more than is on hand, or nothing', () => {
    expect(() => issueValue({ onHand: d(10), value: d(5) }, d(11))).toThrow(RangeError);
    expect(() => issueValue({ onHand: d(10), value: d(5) }, d(0))).toThrow(RangeError);
  });

  it('reaches value 0 exactly whenever quantity reaches 0, and keeps the average within receipt costs (PT-02)', async () => {
    await forEachSeed(propRuns(200), (random) => {
      let b = { onHand: d(0), value: d(0) };
      let minCost = Infinity;
      let maxCost = -Infinity;
      let roundings = 0; // since the balance last stood at zero
      for (let step = 0; step < 40; step++) {
        if (b.onHand.isZero() || random.chance(0.35)) {
          const q = d(random.decimal(0.5, 5000, 4));
          const cost = Number(random.decimal(0.01, 50, 4));
          minCost = Math.min(minCost, cost);
          maxCost = Math.max(maxCost, cost);
          b = { onHand: b.onHand.plus(q), value: b.value.plus(round4(q.times(cost))) };
          roundings += 1;
        } else {
          const q = random.chance(0.2)
            ? b.onHand
            : Decimal.min(b.onHand, d(random.decimal(0.0001, 3000, 4)));
          const v = issueValue(b, q);
          b = { onHand: b.onHand.minus(q), value: b.value.minus(v) };
          roundings += 1;
          expect(b.value.isNegative()).toBe(false);
        }
        if (b.onHand.isZero()) {
          expect(b.value.isZero()).toBe(true);
          roundings = 0;
        } else {
          // Value is held to 4 dp: each receipt or issue since the last zero may move it by
          // up to 0.00005, so the average may drift by that many half-units over Q.
          const slack = (roundings * 0.00005) / b.onHand.toNumber() + 1e-8;
          const avg = b.value.dividedBy(b.onHand).toNumber();
          expect(avg).toBeGreaterThanOrEqual(minCost - slack);
          expect(avg).toBeLessThanOrEqual(maxCost + slack);
        }
      }
    });
  });
});

describe('recipe explosion (RECIPE_INVENTORY.md §4.4)', () => {
  const C = (
    itemId: string,
    qtyBase: string,
    extra: Partial<RecipeComponent> = {},
  ): RecipeComponent => ({
    itemId,
    qtyBase,
    wasteFactor: '0',
    forDineIn: true,
    forTakeaway: true,
    forDelivery: true,
    ...extra,
  });
  const cappuccino = [
    C('beans', '18'),
    C('milk', '150', { wasteFactor: '0.05' }),
    C('cup', '1', { forDineIn: false }),
    C('lid', '1', { forDineIn: false }),
  ];
  const rules = [
    {
      optionId: 'oat',
      action: 'replace' as const,
      itemId: 'milk',
      replacementItemId: 'oatmilk',
      qtyBase: null,
      scaleFactor: null,
    },
    {
      optionId: 'shot',
      action: 'add' as const,
      itemId: 'beans',
      replacementItemId: null,
      qtyBase: '9',
      scaleFactor: null,
    },
    {
      optionId: 'nomilk',
      action: 'remove' as const,
      itemId: 'milk',
      replacementItemId: null,
      qtyBase: null,
      scaleFactor: null,
    },
    {
      optionId: 'big',
      action: 'scale' as const,
      itemId: 'milk',
      replacementItemId: null,
      qtyBase: null,
      scaleFactor: '1.5',
    },
  ];
  const plain = (m: Map<string, Decimal>) =>
    Object.fromEntries([...m].map(([k, v]) => [k, v.toFixed(4)]));

  it('matches the worked example: takeaway, oat milk and an extra shot, two cups', () => {
    const perUnit = explodeRecipe(cappuccino, rules, 'takeaway', ['oat', 'shot']);
    expect(plain(perUnit)).toEqual({
      beans: '27.0000',
      oatmilk: '157.5000',
      cup: '1.0000',
      lid: '1.0000',
    });
    expect(plain(requirement(perUnit, 2))).toEqual({
      beans: '54.0000',
      oatmilk: '315.0000',
      cup: '2.0000',
      lid: '2.0000',
    });
  });

  it('uses only the components for the order type', () => {
    expect(plain(explodeRecipe(cappuccino, rules, 'dine_in', []))).toEqual({
      beans: '18.0000',
      milk: '157.5000',
    });
  });

  it('applies remove before replace, scales n times and adds n times', () => {
    expect(plain(explodeRecipe(cappuccino, rules, 'dine_in', ['nomilk', 'oat']))).toEqual({
      beans: '18.0000',
    });
    expect(
      plain(explodeRecipe(cappuccino, rules, 'dine_in', ['big', 'big', 'shot', 'shot'])),
    ).toEqual({
      beans: '36.0000',
      milk: '354.3750', // 150 × 1.5² = 337.5, then +5 % waste
    });
  });

  it('ignores rules of choices that were not picked', () => {
    expect(plain(explodeRecipe(cappuccino, rules, 'delivery', []))).toEqual({
      beans: '18.0000',
      milk: '157.5000',
      cup: '1.0000',
      lid: '1.0000',
    });
  });
});
