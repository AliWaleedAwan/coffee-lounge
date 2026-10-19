/**
 * Live-update client (API.md §7): one stream per tab, read with fetch. Reconnects with
 * Last-Event-ID so the server can replay what was missed (or send `resync`); a refused
 * stream (401/403) means the session or device is no longer valid.
 */
import { SseParser, type SseMessage } from './sse.ts';

export interface LiveHint {
  id: string;
  event: string;
  topics: string[];
  entity: { type: string; id: string; version: number | null } | null;
}

export interface LiveClientOptions {
  url: string;
  /** A hint arrived (already parsed). */
  onHint: (hint: LiveHint) => void;
  /** Every view must refetch: server asked for a resync, or the stream came back after a gap. */
  onResync: () => void;
  onOpen: () => void;
  onLost: () => void;
  /** The server ended the stream for good (session ended, device revoked). */
  onRefused: (status: number) => void;
  fetchImpl?: typeof fetch;
  /** Base reconnection delay; the server's `retry:` replaces it. */
  retryMs?: number;
  maxRetryMs?: number;
  random?: () => number;
}

function parseHint(message: SseMessage): LiveHint | null {
  try {
    const data = JSON.parse(message.data) as {
      topics?: unknown;
      entity?: { type?: unknown; id?: unknown; version?: unknown } | null;
    };
    const topics = Array.isArray(data.topics)
      ? data.topics.filter((t): t is string => typeof t === 'string')
      : [];
    const e = data.entity;
    const entity =
      e && typeof e.type === 'string' && typeof e.id === 'string'
        ? { type: e.type, id: e.id, version: typeof e.version === 'number' ? e.version : null }
        : null;
    return { id: message.lastEventId, event: message.event, topics, entity };
  } catch {
    return null;
  }
}

export class LiveClient {
  private readonly options: Required<Omit<LiveClientOptions, 'fetchImpl'>> & {
    fetchImpl: typeof fetch;
  };
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastEventId = '';
  private failures = 0;
  private serverRetryMs: number | null = null;
  private stopped = true;
  private everOpened = false;

  constructor(options: LiveClientOptions) {
    this.options = {
      retryMs: 3_000,
      maxRetryMs: 30_000,
      random: Math.random,
      fetchImpl: (input, init) => fetch(input, init),
      ...options,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = undefined;
  }

  private async connect(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const parser = new SseParser();
    parser.lastEventId = this.lastEventId;
    let opened = false;
    try {
      // Holding a stream open is not user activity (the session idle timer keeps running).
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        'x-cl-background': '1',
      };
      if (this.lastEventId) headers['last-event-id'] = this.lastEventId;
      const res = await this.options.fetchImpl(this.options.url, {
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        this.stopped = true;
        this.options.onRefused(res.status);
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream answered ${res.status}`);

      opened = true;
      // After a gap (a drop, or failed first attempts while views were already loaded)
      // changes may have been missed; refetching is always safe (hints only).
      const afterGap = this.everOpened || this.failures > 0;
      this.failures = 0;
      this.options.onOpen();
      if (afterGap) this.options.onResync();
      this.everOpened = true;

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of parser.push(value)) this.handle(message);
        this.lastEventId = parser.lastEventId;
        if (parser.retryMs !== null) this.serverRetryMs = parser.retryMs;
      }
      if (parser.lastEventId) this.lastEventId = parser.lastEventId;
    } catch {
      // network error, abort, or a bad status: reconnect below unless stopped
    }
    if (this.stopped || controller.signal.aborted) return;
    if (opened || this.failures === 0) this.options.onLost();
    this.failures += 1;
    this.timer = setTimeout(() => void this.connect(), this.delay());
  }

  private handle(message: SseMessage): void {
    if (message.event === 'resync') {
      this.options.onResync();
      return;
    }
    if (message.event === 'session_ended') {
      this.stop();
      this.options.onRefused(401);
      return;
    }
    const hint = parseHint(message);
    if (hint) this.options.onHint(hint);
  }

  /** Base delay doubled per consecutive failure, capped, with ±20 % jitter. */
  private delay(): number {
    const base = this.serverRetryMs ?? this.options.retryMs;
    const exp = Math.min(base * 2 ** Math.max(0, this.failures - 1), this.options.maxRetryMs);
    return Math.round(exp * (0.8 + this.options.random() * 0.4));
  }
}
