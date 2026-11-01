/**
 * Printing on the staff API (API.md §5.7): printer status for the banner, printer setup
 * and test print (owner), the open-jobs list with Retry / Retry all / "Did it print?",
 * and labelled ticket reprints (K5).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit } from '../../platform/audit.ts';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf, factsOf } from '../identity/index.ts';
import { detectQueues } from './detect.ts';
import { printJobChanged, requestPrint, stationPrinter, wakePrinter } from './jobs.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const idParam = (request: FastifyRequest) => parseInput(z.object({ id }), request.params).id;
const printerFields = {
  name: z.string().trim().min(1).max(60),
  connection: z.enum(['spooler', 'tcp']),
  address: z.string().trim().min(1).max(200),
  paperWidthMm: z.union([z.literal(58), z.literal(80)]).optional(),
  supportsStatus: z.boolean().optional(),
  canCut: z.boolean().optional(),
};

function who(request: FastifyRequest) {
  const auth = authOf(request);
  const facts = factsOf(request);
  return {
    actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
    correlationId: facts.correlationId,
    ...(facts.ip ? { ip: facts.ip } : {}),
  };
}

function checkAddress(connection: 'spooler' | 'tcp', address: string): void {
  if (connection === 'tcp' && !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(address)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'A network printer address looks like 192.168.100.251:9100',
    );
  }
}

async function lockJob(tx: Tx, jobId: string) {
  const { rows } = await tx.query<{
    id: string;
    printer_id: string;
    status: string;
    document_type: string;
    document_id: string;
  }>(
    `SELECT id::text, printer_id::text, status, document_type, document_id::text FROM cl.print_jobs WHERE id = $1 FOR UPDATE`,
    [jobId],
  );
  const job = rows[0];
  if (!job) throw new AppError('NOT_FOUND', 'Print job not found');
  return job;
}

export interface PrintingRouteOptions {
  pool: pg.Pool;
}

export async function printingRoutes(
  app: FastifyInstance,
  options: PrintingRouteOptions,
): Promise<void> {
  const { pool } = options;

  // ------------------------------------------------------------ status (banner)
  app.get('/printers/status', { config: { permission: 'kitchen.read' } }, async () => {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      open_jobs: number;
      attention: number;
      retrying: number;
      uncertain: number;
      last_error: string | null;
    }>(
      `SELECT p.id::text, p.name,
              count(j.id) FILTER (WHERE j.status IN ('queued','sending','retrying','needs_attention'))::int AS open_jobs,
              count(j.id) FILTER (WHERE j.status = 'needs_attention')::int AS attention,
              count(j.id) FILTER (WHERE j.status = 'retrying')::int AS retrying,
              count(j.id) FILTER (WHERE j.status = 'uncertain')::int AS uncertain,
              (SELECT j2.last_error FROM cl.print_jobs j2 WHERE j2.printer_id = p.id
                  AND j2.status IN ('retrying','needs_attention') ORDER BY j2.id LIMIT 1) AS last_error
         FROM cl.printers p LEFT JOIN cl.print_jobs j ON j.printer_id = p.id
        WHERE p.is_active GROUP BY p.id ORDER BY p.name`,
    );
    const { rows: unassigned } = await pool.query(
      `SELECT 1 FROM cl.stations s LEFT JOIN cl.printers p ON p.id = s.printer_id AND p.is_active WHERE p.id IS NULL`,
    );
    return {
      kitchenPrinterMissing: unassigned.length > 0,
      printers: rows.map((r) => ({
        id: r.id,
        name: r.name,
        state: r.attention > 0 ? 'needs_attention' : r.retrying > 0 ? 'retrying' : 'ok',
        openJobs: r.open_jobs,
        uncertain: r.uncertain,
        lastError: r.last_error,
      })),
    };
  });

  // ------------------------------------------------------------ setup (owner)
  app.get('/printers', { config: { permission: 'printers.manage' } }, async () => {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      connection: string;
      address: string;
      paper_width_mm: number;
      chars_per_line: number;
      supports_status: boolean;
      can_cut: boolean;
      is_active: boolean;
      version: number;
    }>(
      `SELECT id::text, name, connection, address, paper_width_mm, chars_per_line, supports_status, can_cut, is_active, version
         FROM cl.printers ORDER BY name`,
    );
    const { rows: stations } = await pool.query<{
      id: string;
      name: string;
      printer_id: string | null;
    }>('SELECT id::text, name, printer_id::text FROM cl.stations ORDER BY stations.id');
    const { rows: tills } = await pool.query<{
      id: string;
      name: string;
      printer_id: string | null;
    }>(
      'SELECT id::text, name, receipt_printer_id::text AS printer_id FROM cl.tills ORDER BY tills.id',
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        connection: r.connection,
        address: r.address,
        paperWidthMm: r.paper_width_mm,
        charsPerLine: r.chars_per_line,
        supportsStatus: r.supports_status,
        canCut: r.can_cut,
        isActive: r.is_active,
        version: r.version,
      })),
      stations: stations.map((s) => ({ id: s.id, name: s.name, printerId: s.printer_id })),
      tills: tills.map((t) => ({ id: t.id, name: t.name, printerId: t.printer_id })),
    };
  });

  app.get('/printers/detect', { config: { permission: 'printers.manage' } }, () => detectQueues());

  app.post('/printers', { config: { permission: 'printers.manage' } }, async (request, reply) => {
    const body = parseInput(z.object(printerFields).strict(), request.body);
    checkAddress(body.connection, body.address);
    const width = body.paperWidthMm ?? 80;
    try {
      const created = await withTransaction(pool, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO cl.printers (name, connection, address, paper_width_mm, chars_per_line, supports_status, can_cut)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
          [
            body.name,
            body.connection,
            body.address,
            width,
            width === 58 ? 32 : 48,
            body.supportsStatus ?? false,
            body.canCut ?? true,
          ],
        );
        const printerId = rows[0]?.id ?? '';
        await writeAudit(tx, who(request), {
          action: 'printer.create',
          entityType: 'printer',
          entityId: printerId,
          after: body,
        });
        return { id: printerId };
      });
      return await reply.code(201).send(created);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError('VALIDATION_FAILED', 'Another printer has that name');
      throw error;
    }
  });

  app.patch('/printers/:id', { config: { permission: 'printers.manage' } }, async (request) => {
    const printerId = idParam(request);
    const body = parseInput(
      z
        .object({
          expectedVersion: z.number().int().min(1),
          ...printerFields,
          name: printerFields.name.optional(),
          connection: printerFields.connection.optional(),
          address: printerFields.address.optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    return withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{
        version: number;
        connection: 'spooler' | 'tcp';
        address: string;
      }>('SELECT version, connection, address FROM cl.printers WHERE id = $1 FOR UPDATE', [
        printerId,
      ]);
      const before = rows[0];
      if (!before) throw new AppError('NOT_FOUND', 'Printer not found');
      if (before.version !== body.expectedVersion) {
        throw new AppError(
          'STALE_STATE',
          'This printer was changed by someone else. Reload and try again.',
        );
      }
      checkAddress(body.connection ?? before.connection, body.address ?? before.address);
      const width = body.paperWidthMm;
      const { rows: updated } = await tx.query<{ version: number }>(
        `UPDATE cl.printers SET name = COALESCE($2, name), connection = COALESCE($3, connection), address = COALESCE($4, address),
                paper_width_mm = COALESCE($5, paper_width_mm), chars_per_line = COALESCE($6, chars_per_line),
                supports_status = COALESCE($7, supports_status), can_cut = COALESCE($8, can_cut), is_active = COALESCE($9, is_active)
          WHERE id = $1 RETURNING version`,
        [
          printerId,
          body.name ?? null,
          body.connection ?? null,
          body.address ?? null,
          width ?? null,
          width === undefined ? null : width === 58 ? 32 : 48,
          body.supportsStatus ?? null,
          body.canCut ?? null,
          body.isActive ?? null,
        ],
      );
      await writeAudit(tx, who(request), {
        action: 'printer.update',
        entityType: 'printer',
        entityId: printerId,
        after: body,
      });
      await wakePrinter(tx, printerId);
      return { id: printerId, version: updated[0]?.version ?? 0 };
    });
  });

  app.put(
    '/stations/:id/printer',
    { config: { permission: 'printers.manage' } },
    async (request, reply) => {
      const stationId = idParam(request);
      const body = parseInput(z.object({ printerId: id.nullable() }).strict(), request.body);
      await withTransaction(pool, async (tx) => {
        const { rowCount } = await tx.query(
          'UPDATE cl.stations SET printer_id = $2 WHERE id = $1',
          [stationId, body.printerId],
        );
        if (!rowCount) throw new AppError('NOT_FOUND', 'Station not found');
        await writeAudit(tx, who(request), {
          action: 'station.printer',
          entityType: 'station',
          entityId: stationId,
          after: body,
        });
      });
      return reply.code(204).send();
    },
  );

  app.put(
    '/tills/:id/printer',
    { config: { permission: 'printers.manage' } },
    async (request, reply) => {
      const tillId = idParam(request);
      const body = parseInput(z.object({ printerId: id.nullable() }).strict(), request.body);
      await withTransaction(pool, async (tx) => {
        const { rowCount } = await tx.query(
          'UPDATE cl.tills SET receipt_printer_id = $2 WHERE id = $1',
          [tillId, body.printerId],
        );
        if (!rowCount) throw new AppError('NOT_FOUND', 'Till not found');
        await writeAudit(tx, who(request), {
          action: 'till.receipt_printer',
          entityType: 'till',
          entityId: tillId,
          after: body,
        });
      });
      return reply.code(204).send();
    },
  );

  app.post(
    '/printers/:id/test',
    { config: { permission: 'printers.manage' } },
    async (request, reply) => {
      const printerId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      const jobId = await withTransaction(pool, (tx) =>
        requestPrint(tx, {
          printerId,
          documentType: 'test_page',
          documentId: printerId,
          requestedBy: authOf(request).user.id,
          jobKey: `test_page:${printerId}:${randomUUID()}`,
        }),
      );
      return reply.code(202).send({ jobId });
    },
  );

  // ------------------------------------------------------------ jobs (staff who reprint)
  app.get('/print-jobs', { config: { permission: 'kitchen.reprint' } }, async (request) => {
    parseInput(z.object({ status: z.literal('open').optional() }).strict(), request.query);
    const { rows } = await pool.query<{
      id: string;
      printer: string;
      document_type: string;
      document_id: string;
      label: string | null;
      copy_no: number;
      status: string;
      attempts: number;
      last_error: string | null;
      created_at: Date;
    }>(
      `SELECT j.id::text, p.name AS printer, j.document_type, j.document_id::text, k.ticket_no AS label, j.copy_no,
              j.status, j.attempts, j.last_error, j.created_at
         FROM cl.print_jobs j JOIN cl.printers p ON p.id = j.printer_id
         LEFT JOIN cl.kitchen_tickets k ON j.document_type = 'kitchen_ticket' AND k.id = j.document_id
        WHERE j.status IN ('queued','sending','retrying','needs_attention','uncertain')
        ORDER BY j.id`,
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        printer: r.printer,
        document:
          r.label ??
          (r.document_type === 'test_page' ? 'Test print' : `${r.document_type} ${r.document_id}`),
        documentType: r.document_type,
        copyNo: r.copy_no,
        status: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  app.post(
    '/print-jobs/:id/retry',
    { config: { permission: 'kitchen.reprint' } },
    async (request) => {
      const jobId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      return withTransaction(pool, async (tx) => {
        const job = await lockJob(tx, jobId);
        if (!['needs_attention', 'retrying'].includes(job.status)) {
          throw new AppError('STALE_STATE', `This job is ${job.status.replace('_', ' ')}`, {
            status: job.status,
          });
        }
        await tx.query(
          `UPDATE cl.print_jobs SET status = 'queued', next_attempt_at = NULL, attempts = 0 WHERE id = $1`,
          [jobId],
        );
        await wakePrinter(tx, job.printer_id);
        await printJobChanged(tx, jobId);
        return { id: jobId, status: 'queued' };
      });
    },
  );

  app.post(
    '/printers/:id/retry-all',
    { config: { permission: 'kitchen.reprint' } },
    async (request) => {
      const printerId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      return withTransaction(pool, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `UPDATE cl.print_jobs SET status = 'queued', next_attempt_at = NULL, attempts = 0
          WHERE printer_id = $1 AND status IN ('needs_attention','retrying') RETURNING id::text`,
          [printerId],
        );
        await wakePrinter(tx, printerId);
        for (const r of rows) await printJobChanged(tx, r.id);
        return { requeued: rows.length };
      });
    },
  );

  app.post(
    '/print-jobs/:id/resolve-uncertain',
    { config: { permission: 'kitchen.reprint' } },
    async (request) => {
      const jobId = idParam(request);
      const body = parseInput(
        z.object({ outcome: z.enum(['printed', 'reprint']) }).strict(),
        request.body,
      );
      const userId = authOf(request).user.id;
      return withTransaction(pool, async (tx) => {
        const job = await lockJob(tx, jobId);
        if (job.status !== 'uncertain')
          throw new AppError('STALE_STATE', `This job is ${job.status.replace('_', ' ')}`, {
            status: job.status,
          });
        let reprintJobId: string | null = null;
        if (body.outcome === 'printed') {
          await tx.query(
            `UPDATE cl.print_jobs SET status = 'sent', sent_at = now(), resolved_by = $2 WHERE id = $1`,
            [jobId, userId],
          );
        } else {
          await tx.query(
            `UPDATE cl.print_jobs SET status = 'cancelled', resolved_by = $2 WHERE id = $1`,
            [jobId, userId],
          );
          const { rows } = await tx.query<{ copy: number }>(
            `SELECT max(copy_no) + 1 AS copy FROM cl.print_jobs WHERE document_type = $1 AND document_id = $2`,
            [job.document_type, job.document_id],
          );
          reprintJobId = await requestPrint(tx, {
            printerId: job.printer_id,
            documentType: job.document_type as 'kitchen_ticket',
            documentId: job.document_id,
            copyNo: rows[0]?.copy ?? 2,
            requestedBy: userId,
          });
        }
        await writeAudit(tx, who(request), {
          action: `print.uncertain_${body.outcome}`,
          entityType: 'print_job',
          entityId: jobId,
        });
        await printJobChanged(tx, jobId);
        return { id: jobId, reprintJobId };
      });
    },
  );

  app.post(
    '/tickets/:id/reprint',
    { config: { permission: 'kitchen.reprint' } },
    async (request, reply) => {
      const ticketId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      const userId = authOf(request).user.id;
      const jobId = await withTransaction(pool, async (tx) => {
        const { rows } = await tx.query<{ station_id: string }>(
          'SELECT station_id::text FROM cl.kitchen_tickets WHERE id = $1',
          [ticketId],
        );
        const stationId = rows[0]?.station_id;
        if (stationId === undefined) throw new AppError('NOT_FOUND', 'Ticket not found');
        const printerId = await stationPrinter(tx, stationId);
        if (printerId === null)
          throw new AppError(
            'VALIDATION_FAILED',
            'No printer is set for the kitchen. The owner sets one on the Hardware page.',
          );
        const { rows: copies } = await tx.query<{ copy: number }>(
          `SELECT COALESCE(max(copy_no), 0) + 1 AS copy FROM cl.print_jobs WHERE document_type = 'kitchen_ticket' AND document_id = $1`,
          [ticketId],
        );
        const copy = Math.max(2, copies[0]?.copy ?? 2);
        const created = await requestPrint(tx, {
          printerId,
          documentType: 'kitchen_ticket',
          documentId: ticketId,
          copyNo: copy,
          requestedBy: userId,
        });
        await writeAudit(tx, who(request), {
          action: 'ticket.reprint',
          entityType: 'kitchen_ticket',
          entityId: ticketId,
          after: { copy },
        });
        return created;
      });
      return reply.code(202).send({ jobId });
    },
  );
}
