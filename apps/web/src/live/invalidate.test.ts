import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidateAll, invalidateForHint, matchesTopics } from './invalidate.ts';

describe('hint → refetch', () => {
  it('matches exact topics and topic families', () => {
    expect(matchesTopics(['floor'], ['floor'])).toBe(true);
    expect(matchesTopics(['table'], ['approvals', 'table:5'])).toBe(true);
    expect(matchesTopics(['table:5'], ['table:5'])).toBe(true);
    expect(matchesTopics(['table:5'], ['table:6'])).toBe(false);
    expect(matchesTopics(['table:5'], ['table'])).toBe(false);
    expect(matchesTopics(['session'], ['sessions'])).toBe(false);
    expect(matchesTopics([], ['floor'])).toBe(false);
  });

  it('invalidates only the queries that depend on the hinted topics', async () => {
    const client = new QueryClient();
    const make = (key: string, topics?: string[]) =>
      client.getQueryCache().build(client, {
        queryKey: [key],
        queryFn: () => key,
        ...(topics ? { meta: { topics } } : {}),
      });
    const floor = make('floor', ['floor']);
    const table5 = make('t5', ['table:5']);
    const devices = make('devices');
    for (const q of [floor, table5, devices]) q.setData('x');

    await invalidateForHint(client, ['table:5', 'approvals']);
    expect([
      floor.state.isInvalidated,
      table5.state.isInvalidated,
      devices.state.isInvalidated,
    ]).toEqual([false, true, false]);

    await invalidateAll(client);
    expect([floor, table5, devices].every((q) => q.state.isInvalidated)).toBe(true);
  });
});
