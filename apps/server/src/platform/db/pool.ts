/**
 * PostgreSQL connection pool.
 *
 * Type handling (DATABASE.md §1): NUMERIC and BIGINT stay strings (never JS numbers,
 * the client's default); DATE stays "YYYY-MM-DD" (the default parser would build a
 * local-time Date and could shift a business date by a day); TIMESTAMPTZ becomes a
 * Date (an instant).
 */
import pg from 'pg';

// Process-wide parser registration: this service is the only user of `pg` in the process.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

export interface PoolOptions {
  connectionString: string;
  max?: number;
  onError?: (error: Error) => void;
}

export function createPool({ connectionString, max = 10, onError }: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: 'coffeelounge',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client losing its connection must not crash the process.
  pool.on('error', (error) => onError?.(error));
  return pool;
}

/** Anything that can run a query: a pool, a client or a transaction. */
export interface Queryable {
  query: pg.Pool['query'];
}
