/**
 * Scheduled promotions (D-14, AT-112): percent or fixed off an item or a whole category,
 * limited by dates, days of the week and a time of day, all in the shop's local time.
 * No stacking: each line gets the single promotion that gives the lowest price.
 *
 * Time windows may cross midnight (e.g. 22:00–02:00). Such a window belongs to the day
 * it starts on: at 01:00 on Saturday the Friday-night window is checked against Friday.
 * Prices are rounded half-up to paisa here; the invoice rounds its total (D-16).
 */
import { Decimal, money } from '@cl/shared';

export interface PromotionRule {
  id: string;
  kind: 'percent' | 'fixed';
  /** Percent (0 < v ≤ 100) or rupees off, as a decimal string. */
  value: string;
  /** Local dates "YYYY-MM-DD", inclusive. */
  startsOn: string;
  endsOn: string | null;
  /** ISO weekdays 1 (Monday) … 7 (Sunday); null = every day. */
  daysOfWeek: number[] | null;
  /** Local "HH:MM" or "HH:MM:SS"; both null = all day. */
  timeFrom: string | null;
  timeTo: string | null;
  isActive: boolean;
  itemIds: readonly string[];
  categoryIds: readonly string[];
}

/** A moment in the shop's local time. */
export interface LocalMoment {
  date: string;
  /** ISO weekday 1…7. */
  isoDay: number;
  /** Seconds after local midnight. */
  seconds: number;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localMoment(instant: Date, timeZone: string): LocalMoment {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    date: `${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''}`,
    isoDay: WEEKDAY[parts['weekday'] ?? ''] ?? 0,
    seconds: Number(parts['hour']) * 3600 + Number(parts['minute']) * 60 + Number(parts['second']),
  };
}

function seconds(time: string): number {
  const [h = '0', m = '0', s = '0'] = time.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** The local date one day earlier, and its weekday. */
function previousDay(moment: LocalMoment): { date: string; isoDay: number } {
  const d = new Date(`${moment.date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return {
    date: d.toISOString().slice(0, 10),
    isoDay: moment.isoDay === 1 ? 7 : moment.isoDay - 1,
  };
}

function dayAllowed(rule: PromotionRule, date: string, isoDay: number): boolean {
  if (date < rule.startsOn) return false;
  if (rule.endsOn !== null && date > rule.endsOn) return false;
  return rule.daysOfWeek === null || rule.daysOfWeek.includes(isoDay);
}

export function promotionApplies(rule: PromotionRule, moment: LocalMoment): boolean {
  if (!rule.isActive) return false;
  if (rule.timeFrom === null || rule.timeTo === null) {
    return dayAllowed(rule, moment.date, moment.isoDay);
  }
  const from = seconds(rule.timeFrom);
  const to = seconds(rule.timeTo);
  if (from < to) {
    return (
      moment.seconds >= from && moment.seconds < to && dayAllowed(rule, moment.date, moment.isoDay)
    );
  }
  // Crosses midnight: the evening part belongs to today, the early part to yesterday.
  if (moment.seconds >= from) return dayAllowed(rule, moment.date, moment.isoDay);
  if (moment.seconds < to) {
    const prev = previousDay(moment);
    return dayAllowed(rule, prev.date, prev.isoDay);
  }
  return false;
}

export function discountedPrice(
  price: Decimal,
  rule: Pick<PromotionRule, 'kind' | 'value'>,
): Decimal {
  const value = new Decimal(rule.value);
  if (rule.kind === 'percent') {
    return money.round(price.times(new Decimal(100).minus(value)).dividedBy(100));
  }
  return Decimal.max(new Decimal(0), price.minus(value));
}

export interface AppliedPromotion {
  promotionId: string;
  price: Decimal;
}

/**
 * The single best promotion for one unit of a variant (lowest resulting price; on a tie
 * the lowest promotion id, so the result never depends on query order), or null.
 */
export function bestPromotion(
  price: Decimal,
  target: { itemId: string; categoryId: string },
  rules: readonly PromotionRule[],
  moment: LocalMoment,
): AppliedPromotion | null {
  let best: AppliedPromotion | null = null;
  for (const rule of rules) {
    const targeted =
      rule.itemIds.includes(target.itemId) || rule.categoryIds.includes(target.categoryId);
    if (!targeted || !promotionApplies(rule, moment)) continue;
    const candidate = discountedPrice(price, rule);
    if (candidate.greaterThanOrEqualTo(price)) continue;
    if (
      best === null ||
      candidate.lessThan(best.price) ||
      (candidate.equals(best.price) && BigInt(rule.id) < BigInt(best.promotionId))
    ) {
      best = { promotionId: rule.id, price: candidate };
    }
  }
  return best;
}
