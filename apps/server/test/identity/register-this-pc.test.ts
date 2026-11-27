/** The counter PC registers itself without a code; no other device can (owner, Nov 2026). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isThisPc } from '../../src/modules/identity/service.ts';
import { identityFixture, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
beforeAll(async () => {
  fx = await identityFixture();
});
afterAll(async () => {
  await fx.close();
});

const from = (remoteAddress: string, method: 'GET' | 'POST', url: string) =>
  fx.staff.inject({
    method,
    url: `/api/staff/v1${url}`,
    remoteAddress,
    headers: method === 'POST' ? { 'x-cl-request': '1', 'content-type': 'application/json' } : {},
    ...(method === 'POST' ? { payload: '{}' } : {}),
  });

describe('registering the counter PC itself', () => {
  it('knows this PC by its own address only', () => {
    expect(isThisPc('127.0.0.1')).toBe(true);
    expect(isThisPc('::1')).toBe(true);
    expect(isThisPc('::ffff:127.0.0.1')).toBe(true);
    expect(isThisPc('192.168.100.20')).toBe(false);
    expect(isThisPc(undefined)).toBe(false);
  });

  it('is offered, and works, on this PC: a counter device, registered by the owner', async () => {
    expect((await from('127.0.0.1', 'GET', '/devices/this-pc')).json()).toEqual({
      available: true,
    });
    const res = await from('127.0.0.1', 'POST', '/devices/register-this-pc');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Counter PC', kind: 'reception', ownership: 'shop' });
    expect(String(res.headers['set-cookie'])).toMatch(/./);
    const { rows } = await fx.pool.query<{ registered_by: string }>(
      `SELECT registered_by::text FROM cl.devices WHERE id = $1`,
      [res.json<{ id: string }>().id],
    );
    expect(rows[0]?.registered_by).toBe(fx.ownerId);
  });

  it('a phone or laptop on the shop network is neither offered it nor allowed', async () => {
    expect((await from('192.168.100.20', 'GET', '/devices/this-pc')).json()).toEqual({
      available: false,
    });
    expect((await from('192.168.100.20', 'POST', '/devices/register-this-pc')).statusCode).toBe(
      403,
    );
  });
});
