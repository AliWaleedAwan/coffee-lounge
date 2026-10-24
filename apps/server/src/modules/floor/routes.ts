/**
 * Floor, tables, QR codes and sessions on the staff API (API.md §5.3). Commands that
 * open, move or close sessions carry an Idempotency-Key. Waiters whose permission is
 * scoped to their own tables (RBAC.md §1.3) may act only on tables assigned to them.
 */
import { networkInterfaces } from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { handleCommand } from '../../platform/idempotency.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf, factsOf, type AuthContext } from '../identity/index.ts';
import * as sessions from './sessions.ts';
import * as tables from './tables.ts';
import { readFloor } from './view.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const expectedVersion = z.number().int().min(1);
const tableFields = {
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,12}$/, 'letters, digits and - (up to 12)'),
  name: z.string().trim().min(1).max(40),
  area: z.string().trim().max(40).nullable().optional(),
  seats: z.number().int().min(1).max(50).nullable().optional(),
  layoutX: z.number().int().min(0).max(10_000).nullable().optional(),
  layoutY: z.number().int().min(0).max(10_000).nullable().optional(),
  sort: z.number().int().min(0).max(10_000).optional(),
};

function whoOf(request: FastifyRequest): tables.Who {
  const auth = authOf(request);
  const facts = factsOf(request);
  return {
    actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
    correlationId: facts.correlationId,
    ...(facts.ip ? { ip: facts.ip } : {}),
  };
}

const idParam = (request: FastifyRequest) => parseInput(z.object({ id }), request.params).id;

/**
 * For a permission granted only for the waiter's own tables: the table must be assigned
 * to this user now. Unscoped grants pass.
 */
async function requireTableScope(
  tx: Tx,
  auth: AuthContext,
  permission: string,
  tableId: string | null,
): Promise<void> {
  const grant = auth.permissions.get(permission);
  if (!grant) throw new AppError('FORBIDDEN', 'You do not have permission for this');
  if (grant.scopes === 'all') return;
  if (tableId !== null && grant.scopes.some((s) => s['tables'] === 'own')) {
    const { rows } = await tx.query(
      'SELECT 1 FROM cl.table_assignments WHERE table_id = $1 AND user_id = $2 AND ended_at IS NULL',
      [tableId, auth.user.id],
    );
    if (rows.length > 0) return;
  }
  throw new AppError('FORBIDDEN', 'This table is not assigned to you');
}

/** First LAN IPv4 address of this PC (the static address guests reach, LOCAL_LAN_HOSTING.md §2). */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

export interface FloorRouteOptions {
  pool: pg.Pool;
  /** `http://<shop address>:8080`; default: this PC's LAN address and the customer port. */
  guestBaseUrl?: string | undefined;
  customerPort?: number | undefined;
  now?: () => Date;
}

export async function floorRoutes(app: FastifyInstance, options: FloorRouteOptions): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());
  const guestBase = (request: FastifyRequest): string | null => {
    if (options.guestBaseUrl) return options.guestBaseUrl;
    const host = request.hostname.replace(/:\d+$/, '');
    const usable =
      host && !['localhost', '127.0.0.1', '[::1]'].includes(host) ? host : lanAddress();
    return usable ? `http://${usable}:${String(options.customerPort ?? 8080)}` : null;
  };

  // ------------------------------------------------------------ floor
  app.get('/floor', { config: { permission: 'tables.read' } }, async () => readFloor(pool, now()));

  // ------------------------------------------------------------ tables and QR codes
  app.get('/tables', { config: { permission: 'tables.manage' } }, async () => ({
    items: await tables.listTables(pool),
    entryPoints: await tables.listEntryPoints(pool),
  }));

  app.post('/tables', { config: { permission: 'tables.manage' } }, async (request, reply) => {
    const body = parseInput(z.object(tableFields).strict(), request.body);
    return reply.code(201).send(await tables.createTable(pool, whoOf(request), body));
  });

  app.patch('/tables/:id', { config: { permission: 'tables.manage' } }, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          ...tableFields,
          code: tableFields.code.optional(),
          name: tableFields.name.optional(),
          availability: z.enum(tables.AVAILABILITY).optional(),
        })
        .strict(),
      request.body,
    );
    return tables.updateTable(pool, whoOf(request), idParam(request), body);
  });

  app.post(
    '/tables/:id/archive',
    { config: { permission: 'tables.manage' } },
    async (request, reply) => {
      const body = parseInput(z.object({ expectedVersion }).strict(), request.body);
      await tables.archiveTable(pool, whoOf(request), idParam(request), body.expectedVersion);
      return reply.code(204).send();
    },
  );

  app.post(
    '/qr-entry-points/generate',
    { config: { permission: 'tables.manage' } },
    async (request, reply) => {
      const body = parseInput(
        z.object({ tableIds: z.array(id).max(200), counter: z.boolean() }).strict(),
        request.body,
      );
      const base = guestBase(request);
      const codes = await tables.generateQrCodes(pool, whoOf(request), body);
      return reply.code(201).send({
        baseUrl: base,
        items: codes.map((c) => ({ ...c, url: base ? `${base}/t/${c.token}` : null })),
      });
    },
  );

  // ------------------------------------------------------------ assignments (D-07)
  app.get('/assignable-staff', { config: { permission: 'tables.assign' } }, async () => ({
    items: await tables.assignableStaff(pool),
  }));

  app.put(
    '/tables/:id/assignment',
    { config: { permission: 'tables.assign' } },
    async (request, reply) => {
      const body = parseInput(z.object({ userId: id }).strict(), request.body);
      await tables.assignTable(pool, whoOf(request), idParam(request), body.userId);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/tables/:id/assignment',
    { config: { permission: 'tables.assign' } },
    async (request, reply) => {
      await tables.unassignTable(pool, whoOf(request), idParam(request));
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------ sessions
  app.post(
    '/tables/:id/sessions',
    { config: { permission: 'orders.create' } },
    async (request, reply) => {
      const tableId = idParam(request);
      const body = parseInput(
        z.object({ guestCount: z.number().int().min(1).max(50).optional() }).strict(),
        request.body ?? {},
      );
      const who = whoOf(request);
      return handleCommand(
        pool,
        request,
        reply,
        {
          scope: 'session.open',
          actorRef: `user:${who.actor.userId}`,
          payload: { tableId, ...body },
        },
        async (tx) => ({
          status: 201,
          body: sessions.sessionView(await sessions.openTableSession(tx, who, tableId, body)),
        }),
      );
    },
  );

  // S2: a takeaway for a guest at the counter (step 3.9).
  app.post(
    '/sessions/takeaway',
    { config: { permission: 'orders.create' } },
    async (request, reply) => {
      const body = parseInput(
        z.object({ customerName: z.string().trim().min(1).max(40).optional() }).strict(),
        request.body ?? {},
      );
      const who = whoOf(request);
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'session.takeaway', actorRef: `user:${who.actor.userId}`, payload: body },
        async (tx) => ({
          status: 201,
          body: sessions.sessionView(await sessions.openTakeawaySession(tx, who, body)),
        }),
      );
    },
  );

  app.get('/sessions', { config: { permission: 'orders.read_all' } }, async (request) => {
    parseInput(z.object({ status: z.literal('active').optional() }).strict(), request.query);
    return { items: await sessions.listActiveSessions(pool) };
  });

  app.post(
    '/sessions/:id/transfer',
    { config: { permission: 'sessions.transfer' } },
    async (request, reply) => {
      const sessionId = idParam(request);
      const body = parseInput(
        z.object({ toTableId: id, reason: z.string().trim().min(1).max(200).optional() }).strict(),
        request.body,
      );
      const who = whoOf(request);
      return handleCommand(
        pool,
        request,
        reply,
        {
          scope: 'session.transfer',
          actorRef: `user:${who.actor.userId}`,
          payload: { sessionId, ...body },
        },
        async (tx) => ({
          status: 200,
          body: sessions.sessionView(await sessions.transferSession(tx, who, sessionId, body)),
        }),
      );
    },
  );

  app.post(
    '/sessions/:id/reset-guests',
    { config: { permission: 'sessions.reset_guests' } },
    async (request) => {
      const sessionId = idParam(request);
      parseInput(z.object({}).strict(), request.body ?? {});
      const auth = authOf(request);
      return withTransaction(pool, async (tx) => {
        const session = await sessions.lockActiveSession(tx, sessionId);
        await requireTableScope(tx, auth, 'sessions.reset_guests', session.table_id);
        return sessions.resetGuests(tx, whoOf(request), session);
      });
    },
  );

  app.post(
    '/sessions/:id/cancel',
    { config: { permission: 'orders.void' } },
    async (request, reply) => {
      const sessionId = idParam(request);
      const body = parseInput(
        z.object({ reason: z.string().trim().min(3).max(200) }).strict(),
        request.body,
      );
      const auth = authOf(request);
      const who = whoOf(request);
      return handleCommand(
        pool,
        request,
        reply,
        {
          scope: 'session.cancel',
          actorRef: `user:${who.actor.userId}`,
          payload: { sessionId, ...body },
        },
        async (tx) => {
          const session = await sessions.lockActiveSession(tx, sessionId);
          await requireTableScope(tx, auth, 'orders.void', session.table_id);
          await sessions.cancelSession(tx, who, session, body.reason);
          return { status: 204, body: null };
        },
      );
    },
  );
}
