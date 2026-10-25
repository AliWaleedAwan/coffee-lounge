import { describe, expect, it } from 'vitest';
import { businessDate, parseCutoff } from './business-date.ts';

const KARACHI = 'Asia/Karachi'; // UTC+5, no daylight saving

describe('businessDate (AT-44)', () => {
  it('puts a sale at 00:30 local time on the previous business date', () => {
    // 2026-10-19T19:30Z = 00:30 on 20 Oct in Karachi
    expect(businessDate(new Date('2026-10-19T19:30:00Z'), KARACHI, '04:00')).toBe('2026-10-19');
  });

  it('starts the new business date exactly at the cutoff', () => {
    // 2026-10-19T23:00Z = 04:00 on 20 Oct in Karachi
    expect(businessDate(new Date('2026-10-19T23:00:00Z'), KARACHI, '04:00')).toBe('2026-10-20');
    expect(businessDate(new Date('2026-10-19T22:59:59Z'), KARACHI, '04:00')).toBe('2026-10-19');
  });

  it('uses the local date during the day', () => {
    expect(businessDate(new Date('2026-10-19T09:15:00Z'), KARACHI, '04:00')).toBe('2026-10-19');
  });

  it('equals the calendar date when the cutoff is midnight', () => {
    expect(businessDate(new Date('2026-10-19T19:30:00Z'), KARACHI, '00:00')).toBe('2026-10-20');
  });

  it('handles month and year boundaries', () => {
    // 1 Jan 2027 01:00 in Karachi → still 31 Dec 2026 business day
    expect(businessDate(new Date('2026-12-31T20:00:00Z'), KARACHI, '04:00')).toBe('2026-12-31');
  });

  it('rejects malformed cutoffs and unknown time zones', () => {
    expect(() => businessDate(new Date(), KARACHI, '4:00')).toThrow(RangeError);
    expect(() => businessDate(new Date(), KARACHI, '24:00')).toThrow(RangeError);
    expect(() => businessDate(new Date(), 'Mars/Olympus', '04:00')).toThrow(RangeError);
    expect(() => businessDate(new Date('not a date'), KARACHI, '04:00')).toThrow(RangeError);
  });
});

describe('parseCutoff', () => {
  it('converts HH:MM to milliseconds after midnight', () => {
    expect(parseCutoff('04:00')).toBe(4 * 3_600_000);
    expect(parseCutoff('23:59')).toBe((23 * 60 + 59) * 60_000);
  });
});
