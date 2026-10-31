/**
 * Shop settings (cl.system_settings, values from DECISIONS.md §4). Each value is JSON
 * and checked against a schema when read, so a bad edit fails loudly at the use site.
 */
import { z } from 'zod';
import type { Queryable } from './db/pool.ts';

export async function readSetting<S extends z.ZodType>(
  db: Queryable,
  key: string,
  schema: S,
): Promise<z.infer<S>> {
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM cl.system_settings WHERE key = $1',
    [key],
  );
  const row = rows[0];
  if (!row) throw new Error(`Setting ${key} is missing`);
  const parsed = schema.safeParse(row.value);
  if (!parsed.success) throw new Error(`Setting ${key} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

/** The shop's IANA time zone (D-22). */
export function shopTimeZone(db: Queryable): Promise<string> {
  return readSetting(db, 'shop.timezone', z.string().min(1));
}

/**
 * The business date of an instant: shop-local date shifted back by the day cutoff
 * (D-22: 04:00), as `YYYY-MM-DD`. Written once with a record and never recomputed.
 */
/**
 * The shop's calendar date at `at` (its own time zone, no business-day cutoff): for dates
 * people write down, such as when a machine was serviced, which may be after midnight but
 * before the 04:00 cutoff.
 */
export async function shopDateOf(db: Queryable, at: Date): Promise<string> {
  const timeZone = await shopTimeZone(db);
  const { rows } = await db.query<{ d: string }>(
    'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS d',
    [at, timeZone],
  );
  const d = rows[0]?.d;
  if (d === undefined) throw new Error('shop date not computed');
  return d;
}

export async function businessDateOf(db: Queryable, at: Date): Promise<string> {
  const timeZone = await shopTimeZone(db);
  const cutoff = await readSetting(
    db,
    'shop.business_day_cutoff',
    z.string().regex(/^\d{2}:\d{2}$/),
  );
  const { rows } = await db.query<{ d: string }>(
    'SELECT cl.business_date($1, $2, $3::time)::text AS d',
    [at, timeZone, cutoff],
  );
  const d = rows[0]?.d;
  if (d === undefined) throw new Error('business date not computed');
  return d;
}
