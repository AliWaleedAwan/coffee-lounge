/**
 * Expense routes (API.md §5.11; Phase 5 step 5.3). Reading needs `expenses.read`; recording,
 * voiding, correcting, attaching bills and keeping the categories `expenses.manage`.
 * Commands carry an Idempotency-Key ([I]); the bill is uploaded as the raw file body
 * (`image/jpeg`, `image/png` or `application/pdf`, at most 5 MB).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../../platform/errors.ts';
import { handleCommand } from '../../platform/idempotency.ts';
import { withTransaction } from '../../platform/db/tx.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf } from '../identity/index.ts';
import { commandContext } from '../orders/index.ts';
import { ATTACHMENT_TYPES, attachBill, MAX_ATTACHMENT_BYTES, readBillFile } from './attachments.ts';
import {
  correctExpense,
  createCategory,
  listCategories,
  listExpenses,
  PAID_VIA,
  PROVIDERS,
  readExpense,
  recordExpense,
  updateCategory,
  voidExpense,
} from './service.ts';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');
const idParam = (request: FastifyRequest) => parseInput(z.object({ id }), request.params).id;
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const reason = z.string().trim().min(3).max(300);
const expenseFields = {
  categoryId: id,
  amount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'rupees, e.g. 45000'),
  payee: z.string().trim().min(1).max(80).optional(),
  reference: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(300).optional(),
  businessDate: localDate.optional(),
  paidVia: z.enum(PAID_VIA),
  provider: z.enum(PROVIDERS).optional(),
  fromTill: z.boolean().optional(),
};

export async function expenseRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; filesDir: string; now?: () => Date },
): Promise<void> {
  const { pool, filesDir } = options;
  const now = options.now ?? (() => new Date());
  const read = { config: { permission: 'expenses.read' } };
  const manage = { config: { permission: 'expenses.manage' } };

  // The bill arrives as the file itself; its real type is checked from its bytes.
  app.addContentTypeParser(
    [...ATTACHMENT_TYPES],
    { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES + 1 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  // ---------------------------------------------------------------- categories
  app.get('/expense-categories', read, async () => listCategories(pool));

  app.post('/expense-categories', manage, async (request, reply) => {
    const body = parseInput(
      z.object({ name: z.string().trim().min(2).max(60) }).strict(),
      request.body,
    );
    const auth = authOf(request);
    const ctx = commandContext(request, now());
    return handleCommand(
      pool,
      request,
      reply,
      { scope: 'expense_category.create', actorRef: `user:${auth.user.id}`, payload: body },
      async (tx) => ({ status: 201, body: await createCategory(tx, ctx, auth, body.name) }),
    );
  });

  app.patch('/expense-categories/:id', manage, async (request) => {
    const categoryId = idParam(request);
    const body = parseInput(
      z
        .object({
          name: z.string().trim().min(2).max(60).optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      request.body,
    );
    const auth = authOf(request);
    const ctx = commandContext(request, now());
    return withTransaction(pool, (tx) => updateCategory(tx, ctx, auth, categoryId, body));
  });

  // ---------------------------------------------------------------- expenses
  app.get('/expenses', read, async (request) => {
    const query = parseInput(
      z
        .object({
          from: localDate.optional(),
          to: localDate.optional(),
          categoryId: id.optional(),
          status: z.enum(['recorded', 'voided']).optional(),
        })
        .strict(),
      request.query,
    );
    const today = await businessDateOf(pool, now());
    const to = query.to ?? today;
    const from = query.from ?? `${to.slice(0, 7)}-01`;
    if (from > to) throw new AppError('VALIDATION_FAILED', 'The start date is after the end date');
    return listExpenses(pool, { from, to, categoryId: query.categoryId, status: query.status });
  });

  app.get('/expenses/:id', read, async (request) => readExpense(pool, idParam(request)));

  app.post('/expenses', manage, async (request, reply) => {
    const body = parseInput(z.object(expenseFields).strict(), request.body);
    const auth = authOf(request);
    const ctx = commandContext(request, now());
    return handleCommand(
      pool,
      request,
      reply,
      { scope: 'expense.record', actorRef: `user:${auth.user.id}`, payload: body },
      async (tx) => ({ status: 201, body: await recordExpense(tx, ctx, auth, body) }),
    );
  });

  app.post('/expenses/:id/void', manage, async (request, reply) => {
    const expenseId = idParam(request);
    const body = parseInput(z.object({ reason }).strict(), request.body);
    const auth = authOf(request);
    const ctx = commandContext(request, now());
    return handleCommand(
      pool,
      request,
      reply,
      { scope: `expense.void:${expenseId}`, actorRef: `user:${auth.user.id}`, payload: body },
      async (tx) => {
        const voided = await voidExpense(tx, ctx, auth, expenseId, body.reason);
        return {
          status: 200,
          body: { id: voided.id, expenseNo: voided.expenseNo, backInTill: voided.backInTill },
        };
      },
    );
  });

  app.post('/expenses/:id/correct', manage, async (request, reply) => {
    const expenseId = idParam(request);
    const body = parseInput(z.object({ ...expenseFields, reason }).strict(), request.body);
    const auth = authOf(request);
    const ctx = commandContext(request, now());
    const { reason: why, ...input } = body;
    return handleCommand(
      pool,
      request,
      reply,
      { scope: `expense.correct:${expenseId}`, actorRef: `user:${auth.user.id}`, payload: body },
      async (tx) => ({
        status: 201,
        body: await correctExpense(tx, ctx, auth, expenseId, why, input),
      }),
    );
  });

  app.put(
    '/expenses/:id/attachment',
    { ...manage, bodyLimit: MAX_ATTACHMENT_BYTES + 1 },
    async (request) => {
      const expenseId = idParam(request);
      if (!Buffer.isBuffer(request.body)) {
        throw new AppError('VALIDATION_FAILED', 'Send the file itself as JPEG, PNG or PDF');
      }
      const bytes = request.body;
      const auth = authOf(request);
      const ctx = commandContext(request, now());
      return withTransaction(pool, (tx) => attachBill(tx, ctx, auth, filesDir, expenseId, bytes));
    },
  );

  app.get('/expenses/:id/attachment', read, async (request, reply) => {
    const file = await readBillFile(pool, filesDir, idParam(request));
    return reply
      .header('content-type', file.type)
      .header('content-disposition', `inline; filename="${file.name}"`)
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-security-policy',
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      )
      .header('cache-control', 'private, no-store')
      .send(file.bytes);
  });
}
