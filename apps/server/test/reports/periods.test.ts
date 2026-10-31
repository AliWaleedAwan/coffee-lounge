/** Report periods (FINANCE_REPORTING.md §1, P6-8): weeks Monday to Sunday, comparisons, limits. */
import { describe, expect, it } from 'vitest';
import {
  checkPeriod,
  datesOf,
  lengthOf,
  monthOf,
  previousPeriod,
  sameDaysLastWeek,
  weekOf,
} from '../../src/modules/reports/periods.ts';

describe('report periods', () => {
  it('weeks run Monday to Sunday, months to their last day', () => {
    expect(weekOf('2026-10-27')).toEqual({ from: '2026-10-26', to: '2026-11-01' }); // a Tuesday
    expect(weekOf('2026-11-01')).toEqual({ from: '2026-10-26', to: '2026-11-01' }); // the Sunday
    expect(monthOf('2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthOf('2028-02-14')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthOf('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('compares with the same weekdays last week, or the period of the same length before', () => {
    expect(sameDaysLastWeek({ from: '2026-10-27', to: '2026-10-27' })).toEqual({
      from: '2026-10-20',
      to: '2026-10-20',
    });
    expect(previousPeriod({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    });
    expect(lengthOf({ from: '2026-10-01', to: '2026-10-31' })).toBe(31);
    expect(datesOf({ from: '2026-12-30', to: '2027-01-02' })).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('refuses a reversed or too long period', () => {
    expect(() => checkPeriod({ from: '2026-10-02', to: '2026-10-01' })).toThrow(/after the end/);
    expect(() => checkPeriod({ from: '2025-01-01', to: '2026-10-01' })).toThrow(/at most 400 days/);
    expect(checkPeriod({ from: '2025-10-01', to: '2026-10-01' })).toEqual({
      from: '2025-10-01',
      to: '2026-10-01',
    });
  });
});
