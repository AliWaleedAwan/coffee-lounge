/**
 * The connection banner (UI_UX.md §8 and the States board) and the health poller that
 * finds out why the server is not answering while the banner shows.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { connection, type ConnectionState } from './store.ts';

export function useConnection(): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.getSnapshot);
}

/** Writes (Accept, Picked up, Lock, Pay, …) are paused until the screen is up to date. */
export function useWritesAllowed(): boolean {
  return useConnection().status === 'online';
}

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export function ConnectionBanner() {
  const state = useConnection();
  if (state.status === 'online') return null;
  const since = state.syncedAt === null ? 'earlier' : timeFormat.format(state.syncedAt);
  switch (state.status) {
    case 'reconnecting':
      return (
        <div role="status" className="banner banner-warning">
          <strong>Reconnecting…</strong> Showing data from {since}. Changes are paused until the
          screen is up to date.
        </div>
      );
    case 'starting':
      return (
        <div role="status" className="banner banner-info">
          <strong>Server starting…</strong> Checking saved data. This usually takes under 3 minutes.
          Nothing you entered before is lost.
          {state.detail ? <span className="banner-detail"> {state.detail}</span> : null}
        </div>
      );
    case 'database_unavailable':
      return (
        <div role="status" className="banner banner-warning">
          <strong>Database not reachable.</strong> Showing data from {since}. Changes are paused and
          the app retries by itself.
        </div>
      );
  }
}

/** While the banner shows, ask the public readiness endpoint every few seconds. */
export function HealthPoller({ intervalMs = 3_000 }: { intervalMs?: number }) {
  const { status } = useConnection();
  useEffect(() => {
    if (status === 'online') return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch('/health/ready', { cache: 'no-store' });
        if (cancelled) return;
        if (res.ok) {
          connection.report({ type: 'api_ok' });
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
        if (body.code === 'SERVER_STARTING') {
          connection.report({ type: 'api_starting', detail: body.detail ?? '' });
        } else if (body.code === 'DATABASE_UNAVAILABLE') {
          connection.report({ type: 'api_database' });
        } else {
          connection.report({ type: 'api_network_error' });
        }
      } catch {
        if (!cancelled) connection.report({ type: 'api_network_error' });
      }
    };
    const timer = setInterval(() => void poll(), intervalMs);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status, intervalMs]);
  return null;
}
