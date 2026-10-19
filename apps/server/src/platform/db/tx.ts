/**
 * Transactions with the global lock order (DATABASE.md §14).
 *
 * Every transaction that locks rows in several tables must lock them in one fixed
 * order, and rows within a table in ascending id order, so two transactions can never
 * wait on each other (deadlock). `tx.lock` enforces this at runtime: locking out of
 * order throws LockOrderError before PostgreSQL is even asked.
 */
import type pg from 'pg';

export const LOCK_ORDER = [
  'dining_tables',
  'table_assignments',
  'dining_sessions',
  'order_rounds',
  'order_lines',
  'inventory_balances',
  'inventory_lots',
  'stock_reservations',
  'invoices',
  'cash_shifts',
  'document_counters',
] as const;

export type LockableTable = (typeof LOCK_ORDER)[number];

/** Key column per lockable table (inventory_balances is keyed by item_id). */
const KEY_COLUMN: Record<Exclude<LockableTable, 'document_counters'>, string> = {
  dining_tables: 'id',
  table_assignments: 'id',
  dining_sessions: 'id',
  order_rounds: 'id',
  order_lines: 'id',
  inventory_balances: 'item_id',
  inventory_lots: 'id',
  stock_reservations: 'id',
  invoices: 'id',
  cash_shifts: 'id',
};

export class LockOrderError extends Error {
  override name = 'LockOrderError';
}

export interface Tx {
  query: pg.PoolClient['query'];
  /**
   * SELECT … FOR UPDATE on the given ids, in ascending order, after checking the
   * global lock order. Returns the locked rows.
   */
  lock<R extends pg.QueryResultRow = pg.QueryResultRow>(
    table: Exclude<LockableTable, 'document_counters'>,
    ids: readonly string[],
  ): Promise<R[]>;
  /** Next gapless number for a document kind and scope (e.g. 'invoice', '2026'). */
  nextNumber(kind: string, scopeKey: string): Promise<string>;
}

const compareIds = (a: string, b: string): number => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

class LockTracker {
  private lastIndex = -1;
  private lastTable: LockableTable | undefined;
  private maxIdInTable: string | undefined;

  check(table: LockableTable, sortedIds: readonly string[]): void {
    const index = LOCK_ORDER.indexOf(table);
    if (index < this.lastIndex) {
      throw new LockOrderError(
        `Lock order violated: ${table} locked after ${String(this.lastTable)} (see DATABASE.md §14)`,
      );
    }
    const first = sortedIds[0];
    if (index === this.lastIndex && first !== undefined && this.maxIdInTable !== undefined) {
      if (compareIds(first, this.maxIdInTable) <= 0) {
        throw new LockOrderError(
          `Lock order violated: ${table} id ${first} locked after higher id ${this.maxIdInTable}`,
        );
      }
    }
    if (index !== this.lastIndex) this.maxIdInTable = undefined;
    this.lastIndex = index;
    this.lastTable = table;
    const last = sortedIds.at(-1);
    if (last !== undefined) this.maxIdInTable = last;
  }
}

function createTx(client: pg.PoolClient): Tx {
  const tracker = new LockTracker();
  return {
    query: client.query.bind(client),

    async lock<R extends pg.QueryResultRow = pg.QueryResultRow>(
      table: Exclude<LockableTable, 'document_counters'>,
      ids: readonly string[],
    ): Promise<R[]> {
      if (!(table in KEY_COLUMN)) throw new LockOrderError(`Unknown lockable table ${table}`);
      const sorted = [...new Set(ids)].sort(compareIds);
      tracker.check(table, sorted);
      if (sorted.length === 0) return [];
      const key = KEY_COLUMN[table];
      const { rows } = await client.query<R>(
        `SELECT * FROM cl.${table} WHERE ${key} = ANY($1::bigint[]) ORDER BY ${key} FOR UPDATE`,
        [sorted],
      );
      return rows;
    },

    async nextNumber(kind, scopeKey) {
      tracker.check('document_counters', []);
      await client.query(
        `INSERT INTO cl.document_counters (kind, scope_key) VALUES ($1, $2)
         ON CONFLICT (kind, scope_key) DO NOTHING`,
        [kind, scopeKey],
      );
      const { rows } = await client.query<{ value: string }>(
        `UPDATE cl.document_counters SET next_value = next_value + 1
          WHERE kind = $1 AND scope_key = $2
          RETURNING (next_value - 1)::text AS value`,
        [kind, scopeKey],
      );
      const value = rows[0]?.value;
      if (value === undefined) throw new Error(`document counter ${kind}/${scopeKey} missing`);
      return value;
    },
  };
}

/**
 * Runs fn inside BEGIN … COMMIT on one pooled connection. Any error rolls back the
 * whole transaction and is rethrown.
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(createTx(client));
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch {
      // The connection itself failed; discard it rather than return it to the pool.
      client.release(true);
    }
    throw error;
  }
}
