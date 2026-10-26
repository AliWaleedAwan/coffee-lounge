/**
 * Inventory item routes (API.md §5.9). Reading needs `inventory.read`; items, packs and
 * barcodes `inventory.items_manage`. Edits carry `expectedVersion` (409 STALE_STATE when
 * someone else changed it first). Nothing here moves stock, so no Idempotency-Key.
 */
import { UNIT_CODES } from '@cl/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditContext } from '../../platform/audit.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf, factsOf } from '../identity/index.ts';
import * as inventory from './inventory.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const expectedVersion = z.number().int().min(1);
/** D-27: any script on screen; SKUs are kept upper-case so "ex-milk" and "EX-MILK" are one. */
const name = z.string().trim().min(1).max(80);
const sku = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, 'letters, digits, dot, dash or underscore')
  .transform((v) => v.toUpperCase());
const category = z
  .string()
  .trim()
  .max(40)
  .transform((v) => (v === '' ? null : v))
  .nullable();
const baseUom = z.enum(['g', 'ml', 'pcs']);
/** A quantity in the item's base unit, up to 4 dp. */
const quantity = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, 'a quantity such as 500 or 2.5');
const days = z.number().int().min(0).max(365);
/** What a scanner types: printable characters, no spaces (P4-4). */
const code = z
  .string()
  .trim()
  .regex(/^[!-~]{1,64}$/, 'letters and digits as printed under the bars');

const settings = {
  category: category.optional(),
  trackLots: z.boolean().optional(),
  trackExpiry: z.boolean().optional(),
  lowThreshold: quantity.nullable().optional(),
  overstockThreshold: quantity.nullable().optional(),
  nearExpiryDays: days.nullable().optional(),
};

function whoOf(request: FastifyRequest): AuditContext {
  const auth = authOf(request);
  const facts = factsOf(request);
  return {
    actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
    correlationId: facts.correlationId,
    ...(facts.ip ? { ip: facts.ip } : {}),
  };
}

const idParam = (request: FastifyRequest) => parseInput(z.object({ id }), request.params).id;

export async function stockRoutes(app: FastifyInstance, options: { pool: pg.Pool }): Promise<void> {
  const { pool } = options;
  const read = { config: { permission: 'inventory.read' } };
  const manage = { config: { permission: 'inventory.items_manage' } };

  app.get('/inventory/items', read, async (request) => {
    const query = parseInput(
      z
        .object({
          q: z.string().max(80).optional(),
          category: z.string().max(40).optional(),
          includeArchived: z.enum(['true', 'false']).optional(),
        })
        .strict(),
      request.query,
    );
    return inventory.listItems(pool, {
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.category !== undefined ? { category: query.category } : {}),
      includeArchived: query.includeArchived === 'true',
    });
  });

  app.get('/inventory/items/:id', read, async (request) =>
    inventory.readItem(pool, idParam(request)),
  );

  app.get('/inventory/scan', read, async (request) => {
    const query = parseInput(z.object({ code }).strict(), request.query);
    return inventory.lookupBarcode(pool, query.code);
  });

  app.post('/inventory/items', manage, async (request, reply) => {
    const body = parseInput(z.object({ sku, name, baseUom, ...settings }).strict(), request.body);
    const created = await inventory.createItem(pool, whoOf(request), {
      sku: body.sku,
      name: body.name,
      baseUom: body.baseUom,
      ...(body.category ? { category: body.category } : {}),
      trackLots: body.trackLots,
      trackExpiry: body.trackExpiry,
      ...(body.lowThreshold ? { lowThreshold: body.lowThreshold } : {}),
      ...(body.overstockThreshold ? { overstockThreshold: body.overstockThreshold } : {}),
      ...(typeof body.nearExpiryDays === 'number' ? { nearExpiryDays: body.nearExpiryDays } : {}),
    });
    return reply.code(201).send(created);
  });

  app.patch('/inventory/items/:id', manage, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          name: name.optional(),
          baseUom: baseUom.optional(),
          ...settings,
        })
        .strict(),
      request.body,
    );
    return inventory.updateItem(pool, whoOf(request), idParam(request), body);
  });

  app.post('/inventory/items/:id/archive', manage, async (request) => {
    const body = parseInput(z.object({ expectedVersion }).strict(), request.body);
    return inventory.archiveItem(pool, whoOf(request), idParam(request), body.expectedVersion);
  });

  app.post('/inventory/items/:id/pack-sizes', manage, async (request, reply) => {
    const body = parseInput(
      z
        .object({
          name: z.string().trim().min(1).max(60),
          qty: z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, 'a quantity such as 1 or 0.5'),
          uom: z.enum(UNIT_CODES),
        })
        .strict(),
      request.body,
    );
    return reply
      .code(201)
      .send(await inventory.addPackSize(pool, whoOf(request), idParam(request), body));
  });

  app.patch('/inventory/pack-sizes/:id', manage, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          name: z.string().trim().min(1).max(60).optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    return inventory.updatePackSize(pool, whoOf(request), idParam(request), body);
  });

  app.post('/inventory/items/:id/barcodes', manage, async (request, reply) => {
    const body = parseInput(z.object({ code, packSizeId: id.optional() }).strict(), request.body);
    return reply
      .code(201)
      .send(await inventory.addBarcode(pool, whoOf(request), idParam(request), body));
  });

  app.post('/inventory/barcodes/:id/deactivate', manage, async (request) => {
    const body = parseInput(z.object({ expectedVersion }).strict(), request.body);
    return inventory.deactivateBarcode(
      pool,
      whoOf(request),
      idParam(request),
      body.expectedVersion,
    );
  });
}
