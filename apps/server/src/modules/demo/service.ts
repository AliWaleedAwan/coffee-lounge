/**
 * Demo mode, for showing the system to a client (docs/phase-8/DEMO.md). It exists only where
 * scripts/demo-shop.ts loaded made-up data: then anyone can become one of the made-up people
 * with a click, and a guest can pick a table without a QR code. Deleting the demo data, which
 * works once, ends all of it for good.
 */
import type { Queryable } from '../../platform/db/pool.ts';

export async function demoPeople(db: Queryable): Promise<string[] | null> {
  const { rows } = await db.query<{ user_ids: string[] }>(
    `SELECT user_ids::text[] AS user_ids FROM cl.demo_state WHERE status = 'loaded'`,
  );
  return rows[0]?.user_ids ?? null;
}
