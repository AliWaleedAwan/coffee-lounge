/**
 * Inventory item and waste routes (API.md §5.9). Reading needs `inventory.read`; items,
 * packs and barcodes `inventory.items_manage`; waste `inventory.waste`. Edits carry
 * `expectedVersion` (409 STALE_STATE when someone else changed it first). Waste moves
 * stock, so it needs an Idempotency-Key; nothing else here does.
 */
import { UNIT_CODES } from '@cl/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AuditContext } from '../../platform/audit.ts';
import { AppError } from '../../platform/errors.ts';
import { handleCommand, IDEMPOTENCY_HEADER } from '../../platform/idempotency.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { parseInput } from '../../platform/validation.ts';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { authOf, consumeStepUp, factsOf } from '../identity/index.ts';
import * as alerts from './alerts.ts';
import * as counts from './counts.ts';
import { ORDER_TYPES } from './math.ts';
import * as recipes from './recipe-editor.ts';
import * as inventory from './inventory.ts';
import { WASTE_REASONS } from './ledger.ts';
import { listWaste, recordWaste } from './waste.ts';

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

export async function stockRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; now?: () => Date },
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());
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
          existingStockExpiry: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
            .optional(),
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

  // ------------------------------------------------------------ waste (step 4.4)
  app.get('/inventory/waste', read, async (request) => {
    const query = parseInput(
      z
        .object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
            .optional(),
        })
        .strict(),
      request.query,
    );
    const date = query.date ?? (await businessDateOf(pool, now()));
    const items = await listWaste(pool, date);
    const seesCost = authOf(request).permissions.has('inventory.cost_view');
    return { date, items: seesCost ? items : items.map((w) => ({ ...w, value: null })) };
  });

  app.post(
    '/inventory/waste',
    { config: { permission: 'inventory.waste' } },
    async (request, reply) => {
      const body = parseInput(
        z
          .object({
            itemId: id,
            qty: quantity,
            uom: z.enum(UNIT_CODES).optional(),
            reasonCode: z.enum(WASTE_REASONS),
            note: z.string().trim().max(200).optional(),
            lotId: id.optional(),
          })
          .strict(),
        request.body,
      );
      const auth = authOf(request);
      const key = String(request.headers[IDEMPOTENCY_HEADER] ?? '').toLowerCase();
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'inventory.waste', actorRef: `user:${auth.user.id}`, payload: body },
        async (tx) => {
          const result = await recordWaste(
            tx,
            { actorUserId: auth.user.id, businessDate: await businessDateOf(tx, now()), key },
            whoOf(request),
            body,
          );
          const seesCost = auth.permissions.has('inventory.cost_view');
          return { status: 201, body: seesCost ? result : { ...result, value: null } };
        },
      );
    },
  );

  // ------------------------------------------------------------ stock counts (step 4.5)
  const counter = (request: FastifyRequest): counts.Counter => {
    const auth = authOf(request);
    return { userId: auth.user.id, permissions: auth.permissions, audit: whoOf(request) };
  };
  /** A count command moves stock or decides on it: Idempotency-Key required ([I]). */
  const command = <T>(
    scope: string,
    request: FastifyRequest,
    reply: Parameters<typeof handleCommand>[2],
    payload: unknown,
    run: (tx: Tx) => Promise<T>,
    status = 200,
  ) =>
    handleCommand(
      pool,
      request,
      reply,
      { scope, actorRef: `user:${authOf(request).user.id}`, payload },
      async (tx) => ({ status, body: await run(tx) }),
    );
  /**
   * Who decides on a count's variances (D-18): the caller with `inventory.count_approve`,
   * or a manager or owner approving by PIN on this device (step-up `count.variance`).
   */
  const approver = async (tx: Tx, request: FastifyRequest, countId: string, stepUpId?: string) => {
    const auth = authOf(request);
    if (auth.permissions.has('inventory.count_approve')) return auth.user.id;
    if (stepUpId === undefined) {
      throw new AppError('STEP_UP_REQUIRED', 'A manager or the owner must approve this count');
    }
    return consumeStepUp(tx, auth, {
      stepUpId,
      action: 'count.variance',
      entityType: 'stock_count',
      entityId: countId,
    });
  };
  const count = { config: { permission: 'inventory.count' } };

  app.get('/stock-counts', read, async () => ({ items: await counts.listCounts(pool) }));

  app.get('/stock-counts/:id', read, async (request) =>
    counts.readCount(pool, idParam(request), {
      costs: authOf(request).permissions.has('inventory.cost_view'),
    }),
  );

  app.post('/stock-counts', count, async (request, reply) => {
    const body = parseInput(
      z
        .object({
          scope: z.enum(['all', 'category', 'items']),
          category: z.string().trim().min(1).max(40).optional(),
          itemIds: z.array(id).min(1).max(500).optional(),
          blind: z.boolean().optional(),
          note: z.string().trim().max(200).optional(),
        })
        .strict()
        .refine((b) => b.scope !== 'category' || b.category !== undefined, 'category needed')
        .refine((b) => b.scope !== 'items' || b.itemIds !== undefined, 'itemIds needed'),
      request.body,
    );
    return command(
      'stock_count.start',
      request,
      reply,
      body,
      (tx) => counts.startCount(tx, counter(request), { ...body, now: now() }),
      201,
    );
  });

  app.post('/stock-counts/:id/lines', count, async (request) => {
    const body = parseInput(
      z
        .object({
          itemId: id,
          lotId: id.optional(),
          countedQty: z
            .string()
            .regex(/^\d{1,10}(\.\d{1,4})?$/, 'a quantity such as 0, 500 or 2.5'),
          uom: z.enum(UNIT_CODES).optional(),
          newLotExpiry: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
            .optional(),
        })
        .strict(),
      request.body,
    );
    return withTransaction(pool, (tx) =>
      counts.enterLine(tx, counter(request), idParam(request), body),
    );
  });

  app.delete('/stock-counts/:id/lines/:lineId', count, async (request, reply) => {
    const params = parseInput(z.object({ id, lineId: id }), request.params);
    await withTransaction(pool, (tx) => counts.removeLine(tx, params.id, params.lineId));
    return reply.code(204).send();
  });

  app.post('/stock-counts/:id/submit', count, async (request, reply) => {
    const countId = idParam(request);
    parseInput(z.object({}).strict(), request.body);
    return command(`stock_count.submit:${countId}`, request, reply, {}, (tx) =>
      counts.submitCount(tx, counter(request), countId, now()),
    );
  });

  app.post('/stock-counts/:id/approve', count, async (request, reply) => {
    const countId = idParam(request);
    const body = parseInput(z.object({ stepUpId: id.optional() }).strict(), request.body);
    return command(`stock_count.approve:${countId}`, request, reply, body, async (tx) =>
      counts.approveCount(
        tx,
        counter(request),
        countId,
        now(),
        await approver(tx, request, countId, body.stepUpId),
      ),
    );
  });

  app.post('/stock-counts/:id/send-back', count, async (request, reply) => {
    const countId = idParam(request);
    const body = parseInput(
      z
        .object({
          reason: z.string().trim().min(3).max(200),
          lineIds: z.array(id).min(1).max(500).optional(),
          stepUpId: id.optional(),
        })
        .strict(),
      request.body,
    );
    return command(`stock_count.send_back:${countId}`, request, reply, body, async (tx) => {
      await approver(tx, request, countId, body.stepUpId);
      return counts.sendBack(tx, counter(request), countId, body);
    });
  });

  app.post('/stock-counts/:id/cancel', count, async (request, reply) => {
    const countId = idParam(request);
    parseInput(z.object({}).strict(), request.body);
    return command(`stock_count.cancel:${countId}`, request, reply, {}, (tx) =>
      counts.cancelCount(tx, counter(request), countId),
    );
  });

  // ------------------------------------------------------------ overview, alerts, history (4.7)
  const costs = (request: FastifyRequest) => authOf(request).permissions.has('inventory.cost_view');

  app.get('/inventory/overview', read, async (request) =>
    alerts.inventoryOverview(pool, now(), costs(request)),
  );

  app.get('/inventory/alerts', read, async () => ({ items: await alerts.listAlerts(pool) }));

  app.post('/inventory/alerts/:id/acknowledge', read, async (request) => {
    parseInput(z.object({}).strict(), request.body);
    return withTransaction(pool, (tx) => alerts.acknowledgeAlert(tx, idParam(request)));
  });

  app.post('/inventory/alerts/:id/close', read, async (request) => {
    const body = parseInput(
      z.object({ note: z.string().trim().min(3).max(200) }).strict(),
      request.body,
    );
    const auth = authOf(request);
    const who = whoOf(request);
    return withTransaction(pool, (tx) =>
      alerts.closeAlert(
        tx,
        { ...who, actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id } },
        { isOwner: auth.user.isOwner, canCount: auth.permissions.has('inventory.count') },
        idParam(request),
        body.note,
      ),
    );
  });

  app.get('/inventory/items/:id/movements', read, async (request) => {
    const query = parseInput(
      z
        .object({
          from: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
            .optional(),
          to: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
            .optional(),
          type: z.enum(alerts.MOVEMENT_TYPES).optional(),
        })
        .strict(),
      request.query,
    );
    return { items: await alerts.movementHistory(pool, idParam(request), query, costs(request)) };
  });

  // ------------------------------------------------------------ recipes (step 4.8)
  const recipeRead = { config: { permission: 'recipes.read' } };
  const recipeManage = { config: { permission: 'recipes.manage' } };
  const userWho = (request: FastifyRequest) => {
    const auth = authOf(request);
    return {
      ...whoOf(request),
      actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
    };
  };

  app.get('/recipes', recipeRead, async () => ({ items: await recipes.recipeOverview(pool) }));

  app.get('/recipes/variants/:id', recipeRead, async (request) =>
    recipes.variantRecipes(pool, idParam(request)),
  );

  app.post('/recipes/variants/:id/draft', recipeManage, async (request, reply) => {
    parseInput(z.object({}).strict(), request.body);
    const draft = await withTransaction(pool, (tx) =>
      recipes.startDraft(tx, userWho(request), idParam(request)),
    );
    return reply.code(201).send(draft);
  });

  app.put('/recipes/versions/:id', recipeManage, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          prepInstructions: z.string().trim().max(1000).nullable().optional(),
          components: z
            .array(
              z
                .object({
                  itemId: id,
                  qty: quantity,
                  uom: z.enum(UNIT_CODES).optional(),
                  wastePercent: z
                    .string()
                    .regex(/^\d{1,2}(\.\d{1,2})?$/, 'a percentage such as 5')
                    .optional(),
                  forDineIn: z.boolean(),
                  forTakeaway: z.boolean(),
                  forDelivery: z.boolean(),
                })
                .strict(),
            )
            .min(1)
            .max(40),
        })
        .strict(),
      request.body,
    );
    return withTransaction(pool, (tx) =>
      recipes.saveDraft(tx, userWho(request), idParam(request), body),
    );
  });

  app.post('/recipes/versions/:id/activate', recipeManage, async (request) => {
    parseInput(z.object({}).strict(), request.body);
    return withTransaction(pool, (tx) =>
      recipes.activateDraft(tx, userWho(request), idParam(request)),
    );
  });

  app.post('/recipes/variants/:id/stock-mode', recipeManage, async (request) => {
    const body = parseInput(
      z.object({ mode: z.enum(['untracked', 'recipe']) }).strict(),
      request.body,
    );
    return withTransaction(pool, (tx) =>
      recipes.changeStockMode(tx, userWho(request), idParam(request), body.mode),
    );
  });

  app.post('/recipes/rules', recipeManage, async (request, reply) => {
    const body = parseInput(
      z
        .object({
          optionId: id,
          variantId: id.optional(),
          action: z.enum(['add', 'remove', 'replace', 'scale']),
          itemId: id,
          replacementItemId: id.optional(),
          qty: quantity.optional(),
          uom: z.enum(UNIT_CODES).optional(),
          scaleFactor: z
            .string()
            .regex(/^\d{1,4}(\.\d{1,4})?$/, 'a factor such as 1.5')
            .optional(),
        })
        .strict(),
      request.body,
    );
    const created = await withTransaction(pool, (tx) =>
      recipes.addRule(tx, userWho(request), body),
    );
    return reply.code(201).send(created);
  });

  app.post('/recipes/rules/:id/retire', recipeManage, async (request) => {
    parseInput(z.object({}).strict(), request.body);
    return withTransaction(pool, (tx) =>
      recipes.retireRule(tx, userWho(request), idParam(request)),
    );
  });

  app.post('/recipes/preview', recipeRead, async (request) => {
    const body = parseInput(
      z
        .object({
          variantId: id,
          orderType: z.enum(ORDER_TYPES),
          optionIds: z.array(id).max(20).default([]),
          draft: z.boolean().default(false),
        })
        .strict(),
      request.body,
    );
    return recipes.previewRecipe(pool, { ...body, at: now() });
  });
}
