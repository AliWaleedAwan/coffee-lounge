/**
 * Demo mode (docs/phase-8/DEMO.md): nothing of it exists until a demo is loaded; a loaded demo
 * lets a device become a made-up person, not a real one; the wipe empties trading, keeps the
 * menu and real people, restarts numbering, and works once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityFixture, OWNER, type IdentityFixture } from '../support/identity.ts';

const url = (p: string) => `/api/staff/v1${p}`;
let fx: IdentityFixture;

beforeAll(async () => {
  fx = await identityFixture();
});
afterAll(async () => {
  await fx.close();
});

describe('demo mode', () => {
  it('does not exist in a shop without a demo', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const status = await owner.call({ method: 'GET', url: url('/demo') });
    expect(status.json()).toEqual({ active: false, people: [] });
    const swap = await owner.call({
      method: 'POST',
      url: url('/demo/switch'),
      payload: { username: OWNER.username },
    });
    expect(swap.statusCode).toBe(404);
    const wipe = await owner.call({
      method: 'POST',
      url: url('/demo/wipe'),
      payload: { confirm: 'DELETE' },
    });
    expect(wipe.statusCode).toBe(404);
    await expect(fx.pool.query('SELECT cl.wipe_demo_data()')).rejects.toThrow(/no demo data/);
  });

  it('switches only to made-up people, and the wipe ends it for good', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const fake = await fx.addUser('demo_someone', ['waiter']);
    await fx.db.client.query('INSERT INTO cl.demo_state (user_ids) VALUES ($1::bigint[])', [
      [fake],
    ]);
    await fx.pool.query(`INSERT INTO cl.dining_tables (code, name) VALUES ('T99', 'Demo table')`);

    const status = await owner.call({ method: 'GET', url: url('/demo') });
    expect(status.json()).toMatchObject({ active: true, people: [{ username: 'demo_someone' }] });
    const real = await owner.call({
      method: 'POST',
      url: url('/demo/switch'),
      payload: { username: OWNER.username },
    });
    expect(real.statusCode).toBe(404);

    const waiter = await fx.loggedIn(OWNER.username, OWNER.password);
    const swap = await waiter.call({
      method: 'POST',
      url: url('/demo/switch'),
      payload: { username: 'demo_someone' },
    });
    expect(swap.statusCode).toBe(204);
    const notOwner = await waiter.call({
      method: 'POST',
      url: url('/demo/wipe'),
      payload: { confirm: 'DELETE' },
    });
    expect(notOwner.statusCode).toBe(403);

    const wipe = await owner.call({
      method: 'POST',
      url: url('/demo/wipe'),
      payload: { confirm: 'DELETE' },
    });
    expect(wipe.statusCode).toBe(204);
    const count = async (sql: string) => (await fx.pool.query(sql)).rowCount;
    expect(await count('SELECT 1 FROM cl.dining_tables')).toBe(0);
    expect(await count(`SELECT 1 FROM cl.users WHERE username = 'demo_someone'`)).toBe(0);
    expect(await count(`SELECT 1 FROM cl.users WHERE username = '${OWNER.username}'`)).toBe(1);
    const again = await owner.call({
      method: 'POST',
      url: url('/demo/wipe'),
      payload: { confirm: 'DELETE' },
    });
    expect(again.statusCode).toBe(404);
  });
});
