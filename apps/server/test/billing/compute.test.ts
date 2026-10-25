/**
 * Working out a bill (step 3.7): discounts, pro-rata shares (AT-69), Rs 1 rounding
 * (AT-115) and the card-number check on references (AT-42). Pure functions.
 */
import { Decimal } from '@cl/shared';
import { describe, expect, it } from 'vitest';
import {
  allocate,
  computeBill,
  discountPercentOf,
  looksLikeCardNumber,
  type BillLineInput,
  type DiscountInput,
} from '../../src/modules/billing/compute.ts';
import { forEachSeed, propRuns } from '../support/random.ts';

const ONE = new Decimal(1);
const line = (id: string, price: string, qty = 1, extra: Partial<BillLineInput> = {}) => ({
  orderLineId: id,
  description: `Item ${id}`,
  qty,
  billableQty: qty,
  unitPrice: price,
  modifiersUnitTotal: '0.00',
  promotionDiscount: '0.00',
  ...extra,
});

describe('lines and promotions', () => {
  it('bills only the units still billed, with modifiers and the promotion scaled down', () => {
    const bill = computeBill(
      [
        line('1', '500.00', 3, {
          billableQty: 2,
          modifiersUnitTotal: '150.00',
          promotionDiscount: '195.00',
        }),
        line('2', '350.00', 1, { billableQty: 0 }),
      ],
      [],
      ONE,
    );
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]).toMatchObject({
      billableQty: 2,
      gross: '1300.00',
      promotionDiscount: '130.00',
      net: '1170.00',
    });
    expect(bill).toMatchObject({ subtotal: '1170.00', discountTotal: '0.00', total: '1170.00' });
  });
});

describe('manual discounts and comps (D-14, D-21)', () => {
  it('a comp takes the whole line; other discounts on that line take nothing', () => {
    const bill = computeBill(
      [line('1', '500.00'), line('2', '350.00')],
      [
        { id: '10', orderLineId: '1', kind: 'percent', value: '10' },
        { id: '11', orderLineId: '1', kind: 'comp', value: '100' },
      ],
      ONE,
    );
    expect(bill.lines[0]).toMatchObject({ isComp: true, manualDiscount: '500.00', net: '0.00' });
    expect(bill.discounts).toEqual([
      { id: '10', amount: '0.00' },
      { id: '11', amount: '500.00' },
    ]);
    expect(bill.total).toBe('350.00');
  });

  it('a fixed discount never takes a line below zero', () => {
    const bill = computeBill(
      [line('1', '200.00')],
      [{ id: '5', orderLineId: '1', kind: 'fixed', value: '250' }],
      ONE,
    );
    expect(bill.lines[0]?.net).toBe('0.00');
    expect(bill.discounts[0]?.amount).toBe('200.00');
  });

  it('two 10 % discounts on one target count as 20 % against the role limit', () => {
    const discounts: DiscountInput[] = [
      { id: '1', orderLineId: null, kind: 'percent', value: '10' },
      { id: '2', orderLineId: null, kind: 'percent', value: '10' },
    ];
    const bill = computeBill([line('1', '1000.00')], discounts, ONE);
    expect(discountPercentOf(bill, null, ['1', '2']).toString()).toBe('20');
    expect(discountPercentOf(bill, null, ['2']).toString()).toBe('10');
  });
});

describe('bill discounts shared pro-rata (AT-69)', () => {
  it('shares sum exactly to the discount, to the paisa', () => {
    const bill = computeBill(
      [line('1', '100.00'), line('2', '100.00'), line('3', '100.00')],
      [{ id: '1', orderLineId: null, kind: 'fixed', value: '100' }],
      ONE,
    );
    const shares = bill.lines.map((l) => l.discountAlloc);
    expect(shares.sort()).toEqual(['33.33', '33.33', '33.34']);
    expect(bill.discountTotal).toBe('100.00');
    expect(bill.total).toBe('200.00');
  });

  it('property: for any bill, shares add up, no line goes negative, totals reconcile', async () => {
    await forEachSeed(propRuns(200), (random) => {
      const lines = Array.from({ length: random.int(1, 8) }, (_, i) =>
        line(String(i + 1), random.decimal(0, 2000, 2), random.int(1, 4)),
      );
      const discounts: DiscountInput[] = [];
      if (random.chance(0.5)) {
        discounts.push({
          id: '1',
          orderLineId: '1',
          kind: 'percent',
          value: String(random.int(0, 30)),
        });
      }
      discounts.push(
        random.chance(0.5)
          ? { id: '2', orderLineId: null, kind: 'percent', value: random.decimal(0, 100, 2) }
          : { id: '2', orderLineId: null, kind: 'fixed', value: random.decimal(0, 5000, 2) },
      );
      const bill = computeBill(lines, discounts, ONE);
      const billDiscount = new Decimal(bill.discounts.find((d) => d.id === '2')?.amount ?? 0);
      const shares = bill.lines.reduce((s, l) => s.plus(l.discountAlloc), new Decimal(0));
      expect(shares.equals(billDiscount)).toBe(true);
      for (const l of bill.lines) {
        expect(new Decimal(l.net).gte(0)).toBe(true);
        expect(
          new Decimal(l.gross)
            .minus(l.promotionDiscount)
            .minus(l.manualDiscount)
            .minus(l.discountAlloc)
            .equals(l.net),
        ).toBe(true);
      }
      const nets = bill.lines.reduce((s, l) => s.plus(l.net), new Decimal(0));
      expect(nets.plus(bill.roundingAdjustment).equals(bill.total)).toBe(true);
      expect(
        new Decimal(bill.subtotal)
          .minus(bill.discountTotal)
          .plus(bill.roundingAdjustment)
          .equals(bill.total),
      ).toBe(true);
      expect(new Decimal(bill.total).isInteger()).toBe(true);
    });
  });

  it('allocate spreads the leftover paisa to the largest remainders, then the first lines', () => {
    expect(
      allocate(
        new Decimal('0.02'),
        [1, 1, 1].map((n) => new Decimal(n)),
      ).map(String),
    ).toEqual(['0.01', '0.01', '0']);
    expect(() => allocate(new Decimal(5), [new Decimal(4)])).toThrow(RangeError);
  });
});

describe('cash rounding to Rs 1 (D-16, AT-115)', () => {
  it('a % discount leaving paisa rounds half-up with an explicit rounding line', () => {
    const up = computeBill(
      [line('1', '333.00')],
      [{ id: '1', orderLineId: null, kind: 'percent', value: '10' }],
      ONE,
    );
    // 333.00 − 33.30 = 299.70 → 300
    expect(up).toMatchObject({
      discountTotal: '33.30',
      roundingAdjustment: '0.30',
      total: '300.00',
    });
    const down = computeBill(
      [line('1', '333.00')],
      [{ id: '1', orderLineId: null, kind: 'percent', value: '15' }],
      ONE,
    );
    // 333.00 − 49.95 = 283.05 → 283
    expect(down).toMatchObject({ roundingAdjustment: '-0.05', total: '283.00' });
  });
});

describe('references that look like card numbers (AT-42)', () => {
  it('refuses 13–19 digits passing Luhn, with or without spaces and dashes', () => {
    expect(looksLikeCardNumber('4111111111111111')).toBe(true);
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeCardNumber('5500-0000-0000-0004')).toBe(true);
    expect(looksLikeCardNumber('378282246310005')).toBe(true); // 15-digit Amex test number
  });

  it('accepts approval codes, transaction IDs and digit runs that fail Luhn', () => {
    expect(looksLikeCardNumber('123456')).toBe(false);
    expect(looksLikeCardNumber('TX9876543210')).toBe(false);
    expect(looksLikeCardNumber('4111111111111112')).toBe(false);
    expect(looksLikeCardNumber('012345678901')).toBe(false); // 12 digits
  });
});
