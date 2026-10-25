/**
 * Where a guest's order is, as the status timeline shows it (Guest prototype): Sent →
 * Accepted → Being prepared → Served (Ready to collect for takeaway). Derived from the
 * round and its line counters (ORDER_STATE_MACHINE.md §2, §3); never stored.
 */
import type { Round } from '../order/RoundList.tsx';

export interface Progress {
  /** Index of the current step, or -1 when the order stopped (declined, withdrawn, expired). */
  step: number;
  steps: { label: string; detail: string }[];
  headline: string;
}

export function progressOf(round: Round, takeaway: boolean): Progress {
  const steps = [
    { label: 'Sent: waiting for staff', detail: 'Usually under 2 minutes' },
    { label: 'Accepted', detail: 'Your order is confirmed' },
    { label: 'Being prepared', detail: 'The kitchen is making it' },
    takeaway
      ? { label: 'Ready to collect', detail: 'Collect it at the counter' }
      : { label: 'Served', detail: 'Enjoy!' },
  ];
  if (round.status === 'pending_approval') {
    return { step: 0, steps, headline: 'Waiting for staff to confirm' };
  }
  if (round.status !== 'accepted') {
    const headline =
      round.status === 'rejected'
        ? `Not accepted${round.reason ? `: ${round.reason}` : ''}`
        : round.status === 'expired'
          ? 'Cancelled: it was not paid in time'
          : 'Withdrawn';
    return { step: -1, steps, headline };
  }
  const live = round.lines.filter((l) => l.cancelled < l.qty);
  const allPicked = live.length > 0 && live.every((l) => l.open === 0);
  if (!allPicked) return { step: 2, steps, headline: 'Being prepared' };
  const served = live.every((l) => l.served >= l.pickedUp);
  if (takeaway) return { step: 3, steps, headline: 'Ready: collect it at the counter' };
  return served
    ? { step: 3, steps, headline: 'Served. Enjoy!' }
    : { step: 2, steps, headline: 'On its way to your table' };
}
