/**
 * System routes (API.md §5.7): the health page data, and the backup banner for every device. Diagnostics only; no business data.
 * When the database is down this route cannot authenticate the caller and answers
 * 503 DATABASE_UNAVAILABLE; the page then shows that state from public /health/ready.
 */
import type { FastifyInstance } from 'fastify';
import type { HealthMonitor } from '../../platform/health.ts';

export interface SystemRouteOptions {
  health: HealthMonitor;
}

export async function systemRoutes(
  app: FastifyInstance,
  options: SystemRouteOptions,
): Promise<void> {
  app.get('/system/health', { config: { permission: 'system.health' } }, async () =>
    options.health.system(),
  );
  // Every signed-in device shows a backup problem (AT-80): the problem and its words only.
  app.get('/system/backup-status', async () => options.health.backupBanner());
}
