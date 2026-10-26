/**
 * Error responses as application/problem+json with a stable `code` (API.md §6).
 * Internal details are logged, never sent to the client.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ERROR_STATUS, type ErrorCode } from '@cl/shared';
import { isConnectionError } from './db/pool.ts';

export class AppError extends Error {
  override name = 'AppError';
  readonly code: ErrorCode;
  readonly extra: Record<string, unknown>;

  constructor(code: ErrorCode, detail: string, extra: Record<string, unknown> = {}) {
    super(detail);
    this.code = code;
    this.extra = extra;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'The request is not valid',
  UNAUTHENTICATED: 'Please log in',
  VISIT_ENDED: 'This visit has ended',
  DEVICE_NOT_REGISTERED: 'This device is not registered',
  FORBIDDEN: 'You do not have permission for this',
  NOT_IN_ACCEPTANCE_SCOPE: 'This order is not in your acceptance scope',
  STEP_UP_REQUIRED: 'Manager approval is required',
  NOT_FOUND: 'Not found',
  ROUND_ALREADY_DECIDED: 'This order was already decided',
  SESSION_LOCKED_FOR_CHECKOUT: 'The bill is being prepared',
  PENDING_ROUNDS_EXIST: 'Orders are still waiting for approval',
  BILL_CHANGED: 'The bill changed',
  QTY_EXCEEDS_REMAINING: 'Quantity exceeds what remains',
  STALE_STATE: 'Someone else changed this first',
  IDEMPOTENCY_KEY_REUSED: 'Request key reused for a different request',
  TABLE_OCCUPIED: 'The table is occupied',
  BARCODE_IN_USE: 'This barcode already belongs to another item',
  INSUFFICIENT_STOCK: 'Not enough stock',
  PRICE_CHANGED_LOCK_EXPIRED: 'The price changed',
  AMOUNT_EXCEEDS_DUE: 'Amount exceeds what is due',
  NO_OPEN_CASH_SHIFT: 'No cash shift is open',
  DISCOUNT_OVER_LIMIT: 'Discount is above your limit',
  REFUND_EXCEEDS_PAID: 'Refund exceeds what was paid',
  CARD_NUMBER_NOT_ALLOWED: 'Card numbers must not be entered',
  RATE_LIMITED: 'Too many requests',
  INTERNAL_ERROR: 'Something went wrong',
  SERVER_STARTING: 'The server is starting',
  DATABASE_UNAVAILABLE: 'The database is not reachable',
};

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  correlationId: string;
  [extra: string]: unknown;
}

export function problem(
  code: ErrorCode,
  detail: string,
  correlationId: string,
  extra: Record<string, unknown> = {},
): Problem {
  return {
    ...extra,
    type: `https://coffeelounge.local/errors/${code.toLowerCase().replaceAll('_', '-')}`,
    title: TITLES[code],
    status: ERROR_STATUS[code],
    code,
    detail,
    correlationId,
  };
}

export function sendProblem(reply: FastifyReply, body: Problem): FastifyReply {
  return reply.code(body.status).type('application/problem+json').send(body);
}

export function fieldsFromZod(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function toProblem(error: unknown, request: FastifyRequest): Problem {
  const id = request.id;
  if (error instanceof AppError) return problem(error.code, error.message, id, error.extra);
  if (error instanceof ZodError) {
    return problem('VALIDATION_FAILED', 'Some fields are invalid', id, {
      fields: fieldsFromZod(error),
    });
  }
  const fastifyError = error as Partial<FastifyError>;
  // Fastify's own client errors (malformed JSON, wrong content type, body too large).
  if (
    typeof fastifyError.statusCode === 'number' &&
    fastifyError.statusCode >= 400 &&
    fastifyError.statusCode < 500
  ) {
    return problem('VALIDATION_FAILED', fastifyError.message ?? 'Bad request', id);
  }
  if (isConnectionError(error)) {
    // Safe to retry: writes carry idempotency keys, so a commit whose reply was lost replays.
    return problem(
      'DATABASE_UNAVAILABLE',
      'The server cannot reach its database right now. Retrying automatically.',
      id,
    );
  }
  return problem('INTERNAL_ERROR', 'An unexpected error occurred. It has been logged.', id);
}

export function registerErrorHandling(
  app: FastifyInstance,
  /** Answers unmatched requests first (e.g. the web app's client-side routes). */
  notFoundFallback?: (request: FastifyRequest, reply: FastifyReply) => FastifyReply | undefined,
): void {
  app.setErrorHandler((error, request, reply) => {
    const body = toProblem(error, request);
    if (body.status >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.info({ code: body.code }, 'request rejected');
    return sendProblem(reply, body);
  });
  app.setNotFoundHandler(
    (request, reply) =>
      notFoundFallback?.(request, reply) ??
      sendProblem(reply, problem('NOT_FOUND', 'No such resource', request.id)),
  );
}
