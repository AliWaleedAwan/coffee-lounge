import { Decimal } from '@cl/shared';
import { describe, expect, it } from 'vitest';
import {
  bestPromotion,
  checkModifierSelection,
  localMoment,
  type ModifierGroupRule,
  type PromotionRule,
} from '../../src/modules/catalog/index.ts';
import { discountedPrice, promotionApplies } from '../../src/modules/catalog/promotions.ts';

const KARACHI = 'Asia/Karachi'; // UTC+5, no daylight saving

/** A moment given as Karachi local time. */
const at = (local: string) => localMoment(new Date(`${local}+05:00`), KARACHI);

const rule = (overrides: Partial<PromotionRule>): PromotionRule => ({
  id: '1',
  kind: 'percent',
  value: '10',
  startsOn: '2026-01-01',
  endsOn: null,
  daysOfWeek: null,
  timeFrom: null,
  timeTo: null,
  isActive: true,
  itemIds: ['100'],
  categoryIds: [],
  ...overrides,
});

const latte = { itemId: '100', categoryId: '7' };

describe('local time of the shop', () => {
  it('reads date, ISO weekday and seconds in the shop time zone', () => {
    // 2026-10-23 is a Friday; 19:30Z is 00:30 on Saturday in Karachi.
    expect(localMoment(new Date('2026-10-23T19:30:00Z'), KARACHI)).toEqual({
      date: '2026-10-24',
      isoDay: 6,
      seconds: 30 * 60,
    });
  });
});

describe('promotion engine (AT-112)', () => {
  it('applies the best single promotion when two match, never both', () => {
    const tenPercent = rule({ id: '1', kind: 'percent', value: '10' }); // 450 → 405
    const fiftyOff = rule({ id: '2', kind: 'fixed', value: '50', itemIds: [], categoryIds: ['7'] }); // 400
    const best = bestPromotion(
      new Decimal(450),
      latte,
      [tenPercent, fiftyOff],
      at('2026-10-21T12:00:00'),
    );
    expect(best).toEqual({ promotionId: '2', price: new Decimal(400) });
  });

  it('breaks a tie by the lowest promotion id, whatever the order', () => {
    const a = rule({ id: '9', kind: 'fixed', value: '50' });
    const b = rule({ id: '4', kind: 'percent', value: '10' }); // 500 → 450 as well
    const moment = at('2026-10-21T12:00:00');
    expect(bestPromotion(new Decimal(500), latte, [a, b], moment)?.promotionId).toBe('4');
    expect(bestPromotion(new Decimal(500), latte, [b, a], moment)?.promotionId).toBe('4');
  });

  it('applies nothing outside the day and time window', () => {
    const happyHour = rule({ daysOfWeek: [1, 2, 3, 4, 5], timeFrom: '15:00', timeTo: '18:00' });
    expect(promotionApplies(happyHour, at('2026-10-21T15:00:00'))).toBe(true); // Wed, start
    expect(promotionApplies(happyHour, at('2026-10-21T17:59:59'))).toBe(true);
    expect(promotionApplies(happyHour, at('2026-10-21T18:00:00'))).toBe(false); // end is exclusive
    expect(promotionApplies(happyHour, at('2026-10-21T14:59:59'))).toBe(false);
    expect(promotionApplies(happyHour, at('2026-10-24T16:00:00'))).toBe(false); // Saturday
    expect(
      bestPromotion(new Decimal(450), latte, [happyHour], at('2026-10-24T16:00:00')),
    ).toBeNull();
  });

  it('gives a window that crosses midnight to the day it starts on', () => {
    const fridayNight = rule({ daysOfWeek: [5], timeFrom: '22:00', timeTo: '02:00' });
    expect(promotionApplies(fridayNight, at('2026-10-23T23:30:00'))).toBe(true); // Fri night
    expect(promotionApplies(fridayNight, at('2026-10-24T01:30:00'))).toBe(true); // Sat early = Fri's
    expect(promotionApplies(fridayNight, at('2026-10-24T02:00:00'))).toBe(false);
    expect(promotionApplies(fridayNight, at('2026-10-24T23:30:00'))).toBe(false); // Sat night
    expect(promotionApplies(fridayNight, at('2026-10-23T01:30:00'))).toBe(false); // Thu's night
  });

  it('respects start and end dates, inclusive, and the active switch', () => {
    const october = rule({ startsOn: '2026-10-01', endsOn: '2026-10-31' });
    expect(promotionApplies(october, at('2026-10-01T00:00:00'))).toBe(true);
    expect(promotionApplies(october, at('2026-10-31T23:59:59'))).toBe(true);
    expect(promotionApplies(october, at('2026-11-01T00:00:00'))).toBe(false);
    expect(promotionApplies(october, at('2026-09-30T23:59:59'))).toBe(false);
    expect(promotionApplies({ ...october, isActive: false }, at('2026-10-15T12:00:00'))).toBe(
      false,
    );
  });

  it('only touches targeted items or categories', () => {
    const other = rule({ itemIds: ['200'], categoryIds: ['8'] });
    expect(bestPromotion(new Decimal(450), latte, [other], at('2026-10-21T12:00:00'))).toBeNull();
  });

  it('rounds percentages half-up to paisa and never goes below zero', () => {
    expect(discountedPrice(new Decimal(335), { kind: 'percent', value: '15' }).toFixed(2)).toBe(
      '284.75',
    );
    expect(discountedPrice(new Decimal(99), { kind: 'percent', value: '12.5' }).toFixed(2)).toBe(
      '86.63',
    );
    expect(discountedPrice(new Decimal(40), { kind: 'fixed', value: '50' }).toFixed(2)).toBe(
      '0.00',
    );
  });
});

describe('modifier choices (AT-113)', () => {
  const milk: ModifierGroupRule = {
    id: '1',
    name: 'Milk',
    minSelect: 1,
    maxSelect: 1,
    options: [
      { id: '11', isActive: true },
      { id: '12', isActive: true },
      { id: '13', isActive: false },
    ],
  };
  const extras: ModifierGroupRule = {
    id: '2',
    name: 'Extras',
    minSelect: 0,
    maxSelect: 2,
    options: [
      { id: '21', isActive: true },
      { id: '22', isActive: true },
      { id: '23', isActive: true },
    ],
  };

  it('accepts a valid choice', () => {
    expect(checkModifierSelection([milk, extras], ['11', '21', '22'])).toEqual([]);
  });

  it('refuses two milk choices and a missing required choice', () => {
    expect(checkModifierSelection([milk], ['11', '12'])).toEqual([
      { kind: 'too_many', groupId: '1', group: 'Milk', max: 1 },
    ]);
    expect(checkModifierSelection([milk, extras], ['21'])).toEqual([
      { kind: 'too_few', groupId: '1', group: 'Milk', min: 1 },
    ]);
    expect(checkModifierSelection([milk, extras], ['11', '21', '22', '23'])).toContainEqual({
      kind: 'too_many',
      groupId: '2',
      group: 'Extras',
      max: 2,
    });
  });

  it('refuses choices from elsewhere, withdrawn choices and repeats', () => {
    expect(checkModifierSelection([milk], ['99'])).toContainEqual({
      kind: 'unknown_option',
      optionId: '99',
    });
    expect(checkModifierSelection([milk], ['13'])).toEqual([
      { kind: 'inactive_option', optionId: '13' },
    ]);
    expect(checkModifierSelection([extras], ['21', '21'])).toEqual([
      { kind: 'duplicate_option', optionId: '21' },
    ]);
  });
});
