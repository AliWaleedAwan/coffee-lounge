/**
 * Tables, QR codes, sessions and guest phones (step 3.3), as the application role.
 * Guests talk to the customer listener with cookies only; staff to the staff listener.
 * Rounds arrive in step 3.4: where a test needs "the first order", it calls
 * `openOrJoinFromQr`, which the round submission will call.
 */
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openOrJoinFromQr,
  scanStaleSessions,
  type EntryPoint,
} from '../../src/modules/floor/index.ts';
import { signEntry } from '../../src/modules/floor/tokens.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import { race, raceRuns, repeatRace, tally } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let clock = new Date();
let fx: IdentityFixture;
let owner: Client;
beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app', now: () => clock });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
});
afterAll(async () => {
  await fx.close();
});

const staffUrl = (path: string) => `/api/staff/v1${path}`;

async function staff(
  client: Client,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  payload?: object,
  key?: string,
) {
  const res = await client.call({
    method,
    url: staffUrl(path),
    ...(payload ? { payload } : {}),
    ...(key ? { headers: { 'idempotency-key': key } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Record<string, unknown>>() : {} };
}

/** A guest phone: cookies only, no CSRF header, customer listener. */
class Phone {
  cookies: Record<string, string> = {};
  async get(path: string): Promise<LightMyRequestResponse> {
    const res = await fx.customer.inject({
      method: 'GET',
      url: `/api/customer/v1${path}`,
      cookies: this.cookies,
    });
    for (const c of res.cookies) {
      if (c.value === '' || c.maxAge === 0) Reflect.deleteProperty(this.cookies, c.name);
      else this.cookies[c.name] = c.value;
    }
    return res;
  }
}

let tableNo = 0;
async function newTable(): Promise<{ id: string; code: string; token: string }> {
  tableNo += 1;
  const code = `T${String(tableNo).padStart(2, '0')}`;
  const created = await staff(owner, 'POST', '/tables', {
    code,
    name: `Table ${String(tableNo)}`,
    seats: 4,
  });
  expect(created.status).toBe(201);
  const id = String(created.body['id']);
  const qr = await staff(owner, 'POST', '/qr-entry-points/generate', {
    tableIds: [id],
    counter: false,
  });
  const token = (qr.body['items'] as { token: string }[])[0]?.token ?? '';
  return { id, code, token };
}

async function entryPointOf(tableId: string): Promise<EntryPoint> {
  const { rows } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.qr_entry_points WHERE table_id = $1 AND is_active',
    [tableId],
  );
  return { id: rows[0]?.id ?? '', kind: 'table', tableId };
}

async function floorTable(tableId: string) {
  const res = await staff(owner, 'GET', '/floor');
  return (
    res.body['tables'] as {
      id: string;
      state: string;
      waiter: { name: string } | null;
      session: { id: string; sessionNo: string; guestPhones: number; stale: boolean } | null;
    }[]
  ).find((t) => t.id === tableId);
}

async function openByStaff(tableId: string) {
  const res = await staff(
    owner,
    'POST',
    `/tables/${tableId}/sessions`,
    { guestCount: 2 },
    randomUUID(),
  );
  expect(res.status).toBe(201);
  return res.body as { id: string; sessionNo: string };
}

async function sessionCount(tableId: string): Promise<number> {
  const { rows } = await fx.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM cl.dining_sessions WHERE table_id = $1',
    [tableId],
  );
  return rows[0]?.n ?? 0;
}

describe('tables and QR codes', () => {
  it('creates tables with unique codes and prints QR links once; a new code retires the old one', async () => {
    const t = await newTable();
    expect((await staff(owner, 'POST', '/tables', { code: t.code, name: 'Copy' })).status).toBe(
      400,
    );
    const again = await staff(owner, 'POST', '/qr-entry-points/generate', {
      tableIds: [t.id],
      counter: true,
    });
    const items = again.body['items'] as { kind: string; token: string; url: string | null }[];
    expect(items.map((i) => i.kind)).toEqual(['table', 'counter_takeaway']);
    for (const i of items) {
      if (i.url !== null) expect(i.url).toMatch(/^http:\/\/[^/]+:8080\/t\/[A-Za-z0-9_-]{22}$/);
    }
    expect((await new Phone().get(`/entry/${t.token}`)).statusCode).toBe(404); // the old print
    expect((await new Phone().get(`/entry/${items[0]?.token ?? ''}`)).statusCode).toBe(200);
    const list = await staff(owner, 'GET', '/tables');
    expect(JSON.stringify(list.body)).not.toContain(items[0]?.token ?? 'x'); // tokens are never listed
  });

  it('refuses to block or archive a table while guests are at it, and retires its QR on archive', async () => {
    const t = await newTable();
    const s = await openByStaff(t.id);
    expect(
      (
        await staff(owner, 'PATCH', `/tables/${t.id}`, {
          expectedVersion: 1,
          availability: 'blocked',
        })
      ).body['code'],
    ).toBe('TABLE_OCCUPIED');
    expect(
      (await staff(owner, 'POST', `/tables/${t.id}/archive`, { expectedVersion: 1 })).body['code'],
    ).toBe('TABLE_OCCUPIED');
    await staff(
      owner,
      'POST',
      `/sessions/${s.id}/cancel`,
      { reason: 'Left without ordering' },
      randomUUID(),
    );
    expect(
      (await staff(owner, 'POST', `/tables/${t.id}/archive`, { expectedVersion: 1 })).status,
    ).toBe(204);
    expect((await new Phone().get(`/entry/${t.token}`)).statusCode).toBe(404);
  });
});

describe('guests (API.md §4)', () => {
  it('browsing opens nothing: the table stays available (AT-74)', async () => {
    const t = await newTable();
    const phone = new Phone();
    const entry = await phone.get(`/entry/${t.token}`);
    expect(entry.statusCode).toBe(200);
    expect(entry.json()).toMatchObject({
      entry: { kind: 'table', table: { code: t.code } },
      orderingOpen: true,
      session: null,
    });
    expect(phone.cookies['cl_entry']).toBeDefined();
    expect(phone.cookies['cl_guest']).toBeUndefined();
    const menu = await phone.get('/menu');
    expect(menu.statusCode).toBe(200);
    expect(menu.json()).toMatchObject({ orderType: 'dine_in' });
    expect((await phone.get('/session')).statusCode).toBe(404);
    expect(await sessionCount(t.id)).toBe(0);
    expect((await floorTable(t.id))?.state).toBe('available');
  });

  it('two phones at one table share one session (AT-09, session part); a scan at an occupied table joins it (D-09)', async () => {
    const t = await newTable();
    const first = new Phone();
    await first.get(`/entry/${t.token}`);
    const opened = await withTransaction(fx.pool, (tx) =>
      entryPointOf(t.id).then((e) => openOrJoinFromQr(tx, e)),
    );
    expect(opened.opened).toBe(true);
    first.cookies['cl_guest'] = opened.token;

    const second = new Phone();
    const scan = await second.get(`/entry/${t.token}`);
    expect(scan.json<{ session: { sessionNo: string } }>().session.sessionNo).toBe(
      opened.session.session_no,
    );
    expect(second.cookies['cl_guest']).toBeDefined();
    for (const phone of [first, second]) {
      const s = await phone.get('/session');
      expect(s.statusCode).toBe(200);
      expect(s.json<{ session: { sessionNo: string } }>().session.sessionNo).toBe(
        opened.session.session_no,
      );
    }
    expect(await sessionCount(t.id)).toBe(1);
    expect((await floorTable(t.id))?.session?.guestPhones).toBe(2);
    // Scanning again with a live token keeps it rather than adding a phone.
    await second.get(`/entry/${t.token}`);
    expect((await floorTable(t.id))?.session?.guestPhones).toBe(2);
  });

  it('two guests opening the same empty table at once get one session, both joined (CT-03)', async () => {
    await repeatRace(raceRuns(), async () => {
      const t = await newTable();
      const entry = await entryPointOf(t.id);
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: ({ pool, barrier }) =>
          withTransaction(pool, async (tx) => {
            await barrier.wait();
            return openOrJoinFromQr(tx, entry);
          }),
      });
      const { ok, failed } = tally(outcomes);
      expect(failed).toEqual([]);
      expect(new Set(ok.map((o) => o.session.id)).size).toBe(1);
      expect(ok.map((o) => o.opened).sort()).toEqual([false, true]);
      expect(await sessionCount(t.id)).toBe(1);
    });
  });

  it('a closed or reset visit answers 401 VISIT_ENDED with no data (AT-40); a new scan starts fresh (AT-12)', async () => {
    const t = await newTable();
    const s = await openByStaff(t.id);
    const phone = new Phone();
    await phone.get(`/entry/${t.token}`);
    expect((await phone.get('/session')).statusCode).toBe(200);

    // Staff reset the table's phones: the token dies, the next scan joins as a new phone.
    expect((await staff(owner, 'POST', `/sessions/${s.id}/reset-guests`, {})).body).toEqual({
      revoked: 1,
    });
    const reset = await phone.get('/session');
    expect(reset.statusCode).toBe(401);
    expect(reset.json()).toMatchObject({ code: 'VISIT_ENDED' });
    expect(reset.json()).not.toHaveProperty('session');
    await phone.get(`/entry/${t.token}`);
    expect(
      (await phone.get('/session')).json<{ session: { sessionNo: string } }>().session.sessionNo,
    ).toBe(s.sessionNo);

    // The visit ends: the token is refused; scanning again finds no session to join.
    await staff(owner, 'POST', `/sessions/${s.id}/cancel`, { reason: 'Guests left' }, randomUUID());
    const ended = await phone.get('/session');
    expect(ended.statusCode).toBe(401);
    expect(phone.cookies['cl_guest']).toBeUndefined(); // cleared
    const rescan = await phone.get(`/entry/${t.token}`);
    expect(rescan.json()).toMatchObject({ session: null });
    const next = await withTransaction(fx.pool, async (tx) =>
      openOrJoinFromQr(tx, await entryPointOf(t.id)),
    );
    expect(next.opened).toBe(true);
    expect(next.session.session_no).not.toBe(s.sessionNo);
  });

  it('takes the table only from the QR code: ids sent by a guest are refused (AT-127)', async () => {
    const t = await newTable();
    const other = await newTable();
    const phone = new Phone();
    expect((await phone.get(`/entry/${t.token}?tableId=${other.id}`)).statusCode).toBe(400);
    await phone.get(`/entry/${t.token}`);
    expect((await phone.get(`/menu?sessionId=1`)).statusCode).toBe(400);
    // A forged entry cookie for another table fails its signature.
    const forged = new Phone();
    forged.cookies['cl_entry'] = signEntry(
      Buffer.alloc(32, 7),
      (await entryPointOf(other.id)).id,
      clock,
    );
    expect((await forged.get('/menu')).json()).toMatchObject({ code: 'VISIT_ENDED' });
    expect((await new Phone().get('/entry/not-a-token')).statusCode).toBe(404);
  });

  it('expires the entry cookie after 12 hours', async () => {
    const t = await newTable();
    const phone = new Phone();
    await phone.get(`/entry/${t.token}`);
    const saved = clock;
    try {
      clock = new Date(saved.getTime() + 13 * 3600_000);
      expect((await phone.get('/menu')).json()).toMatchObject({ code: 'VISIT_ENDED' });
    } finally {
      clock = saved;
    }
  });
});

describe('blocked tables and stale sessions (AT-128)', () => {
  it('a blocked table cannot be ordered from by QR, nor opened by staff', async () => {
    const t = await newTable();
    expect(
      (
        await staff(owner, 'PATCH', `/tables/${t.id}`, {
          expectedVersion: 1,
          availability: 'maintenance',
        })
      ).status,
    ).toBe(200);
    const phone = new Phone();
    expect((await phone.get(`/entry/${t.token}`)).json()).toMatchObject({
      orderingOpen: false,
      session: null,
    });
    await expect(
      withTransaction(fx.pool, async (tx) => openOrJoinFromQr(tx, await entryPointOf(t.id))),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect((await staff(owner, 'POST', `/tables/${t.id}/sessions`, {}, randomUUID())).status).toBe(
      400,
    );
    expect((await floorTable(t.id))?.state).toBe('maintenance');
  });

  it('alerts the manager once for a session open more than 3 hours, without changing it', async () => {
    const t = await newTable();
    const s = await openByStaff(t.id);
    expect((await floorTable(t.id))?.session?.stale).toBe(false);
    const later = new Date(Date.now() + 3.5 * 3600_000);
    expect(await scanStaleSessions(fx.pool, later)).toBeGreaterThanOrEqual(1);
    expect(await scanStaleSessions(fx.pool, later)).toBe(0);
    const { rows } = await fx.pool.query(
      `SELECT state FROM cl.operational_alerts WHERE kind = 'stale_session' AND entity_id = $1`,
      [s.id],
    );
    expect(rows).toEqual([{ state: 'open' }]);
    const saved = clock;
    try {
      clock = later;
      expect((await floorTable(t.id))?.session?.stale).toBe(true);
    } finally {
      clock = saved;
    }
    await staff(
      owner,
      'POST',
      `/sessions/${s.id}/cancel`,
      { reason: 'Closed by test' },
      randomUUID(),
    );
    const after = await fx.pool.query(
      `SELECT state FROM cl.operational_alerts WHERE entity_id = $1 AND kind = 'stale_session'`,
      [s.id],
    );
    expect(after.rows).toEqual([{ state: 'resolved' }]);
  });
});

describe('transfer (AT-100, D-10)', () => {
  it('moves a session to a free table with an audit trail; an occupied target answers TABLE_OCCUPIED', async () => {
    const from = await newTable();
    const to = await newTable();
    const busy = await newTable();
    const s = await openByStaff(from.id);
    await openByStaff(busy.id);
    const phone = new Phone();
    await phone.get(`/entry/${from.token}`);

    const occupied = await staff(
      owner,
      'POST',
      `/sessions/${s.id}/transfer`,
      { toTableId: busy.id },
      randomUUID(),
    );
    expect(occupied.status).toBe(409);
    expect(occupied.body['code']).toBe('TABLE_OCCUPIED');

    const key = randomUUID();
    const moved = await staff(
      owner,
      'POST',
      `/sessions/${s.id}/transfer`,
      { toTableId: to.id, reason: 'Window seat' },
      key,
    );
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: s.id, tableId: to.id });
    const replay = await owner.call({
      method: 'POST',
      url: staffUrl(`/sessions/${s.id}/transfer`),
      payload: { toTableId: to.id, reason: 'Window seat' },
      headers: { 'idempotency-key': key },
    });
    expect(replay.headers['idempotent-replayed']).toBe('true');

    expect((await floorTable(from.id))?.state).toBe('available');
    expect((await floorTable(to.id))?.session?.id).toBe(s.id);
    expect((await phone.get('/session')).statusCode).toBe(200); // the phone follows its session
    const { rows } = await fx.pool.query(
      `SELECT m.reason, a.action FROM cl.session_table_moves m
         JOIN cl.audit_events a ON a.entity_id::text = m.session_id::text AND a.action = 'session.transfer'
        WHERE m.session_id = $1`,
      [s.id],
    );
    expect(rows).toEqual([{ reason: 'Window seat', action: 'session.transfer' }]);
  });
});

describe('waiter assignments and own-table scope (D-07)', () => {
  it('assigns waiters, shows them on the floor, and limits scoped actions to their own tables', async () => {
    const mine = await newTable();
    const theirs = await newTable();
    const sara = await fx.addUser('sara-floor', ['waiter']);
    const cashier = await fx.addUser('ali-floor', ['cashier']);
    expect(
      (await staff(owner, 'PUT', `/tables/${mine.id}/assignment`, { userId: cashier })).status,
    ).toBe(400);
    expect(
      (await staff(owner, 'PUT', `/tables/${mine.id}/assignment`, { userId: sara })).status,
    ).toBe(204);
    expect((await floorTable(mine.id))?.waiter?.name).toBe('sara-floor');

    const s1 = await openByStaff(mine.id);
    const s2 = await openByStaff(theirs.id);
    const waiter = await fx.loggedIn('sara-floor');
    expect((await staff(waiter, 'POST', `/sessions/${s1.id}/reset-guests`, {})).status).toBe(200);
    const refused = await staff(waiter, 'POST', `/sessions/${s2.id}/reset-guests`, {});
    expect(refused.status).toBe(403);
    expect(
      (
        await staff(
          waiter,
          'POST',
          `/sessions/${s2.id}/cancel`,
          { reason: 'Not mine' },
          randomUUID(),
        )
      ).status,
    ).toBe(403);

    expect((await staff(owner, 'DELETE', `/tables/${mine.id}/assignment`)).status).toBe(204);
    expect((await floorTable(mine.id))?.waiter).toBeNull();
    expect((await staff(waiter, 'POST', `/sessions/${s1.id}/reset-guests`, {})).status).toBe(403);
  });

  it('numbers sessions S-YYYYMMDD-NNNN and needs an Idempotency-Key to open one', async () => {
    const t = await newTable();
    expect((await staff(owner, 'POST', `/tables/${t.id}/sessions`, {})).status).toBe(400);
    const s = await openByStaff(t.id);
    expect(s.sessionNo).toMatch(/^S-\d{8}-\d{4}$/);
    expect(
      (await staff(owner, 'POST', `/tables/${t.id}/sessions`, {}, randomUUID())).body['code'],
    ).toBe('TABLE_OCCUPIED');
  });
});
