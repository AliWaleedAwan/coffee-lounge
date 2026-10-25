/**
 * Every customer (guest) API route, in one place: used by the API service (main.ts) and
 * by tests. Nothing here needs a staff login; guests are known by their cookies only.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { customerFloorRoutes } from './modules/floor/index.ts';
import { customerLiveRoutes, type LiveRouteOptions } from './modules/live/index.ts';
import { customerOrderRoutes } from './modules/orders/index.ts';
import { AppError } from './platform/errors.ts';
import { RequestLimiter } from './platform/rate-limit.ts';

export interface CustomerRouteDeps {
  pool: pg.Pool;
  /** Clock for entry cookies and promotions (tests). */
  now?: () => Date;
  /** Requests per minute per IP (API.md §2: 60); guest submissions per minute (10). */
  limits?: { perIp?: number; submissions?: number };
  /** The live-update hub: guest phones get `GET /events` (step 3.11). */
  hub?: LiveRouteOptions['hub'];
  live?: Pick<LiveRouteOptions, 'heartbeatMs' | 'revalidateMs'>;
}

export async function registerCustomerRoutes(
  app: FastifyInstance,
  deps: CustomerRouteDeps,
): Promise<void> {
  const perIp = new RequestLimiter(deps.limits?.perIp ?? 60, 60_000);
  app.addHook('onRequest', async (request, reply) => {
    const wait = perIp.take(request.ip);
    if (wait > 0) {
      void reply.header('Retry-After', String(Math.ceil(wait / 1000)));
      throw new AppError(
        'RATE_LIMITED',
        'Too many requests from this phone. Please wait a moment.',
      );
    }
  });
  const clock = deps.now ? { now: deps.now } : {};
  await customerFloorRoutes(app, { pool: deps.pool, ...clock });
  await customerOrderRoutes(app, {
    pool: deps.pool,
    ...clock,
    ...(deps.limits?.submissions ? { submissionsPerMinute: deps.limits.submissions } : {}),
  });
  if (deps.hub) {
    await customerLiveRoutes(app, { pool: deps.pool, hub: deps.hub, ...deps.live, ...clock });
  }
}
