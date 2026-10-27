/** Audit log routes (API.md §5.13; Phase 5 step 5.5): read only, `audit.read`. */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../platform/errors.ts';
import { parseInput } from '../../platform/validation.ts';
import { auditFilters, readAudit } from './service.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export async function auditRoutes(app: FastifyInstance, options: { pool: pg.Pool }): Promise<void> {
  const { pool } = options;
  const read = { config: { permission: 'audit.read' } };

  app.get('/audit', read, async (request) => {
    const query = parseInput(
      z
        .object({
          from: localDate.optional(),
          to: localDate.optional(),
          userId: id.optional(),
          action: z
            .string()
            .regex(/^[a-z_]+(\.[a-z_]+)*$/)
            .optional(),
          entityType: z
            .string()
            .regex(/^[a-z_]+$/)
            .optional(),
          entityId: id.optional(),
          before: id.optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .strict(),
      request.query,
    );
    if (query.from && query.to && query.from > query.to) {
      throw new AppError('VALIDATION_FAILED', 'The start date is after the end date');
    }
    return readAudit(pool, query);
  });

  app.get('/audit/filters', read, async () => auditFilters(pool));
}
