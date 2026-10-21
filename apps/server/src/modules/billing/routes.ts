/**
 * Bills, discounts, payments and the till shift on the staff API (API.md §5.5). Every
 * command carries an Idempotency-Key; for a payment it is also the payment's own key, so
 * a retry after a dropped connection never charges twice (AT-11).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { handleCommand } from '../../platform/idempotency.ts';
import { parseInput } from '../../platform/validation.ts';
import type { SessionRow } from '../floor/index.ts';
import { authOf } from '../identity/index.ts';
import { commandContext, requireOwnTable } from '../orders/index.ts';
import { applyDiscount, lockBill, readBill, reopenBill, voidDiscount } from './invoices.ts';
import {
  PAYMENT_METHODS,
  reprintReceipt,
  settle,
  takePayment,
  TRANSFER_PROVIDERS,
} from './payments.ts';
import { openBills } from './views.ts';
import { currentShift, openShift } from './shifts.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const idParam = (request: FastifyRequest) => parseInput(z.object({ id }), request.params).id;
const amount = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'an amount like 650 or 650.50');
const reason = z.string().trim().min(3).max(120);
const stepUpId = id.optional();

export interface BillingRouteOptions {
  pool: pg.Pool;
  now?: () => Date;
}

export async function billingRoutes(
  app: FastifyInstance,
  options: BillingRouteOptions,
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());

  app.get('/bills', { config: { permission: 'invoices.read' } }, async (request) =>
    openBills(pool, authOf(request)),
  );

  app.get('/sessions/:id/bill', { config: { permission: 'invoices.read' } }, async (request) => {
    const sessionId = idParam(request);
    const bill = await readBill(pool, sessionId);
    const session = { id: sessionId, table_id: bill.session.tableId } as SessionRow;
    await requireOwnTable(pool, authOf(request), 'invoices.read', session);
    return bill;
  });

  app.post(
    '/invoices/:id/lock',
    { config: { permission: 'invoices.lock' } },
    async (request, reply) => {
      const invoiceId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'invoice.lock', actorRef: `user:${auth.user.id}`, payload: { invoiceId } },
        async (tx) => {
          const result = await lockBill(tx, ctx, auth, invoiceId, async (locked) => {
            await settle(tx, ctx, auth, locked);
          });
          return { status: 200, body: { ...result, bill: await readBill(tx, result.sessionId) } };
        },
      );
    },
  );

  app.post(
    '/invoices/:id/reopen',
    { config: { permission: 'invoices.reopen' } },
    async (request, reply) => {
      const invoiceId = idParam(request);
      const body = parseInput(
        z.object({ reason: reason.optional(), stepUpId }).strict(),
        request.body ?? {},
      );
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        {
          scope: 'invoice.reopen',
          actorRef: `user:${auth.user.id}`,
          payload: { invoiceId, ...body },
        },
        async (tx) => ({ status: 200, body: await reopenBill(tx, ctx, auth, invoiceId, body) }),
      );
    },
  );

  app.post(
    '/invoices/:id/discounts',
    { config: { permission: 'discounts.apply' } },
    async (request, reply) => {
      const invoiceId = idParam(request);
      const body = parseInput(
        z
          .object({
            orderLineId: id.nullable(),
            kind: z.enum(['percent', 'fixed']),
            value: amount,
            reason,
            stepUpId,
          })
          .strict()
          .refine((b) => b.kind !== 'percent' || Number(b.value) <= 100, {
            message: 'a percentage is at most 100',
            path: ['value'],
          }),
        request.body,
      );
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        {
          scope: 'discount.apply',
          actorRef: `user:${auth.user.id}`,
          payload: { invoiceId, ...body },
        },
        async (tx) => ({
          status: 201,
          body: await applyDiscount(tx, ctx, auth, invoiceId, body),
        }),
      );
    },
  );

  app.post(
    '/invoices/:id/comps',
    { config: { permission: 'discounts.comp' } },
    async (request, reply) => {
      const invoiceId = idParam(request);
      const body = parseInput(z.object({ orderLineId: id, reason }).strict(), request.body);
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        {
          scope: 'discount.comp',
          actorRef: `user:${auth.user.id}`,
          payload: { invoiceId, ...body },
        },
        async (tx) => ({
          status: 201,
          body: await applyDiscount(tx, ctx, auth, invoiceId, {
            orderLineId: body.orderLineId,
            kind: 'comp',
            value: '100',
            reason: body.reason,
          }),
        }),
      );
    },
  );

  app.post(
    '/discounts/:id/void',
    { config: { permission: 'discounts.apply' } },
    async (request, reply) => {
      const discountId = idParam(request);
      const body = parseInput(z.object({ reason }).strict(), request.body);
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        {
          scope: 'discount.void',
          actorRef: `user:${auth.user.id}`,
          payload: { discountId, ...body },
        },
        async (tx) => ({
          status: 200,
          body: await voidDiscount(tx, ctx, auth, discountId, body.reason),
        }),
      );
    },
  );

  app.post(
    '/invoices/:id/payments',
    { config: { permission: 'payments.collect' } },
    async (request, reply) => {
      const invoiceId = idParam(request);
      const body = parseInput(
        z
          .object({
            lockVersion: z.number().int().min(1),
            method: z.enum(PAYMENT_METHODS),
            amount,
            tendered: amount.optional(),
            provider: z.enum(TRANSFER_PROVIDERS).optional(),
            reference: z.string().trim().min(1).max(32).optional(),
            confirmed: z.boolean().optional(),
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
        {
          scope: 'payment.take',
          actorRef: `user:${auth.user.id}`,
          payload: { invoiceId, ...body },
        },
        async (tx) => ({
          status: 201,
          body: await takePayment(tx, ctx, auth, invoiceId, body),
        }),
      );
    },
  );

  app.post(
    '/invoices/:id/receipt/reprint',
    { config: { permission: 'receipts.reprint' } },
    async (request, reply) => {
      const invoiceId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'receipt.reprint', actorRef: `user:${auth.user.id}`, payload: { invoiceId } },
        async (tx) => ({ status: 201, body: await reprintReceipt(tx, ctx, auth, invoiceId) }),
      );
    },
  );

  // ------------------------------------------------------------ the till's shift (3.8 adds the rest)
  app.get('/cash-shifts/current', { config: { permission: 'cash_shifts.operate' } }, async () =>
    currentShift(pool),
  );

  app.post(
    '/cash-shifts',
    { config: { permission: 'cash_shifts.operate' } },
    async (request, reply) => {
      const body = parseInput(z.object({ openingFloat: amount }).strict(), request.body);
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'shift.open', actorRef: `user:${auth.user.id}`, payload: body },
        async (tx) => ({ status: 201, body: await openShift(tx, ctx, auth, body) }),
      );
    },
  );
}
