/**
 * Report periods (FINANCE_REPORTING.md §1; Phase 6 step 6.1). Always business dates
 * (D-22: the business day starts at 04:00); weeks run Monday to Sunday; a comparison is
 * the same weekday(s) a week earlier on the overview, or the period of the same length
 * just before on reports (P6-8).
 */
import { AppError } from '../../platform/errors.ts';

export interface Period {
  from: string;
  to: string;
}

/** The longest range a report runs over (a year and a little, for year-on-year). */
export const MAX_DAYS = 400;

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const d = toDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

/** Days from `from` to `to` inclusive. */
export function lengthOf(p: Period): number {
  return Math.round((toDate(p.to).getTime() - toDate(p.from).getTime()) / 86_400_000) + 1;
}

export function checkPeriod(p: Period): Period {
  if (p.from > p.to)
    throw new AppError('VALIDATION_FAILED', 'The start date is after the end date');
  if (lengthOf(p) > MAX_DAYS) {
    throw new AppError('VALIDATION_FAILED', `A report covers at most ${String(MAX_DAYS)} days`);
  }
  return p;
}

/** Monday to Sunday around a business date. */
export function weekOf(date: string): Period {
  const weekday = (toDate(date).getUTCDay() + 6) % 7; // Monday = 0
  const from = addDays(date, -weekday);
  return { from, to: addDays(from, 6) };
}

export function monthOf(date: string): Period {
  const from = `${date.slice(0, 7)}-01`;
  const next = toDate(from);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from, to: addDays(iso(next), -1) };
}

/** The same weekday(s) one week earlier (the overview's comparison). */
export function sameDaysLastWeek(p: Period): Period {
  return { from: addDays(p.from, -7), to: addDays(p.to, -7) };
}

/** The period of the same length just before (reports' comparison). */
export function previousPeriod(p: Period): Period {
  const n = lengthOf(p);
  return { from: addDays(p.from, -n), to: addDays(p.from, -1) };
}

/** Every business date of the period, in order. */
export function datesOf(p: Period): string[] {
  const out: string[] = [];
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) out.push(d);
  return out;
}
