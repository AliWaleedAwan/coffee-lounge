/**
 * Every staff API route, in one place: used by the API service (main.ts) and by tests,
 * so the route × role matrix (SEC-ALL) always sees the routes that ship.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { billingRoutes } from './modules/billing/index.ts';
import { catalogRoutes } from './modules/catalog/index.ts';
import { floorRoutes } from './modules/floor/index.ts';
import { orderRoutes } from './modules/orders/index.ts';
import { printingRoutes } from './modules/printing/index.ts';
import { registerStaffIdentity } from './modules/identity/index.ts';
import { liveRoutes, type LiveRouteOptions } from './modules/live/index.ts';
import { systemRoutes } from './modules/system/index.ts';
import type { HealthMonitor } from './platform/health.ts';
import type { LiveHub } from './platform/live-hub.ts';

export interface StaffRouteDeps {
  pool: pg.Pool;
  secureCookies: boolean;
  hub: LiveHub;
  health: HealthMonitor;
  /** Stream timing overrides (tests). */
  live?: Pick<LiveRouteOptions, 'heartbeatMs' | 'revalidateMs'>;
  /** Clock for time-dependent reads such as promotions (tests). */
  now?: () => Date;
  /** Base of the QR links (`http://<shop address>:8080`); default: this PC's LAN address. */
  guestBaseUrl?: string | undefined;
  customerPort?: number | undefined;
}

export async function registerStaffRoutes(
  app: FastifyInstance,
  deps: StaffRouteDeps,
): Promise<void> {
  await registerStaffIdentity(app, { pool: deps.pool, secureCookies: deps.secureCookies });
  await liveRoutes(app, { pool: deps.pool, hub: deps.hub, ...deps.live });
  await systemRoutes(app, { health: deps.health });
  await catalogRoutes(app, { pool: deps.pool, ...(deps.now ? { now: deps.now } : {}) });
  await floorRoutes(app, {
    pool: deps.pool,
    guestBaseUrl: deps.guestBaseUrl,
    customerPort: deps.customerPort,
    ...(deps.now ? { now: deps.now } : {}),
  });
  await orderRoutes(app, { pool: deps.pool, ...(deps.now ? { now: deps.now } : {}) });
  await printingRoutes(app, { pool: deps.pool });
  await billingRoutes(app, { pool: deps.pool, ...(deps.now ? { now: deps.now } : {}) });
}
