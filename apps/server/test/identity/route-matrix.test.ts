/**
 * SEC-ALL (TEST_PLAN.md §5.6): every staff route × every role. Routes are collected as
 * they register, so routes added in later phases are covered without editing this file.
 * Path parameters use an id that does not exist and bodies are empty, so permitted calls
 * fail validation or lookup instead of changing anything.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

const ROLES = ['owner', 'manager', 'waiter', 'cashier', 'inventory_clerk', 'kitchen'] as const;

let fx: IdentityFixture;
const clients = new Map<string, { client: Client; permissions: Set<string> }>();

beforeAll(async () => {
  fx = await identityFixture();
  for (const role of ROLES) {
    const username = role === 'owner' ? OWNER.username : `matrix_${role}`;
    if (role !== 'owner') await fx.addUser(username, [role]);
    const client =
      role === 'owner'
        ? await fx.loggedIn(OWNER.username, OWNER.password)
        : await fx.loggedIn(username);
    const me = await client.call({ url: '/api/staff/v1/auth/me' });
    const permissions = new Set(
      me.json<{ permissions: { key: string }[] }>().permissions.map((p) => p.key),
    );
    clients.set(role, { client, permissions });
  }
});
afterAll(async () => {
  await fx.close();
});

const concrete = (url: string): string =>
  url.replace(/:[A-Za-z]+/g, (p) => (p === ':permissionKey' ? 'menu.read' : '999999'));
const isForbidden = (res: LightMyRequestResponse): boolean =>
  res.statusCode === 403 && res.json<{ code: string }>().code === 'FORBIDDEN';

describe('route × role matrix (SEC-ALL)', () => {
  it('collects the staff routes', () => {
    expect(fx.routes.length).toBeGreaterThanOrEqual(15);
  });

  it('refuses every role that lacks the route permission, and only those', async () => {
    const results: string[] = [];
    for (const route of fx.routes.filter((r) => r.config.permission)) {
      const permission = route.config.permission ?? '';
      for (const role of ROLES) {
        const entry = clients.get(role);
        if (!entry) throw new Error(`no client for ${role}`);
        const res = await entry.client.call({
          method: route.method,
          url: concrete(route.url),
          ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
        });
        const allowed = entry.permissions.has(permission);
        results.push(`${route.method} ${route.url} ${role}`);
        expect(
          isForbidden(res),
          `${route.method} ${route.url} as ${role} (${allowed ? 'has' : 'lacks'} ${permission}): ${res.body}`,
        ).toBe(!allowed);
      }
    }
    expect(results.length).toBeGreaterThan(50);
  });

  it('requires a registered device on every non-public route, and a session where declared', async () => {
    const device = await fx.newDevice();
    for (const route of fx.routes) {
      const level = route.config.permission ? 'session' : (route.config.auth ?? 'session');
      if (level === 'public') continue;
      const target = concrete(route.url);
      const payload = route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} };

      const anonymous = await fx.staff.inject({
        method: route.method as 'GET',
        url: target,
        headers: { 'x-cl-request': '1' },
        ...payload,
      });
      expect(anonymous.statusCode, `${route.method} ${route.url} without device`).toBe(403);
      expect(anonymous.json(), route.url).toMatchObject({ code: 'DEVICE_NOT_REGISTERED' });

      if (level === 'session') {
        const noSession = await device.call({
          method: route.method,
          url: target,
          ...payload,
        });
        expect(noSession.statusCode, `${route.method} ${route.url} without session`).toBe(401);
      }
    }
  });

  it('declares every route explicitly as public, device or session', () => {
    const publicRoutes = fx.routes
      .filter((r) => r.config.auth === 'public')
      .map((r) => `${r.method} ${r.url}`);
    expect(publicRoutes).toEqual(['POST /api/staff/v1/devices/register']);
  });
});

describe('no route forgets its permission', () => {
  it('only personal self-service routes are open to any logged-in user', () => {
    const SELF_SERVICE = [
      'POST /api/staff/v1/auth/logout',
      'GET /api/staff/v1/auth/me',
      'POST /api/staff/v1/auth/password',
      'POST /api/staff/v1/auth/pin',
      'POST /api/staff/v1/auth/step-up',
    ];
    const sessionOnly = fx.routes
      .filter((r) => !r.config.permission && (r.config.auth ?? 'session') === 'session')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(sessionOnly).toEqual([...SELF_SERVICE].sort());
  });
});
