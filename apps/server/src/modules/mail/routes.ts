/**
 * Mail routes (API.md §5.15; Phase 6 step 6.6). The mailbox is the owner's
 * (`settings.mailbox`, protected): its password goes in and never comes out. Schedules and
 * the e-mail queue need `reports.schedule`; a schedule may only send a report its author may
 * open and export, and sends it with the permissions its author has when it is made.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit } from '../../platform/audit.ts';
import { withTransaction } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf, factsOf } from '../identity/index.ts';
import {
  describeFailure,
  EMAIL,
  openMailer,
  readAccount,
  saveAccount,
  type MailDeps,
} from './account.ts';
import { listDeliveries, retryDelivery } from './deliveries.ts';
import { createSchedule, listSchedules, scheduleInput, updateSchedule } from './schedules.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');

const accountInput = z
  .object({
    host: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9.-]{1,253}$/, 'a host name such as smtp.gmail.com'),
    port: z.number().int().min(1).max(65_535),
    security: z.enum(['starttls', 'tls']),
    username: z.string().trim().min(1).max(254),
    fromAddress: z.string().trim().regex(EMAIL, 'one plain e-mail address'),
    fromName: z.string().trim().min(1).max(80),
    password: z.string().min(1).max(200).optional(),
    expectedVersion: z.number().int().optional(),
  })
  .strict();

export async function mailRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; mail: MailDeps; now?: () => Date },
): Promise<void> {
  const { pool, mail } = options;
  const now = options.now ?? (() => new Date());
  const who = (request: FastifyRequest) => {
    const auth = authOf(request);
    const facts = factsOf(request);
    return {
      actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
      correlationId: facts.correlationId,
      ...(facts.ip ? { ip: facts.ip } : {}),
      userId: auth.user.id,
      can: (p: string) => auth.permissions.has(p),
    };
  };
  const mailbox = { config: { permission: 'settings.mailbox' } };
  const schedule = { config: { permission: 'reports.schedule' } };

  app.get('/mail/account', mailbox, async () => readAccount(pool));

  app.put('/mail/account', mailbox, async (request) => {
    const body = parseInput(accountInput, request.body);
    return withTransaction(pool, (tx) => saveAccount(tx, who(request), mail, body));
  });

  // "Send a test": the provider's answer, as it is, on screen (PLAN risks).
  app.post('/mail/test', mailbox, async (request) => {
    const body = parseInput(
      z
        .object({ to: z.string().trim().toLowerCase().regex(EMAIL, 'one plain e-mail address') })
        .strict(),
      request.body,
    );
    const mailer = await openMailer(pool, mail);
    if (!mailer) throw new AppError('VALIDATION_FAILED', 'Save the mailbox first');
    let error: string | null = null;
    try {
      await mailer.send({
        to: body.to,
        subject: `${mailer.from.name}: test e-mail`,
        text: 'This is a test from the shop system. Scheduled reports will come from this mailbox.',
        messageId: `<test-${crypto.randomUUID()}@${mailer.domain}>`,
      });
    } catch (e) {
      error = describeFailure(e).message;
    } finally {
      mailer.close();
    }
    await writeAudit(pool, who(request), {
      action: 'mail.test',
      entityType: 'mail_account',
      entityId: '1',
      after: { to: body.to, sent: error === null, ...(error ? { error } : {}) },
    });
    if (error) throw new AppError('VALIDATION_FAILED', error);
    return { sent: true, to: body.to };
  });

  app.get('/report-schedules', schedule, async () => ({ items: await listSchedules(pool) }));

  app.post('/report-schedules', schedule, async (request, reply) => {
    const body = parseInput(scheduleInput, request.body);
    const created = await createSchedule(pool, { ...who(request), now: now() }, body);
    return reply.code(201).send(created);
  });

  app.put('/report-schedules/:id', schedule, async (request) => {
    const scheduleId = parseInput(z.object({ id }).strict(), request.params).id;
    const body = parseInput(
      scheduleInput.extend({ isActive: z.boolean(), expectedVersion: z.number().int() }),
      request.body,
    );
    return updateSchedule(pool, who(request), scheduleId, body);
  });

  app.get('/report-deliveries', schedule, async () => ({ items: await listDeliveries(pool) }));

  app.post('/report-deliveries/:id/retry', schedule, async (request) => {
    const deliveryId = parseInput(z.object({ id }).strict(), request.params).id;
    await retryDelivery(pool, who(request), deliveryId, now());
    return { queued: true };
  });
}
