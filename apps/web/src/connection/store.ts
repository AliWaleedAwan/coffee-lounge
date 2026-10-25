/**
 * Connection state behind the banner and the "writes paused" rule (UI_UX.md §8,
 * States board). Two signals feed it: API responses and the live-update stream. Writes
 * are allowed only while both are healthy, so nobody acts on a screen that may be
 * out of date.
 */
export type ConnectionStatus = 'online' | 'reconnecting' | 'starting' | 'database_unavailable';

export type ConnectionEvent =
  | { type: 'api_ok' }
  | { type: 'api_network_error' }
  | { type: 'api_starting'; detail: string }
  | { type: 'api_database' }
  | { type: 'stream_open' }
  | { type: 'stream_lost' }
  /** Signed out: no stream is expected. */
  | { type: 'stream_stopped' };

export interface ConnectionState {
  status: ConnectionStatus;
  /** While not online: when the screen was last known to be up to date (ms epoch). */
  syncedAt: number | null;
  /** Server-provided reason while starting (e.g. the PC clock is wrong). */
  detail: string | null;
}

type ApiHealth = 'ok' | 'network' | 'starting' | 'database';

interface Inner {
  api: ApiHealth;
  /** null when no stream is expected (not signed in). */
  stream: boolean | null;
  syncedAt: number | null;
  detail: string | null;
}

export function statusOf(inner: Pick<Inner, 'api' | 'stream'>): ConnectionStatus {
  if (inner.api === 'starting') return 'starting';
  if (inner.api === 'database') return 'database_unavailable';
  if (inner.api === 'network' || inner.stream === false) return 'reconnecting';
  return 'online';
}

export class ConnectionStore {
  private inner: Inner = { api: 'ok', stream: null, syncedAt: null, detail: null };
  private snapshot: ConnectionState = { status: 'online', syncedAt: null, detail: null };
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ConnectionState => this.snapshot;

  report(event: ConnectionEvent): void {
    const next = { ...this.inner };
    switch (event.type) {
      case 'api_ok':
        next.api = 'ok';
        next.detail = null;
        break;
      case 'api_network_error':
        next.api = 'network';
        break;
      case 'api_starting':
        next.api = 'starting';
        next.detail = event.detail;
        break;
      case 'api_database':
        next.api = 'database';
        break;
      case 'stream_open':
        // The stream needs a valid session, so the server and database answered.
        next.stream = true;
        next.api = 'ok';
        next.detail = null;
        break;
      case 'stream_lost':
        next.stream = false;
        break;
      case 'stream_stopped':
        next.stream = null;
        break;
    }
    const wasOnline = statusOf(this.inner) === 'online';
    const online = statusOf(next) === 'online';
    // The screen was current until the moment the connection was lost.
    if (wasOnline && !online) next.syncedAt = this.now();
    this.inner = next;
    const snapshot: ConnectionState = {
      status: statusOf(next),
      syncedAt: next.syncedAt,
      detail: next.detail,
    };
    if (
      snapshot.status !== this.snapshot.status ||
      snapshot.syncedAt !== this.snapshot.syncedAt ||
      snapshot.detail !== this.snapshot.detail
    ) {
      this.snapshot = snapshot;
      for (const listener of this.listeners) listener();
    }
  }
}

/** The app-wide store (one per browser tab). */
export const connection = new ConnectionStore();
