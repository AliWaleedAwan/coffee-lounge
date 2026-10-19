/**
 * Live update hub (02-architecture §2.8, API.md §7).
 *
 * Reads committed outbox rows and fans them out to SSE subscribers, filtered by what
 * each subscriber may see. Woken by LISTEN/NOTIFY and also polled, so a lost
 * notification or listener connection only delays delivery.
 *
 * Ordering: transactions can commit out of id order (id 10 may commit after id 11).
 * The hub keeps a watermark below which every id is settled; ids above it are
 * delivered as they appear, and a missing id is waited for (gapGraceMs) before it is
 * treated as a rolled-back transaction and skipped.
 *
 * Replay: a reconnecting client sends Last-Event-ID. If that point is still in the
 * outbox the missed events are replayed; otherwise the client is told to resync
 * (reload its views). Hints are never business truth, so resync is always safe.
 */
import type pg from 'pg';
import { OUTBOX_CHANNEL, type OutboxRow } from './outbox.ts';

export interface Subscriber {
  id: string;
  /** Whether this subscriber may receive a topic. */
  canSee(topic: string): boolean;
  /** Writes a raw SSE frame; returns false if the subscriber should be dropped. */
  write(frame: string): boolean;
}

export interface HubOptions {
  pool: pg.Pool;
  /** Opens the dedicated connection used for LISTEN. */
  connectListener: () => Promise<pg.Client>;
  pollMs?: number;
  gapGraceMs?: number;
  maxReplay?: number;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

const SELECT_ROWS = `SELECT id::text, topics, event_type, entity_type, entity_id::text, entity_version, created_at
                       FROM cl.outbox_events`;
const BATCH = 1_000;
const RECENT_LIMIT = 2_000;

export function eventFrame(row: OutboxRow, topics: readonly string[]): string {
  const data = JSON.stringify({
    entity: { type: row.entity_type, id: row.entity_id, version: row.entity_version },
    topics,
    at: row.created_at.toISOString(),
  });
  return `id: ${row.id}\nevent: ${row.event_type}\ndata: ${data}\n\n`;
}

export function controlFrame(event: string, data: Record<string, unknown> = {}): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface SubscriberState {
  subscriber: Subscriber;
  /** True while a replay runs; live rows are held until it finishes. */
  buffering: boolean;
  buffer: OutboxRow[];
  recent: Set<string>;
}

export type SubscribeResult = 'live' | 'replayed' | 'resync';

export class LiveHub {
  private readonly options: Required<Omit<HubOptions, 'onError'>> & Pick<HubOptions, 'onError'>;
  private watermark = 0n;
  private readonly deliveredAbove = new Set<bigint>();
  private readonly missingSince = new Map<bigint, number>();
  private readonly subscribers = new Map<string, SubscriberState>();
  private listener: pg.Client | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private rerun = false;
  private stopped = false;

  constructor(options: HubOptions) {
    this.options = {
      pollMs: 2_000,
      gapGraceMs: 5_000,
      maxReplay: 1_000,
      now: () => Date.now(),
      ...options,
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  async start(): Promise<void> {
    const { rows } = await this.options.pool.query<{ max: string | null }>(
      'SELECT max(id)::text AS max FROM cl.outbox_events',
    );
    this.watermark = BigInt(rows[0]?.max ?? '0');
    await this.connectListener();
    this.pollTimer = setInterval(() => void this.fetch(), this.options.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pollTimer);
    this.subscribers.clear();
    await this.running;
    await this.listener?.end().catch(() => undefined);
  }

  private async connectListener(): Promise<void> {
    try {
      const client = await this.options.connectListener();
      client.on('notification', () => void this.fetch());
      client.on('error', (error) => {
        this.options.onError?.(error, 'listener connection lost; reconnecting');
        this.listener = undefined;
        if (!this.stopped) setTimeout(() => void this.connectListener(), 1_000);
      });
      await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
      this.listener = client;
    } catch (error) {
      // Polling keeps delivering while the listener is down.
      this.options.onError?.(error, 'could not LISTEN; retrying');
      if (!this.stopped) setTimeout(() => void this.connectListener(), 1_000);
    }
  }

  /** Runs one delivery pass (serialised; a request during a pass schedules another). */
  fetch(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.pass();
        } while (this.rerunRequested());
      } catch (error) {
        this.options.onError?.(error, 'outbox fetch failed');
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Read through a method: `pass()` may set the flags while it awaits. */
  private rerunRequested(): boolean {
    return this.rerun && !this.stopped;
  }

  private async pass(): Promise<void> {
    const { rows } = await this.options.pool.query<OutboxRow>(
      `${SELECT_ROWS} WHERE id > $1 ORDER BY id LIMIT ${String(BATCH)}`,
      [this.watermark.toString()],
    );
    const now = this.options.now();
    const present = new Set<bigint>();
    for (const row of rows) {
      const id = BigInt(row.id);
      present.add(id);
      if (this.deliveredAbove.has(id)) continue;
      this.deliveredAbove.add(id);
      this.missingSince.delete(id);
      this.broadcast(row);
    }

    const highest = rows.length > 0 ? BigInt(rows[rows.length - 1]?.id ?? '0') : this.watermark;
    for (let id = this.watermark + 1n; id < highest; id += 1n) {
      if (!present.has(id) && !this.deliveredAbove.has(id) && !this.missingSince.has(id)) {
        this.missingSince.set(id, now);
      }
    }

    for (;;) {
      const next = this.watermark + 1n;
      if (this.deliveredAbove.delete(next)) {
        this.watermark = next;
        continue;
      }
      const since = this.missingSince.get(next);
      if (since !== undefined && now - since >= this.options.gapGraceMs) {
        this.missingSince.delete(next); // never committed: a rolled-back transaction
        this.watermark = next;
        continue;
      }
      break;
    }
    if (rows.length === BATCH) this.rerun = true;
  }

  private broadcast(row: OutboxRow): void {
    for (const state of this.subscribers.values()) {
      if (state.buffering) state.buffer.push(row);
      else this.send(state, row);
    }
  }

  private send(state: SubscriberState, row: OutboxRow): void {
    if (state.recent.has(row.id)) return;
    const topics = row.topics.filter((t) => state.subscriber.canSee(t));
    if (topics.length === 0) return;
    state.recent.add(row.id);
    if (state.recent.size > RECENT_LIMIT) {
      const oldest = state.recent.values().next().value;
      if (oldest !== undefined) state.recent.delete(oldest);
    }
    if (!state.subscriber.write(eventFrame(row, topics))) this.unsubscribe(state.subscriber.id);
  }

  /**
   * Adds a subscriber. With lastEventId, replays what it missed or sends `resync`.
   */
  async subscribe(subscriber: Subscriber, lastEventId?: string): Promise<SubscribeResult> {
    const state: SubscriberState = {
      subscriber,
      buffering: lastEventId !== undefined,
      buffer: [],
      recent: new Set(),
    };
    this.subscribers.set(subscriber.id, state);
    if (lastEventId === undefined) return 'live';

    let result: SubscribeResult;
    try {
      result = await this.replay(state, lastEventId);
    } catch (error) {
      this.options.onError?.(error, 'replay failed');
      result = 'resync';
    }
    if (result === 'resync')
      subscriber.write(controlFrame('resync', { reason: 'reload your views' }));
    for (const row of state.buffer) this.send(state, row);
    state.buffer = [];
    state.buffering = false;
    return result;
  }

  private async replay(state: SubscriberState, lastEventId: string): Promise<SubscribeResult> {
    if (!/^\d{1,19}$/.test(lastEventId)) return 'resync';
    const last = BigInt(lastEventId);
    const { rows: bounds } = await this.options.pool.query<{
      min: string | null;
      max: string | null;
      pending: string;
    }>(
      `SELECT min(id)::text AS min, max(id)::text AS max,
              (SELECT count(*) FROM cl.outbox_events WHERE id > $1)::text AS pending
         FROM cl.outbox_events`,
      [last.toString()],
    );
    const b = bounds[0];
    if (!b?.max || !b.min) return last === 0n ? 'replayed' : 'resync';
    if (last > BigInt(b.max)) return 'resync'; // the database was restored or reset
    if (last < BigInt(b.min) - 1n) return 'resync'; // missed events were already pruned
    if (Number(b.pending) > this.options.maxReplay) return 'resync';

    const { rows } = await this.options.pool.query<OutboxRow>(
      `${SELECT_ROWS} WHERE id > $1 ORDER BY id`,
      [last.toString()],
    );
    for (const row of rows) this.send(state, row);
    return 'replayed';
  }

  unsubscribe(id: string): void {
    this.subscribers.delete(id);
  }
}
