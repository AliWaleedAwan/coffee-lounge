/**
 * Shop business date (DECISIONS.md D-22, FINANCE_REPORTING.md §1).
 *
 * The business day runs from the cutoff (e.g. 04:00) to just before the next
 * cutoff, in the shop's time zone, so a sale at 00:30 belongs to the previous
 * date. Must give the same answer as the SQL function `cl.business_date`
 * (DATABASE.md §2); the database integration tests compare the two.
 */

const CUTOFF_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parses "HH:MM" into milliseconds after midnight. */
export function parseCutoff(cutoff: string): number {
  const match = CUTOFF_PATTERN.exec(cutoff);
  if (!match) {
    throw new RangeError(`Business-day cutoff must be "HH:MM" (24 h), got "${cutoff}"`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return (hours * 60 + minutes) * 60_000;
}

/**
 * Returns the business date as "YYYY-MM-DD".
 *
 * @param instant  the moment the event happened (any time zone)
 * @param timeZone IANA zone of the shop, e.g. "Asia/Karachi"
 * @param cutoff   start of the business day in local time, "HH:MM"
 */
export function businessDate(instant: Date, timeZone: string, cutoff: string): string {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError('businessDate: invalid instant');
  }
  const cutoffMs = parseCutoff(cutoff);

  // Local wall-clock fields in the shop's zone (throws RangeError for an unknown zone).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`businessDate: missing ${type} from Intl output`);
    return Number(part.value);
  };

  // Treat the local wall-clock time as if it were UTC, shift back by the cutoff,
  // and read the date. Only the calendar date is used, so DST jumps cannot skew it.
  const localAsUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return new Date(localAsUtc - cutoffMs).toISOString().slice(0, 10);
}
