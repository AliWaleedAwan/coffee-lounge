/**
 * Supplier records (DATABASE.md §5, `suppliers.manage`). Versioned edits; a supplier is
 * never deleted, only made inactive (D-31), which keeps its name on old receipts.
 */
import type pg from 'pg';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import { withTransaction } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
}

export interface SupplierFields {
  name?: string | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  address?: string | null | undefined;
  notes?: string | null | undefined;
}

const COLUMNS = `id::text, name, phone, email, address, notes, is_active AS "isActive", version`;

export async function listSuppliers(db: pg.Pool, includeInactive: boolean): Promise<Supplier[]> {
  const { rows } = await db.query<Supplier>(
    `SELECT ${COLUMNS} FROM cl.suppliers WHERE $1 OR is_active
      ORDER BY is_active DESC, lower(name), suppliers.id`,
    [includeInactive],
  );
  return rows;
}

function duplicate(error: unknown, name: string | undefined): never {
  if ((error as { code?: string }).code === '23505') {
    throw new AppError('VALIDATION_FAILED', `A supplier called ${name ?? 'that'} already exists`);
  }
  throw error;
}

export async function createSupplier(
  pool: pg.Pool,
  who: AuditContext,
  input: SupplierFields & { name: string },
): Promise<{ id: string }> {
  return withTransaction(pool, async (tx) => {
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cl.suppliers (name, phone, email, address, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
        [
          input.name,
          input.phone ?? null,
          input.email ?? null,
          input.address ?? null,
          input.notes ?? null,
        ],
      );
      const id = rows[0]?.id ?? '';
      await writeAudit(tx, who, {
        action: 'supplier.create',
        entityType: 'supplier',
        entityId: id,
        after: input,
      });
      await publish(tx, {
        type: 'supplier.changed',
        entityType: 'supplier',
        entityId: id,
        topics: ['inventory'],
      });
      return { id };
    } catch (error) {
      duplicate(error, input.name);
    }
  });
}

export async function updateSupplier(
  pool: pg.Pool,
  who: AuditContext,
  id: string,
  input: SupplierFields & { expectedVersion: number; isActive?: boolean | undefined },
): Promise<{ id: string; version: number }> {
  return withTransaction(pool, async (tx) => {
    const { rows: found } = await tx.query<Supplier>(
      `SELECT ${COLUMNS} FROM cl.suppliers WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const before = found[0];
    if (!before) throw new AppError('NOT_FOUND', 'Supplier not found');
    if (before.version !== input.expectedVersion) {
      throw new AppError(
        'STALE_STATE',
        'This supplier was changed by someone else. Reload it and try again.',
        {
          currentVersion: before.version,
        },
      );
    }
    const pick = <K extends keyof SupplierFields>(key: K) =>
      input[key] === undefined ? before[key] : input[key];
    try {
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE cl.suppliers SET name = $2, phone = $3, email = $4, address = $5, notes = $6,
                is_active = $7
          WHERE id = $1 RETURNING version`,
        [
          id,
          pick('name'),
          pick('phone'),
          pick('email'),
          pick('address'),
          pick('notes'),
          input.isActive ?? before.isActive,
        ],
      );
      await writeAudit(tx, who, {
        action: 'supplier.update',
        entityType: 'supplier',
        entityId: id,
        before,
        after: input,
      });
      await publish(tx, {
        type: 'supplier.changed',
        entityType: 'supplier',
        entityId: id,
        topics: ['inventory'],
      });
      return { id, version: rows[0]?.version ?? 0 };
    } catch (error) {
      duplicate(error, input.name ?? before.name);
    }
  });
}
