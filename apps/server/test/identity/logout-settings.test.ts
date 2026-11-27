/** The owner sets how long a device may sit idle (owner's request, Nov 2026); 0 is never. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idleSeconds, SESSION_ABSOLUTE_MS } from '../../src/modules/identity/service.ts';
import { identityFixture, OWNER, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
beforeAll(async () => {
  fx = await identityFixture();
});
afterAll(async () => {
  await fx.close();
});

const set = (key: string, value: unknown) =>
  fx.pool.query('UPDATE cl.system_settings SET value = $2::jsonb WHERE key = $1', [
    key,
    JSON.stringify(value),
  ]);

describe('idle logout', () => {
  it('keeps the times used until now by default', async () => {
    expect(await idleSeconds(fx.pool, 'reception')).toBe(600);
    expect(await idleSeconds(fx.pool, 'inventory')).toBe(600);
    expect(await idleSeconds(fx.pool, 'manager')).toBe(300);
    expect(await idleSeconds(fx.pool, 'waiter')).toBe(300);
    expect(await idleSeconds(fx.pool, 'kitchen')).toBe(12 * 3600);
  });

  it('follows the owner: minutes, or never (then only the 12-hour limit applies)', async () => {
    await set('security.logout_manager_minutes', 60);
    expect(await idleSeconds(fx.pool, 'manager')).toBe(3600);
    await set('security.logout_manager_minutes', 0);
    expect(await idleSeconds(fx.pool, 'manager')).toBe(SESSION_ABSOLUTE_MS / 1000);
    await set('security.logout_manager_minutes', 5);
  });

  it('a damaged value falls back to the built-in time instead of locking everyone out', async () => {
    await set('security.logout_waiter_minutes', 'soon');
    expect(await idleSeconds(fx.pool, 'waiter')).toBe(300);
    await set('security.logout_waiter_minutes', 5);
  });

  it('only the owner may change it, and only to a sensible value', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const read = await owner.call({ method: 'GET', url: '/api/staff/v1/settings' });
    const item = read
      .json<{ items: { key: string; version: number; financial?: boolean }[] }>()
      .items.find((s) => s.key === 'security.logout_counter_minutes');
    expect(item?.financial).toBe(true);
    const patch = (value: unknown) =>
      owner.call({
        method: 'PATCH',
        url: '/api/staff/v1/settings/security.logout_counter_minutes',
        payload: { value, expectedVersion: item?.version },
      });
    expect((await patch(721)).statusCode).toBe(400);
    expect((await patch(0)).statusCode).toBe(200);
    expect(await idleSeconds(fx.pool, 'reception')).toBe(SESSION_ABSOLUTE_MS / 1000);
  });
});
