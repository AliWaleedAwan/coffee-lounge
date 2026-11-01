/**
 * Menu item photos: a JPEG or PNG of at most 2 MB, kept in FILES_DIR/menu; the type comes
 * from the bytes; the staff and guest menus give its address; the photo is served without
 * login; removing it keeps the file and both changes are audited.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let itemId: string;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('rest of a png'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a jpeg')]);

const put = (body: Buffer, type = 'image/png', client = owner) =>
  client.call({
    method: 'PUT',
    url: `/api/staff/v1/menu/items/${itemId}/photo`,
    headers: { 'content-type': type },
    payload: body,
  });
const catalogItem = async () => {
  const res = await owner.call({ method: 'GET', url: '/api/staff/v1/menu/catalog' });
  const menu = res.json<{ categories: { items: { id: string; imageUrl: string | null }[] }[] }>();
  return menu.categories.flatMap((c) => c.items).find((i) => i.id === itemId);
};

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  const cat = await owner.call({
    method: 'POST',
    url: '/api/staff/v1/menu/categories',
    payload: { name: 'Photo test' },
  });
  const item = await owner.call({
    method: 'POST',
    url: '/api/staff/v1/menu/items',
    payload: {
      categoryId: cat.json<{ id: string }>().id,
      name: 'Plain Fries',
      variants: [{ name: 'Regular', price: '250' }],
    },
  });
  itemId = item.json<{ id: string }>().id;
});
afterAll(async () => {
  await fx.close();
});

describe('menu item photos', () => {
  it('keeps a PNG on disk, shows its address on the menu and serves it to guests without login', async () => {
    const res = await put(PNG);
    expect(res.statusCode, res.body).toBe(200);
    const { imageUrl } = res.json<{ imageUrl: string }>();
    expect(imageUrl).toMatch(new RegExp(`^menu-photos/${itemId}-[0-9a-f]{12}\\.png$`));
    expect((await catalogItem())?.imageUrl).toBe(imageUrl);
    const served = await fx.customer.inject({ method: 'GET', url: `/api/customer/v1/${imageUrl}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.rawPayload.equals(PNG)).toBe(true);
    expect((await owner.call({ method: 'GET', url: `/api/staff/v1/${imageUrl}` })).statusCode).toBe(
      200,
    );
    const anonymous = await fx.staff.inject({ method: 'GET', url: `/api/staff/v1/${imageUrl}` });
    expect(anonymous.statusCode).toBeGreaterThanOrEqual(401);
  });

  it('takes the type from the bytes and refuses anything else, or a file over 2 MB', async () => {
    expect((await put(JPEG, 'image/png')).json<{ imageUrl: string }>().imageUrl).toMatch(/\.jpg$/);
    expect((await put(Buffer.from('<svg/>'), 'image/png')).statusCode).toBe(400);
    const big = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await put(big, 'image/jpeg')).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses addresses outside the photo folder', async () => {
    for (const bad of [
      '..%2F..%2Fsecret.png',
      '1-zzzzzzzzzzzz.png',
      `${itemId}-000000000000.gif`,
    ]) {
      const res = await fx.customer.inject({
        method: 'GET',
        url: `/api/customer/v1/menu-photos/${bad}`,
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('needs menu.manage, and removing keeps the file and audits both changes', async () => {
    await fx.addUser('ph-waiter', ['waiter']);
    const waiter = await fx.loggedIn('ph-waiter');
    expect((await put(PNG, 'image/png', waiter)).statusCode).toBe(403);
    const url = (await catalogItem())?.imageUrl ?? '';
    const res = await owner.call({
      method: 'DELETE',
      url: `/api/staff/v1/menu/items/${itemId}/photo`,
    });
    expect(res.statusCode).toBe(204);
    expect((await catalogItem())?.imageUrl).toBeNull();
    expect(existsSync(join(fx.filesDir, 'menu', url.slice('menu-photos/'.length)))).toBe(true);
    const { rows } = await fx.pool.query<{ action: string }>(
      `SELECT action FROM cl.audit_events WHERE entity_id = $1 AND action LIKE 'menu_item.photo%' ORDER BY id`,
      [itemId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'menu_item.photo',
      'menu_item.photo',
      'menu_item.photo_removed',
    ]);
  });
});
