/**
 * Menu and catalogue routes (API.md §5.7). Reading the menu needs `menu.read`;
 * catalogue edits `menu.manage`; prices `menu.price_change`; the temporary
 * unavailable switch `menu.availability_toggle`; promotions `promotions.manage`.
 * Edits carry `expectedVersion` (409 STALE_STATE when someone else changed it first).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { parseInput } from '../../platform/validation.ts';
import { authOf, factsOf } from '../identity/index.ts';
import * as catalog from './service.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const name = z.string().trim().min(1).max(80);
const sort = z.number().int().min(0).max(10_000);
const expectedVersion = z.number().int().min(1);
/** Menu prices are whole rupees (D-16); "350" and "350.00" are both accepted. */
const rupees = z
  .string()
  .regex(/^\d{1,9}(\.00?)?$/, 'whole rupees, e.g. 350')
  .transform((v) => v.split('.')[0] ?? v);
const reason = z.string().trim().min(3).max(200);
/** MENU-008: kept exactly as typed; only refused when blank. */
const dietaryTag = z
  .string()
  .max(40)
  .refine((t) => t.trim().length > 0, 'must not be blank');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

const variantInput = z
  .object({ name, price: rupees, isDefault: z.boolean().optional(), sort: sort.optional() })
  .strict();
const itemFields = {
  categoryId: id,
  name,
  description: z.string().trim().max(500).nullable().optional(),
  dietaryTags: z.array(dietaryTag).max(10).optional(),
  allowDineIn: z.boolean().optional(),
  allowTakeaway: z.boolean().optional(),
  allowDelivery: z.boolean().optional(),
  sort: sort.optional(),
  modifierGroupIds: z.array(id).max(20).optional(),
};
const optionInput = z
  .object({ name, priceDelta: rupees.optional(), sort: sort.optional() })
  .strict();
const promotionFields = {
  name,
  kind: z.enum(['percent', 'fixed']),
  value: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'a number such as 10 or 25.50'),
  startsOn: localDate,
  endsOn: localDate.nullable().optional(),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().optional(),
  timeFrom: localTime.nullable().optional(),
  timeTo: localTime.nullable().optional(),
  itemIds: z.array(id).max(200).optional(),
  categoryIds: z.array(id).max(50).optional(),
};

function whoOf(request: FastifyRequest): catalog.Who {
  const auth = authOf(request);
  const facts = factsOf(request);
  return {
    actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
    correlationId: facts.correlationId,
    ...(facts.ip ? { ip: facts.ip } : {}),
  };
}

const idParam = (request: FastifyRequest) => parseInput(z.object({ id }), request.params).id;
const versionBody = (request: FastifyRequest) =>
  parseInput(z.object({ expectedVersion }).strict(), request.body).expectedVersion;

export interface CatalogRouteOptions {
  pool: pg.Pool;
  /** Clock for promotions (tests). */
  now?: () => Date;
}

export async function catalogRoutes(
  app: FastifyInstance,
  options: CatalogRouteOptions,
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());

  // ------------------------------------------------------------ reading
  app.get('/menu', { config: { permission: 'menu.read' } }, async () =>
    catalog.readMenu(pool, { management: false, now: now() }),
  );

  app.get('/menu/catalog', { config: { permission: 'menu.manage' } }, async () =>
    catalog.readMenu(pool, { management: true, now: now() }),
  );

  app.get(
    '/menu/variants/:id/price-history',
    { config: { permission: 'menu.manage' } },
    async (request) => ({ items: await catalog.priceHistory(pool, idParam(request)) }),
  );

  app.post(
    '/menu/variants/:id/availability',
    { config: { permission: 'menu.availability_toggle' } },
    async (request) => {
      const body = parseInput(
        z
          .object({ available: z.boolean(), reason: z.string().trim().min(1).max(120).optional() })
          .strict(),
        request.body,
      );
      return catalog.setAvailability(pool, whoOf(request), idParam(request), body);
    },
  );

  // ------------------------------------------------------------ categories
  app.post(
    '/menu/categories',
    { config: { permission: 'menu.manage' } },
    async (request, reply) => {
      const body = parseInput(z.object({ name, sort: sort.optional() }).strict(), request.body);
      return reply.code(201).send(await catalog.createCategory(pool, whoOf(request), body));
    },
  );

  app.patch('/menu/categories/:id', { config: { permission: 'menu.manage' } }, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          name: name.optional(),
          sort: sort.optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    return catalog.updateCategory(pool, whoOf(request), idParam(request), body);
  });

  app.post(
    '/menu/categories/:id/archive',
    { config: { permission: 'menu.manage' } },
    async (request, reply) => {
      await catalog.archiveCategory(pool, whoOf(request), idParam(request), versionBody(request));
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------ items and variants
  app.post('/menu/items', { config: { permission: 'menu.manage' } }, async (request, reply) => {
    const body = parseInput(
      z.object({ ...itemFields, variants: z.array(variantInput).min(1).max(10) }).strict(),
      request.body,
    );
    return reply.code(201).send(await catalog.createItem(pool, whoOf(request), body));
  });

  app.patch('/menu/items/:id', { config: { permission: 'menu.manage' } }, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          ...itemFields,
          categoryId: id.optional(),
          name: name.optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    return catalog.updateItem(pool, whoOf(request), idParam(request), body);
  });

  app.post(
    '/menu/items/:id/archive',
    { config: { permission: 'menu.manage' } },
    async (request, reply) => {
      await catalog.archiveItem(pool, whoOf(request), idParam(request), versionBody(request));
      return reply.code(204).send();
    },
  );

  app.post(
    '/menu/items/:id/variants',
    { config: { permission: 'menu.manage' } },
    async (request, reply) => {
      const body = parseInput(variantInput, request.body);
      return reply
        .code(201)
        .send(await catalog.addVariant(pool, whoOf(request), idParam(request), body));
    },
  );

  app.patch('/menu/variants/:id', { config: { permission: 'menu.manage' } }, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          name: name.optional(),
          sort: sort.optional(),
          isDefault: z.boolean().optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    return catalog.updateVariant(pool, whoOf(request), idParam(request), body);
  });

  app.post(
    '/menu/variants/:id/archive',
    { config: { permission: 'menu.manage' } },
    async (request, reply) => {
      await catalog.archiveVariant(pool, whoOf(request), idParam(request), versionBody(request));
      return reply.code(204).send();
    },
  );

  app.post(
    '/menu/variants/:id/price',
    { config: { permission: 'menu.price_change' } },
    async (request) => {
      const body = parseInput(
        z.object({ expectedVersion, price: rupees, reason }).strict(),
        request.body,
      );
      return catalog.changePrice(pool, whoOf(request), idParam(request), body);
    },
  );

  // ------------------------------------------------------------ modifiers
  app.post(
    '/modifier-groups',
    { config: { permission: 'menu.manage' } },
    async (request, reply) => {
      const body = parseInput(
        z
          .object({
            name,
            minSelect: z.number().int().min(0).max(20),
            maxSelect: z.number().int().min(1).max(20),
            options: z.array(optionInput).min(1).max(30),
          })
          .strict(),
        request.body,
      );
      return reply.code(201).send(await catalog.createModifierGroup(pool, whoOf(request), body));
    },
  );

  app.patch('/modifier-groups/:id', { config: { permission: 'menu.manage' } }, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          name: name.optional(),
          minSelect: z.number().int().min(0).max(20).optional(),
          maxSelect: z.number().int().min(1).max(20).optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    return catalog.updateModifierGroup(pool, whoOf(request), idParam(request), body);
  });

  app.post(
    '/modifier-groups/:id/options',
    { config: { permission: 'menu.manage' } },
    async (request, reply) => {
      const body = parseInput(optionInput, request.body);
      return reply
        .code(201)
        .send(await catalog.addModifierOption(pool, whoOf(request), idParam(request), body));
    },
  );

  app.patch('/modifier-options/:id', { config: { permission: 'menu.manage' } }, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          name: name.optional(),
          priceDelta: rupees.optional(),
          sort: sort.optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    const canChangePrice = authOf(request).permissions.has('menu.price_change');
    return catalog.updateModifierOption(
      pool,
      whoOf(request),
      idParam(request),
      body,
      canChangePrice,
    );
  });

  // ------------------------------------------------------------ promotions
  app.get('/promotions', { config: { permission: 'promotions.manage' } }, async () => ({
    items: await catalog.loadPromotionRules(pool, false),
  }));

  app.post(
    '/promotions',
    { config: { permission: 'promotions.manage' } },
    async (request, reply) => {
      const body = parseInput(z.object(promotionFields).strict(), request.body);
      return reply.code(201).send(await catalog.createPromotion(pool, whoOf(request), body));
    },
  );

  app.patch('/promotions/:id', { config: { permission: 'promotions.manage' } }, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          ...promotionFields,
          name: name.optional(),
          kind: promotionFields.kind.optional(),
          value: promotionFields.value.optional(),
          startsOn: localDate.optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    return catalog.updatePromotion(pool, whoOf(request), idParam(request), body);
  });
}
