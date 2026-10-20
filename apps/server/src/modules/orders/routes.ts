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
import { lockActiveSession } from '../floor/index.ts';
import { authOf, factsOf } from '../identity/index.ts';
import { acceptRound, rejectRound, submitRound, type CommandContext } from './rounds.ts';
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
}
