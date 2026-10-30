/**
 * The e-mail queue (FINANCE_REPORTING.md §8; AT-21, AT-104). Every minute the worker takes
 * the e-mails that are due (SKIP LOCKED, so two workers never take the same one), sends
 * each with the Message-ID it was given when queued, and marks it sent; a failure keeps it
 * queued with the reason on screen and the next try after 1, 2, 4 … up to 60 minutes, for
 * as long as the internet is down. Only an address the mail server refuses stops it
 * (failed, until someone retries it). One left "sending" by a stopped worker goes back to
 * the queue after 10 minutes, so delivery is at-least-once, and the same Message-ID lets
 * mail clients drop a rare duplicate.
 */
import type pg from 'pg';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import { withTransaction } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { schedulable } from '../reports/index.ts';
import { describeFailure, openMailer, type MailDeps, type Mailer } from './account.ts';

const STALE_SENDING_MS = 10 * 60_000;
export const NO_MAILBOX = 'Waiting for the shop mailbox to be set up (Settings → E-mail)';

/** Minutes until the next try after `attempts` failures: 1, 2, 4 … at most 60. */
export const backoffMinutes = (attempts: number): number =>
  Math.min(60, 2 ** Math.max(0, attempts - 1));

interface Due {
  id: string;
  recipient: string;
  message_id: string;
  attempts: number;
  report_type: string;
  period_from: string;
  period_to: string;
  file_name: string;
  content_type: string;
  content: Buffer;
  summary: string | null;
}

function message(d: Due, shopName: string) {
  const title = schedulable(d.report_type)?.title ?? d.report_type;
  const period =
    d.period_from === d.period_to
      ? `business date ${d.period_from}`
      : `${d.period_from} to ${d.period_to}`;
  return {
    to: d.recipient,
    subject: `${shopName}: ${title}, ${period}`,
    text: [
      `${title} for ${period} is attached (${d.file_name}).`,
      ...(d.summary ? ['', d.summary] : []),
      '',
      `Sent by the ${shopName} system on a schedule. To change who receives it, open Reports → E-mails.`,
    ].join('\n'),
    messageId: d.message_id,
    attachments: [{ filename: d.file_name, content: d.content, contentType: d.content_type }],
  };
}

/** Sends what is due; returns how many went out and how many must wait. */
export async function sendDue(
  pool: pg.Pool,
  deps: MailDeps,
  now: Date,
  limit = 20,
): Promise<{ sent: number; waiting: number; failed: number }> {
  await pool.query(
    `UPDATE cl.report_deliveries SET status = 'queued', claimed_at = NULL
      WHERE status = 'sending' AND claimed_at < $1`,
    [new Date(now.getTime() - STALE_SENDING_MS)],
  );
  const result = { sent: 0, waiting: 0, failed: 0 };
  const { rows: account } = await pool.query('SELECT 1 FROM cl.mail_account WHERE id = 1');
  if (account.length === 0) {
    await pool.query(
      `UPDATE cl.report_deliveries SET last_error = $1
        WHERE status = 'queued' AND last_error IS DISTINCT FROM $1`,
      [NO_MAILBOX],
    );
    return result;
  }
  const due = await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<Due>(
      `SELECT d.id::text, d.recipient, d.message_id, d.attempts, r.report_type,
              r.period_from::text, r.period_to::text, r.file_name, r.content_type, r.content, r.summary
         FROM cl.report_deliveries d JOIN cl.report_runs r ON r.id = d.run_id
        WHERE d.status = 'queued' AND d.next_attempt_at <= $1
        ORDER BY d.next_attempt_at, d.id
        LIMIT $2
        FOR UPDATE OF d SKIP LOCKED`,
      [now, limit],
    );
    if (rows.length > 0) {
      await tx.query(
        `UPDATE cl.report_deliveries SET status = 'sending', claimed_at = $2, attempts = attempts + 1
          WHERE id = ANY($1::bigint[])`,
        [rows.map((r) => r.id), now],
      );
    }
    return rows;
  });
  if (due.length === 0) return result;
  let mailer: Mailer | null = null;
  try {
    mailer = await openMailer(pool, deps);
    const shopName = mailer?.from.name ?? 'Coffee Lounge';
    for (const d of due) {
      const attempts = d.attempts + 1;
      try {
        if (!mailer) throw new Error(NO_MAILBOX);
        await mailer.send(message(d, shopName));
        await pool.query(
          `UPDATE cl.report_deliveries SET status = 'sent', sent_at = $2, claimed_at = NULL, last_error = NULL
            WHERE id = $1`,
          [d.id, now],
        );
        result.sent += 1;
      } catch (error) {
        const failure = describeFailure(error);
        const next = new Date(now.getTime() + backoffMinutes(attempts) * 60_000);
        await pool.query(
          `UPDATE cl.report_deliveries SET status = $2, claimed_at = NULL, last_error = $3, next_attempt_at = $4
            WHERE id = $1`,
          [d.id, failure.permanent ? 'failed' : 'queued', failure.message, next],
        );
        if (failure.permanent) result.failed += 1;
        else result.waiting += 1;
      }
    }
  } finally {
    mailer?.close();
  }
  return result;
}

/** The latest e-mails with where they stand (AT-21: status visible). */
export async function listDeliveries(db: Queryable, limit = 100) {
  const { rows } = await db.query<{
    id: string;
    schedule_id: string;
    report_type: string;
    period_from: string;
    period_to: string;
    recipient: string | null;
    status: string;
    attempts: number;
    last_error: string | null;
    next_attempt_at: Date | null;
    sent_at: Date | null;
    message_id: string | null;
    file_name: string | null;
    created_at: Date;
  }>(
    // Runs that could not be made show too, with their reason.
    `SELECT COALESCE(d.id::text, 'run-' || r.id) AS id, r.schedule_id::text, r.report_type,
            r.period_from::text, r.period_to::text, d.recipient,
            COALESCE(d.status, 'not_made') AS status, COALESCE(d.attempts, 0) AS attempts,
            COALESCE(d.last_error, r.error) AS last_error, d.next_attempt_at, d.sent_at, d.message_id,
            r.file_name, r.created_at
       FROM cl.report_runs r LEFT JOIN cl.report_deliveries d ON d.run_id = r.id
      ORDER BY r.created_at DESC, r.id DESC, d.id
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    scheduleId: r.schedule_id,
    reportType: r.report_type,
    title: schedulable(r.report_type)?.title ?? r.report_type,
    period: { from: r.period_from, to: r.period_to },
    recipient: r.recipient,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    nextAttemptAt: r.status === 'queued' ? (r.next_attempt_at?.toISOString() ?? null) : null,
    sentAt: r.sent_at?.toISOString() ?? null,
    messageId: r.message_id,
    fileName: r.file_name,
  }));
}

/** Tries a waiting or failed e-mail again now, with the same Message-ID (AT-104). */
export async function retryDelivery(
  pool: pg.Pool,
  ctx: AuditContext,
  id: string,
  now: Date,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ status: string; message_id: string }>(
      'SELECT status, message_id FROM cl.report_deliveries WHERE id = $1 FOR UPDATE',
      [id],
    );
    const d = rows[0];
    if (!d) throw new AppError('NOT_FOUND', 'E-mail not found');
    if (d.status === 'sent' || d.status === 'sending')
      throw new AppError('STALE_STATE', `This e-mail is already ${d.status}`);
    await tx.query(
      `UPDATE cl.report_deliveries SET status = 'queued', next_attempt_at = $2 WHERE id = $1`,
      [id, now],
    );
    await writeAudit(tx, ctx, {
      action: 'report_delivery.retry',
      entityType: 'report_delivery',
      entityId: id,
      before: { status: d.status },
      after: { status: 'queued', messageId: d.message_id },
    });
  });
}
