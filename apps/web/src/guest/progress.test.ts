import { describe, expect, it } from 'vitest';
import type { Round, RoundLine } from '../order/RoundList.tsx';
import { progressOf } from './progress.ts';

const line = (over: Partial<RoundLine> = {}): RoundLine => ({
  id: '1',
  item: 'Cappuccino',
  variant: 'Regular',
  qty: 2,
  notes: null,
  modifiers: [],
  lineTotal: '1300.00',
  priceLocked: false,
  pickedUp: 0,
  served: 0,
  cancelled: 0,
  open: 2,
  voidable: 0,
  ...over,
});
const round = (
  status: string,
  lines: RoundLine[] = [line()],
  reason: string | null = null,
): Round => ({
  id: '9',
  roundNo: 1,
  roundRef: 'R-1025-001',
  status,
  submittedAt: '2026-10-25T09:00:00Z',
  quotedTotal: '1300.00',
  afterBillRequest: false,
  reason,
  lines,
});

describe('guest order progress', () => {
  it('follows a table order from sent to served', () => {
    expect(progressOf(round('pending_approval'), false)).toMatchObject({
      step: 0,
      headline: 'Waiting for staff to confirm',
    });
    expect(progressOf(round('accepted'), false)).toMatchObject({
      step: 2,
      headline: 'Being prepared',
    });
    expect(
      progressOf(round('accepted', [line({ pickedUp: 1, served: 1, open: 1 })]), false).step,
    ).toBe(2);
    expect(
      progressOf(round('accepted', [line({ pickedUp: 2, served: 0, open: 0 })]), false),
    ).toMatchObject({
      step: 2,
      headline: 'On its way to your table',
    });
    expect(
      progressOf(round('accepted', [line({ pickedUp: 2, served: 2, open: 0 })]), false),
    ).toMatchObject({
      step: 3,
      headline: 'Served. Enjoy!',
    });
  });

  it('a takeaway is ready to collect once picked up; cancelled lines do not hold it back', () => {
    const p = progressOf(
      round('accepted', [
        line({ pickedUp: 2, open: 0 }),
        line({ id: '2', cancelled: 1, qty: 1, open: 0 }),
      ]),
      true,
    );
    expect(p).toMatchObject({ step: 3, headline: 'Ready: collect it at the counter' });
    expect(p.steps[3]?.label).toBe('Ready to collect');
  });

  it('a stopped order says why', () => {
    expect(progressOf(round('rejected', [line()], 'Item just ran out'), false)).toMatchObject({
      step: -1,
      headline: 'Not accepted: Item just ran out',
    });
    expect(progressOf(round('expired'), true).headline).toBe('Cancelled: it was not paid in time');
    expect(progressOf(round('cancelled'), false).headline).toBe('Withdrawn');
  });
});
