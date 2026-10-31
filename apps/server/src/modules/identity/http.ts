/**
 * Staff authentication for HTTP (API.md §2, §4; RBAC.md §1):
 *  - every staff route needs a registered device; most need a session (deny by default)
 *  - a route declares `config: { auth, permission }`; the permission is checked here
 *  - mutations need the X-CL-Request header and a same-origin Origin (CSRF)
 */
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { AppError } from '../../platform/errors.ts';
import { loadEffectivePermissions } from './permissions.ts';
import {
  auditAccessDenied,
  deviceForToken,
  sessionForToken,
  type AuthContext,
  type DeviceInfo,
  type RequestFacts,
} from './service.ts';

export const DEVICE_COOKIE = 'cl_device';
export const SESSION_COOKIE = 'cl_session';
/** Sent by clients on reads the user did not trigger (refetch after a live hint). */
export const BACKGROUND_HEADER = 'x-cl-background';
export const CSRF_HEADER = 'x-cl-request';
const DEVICE_COOKIE_MAX_AGE_S = 5 * 365 * 24 * 3600;

/** Route-level access declaration. */
export interface AccessConfig {
  /** public: anyone; device: a registered device; session (default): a logged-in user. */
  auth?: 'public' | 'device' | 'session';
  /** Required permission key (implies a session). */
  permission?: string;
  /** A second permission needed as well (e.g. `reports.export` on a report's export). */
  alsoNeeds?: string;
}

declare module 'fastify' {
  // Declaration merging needs an interface; it adds the AccessConfig fields to route config.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface FastifyContextConfig extends AccessConfig {}
  interface FastifyRequest {
    device: DeviceInfo | null;
    auth: AuthContext | null;
  }
}

export interface StaffAuthOptions {
  pool: pg.Pool;
  /** Set Secure on cookies (true when the staff listener uses HTTPS). */
  secureCookies: boolean;
}

export function factsOf(request: FastifyRequest): RequestFacts {
  return { correlationId: request.id, ip: request.ip };
}

/** The authenticated context; throws if the route forgot to require a session. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError('UNAUTHENTICATED', 'Please log in');
  return request.auth;
}

export function deviceOf(request: FastifyRequest): DeviceInfo {
  if (!request.device) throw new AppError('DEVICE_NOT_REGISTERED', 'This device is not registered');
  return request.device;
}

export function setDeviceCookie(reply: FastifyReply, token: string, secure: boolean): void {
  void reply.setCookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE_S,
  });
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function checkCsrf(request: FastifyRequest): void {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
  if (request.headers[CSRF_HEADER] !== '1') {
    throw new AppError('FORBIDDEN', 'Missing X-CL-Request header');
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    const expected = `${request.protocol}://${request.host}`;
    if (origin !== expected) throw new AppError('FORBIDDEN', 'Cross-origin request refused');
  }
}

/** Registers cookie parsing and the auth/permission hooks on the staff API scope. */
export async function registerStaffAuth(
  app: FastifyInstance,
  options: StaffAuthOptions,
): Promise<void> {
  await app.register(cookie);
  app.decorateRequest('device', null);
  app.decorateRequest('auth', null);

  app.addHook('preHandler', async (request) => {
    checkCsrf(request);
    const config = request.routeOptions.config;
    const level = config.permission ? 'session' : (config.auth ?? 'session');
    if (level === 'public') return;

    const deviceToken = request.cookies[DEVICE_COOKIE];
    const device = deviceToken ? await deviceForToken(options.pool, deviceToken) : null;
    if (!device)
      throw new AppError(
        'DEVICE_NOT_REGISTERED',
        'This device is not registered. Ask a manager for a registration code.',
      );
    request.device = device;
    if (level === 'device') return;

    const sessionToken = request.cookies[SESSION_COOKIE];
    // Only reads may be background; any write is user activity.
    const background = request.method === 'GET' && request.headers[BACKGROUND_HEADER] === '1';
    const session = sessionToken
      ? await sessionForToken(options.pool, sessionToken, device, { extend: !background })
      : null;
    if (!session) throw new AppError('UNAUTHENTICATED', 'Please log in');
    const permissions = await loadEffectivePermissions(options.pool, session.user.id);
    request.auth = { ...session, device, permissions };

    for (const needed of [config.permission, config.alsoNeeds]) {
      if (!needed || permissions.has(needed)) continue;
      await auditAccessDenied(options.pool, request.auth, factsOf(request), {
        permission: needed,
        route: `${request.method} ${request.routeOptions.url ?? request.url}`,
      });
      throw new AppError('FORBIDDEN', `You need the ${needed} permission for this`);
    }
  });
}
