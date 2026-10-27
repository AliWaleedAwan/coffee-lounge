/**
 * Ledger routes (API.md §5.10; Phase 5 step 5.1). Reading needs `ledger.read`; the
 * owner's manual entries and their reversals `ledger.manage` and an Idempotency-Key
 * ([I]): they are money records.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../platform/errors.ts';
import { handleCommand } from '../../platform/idempotency.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf, factsOf } from '../identity/index.ts';
import { CHANNELS, postAdjustment, PROVIDERS, readLedger, reverseAdjustment } from './service.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export async function ledgerRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; now?: () => Date },
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());
  const who = (request: FastifyRequest) => {
    const auth = authOf(request);
    const facts = factsOf(request);
    return {
      actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
      correlationId: facts.correlationId,
      ...(facts.ip ? { ip: facts.ip } : {}),
    };
  };
  const manage = { config: { permission: 'ledger.manage' } };

  app.get('/ledger', { config: { permission: 'ledger.read' } }, async (request) => {
    const query = parseInput(
      z
        .object({
          from: localDate.optional(),
          to: localDate.optional(),
          channel: z.enum(CHANNELS).optional(),
        })
        .strict(),
      request.query,
    );
    const today = await businessDateOf(pool, now());
    const to = query.to ?? today;
    const from = query.from ?? `${to.slice(0, 7)}-01`;
    if (from > to) throw new AppError('VALIDATION_FAILED', 'The start date is after the end date');
    return readLedger(pool, { from, to, channel: query.channel });
  });

  app.post('/ledger/entries', manage, async (request, reply) => {
    const body = parseInput(
      z
        .object({
          direction: z.enum(['in', 'out']),
          amount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'rupees, e.g. 5000'),
          channel: z.enum(CHANNELS),
          provider: z.enum(PROVIDERS).optional(),
          memo: z.string().trim().min(3).max(300),
        })
        .strict(),
      request.body,
    );
    const auth = authOf(request);
    return handleCommand(
      pool,
      request,
      reply,
      { scope: 'ledger.adjustment', actorRef: `user:${auth.user.id}`, payload: body },
      async (tx) => ({
        status: 201,
        body: await postAdjustment(tx, who(request), body, await businessDateOf(tx, now())),
      }),
    );
  });

  app.post('/ledger/entries/:id/reverse', manage, async (request, reply) => {
    const entryId = parseInput(z.object({ id }), request.params).id;
    const body = parseInput(
      z.object({ reason: z.string().trim().min(3).max(300) }).strict(),
      request.body,
    );
    const auth = authOf(request);
    return handleCommand(
      pool,
      request,
      reply,
      { scope: `ledger.reverse:${entryId}`, actorRef: `user:${auth.user.id}`, payload: body },
      async (tx) => ({
        status: 201,
        body: await reverseAdjustment(
          tx,
          who(request),
          entryId,
          body.reason,
          await businessDateOf(tx, now()),
        ),
      }),
    );
  });
}
