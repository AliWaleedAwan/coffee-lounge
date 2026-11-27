/**
 * Rounds on the staff API (API.md §5.4): staff rounds (accepted on submit), the approvals
 * queue, accept and reject, and a session's rounds. Every command carries an
 * Idempotency-Key, so a double press or a retry after a network drop acts once (AT-03).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../platform/errors.ts';
import { handleCommand, IDEMPOTENCY_HEADER } from '../../platform/idempotency.ts';
import { parseInput } from '../../platform/validation.ts';
import { lockActiveSession, requestBill } from '../floor/index.ts';
import { authOf, factsOf } from '../identity/index.ts';
import { readSetting } from '../../platform/settings.ts';
import { WASTE_REASONS } from '../stock/index.ts';
import { cancelUnits, pickUp, requireOwnTable, serve, voidUnits } from './lines.ts';
import { acceptRound, rejectRound, submitRound, type CommandContext } from './rounds.ts';
import { pickupQueue, ticketView } from './tickets.ts';
import { linesSchema } from './schema.ts';
import { approvals, sessionRounds } from './views.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const idParam = (request: FastifyRequest) => parseInput(z.object({ id }), request.params).id;

export function commandContext(request: FastifyRequest, now: Date): CommandContext {
  const facts = factsOf(request);
  return {
    key: String(request.headers[IDEMPOTENCY_HEADER] ?? '').toLowerCase(),
    correlationId: facts.correlationId,
    now,
    ip: facts.ip,
  };
}

export interface OrderRouteOptions {
  pool: pg.Pool;
  now?: () => Date;
}

export async function orderRoutes(app: FastifyInstance, options: OrderRouteOptions): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());

  app.post(
    '/sessions/:id/rounds',
    { config: { permission: 'orders.create' } },
    async (request, reply) => {
      const sessionId = idParam(request);
      const body = parseInput(z.object({ lines: linesSchema }).strict(), request.body);
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        {
          scope: 'round.submit',
          actorRef: `user:${auth.user.id}`,
          payload: { sessionId, ...body },
        },
        async (tx) => {
          const session = await lockActiveSession(tx, sessionId);
          const round = await submitRound(tx, ctx, {
            session,
            submitter: {
              kind: 'user',
              userId: auth.user.id,
              deviceId: auth.device.id,
              source: auth.device.kind === 'reception' ? 'reception' : 'waiter',
            },
            lines: body.lines,
          });
          return { status: 201, body: round };
        },
      );
    },
  );

  app.get('/sessions/:id', { config: { permission: 'tables.read' } }, async (request) => {
    const sessionId = idParam(request);
    const { rows } = await pool.query<{
      id: string;
      session_no: string;
      order_type: string;
      status: string;
      table_name: string | null;
      opened_at: Date;
    }>(
      `SELECT s.id::text, s.session_no, s.order_type, s.status, t.name AS table_name, s.opened_at
         FROM cl.dining_sessions s LEFT JOIN cl.dining_tables t ON t.id = s.table_id WHERE s.id = $1`,
      [sessionId],
    );
    const s = rows[0];
    if (!s) throw new AppError('NOT_FOUND', 'Session not found');
    return {
      session: {
        id: s.id,
        sessionNo: s.session_no,
        orderType: s.order_type,
        status: s.status,
        tableName: s.table_name,
        openedAt: s.opened_at.toISOString(),
      },
      ...(await sessionRounds(pool, sessionId)),
    };
  });

  // S4 by staff: the guests asked a waiter for the bill.
  app.post(
    '/sessions/:id/bill-request',
    { config: { permission: 'invoices.read' } },
    async (request, reply) => {
      const sessionId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'session.bill_request', actorRef: `user:${auth.user.id}`, payload: { sessionId } },
        async (tx) => {
          const session = await lockActiveSession(tx, sessionId);
          await requireOwnTable(tx, auth, 'invoices.read', session);
          return {
            status: 200,
            body: await requestBill(tx, session, {
              actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
              correlationId: ctx.correlationId,
            }),
          };
        },
      );
    },
  );

  app.get('/approvals', { config: { permission: 'orders.accept' } }, async (request) =>
    approvals(pool, authOf(request), now()),
  );

  app.post(
    '/rounds/:id/accept',
    { config: { permission: 'orders.accept' } },
    async (request, reply) => {
      const roundId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        {
          scope: 'round.decide',
          actorRef: `user:${auth.user.id}`,
          payload: { roundId, decision: 'accept' },
        },
        async (tx) => ({ status: 200, body: await acceptRound(tx, ctx, auth, roundId) }),
      );
    },
  );

  app.post(
    '/rounds/:id/reject',
    { config: { permission: 'orders.accept' } },
    async (request, reply) => {
      const roundId = idParam(request);
      const body = parseInput(
        z.object({ reason: z.string().trim().min(3).max(200) }).strict(),
        request.body,
      );
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        {
          scope: 'round.decide',
          actorRef: `user:${auth.user.id}`,
          payload: { roundId, decision: 'reject', ...body },
        },
        async (tx) => ({
          status: 200,
          body: await rejectRound(tx, ctx, auth, roundId, body.reason),
        }),
      );
    },
  );

  // ------------------------------------------------------------ kitchen and pickup (step 3.5)
  const qty = z.number().int().min(1).max(20);
  const stepUpId = z
    .string()
    .regex(/^\d{1,18}$/)
    .optional();

  app.get('/pickup', { config: { permission: 'kitchen.pickup' } }, async () =>
    pickupQueue(
      pool,
      now(),
      await readSetting(pool, 'orders.uncollected_alert_minutes', z.number().positive()),
    ),
  );

  app.get('/tickets/:id', { config: { permission: 'kitchen.read' } }, async (request) => {
    const ticket = await ticketView(pool, idParam(request));
    if (!ticket) throw new AppError('NOT_FOUND', 'Ticket not found');
    return ticket;
  });

  app.post(
    '/lines/:id/pickup',
    { config: { permission: 'kitchen.pickup' } },
    async (request, reply) => {
      const lineId = idParam(request);
      const body = parseInput(z.object({ qty }).strict(), request.body);
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'line.pickup', actorRef: `user:${auth.user.id}`, payload: { lineId, ...body } },
        async (tx) => ({
          status: 200,
          body: await pickUp(tx, ctx, auth, [{ lineId, qty: body.qty }]),
        }),
      );
    },
  );

  /** The kitchen accepts a ticket: the order now reads "Preparing". Nothing else changes. */
  app.post('/tickets/:id/start', { config: { permission: 'kitchen.pickup' } }, async (request) => {
    const ticketId = idParam(request);
    parseInput(z.object({}).strict(), request.body ?? {});
    const { rowCount } = await pool.query(
      `UPDATE cl.kitchen_tickets SET started_at = COALESCE(started_at, now())
        WHERE id = $1 AND status = 'open' AND kind IN ('new','supplement')`,
      [ticketId],
    );
    if (rowCount === 0) throw new AppError('NOT_FOUND', 'No such open ticket');
    return { started: true };
  });

  app.post(
    '/tickets/:id/pickup',
    { config: { permission: 'kitchen.pickup' } },
    async (request, reply) => {
      const ticketId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'line.pickup', actorRef: `user:${auth.user.id}`, payload: { ticketId } },
        async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `SELECT kl.order_line_id::text AS id FROM cl.kitchen_ticket_lines kl JOIN cl.kitchen_tickets k ON k.id = kl.ticket_id
            WHERE k.id = $1 AND k.kind IN ('new','supplement') ORDER BY kl.order_line_id`,
            [ticketId],
          );
          if (rows.length === 0) throw new AppError('NOT_FOUND', 'Ticket not found');
          return {
            status: 200,
            body: await pickUp(
              tx,
              ctx,
              auth,
              rows.map((r) => ({ lineId: r.id, qty: 'rest' as const })),
            ),
          };
        },
      );
    },
  );

  app.post(
    '/lines/:id/serve',
    { config: { permission: 'orders.serve' } },
    async (request, reply) => {
      const lineId = idParam(request);
      const body = parseInput(z.object({ qty }).strict(), request.body);
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'line.serve', actorRef: `user:${auth.user.id}`, payload: { lineId, ...body } },
        async (tx) => ({ status: 200, body: await serve(tx, ctx, auth, lineId, body.qty) }),
      );
    },
  );

  app.post(
    '/lines/:id/cancel',
    { config: { permission: 'orders.void' } },
    async (request, reply) => {
      const lineId = idParam(request);
      const body = parseInput(
        z
          .object({ qty, made: z.boolean(), reason: z.string().trim().min(3).max(200), stepUpId })
          .strict(),
        request.body,
      );
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'line.cancel', actorRef: `user:${auth.user.id}`, payload: { lineId, ...body } },
        async (tx) => ({
          status: 200,
          body: await cancelUnits(tx, ctx, auth, { lineId, ...body }),
        }),
      );
    },
  );

  app.post('/lines/:id/void', { config: { permission: 'orders.void' } }, async (request, reply) => {
    const lineId = idParam(request);
    const body = parseInput(
      z
        .object({
          qty,
          reasonCode: z.enum(WASTE_REASONS),
          note: z.string().trim().max(200).optional(),
          stepUpId,
        })
        .strict(),
      request.body,
    );
    const auth = authOf(request);
    const ctx = commandContext(request, now());
    return handleCommand(
      pool,
      request,
      reply,
      { scope: 'line.void', actorRef: `user:${auth.user.id}`, payload: { lineId, ...body } },
      async (tx) => ({ status: 200, body: await voidUnits(tx, ctx, auth, { lineId, ...body }) }),
    );
  });
}
