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
  /**
   * Act as this role on every connection (SET ROLE at connect). Tests use it to run
   * with exactly the application's privileges; production logs in as a member of it.
   */
  sessionRole?: 'cl_app' | 'cl_readonly';
}

export function createPool({
  connectionString,
  max = 10,
  onError,
  sessionRole,
}: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    ...(sessionRole ? { options: `-c role=${sessionRole}` } : {}),
    application_name: 'coffeelounge',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // A client losing its connection must not crash the process: the pool reports idle
  // clients here; a checked-out client also emits on itself (its query rejects anyway).
  pool.on('error', (error) => onError?.(error));
  pool.on('connect', (client) => {
    client.on('error', (error) => onError?.(error));
  });
  return pool;
}

/** Anything that can run a query: a pool, a client or a transaction. */
export interface Queryable {
  query: pg.Pool['query'];
}

/** Node socket errors and PostgreSQL SQLSTATEs that mean "no usable connection". */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  '57P01', // admin_shutdown (server stopped or connection terminated)
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (server starting up)
]);
const CONNECTION_MESSAGES =
  /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|Client was closed|Connection terminated unexpectedly/;

/** Whether an error means the database could not be reached (not a query or data error). */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && (CONNECTION_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code))) {
    return true;
  }
  if (error instanceof AggregateError && error.errors.some(isConnectionError)) return true;
  return CONNECTION_MESSAGES.test(error.message);
}
