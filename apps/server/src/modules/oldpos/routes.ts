/**
 * The old POS (owner's request, Nov 2026): its import (owner only, as it adds the menu and
 * personal details), the customer list and look-up for deliveries, and its sales history.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { authOf, factsOf } from '../identity/index.ts';
import { withTransaction } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { shopTimeZone } from '../../platform/settings.ts';
import { parseInput } from '../../platform/validation.ts';
import { normalizeMobile } from './history.ts';
import { importOldPos, readOldPosFile, type OldPosResult } from './service.ts';

/** The whole export, compressed: about 3 MB for two years of a busy shop. */
const MAX_UPLOAD = 60_000_000;

export async function oldPosRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool },
): Promise<void> {
  const { pool } = options;
  const whoOf = (request: FastifyRequest) => {
    const auth = authOf(request);
    const facts = factsOf(request);
    return {
      actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
      correlationId: facts.correlationId,
      ...(facts.ip ? { ip: facts.ip } : {}),
    };
  };

  await app.register(async (upload) => {
    upload.addContentTypeParser(
      ['application/gzip', 'application/json', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD },
      (_request, body, done) => {
        done(null, body);
      },
    );
    const run = async (request: FastifyRequest, keep: boolean): Promise<OldPosResult> => {
      if (!Buffer.isBuffer(request.body))
        throw new AppError('VALIDATION_FAILED', 'Send the export file itself');
      const file = readOldPosFile(request.body);
      const ROLLBACK = new Error('preview');
      let result: OldPosResult | undefined;
      try {
        await withTransaction(pool, async (tx) => {
          result = await importOldPos(tx, whoOf(request), file, await shopTimeZone(tx));
          if (!keep) throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) throw error;
      }
      if (!result) throw new Error('import gave no result');
      return result;
    };
    const route = { config: { permission: 'settings.manage' }, bodyLimit: MAX_UPLOAD };
    // The preview is the import itself, always rolled back: what it shows is what happens.
    upload.post('/imports/old-pos/preview', route, (request) => run(request, false));
    upload.post('/imports/old-pos/apply', route, (request) => run(request, true));
  });

  // ------------------------------------------------------------ customers (deliveries)
  app.get('/customers', { config: { permission: 'delivery.create' } }, async (request) => {
    const { q } = parseInput(
      z.object({ q: z.string().trim().max(60).optional() }).strict(),
      request.query,
    );
    const term = q ?? '';
    const digits = term.replace(/\D/g, '');
    const { rows } = await pool.query<{
      id: string;
      mobile: string;
      name: string | null;
      location: string | null;
      lastSeen: string | null;
      bills: number;
    }>(
      `SELECT c.id::text, c.mobile, c.name, c.location, c.last_seen::text AS "lastSeen",
              (SELECT count(*)::int FROM cl.old_pos_bills b WHERE b.customer_mobile = c.mobile) AS bills
         FROM cl.customers c
        WHERE $1 = ''
           OR ($2 <> '' AND c.mobile LIKE '%' || $2 || '%')
           OR lower(c.name) LIKE '%' || lower($1) || '%'
        ORDER BY c.last_seen DESC NULLS LAST, c.id
        LIMIT 50`,
      [term, digits.length >= 3 ? digits : ''],
    );
    const { rows: count } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM cl.customers',
    );
    return { items: rows, total: count[0]?.n ?? 0 };
  });

  /** For the delivery form: the customer behind a mobile number, if known. */
  app.get('/customers/lookup', { config: { permission: 'delivery.create' } }, async (request) => {
    const { mobile } = parseInput(z.object({ mobile: z.string().max(30) }).strict(), request.query);
    const normal = normalizeMobile(mobile);
    if (!normal) return { customer: null };
    const { rows } = await pool.query<{ name: string | null; location: string | null }>(
      'SELECT name, location FROM cl.customers WHERE mobile = $1',
      [normal],
    );
    return { customer: rows[0] ?? null };
  });

  // ------------------------------------------------------------ old sales (history)
  app.get('/reports/old-pos', { config: { permission: 'reports.sales' } }, async (request) => {
    const query = parseInput(
      z
        .object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
        .strict(),
      request.query,
    );
    if (query.to < query.from)
      throw new AppError('VALIDATION_FAILED', 'The end is before the start');
    const tz = await shopTimeZone(pool);
    const range = [query.from, query.to, tz];
    const { rows: days } = await pool.query<{ date: string; bills: number; sales: number }>(
      `SELECT (sold_at AT TIME ZONE $3)::date::text AS date, count(*)::int AS bills,
              sum(payable)::bigint::float8 AS sales
         FROM cl.old_pos_bills
        WHERE status = 'paid' AND (sold_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 1`,
      range,
    );
    const { rows: items } = await pool.query<{
      item: string;
      category: string | null;
      qty: number;
      amount: number;
    }>(
      `SELECT item, category, sum(qty)::bigint::float8 AS qty, sum(amount)::bigint::float8 AS amount
         FROM cl.old_pos_bill_lines
        WHERE status = 'paid' AND (sold_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
        GROUP BY item, category ORDER BY sum(amount) DESC LIMIT 25`,
      range,
    );
    const { rows: span } = await pool.query<{ first: string | null; last: string | null }>(
      `SELECT min((sold_at AT TIME ZONE $1)::date)::text AS first,
              max((sold_at AT TIME ZONE $1)::date)::text AS last FROM cl.old_pos_bills`,
      [tz],
    );
    return {
      from: query.from,
      to: query.to,
      available: span[0] ?? { first: null, last: null },
      totals: {
        bills: days.reduce((n, d) => n + d.bills, 0),
        sales: days.reduce((n, d) => n + d.sales, 0),
      },
      days,
      items,
    };
  });
}
