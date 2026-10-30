/**
 * Print jobs (PRINTING_HARDWARE.md §5). A job is created in the business transaction
 * (accepting a round makes its kitchen ticket's job), so it exists exactly when the
 * thing it prints does. The worker prints each printer's jobs strictly in creation
 * order: a job that cannot be sent holds the ones behind it (AT-57).
 *
 *   queued → sending → sent
 *                    → retrying (nothing sent; 5 s, 15 s, 45 s, 135 s) → needs_attention after 5 tries
 *                    → uncertain (bytes may have gone out; never resent automatically, AT-28)
 *   needs_attention → queued (staff press Retry)     uncertain → sent ("it printed") or a reprint
 *
 * Business state never depends on printing: tickets stay readable on staff screens.
 */
import type pg from 'pg';
import { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { enqueueJob } from '../../platform/jobs.ts';
import { publish } from '../../platform/outbox.ts';
import { readSetting } from '../../platform/settings.ts';
import {
  renderDayEnd,
  renderKitchenTicket,
  renderReceipt,
  renderRefundSlip,
  renderShiftReport,
  renderTestPage,
  type KitchenTicketData,
} from './documents.ts';
import { dayEndPrintData } from './day-end-data.ts';
import { receiptData } from './receipt-data.ts';
import { refundSlipData } from './refund-slip-data.ts';
import { shiftReportData } from './shift-report-data.ts';
import type { PrinterTarget, Transport } from './transports.ts';

export const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [5, 15, 45, 135];
/** A send claimed longer ago than this, still `sending`, died with its worker. */
export const STALE_SEND_MS = 2 * 60_000;

export type DocumentType =
  'kitchen_ticket' | 'receipt' | 'refund_slip' | 'shift_report' | 'test_page' | 'day_end';

export interface PrinterRow extends PrinterTarget {
  id: string;
  chars_per_line: number;
  can_cut: boolean;
  is_active: boolean;
}

interface JobRow {
  id: string;
  printer_id: string;
  document_type: DocumentType;
  document_id: string;
  copy_no: number;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  claimed_at: Date | null;
}

export async function printJobChanged(tx: Tx, jobId: string): Promise<void> {
  await publish(tx, {
    type: 'print_job.changed',
    entityType: 'print_job',
    entityId: jobId,
    topics: ['printers'],
  });
}

export function wakePrinter(tx: Queryable, printerId: string, runAt?: Date): Promise<string> {
  return enqueueJob(
    tx,
    'print:dispatch',
    { printerId },
    { queueName: `print-${printerId}`, ...(runAt ? { runAt } : {}) },
  );
}

/**
 * Queues a document for a printer inside the caller's transaction. `copyNo` > 1 is a
 * labelled reprint. Returns null when the job key exists already (same copy twice).
 */
export async function requestPrint(
  tx: Tx,
  input: {
    printerId: string;
    documentType: DocumentType;
    documentId: string;
    copyNo?: number;
    requestedBy?: string | null;
    jobKey?: string;
  },
): Promise<string | null> {
  const copyNo = input.copyNo ?? 1;
  const jobKey = input.jobKey ?? `${input.documentType}:${input.documentId}:copy:${String(copyNo)}`;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.print_jobs (job_key, printer_id, document_type, document_id, copy_no, is_reprint, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (job_key) DO NOTHING RETURNING id::text`,
    [
      jobKey,
      input.printerId,
      input.documentType,
      input.documentId,
      copyNo,
      copyNo > 1,
      input.requestedBy ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) return null;
  await wakePrinter(tx, input.printerId);
  await printJobChanged(tx, id);
  return id;
}

/** The printer of the shop's kitchen station, if one is set and active. */
export async function stationPrinter(db: Queryable, stationId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT p.id::text FROM cl.stations s JOIN cl.printers p ON p.id = s.printer_id
      WHERE s.id = $1 AND p.is_active`,
    [stationId],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------- rendering a job

async function kitchenTicketData(db: Queryable, ticketId: string): Promise<KitchenTicketData> {
  const { rows } = await db.query<{
    ticket_no: string;
    kind: KitchenTicketData['kind'];
    supersedes: string | null;
    order_type: KitchenTicketData['orderType'];
    table_name: string | null;
    session_no: string;
    round_no: number;
    created_at: Date;
    accepted_by: string | null;
  }>(
    `SELECT k.ticket_no, k.kind, o.ticket_no AS supersedes, s.order_type, t.name AS table_name, s.session_no,
            r.round_no, k.created_at, u.display_name AS accepted_by
       FROM cl.kitchen_tickets k
       LEFT JOIN cl.kitchen_tickets o ON o.id = k.supersedes_ticket_id
       JOIN cl.order_rounds r ON r.id = k.round_id
       JOIN cl.dining_sessions s ON s.id = r.session_id
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
       LEFT JOIN cl.users u ON u.id = r.decided_by
      WHERE k.id = $1`,
    [ticketId],
  );
  const t = rows[0];
  if (!t) throw new Error(`kitchen ticket ${ticketId} not found`);
  const { rows: lines } = await db.query<{
    qty: number;
    display: { item: string; variant: string; modifiers: string[]; notes: string | null };
  }>('SELECT qty, display FROM cl.kitchen_ticket_lines WHERE ticket_id = $1 ORDER BY id', [
    ticketId,
  ]);
  // Only these fields reach the ticket: no price, payment or guest detail exists here (AT-99).
  return {
    ticketNo: t.ticket_no,
    kind: t.kind,
    supersedes: t.supersedes,
    where: t.table_name ?? t.session_no,
    orderType: t.order_type,
    roundNo: t.round_no,
    at: t.created_at,
    acceptedBy: t.accepted_by,
    lines: lines.map((l) => ({
      qty: l.qty,
      item: l.display.item,
      variant: l.display.variant,
      modifiers: l.display.modifiers,
      notes: l.display.notes,
    })),
  };
}

export async function renderJob(db: Queryable, job: JobRow, printer: PrinterRow): Promise<Buffer> {
  const timeZone = await readSetting(db, 'shop.timezone', z.string().min(1));
  const options = {
    width: printer.chars_per_line,
    canCut: printer.can_cut,
    copyNo: job.copy_no,
    timeZone,
  };
  switch (job.document_type) {
    case 'kitchen_ticket':
      return renderKitchenTicket(await kitchenTicketData(db, job.document_id), options);
    case 'test_page':
      return renderTestPage(
        { printerName: printer.name, connection: printer.connection, at: new Date() },
        options,
      );
    case 'receipt':
      return renderReceipt(await receiptData(db, job.document_id), options);
    case 'shift_report':
      return renderShiftReport(await shiftReportData(db, job.document_id), options);
    case 'refund_slip':
      return renderRefundSlip(await refundSlipData(db, job.document_id), options);
    case 'day_end':
      return renderDayEnd(await dayEndPrintData(db, job.document_id), options);
    default: {
      const unknown: never = job.document_type;
      throw new Error(`unknown document type ${JSON.stringify(unknown)}`);
    }
  }
}

// ---------------------------------------------------------------- the dispatcher

export interface DispatchDeps {
  transports: Record<PrinterTarget['connection'], Transport>;
  now?: () => Date;
}

type Claim =
  { kind: 'job'; job: JobRow; printer: PrinterRow } | { kind: 'again' } | { kind: 'idle' };

async function claimHead(pool: pg.Pool, printerId: string, now: Date): Promise<Claim> {
  return withTransaction(pool, async (tx) => {
    const { rows: printers } = await tx.query<PrinterRow>(
      `SELECT id::text, name, connection, address, supports_status, chars_per_line, can_cut, is_active
         FROM cl.printers WHERE id = $1`,
      [printerId],
    );
    const printer = printers[0];
    if (!printer?.is_active) return { kind: 'idle' };
    const { rows } = await tx.query<JobRow>(
      `SELECT id::text, printer_id::text, document_type, document_id::text, copy_no, status, attempts, next_attempt_at, claimed_at
         FROM cl.print_jobs
        WHERE printer_id = $1 AND status IN ('queued','sending','retrying','needs_attention')
        ORDER BY print_jobs.id LIMIT 1 FOR UPDATE`,
      [printerId],
    );
    const head = rows[0];
    if (!head) return { kind: 'idle' };
    if (head.status === 'needs_attention') return { kind: 'idle' }; // held until staff press Retry
    if (head.status === 'retrying' && head.next_attempt_at && head.next_attempt_at > now)
      return { kind: 'idle' };
    if (head.status === 'sending') {
      // Only one dispatcher runs per printer, so a `sending` head was left by a worker that
      // stopped mid-send: its bytes may have printed. Never resend it (AT-28).
      if (head.claimed_at && now.getTime() - head.claimed_at.getTime() < STALE_SEND_MS)
        return { kind: 'idle' };
      await tx.query(
        `UPDATE cl.print_jobs SET status = 'uncertain', last_error = 'The worker stopped while sending' WHERE id = $1`,
        [head.id],
      );
      await printJobChanged(tx, head.id);
      return { kind: 'again' };
    }
    await tx.query(
      `UPDATE cl.print_jobs SET status = 'sending', claimed_at = $2, attempts = attempts + 1 WHERE id = $1`,
      [head.id, now],
    );
    return { kind: 'job', job: { ...head, attempts: head.attempts + 1 }, printer };
  });
}

/**
 * Prints the printer's jobs in order until its queue is empty, or until the head job
 * cannot be sent (it then waits for its retry, or for staff). Returns how many were sent.
 */
export async function dispatchPrinter(
  pool: pg.Pool,
  printerId: string,
  deps: DispatchDeps,
): Promise<number> {
  const now = deps.now ?? (() => new Date());
  let sent = 0;
  for (let guard = 0; guard < 100; guard++) {
    const claim = await claimHead(pool, printerId, now());
    if (claim.kind === 'idle') break;
    if (claim.kind === 'again') continue;
    const { job, printer } = claim;
    let result;
    try {
      result = await deps.transports[printer.connection].send(
        printer,
        await renderJob(pool, job, printer),
      );
    } catch (error) {
      result = {
        outcome: 'not_sent' as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const at = now();
    const outcome = await withTransaction(pool, async (tx) => {
      if (result.outcome === 'sent') {
        await tx.query(
          `UPDATE cl.print_jobs SET status = 'sent', sent_at = $2, last_error = NULL, next_attempt_at = NULL WHERE id = $1`,
          [job.id, at],
        );
      } else if (result.outcome === 'uncertain') {
        await tx.query(
          `UPDATE cl.print_jobs SET status = 'uncertain', last_error = $2 WHERE id = $1`,
          [job.id, result.error],
        );
      } else if (job.attempts >= MAX_ATTEMPTS) {
        await tx.query(
          `UPDATE cl.print_jobs SET status = 'needs_attention', last_error = $2, next_attempt_at = NULL WHERE id = $1`,
          [job.id, result.error],
        );
      } else {
        const next = new Date(at.getTime() + (BACKOFF_SECONDS[job.attempts - 1] ?? 135) * 1000);
        await tx.query(
          `UPDATE cl.print_jobs SET status = 'retrying', last_error = $2, next_attempt_at = $3 WHERE id = $1`,
          [job.id, result.error, next],
        );
        await wakePrinter(tx, printerId, next);
      }
      await printJobChanged(tx, job.id);
      return result.outcome;
    });
    if (outcome === 'sent') sent += 1;
    if (outcome === 'not_sent') break; // the head holds the queue (in-order printing)
  }
  return sent;
}

/** Safety net (every minute): wake printers with due retries or a send left by a dead worker. */
export async function sweepPrinters(pool: pg.Pool, now: Date): Promise<number> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ printer_id: string }>(
      `SELECT DISTINCT printer_id::text FROM cl.print_jobs
        WHERE (status = 'retrying' AND next_attempt_at <= $1)
           OR (status = 'queued' AND created_at < $1::timestamptz - interval '1 minute')
           OR (status = 'sending' AND claimed_at < $1::timestamptz - make_interval(secs => $2))`,
      [now, STALE_SEND_MS / 1000],
    );
    for (const r of rows) await wakePrinter(tx, r.printer_id);
    return rows.length;
  });
}
