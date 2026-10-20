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
