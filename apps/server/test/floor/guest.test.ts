/**
 * The guest app's server side finished in step 3.11: asking for the bill (S4), a paid
 * counter-QR guest following the order read-only, and the guest live stream that carries
 * the phone's own session and the menu, nothing else, until the visit ends.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveHub } from '../../src/platform/live-hub.ts';
import { publish } from '../../src/platform/outbox.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let cashier: Client;
let base = '';
let tea = '';
let counterToken = '';

type Body = Record<string, unknown>;
async function staff(client: Client, method: 'GET' | 'POST', path: string, payload?: object) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}

class Phone {
  cookies: Record<string, string> = {};
  private keep(res: LightMyRequestResponse) {
    for (const c of res.cookies) {
      if (c.value === '' || c.maxAge === 0) Reflect.deleteProperty(this.cookies, c.name);
      else this.cookies[c.name] = c.value;
    }
    return res;
  }
  async get(path: string) {
    return this.keep(
      await fx.customer.inject({
        method: 'GET',
        url: `/api/customer/v1${path}`,
        cookies: this.cookies,
      }),
    );
  }
  async post(path: string, payload: object = {}, key = randomUUID()) {
    return this.keep(
      await fx.customer.inject({
        method: 'POST',
        url: `/api/customer/v1${path}`,
        cookies: this.cookies,
        headers: { 'idempotency-key': key },
        payload,
      }),
    );
  }
  order(qty = 1) {
    return this.post('/rounds', { lines: [{ variantId: tea, qty, modifierOptionIds: [] }] });
  }
  /** The live stream as the browser reads it. */
  async stream() {
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, {
      headers: {
        accept: 'text/event-stream',
        cookie: Object.entries(this.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      },
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
        // aborted
      }
    })();
    return {
      status: res.status,
      text: () => received,
      async waitFor(pattern: RegExp, timeoutMs = 3_000) {
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
}

let tableNo = 0;
async function tableWithCode(): Promise<{ id: string; token: string }> {
  tableNo += 1;
  const t = await staff(owner, 'POST', '/tables', {
    code: `G${String(tableNo)}`,
    name: `Guest ${String(tableNo)}`,
  });
  const qr = await staff(owner, 'POST', '/qr-entry-points/generate', {
    tableIds: [t.body['id']],
    counter: false,
  });
  return {
    id: String(t.body['id']),
    token: (qr.body['items'] as { token: string }[])[0]?.token ?? '',
  };
}

async function seated(): Promise<{ phone: Phone; tableId: string; sessionId: string }> {
  const t = await tableWithCode();
  const phone = new Phone();
  await phone.get(`/entry/${t.token}`);
  expect((await phone.order()).statusCode).toBe(201);
  const { rows } = await fx.pool.query<{ id: string }>(
    `SELECT id::text FROM cl.dining_sessions WHERE table_id = $1 AND status IN ('open','checkout_requested')`,
    [t.id],
  );
  return { phone, tableId: t.id, sessionId: rows[0]?.id ?? '' };
}

beforeAll(async () => {
  fx = await identityFixture({
    sessionRole: 'cl_app',
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
  await fx.hub.start();
  await fx.customer.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${String((fx.customer.server.address() as AddressInfo).port)}/api/customer/v1`;
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('gs-cash', ['cashier']);
  cashier = await fx.loggedIn('gs-cash');
  const cat = await staff(owner, 'POST', '/menu/categories', { name: 'Guest tests' });
  const item = await staff(owner, 'POST', '/menu/items', {
    categoryId: cat.body['id'],
    name: 'Green tea',
    variants: [{ name: 'Pot', price: '300' }],
  });
  tea = (item.body['variantIds'] as string[])[0] ?? '';
  const qr = await staff(owner, 'POST', '/qr-entry-points/generate', {
    tableIds: [],
    counter: true,
  });
  counterToken = (qr.body['items'] as { token: string }[])[0]?.token ?? '';
});
afterAll(async () => {
  await fx.hub.stop();
  await fx.customer.close();
  await fx.close();
});

describe('asking for the bill (S4)', () => {
  it('a table’s guest asks once; staff see it; later rounds are flagged (D-12)', async () => {
    const { phone, sessionId } = await seated();
    const key = randomUUID();
    const asked = await phone.post('/session/bill-request', {}, key);
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toMatchObject({ status: 'checkout_requested' });
    const again = await phone.post('/session/bill-request');
    expect(again.json<Body>()['requestedAt']).toBe(asked.json<Body>()['requestedAt']);
    expect((await phone.get('/session')).json()).toMatchObject({
      session: { billRequested: true },
    });
    const bills = (await staff(cashier, 'GET', '/bills')).body['items'] as Body[];
    expect(bills.find((b) => b['sessionId'] === sessionId)).toMatchObject({ billRequested: true });
    const more = await phone.order();
    expect(more.statusCode).toBe(201);
    const { rows } = await fx.pool.query<{ flagged: boolean }>(
      'SELECT after_bill_request AS flagged FROM cl.order_rounds WHERE id = $1',
      [more.json<{ round: { id: string } }>().round.id],
    );
    expect(rows).toEqual([{ flagged: true }]);
  });

  it('staff can ask for a table too; a prepared bill or the counter QR cannot be asked again', async () => {
    const { phone, sessionId } = await seated();
    expect(
      (await staff(cashier, 'POST', `/sessions/${sessionId}/bill-request`, {})).body,
    ).toMatchObject({
      status: 'checkout_requested',
    });
    // Accept the guest's pending order, then prepare the bill.
    const { rows } = await fx.pool.query<{ id: string }>(
      `SELECT id::text FROM cl.order_rounds WHERE session_id = $1 AND status = 'pending_approval'`,
      [sessionId],
    );
    for (const r of rows) await staff(cashier, 'POST', `/rounds/${r.id}/accept`, {});
    const inv = await fx.pool.query<{ id: string }>(
      'SELECT id::text FROM cl.invoices WHERE session_id = $1',
      [sessionId],
    );
    expect(
      (await staff(cashier, 'POST', `/invoices/${inv.rows[0]?.id ?? ''}/lock`, {})).status,
    ).toBe(200);
    expect((await phone.post('/session/bill-request')).json()).toMatchObject({
      code: 'STALE_STATE',
    });

    const counter = new Phone();
    await counter.get(`/entry/${counterToken}`);
    await counter.order();
    const refused = await counter.post('/session/bill-request');
    expect(refused.statusCode).toBe(400);
    expect(refused.json<Body>()['detail']).toBe('Takeaway orders are paid at the counter.');
  });
});

describe('a paid counter-QR order', () => {
  it('can be followed read-only for two hours; ordering again starts a new visit', async () => {
    const phone = new Phone();
    await phone.get(`/entry/${counterToken}`);
    const first = await phone.order();
    const roundId = first.json<{ round: { id: string } }>().round.id;
    const pending = (await phone.get('/session')).json<{ session: Body }>().session;
    expect(Date.parse(String(pending['payBy']))).toBeGreaterThan(Date.now() + 29 * 60_000);
    const paid = await staff(cashier, 'POST', `/rounds/${roundId}/accept-and-pay`, {
      payments: [{ method: 'card_manual', amount: '300' }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const follow = (await phone.get('/session')).json<{ session: Body; rounds: Body[] }>();
    expect(follow.session).toMatchObject({ status: 'settled', readOnly: true, payBy: null });
    expect(follow.rounds).toHaveLength(1);
    expect((await phone.post('/session/bill-request')).json()).toMatchObject({
      code: 'VISIT_ENDED',
    });

    const paidVisit = new Phone();
    paidVisit.cookies = { ...phone.cookies }; // the token of the paid visit
    const again = await phone.order();
    expect(again.statusCode).toBe(201);
    expect(again.json<{ session: { sessionNo: string } }>().session.sessionNo).not.toBe(
      follow.session['sessionNo'],
    );

    // Two hours after it was paid, the old visit is over for good.
    const { rows } = await fx.pool.query<{ id: string }>(
      'SELECT session_id::text AS id FROM cl.order_rounds WHERE id = $1',
      [roundId],
    );
    await fx.pool.query(
      `UPDATE cl.dining_sessions SET closed_at = now() - interval '3 hours' WHERE id = $1`,
      [rows[0]?.id],
    );
    const ended = await paidVisit.get('/session');
    expect(ended.statusCode).toBe(401);
    expect(ended.json()).toMatchObject({ code: 'VISIT_ENDED' });
  });
});

describe('the guest live stream', () => {
  it('carries this phone’s session and the menu, nothing else, and ends with the visit', async () => {
    const mine = await seated();
    const other = await seated();
    const stream = await mine.phone.stream();
    expect(stream.status).toBe(200);
    await stream.waitFor(/retry: 3000/);

    const hint = async (topics: string[]) => {
      const client = await fx.pool.connect();
      try {
        await client.query('BEGIN');
        await publish(client, {
          type: 'session.changed',
          entityType: 'dining_session',
          entityId: '1',
          topics,
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    };
    await hint([`session:${other.sessionId}`, 'floor', 'cashier']);
    await hint(['menu']);
    await stream.waitFor(/"topics":\["menu"\]/);
    expect(stream.text()).not.toContain(`session:${other.sessionId}`);
    expect(stream.text()).not.toContain('floor');
    await hint([`session:${mine.sessionId}`, 'floor']);
    await stream.waitFor(new RegExp(`"topics":\\["session:${mine.sessionId}"\\]`));

    // Staff reset the table's phones: the stream ends with visit_ended.
    await staff(owner, 'POST', `/sessions/${mine.sessionId}/reset-guests`, {});
    await stream.waitFor(/event: visit_ended/);
    await stream.ended;

    // A phone that has only scanned hears the menu; one with no code is refused.
    const t = await tableWithCode();
    const browsing = new Phone();
    await browsing.get(`/entry/${t.token}`);
    const menuOnly = await browsing.stream();
    expect(menuOnly.status).toBe(200);
    menuOnly.close();
    expect((await new Phone().stream()).status).toBe(401);
  });
});
