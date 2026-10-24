/**
 * Guest rounds on the customer listener (API.md §5.1). The session always comes from the
 * phone's cookies, never from the request (AT-127): the guest token if the phone has
 * one, otherwise the entry cookie of the scanned QR code, whose first order opens or
 * joins the table's session (S1, CT-03). Submissions are idempotent (AT-24) and limited
 * to 10 a minute per phone and 3 waiting rounds per session (AT-125).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../platform/errors.ts';
import { runIdempotent } from '../../platform/idempotency.ts';
import { isUuid } from '../../platform/correlation.ts';
import { RequestLimiter } from '../../platform/rate-limit.ts';
import { readSetting } from '../../platform/settings.ts';
import { parseInput } from '../../platform/validation.ts';
import {
  ENTRY_COOKIE,
  GUEST_COOKIE,
  GUEST_TTL_SECONDS,
  guestFromToken,
  lockActiveSession,
  looksLikeToken,
  openOrJoinFromQr,
  requestBill,
  resolveEntry,
  setGuestCookie,
  type GuestContext,
} from '../floor/index.ts';
import { submitRound, withdrawRound, type CommandContext } from './rounds.ts';
import { linesSchema } from './schema.ts';
import { sessionRounds } from './views.ts';

const MINUTE = 60_000;

export interface CustomerOrderOptions {
  pool: pg.Pool;
  now?: () => Date;
  /** Guest submissions per minute per phone (API.md §2: 10). */
  submissionsPerMinute?: number;
}

function guestContext(request: FastifyRequest, now: Date): CommandContext {
  const key = request.headers['idempotency-key'];
  if (!isUuid(key)) {
    throw new AppError('VALIDATION_FAILED', 'Idempotency-Key header (UUID) is required', {
      fields: [{ path: 'Idempotency-Key', message: 'required UUID' }],
    });
  }
  return { key: key.toLowerCase(), correlationId: request.id, now, ip: request.ip };
}

export async function customerOrderRoutes(
  app: FastifyInstance,
  options: CustomerOrderOptions,
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());
  const limiter = new RequestLimiter(options.submissionsPerMinute ?? 10, MINUTE);

  /** The phone's live visit, or null if it has none yet; VISIT_ENDED if it has ended. */
  const visitOf = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<GuestContext | null> => {
    const token = request.cookies[GUEST_COOKIE];
    if (token === undefined) return null;
    try {
      return await guestFromToken(pool, looksLikeToken(token) ? token : 'x'.repeat(22));
    } catch (error) {
      if (error instanceof AppError && error.code === 'VISIT_ENDED')
        void reply.clearCookie(GUEST_COOKIE, { path: '/' });
      throw error;
    }
  };

  app.post('/rounds', { config: { auth: 'public' } }, async (request, reply) => {
    const body = parseInput(
      z
        .object({
          lines: linesSchema,
          /** Counter QR: a name to call the order out by (optional, D-05). */
          customerName: z.string().trim().min(1).max(40).optional(),
        })
        .strict(),
      request.body,
    );
    const ctx = guestContext(request, now());
    const held = await visitOf(request, reply);
    // A paid takeaway's phone (read-only) orders again as a new visit from the counter QR.
    const visit = held?.readOnly ? null : held;
    const entry = visit ? null : await resolveEntry(pool, request.cookies[ENTRY_COOKIE], ctx.now);
    if (!visit && !entry)
      throw new AppError('VISIT_ENDED', 'Scan the QR code on your table to order.');
    const actorRef = visit ? `guest:${visit.tokenId}` : `entry:${entry?.id ?? ''}:${request.ip}`;
    // Per phone: each phone has its own address on the shop Wi-Fi, before and after its first order.
    const wait = limiter.take(request.ip);
    if (wait > 0) {
      void reply.header('Retry-After', String(Math.ceil(wait / 1000)));
      throw new AppError('RATE_LIMITED', 'Too many orders from this phone. Please wait a moment.');
    }
    const issued: { token: string | null } = { token: null };
    const result = await runIdempotent(
      pool,
      { scope: 'round.submit.guest', key: ctx.key, actorRef, payload: body },
      async (tx) => {
        let tokenId: string;
        let session;
        if (visit) {
          session = await lockActiveSession(tx, visit.session.id);
          tokenId = visit.tokenId;
        } else {
          if (!entry) throw new AppError('VISIT_ENDED', 'Scan the QR code on your table to order.');
          const joined = await openOrJoinFromQr(tx, entry, { customerName: body.customerName });
          session = joined.session;
          issued.token = joined.token;
          tokenId = joined.tokenId;
        }
        const round = await submitRound(tx, ctx, {
          session,
          submitter: { kind: 'guest', tokenId },
          lines: body.lines,
        });
        return {
          status: 201,
          body: {
            round,
            session: { sessionNo: session.session_no, orderType: session.order_type },
          },
        };
      },
    );
    // The token cookie is set only once the order is really saved.
    if (issued.token !== null && !result.replayed)
      setGuestCookie(reply, GUEST_COOKIE, issued.token, GUEST_TTL_SECONDS);
    if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
    return reply.code(result.status).send(result.body);
  });

  app.post('/rounds/:id/withdraw', { config: { auth: 'public' } }, async (request, reply) => {
    const { id } = parseInput(
      z.object({ id: z.string().regex(/^\d{1,18}$/) }).strict(),
      request.params,
    );
    parseInput(z.object({}).strict(), request.body ?? {});
    const ctx = guestContext(request, now());
    const visit = await visitOf(request, reply);
    if (!visit) throw new AppError('NOT_FOUND', 'Order not found');
    let result;
    try {
      result = await runIdempotent(
        pool,
        {
          scope: 'round.withdraw.guest',
          key: ctx.key,
          actorRef: `guest:${visit.tokenId}`,
          payload: { id },
        },
        async (tx) => ({
          status: 200,
          body: await withdrawRound(tx, ctx, { tokenId: visit.tokenId }, id),
        }),
      );
    } catch (error) {
      // Staff decided it first: say so without saying who.
      if (error instanceof AppError && error.code === 'ROUND_ALREADY_DECIDED') {
        throw new AppError('ROUND_ALREADY_DECIDED', 'Staff have already dealt with this order', {
          status: error.extra['status'],
        });
      }
      throw error;
    }
    return reply.code(result.status).send(result.body);
  });

  app.get('/session', { config: { auth: 'public' } }, async (request, reply) => {
    parseInput(z.object({}).strict(), request.query);
    const visit = await visitOf(request, reply);
    if (!visit) throw new AppError('NOT_FOUND', 'Nothing ordered from this phone yet');
    const expiry = await readSetting(
      pool,
      'orders.takeaway_unpaid_expiry_minutes',
      z.number().positive(),
    );
    const { rows } = await pool.query<{
      requested: Date | null;
      invoice_no: string | null;
      pay_by: Date | null;
    }>(
      `SELECT s.checkout_requested_at AS requested, i.invoice_no,
              (SELECT min(r.submitted_at) + make_interval(mins => $2) FROM cl.order_rounds r
                WHERE r.session_id = s.id AND r.status = 'pending_approval'
                  AND s.order_type = 'takeaway' AND s.opened_via = 'qr') AS pay_by
         FROM cl.dining_sessions s LEFT JOIN cl.invoices i ON i.session_id = s.id WHERE s.id = $1`,
      [visit.session.id, expiry],
    );
    const extra = rows[0];
    return {
      session: {
        sessionNo: visit.session.session_no,
        orderType: visit.session.order_type,
        status: visit.session.status,
        openedAt: visit.session.opened_at.toISOString(),
        billRequested: (extra?.requested ?? null) !== null,
        /** Counter QR: pay at the counter before this, or the order cancels itself (D-40). */
        payBy: extra?.pay_by?.toISOString() ?? null,
        invoiceNo: extra?.invoice_no ?? null,
        readOnly: visit.readOnly,
      },
      // D-09: a table's phones see every round of the table and the total.
      ...(await sessionRounds(pool, visit.session.id, visit.tokenId)),
    };
  });

  // S4: a table's guests ask for the bill (the counter QR pays first instead).
  app.post('/session/bill-request', { config: { auth: 'public' } }, async (request, reply) => {
    parseInput(z.object({}).strict(), request.body ?? {});
    const ctx = guestContext(request, now());
    const visit = await visitOf(request, reply);
    if (!visit || visit.readOnly) throw new AppError('VISIT_ENDED', 'This visit has ended.');
    if (visit.session.table_id === null) {
      throw new AppError('VALIDATION_FAILED', 'Takeaway orders are paid at the counter.');
    }
    const result = await runIdempotent(
      pool,
      {
        scope: 'session.bill_request.guest',
        key: ctx.key,
        actorRef: `guest:${visit.tokenId}`,
        payload: {},
      },
      async (tx) => {
        const session = await lockActiveSession(tx, visit.session.id);
        return { status: 200, body: await requestBill(tx, session, { kind: 'guest' }) };
      },
    );
    if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
    return reply.code(result.status).send(result.body);
  });
}
