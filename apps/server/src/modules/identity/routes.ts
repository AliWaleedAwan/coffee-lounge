/**
 * Staff identity routes (API.md §5.2 plus user/permission administration, RBAC.md).
 * Registered inside the staff API scope after registerStaffAuth.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import { AppError } from '../../platform/errors.ts';
import { FailureThrottle } from '../../platform/rate-limit.ts';
import { parseInput } from '../../platform/validation.ts';
import {
  authOf,
  clearSessionCookie,
  deviceOf,
  factsOf,
  setDeviceCookie,
  setSessionCookie,
} from './http.ts';
import { describePermissions, loadEffectivePermissions } from './permissions.ts';
import * as identity from './service.ts';

const MINUTE = 60_000;
const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const username = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, . _ - only');
const deviceKind = z.enum(identity.DEVICE_KINDS);
const ownership = z.enum(['shop', 'personal']);
const reason = z.string().trim().min(3).max(200);

async function meFor(db: Queryable, auth: identity.AuthContext) {
  const { rows } = await db.query<{ roles: string[]; limit: string | null }>(
    `SELECT COALESCE(array_agg(r.key ORDER BY r.key), '{}') AS roles,
            max(l.max_percent)::text AS limit
       FROM cl.user_roles ur
       JOIN cl.roles r ON r.id = ur.role_id
       LEFT JOIN cl.role_discount_limits l ON l.role_id = r.id
      WHERE ur.user_id = $1`,
    [auth.user.id],
  );
  return {
    user: { id: auth.user.id, name: auth.user.displayName, username: auth.user.username },
    roles: rows[0]?.roles ?? [],
    permissions: describePermissions(auth.permissions),
    discountLimitPercent: rows[0]?.limit ?? null,
    device: auth.device,
    mustChangePassword: auth.user.mustChangePassword,
  };
}

/**
 * Runs an attempt that can fail by guessing (wrong code, password or PIN). Refuses while
 * the caller is over the failure limit; counts the attempt only if it fails that way.
 */
async function guarded<T>(
  throttle: FailureThrottle,
  request: FastifyRequest,
  reply: FastifyReply,
  attempt: () => Promise<T>,
): Promise<T> {
  const waitMs = throttle.blockedFor(request.ip);
  if (waitMs > 0) {
    void reply.header('Retry-After', String(Math.ceil(waitMs / 1000)));
    throw new AppError(
      'RATE_LIMITED',
      'Too many failed attempts from this device. Wait and try again.',
    );
  }
  try {
    return await attempt();
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === 'UNAUTHENTICATED' || error.code === 'VALIDATION_FAILED')
    ) {
      throttle.recordFailure(request.ip);
    }
    throw error;
  }
}

export interface IdentityRouteOptions {
  pool: pg.Pool;
  secureCookies: boolean;
}

export async function identityRoutes(
  app: FastifyInstance,
  options: IdentityRouteOptions,
): Promise<void> {
  const { pool, secureCookies } = options;
  const registerThrottle = new FailureThrottle(10, 10 * MINUTE);
  const loginThrottle = new FailureThrottle(30, 10 * MINUTE);
  const stepUpThrottle = new FailureThrottle(20, 10 * MINUTE);

  // ------------------------------------------------------------ devices
  app.post(
    '/devices/registration-codes',
    { config: { permission: 'devices.manage' } },
    async (request, reply) => {
      const body = parseInput(
        z
          .object({ deviceName: z.string().trim().min(1).max(60), kind: deviceKind, ownership })
          .strict(),
        request.body,
      );
      const auth = authOf(request);
      const result = await identity.createRegistrationCode(
        pool,
        {
          actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
          userId: auth.user.id,
        },
        body,
        factsOf(request),
      );
      return reply.code(201).send(result);
    },
  );

  app.post('/devices/register', { config: { auth: 'public' } }, async (request, reply) => {
    const { token, device } = await guarded(registerThrottle, request, reply, () => {
      const body = parseInput(
        z.object({ code: z.string().regex(/^\d{8}$/) }).strict(),
        request.body,
      );
      return identity.registerDevice(pool, body.code, factsOf(request));
    });
    setDeviceCookie(reply, token, secureCookies);
    return reply.code(201).send(device);
  });

  app.get('/devices', { config: { permission: 'devices.manage' } }, async () => ({
    items: await identity.listDevices(pool),
  }));

  app.post(
    '/devices/:deviceId/revoke',
    { config: { permission: 'devices.manage' } },
    async (request) => {
      const params = parseInput(z.object({ deviceId: id }), request.params);
      return identity.revokeDevice(pool, authOf(request), params.deviceId, factsOf(request));
    },
  );

  // ------------------------------------------------------------ sessions
  app.post('/auth/login', { config: { auth: 'device' } }, async (request, reply) => {
    const body = parseInput(
      z.object({ username, password: z.string().min(1).max(128) }).strict(),
      request.body,
    );
    const { token, userId } = await guarded(loginThrottle, request, reply, () =>
      identity.login(pool, deviceOf(request), body, factsOf(request)),
    );
    setSessionCookie(reply, token, secureCookies);
    return meFor(pool, await contextFor(pool, request, token, userId));
  });

  app.post('/auth/pin-switch', { config: { auth: 'device' } }, async (request, reply) => {
    const body = parseInput(
      z.object({ username, pin: z.string().regex(/^\d{4,6}$/) }).strict(),
      request.body,
    );
    const { token, userId } = await guarded(loginThrottle, request, reply, () =>
      identity.pinSwitch(pool, deviceOf(request), body, factsOf(request)),
    );
    setSessionCookie(reply, token, secureCookies);
    return meFor(pool, await contextFor(pool, request, token, userId));
  });

  app.post('/auth/logout', async (request, reply) => {
    await identity.logout(pool, authOf(request), factsOf(request));
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request) => meFor(pool, authOf(request)));

  app.post('/auth/password', async (request, reply) => {
    const body = parseInput(
      z
        .object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().max(128) })
        .strict(),
      request.body,
    );
    await identity.changePassword(pool, authOf(request), body, factsOf(request));
    return reply.code(204).send();
  });

  app.post('/auth/pin', async (request, reply) => {
    const body = parseInput(
      z.object({ password: z.string().min(1).max(128), pin: z.string() }).strict(),
      request.body,
    );
    await identity.setOwnPin(pool, authOf(request), body, factsOf(request));
    return reply.code(204).send();
  });

  app.post('/auth/step-up', async (request, reply) => {
    const actions = Object.keys(identity.STEP_UP_ACTIONS) as [
      identity.StepUpAction,
      ...identity.StepUpAction[],
    ];
    const body = parseInput(
      z
        .object({
          action: z.enum(actions),
          entityType: z.string().regex(/^[a-z_]{2,40}$/),
          entityId: id,
          approverUsername: username,
          approverPin: z.string().regex(/^\d{4,6}$/),
          reason,
        })
        .strict(),
      request.body,
    );
    const result = await guarded(stepUpThrottle, request, reply, () =>
      identity.createStepUp(pool, authOf(request), body, factsOf(request)),
    );
    return reply.code(201).send(result);
  });

  // ------------------------------------------------------------ users and permissions
  app.get('/users', { config: { permission: 'users.manage' } }, async () => ({
    items: await identity.listUsers(pool),
  }));

  app.post('/users', { config: { permission: 'users.manage' } }, async (request, reply) => {
    const body = parseInput(
      z
        .object({
          username,
          displayName: z.string().trim().min(1).max(60),
          password: z.string().max(128),
          pin: z.string().optional(),
          roles: z
            .array(z.string().regex(/^[a-z_]+$/))
            .min(1)
            .max(6),
        })
        .strict(),
      request.body,
    );
    const result = await identity.createUser(pool, authOf(request), body, factsOf(request));
    return reply.code(201).send(result);
  });

  app.post(
    '/users/:userId/status',
    { config: { permission: 'users.manage' } },
    async (request, reply) => {
      const params = parseInput(z.object({ userId: id }), request.params);
      const body = parseInput(
        z.object({ status: z.enum(['active', 'disabled']) }).strict(),
        request.body,
      );
      await identity.setUserStatus(
        pool,
        authOf(request),
        params.userId,
        body.status,
        factsOf(request),
      );
      return reply.code(204).send();
    },
  );

  app.get(
    '/users/:userId/effective-permissions',
    { config: { permission: 'users.manage' } },
    async (request) => {
      const params = parseInput(z.object({ userId: id }), request.params);
      return {
        permissions: describePermissions(await loadEffectivePermissions(pool, params.userId)),
      };
    },
  );

  app.put(
    '/users/:userId/permission-overrides/:permissionKey',
    { config: { permission: 'roles.manage' } },
    async (request, reply) => {
      const params = parseInput(
        z.object({ userId: id, permissionKey: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/) }),
        request.params,
      );
      const body = parseInput(
        z.object({ effect: z.enum(['grant', 'deny']), reason }).strict(),
        request.body,
      );
      await identity.setPermissionOverride(
        pool,
        authOf(request),
        { ...params, ...body },
        factsOf(request),
      );
      return reply.code(204).send();
    },
  );

  app.delete(
    '/users/:userId/permission-overrides/:permissionKey',
    { config: { permission: 'roles.manage' } },
    async (request, reply) => {
      const params = parseInput(
        z.object({ userId: id, permissionKey: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/) }),
        request.params,
      );
      const query = parseInput(z.object({ reason }), request.query);
      await identity.removePermissionOverride(
        pool,
        authOf(request),
        { ...params, ...query },
        factsOf(request),
      );
      return reply.code(204).send();
    },
  );
}

/** Builds the auth context right after login (the preHandler ran before the session existed). */
async function contextFor(
  pool: pg.Pool,
  request: FastifyRequest,
  token: string,
  userId: string,
): Promise<identity.AuthContext> {
  const device = deviceOf(request);
  const session = await identity.sessionForToken(pool, token, device);
  if (!session || session.user.id !== userId) throw new Error('session missing right after login');
  return { ...session, device, permissions: await loadEffectivePermissions(pool, userId) };
}
