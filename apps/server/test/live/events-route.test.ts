/**
 * The staff live stream over a real socket (fetch streaming), as a browser's EventSource
 * would use it: cookies, frames, heartbeats, permission filtering, replay and revocation.
 */
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveHub } from '../../src/platform/live-hub.ts';
import { publish, type OutboxEvent } from '../../src/platform/outbox.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let hub: LiveHub;
let base: string;

beforeAll(async () => {
  fx = await identityFixture({
    makeHub: (pool) =>
      new LiveHub({
        pool,
        connectListener: async () => {
          const client = new pg.Client({ connectionString: urlFor(fx.db.name) });
          await client.connect();
          return client;
        },
        pollMs: 50,
        gapGraceMs: 200,
      }),
    live: { heartbeatMs: 100, revalidateMs: 100 },
  });
  hub = fx.hub;
  await hub.start();
  await fx.staff.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${String((fx.staff.server.address() as AddressInfo).port)}/api/staff/v1`;
});
afterAll(async () => {
  await hub.stop();
  await fx.staff.close();
  await fx.close();
});

interface Stream {
  status: number;
  contentType: string | null;
  text(): string;
  /** Resolves once the received text matches, or rejects after the timeout. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<void>;
  ended: Promise<void>;
  close(): void;
}

async function open(client: Client | null, headers: Record<string, string> = {}): Promise<Stream> {
  const cookie = client
    ? Object.entries(client.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
    : '';
  const controller = new AbortController();
  const res = await fetch(`${base}/events`, {
    headers: { accept: 'text/event-stream', ...(cookie ? { cookie } : {}), ...headers },
    signal: controller.signal,
  });
  let received = '';
  const ended = (async () => {
    if (!res.body) return;
    const decoder = new TextDecoder();
    try {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted by close()
    }
  })();
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    text: () => received,
    async waitFor(pattern, timeoutMs = 3_000) {
      const end = Date.now() + timeoutMs;
      while (!pattern.test(received)) {
        if (Date.now() > end)
          throw new Error(`timed out waiting for ${String(pattern)}; got:\n${received}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    ended,
    close: () => {
      controller.abort();
    },
  };
}

async function publishCommitted(e: Partial<OutboxEvent>): Promise<string> {
  const client = await fx.pool.connect();
  try {
    await client.query('BEGIN');
    const id = await publish(client, {
      type: 'table.changed',
      entityType: 'table',
      entityId: '4',
      topics: ['floor'],
      ...e,
    });
    await client.query('COMMIT');
    return id;
  } finally {
    client.release();
  }
}

describe('GET /api/staff/v1/events (AT-73, staff stream part)', () => {
  it('refuses a client without a signed-in session', async () => {
    const anonymous = await open(null);
    expect(anonymous.status).toBe(403); // DEVICE_NOT_REGISTERED
    await anonymous.ended;
    const deviceOnly = await open(await fx.newDevice('waiter'));
    expect(deviceOnly.status).toBe(401); // UNAUTHENTICATED
    await deviceOnly.ended;
  });

  it('streams hints for the topics the user may see, with heartbeats', async () => {
    await fx.addUser('sse_waiter', ['waiter']);
    const waiter = await fx.loggedIn('sse_waiter', undefined, 'waiter');
    const stream = await open(waiter);
    try {
      expect(stream.status).toBe(200);
      expect(stream.contentType).toBe('text/event-stream; charset=utf-8');
      await stream.waitFor(/^retry: 3000$/m);
      await stream.waitFor(/^: heartbeat$/m);
      await new Promise((r) => setTimeout(r, 100)); // let the hub register the subscriber

      const hidden = await publishCommitted({
        type: 'printer.changed',
        entityType: 'printer',
        topics: ['printers', 'system'],
      });
      const mixed = await publishCommitted({ topics: ['floor', 'printers'] });
      await stream.waitFor(new RegExp(`^id: ${mixed}$`, 'm'));
      expect(stream.text()).not.toContain(`id: ${hidden}\n`);
      const frame =
        stream
          .text()
          .split('\n\n')
          .find((f) => f.includes(`id: ${mixed}`)) ?? '';
      expect(frame).toContain('event: table.changed');
      expect(JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? '{}')).toMatchObject({
        topics: ['floor'],
      });
    } finally {
      stream.close();
      await stream.ended;
    }
  });

  it('replays what a reconnecting client missed after its Last-Event-ID', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const seen = await publishCommitted({ entityId: '1' });
    const missed = await publishCommitted({ entityId: '2' });
    const stream = await open(owner, { 'last-event-id': seen });
    try {
      await stream.waitFor(new RegExp(`^id: ${missed}$`, 'm'));
      expect(stream.text()).not.toContain(`id: ${seen}\n`);
    } finally {
      stream.close();
      await stream.ended;
    }
    const future = await open(owner, { 'last-event-id': String(BigInt(missed) + 100n) });
    try {
      await future.waitFor(/^event: resync$/m);
    } finally {
      future.close();
      await future.ended;
    }
  });

  it('tells the client and closes the stream when the session ends', async () => {
    await fx.addUser('sse_cashier', ['cashier']);
    const cashier = await fx.loggedIn('sse_cashier');
    const stream = await open(cashier);
    await stream.waitFor(/^retry: 3000$/m);
    const out = await cashier.call({ method: 'POST', url: '/api/staff/v1/auth/logout' });
    expect(out.statusCode).toBeLessThan(300);
    await stream.waitFor(/^event: session_ended$/m);
    await stream.ended; // the server ended the response
    expect(hub.subscriberCount).toBe(0);
  });

  it('forgets a subscriber when the client disconnects', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const stream = await open(owner);
    await stream.waitFor(/^retry: 3000$/m);
    await new Promise((r) => setTimeout(r, 100));
    expect(hub.subscriberCount).toBe(1);
    stream.close();
    await stream.ended;
    const end = Date.now() + 2_000;
    while (hub.subscriberCount > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(hub.subscriberCount).toBe(0);
  });
  // Runs last: it closes the server.
  it('ends open streams when the server shuts down, so a service stop never hangs', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const stream = await open(owner);
    await stream.waitFor(/^retry: 3000$/m);
    const started = Date.now();
    await fx.staff.close();
    await stream.ended;
    // Without the fix this hangs for ever; slow CI runners need a few seconds.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
