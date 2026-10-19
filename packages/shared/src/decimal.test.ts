import { describe, expect, it } from 'vitest';
import { Decimal, DecimalFormatError, money, qty, roundToUnit, unitCost } from './decimal.ts';

describe('money', () => {
  it('parses decimal strings and formats with two places', () => {
    expect(money.format(money.parse('650'))).toBe('650.00');
    expect(money.format(money.parse('1300.5'))).toBe('1300.50');
    expect(money.format(money.parse('-335.00'))).toBe('-335.00');
  });

  it('rounds half up (PT-08)', () => {
    expect(money.format(new Decimal('2.345'))).toBe('2.35');
    expect(money.format(new Decimal('2.344'))).toBe('2.34');
    expect(money.format(new Decimal('-2.345'))).toBe('-2.35');
    expect(money.format(new Decimal('-0.001'))).toBe('0.00');
  });

  it('adds exactly where floating point would not', () => {
    const sum = money.parse('0.10').plus(money.parse('0.20'));
    expect(money.format(sum)).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this module exists
  });

  it('refuses numbers, extra places, separators and junk', () => {
    for (const bad of ['1.234', '1,300.00', 'Rs 650', '', ' 1', '1e3', 'NaN', '01.2.3']) {
      expect(() => money.parse(bad), bad).toThrow(DecimalFormatError);
    }
    expect(() => money.parse(650 as unknown as string)).toThrow(DecimalFormatError);
  });

  it('round-trips format → parse without loss', () => {
    for (const s of ['0.00', '0.01', '999999999999.99', '-12.30']) {
      expect(money.format(money.parse(s))).toBe(s);
    }
  });
});

describe('quantities and unit costs', () => {
  it('keeps four places for quantities', () => {
    expect(qty.format(qty.parse('150'))).toBe('150.0000');
    expect(qty.format(new Decimal('157.49995'))).toBe('157.5000');
    expect(() => qty.parse('1.23456')).toThrow(DecimalFormatError);
  });

  it('keeps eight places for unit costs (COST_VALUATION.md example)', () => {
    const avg = new Decimal('10100').div('38000');
    expect(unitCost.format(avg)).toBe('0.26578947');
    expect(() => unitCost.parse('0.123456789')).toThrow(DecimalFormatError);
  });

  it('computes the WAC issue value of the worked example exactly', () => {
    // 25,000 ml issued from 38,000 ml valued at Rs 10,100 → Rs 6,644.7368 at 4 dp
    const value = qty.round(new Decimal('25000').mul('10100').div('38000'));
    expect(qty.format(value)).toBe('6644.7368');
  });
});

describe('roundToUnit (D-16 cash rounding)', () => {
  it('rounds to the nearest rupee, half up', () => {
    const one = new Decimal(1);
    expect(money.format(roundToUnit(money.parse('3014.50'), one))).toBe('3015.00');
    expect(money.format(roundToUnit(money.parse('3014.49'), one))).toBe('3014.00');
    expect(money.format(roundToUnit(money.parse('3015.00'), one))).toBe('3015.00');
  });

  it('supports other units and rejects non-positive ones', () => {
    expect(money.format(roundToUnit(money.parse('1237.00'), new Decimal(5)))).toBe('1235.00');
    expect(() => roundToUnit(money.parse('1.00'), new Decimal(0))).toThrow(RangeError);
  });
});
