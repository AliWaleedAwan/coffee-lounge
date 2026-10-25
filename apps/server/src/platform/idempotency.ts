/**
 * Idempotent commands (API.md §3, ORDER_STATE_MACHINE.md general rules, AT-72).
 *
 * The idempotency row is inserted at the start of the business transaction and its
 * response stored before COMMIT, so the key and the effect commit together or not at
 * all. A concurrent duplicate blocks on the primary key until the first transaction
 * ends, then replays its stored response. A failed (rolled back) attempt leaves no row,
 * so a retry runs normally.
 */
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { isUuid } from './correlation.ts';
import { withTransaction, type Tx } from './db/tx.ts';
import { AppError } from './errors.ts';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';
const RETENTION_HOURS = 24;

export interface CommandResult<T = unknown> {
  status: number;
  body: T;
}

export interface IdempotentRequest {
  /** Endpoint family, e.g. 'round.submit', 'payment.create'. */
  scope: string;
  /** Client-generated UUID v4. */
  key: string;
  /** Who is acting, e.g. 'user:12', 'guest:845'. A key belongs to one actor. */
  actorRef: string;
  /** The request content that must be identical on a retry. */
  payload: unknown;
}

/** JSON with object keys sorted, so equal payloads always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

export function requestHash(scope: string, payload: unknown): Buffer {
  return createHash('sha256')
    .update(`${scope}\n${canonicalJson(payload)}`)
    .digest();
}

interface StoredRow {
  actor_ref: string;
  request_hash: Buffer;
  response_status: number | null;
  response_body: unknown;
  expired: boolean;
}

/**
 * Runs fn exactly once per (scope, key). Returns its result, or the stored result of
 * the first successful run with replayed = true.
 */
export async function runIdempotent<T>(
  pool: pg.Pool,
  request: IdempotentRequest,
  fn: (tx: Tx) => Promise<CommandResult<T>>,
): Promise<CommandResult<T> & { replayed: boolean }> {
  const hash = requestHash(request.scope, request.payload);
  return withTransaction(pool, async (tx) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inserted = await tx.query(
        `INSERT INTO cl.idempotency_keys (scope, key, actor_ref, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))
         ON CONFLICT (scope, key) DO NOTHING
         RETURNING key`,
        [request.scope, request.key, request.actorRef, hash, RETENTION_HOURS],
      );
      if (inserted.rowCount === 1) {
        const result = await fn(tx);
        await tx.query(
          `UPDATE cl.idempotency_keys SET response_status = $3, response_body = $4
            WHERE scope = $1 AND key = $2`,
          [request.scope, request.key, result.status, JSON.stringify(result.body ?? null)],
        );
        return { ...result, replayed: false };
      }

      const { rows } = await tx.query<StoredRow>(
        `SELECT actor_ref, request_hash, response_status, response_body,
                expires_at < now() AS expired
           FROM cl.idempotency_keys WHERE scope = $1 AND key = $2`,
        [request.scope, request.key],
      );
      const stored = rows[0];
      if (!stored) continue; // the other attempt rolled back between our statements
      if (stored.expired) {
        await tx.query('DELETE FROM cl.idempotency_keys WHERE scope = $1 AND key = $2', [
          request.scope,
          request.key,
        ]);
        continue;
      }
      if (stored.actor_ref !== request.actorRef || !stored.request_hash.equals(hash)) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request. Use a new key for a new action.',
        );
      }
      if (stored.response_status === null) {
        throw new Error('Idempotency row committed without a response');
      }
      return {
        status: stored.response_status,
        body: stored.response_body as T,
        replayed: true,
      };
    }
    throw new Error('Idempotency key could not be claimed');
  });
}

/**
 * Route helper: reads and validates the Idempotency-Key header, runs the command and
 * sends its response (with Idempotent-Replayed: true on a replay).
 */
export async function handleCommand<T>(
  pool: pg.Pool,
  httpRequest: FastifyRequest,
  reply: FastifyReply,
  options: { scope: string; actorRef: string; payload?: unknown },
  fn: (tx: Tx) => Promise<CommandResult<T>>,
): Promise<FastifyReply> {
  const key = httpRequest.headers[IDEMPOTENCY_HEADER];
  if (!isUuid(key)) {
    throw new AppError('VALIDATION_FAILED', 'Idempotency-Key header (UUID) is required', {
      fields: [{ path: 'Idempotency-Key', message: 'required UUID' }],
    });
  }
  const result = await runIdempotent(
    pool,
    {
      scope: options.scope,
      key: key.toLowerCase(),
      actorRef: options.actorRef,
      payload: options.payload ?? httpRequest.body ?? null,
    },
    fn,
  );
  if (result.replayed) void reply.header(REPLAYED_HEADER, 'true');
  return reply.code(result.status).send(result.body);
}
