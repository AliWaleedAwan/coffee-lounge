/**
 * Asset register routes (API.md §5.12; Phase 5 step 5.4). Reading needs `assets.read`;
 * registering, changing, maintenance and disposal `assets.manage`. Commands carry an
 * Idempotency-Key ([I]); a change names the version it was made on.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { handleCommand } from '../../platform/idempotency.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf, factsOf } from '../identity/index.ts';
import {
  ACTIVE_STATUSES,
  changeAsset,
  CONDITIONS,
  DISPOSALS,
  disposeAsset,
  listAssets,
  readAsset,
  recordMaintenance,
  registerAsset,
  type By,
} from './service.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const idParam = (request: FastifyRequest) => parseInput(z.object({ id }), request.params).id;
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const amount = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'rupees, e.g. 185000');
const reason = z.string().trim().min(3).max(300);
const tag = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$/, 'letters, digits, dot, dash, slash; up to 30');
const fields = {
  name: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(40),
  quantity: z.number().int().min(1).max(9999),
  purchaseDate: localDate.nullable(),
  purchasePrice: amount.nullable(),
  supplierId: id.nullable(),
  location: z.string().trim().max(60).nullable(),
  condition: z.enum(CONDITIONS).nullable(),
  responsibleUserId: id.nullable(),
  notes: z.string().trim().max(500).nullable(),
};

export async function assetRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; now?: () => Date },
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());
  const read = { config: { permission: 'assets.read' } };
  const manage = { config: { permission: 'assets.manage' } };
  const byOf = (request: FastifyRequest): By => {
    const auth = authOf(request);
    const facts = factsOf(request);
    return {
      who: {
        actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
        correlationId: facts.correlationId,
        ...(facts.ip ? { ip: facts.ip } : {}),
      },
      now: now(),
    };
  };

  app.get('/assets', read, async (request) => {
    const query = parseInput(
      z
        .object({
          q: z.string().max(60).optional(),
          status: z.enum(['active', ...ACTIVE_STATUSES, 'disposed']).optional(),
          category: z.string().max(40).optional(),
        })
        .strict(),
      request.query,
    );
    return listAssets(pool, query);
  });

  /** Who may look after an asset, and the suppliers it may come from. */
  app.get('/assets/choices', manage, async () => {
    const { rows: people } = await pool.query<{ id: string; name: string }>(
      `SELECT id::text, display_name AS name FROM cl.users WHERE status = 'active' ORDER BY lower(display_name), users.id`,
    );
    const { rows: suppliers } = await pool.query<{ id: string; name: string }>(
      `SELECT id::text, name FROM cl.suppliers WHERE is_active ORDER BY lower(name), suppliers.id`,
    );
    return { people, suppliers };
  });

  app.get('/assets/:id', read, async (request) => readAsset(pool, idParam(request)));

  app.post('/assets', manage, async (request, reply) => {
    const body = parseInput(
      z
        .object({
          assetTag: tag.optional(),
          name: fields.name,
          category: fields.category,
          quantity: fields.quantity.optional(),
          purchaseDate: fields.purchaseDate.optional(),
          purchasePrice: fields.purchasePrice.optional(),
          supplierId: fields.supplierId.optional(),
          location: fields.location.optional(),
          condition: fields.condition.optional(),
          responsibleUserId: fields.responsibleUserId.optional(),
          notes: fields.notes.optional(),
        })
        .strict(),
      request.body,
    );
    const auth = authOf(request);
    const by = byOf(request);
    return handleCommand(
      pool,
      request,
      reply,
      { scope: 'asset.register', actorRef: `user:${auth.user.id}`, payload: body },
      async (tx) => ({ status: 201, body: await registerAsset(tx, by, body) }),
    );
  });

  app.post('/assets/:id/changes', manage, async (request, reply) => {
    const assetId = idParam(request);
    const body = parseInput(
      z
        .object({
          version: z.number().int().min(1),
          reason: reason.optional(),
          changes: z
            .object({
              assetTag: tag.optional(),
              name: fields.name.optional(),
              category: fields.category.optional(),
              quantity: fields.quantity.optional(),
              purchaseDate: fields.purchaseDate.optional(),
              purchasePrice: fields.purchasePrice.optional(),
              supplierId: fields.supplierId.optional(),
              location: fields.location.optional(),
              condition: fields.condition.optional(),
              responsibleUserId: fields.responsibleUserId.optional(),
              notes: fields.notes.optional(),
              status: z.enum(ACTIVE_STATUSES).optional(),
            })
            .strict(),
        })
        .strict(),
      request.body,
    );
    const auth = authOf(request);
    const by = byOf(request);
    return handleCommand(
      pool,
      request,
      reply,
      { scope: `asset.change:${assetId}`, actorRef: `user:${auth.user.id}`, payload: body },
      async (tx) => ({
        status: 200,
        body: await changeAsset(tx, by, assetId, body.changes, {
          version: body.version,
          reason: body.reason,
        }),
      }),
    );
  });

  app.post('/assets/:id/maintenance', manage, async (request, reply) => {
    const assetId = idParam(request);
    const body = parseInput(
      z
        .object({
          performedOn: localDate,
          vendor: z.string().trim().max(80).optional(),
          cost: amount.optional(),
          description: z.string().trim().min(3).max(300),
          nextDue: localDate.optional(),
          expenseNo: z.string().trim().max(20).optional(),
        })
        .strict(),
      request.body,
    );
    const auth = authOf(request);
    const by = byOf(request);
    return handleCommand(
      pool,
      request,
      reply,
      { scope: `asset.maintenance:${assetId}`, actorRef: `user:${auth.user.id}`, payload: body },
      async (tx) => ({ status: 201, body: await recordMaintenance(tx, by, assetId, body) }),
    );
  });

  app.post('/assets/:id/dispose', manage, async (request, reply) => {
    const assetId = idParam(request);
    const body = parseInput(z.object({ how: z.enum(DISPOSALS), reason }).strict(), request.body);
    const auth = authOf(request);
    const by = byOf(request);
    return handleCommand(
      pool,
      request,
      reply,
      { scope: `asset.dispose:${assetId}`, actorRef: `user:${auth.user.id}`, payload: body },
      async (tx) => ({ status: 200, body: await disposeAsset(tx, by, assetId, body) }),
    );
  });
}
