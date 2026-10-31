/**
 * The test restore (BACKUP_RECOVERY.md §4; AT-81; P7-3; step 7.2). The night's dump is
 * restored into a scratch database (`coffee_lounge_restore_test`, owned by the backup login)
 * and the integrity checks are run on the copy, not on the live database:
 *   1. every stock balance equals its movements, reservations and value;
 *   2. every settled bill's total adds up and is paid exactly;
 *   3. every closed cash shift's expected cash recomputes from its payments, refunds and cash moves;
 *   4. every money source has exactly its ledger entry, and every entry its source;
 *   5. each document counter is past the highest number it issued;
 *   6. no orphaned references (the restore re-creates every foreign key, checking each row).
 * The private key is never on this PC, so the check uses the dump as it is made, just before it
 * is encrypted; that the encrypted copy opens is checked with the owner's key (DRILL-4).
 */
import pg from 'pg';
import { findLedgerMismatches } from '../ledger/index.ts';
import { findStockMismatches } from '../stock/index.ts';
import { runTool, type BackupConfig } from './tools.ts';

export interface IntegrityReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

type Db = Pick<pg.Pool, 'query'>;

const count = async (db: Db, sql: string): Promise<number> =>
  (await db.query<{ n: number }>(sql)).rows[0]?.n ?? 0;

/** The six checks of BACKUP_RECOVERY.md §4 on a database (the restored copy). */
export async function integrityChecks(db: Db): Promise<IntegrityReport> {
  const checks: IntegrityReport['checks'] = [];
  const add = (name: string, problems: number, what: string) =>
    checks.push({
      name,
      ok: problems === 0,
      detail: problems === 0 ? 'all agree' : `${String(problems)} ${what}`,
    });
  add('Stock balances = their movements', (await findStockMismatches(db)).length, 'items differ');
  add(
    'Settled bills add up and are paid',
    await count(
      db,
      `SELECT count(*)::int AS n FROM cl.invoices i
        WHERE i.status = 'settled' AND (i.total <> i.subtotal - i.discount_total + i.tax_total + i.rounding_adjustment
           OR i.paid_total <> i.total
           OR i.paid_total <> (SELECT COALESCE(sum(p.amount), 0) FROM cl.payments p WHERE p.invoice_id = i.id))`,
    ),
    'bills differ',
  );
  add(
    'Closed shifts: expected cash recomputes',
    await count(
      db,
      `SELECT count(*)::int AS n FROM cl.cash_shifts s JOIN cl.cash_shift_figures f ON f.shift_id = s.id
        WHERE s.status <> 'open' AND s.expected_cash <> f.expected_cash`,
    ),
    'shifts differ',
  );
  add(
    'Ledger: one entry per money source',
    (await findLedgerMismatches(db)).length,
    'sources differ',
  );
  add(
    'Document counters are past every number issued',
    await count(
      db,
      `SELECT count(*)::int AS n FROM cl.document_counters c
        WHERE (c.kind = 'invoice' AND c.next_value <= COALESCE((
                 SELECT max(substring(i.invoice_no FROM '([0-9]+)$')::bigint) FROM cl.invoices i
                  WHERE i.invoice_no LIKE 'INV-' || c.scope_key || '-%'), 0))
           OR (c.kind = 'refund' AND c.next_value <= COALESCE((
                 SELECT max(substring(r.refund_no FROM '([0-9]+)$')::bigint) FROM cl.refunds r
                  WHERE r.refund_no LIKE 'RF-' || c.scope_key || '-%'), 0))`,
    ),
    'counters behind',
  );
  add(
    'No orphaned references',
    await count(
      db,
      `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'cl' AND c.contype = 'f' AND NOT c.convalidated`,
    ),
    'foreign keys not checked',
  );
  return { ok: checks.every((c) => c.ok), checks };
}

/** Restores `plainDump` into the scratch database and runs the checks there. */
export async function testRestore(
  c: BackupConfig,
  scratchUrl: string,
  plainDump: Buffer,
): Promise<IntegrityReport> {
  const scratch = new pg.Pool({ connectionString: scratchUrl, max: 2 });
  try {
    await scratch.query('DROP SCHEMA IF EXISTS cl CASCADE');
    await scratch.query('DROP SCHEMA IF EXISTS cl_meta CASCADE');
    // pg_trgm is a trusted extension: the scratch database's owner may add it.
    await scratch.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await runTool(
      c,
      'pg_restore',
      [
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        '--single-transaction',
        `--dbname=${scratchUrl}`,
      ],
      plainDump,
    );
    return await integrityChecks(scratch);
  } finally {
    await scratch.query('DROP SCHEMA IF EXISTS cl CASCADE').catch(() => undefined);
    await scratch.query('DROP SCHEMA IF EXISTS cl_meta CASCADE').catch(() => undefined);
    await scratch.end();
  }
}
