/**
 * Every customer (guest) API route, in one place: used by the API service (main.ts) and
 * by tests. Nothing here needs a staff login; guests are known by their cookies only.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { customerFloorRoutes } from './modules/floor/index.ts';

export interface CustomerRouteDeps {
  pool: pg.Pool;
  /** Clock for entry cookies and promotions (tests). */
  now?: () => Date;
}

export async function registerCustomerRoutes(
  app: FastifyInstance,
  deps: CustomerRouteDeps,
): Promise<void> {
  await customerFloorRoutes(app, { pool: deps.pool, ...(deps.now ? { now: deps.now } : {}) });
}
