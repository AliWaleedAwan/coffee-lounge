/**
 * Owner settings take effect and are audited; a brand colour failing AA for button text is
 * refused (AT-130). Business hours stop guest QR orders, not staff. The manager's live
 * operations and inbox (step 3.12).
 */
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guestOrderingOpen } from '../../src/modules/settings/index.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let manager: Client;
let cashier: Client;
let tea = '';

type Body = Record<string, unknown>;
async function staff(
  client: Client,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  payload?: object,
) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}

async function setting(key: string) {
  const items = (await staff(owner, 'GET', '/settings')).body['items'] as Body[];
  const found = items.find((i) => i['key'] === key);
  if (!found) throw new Error(`no setting ${key}`);
  return found;
}

async function change(key: string, value: unknown) {
  const current = await setting(key);
  return staff(owner, 'PATCH', `/settings/${key}`, { value, expectedVersion: current['version'] });
}

class Phone {
  cookies: Record<string, string> = {};
  private keep(res: LightMyRequestResponse) {
    for (const c of res.cookies) this.cookies[c.name] = c.value;
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
  async order() {
    return this.keep(
      await fx.customer.inject({
        method: 'POST',
        url: '/api/customer/v1/rounds',
        cookies: this.cookies,
        headers: { 'idempotency-key': randomUUID() },
        payload: { lines: [{ variantId: tea, qty: 1, modifierOptionIds: [] }] },
      }),
    );
  }
}

/** "HH:MM" in Karachi, `hours` from now. */
const karachi = (hours: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(Date.now() + hours * 3_600_000));

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('st-mgr', ['manager']);
  await fx.addUser('st-cash', ['cashier']);
  manager = await fx.loggedIn('st-mgr');
  cashier = await fx.loggedIn('st-cash');
  const cat = await staff(owner, 'POST', '/menu/categories', { name: 'Settings tests' });
  const item = await staff(owner, 'POST', '/menu/items', {
    categoryId: cat.body['id'],
    name: 'Lemon tea',
    variants: [{ name: 'Cup', price: '200' }],
  });
  tea = (item.body['variantIds'] as string[])[0] ?? '';
});
afterAll(async () => {
  await fx.close();
});

describe('owner settings (AT-130)', () => {
  it('a threshold change takes effect, is audited, and needs the current version', async () => {
    const before = await setting('orders.escalation_minutes');
    expect(before).toMatchObject({ value: 3, editable: true, group: 'Orders' });
    const res = await change('orders.escalation_minutes', 5);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await setting('orders.escalation_minutes'))['value']).toBe(5);
    const stale = await staff(owner, 'PATCH', '/settings/orders.escalation_minutes', {
      value: 6,
      expectedVersion: before['version'],
    });
    expect(stale.status).toBe(409);
    const { rows } = await fx.pool.query<{ after: Body; before: Body }>(
      `SELECT after, before FROM cl.audit_events WHERE action = 'settings.update' ORDER BY audit_events.id DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({
      after: { key: 'orders.escalation_minutes', value: 5 },
      before: { key: 'orders.escalation_minutes', value: 3 },
    });
    // Out of range, not editable, or not allowed for the role.
    expect((await change('orders.escalation_minutes', 0)).status).toBe(400);
    expect((await change('shop.timezone', 'Asia/Dubai')).status).toBe(404);
    expect((await staff(manager, 'GET', '/settings')).status).toBe(403);
    await change('orders.escalation_minutes', 3);
  });

  it('business hours stop guest QR orders, not staff orders', async () => {
    const t = await staff(owner, 'POST', '/tables', { code: 'H1', name: 'Hours table' });
    const qr = await staff(owner, 'POST', '/qr-entry-points/generate', {
      tableIds: [t.body['id']],
      counter: false,
    });
    const token = (qr.body['items'] as { token: string }[])[0]?.token ?? '';
    // Closed now: the shop opens in an hour and closes in two.
    expect(
      (await change('shop.business_hours', { opens: karachi(1), closes: karachi(2) })).status,
    ).toBe(200);
    const phone = new Phone();
    const entry = (await phone.get(`/entry/${token}`)).json<Body>();
    expect(entry).toMatchObject({ orderingOpen: false, hours: { open: false, opens: karachi(1) } });
    const refused = await phone.order();
    expect(refused.statusCode).toBe(400);
    expect(refused.json<Body>()['detail']).toContain(`Orders open again at ${karachi(1)}`);
    const s = await staff(cashier, 'POST', `/tables/${String(t.body['id'])}/sessions`, {});
    const staffRound = await staff(cashier, 'POST', `/sessions/${String(s.body['id'])}/rounds`, {
      lines: [{ variantId: tea, qty: 1, modifierOptionIds: [] }],
    });
    expect(staffRound.status).toBe(201);
    // Open again (the same time twice = always open).
    expect((await change('shop.business_hours', { opens: '00:00', closes: '00:00' })).status).toBe(
      200,
    );
    expect((await phone.order()).statusCode).toBe(201);
    expect((await change('shop.business_hours', { opens: '25:00', closes: '01:00' })).status).toBe(
      400,
    );
  });

  it('hours may pass midnight', async () => {
    await change('shop.business_hours', { opens: '08:00', closes: '01:00' });
    const at = (iso: string) => guestOrderingOpen(fx.pool, new Date(iso));
    expect((await at('2026-10-25T19:00:00Z')).open).toBe(true); // 00:00 Karachi
    expect((await at('2026-10-25T21:00:00Z')).open).toBe(false); // 02:00
    expect((await at('2026-10-25T03:00:00Z')).open).toBe(true); // 08:00
    expect((await at('2026-10-25T02:59:00Z')).open).toBe(false); // 07:59
    await change('shop.business_hours', { opens: '00:00', closes: '00:00' });
  });

  it('branding: the shop name and receipt wording change together; a light colour is refused', async () => {
    const current = (await staff(owner, 'GET', '/settings')).body['branding'] as Body;
    expect(current).toMatchObject({ shopName: 'Coffee Lounge', primary: '#6B4435' });
    const body = {
      expectedVersion: current['version'],
      shopName: 'Coffee Lounge Gulberg',
      addressLine: '12 Main Boulevard',
      phone: '',
      footer: 'Thank you!',
      primary: '#F2C94C',
    };
    const light = await staff(owner, 'PUT', '/settings/branding', body);
    expect(light.status).toBe(400);
    expect(String(light.body['detail'])).toContain('Brand colour: Too light');
    const ok = await staff(owner, 'PUT', '/settings/branding', { ...body, primary: '#1f4e79' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      shopName: 'Coffee Lounge Gulberg',
      phone: null,
      primary: '#1F4E79',
    });
    expect((await staff(cashier, 'GET', '/branding')).body).toEqual({
      shopName: 'Coffee Lounge Gulberg',
      primary: '#1F4E79',
    });
    const stale = await staff(owner, 'PUT', '/settings/branding', { ...body, primary: '#1F4E79' });
    expect(stale.status).toBe(409);
    const { rows } = await fx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cl.audit_events WHERE action = 'settings.branding'`,
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe('live operations for managers', () => {
  it('shows the figures and an inbox; an alert can be noted as seen', async () => {
    const t = await staff(owner, 'POST', '/tables', { code: 'O1', name: 'Ops table' });
    const s = await staff(manager, 'POST', `/tables/${String(t.body['id'])}/sessions`, {});
    await staff(manager, 'POST', `/sessions/${String(s.body['id'])}/bill-request`, {});
    await fx.pool.query(
      `INSERT INTO cl.operational_alerts (kind, entity_type, entity_id, detail)
       VALUES ('stale_session', 'dining_session', $1, jsonb_build_object('sessionNo', 'S-OPS'))`,
      [s.body['id']],
    );
    const ops = await staff(manager, 'GET', '/operations');
    expect(ops.status).toBe(200);
    expect(ops.body).toMatchObject({
      tables: { billRequested: 1 },
      sales: { settled: 0, total: '0.00' },
    });
    const inbox = ops.body['inbox'] as Body[];
    const stale = inbox.find((i) => i['kind'] === 'stale_session');
    expect(stale).toMatchObject({
      title: 'Table open a long time: S-OPS',
      acknowledged: false,
      link: '/floor',
    });
    const seen = await staff(
      manager,
      'POST',
      `/alerts/${String(stale?.['alertId'])}/acknowledge`,
      {},
    );
    expect(seen.body).toMatchObject({ state: 'acknowledged' });
    expect(
      (await staff(manager, 'POST', `/alerts/${String(stale?.['alertId'])}/acknowledge`, {}))
        .status,
    ).toBe(409);
    const after = (await staff(manager, 'GET', '/operations')).body['inbox'] as Body[];
    expect(after.find((i) => i['kind'] === 'stale_session')).toMatchObject({ acknowledged: true });
    expect((await staff(cashier, 'GET', '/operations')).status).toBe(403);
  });
});
