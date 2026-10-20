/**
 * Identity test helpers: a staff app with identity installed, an owner, registered
 * devices and logged-in users per role, and an inject wrapper that carries cookies and
 * the CSRF header the way a real staff client does.
 */
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import {
  createOwner,
  createRegistrationCode,
  type DeviceKind,
} from '../../src/modules/identity/index.ts';
import { hashSecret } from '../../src/modules/identity/secrets.ts';
import { HealthMonitor, type HealthProbes } from '../../src/platform/health.ts';
import { LiveHub } from '../../src/platform/live-hub.ts';
import type { Readiness } from '../../src/platform/readiness.ts';
import { registerStaffRoutes, type StaffRouteDeps } from '../../src/staff-routes.ts';
import { passedReadiness, platformFixture, readyApps, type PlatformFixture } from './platform.ts';

export const OWNER = { username: 'owner', password: 'owner-password-1' };
export const STAFF_PASSWORD = 'staff-password-1';
const facts = { correlationId: '00000000-0000-4000-8000-000000000000' };

export interface Client {
  cookies: Record<string, string>;
  call(options: InjectOptions & { csrf?: boolean }): Promise<LightMyRequestResponse>;
}

export interface CollectedRoute {
  method: string;
  url: string;
  config: { auth?: string; permission?: string };
}

export interface FixtureOptions {
  /** The hub behind GET /events (default: one that is never started). */
  makeHub?: (pool: PlatformFixture['pool']) => LiveHub;
  live?: StaffRouteDeps['live'];
  /** Health probe overrides; the internet probe is always stubbed offline unless given. */
  probes?: Partial<HealthProbes>;
  /** Run every query with only the application role's privileges. */
  sessionRole?: 'cl_app';
}

export interface IdentityFixture extends PlatformFixture {
  staff: FastifyInstance;
  readiness: Readiness;
  hub: LiveHub;
  health: HealthMonitor;
  /** Every staff route registered in the API scope, with its access declaration. */
  routes: CollectedRoute[];
  ownerId: string;
  recoveryCode: string;
  /** Registers a new device through the API and returns a client holding its cookie. */
  newDevice(kind?: DeviceKind, name?: string): Promise<Client>;
  /** Creates a user with the given roles (and optional PIN) directly in the database. */
  addUser(
    username: string,
    roles: string[],
    options?: { pin?: string; mustChange?: boolean },
  ): Promise<string>;
  /** New device + password login. */
  loggedIn(username: string, password?: string, kind?: DeviceKind): Promise<Client>;
}

export function cookiesFrom(res: LightMyRequestResponse): Record<string, string> {
  return Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
}

function clientFor(app: FastifyInstance, initial: Record<string, string> = {}): Client {
  const client: Client = {
    cookies: { ...initial },
    async call(options) {
      const headers: Record<string, string> = {
        ...(options.headers as Record<string, string> | undefined),
      };
      const method = (options.method ?? 'GET').toUpperCase();
      if (options.csrf !== false && method !== 'GET') headers['x-cl-request'] = '1';
      const res = await app.inject({ ...options, headers, cookies: client.cookies });
      for (const c of res.cookies) {
        if (c.value === '') Reflect.deleteProperty(client.cookies, c.name);
        else client.cookies[c.name] = c.value;
      }
      return res;
    },
  };
  return client;
}

export async function identityFixture(options: FixtureOptions = {}): Promise<IdentityFixture> {
  const base = await platformFixture(20, options.sessionRole);
  const routes: CollectedRoute[] = [];
  const hub =
    options.makeHub?.(base.pool) ??
    new LiveHub({
      pool: base.pool,
      connectListener: () => Promise.reject(new Error('not started in this test')),
    });
  const readiness = passedReadiness();
  const health = new HealthMonitor({
    db: base.pool,
    readiness,
    probes: { internet: () => Promise.resolve('offline'), ...options.probes },
  });
  const { staff } = readyApps(
    base.pool,
    {
      staff: async (app) => {
        app.addHook('onRoute', (route) => {
          const methods = Array.isArray(route.method) ? route.method : [route.method];
          for (const method of methods) {
            if (method === 'HEAD') continue;
            routes.push({
              method,
              url: route.url,
              config: route.config ?? {},
            });
          }
        });
        await registerStaffRoutes(app, {
          pool: base.pool,
          secureCookies: false,
          hub,
          health,
          ...(options.live ? { live: options.live } : {}),
        });
      },
    },
    readiness,
    health,
  );
  await staff.ready();
  const { userId: ownerId, recoveryCode } = await createOwner(
    base.pool,
    { ...OWNER, displayName: 'Owner' },
    facts,
  );

  const newDevice = async (
    kind: DeviceKind = 'waiter',
    name = `${kind} device`,
  ): Promise<Client> => {
    const { code } = await createRegistrationCode(
      base.pool,
      { actor: { kind: 'system' }, userId: ownerId },
      { deviceName: name, kind, ownership: 'shop' },
      facts,
    );
    const client = clientFor(staff);
    const res = await client.call({
      method: 'POST',
      url: '/api/staff/v1/devices/register',
      payload: { code },
    });
    if (res.statusCode !== 201) throw new Error(`device registration failed: ${res.body}`);
    return client;
  };

  return {
    ...base,
    staff,
    readiness,
    hub,
    health,
    routes,
    ownerId,
    recoveryCode,
    newDevice,
    async addUser(username, roles, options = {}) {
      const passwordHash = await hashSecret(STAFF_PASSWORD);
      const pinHash = options.pin ? await hashSecret(options.pin) : null;
      const { rows } = await base.pool.query<{ id: string }>(
        `INSERT INTO cl.users (username, display_name, password_hash, pin_hash, is_owner, must_change_password)
         VALUES ($1, $1, $2, $3, $4, $5) RETURNING id::text`,
        [username, passwordHash, pinHash, roles.includes('owner'), options.mustChange ?? false],
      );
      const id = rows[0]?.id ?? '';
      await base.pool.query(
        'INSERT INTO cl.user_roles (user_id, role_id) SELECT $1, id FROM cl.roles WHERE key = ANY($2::text[])',
        [id, roles],
      );
      return id;
    },
    async loggedIn(username, password = STAFF_PASSWORD, kind = 'reception') {
      const client = await newDevice(kind);
      const res = await client.call({
        method: 'POST',
        url: '/api/staff/v1/auth/login',
        payload: { username, password },
      });
      if (res.statusCode !== 200) throw new Error(`login failed for ${username}: ${res.body}`);
      return client;
    },
  };
}
