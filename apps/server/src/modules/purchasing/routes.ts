/**
 * Suppliers and purchase receipts (API.md §5.9). Posting and reversing a receipt move
 * stock, so they need an Idempotency-Key ([I]); supplier edits carry `expectedVersion`.
 * Receipt costs are shown to whoever receives stock or may see costs (RBAC
 * `inventory.receive`, `inventory.cost_view`); others reading inventory see quantities.
 */
import { UNIT_CODES } from '@cl/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditContext } from '../../platform/audit.ts';
import { handleCommand } from '../../platform/idempotency.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf, factsOf } from '../identity/index.ts';
import { commandContext } from '../orders/index.ts';
import {
  listReceipts,
  PAYMENT_CHANNELS,
  postReceipt,
  readReceipt,
  reverseReceipt,
  type ReceiptSummary,
} from './receipts.ts';
import { returnToSupplier } from './returns.ts';
import { createSupplier, listSuppliers, updateSupplier } from './suppliers.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const idParam = (request: FastifyRequest) => parseInput(z.object({ id }), request.params).id;
const expectedVersion = z.number().int().min(1);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const quantity = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, 'a quantity such as 6 or 2.5');

const lineSchema = z
  .object({
    itemId: id,
    packSizeId: id.optional(),
    packQty: z
      .string()
      .regex(/^\d{1,9}(\.\d{1,3})?$/, 'a number of packs such as 6 or 0.5')
      .optional(),
    qty: quantity.optional(),
    uom: z.enum(UNIT_CODES).optional(),
    lineCost: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'rupees, e.g. 1650 or 1650.50'),
    lotCode: z.string().trim().max(40).optional(),
    expiryDate: localDate.optional(),
  })
  .strict()
  .refine(
    (l) =>
      (l.packSizeId !== undefined && l.packQty !== undefined && l.qty === undefined) ||
      (l.packSizeId === undefined && l.packQty === undefined && l.qty !== undefined),
    'either packSizeId with packQty, or qty (with uom)',
  );

function whoOf(request: FastifyRequest): AuditContext {
  const auth = authOf(request);
  const facts = factsOf(request);
  return {
    actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
    correlationId: facts.correlationId,
    ...(facts.ip ? { ip: facts.ip } : {}),
  };
}

const supplierFields = {
  phone: optional(30),
  email: optional(120),
  address: optional(200),
  notes: optional(500),
};

export async function purchasingRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; now?: () => Date },
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());
  const seesCost = (request: FastifyRequest) => {
    const p = authOf(request).permissions;
    return p.has('inventory.receive') || p.has('inventory.cost_view');
  };
  const withoutCost = (r: ReceiptSummary) => ({ ...r, totalCost: null });

  // ------------------------------------------------------------ suppliers
  app.get('/suppliers', { config: { permission: 'inventory.read' } }, async (request) => {
    const query = parseInput(
      z.object({ includeInactive: z.enum(['true', 'false']).optional() }).strict(),
      request.query,
    );
    return { items: await listSuppliers(pool, query.includeInactive === 'true') };
  });

  app.post('/suppliers', { config: { permission: 'suppliers.manage' } }, async (request, reply) => {
    const body = parseInput(
      z.object({ name: z.string().trim().min(1).max(80), ...supplierFields }).strict(),
      request.body,
    );
    return reply.code(201).send(await createSupplier(pool, whoOf(request), body));
  });

  app.patch('/suppliers/:id', { config: { permission: 'suppliers.manage' } }, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          name: z.string().trim().min(1).max(80).optional(),
          isActive: z.boolean().optional(),
          ...supplierFields,
        })
        .strict(),
      request.body,
    );
    return updateSupplier(pool, whoOf(request), idParam(request), body);
  });

  // ------------------------------------------------------------ receipts
  app.get('/purchase-receipts', { config: { permission: 'inventory.read' } }, async (request) => {
    const query = parseInput(
      z.object({ date: localDate.optional(), supplierId: id.optional() }).strict(),
      request.query,
    );
    const items = await listReceipts(pool, query);
    return { items: seesCost(request) ? items : items.map(withoutCost) };
  });

  app.get(
    '/purchase-receipts/:id',
    { config: { permission: 'inventory.read' } },
    async (request) => {
      const receipt = await readReceipt(pool, idParam(request));
      if (seesCost(request)) return receipt;
      return {
        ...withoutCost(receipt),
        lines: receipt.lines.map((l) => ({ ...l, lineCost: null, unitCost: null })),
        returns: receipt.returns.map((r) => ({ ...r, value: null, refundAmount: null })),
      };
    },
  );

  app.post(
    '/purchase-receipts',
    { config: { permission: 'inventory.receive' } },
    async (request, reply) => {
      const body = parseInput(
        z
          .object({
            supplierId: id.optional(),
            supplierInvoiceRef: z.string().trim().max(60).optional(),
            note: z.string().trim().max(200).optional(),
            paidNow: z.boolean(),
            paymentChannel: z.enum(PAYMENT_CHANNELS).optional(),
            paymentReference: z.string().trim().max(60).optional(),
            startStockControl: z.array(id).max(50).optional(),
            lines: z.array(lineSchema).min(1).max(50),
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
        { scope: 'purchase_receipt.post', actorRef: `user:${auth.user.id}`, payload: body },
        async (tx) => ({ status: 201, body: await postReceipt(tx, ctx, auth, body) }),
      );
    },
  );

  app.post(
    '/purchase-receipts/:id/reverse',
    { config: { permission: 'inventory.receive' } },
    async (request, reply) => {
      const receiptId = idParam(request);
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
          scope: `purchase_receipt.reverse:${receiptId}`,
          actorRef: `user:${auth.user.id}`,
          payload: body,
        },
        async (tx) => ({
          status: 200,
          body: await reverseReceipt(tx, ctx, auth, receiptId, body.reason),
        }),
      );
    },
  );

  app.post(
    '/purchase-receipts/:id/returns',
    { config: { permission: 'inventory.receive' } },
    async (request, reply) => {
      const receiptId = idParam(request);
      const body = parseInput(
        z
          .object({
            lineId: id,
            qty: quantity,
            uom: z.enum(UNIT_CODES).optional(),
            reason: z.string().trim().min(3).max(200),
            refundAmount: z
              .string()
              .regex(/^\d{1,10}(\.\d{1,2})?$/, 'rupees, e.g. 600')
              .optional(),
            refundChannel: z.enum(PAYMENT_CHANNELS).optional(),
            refundReference: z.string().trim().max(60).optional(),
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
          scope: `purchase_receipt.return:${receiptId}`,
          actorRef: `user:${auth.user.id}`,
          payload: body,
        },
        async (tx) => ({
          status: 201,
          body: await returnToSupplier(tx, ctx, auth, receiptId, body),
        }),
      );
    },
  );
}
