import { describe, expect, it } from 'vitest';
import { ConnectionStore, statusOf } from './store.ts';

describe('connection status', () => {
  it('ranks server starting over database down over plain reconnecting', () => {
    expect(statusOf({ api: 'ok', stream: null })).toBe('online');
    expect(statusOf({ api: 'ok', stream: true })).toBe('online');
    expect(statusOf({ api: 'ok', stream: false })).toBe('reconnecting');
    expect(statusOf({ api: 'network', stream: true })).toBe('reconnecting');
    expect(statusOf({ api: 'database', stream: false })).toBe('database_unavailable');
    expect(statusOf({ api: 'starting', stream: false })).toBe('starting');
  });

  it('records when the screen went stale and recovers when the stream reopens', () => {
    let now = 1_000;
    const store = new ConnectionStore(() => now);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.report({ type: 'stream_open' });
    expect(store.getSnapshot()).toEqual({ status: 'online', syncedAt: null, detail: null });

    now = 5_000;
    store.report({ type: 'stream_lost' });
    expect(store.getSnapshot()).toEqual({ status: 'reconnecting', syncedAt: 5_000, detail: null });

    now = 9_000;
    store.report({ type: 'api_starting', detail: 'PC clock is wrong' });
    expect(store.getSnapshot()).toEqual({
      status: 'starting',
      syncedAt: 5_000, // still the moment the data stopped being current
      detail: 'PC clock is wrong',
    });

    store.report({ type: 'api_ok' }); // health answers again, stream still down
    expect(store.getSnapshot().status).toBe('reconnecting');
    store.report({ type: 'stream_open' });
    expect(store.getSnapshot().status).toBe('online');
    expect(notified).toBe(4);
  });

  it('does not notify listeners when nothing visible changed', () => {
    const store = new ConnectionStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.report({ type: 'api_ok' });
    store.report({ type: 'stream_stopped' });
    expect(notified).toBe(0);
  });

  it('treats signed-out screens as online unless the API itself fails', () => {
    const store = new ConnectionStore();
    store.report({ type: 'stream_stopped' });
    expect(store.getSnapshot().status).toBe('online');
    store.report({ type: 'api_database' });
    expect(store.getSnapshot().status).toBe('database_unavailable');
  });
});
