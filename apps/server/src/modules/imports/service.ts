/**
 * Running an import (docs/templates/README.md "How the import behaves"; AT-82). The
 * preview runs exactly the import, in a transaction that is always rolled back, so what
 * it shows is what importing does. Importing commits only a file without a single error;
 * otherwise nothing is saved and every problem is listed with its row.
 */
import type pg from 'pg';
import { writeAudit } from '../../platform/audit.ts';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { CsvError, parseCsv } from './csv.ts';
import { templateOf, type ImportChange, type ImportError, type Run } from './templates.ts';

export interface ImportResult {
  template: string;
  file: string;
  rows: number;
  errors: ImportError[];
  changes: ImportChange[];
  summary: { create: number; update: number; unchanged: number };
}

export const MAX_ROWS = 2000;

/** Checks and (if clean) applies one file inside `tx`. Never commits by itself. */
export async function runImport(
  tx: Tx,
  who: Run['who'],
  can: (permission: string) => boolean,
  templateKey: string,
  csv: string,
  now: Date,
): Promise<ImportResult> {
  const template = templateOf(templateKey);
  if (!can(template.permission)) {
    throw new AppError('FORBIDDEN', `Importing ${template.file} needs ${template.permission}`);
  }
  const result = (errors: ImportError[], changes: ImportChange[], rows: number): ImportResult => ({
    template: template.key,
    file: template.file,
    rows,
    errors,
    changes,
    summary: {
      create: changes.filter((c) => c.action === 'create').length,
      update: changes.filter((c) => c.action === 'update').length,
      unchanged: changes.filter((c) => c.action === 'unchanged').length,
    },
  });
  let records;
  try {
    records = parseCsv(csv);
  } catch (error) {
    if (error instanceof CsvError)
      return result([{ row: error.line, message: error.message }], [], 0);
    throw error;
  }
  const [header, ...data] = records;
  const columns = header?.values.map((v) => v.toLowerCase()) ?? [];
  if (columns.join(',') !== template.columns.join(',')) {
    return result(
      [
        {
          row: 1,
          message: `The header must be exactly: ${template.columns.join(',')} (is this ${template.file}?)`,
        },
      ],
      [],
      data.length,
    );
  }
  if (data.length === 0) return result([{ row: 2, message: 'The file has no rows' }], [], 0);
  if (data.length > MAX_ROWS) {
    return result(
      [{ row: MAX_ROWS + 2, message: `At most ${String(MAX_ROWS)} rows per file` }],
      [],
      data.length,
    );
  }
  const run: Run = {
    tx,
    who,
    can,
    rows: data.map((rec) => ({
      line: rec.line,
      get: (column: string) => rec.values[template.columns.indexOf(column)] ?? '',
    })),
    errors: [],
    changes: [],
    businessDate: await businessDateOf(tx, now),
  };
  await template.run(run);
  run.errors.sort((a, b) => a.row - b.row);
  run.changes.sort((a, b) => a.row - b.row);
  return result(run.errors, run.errors.length > 0 ? [] : run.changes, data.length);
}

class Rollback extends Error {
  readonly result: ImportResult;
  constructor(result: ImportResult) {
    super('preview');
    this.result = result;
  }
}

/** What importing the file would do, without saving anything. */
export async function previewImport(
  pool: pg.Pool,
  who: Run['who'],
  can: (permission: string) => boolean,
  templateKey: string,
  csv: string,
  now: Date,
): Promise<ImportResult> {
  try {
    await withTransaction(pool, async (tx) => {
      throw new Rollback(await runImport(tx, who, can, templateKey, csv, now));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result;
    throw error;
  }
  throw new Error('unreachable');
}

/** Imports the file, all or nothing; audited with who imported which file. */
export async function applyImport(
  tx: Tx,
  who: Run['who'],
  can: (permission: string) => boolean,
  templateKey: string,
  csv: string,
  now: Date,
): Promise<ImportResult> {
  const result = await runImport(tx, who, can, templateKey, csv, now);
  if (result.errors.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${String(result.errors.length)} problem${result.errors.length === 1 ? '' : 's'} in ${result.file}: nothing was imported`,
      { errors: result.errors },
    );
  }
  // The audit row is the record of the import; its id names the import in the live hint.
  const auditId = await writeAudit(tx, who, {
    action: 'import.apply',
    entityType: 'import',
    after: { template: result.template, file: result.file, rows: result.rows, ...result.summary },
  });
  await publish(tx, {
    type: 'inventory.changed',
    entityType: 'import',
    entityId: auditId,
    topics: ['inventory', 'menu'],
  });
  return result;
}
