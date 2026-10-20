/**
 * Menu catalogue (DATABASE.md §4, API.md §5.7). Edits use optimistic versions
 * (`expectedVersion` → 409 STALE_STATE, CT-10); nothing is deleted, only archived;
 * every change is audited and announced on the `menu` topic in the same transaction.
 */
import { Decimal, money } from '@cl/shared';
import type pg from 'pg';
import { writeAudit, type Actor } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { shopTimeZone } from '../../platform/settings.ts';
import { bestPromotion, localMoment, type PromotionRule } from './promotions.ts';

export interface Who {
  actor: Actor & { kind: 'user'; userId: string };
  correlationId: string;
  ip?: string;
}

// ------------------------------------------------------------------ shared helpers

async function changed(
  tx: Tx,
  who: Who,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
  },
  event: { type: 'menu.changed' | 'availability.changed'; version?: number },
): Promise<void> {
  await writeAudit(tx, who, entry);
  await publish(tx, {
    type: event.type,
    entityType: entry.entityType,
    entityId: entry.entityId,
    ...(event.version !== undefined ? { version: event.version } : {}),
    topics: ['menu'],
  });
}

/** Maps constraint errors to messages people can act on; anything else is rethrown. */
function friendly(error: unknown, messages: Record<string, string> = {}): never {
  const e = error as { code?: string; constraint?: string };
  if (e.code === '23505') {
    throw new AppError(
      'VALIDATION_FAILED',
      messages[e.constraint ?? ''] ?? 'That name is already used here',
    );
  }
  if (e.code === '23503')
    throw new AppError('VALIDATION_FAILED', 'A referenced item does not exist');
  if (e.code === '23514')
    throw new AppError('VALIDATION_FAILED', 'The values break a rule of the menu');
  throw error;
}

/** Row at the expected version, locked; STALE_STATE when someone changed it first. */
async function lockVersioned<R extends pg.QueryResultRow>(
  tx: Tx,
  table: string,
  id: string,
  expectedVersion: number,
  what: string,
): Promise<R & { version: number }> {
  const { rows } = await tx.query<R & { version: number }>(
    `SELECT * FROM cl.${table} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', `${what} not found`);
  if (row.version !== expectedVersion) {
    throw new AppError(
      'STALE_STATE',
      `${what} was changed by someone else. Reload it and try again.`,
      {
        currentVersion: row.version,
      },
    );
  }
  return row;
}

function money2(value: string): string {
  return money.format(new Decimal(value));
}

// ------------------------------------------------------------------ categories

export interface CategoryInput {
  name: string;
  sort?: number | undefined;
}

export async function createCategory(
  pool: pg.Pool,
  who: Who,
  input: CategoryInput,
): Promise<{ id: string }> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO cl.menu_categories (name, sort) VALUES ($1, $2) RETURNING id::text',
      [input.name, input.sort ?? 0],
    );
    const id = rows[0]?.id ?? '';
    await changed(
      tx,
      who,
      { action: 'menu.category.create', entityType: 'menu_category', entityId: id, after: input },
      { type: 'menu.changed', version: 1 },
    );
    return { id };
  });
}

export async function updateCategory(
  pool: pg.Pool,
  who: Who,
  id: string,
  input: {
    expectedVersion: number;
    name?: string | undefined;
    sort?: number | undefined;
    isActive?: boolean | undefined;
  },
): Promise<{ id: string; version: number }> {
  return withTransaction(pool, async (tx) => {
    const before = await lockVersioned<{
      name: string;
      sort: number;
      is_active: boolean;
      archived_at: Date | null;
    }>(tx, 'menu_categories', id, input.expectedVersion, 'Category');
    if (before.archived_at) throw new AppError('VALIDATION_FAILED', 'This category is archived');
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE cl.menu_categories SET name = COALESCE($2, name), sort = COALESCE($3, sort),
              is_active = COALESCE($4, is_active)
        WHERE id = $1 RETURNING version`,
      [id, input.name ?? null, input.sort ?? null, input.isActive ?? null],
    );
    const version = rows[0]?.version ?? 0;
    await changed(
      tx,
      who,
      {
        action: 'menu.category.update',
        entityType: 'menu_category',
        entityId: id,
        before,
        after: input,
      },
      { type: 'menu.changed', version },
    );
    return { id, version };
  });
}

export async function archiveCategory(
  pool: pg.Pool,
  who: Who,
  id: string,
  expectedVersion: number,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await lockVersioned(tx, 'menu_categories', id, expectedVersion, 'Category');
    const { rows } = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM cl.menu_items WHERE category_id = $1 AND archived_at IS NULL',
      [id],
    );
    if ((rows[0]?.n ?? 0) > 0) {
      throw new AppError('VALIDATION_FAILED', 'Archive or move the items in this category first');
    }
    const { rows: updated } = await tx.query<{ version: number }>(
      'UPDATE cl.menu_categories SET archived_at = now(), is_active = false WHERE id = $1 RETURNING version',
      [id],
    );
    await changed(
      tx,
      who,
      { action: 'menu.category.archive', entityType: 'menu_category', entityId: id },
      { type: 'menu.changed', version: updated[0]?.version ?? 0 },
    );
  });
}

// ------------------------------------------------------------------ items and variants

export interface VariantInput {
  name: string;
  price: string;
  isDefault?: boolean | undefined;
  sort?: number | undefined;
}

export interface ItemInput {
  categoryId: string;
  name: string;
  description?: string | null | undefined;
  dietaryTags?: string[] | undefined;
  allowDineIn?: boolean | undefined;
  allowTakeaway?: boolean | undefined;
  allowDelivery?: boolean | undefined;
  sort?: number | undefined;
  modifierGroupIds?: string[] | undefined;
}

async function setItemModifierGroups(
  tx: Tx,
  itemId: string,
  groupIds: readonly string[],
): Promise<void> {
  await tx.query('DELETE FROM cl.menu_item_modifier_groups WHERE item_id = $1', [itemId]);
  for (const [sort, groupId] of groupIds.entries()) {
    await tx.query(
      'INSERT INTO cl.menu_item_modifier_groups (item_id, group_id, sort) VALUES ($1, $2, $3)',
      [itemId, groupId, sort],
    );
  }
}

async function insertVariant(
  tx: Tx,
  who: Who,
  itemId: string,
  v: VariantInput,
  isDefault: boolean,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.menu_variants (item_id, name, price, is_default, sort)
     VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
    [itemId, v.name, v.price, isDefault, v.sort ?? 0],
  );
  const id = rows[0]?.id ?? '';
  await tx.query(
    `INSERT INTO cl.menu_variant_price_history (variant_id, old_price, new_price, changed_by, reason)
     VALUES ($1, NULL, $2, $3, 'initial price')`,
    [id, v.price, who.actor.userId],
  );
  return id;
}

export async function createItem(
  pool: pg.Pool,
  who: Who,
  input: ItemInput & { variants: VariantInput[] },
): Promise<{ id: string; variantIds: string[] }> {
  if (input.variants.length === 0)
    throw new AppError('VALIDATION_FAILED', 'An item needs at least one size or variant');
  const defaults = input.variants.filter((v) => v.isDefault).length;
  if (defaults > 1) throw new AppError('VALIDATION_FAILED', 'Only one variant can be the default');
  try {
    return await withTransaction(pool, async (tx) => {
      const { rows: cat } = await tx.query(
        'SELECT 1 FROM cl.menu_categories WHERE id = $1 AND archived_at IS NULL',
        [input.categoryId],
      );
      if (cat.length === 0)
        throw new AppError('VALIDATION_FAILED', 'That category does not exist or is archived');
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cl.menu_items (category_id, name, description, dietary_tags, allow_dine_in,
                                    allow_takeaway, allow_delivery, sort)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`,
        [
          input.categoryId,
          input.name,
          input.description ?? null,
          input.dietaryTags ?? [],
          input.allowDineIn ?? true,
          input.allowTakeaway ?? true,
          input.allowDelivery ?? true,
          input.sort ?? 0,
        ],
      );
      const id = rows[0]?.id ?? '';
      const variantIds: string[] = [];
      for (const [i, v] of input.variants.entries()) {
        variantIds.push(
          await insertVariant(tx, who, id, v, defaults === 0 ? i === 0 : v.isDefault === true),
        );
      }
      await setItemModifierGroups(tx, id, input.modifierGroupIds ?? []);
      await changed(
        tx,
        who,
        { action: 'menu.item.create', entityType: 'menu_item', entityId: id, after: input },
        { type: 'menu.changed', version: 1 },
      );
      return { id, variantIds };
    });
  } catch (error) {
    friendly(error, {
      menu_variants_item_id_name_key: 'Two variants of one item cannot have the same name',
    });
  }
}

export async function updateItem(
  pool: pg.Pool,
  who: Who,
  id: string,
  input: { [K in keyof ItemInput]?: ItemInput[K] | undefined } & {
    expectedVersion: number;
    isActive?: boolean | undefined;
  },
): Promise<{ id: string; version: number }> {
  try {
    return await withTransaction(pool, async (tx) => {
      const before = await lockVersioned<{ archived_at: Date | null }>(
        tx,
        'menu_items',
        id,
        input.expectedVersion,
        'Item',
      );
      if (before.archived_at) throw new AppError('VALIDATION_FAILED', 'This item is archived');
      if (input.categoryId !== undefined) {
        const { rows: cat } = await tx.query(
          'SELECT 1 FROM cl.menu_categories WHERE id = $1 AND archived_at IS NULL',
          [input.categoryId],
        );
        if (cat.length === 0)
          throw new AppError('VALIDATION_FAILED', 'That category does not exist or is archived');
      }
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE cl.menu_items SET
            category_id    = COALESCE($2, category_id),
            name           = COALESCE($3, name),
            description    = CASE WHEN $4::boolean THEN $5 ELSE description END,
            dietary_tags   = COALESCE($6, dietary_tags),
            allow_dine_in  = COALESCE($7, allow_dine_in),
            allow_takeaway = COALESCE($8, allow_takeaway),
            allow_delivery = COALESCE($9, allow_delivery),
            sort           = COALESCE($10, sort),
            is_active      = COALESCE($11, is_active)
          WHERE id = $1 RETURNING version`,
        [
          id,
          input.categoryId ?? null,
          input.name ?? null,
          input.description !== undefined,
          input.description ?? null,
          input.dietaryTags ?? null,
          input.allowDineIn ?? null,
          input.allowTakeaway ?? null,
          input.allowDelivery ?? null,
          input.sort ?? null,
          input.isActive ?? null,
        ],
      );
      if (input.modifierGroupIds) await setItemModifierGroups(tx, id, input.modifierGroupIds);
      const version = rows[0]?.version ?? 0;
      await changed(
        tx,
        who,
        { action: 'menu.item.update', entityType: 'menu_item', entityId: id, before, after: input },
        { type: 'menu.changed', version },
      );
      return { id, version };
    });
  } catch (error) {
    friendly(error);
  }
}

export async function archiveItem(
  pool: pg.Pool,
  who: Who,
  id: string,
  expectedVersion: number,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await lockVersioned(tx, 'menu_items', id, expectedVersion, 'Item');
    const { rows } = await tx.query<{ version: number }>(
      'UPDATE cl.menu_items SET archived_at = now(), is_active = false WHERE id = $1 RETURNING version',
      [id],
    );
    await tx.query(
      'UPDATE cl.menu_variants SET archived_at = now(), is_active = false WHERE item_id = $1 AND archived_at IS NULL',
      [id],
    );
    await changed(
      tx,
      who,
      { action: 'menu.item.archive', entityType: 'menu_item', entityId: id },
      { type: 'menu.changed', version: rows[0]?.version ?? 0 },
    );
  });
}

export async function addVariant(
  pool: pg.Pool,
  who: Who,
  itemId: string,
  input: VariantInput,
): Promise<{ id: string }> {
  try {
    return await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ archived_at: Date | null }>(
        'SELECT archived_at FROM cl.menu_items WHERE id = $1 FOR UPDATE',
        [itemId],
      );
      if (!rows[0]) throw new AppError('NOT_FOUND', 'Item not found');
      if (rows[0].archived_at) throw new AppError('VALIDATION_FAILED', 'This item is archived');
      if (input.isDefault)
        await tx.query(
          'UPDATE cl.menu_variants SET is_default = false WHERE item_id = $1 AND is_default',
          [itemId],
        );
      const id = await insertVariant(tx, who, itemId, input, input.isDefault === true);
      await changed(
        tx,
        who,
        {
          action: 'menu.variant.create',
          entityType: 'menu_variant',
          entityId: id,
          after: { itemId, ...input },
        },
        { type: 'menu.changed', version: 1 },
      );
      return { id };
    });
  } catch (error) {
    friendly(error, {
      menu_variants_item_id_name_key: 'This item already has a variant with that name',
    });
  }
}

export async function updateVariant(
  pool: pg.Pool,
  who: Who,
  id: string,
  input: {
    expectedVersion: number;
    name?: string | undefined;
    sort?: number | undefined;
    isDefault?: boolean | undefined;
    isActive?: boolean | undefined;
  },
): Promise<{ id: string; version: number }> {
  try {
    return await withTransaction(pool, async (tx) => {
      const before = await lockVersioned<{
        item_id: string;
        archived_at: Date | null;
        is_default: boolean;
      }>(tx, 'menu_variants', id, input.expectedVersion, 'Variant');
      if (before.archived_at) throw new AppError('VALIDATION_FAILED', 'This variant is archived');
      if (input.isActive === false || input.isDefault === false) {
        await assertAnotherActiveVariant(
          tx,
          before.item_id,
          id,
          input.isDefault === false && input.isActive !== false,
        );
      }
      if (input.isDefault) {
        await tx.query(
          'UPDATE cl.menu_variants SET is_default = false WHERE item_id = $1 AND is_default AND id <> $2',
          [before.item_id, id],
        );
      }
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE cl.menu_variants SET name = COALESCE($2, name), sort = COALESCE($3, sort),
                is_default = COALESCE($4, is_default), is_active = COALESCE($5, is_active)
          WHERE id = $1 RETURNING version`,
        [
          id,
          input.name ?? null,
          input.sort ?? null,
          input.isDefault ?? null,
          input.isActive ?? null,
        ],
      );
      const version = rows[0]?.version ?? 0;
      await changed(
        tx,
        who,
        {
          action: 'menu.variant.update',
          entityType: 'menu_variant',
          entityId: id,
          before,
          after: input,
        },
        { type: 'menu.changed', version },
      );
      return { id, version };
    });
  } catch (error) {
    friendly(error, {
      menu_variants_item_id_name_key: 'This item already has a variant with that name',
    });
  }
}

async function assertAnotherActiveVariant(
  tx: Tx,
  itemId: string,
  exceptId: string,
  onlyDefaultChange: boolean,
): Promise<void> {
  if (onlyDefaultChange) return; // un-defaulting is fine; the item then has no default (first is used)
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cl.menu_variants
      WHERE item_id = $1 AND id <> $2 AND is_active AND archived_at IS NULL`,
    [itemId, exceptId],
  );
  if ((rows[0]?.n ?? 0) === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'An item needs at least one active variant. Archive the item instead.',
    );
  }
}

export async function archiveVariant(
  pool: pg.Pool,
  who: Who,
  id: string,
  expectedVersion: number,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const v = await lockVersioned<{ item_id: string }>(
      tx,
      'menu_variants',
      id,
      expectedVersion,
      'Variant',
    );
    await assertAnotherActiveVariant(tx, v.item_id, id, false);
    const { rows } = await tx.query<{ version: number }>(
      'UPDATE cl.menu_variants SET archived_at = now(), is_active = false, is_default = false WHERE id = $1 RETURNING version',
      [id],
    );
    await changed(
      tx,
      who,
      { action: 'menu.variant.archive', entityType: 'menu_variant', entityId: id },
      { type: 'menu.changed', version: rows[0]?.version ?? 0 },
    );
  });
}

/** Price changes are their own permission and always leave history (DATABASE.md §4). */
export async function changePrice(
  pool: pg.Pool,
  who: Who,
  id: string,
  input: { expectedVersion: number; price: string; reason: string },
): Promise<{ id: string; version: number; price: string }> {
  return withTransaction(pool, async (tx) => {
    const before = await lockVersioned<{ price: string; archived_at: Date | null }>(
      tx,
      'menu_variants',
      id,
      input.expectedVersion,
      'Variant',
    );
    if (before.archived_at) throw new AppError('VALIDATION_FAILED', 'This variant is archived');
    if (new Decimal(before.price).equals(new Decimal(input.price))) {
      throw new AppError('VALIDATION_FAILED', 'That is already the price');
    }
    const { rows } = await tx.query<{ version: number }>(
      'UPDATE cl.menu_variants SET price = $2 WHERE id = $1 RETURNING version',
      [id, input.price],
    );
    await tx.query(
      `INSERT INTO cl.menu_variant_price_history (variant_id, old_price, new_price, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, before.price, input.price, who.actor.userId, input.reason],
    );
    const version = rows[0]?.version ?? 0;
    await changed(
      tx,
      who,
      {
        action: 'menu.price.change',
        entityType: 'menu_variant',
        entityId: id,
        before: { price: money2(before.price) },
        after: { price: money2(input.price) },
        reason: input.reason,
      },
      { type: 'menu.changed', version },
    );
    return { id, version, price: money2(input.price) };
  });
}

export async function priceHistory(db: Queryable, variantId: string) {
  const { rows } = await db.query<{
    id: string;
    old_price: string | null;
    new_price: string;
    changed_by: string;
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT h.id::text, h.old_price::text, h.new_price::text, u.display_name AS changed_by, h.reason, h.created_at
       FROM cl.menu_variant_price_history h JOIN cl.users u ON u.id = h.changed_by
      WHERE h.variant_id = $1 ORDER BY h.created_at DESC, h.id DESC`,
    [variantId],
  );
  return rows.map((r) => ({
    id: r.id,
    oldPrice: r.old_price === null ? null : money2(r.old_price),
    newPrice: money2(r.new_price),
    changedBy: r.changed_by,
    reason: r.reason,
    at: r.created_at.toISOString(),
  }));
}

/** Manual "temporarily unavailable" (machine broken…); overrides stock availability. */
export async function setAvailability(
  pool: pg.Pool,
  who: Who,
  id: string,
  input: { available: boolean; reason?: string | undefined },
): Promise<{ id: string; available: boolean; version: number }> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ archived_at: Date | null; manual_unavailable: boolean }>(
      'SELECT archived_at, manual_unavailable FROM cl.menu_variants WHERE id = $1 FOR UPDATE',
      [id],
    );
    const v = rows[0];
    if (!v) throw new AppError('NOT_FOUND', 'Variant not found');
    if (v.archived_at) throw new AppError('VALIDATION_FAILED', 'This variant is archived');
    const { rows: updated } = await tx.query<{ version: number }>(
      input.available
        ? `UPDATE cl.menu_variants SET manual_unavailable = false, unavailable_note = NULL,
                  unavailable_by = NULL, unavailable_at = NULL WHERE id = $1 RETURNING version`
        : `UPDATE cl.menu_variants SET manual_unavailable = true, unavailable_note = $2,
                  unavailable_by = $3, unavailable_at = now() WHERE id = $1 RETURNING version`,
      input.available ? [id] : [id, input.reason ?? null, who.actor.userId],
    );
    const version = updated[0]?.version ?? 0;
    await changed(
      tx,
      who,
      {
        action: input.available ? 'menu.availability.on' : 'menu.availability.off',
        entityType: 'menu_variant',
        entityId: id,
        before: { available: !v.manual_unavailable },
        after: input,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      { type: 'availability.changed', version },
    );
    return { id, available: input.available, version };
  });
}

// ------------------------------------------------------------------ modifiers

export interface OptionInput {
  name: string;
  priceDelta?: string | undefined;
  sort?: number | undefined;
}

export async function createModifierGroup(
  pool: pg.Pool,
  who: Who,
  input: { name: string; minSelect: number; maxSelect: number; options: OptionInput[] },
): Promise<{ id: string; optionIds: string[] }> {
  if (input.minSelect > input.maxSelect)
    throw new AppError('VALIDATION_FAILED', 'Minimum choices cannot exceed the maximum');
  if (input.options.length < Math.max(1, input.minSelect)) {
    throw new AppError('VALIDATION_FAILED', 'Add at least as many choices as the minimum');
  }
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO cl.modifier_groups (name, min_select, max_select) VALUES ($1, $2, $3) RETURNING id::text',
      [input.name, input.minSelect, input.maxSelect],
    );
    const id = rows[0]?.id ?? '';
    const optionIds: string[] = [];
    for (const [i, o] of input.options.entries()) {
      const { rows: opt } = await tx.query<{ id: string }>(
        'INSERT INTO cl.modifier_options (group_id, name, price_delta, sort) VALUES ($1, $2, $3, $4) RETURNING id::text',
        [id, o.name, o.priceDelta ?? '0', o.sort ?? i],
      );
      optionIds.push(opt[0]?.id ?? '');
    }
    await changed(
      tx,
      who,
      {
        action: 'menu.modifier_group.create',
        entityType: 'modifier_group',
        entityId: id,
        after: input,
      },
      { type: 'menu.changed', version: 1 },
    );
    return { id, optionIds };
  });
}

export async function updateModifierGroup(
  pool: pg.Pool,
  who: Who,
  id: string,
  input: {
    expectedVersion: number;
    name?: string | undefined;
    minSelect?: number | undefined;
    maxSelect?: number | undefined;
    isActive?: boolean | undefined;
  },
): Promise<{ id: string; version: number }> {
  try {
    return await withTransaction(pool, async (tx) => {
      const before = await lockVersioned<{ min_select: number; max_select: number }>(
        tx,
        'modifier_groups',
        id,
        input.expectedVersion,
        'Modifier group',
      );
      const min = input.minSelect ?? before.min_select;
      const max = input.maxSelect ?? before.max_select;
      if (min > max)
        throw new AppError('VALIDATION_FAILED', 'Minimum choices cannot exceed the maximum');
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE cl.modifier_groups SET name = COALESCE($2, name), min_select = $3, max_select = $4,
                is_active = COALESCE($5, is_active) WHERE id = $1 RETURNING version`,
        [id, input.name ?? null, min, max, input.isActive ?? null],
      );
      const version = rows[0]?.version ?? 0;
      await changed(
        tx,
        who,
        {
          action: 'menu.modifier_group.update',
          entityType: 'modifier_group',
          entityId: id,
          before,
          after: input,
        },
        { type: 'menu.changed', version },
      );
      return { id, version };
    });
  } catch (error) {
    friendly(error);
  }
}

export async function addModifierOption(
  pool: pg.Pool,
  who: Who,
  groupId: string,
  input: OptionInput,
): Promise<{ id: string }> {
  try {
    return await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'INSERT INTO cl.modifier_options (group_id, name, price_delta, sort) VALUES ($1, $2, $3, $4) RETURNING id::text',
        [groupId, input.name, input.priceDelta ?? '0', input.sort ?? 0],
      );
      const id = rows[0]?.id ?? '';
      await changed(
        tx,
        who,
        {
          action: 'menu.modifier_option.create',
          entityType: 'modifier_option',
          entityId: id,
          after: { groupId, ...input },
        },
        { type: 'menu.changed', version: 1 },
      );
      return { id };
    });
  } catch (error) {
    friendly(error);
  }
}

export async function updateModifierOption(
  pool: pg.Pool,
  who: Who,
  id: string,
  input: {
    expectedVersion: number;
    name?: string | undefined;
    priceDelta?: string | undefined;
    sort?: number | undefined;
    isActive?: boolean | undefined;
  },
  canChangePrice: boolean,
): Promise<{ id: string; version: number }> {
  return withTransaction(pool, async (tx) => {
    const before = await lockVersioned<{ price_delta: string }>(
      tx,
      'modifier_options',
      id,
      input.expectedVersion,
      'Choice',
    );
    const priceChanged =
      input.priceDelta !== undefined &&
      !new Decimal(before.price_delta).equals(new Decimal(input.priceDelta));
    if (priceChanged && !canChangePrice)
      throw new AppError('FORBIDDEN', 'Changing a price needs the price-change permission');
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE cl.modifier_options SET name = COALESCE($2, name), price_delta = COALESCE($3, price_delta),
              sort = COALESCE($4, sort), is_active = COALESCE($5, is_active) WHERE id = $1 RETURNING version`,
      [
        id,
        input.name ?? null,
        input.priceDelta ?? null,
        input.sort ?? null,
        input.isActive ?? null,
      ],
    );
    const version = rows[0]?.version ?? 0;
    await changed(
      tx,
      who,
      {
        action: priceChanged ? 'menu.price.change' : 'menu.modifier_option.update',
        entityType: 'modifier_option',
        entityId: id,
        before,
        after: input,
      },
      { type: 'menu.changed', version },
    );
    return { id, version };
  });
}

// ------------------------------------------------------------------ promotions

export interface PromotionInput {
  name: string;
  kind: 'percent' | 'fixed';
  value: string;
  startsOn: string;
  endsOn?: string | null | undefined;
  daysOfWeek?: number[] | null | undefined;
  timeFrom?: string | null | undefined;
  timeTo?: string | null | undefined;
  itemIds?: string[] | undefined;
  categoryIds?: string[] | undefined;
}

async function setTargets(
  tx: Tx,
  promotionId: string,
  itemIds: readonly string[],
  categoryIds: readonly string[],
): Promise<void> {
  if (itemIds.length + categoryIds.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Choose at least one item or category for the promotion',
    );
  }
  await tx.query('DELETE FROM cl.promotion_targets WHERE promotion_id = $1', [promotionId]);
  for (const itemId of new Set(itemIds)) {
    await tx.query(
      'INSERT INTO cl.promotion_targets (promotion_id, menu_item_id) VALUES ($1, $2)',
      [promotionId, itemId],
    );
  }
  for (const categoryId of new Set(categoryIds)) {
    await tx.query('INSERT INTO cl.promotion_targets (promotion_id, category_id) VALUES ($1, $2)', [
      promotionId,
      categoryId,
    ]);
  }
}

export async function createPromotion(
  pool: pg.Pool,
  who: Who,
  input: PromotionInput,
): Promise<{ id: string }> {
  try {
    return await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cl.promotions (name, kind, value, starts_on, ends_on, days_of_week, time_from, time_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`,
        [
          input.name,
          input.kind,
          input.value,
          input.startsOn,
          input.endsOn ?? null,
          input.daysOfWeek ?? null,
          input.timeFrom ?? null,
          input.timeTo ?? null,
        ],
      );
      const id = rows[0]?.id ?? '';
      await setTargets(tx, id, input.itemIds ?? [], input.categoryIds ?? []);
      await changed(
        tx,
        who,
        { action: 'promotion.create', entityType: 'promotion', entityId: id, after: input },
        { type: 'menu.changed', version: 1 },
      );
      return { id };
    });
  } catch (error) {
    friendly(error);
  }
}

export async function updatePromotion(
  pool: pg.Pool,
  who: Who,
  id: string,
  input: { [K in keyof PromotionInput]?: PromotionInput[K] | undefined } & {
    expectedVersion: number;
    isActive?: boolean | undefined;
  },
): Promise<{ id: string; version: number }> {
  try {
    return await withTransaction(pool, async (tx) => {
      const before = await lockVersioned<Record<string, unknown>>(
        tx,
        'promotions',
        id,
        input.expectedVersion,
        'Promotion',
      );
      const has = (k: keyof PromotionInput) => input[k] !== undefined;
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE cl.promotions SET
            name = COALESCE($2, name), kind = COALESCE($3, kind), value = COALESCE($4, value),
            starts_on = COALESCE($5, starts_on),
            ends_on = CASE WHEN $6::boolean THEN $7::date ELSE ends_on END,
            days_of_week = CASE WHEN $8::boolean THEN $9::smallint[] ELSE days_of_week END,
            time_from = CASE WHEN $10::boolean THEN $11::time ELSE time_from END,
            time_to = CASE WHEN $10::boolean THEN $12::time ELSE time_to END,
            is_active = COALESCE($13, is_active)
          WHERE id = $1 RETURNING version`,
        [
          id,
          input.name ?? null,
          input.kind ?? null,
          input.value ?? null,
          input.startsOn ?? null,
          has('endsOn'),
          input.endsOn ?? null,
          has('daysOfWeek'),
          input.daysOfWeek ?? null,
          has('timeFrom') || has('timeTo'),
          input.timeFrom ?? null,
          input.timeTo ?? null,
          input.isActive ?? null,
        ],
      );
      if (input.itemIds !== undefined || input.categoryIds !== undefined) {
        const { rows: current } = await tx.query<{
          menu_item_id: string | null;
          category_id: string | null;
        }>(
          'SELECT menu_item_id::text, category_id::text FROM cl.promotion_targets WHERE promotion_id = $1',
          [id],
        );
        await setTargets(
          tx,
          id,
          input.itemIds ?? current.flatMap((t) => (t.menu_item_id ? [t.menu_item_id] : [])),
          input.categoryIds ?? current.flatMap((t) => (t.category_id ? [t.category_id] : [])),
        );
      }
      const version = rows[0]?.version ?? 0;
      await changed(
        tx,
        who,
        { action: 'promotion.update', entityType: 'promotion', entityId: id, before, after: input },
        { type: 'menu.changed', version },
      );
      return { id, version };
    });
  } catch (error) {
    friendly(error);
  }
}

export async function loadPromotionRules(
  db: Queryable,
  onlyActive = true,
): Promise<(PromotionRule & { name: string; version: number })[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    kind: 'percent' | 'fixed';
    value: string;
    starts_on: string;
    ends_on: string | null;
    days_of_week: number[] | null;
    time_from: string | null;
    time_to: string | null;
    is_active: boolean;
    version: number;
    item_ids: string[];
    category_ids: string[];
  }>(
    `SELECT p.id::text, p.name, p.kind, p.value::text, p.starts_on::text, p.ends_on::text, p.days_of_week,
            p.time_from::text, p.time_to::text, p.is_active, p.version,
            COALESCE(array_agg(t.menu_item_id::text) FILTER (WHERE t.menu_item_id IS NOT NULL), '{}') AS item_ids,
            COALESCE(array_agg(t.category_id::text) FILTER (WHERE t.category_id IS NOT NULL), '{}') AS category_ids
       FROM cl.promotions p LEFT JOIN cl.promotion_targets t ON t.promotion_id = p.id
      ${onlyActive ? 'WHERE p.is_active' : ''}
      GROUP BY p.id ORDER BY p.id`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    value: r.value,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    daysOfWeek: r.days_of_week,
    timeFrom: r.time_from,
    timeTo: r.time_to,
    isActive: r.is_active,
    version: r.version,
    itemIds: r.item_ids,
    categoryIds: r.category_ids,
  }));
}

// ------------------------------------------------------------------ reading the menu

export interface MenuOptions {
  /** true: the management view (inactive rows too, with versions); false: what can be ordered. */
  management: boolean;
  now: Date;
}

/** The menu tree. Availability is manual-only until the stock model arrives (step 3.2). */
export async function readMenu(db: pg.Pool, options: MenuOptions) {
  // A pool (not a transaction client): the reads below run in parallel.
  const live = !options.management;
  const [categories, items, variants, groups, opts, links, rules, timeZone] = await Promise.all([
    db.query<{ id: string; name: string; sort: number; is_active: boolean; version: number }>(
      `SELECT id::text, name, sort, is_active, version FROM cl.menu_categories
        WHERE archived_at IS NULL ${live ? 'AND is_active' : ''} ORDER BY sort, name, id`,
    ),
    db.query<{
      id: string;
      category_id: string;
      name: string;
      description: string | null;
      dietary_tags: string[];
      allow_dine_in: boolean;
      allow_takeaway: boolean;
      allow_delivery: boolean;
      sort: number;
      is_active: boolean;
      version: number;
    }>(
      `SELECT id::text, category_id::text, name, description, dietary_tags, allow_dine_in, allow_takeaway,
              allow_delivery, sort, is_active, version
         FROM cl.menu_items WHERE archived_at IS NULL ${live ? 'AND is_active' : ''} ORDER BY sort, name, id`,
    ),
    db.query<{
      id: string;
      item_id: string;
      name: string;
      price: string;
      is_default: boolean;
      sort: number;
      is_active: boolean;
      version: number;
      manual_unavailable: boolean;
      unavailable_note: string | null;
      stock_mode: string;
    }>(
      `SELECT id::text, item_id::text, name, price::text, is_default, sort, is_active, version,
              manual_unavailable, unavailable_note, stock_mode
         FROM cl.menu_variants WHERE archived_at IS NULL ${live ? 'AND is_active' : ''} ORDER BY sort, id`,
    ),
    db.query<{
      id: string;
      name: string;
      min_select: number;
      max_select: number;
      is_active: boolean;
      version: number;
    }>(
      `SELECT id::text, name, min_select, max_select, is_active, version FROM cl.modifier_groups
        ${live ? 'WHERE is_active' : ''} ORDER BY name, id`,
    ),
    db.query<{
      id: string;
      group_id: string;
      name: string;
      price_delta: string;
      sort: number;
      is_active: boolean;
      version: number;
    }>(
      `SELECT id::text, group_id::text, name, price_delta::text, sort, is_active, version
         FROM cl.modifier_options ${live ? 'WHERE is_active' : ''} ORDER BY sort, id`,
    ),
    db.query<{ item_id: string; group_id: string }>(
      'SELECT item_id::text, group_id::text FROM cl.menu_item_modifier_groups ORDER BY sort, group_id',
    ),
    loadPromotionRules(db),
    shopTimeZone(db),
  ]);
  const moment = localMoment(options.now, timeZone);

  const optionsByGroup = new Map<string, typeof opts.rows>();
  for (const o of opts.rows)
    optionsByGroup.set(o.group_id, [...(optionsByGroup.get(o.group_id) ?? []), o]);
  const groupById = new Map(groups.rows.map((g) => [g.id, g]));
  const groupsByItem = new Map<string, string[]>();
  for (const l of links.rows)
    groupsByItem.set(l.item_id, [...(groupsByItem.get(l.item_id) ?? []), l.group_id]);
  const variantsByItem = new Map<string, typeof variants.rows>();
  for (const v of variants.rows)
    variantsByItem.set(v.item_id, [...(variantsByItem.get(v.item_id) ?? []), v]);

  const itemView = (item: (typeof items.rows)[number]) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    imageUrl: null,
    dietaryTags: item.dietary_tags,
    allowDineIn: item.allow_dine_in,
    allowTakeaway: item.allow_takeaway,
    allowDelivery: item.allow_delivery,
    ...(options.management
      ? {
          sort: item.sort,
          isActive: item.is_active,
          version: item.version,
          categoryId: item.category_id,
        }
      : {}),
    variants: (variantsByItem.get(item.id) ?? []).map((v) => {
      const promo = bestPromotion(
        new Decimal(v.price),
        { itemId: item.id, categoryId: item.category_id },
        rules,
        moment,
      );
      return {
        id: v.id,
        name: v.name,
        price: money2(v.price),
        promotionPrice: promo ? money.format(promo.price) : null,
        promotionId: promo ? promo.promotionId : null,
        isDefault: v.is_default,
        available: !v.manual_unavailable,
        unavailableReason: v.manual_unavailable ? 'marked_unavailable' : null,
        unavailableNote: v.unavailable_note,
        ...(options.management
          ? { sort: v.sort, isActive: v.is_active, version: v.version, stockMode: v.stock_mode }
          : {}),
      };
    }),
    modifierGroups: (groupsByItem.get(item.id) ?? []).flatMap((groupId) => {
      const g = groupById.get(groupId);
      if (!g) return [];
      return [
        {
          id: g.id,
          name: g.name,
          minSelect: g.min_select,
          maxSelect: g.max_select,
          options: (optionsByGroup.get(g.id) ?? []).map((o) => ({
            id: o.id,
            name: o.name,
            priceDelta: money2(o.price_delta),
            available: true,
            ...(options.management
              ? { sort: o.sort, isActive: o.is_active, version: o.version }
              : {}),
          })),
        },
      ];
    }),
  });

  const itemsByCategory = new Map<string, ReturnType<typeof itemView>[]>();
  for (const item of items.rows) {
    const view = itemView(item);
    if (live && view.variants.length === 0) continue; // nothing to order
    itemsByCategory.set(item.category_id, [...(itemsByCategory.get(item.category_id) ?? []), view]);
  }
  return {
    categories: categories.rows.map((c) => ({
      id: c.id,
      name: c.name,
      ...(options.management ? { sort: c.sort, isActive: c.is_active, version: c.version } : {}),
      items: itemsByCategory.get(c.id) ?? [],
    })),
    ...(options.management
      ? {
          modifierGroups: groups.rows.map((g) => ({
            id: g.id,
            name: g.name,
            minSelect: g.min_select,
            maxSelect: g.max_select,
            isActive: g.is_active,
            version: g.version,
            options: (optionsByGroup.get(g.id) ?? []).map((o) => ({
              id: o.id,
              name: o.name,
              priceDelta: money2(o.price_delta),
              sort: o.sort,
              isActive: o.is_active,
              version: o.version,
            })),
          })),
        }
      : {}),
  };
}
