/**
 * Riders (D-41): people without a login. The owner (or a manager given `users.manage`)
 * keeps the list; the cashier picks a rider at dispatch.
 */
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { whoOf } from '../billing/index.ts';
import type { CommandContext, StaffAuth } from '../orders/index.ts';

export async function listRiders(db: Queryable, includeInactive: boolean) {
  const { rows } = await db.query<{
    id: string;
    display_name: string;
    phone: string | null;
    is_active: boolean;
    version: number;
  }>(
    `SELECT id::text, display_name, phone, is_active, version FROM cl.staff_profiles
      WHERE kind = 'rider' AND ($1::boolean OR is_active) ORDER BY is_active DESC, display_name`,
    [includeInactive],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.display_name,
      phone: r.phone,
      isActive: r.is_active,
      version: r.version,
    })),
  };
}

const duplicate = (error: unknown): boolean => (error as { code?: string }).code === '23505';

export async function addRider(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  input: { name: string; phone?: string | undefined },
): Promise<{ id: string }> {
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cl.staff_profiles (display_name, kind, phone) VALUES ($1, 'rider', $2) RETURNING id::text`,
      [input.name.trim(), input.phone?.trim() || null],
    );
    const id = rows[0]?.id ?? '';
    await writeAudit(tx, whoOf(auth, ctx), {
      action: 'rider.create',
      entityType: 'staff_profile',
      entityId: id,
      after: { name: input.name },
    });
    return { id };
  } catch (error) {
    if (duplicate(error)) throw new AppError('VALIDATION_FAILED', 'A rider with that name exists');
    throw error;
  }
}

export async function updateRider(
  tx: Tx,
  ctx: CommandContext,
  auth: StaffAuth,
  riderId: string,
  input: {
    expectedVersion: number;
    name?: string | undefined;
    phone?: string | null | undefined;
    isActive?: boolean | undefined;
  },
): Promise<void> {
  try {
    const { rowCount } = await tx.query(
      `UPDATE cl.staff_profiles SET display_name = coalesce($3, display_name),
              phone = CASE WHEN $4::boolean THEN $5 ELSE phone END, is_active = coalesce($6, is_active)
        WHERE id = $1 AND version = $2 AND kind = 'rider'`,
      [
        riderId,
        input.expectedVersion,
        input.name?.trim() ?? null,
        input.phone !== undefined,
        input.phone?.trim() || null,
        input.isActive ?? null,
      ],
    );
    if (!rowCount) {
      throw new AppError('STALE_STATE', 'This rider was changed meanwhile, or does not exist');
    }
  } catch (error) {
    if (duplicate(error)) throw new AppError('VALIDATION_FAILED', 'A rider with that name exists');
    throw error;
  }
  await writeAudit(tx, whoOf(auth, ctx), {
    action: 'rider.update',
    entityType: 'staff_profile',
    entityId: riderId,
    after: input,
  });
}
