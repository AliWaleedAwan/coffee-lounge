/**
 * Report schedules (FINANCE_REPORTING.md §8; D-20; Phase 6 step 6.6). A schedule sends one
 * report for each completed period: daily (yesterday's business date), weekly (Monday to
 * Sunday, sent on the chosen weekday of the next week) or monthly (sent on the 1st), at its
 * time on the shop clock, never before 04:30 (the day ends at 04:00, the day-end is made at
 * 04:25). The worker looks every few minutes; each period is made once into a run (an
 * advisory lock and the run's unique key keep two workers from making it twice), and one
 * e-mail per recipient is queued with its Message-ID. A worker that was off catches up on
 * the last 7 days, 2 weeks or 2 months; a new schedule starts with the next period.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { businessDateOf, readSetting } from '../../platform/settings.ts';
import { loadEffectivePermissions } from '../identity/index.ts';
import {
  addDays,
  checkSchedule,
  monthOf,
  schedulable,
  scheduledFile,
  weekOf,
} from '../reports/index.ts';
import { EMAIL } from './account.ts';

export const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface ScheduleInput {
  reportType: string;
  filters: Record<string, unknown>;
  frequency: Frequency;
  sendAt: string;
  weekday?: number | undefined;
  recipients: string[];
}

interface ScheduleRow {
  id: string;
  report_type: string;
  filters: Record<string, unknown>;
  frequency: Frequency;
  send_at: string;
  weekday: number | null;
  recipients: string[];
  is_active: boolean;
  created_by: string;
  starts_on: string;
  version: number;
}

const SELECT = `SELECT s.id::text, s.report_type, s.filters, s.frequency, to_char(s.send_at, 'HH24:MI') AS send_at,
                       s.weekday, s.recipients, s.is_active, s.created_by::text, s.starts_on::text, s.version
                  FROM cl.report_schedules s`;

/** The shop clock now: its calendar date and hh:mm. */
export function shopClock(at: Date, timeZone: string): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return {
    date: `${p['year'] ?? ''}-${p['month'] ?? ''}-${p['day'] ?? ''}`,
    time: `${p['hour'] ?? ''}:${p['minute'] ?? ''}`,
  };
}

export interface Period {
  from: string;
  to: string;
  /** When it goes out, on the shop clock ("YYYY-MM-DD hh:mm"). */
  due: string;
}

/** The completed periods of a schedule that are due by now, oldest first. */
export function duePeriods(
  s: Pick<ScheduleRow, 'frequency' | 'send_at' | 'weekday' | 'starts_on'>,
  today: string,
  clock: { date: string; time: string },
): Period[] {
  const now = `${clock.date} ${clock.time}`;
  const candidates: Period[] = [];
  if (s.frequency === 'daily') {
    for (let k = 7; k >= 1; k--) {
      const day = addDays(today, -k);
      candidates.push({ from: day, to: day, due: `${addDays(day, 1)} ${s.send_at}` });
    }
  } else if (s.frequency === 'weekly') {
    const thisWeek = weekOf(today).from;
    for (let k = 2; k >= 1; k--) {
      const from = addDays(thisWeek, -7 * k);
      const to = addDays(from, 6);
      candidates.push({ from, to, due: `${addDays(to, s.weekday ?? 1)} ${s.send_at}` });
    }
  } else {
    let month = monthOf(today);
    const months = [];
    for (let k = 1; k <= 2; k++) {
      month = monthOf(addDays(month.from, -1));
      months.unshift(month);
    }
    for (const m of months) candidates.push({ ...m, due: `${addDays(m.to, 1)} ${s.send_at}` });
  }
  return candidates.filter((p) => p.from >= s.starts_on && p.to < today && p.due <= now);
}

// ---------------------------------------------------------------- managing schedules

export const scheduleInput = z
  .object({
    reportType: z.string().regex(/^[a-z-]{1,40}$/),
    filters: z.record(z.string(), z.string().max(80)).default({}),
    frequency: z.enum(FREQUENCIES),
    sendAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hh:mm')
      .refine((t) => t >= '04:30', 'E-mails go out after the day ends: 04:30 or later'),
    weekday: z.number().int().min(1).max(7).optional(),
    recipients: z
      .array(z.string().trim().toLowerCase().regex(EMAIL, 'one plain e-mail address'))
      .min(1)
      .max(10),
  })
  .strict();

function check(input: ScheduleInput, can: (p: string) => boolean): void {
  checkSchedule(input.reportType, input.filters, can);
  if (input.reportType === 'day-end' && input.frequency !== 'daily')
    throw new AppError('VALIDATION_FAILED', 'The day-end is sent daily');
  if ((input.frequency === 'weekly') !== (input.weekday !== undefined))
    throw new AppError('VALIDATION_FAILED', 'A weekly schedule needs its weekday (and only it)');
}

export async function createSchedule(
  pool: pg.Pool,
  ctx: AuditContext & { userId: string; can: (p: string) => boolean; now: Date },
  input: ScheduleInput,
) {
  check(input, ctx.can);
  return withTransaction(pool, async (tx) => {
    const startsOn = await businessDateOf(tx, ctx.now);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cl.report_schedules (report_type, filters, frequency, send_at, weekday, recipients, created_by, starts_on)
       VALUES ($1, $2, $3, $4::time, $5, $6, $7, $8::date) RETURNING id::text`,
      [
        input.reportType,
        JSON.stringify(input.filters),
        input.frequency,
        input.sendAt,
        input.weekday ?? null,
        [...new Set(input.recipients)],
        ctx.userId,
        startsOn,
      ],
    );
    const id = rows[0]?.id ?? '';
    await writeAudit(tx, ctx, {
      action: 'report_schedule.create',
      entityType: 'report_schedule',
      entityId: id,
      after: input,
    });
    return readSchedule(tx, id);
  });
}

export async function updateSchedule(
  pool: pg.Pool,
  ctx: AuditContext & { userId: string; can: (p: string) => boolean },
  id: string,
  input: ScheduleInput & { isActive: boolean; expectedVersion: number },
) {
  check(input, ctx.can);
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<ScheduleRow>(`${SELECT} WHERE s.id = $1 FOR UPDATE`, [id]);
    const before = rows[0];
    if (!before) throw new AppError('NOT_FOUND', 'Schedule not found');
    if (before.version !== input.expectedVersion)
      throw new AppError('STALE_STATE', 'Someone else changed this schedule first');
    await tx.query(
      `UPDATE cl.report_schedules SET report_type = $2, filters = $3, frequency = $4, send_at = $5::time,
              weekday = $6, recipients = $7, is_active = $8 WHERE id = $1`,
      [
        id,
        input.reportType,
        JSON.stringify(input.filters),
        input.frequency,
        input.sendAt,
        input.weekday ?? null,
        [...new Set(input.recipients)],
        input.isActive,
      ],
    );
    await writeAudit(tx, ctx, {
      action: 'report_schedule.update',
      entityType: 'report_schedule',
      entityId: id,
      before: {
        reportType: before.report_type,
        filters: before.filters,
        frequency: before.frequency,
        sendAt: before.send_at,
        weekday: before.weekday,
        recipients: before.recipients,
        isActive: before.is_active,
      },
      after: { ...input, expectedVersion: undefined },
    });
    return readSchedule(tx, id);
  });
}

async function readSchedule(db: Queryable, id: string) {
  const { rows } = await db.query<ScheduleRow>(`${SELECT} WHERE s.id = $1`, [id]);
  const s = rows[0];
  if (!s) throw new AppError('NOT_FOUND', 'Schedule not found');
  return view(s);
}

function view(s: ScheduleRow) {
  return {
    id: s.id,
    reportType: s.report_type,
    title: schedulable(s.report_type)?.title ?? s.report_type,
    filters: s.filters,
    frequency: s.frequency,
    sendAt: s.send_at,
    weekday: s.weekday,
    recipients: s.recipients,
    isActive: s.is_active,
    startsOn: s.starts_on,
    version: s.version,
  };
}

export async function listSchedules(db: Queryable) {
  const { rows } = await db.query<ScheduleRow>(`${SELECT} ORDER BY s.id`);
  return rows.map(view);
}

// ---------------------------------------------------------------- the worker's scan

/**
 * Makes the run of one period and queues its e-mails, once: the advisory lock makes a second
 * worker wait, then find the run there and do nothing. A report that cannot be made (its
 * owner lost the permission) is kept as a failed run, shown on screen.
 */
async function makeRun(
  tx: Tx,
  s: ScheduleRow,
  period: Period,
  today: string,
): Promise<'made' | 'failed' | 'exists'> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `report_run:${s.id}:${period.from}:${period.to}`,
  ]);
  const { rows: existing } = await tx.query(
    'SELECT 1 FROM cl.report_runs WHERE schedule_id = $1 AND period_from = $2 AND period_to = $3',
    [s.id, period.from, period.to],
  );
  if (existing.length > 0) return 'exists';
  const grants = await loadEffectivePermissions(tx, s.created_by);
  let file: Awaited<ReturnType<typeof scheduledFile>> | null = null;
  let error: string | null = null;
  try {
    // A savepoint, so a failing report leaves the transaction usable for the failed run.
    await tx.query('SAVEPOINT make_report');
    file = await scheduledFile(tx, {
      key: s.report_type,
      filters: s.filters,
      period: { from: period.from, to: period.to },
      today,
      can: (p) => grants.has(p),
    });
    await tx.query('RELEASE SAVEPOINT make_report');
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT make_report');
    error = e instanceof Error ? e.message.slice(0, 300) : 'the report could not be made';
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.report_runs (schedule_id, report_type, period_from, period_to, status, file_name, content_type, content, summary, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text`,
    [
      s.id,
      s.report_type,
      period.from,
      period.to,
      file ? 'ready' : 'failed',
      file?.name ?? null,
      file?.contentType ?? null,
      file?.body ?? null,
      file?.summary ?? null,
      error,
    ],
  );
  if (!file) return 'failed';
  const runId = rows[0]?.id ?? '';
  const { rows: account } = await tx.query<{ domain: string }>(
    `SELECT split_part(from_address, '@', 2) AS domain FROM cl.mail_account WHERE id = 1`,
  );
  const domain = account[0]?.domain ?? 'coffee-lounge.local';
  for (const to of s.recipients) {
    await tx.query(
      `INSERT INTO cl.report_deliveries (run_id, recipient, message_id) VALUES ($1, $2, $3)`,
      [runId, to, `<${randomUUID()}@${domain}>`],
    );
  }
  return 'made';
}

export async function scanSchedules(
  pool: pg.Pool,
  at: Date,
): Promise<{ made: number; failed: number }> {
  const today = await businessDateOf(pool, at);
  const clock = shopClock(at, await readSetting(pool, 'shop.timezone', z.string().min(1)));
  const { rows } = await pool.query<ScheduleRow>(`${SELECT} WHERE s.is_active ORDER BY s.id`);
  const result = { made: 0, failed: 0 };
  for (const s of rows) {
    for (const period of duePeriods(s, today, clock)) {
      const outcome = await withTransaction(pool, (tx) => makeRun(tx, s, period, today));
      if (outcome === 'made') result.made += 1;
      if (outcome === 'failed') result.failed += 1;
    }
  }
  return result;
}
