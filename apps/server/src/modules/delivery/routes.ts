/**
 * Delivery on the staff API (API.md §5.6): the order, the board, dispatch, the rider's
 * return, a manager's decision on a failed delivery, and the riders. Every command carries
 * an Idempotency-Key, so a retried return records one payment (AT-60).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { handleCommand } from '../../platform/idempotency.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf } from '../identity/index.ts';
import { commandContext } from '../orders/index.ts';
import { addRider, listRiders, updateRider } from './riders.ts';
import {
  CHANNELS,
  createDelivery,
  deliveryBoard,
  dispatch,
  PAYMENT_MODES,
  readDelivery,
  recordReturn,
  resolveFailed,
} from './service.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const idParam = (request: FastifyRequest) => parseInput(z.object({ id }), request.params).id;
const text = (max: number) => z.string().trim().min(1).max(max).optional();
const reason = z.string().trim().min(3).max(200);

export interface DeliveryRouteOptions {
  pool: pg.Pool;
  now?: () => Date;
}

export async function deliveryRoutes(
  app: FastifyInstance,
  options: DeliveryRouteOptions,
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());

  /** One idempotent command: scope, body, and the service call. */
  const command = <B>(
    scope: string,
    request: FastifyRequest,
    reply: Parameters<typeof handleCommand>[2],
    payload: unknown,
    run: (
      tx: Parameters<Parameters<typeof handleCommand>[4]>[0],
      ctx: ReturnType<typeof commandContext>,
      auth: ReturnType<typeof authOf>,
    ) => Promise<B>,
    status = 200,
  ) => {
    const auth = authOf(request);
    const ctx = commandContext(request, now());
    return handleCommand(
      pool,
      request,
      reply,
      { scope, actorRef: `user:${auth.user.id}`, payload },
      async (tx) => ({
        status,
        body: await run(tx, ctx, auth),
      }),
    );
  };

  app.post(
    '/sessions/delivery',
    { config: { permission: 'delivery.create' } },
    async (request, reply) => {
      const body = parseInput(
        z
          .object({
            channel: z.enum(CHANNELS),
            paymentMode: z.enum(PAYMENT_MODES),
            customerName: text(60),
            customerPhone: z
              .string()
              .trim()
              .regex(/^[0-9 +()-]{4,20}$/, 'digits, spaces and + ( ) - only')
              .optional(),
            customerEmail: z.email().max(120).optional(),
            address: text(300),
            landmark: text(120),
            notes: text(200),
          })
          .strict(),
        request.body,
      );
      return command(
        'delivery.create',
        request,
        reply,
        body,
        (tx, ctx, auth) => createDelivery(tx, ctx, auth, body),
        201,
      );
    },
  );

  app.get('/deliveries', { config: { permission: 'delivery.create' } }, async () =>
    deliveryBoard(pool),
  );

  app.get('/deliveries/:id', { config: { permission: 'delivery.create' } }, async (request) =>
    readDelivery(pool, idParam(request)),
  );

  app.post(
    '/deliveries/:id/dispatch',
    { config: { permission: 'delivery.dispatch' } },
    async (request, reply) => {
      const deliveryId = idParam(request);
      const body = parseInput(z.object({ riderId: id }).strict(), request.body);
      return command(
        'delivery.dispatch',
        request,
        reply,
        { deliveryId, ...body },
        (tx, ctx, auth) => dispatch(tx, ctx, auth, deliveryId, body),
      );
    },
  );

  app.post(
    '/deliveries/:id/return',
    { config: { permission: 'delivery.record_return' } },
    async (request, reply) => {
      const deliveryId = idParam(request);
      const body = parseInput(
        z.discriminatedUnion('outcome', [
          z
            .object({
              outcome: z.literal('delivered'),
              method: z.enum(['cash', 'card_manual']).optional(),
              reference: z.string().trim().min(1).max(32).optional(),
              deliveredAt: z.iso.datetime().optional(),
            })
            .strict(),
          z.object({ outcome: z.literal('failed'), reason }).strict(),
        ]),
        request.body,
      );
      return command('delivery.return', request, reply, { deliveryId, ...body }, (tx, ctx, auth) =>
        recordReturn(
          tx,
          ctx,
          auth,
          deliveryId,
          body.outcome === 'delivered'
            ? {
                outcome: 'delivered',
                method: body.method,
                reference: body.reference,
                ...(body.deliveredAt ? { deliveredAt: new Date(body.deliveredAt) } : {}),
              }
            : body,
        ),
      );
    },
  );

  app.post(
    '/deliveries/:id/resolve',
    { config: { permission: 'delivery.resolve_failed' } },
    async (request, reply) => {
      const deliveryId = idParam(request);
      const body = parseInput(
        z.discriminatedUnion('action', [
          z.object({ action: z.literal('reattempt'), riderId: id.optional() }).strict(),
          z.object({ action: z.literal('convert_to_pickup') }).strict(),
          z.object({ action: z.literal('cancel'), reason }).strict(),
        ]),
        request.body,
      );
      return command('delivery.resolve', request, reply, { deliveryId, ...body }, (tx, ctx, auth) =>
        resolveFailed(tx, ctx, auth, deliveryId, body),
      );
    },
  );

  // ------------------------------------------------------------ riders (D-41)
  app.get('/riders', { config: { permission: 'delivery.dispatch' } }, async (request) => {
    const query = parseInput(
      z.object({ all: z.enum(['true']).optional() }).strict(),
      request.query,
    );
    return listRiders(pool, query.all === 'true');
  });

  app.post('/riders', { config: { permission: 'users.manage' } }, async (request, reply) => {
    const body = parseInput(
      z.object({ name: z.string().trim().min(1).max(60), phone: text(20) }).strict(),
      request.body,
    );
    return command(
      'rider.create',
      request,
      reply,
      body,
      (tx, ctx, auth) => addRider(tx, ctx, auth, body),
      201,
    );
  });

  app.patch('/riders/:id', { config: { permission: 'users.manage' } }, async (request, reply) => {
    const riderId = idParam(request);
    const body = parseInput(
      z
        .object({
          expectedVersion: z.number().int().min(1),
          name: z.string().trim().min(1).max(60).optional(),
          phone: z.string().trim().max(20).nullable().optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    return command('rider.update', request, reply, { riderId, ...body }, async (tx, ctx, auth) => {
      await updateRider(tx, ctx, auth, riderId, body);
      return { id: riderId };
    });
  });
}
