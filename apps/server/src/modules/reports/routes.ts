/**
 * Report routes (API.md §5.14; Phase 6 step 6.1). Each report is its own route with its own
 * permission, so the route × role matrix covers every one; `GET /reports` lists those the
 * caller may open. Without a period, a report covers this business month to today.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { businessDateOf } from '../../platform/settings.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf } from '../identity/index.ts';
import { REPORTS } from './catalog.ts';
import { runReport, type ReportDefinition } from './engine.ts';
import { overview } from './overview.ts';
import { checkPeriod, monthOf } from './periods.ts';
import { AppError } from '../../platform/errors.ts';

/** Names for the footer instead of ids (FINANCE_REPORTING.md §6). */
async function filterLabels(
  pool: pg.Pool,
  filters: Record<string, unknown>,
): Promise<Record<string, string>> {
  const labels: Record<string, string> = {};
  if (typeof filters['categoryId'] === 'string') {
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM cl.menu_categories WHERE id = $1',
      [filters['categoryId']],
    );
    if (rows[0]) labels['categoryId'] = rows[0].name;
  }
  if (typeof filters['itemId'] === 'string') {
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM cl.menu_items WHERE id = $1',
      [filters['itemId']],
    );
    if (rows[0]) labels['itemId'] = rows[0].name;
  }
  return labels;
}

export async function reportRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; now?: () => Date },
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());

  app.get('/reports', async (request) => {
    const permissions = authOf(request).permissions;
    return {
      items: REPORTS.filter((r) => permissions.has(r.permission)).map((r) => ({
        key: r.key,
        title: r.title,
        profitColumns: permissions.has('reports.profit'),
      })),
    };
  });

  // The owner overview (step 6.2): its tiles are the totals of the reports they open.
  app.get('/reports/overview', { config: { permission: 'reports.sales' } }, async (request) => {
    const today = await businessDateOf(pool, now());
    const query = request.query as Record<string, unknown>;
    const from = typeof query['from'] === 'string' ? query['from'] : today;
    const to = typeof query['to'] === 'string' ? query['to'] : today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new AppError('VALIDATION_FAILED', 'Dates as YYYY-MM-DD');
    }
    const period = checkPeriod({ from, to });
    const permissions = authOf(request).permissions;
    return overview(pool, { db: pool, can: (p) => permissions.has(p), today }, period);
  });

  const register = <F extends { from: string; to: string }>(def: ReportDefinition<F>) => {
    app.get(
      `/reports/${def.key}`,
      { config: { permission: def.permission } },
      async (request: FastifyRequest) => {
        const today = await businessDateOf(pool, now());
        const query = { ...(request.query as Record<string, unknown>) };
        const month = monthOf(today);
        query['from'] ??= month.from;
        query['to'] ??= today;
        const filters = parseInput(def.filters, query);
        checkPeriod(filters);
        const permissions = authOf(request).permissions;
        return runReport(
          def,
          { db: pool, can: (p) => permissions.has(p), today },
          filters,
          await filterLabels(pool, filters as Record<string, unknown>),
        );
      },
    );
  };
  for (const def of REPORTS) register(def);
}
