/** Live operations for managers (API.md §5.9): the figures and the inbox, and noting an alert. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../platform/db/tx.ts';
import { parseInput } from '../../platform/validation.ts';
import { acknowledgeAlert, liveOperations } from './service.ts';

const idParam = (request: FastifyRequest) =>
  parseInput(z.object({ id: z.string().regex(/^\d{1,18}$/) }), request.params).id;

export async function operationsRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; now?: () => Date },
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());

  app.get('/operations', { config: { permission: 'reports.sales' } }, async () =>
    liveOperations(pool, now()),
  );

  app.post(
    '/alerts/:id/acknowledge',
    { config: { permission: 'reports.sales' } },
    async (request) => {
      const alertId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      return withTransaction(pool, (tx) => acknowledgeAlert(tx, alertId));
    },
  );
}
