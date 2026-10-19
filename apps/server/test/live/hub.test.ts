import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LiveHub, type Subscriber } from '../../src/platform/live-hub.ts';
import { publish, type OutboxEvent } from '../../src/platform/outbox.ts';
import { urlFor } from '../support/db.ts';
import { platformFixture, type PlatformFixture } from '../support/platform.ts';

let fx: PlatformFixture;
let hub: LiveHub;
const GRACE_MS = 300;

beforeAll(async () => {
  fx = await platformFixture(10);
});
afterAll(async () => {
  await fx.close();
});

async function startHub(options: { maxReplay?: number } = {}): Promise<LiveHub> {
  hub = new LiveHub({
    pool: fx.pool,
    connectListener: async () => {
      const client = new pg.Client({ connectionString: urlFor(fx.db.name) });
      await client.connect();
      return client;
    },
    pollMs: 50,
    gapGraceMs: GRACE_MS,
    ...options,
  });
  await hub.start();
  return hub;
}
afterEach(async () => {
  await hub.stop();
});

interface Collector extends Subscriber {
  frames: string[];
  ids(): string[];
}

function collector(canSee: (topic: string) => boolean = () => true): Collector {
  const frames: string[] = [];
  return {
    id: randomUUID(),
    canSee,
    write(frame) {
      frames.push(frame);
      return true;
    },
    frames,
    ids: () => frames.flatMap((f) => /^id: (\d+)$/m.exec(f)?.[1] ?? []),
  };
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const event = (overrides: Partial<OutboxEvent> = {}): OutboxEvent => ({
  type: 'round.decided',
  entityType: 'round',
  entityId: '812',
  version: 3,
  topics: ['approvals', 'kitchen'],
  ...overrides,
});

async function publishCommitted(e = event()): Promise<string> {
  const client = await fx.pool.connect();
  try {
    await client.query('BEGIN');
    const id = await publish(client, e);
    await client.query('COMMIT');
    return id;
  } finally {
    client.release();
  }
}

describe('live hub delivery (AT-73, topic filtering part)', () => {
  it('delivers committed hints with only the topics the subscriber may see', async () => {
    await startHub();
    const kitchenOnly = collector((t) => t === 'kitchen');
    await hub.subscribe(kitchenOnly);
    const id = await publishCommitted();
    await until(() => kitchenOnly.ids().includes(id));
    const frame = kitchenOnly.frames.find((f) => f.includes(`id: ${id}`)) ?? '';
    expect(frame).toMatch(/^event: round\.decided$/m);
    const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? '{}') as {
      topics: string[];
      entity: unknown;
    };
    expect(data.topics).toEqual(['kitchen']);
    expect(data.entity).toEqual({ type: 'round', id: '812', version: 3 });
  });

  it('never delivers a hint whose transaction rolled back, nor topics nobody may see', async () => {
    await startHub();
    const sub = collector((t) => t === 'kitchen');
    await hub.subscribe(sub);
    const client = await fx.pool.connect();
    try {
      await client.query('BEGIN');
      await publish(client, event());
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const printersOnly = await publishCommitted(event({ topics: ['printers'] }));
    const marker = await publishCommitted(event({ topics: ['kitchen'], entityId: '999' }));
    await until(() => sub.ids().includes(marker));
    expect(sub.ids()).toEqual([marker]);
    expect(sub.ids()).not.toContain(printersOnly);
  });

  it('delivers both events exactly once when they commit out of id order', async () => {
    await startHub();
    const sub = collector();
    await hub.subscribe(sub);
    const slow = await fx.pool.connect();
    let earlyId: string, lateId: string;
    try {
      await slow.query('BEGIN');
      earlyId = await publish(slow, event({ entityId: '1' })); // lower id, commits later
      lateId = await publishCommitted(event({ entityId: '2' }));
      await until(() => sub.ids().includes(lateId));
      await slow.query('COMMIT');
    } catch (error) {
      await slow.query('ROLLBACK');
      throw error;
    } finally {
      slow.release();
    }
    await until(() => sub.ids().includes(earlyId));
    await new Promise((r) => setTimeout(r, GRACE_MS + 200)); // let further passes run
    expect(sub.ids().filter((i) => i === earlyId)).toHaveLength(1);
    expect(sub.ids().filter((i) => i === lateId)).toHaveLength(1);
  });

  it('moves past a gap left by a rolled-back transaction after the grace period', async () => {
    await startHub();
    const sub = collector();
    await hub.subscribe(sub);
    const aborted = await fx.pool.connect();
    let after: string;
    try {
      await aborted.query('BEGIN');
      await publish(aborted, event({ entityId: '01' }));
      after = await publishCommitted(event({ entityId: '02' }));
    } finally {
      await aborted.query('ROLLBACK');
      aborted.release();
    }
    await new Promise((r) => setTimeout(r, GRACE_MS + 200));
    const later = await publishCommitted(event({ entityId: '03' }));
    await until(() => sub.ids().includes(later));
    expect(sub.ids()).toEqual([after, later]);
  });

  it('keeps delivering by polling when the LISTEN connection is killed', async () => {
    await startHub();
    const sub = collector();
    await hub.subscribe(sub);
    await fx.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()`,
    );
    const id = await publishCommitted();
    await until(() => sub.ids().includes(id));
  });
});

describe('reconnect replay and resync (AT-43, stream part)', () => {
  it('replays events after the last one the client saw', async () => {
    await startHub();
    const a = await publishCommitted(event({ entityId: '11' }));
    const b = await publishCommitted(event({ entityId: '12' }));
    const c = await publishCommitted(event({ entityId: '13' }));
    const sub = collector();
    expect(await hub.subscribe(sub, a)).toBe('replayed');
    expect(sub.ids()).toEqual([b, c]);
  });

  it('asks for a resync when the point is in the future, pruned, invalid or too far back', async () => {
    await startHub({ maxReplay: 2 });
    const first = await publishCommitted();
    await publishCommitted();
    await publishCommitted();
    const max = await publishCommitted();

    const resync = async (lastId: string): Promise<boolean> => {
      const sub = collector();
      const result = await hub.subscribe(sub, lastId);
      hub.unsubscribe(sub.id);
      return result === 'resync' && sub.frames.some((f) => f.startsWith('event: resync'));
    };
    expect(await resync(String(BigInt(max) + 10n))).toBe(true); // database restored or reset
    expect(await resync('not-a-number')).toBe(true);
    expect(await resync(first)).toBe(true); // 3 to replay > maxReplay 2

    await fx.pool.query('DELETE FROM cl.outbox_events WHERE id <= $1', [
      String(BigInt(first) + 1n),
    ]);
    expect(await resync(first)).toBe(true); // what it missed was pruned
  });
});
