/**
 * Report routes (API.md §5.14; Phase 6 steps 6.1 and 6.5). Each report is its own route with
 * its own permission, so the route × role matrix covers every one; `GET /reports` lists
 * those the caller may open. Without a period, a report covers this business month to
 * today. Its export (`/reports/<key>/export?format=csv|pdf`) is the same report, needing
 * `reports.export` as well, and is audited. The day-end report has its own routes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit } from '../../platform/audit.ts';
import { withTransaction } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { parseInput } from '../../platform/validation.ts';
import { counterTill } from '../billing/index.ts';
import { authOf, factsOf } from '../identity/index.ts';
import { requestPrint } from '../printing/index.ts';
import { REPORTS } from './catalog.ts';
import { completedDay, dayEndOf, dayEndView } from './day-end.ts';
import { dayEndFile, filterLabels, FORMATS, reportFile } from './files.ts';
import { runReport, type ReportDefinition } from './engine.ts';
import { overview } from './overview.ts';
import { checkPeriod, monthOf } from './periods.ts';

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export async function reportRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; now?: () => Date },
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());

  app.get('/reports', async (request) => {
    const permissions = authOf(request).permissions;
    return {
      // The shop's business date now, for the screen's "Today" (before 04:00 it is yesterday's).
      today: await businessDateOf(pool, now()),
      items: REPORTS.filter((r) => permissions.has(r.permission)).map((r) => ({
        key: r.key,
        title: r.title,
        profitColumns: permissions.has('reports.profit'),
        // The filters the report takes besides its period, for the screen to offer.
        filters: Object.keys(
          (r.filters as unknown as { shape: Record<string, unknown> }).shape,
        ).filter((k) => k !== 'from' && k !== 'to'),
        drillOnly: r.key === 'bill-lines',
        formats: r.formats ?? FORMATS,
      })),
    };
  });

  /** Names for the "settled by" filter (who took the money; no other user details). */
  app.get('/reports/staff', { config: { permission: 'reports.sales' } }, async () => {
    const { rows } = await pool.query<{ id: string; name: string }>(
      'SELECT id::text, display_name AS name FROM cl.users ORDER BY lower(display_name), users.id',
    );
    return { items: rows };
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

  const who = (request: FastifyRequest) => {
    const auth = authOf(request);
    const facts = factsOf(request);
    return {
      actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
      correlationId: facts.correlationId,
      ...(facts.ip ? { ip: facts.ip } : {}),
    };
  };
  const sendFile = (reply: FastifyReply, format: 'csv' | 'pdf', name: string, body: Buffer) =>
    reply
      .header('content-type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(body);

  const register = <F extends { from: string; to: string }>(def: ReportDefinition<F>) => {
    const prepare = async (request: FastifyRequest, extra: readonly string[] = []) => {
      const today = await businessDateOf(pool, now());
      const query = { ...(request.query as Record<string, unknown>) };
      for (const k of extra) Reflect.deleteProperty(query, k);
      const month = monthOf(today);
      query['from'] ??= month.from;
      query['to'] ??= today;
      const filters = parseInput(def.filters, query);
      checkPeriod(filters);
      const permissions = authOf(request).permissions;
      const labels = await filterLabels(pool, filters, def.key);
      const report = await runReport(
        def,
        { db: pool, can: (p) => permissions.has(p), today },
        filters,
        labels,
      );
      return { report, labels };
    };
    const config = { config: { permission: def.permission } };
    // Exports need `reports.export` besides the report's own permission (FINANCE_REPORTING.md §8).
    const exportConfig = { config: { permission: def.permission, alsoNeeds: 'reports.export' } };
    app.get(`/reports/${def.key}`, config, async (request) => (await prepare(request)).report);

    // The same report as a file (AT-103): what the screen shows, to the rupee (AC-RPT-1).
    app.get(`/reports/${def.key}/export`, exportConfig, async (request, reply) => {
      const formats = def.formats ?? FORMATS;
      const format = (request.query as Record<string, unknown>)['format'];
      if (typeof format !== 'string' || !(formats as readonly string[]).includes(format)) {
        throw new AppError('VALIDATION_FAILED', `format must be ${formats.join(' or ')}`);
      }
      const { report, labels } = await prepare(request, ['format']);
      const kind = format as (typeof FORMATS)[number];
      const { name, body } = await reportFile(pool, report, labels, kind);
      await writeAudit(pool, who(request), {
        action: 'report.export',
        entityType: 'report',
        after: {
          report: def.key,
          format: kind,
          period: report.period,
          filters: report.filters,
          rows: report.rows.length,
          file: name,
        },
      });
      return sendFile(reply, kind, name, body);
    });
  };
  // Each definition parses its own filters; the router only needs the period they share.
  for (const def of REPORTS)
    register(def as unknown as ReportDefinition<{ from: string; to: string }>);

  // ---------------------------------------------------------------- the day-end (P6-9)

  const dayEndQuery = z.object({ date: localDate.optional() }).strict();
  const sales = { config: { permission: 'reports.sales' } };
  const dayEndFor = async (date: string | undefined) => {
    const today = await businessDateOf(pool, now());
    return dayEndOf(pool, date ?? completedDay(today), today, 'on_request');
  };

  app.get('/reports/day-end', sales, async (request) => {
    const query = parseInput(dayEndQuery, request.query);
    const d = await dayEndFor(query.date);
    return {
      date: d.date,
      generatedAt: d.generatedAt,
      generatedBy: d.generatedBy,
      report: dayEndView(d.report, authOf(request).permissions.has('reports.profit')),
    };
  });

  app.get(
    '/reports/day-end/export',
    { config: { permission: 'reports.sales', alsoNeeds: 'reports.export' } },
    async (request, reply) => {
      const query = parseInput(
        z.object({ date: localDate.optional(), format: z.literal('pdf') }).strict(),
        request.query,
      );
      const d = await dayEndFor(query.date);
      const { name, body } = await dayEndFile(
        pool,
        d,
        authOf(request).permissions.has('reports.profit'),
      );
      await writeAudit(pool, who(request), {
        action: 'report.export',
        entityType: 'day_end_report',
        entityId: d.id,
        after: { report: 'day-end', format: 'pdf', date: d.date, file: name },
      });
      return sendFile(reply, 'pdf', name, body);
    },
  );

  // The 80 mm summary on the counter's receipt printer; each press is a numbered copy.
  app.post('/reports/day-end/print', sales, async (request) => {
    const body = parseInput(z.object({ date: localDate.optional() }).strict(), request.body ?? {});
    const d = await dayEndFor(body.date);
    const auth = authOf(request);
    return withTransaction(pool, async (tx) => {
      const till = await counterTill(tx);
      if (!till?.printerId) {
        throw new AppError(
          'VALIDATION_FAILED',
          'No receipt printer is set. Choose one in Settings → Printers.',
        );
      }
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`day_end_print:${d.id}`]);
      const { rows } = await tx.query<{ n: number }>(
        `SELECT coalesce(max(copy_no), 0)::int AS n FROM cl.print_jobs WHERE document_type = 'day_end' AND document_id = $1`,
        [d.id],
      );
      const copyNo = (rows[0]?.n ?? 0) + 1;
      const jobId = await requestPrint(tx, {
        printerId: till.printerId,
        documentType: 'day_end',
        documentId: d.id,
        copyNo,
        requestedBy: auth.user.id,
      });
      await writeAudit(tx, who(request), {
        action: 'report.day_end_print',
        entityType: 'day_end_report',
        entityId: d.id,
        after: { date: d.date, copyNo },
      });
      return { date: d.date, jobId, copyNo };
    });
  });
}
