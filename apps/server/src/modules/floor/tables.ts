/**
 * Dining tables, their QR codes and waiter assignments (DATABASE.md §6, API.md §5.3,
 * D-07). Tables are never deleted, only archived. A QR code's token is shown once, when
 * it is generated for printing; generating again retires the printed code.
 */
import type pg from 'pg';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { newToken } from './tokens.ts';

export type Who = AuditContext & { actor: { kind: 'user'; userId: string; deviceId?: string } };

export const AVAILABILITY = ['active', 'blocked', 'maintenance'] as const;
export type Availability = (typeof AVAILABILITY)[number];

const ACTIVE_SESSION = `status IN ('open','checkout_requested','checkout_locked')`;

async function tableChanged(tx: Tx, tableId: string, version?: number): Promise<void> {
  await publish(tx, {
    type: 'table.changed',
    entityType: 'dining_table',
    entityId: tableId,
    ...(version !== undefined ? { version } : {}),
    topics: ['floor', 'approvals', `table:${tableId}`],
  });
}

function friendly(error: unknown): never {
  const e = error as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'dining_tables_code_key') {
    throw new AppError('VALIDATION_FAILED', 'Another table already uses that code');
  }
  if (e.code === '23514')
    throw new AppError('VALIDATION_FAILED', 'The values break a rule for tables');
  throw error;
}

// ---------------------------------------------------------------- tables

export interface TableInput {
  code: string;
  name: string;
  area?: string | null | undefined;
  seats?: number | null | undefined;
  layoutX?: number | null | undefined;
  layoutY?: number | null | undefined;
  sort?: number | undefined;
}

export async function listTables(db: Queryable) {
  const { rows } = await db.query<{
    id: string;
    code: string;
    name: string;
    area: string | null;
    seats: number | null;
    layout_x: number | null;
    layout_y: number | null;
    availability: Availability;
    sort: number;
    version: number;
    qr_created_at: Date | null;
  }>(
    `SELECT t.id::text, t.code, t.name, t.area, t.seats, t.layout_x, t.layout_y, t.availability, t.sort,
            t.version, q.created_at AS qr_created_at
       FROM cl.dining_tables t
       LEFT JOIN cl.qr_entry_points q ON q.table_id = t.id AND q.is_active
      WHERE t.archived_at IS NULL
      ORDER BY t.sort, t.code`,
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    area: r.area,
    seats: r.seats,
    layoutX: r.layout_x,
    layoutY: r.layout_y,
    availability: r.availability,
    sort: r.sort,
    version: r.version,
    qrPrintedAt: r.qr_created_at?.toISOString() ?? null,
  }));
}

export async function createTable(
  pool: pg.Pool,
  who: Who,
  input: TableInput,
): Promise<{ id: string }> {
  try {
    return await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cl.dining_tables (code, name, area, seats, layout_x, layout_y, sort)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
        [
          input.code,
          input.name,
          input.area ?? null,
          input.seats ?? null,
          input.layoutX ?? null,
          input.layoutY ?? null,
          input.sort ?? 0,
        ],
      );
      const id = rows[0]?.id ?? '';
      await writeAudit(tx, who, {
        action: 'table.create',
        entityType: 'dining_table',
        entityId: id,
        after: input,
      });
      await tableChanged(tx, id, 1);
      return { id };
    });
  } catch (error) {
    friendly(error);
  }
}

async function hasActiveSession(tx: Tx, tableId: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM cl.dining_sessions WHERE table_id = $1 AND ${ACTIVE_SESSION}`,
    [tableId],
  );
  return rows.length > 0;
}

async function lockTable(tx: Tx, tableId: string, expectedVersion?: number) {
  const rows = await tx.lock<{
    id: string;
    version: number;
    archived_at: Date | null;
    availability: Availability;
  }>('dining_tables', [tableId]);
  const table = rows[0];
  if (!table || table.archived_at) throw new AppError('NOT_FOUND', 'Table not found');
  if (expectedVersion !== undefined && table.version !== expectedVersion) {
    throw new AppError(
      'STALE_STATE',
      'This table was changed by someone else. Reload and try again.',
      {
        currentVersion: table.version,
      },
    );
  }
  return table;
}

export async function updateTable(
  pool: pg.Pool,
  who: Who,
  id: string,
  input: { [K in keyof TableInput]?: TableInput[K] | undefined } & {
    expectedVersion: number;
    availability?: Availability | undefined;
  },
): Promise<{ id: string; version: number }> {
  try {
    return await withTransaction(pool, async (tx) => {
      const before = await lockTable(tx, id, input.expectedVersion);
      if (
        input.availability &&
        input.availability !== 'active' &&
        before.availability === 'active' &&
        (await hasActiveSession(tx, id))
      ) {
        throw new AppError(
          'TABLE_OCCUPIED',
          'Guests are at this table. Close or move their session first.',
        );
      }
      const has = (k: keyof TableInput) => input[k] !== undefined;
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE cl.dining_tables SET
            code = COALESCE($2, code), name = COALESCE($3, name),
            area = CASE WHEN $4::boolean THEN $5 ELSE area END,
            seats = CASE WHEN $6::boolean THEN $7::int ELSE seats END,
            layout_x = CASE WHEN $8::boolean THEN $9::int ELSE layout_x END,
            layout_y = CASE WHEN $10::boolean THEN $11::int ELSE layout_y END,
            sort = COALESCE($12, sort), availability = COALESCE($13, availability)
          WHERE id = $1 RETURNING version`,
        [
          id,
          input.code ?? null,
          input.name ?? null,
          has('area'),
          input.area ?? null,
          has('seats'),
          input.seats ?? null,
          has('layoutX'),
          input.layoutX ?? null,
          has('layoutY'),
          input.layoutY ?? null,
          input.sort ?? null,
          input.availability ?? null,
        ],
      );
      const version = rows[0]?.version ?? 0;
      await writeAudit(tx, who, {
        action:
          input.availability && input.availability !== before.availability
            ? 'table.availability'
            : 'table.update',
        entityType: 'dining_table',
        entityId: id,
        before: { availability: before.availability },
        after: input,
      });
      await tableChanged(tx, id, version);
      return { id, version };
    });
  } catch (error) {
    friendly(error);
  }
}

export async function archiveTable(
  pool: pg.Pool,
  who: Who,
  id: string,
  expectedVersion: number,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await lockTable(tx, id, expectedVersion);
    if (await hasActiveSession(tx, id)) {
      throw new AppError(
        'TABLE_OCCUPIED',
        'Guests are at this table. Close or move their session first.',
      );
    }
    await tx.query(
      `UPDATE cl.table_assignments SET ended_at = now(), ended_by = $2 WHERE table_id = $1 AND ended_at IS NULL`,
      [id, who.actor.userId],
    );
    await tx.query(
      `UPDATE cl.qr_entry_points SET is_active = false, revoked_at = now() WHERE table_id = $1 AND is_active`,
      [id],
    );
    await tx.query('UPDATE cl.dining_tables SET archived_at = now() WHERE id = $1', [id]);
    await writeAudit(tx, who, {
      action: 'table.archive',
      entityType: 'dining_table',
      entityId: id,
    });
    await tableChanged(tx, id);
  });
}

// ---------------------------------------------------------------- QR codes

export interface GeneratedCode {
  entryPointId: string;
  kind: 'table' | 'counter_takeaway';
  label: string;
  tableCode: string | null;
  /** Shown once, for printing; only its hash is stored. */
  token: string;
}

/**
 * New QR codes for the given tables and/or the counter. Each replaces the code printed
 * before for the same table (or the counter), which stops working at once.
 */
export async function generateQrCodes(
  pool: pg.Pool,
  who: Who,
  input: { tableIds: readonly string[]; counter: boolean },
): Promise<GeneratedCode[]> {
  if (input.tableIds.length === 0 && !input.counter) {
    throw new AppError('VALIDATION_FAILED', 'Choose at least one table or the counter');
  }
  return withTransaction(pool, async (tx) => {
    const tables = await tx.lock<{
      id: string;
      code: string;
      name: string;
      archived_at: Date | null;
    }>('dining_tables', input.tableIds);
    if (tables.length !== new Set(input.tableIds).size || tables.some((t) => t.archived_at)) {
      throw new AppError('NOT_FOUND', 'A chosen table does not exist');
    }
    const codes: GeneratedCode[] = [];
    for (const t of tables) {
      await tx.query(
        `UPDATE cl.qr_entry_points SET is_active = false, revoked_at = now() WHERE table_id = $1 AND is_active`,
        [t.id],
      );
      const { token, hash } = newToken();
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cl.qr_entry_points (kind, table_id, label, token_hash) VALUES ('table', $1, $2, $3) RETURNING id::text`,
        [t.id, t.name, hash],
      );
      codes.push({
        entryPointId: rows[0]?.id ?? '',
        kind: 'table',
        label: t.name,
        tableCode: t.code,
        token,
      });
    }
    if (input.counter) {
      await tx.query(
        `UPDATE cl.qr_entry_points SET is_active = false, revoked_at = now() WHERE kind = 'counter_takeaway' AND is_active`,
      );
      const { token, hash } = newToken();
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cl.qr_entry_points (kind, label, token_hash) VALUES ('counter_takeaway', 'Counter takeaway', $1) RETURNING id::text`,
        [hash],
      );
      codes.push({
        entryPointId: rows[0]?.id ?? '',
        kind: 'counter_takeaway',
        label: 'Counter takeaway',
        tableCode: null,
        token,
      });
    }
    await writeAudit(tx, who, {
      action: 'qr.generate',
      entityType: 'qr_entry_point',
      after: { tables: tables.map((t) => t.code), counter: input.counter },
    });
    return codes;
  });
}

export async function listEntryPoints(db: Queryable) {
  const { rows } = await db.query<{
    id: string;
    kind: string;
    label: string;
    table_code: string | null;
    created_at: Date;
  }>(
    `SELECT q.id::text, q.kind, q.label, t.code AS table_code, q.created_at
       FROM cl.qr_entry_points q LEFT JOIN cl.dining_tables t ON t.id = q.table_id
      WHERE q.is_active ORDER BY q.kind DESC, t.sort, t.code`,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    tableCode: r.table_code,
    printedAt: r.created_at.toISOString(),
  }));
}

// ---------------------------------------------------------------- assignments (D-07)

/** Staff who can be given tables: active users with the waiter role. */
export async function assignableStaff(db: Queryable) {
  const { rows } = await db.query<{ id: string; display_name: string }>(
    `SELECT DISTINCT u.id::text, u.display_name
       FROM cl.users u JOIN cl.user_roles ur ON ur.user_id = u.id JOIN cl.roles r ON r.id = ur.role_id
      WHERE u.status = 'active' AND r.key = 'waiter'
      ORDER BY u.display_name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.display_name }));
}

export async function assignTable(
  pool: pg.Pool,
  who: Who,
  tableId: string,
  userId: string,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await lockTable(tx, tableId);
    const { rows: waiter } = await tx.query(
      `SELECT 1 FROM cl.users u JOIN cl.user_roles ur ON ur.user_id = u.id JOIN cl.roles r ON r.id = ur.role_id
        WHERE u.id = $1 AND u.status = 'active' AND r.key = 'waiter'`,
      [userId],
    );
    if (waiter.length === 0)
      throw new AppError('VALIDATION_FAILED', 'Only an active waiter can be given a table');
    const current = await tx.query<{ id: string; user_id: string }>(
      `SELECT id::text, user_id::text FROM cl.table_assignments WHERE table_id = $1 AND ended_at IS NULL FOR UPDATE`,
      [tableId],
    );
    if (current.rows[0]?.user_id === userId) return;
    await tx.query(
      `UPDATE cl.table_assignments SET ended_at = now(), ended_by = $2 WHERE table_id = $1 AND ended_at IS NULL`,
      [tableId, who.actor.userId],
    );
    await tx.query(
      'INSERT INTO cl.table_assignments (table_id, user_id, assigned_by) VALUES ($1, $2, $3)',
      [tableId, userId, who.actor.userId],
    );
    await writeAudit(tx, who, {
      action: 'table.assign',
      entityType: 'dining_table',
      entityId: tableId,
      before: { userId: current.rows[0]?.user_id ?? null },
      after: { userId },
    });
    await tableChanged(tx, tableId);
  });
}

export async function unassignTable(pool: pg.Pool, who: Who, tableId: string): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await lockTable(tx, tableId);
    const { rows } = await tx.query<{ user_id: string }>(
      `UPDATE cl.table_assignments SET ended_at = now(), ended_by = $2
        WHERE table_id = $1 AND ended_at IS NULL RETURNING user_id::text`,
      [tableId, who.actor.userId],
    );
    if (rows.length === 0) return;
    await writeAudit(tx, who, {
      action: 'table.unassign',
      entityType: 'dining_table',
      entityId: tableId,
      before: { userId: rows[0]?.user_id },
    });
    await tableChanged(tx, tableId);
  });
}
