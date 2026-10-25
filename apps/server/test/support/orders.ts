/**
 * Real order lines for tests that need one (stock reservations and line costs reference
 * cl.order_lines). Each call makes a takeaway session with one accepted-looking round of
 * `count` lines on a shared test item; nothing else about them matters to the caller.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../src/platform/db/pool.ts';

const variants = new WeakMap<object, string>();

async function testVariant(db: Queryable & object): Promise<string> {
  const cached = variants.get(db);
  if (cached) return cached;
  const { rows } = await db.query<{ id: string }>(
    `WITH c AS (INSERT INTO cl.menu_categories (name) VALUES ('Test lines') RETURNING id),
          i AS (INSERT INTO cl.menu_items (category_id, name) SELECT id, 'Test item' FROM c RETURNING id)
     INSERT INTO cl.menu_variants (item_id, name, price) SELECT id, 'Regular', 100 FROM i RETURNING id::text`,
  );
  const id = rows[0]?.id ?? '';
  variants.set(db, id);
  return id;
}

export async function testOrderLines(
  db: Queryable & object,
  userId: string,
  count = 1,
): Promise<string[]> {
  const variantId = await testVariant(db);
  const tag = randomUUID().slice(0, 8);
  const { rows: s } = await db.query<{ id: string }>(
    `INSERT INTO cl.dining_sessions (session_no, order_type, opened_via, opened_by_user_id, business_date)
     VALUES ($1, 'takeaway', 'staff', $2, current_date) RETURNING id::text`,
    [`S-TEST-${tag}`, userId],
  );
  const sessionId = s[0]?.id ?? '';
  const { rows: r } = await db.query<{ id: string }>(
    `INSERT INTO cl.order_rounds (session_id, round_no, round_ref, source, status, submitted_by_user_id, quoted_total)
     VALUES ($1, 1, $2, 'reception', 'pending_approval', $3, 0) RETURNING id::text`,
    [sessionId, `R-TEST-${tag}`, userId],
  );
  const roundId = r[0]?.id ?? '';
  const ids: string[] = [];
  for (let n = 1; n <= count; n++) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO cl.order_lines (round_id, session_id, line_no, variant_id, item_name_snap, variant_name_snap, qty, unit_price_quoted)
       VALUES ($1, $2, $3, $4, 'Test item', 'Regular', 1, 100) RETURNING id::text`,
      [roundId, sessionId, n, variantId],
    );
    ids.push(rows[0]?.id ?? '');
  }
  return ids;
}
