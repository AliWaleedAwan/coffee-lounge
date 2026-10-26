/**
 * Inventory items as the clerk keeps them (RECIPE_INVENTORY.md §1–§3, §7): settings,
 * pack sizes and barcodes, and the scan lookup. Edits use optimistic versions
 * (`expectedVersion` → 409 STALE_STATE); nothing is deleted (D-31): items are archived,
 * packs and barcodes deactivated. Every change is audited and announced on the
 * `inventory` topic in the same transaction.
 */
import {
  Decimal,
  convertQty,
  qty,
  UNITS,
  UnitConversionError,
  type BaseUnit,
  type UnitCode,
} from '@cl/shared';
import type pg from 'pg';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { createInventoryItem, type InventoryItemInput } from './items.ts';

// ------------------------------------------------------------------ reading

export interface ItemSummary {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  baseUom: BaseUnit;
  trackLots: boolean;
  trackExpiry: boolean;
  lowThreshold: string | null;
  overstockThreshold: string | null;
  nearExpiryDays: number | null;
  stockControlActive: boolean;
  archived: boolean;
  version: number;
  onHand: string;
  reserved: string;
  packCount: number;
  barcodeCount: number;
}

export interface PackSize {
  id: string;
  name: string;
  qtyBase: string;
  isActive: boolean;
  version: number;
}

export interface Barcode {
  id: string;
  code: string;
  packSizeId: string | null;
  packName: string | null;
  version: number;
}

const SUMMARY = `
  SELECT i.id::text, i.sku, i.name, i.category, i.base_uom AS "baseUom",
         i.track_lots AS "trackLots", i.track_expiry AS "trackExpiry",
         i.low_threshold::text AS "lowThreshold", i.overstock_threshold::text AS "overstockThreshold",
         i.near_expiry_days AS "nearExpiryDays", i.stock_control_active AS "stockControlActive",
         i.archived_at IS NOT NULL AS archived, i.version,
         b.on_hand::text AS "onHand", b.reserved::text AS reserved,
         (SELECT count(*)::int FROM cl.item_pack_sizes p WHERE p.item_id = i.id AND p.is_active) AS "packCount",
         (SELECT count(*)::int FROM cl.barcodes c WHERE c.item_id = i.id AND c.is_active) AS "barcodeCount"
    FROM cl.inventory_items i
    JOIN cl.inventory_balances b ON b.item_id = i.id`;

/**
 * Items by name, SKU or exact barcode, active ones unless `includeArchived`. Also
 * returns the categories in use, for the filter.
 */
export async function listItems(
  db: pg.Pool,
  filter: { q?: string; category?: string; includeArchived?: boolean },
): Promise<{ items: ItemSummary[]; categories: string[] }> {
  const q = filter.q?.trim() ?? '';
  const { rows } = await db.query<ItemSummary>(
    `${SUMMARY}
     WHERE ($1 OR i.archived_at IS NULL)
       AND ($2::text IS NULL OR i.category = $2)
       AND ($3 = '' OR i.name ILIKE '%' || $3 || '%' OR i.sku ILIKE '%' || $3 || '%'
            OR EXISTS (SELECT 1 FROM cl.barcodes c WHERE c.item_id = i.id AND c.is_active AND c.code = $4))
     ORDER BY lower(i.name), i.id`,
    [filter.includeArchived ?? false, filter.category ?? null, escapeLike(q), q],
  );
  const categories = await db.query<{ category: string }>(
    `SELECT DISTINCT category FROM cl.inventory_items
      WHERE category IS NOT NULL AND archived_at IS NULL ORDER BY category`,
  );
  return { items: rows, categories: categories.rows.map((r) => r.category) };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function readItem(
  db: pg.Pool,
  id: string,
): Promise<ItemSummary & { packs: PackSize[]; barcodes: Barcode[] }> {
  const { rows } = await db.query<ItemSummary>(`${SUMMARY} WHERE i.id = $1`, [id]);
  const item = rows[0];
  if (!item) throw new AppError('NOT_FOUND', 'Item not found');
  const packs = await db.query<PackSize>(
    `SELECT id::text, name, qty_base::text AS "qtyBase", is_active AS "isActive", version
       FROM cl.item_pack_sizes WHERE item_id = $1 ORDER BY is_active DESC, qty_base, cl.item_pack_sizes.id`,
    [id],
  );
  const barcodes = await db.query<Barcode>(
    `SELECT c.id::text, c.code, c.pack_size_id::text AS "packSizeId", p.name AS "packName", c.version
       FROM cl.barcodes c LEFT JOIN cl.item_pack_sizes p ON p.id = c.pack_size_id
      WHERE c.item_id = $1 AND c.is_active ORDER BY c.code`,
    [id],
  );
  return { ...item, packs: packs.rows, barcodes: barcodes.rows };
}

export interface ScanMatch {
  itemId: string;
  sku: string;
  name: string;
  baseUom: BaseUnit;
  pack: { id: string; name: string; qtyBase: string } | null;
}

/** What a scanned code names (AT-14): the item and pack, or null for an unknown code. */
export async function lookupBarcode(
  db: pg.Pool | Tx,
  code: string,
): Promise<{ code: string; match: ScanMatch | null }> {
  const { rows } = await db.query<{
    itemId: string;
    sku: string;
    name: string;
    baseUom: BaseUnit;
    packId: string | null;
    packName: string | null;
    packQty: string | null;
  }>(
    `SELECT i.id::text AS "itemId", i.sku, i.name, i.base_uom AS "baseUom",
            p.id::text AS "packId", p.name AS "packName", p.qty_base::text AS "packQty"
       FROM cl.barcodes c
       JOIN cl.inventory_items i ON i.id = c.item_id
       LEFT JOIN cl.item_pack_sizes p ON p.id = c.pack_size_id
      WHERE c.code = $1 AND c.is_active`,
    [code],
  );
  const row = rows[0];
  if (!row) return { code, match: null };
  return {
    code,
    match: {
      itemId: row.itemId,
      sku: row.sku,
      name: row.name,
      baseUom: row.baseUom,
      pack:
        row.packId !== null && row.packName !== null && row.packQty !== null
          ? { id: row.packId, name: row.packName, qtyBase: row.packQty }
          : null,
    },
  };
}

// ------------------------------------------------------------------ shared helpers

async function changed(
  tx: Tx,
  who: AuditContext,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
  },
  itemId: string,
): Promise<void> {
  await writeAudit(tx, who, entry);
  await publish(tx, {
    type: 'inventory.changed',
    entityType: 'inventory_item',
    entityId: itemId,
    topics: ['inventory'],
  });
}

interface ItemRow {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  base_uom: BaseUnit;
  track_lots: boolean;
  track_expiry: boolean;
  low_threshold: string | null;
  overstock_threshold: string | null;
  near_expiry_days: number | null;
  archived_at: Date | null;
  version: number;
}

async function lockItem(tx: Tx, id: string, expectedVersion?: number): Promise<ItemRow> {
  const { rows } = await tx.query<ItemRow>(
    `SELECT id::text, sku, name, category, base_uom, track_lots, track_expiry,
            low_threshold::text, overstock_threshold::text, near_expiry_days, archived_at, version
       FROM cl.inventory_items WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'Item not found');
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw new AppError(
      'STALE_STATE',
      'This item was changed by someone else. Reload it and try again.',
      { currentVersion: row.version },
    );
  }
  if (row.archived_at) throw new AppError('VALIDATION_FAILED', `${row.name} is archived`);
  return row;
}

/** RECIPE_INVENTORY.md §3: expiry needs lots; overstock above low. */
function checkSettings(s: {
  trackLots: boolean;
  trackExpiry: boolean;
  lowThreshold: string | null;
  overstockThreshold: string | null;
}): void {
  if (s.trackExpiry && !s.trackLots) {
    throw new AppError('VALIDATION_FAILED', 'Expiry dates need lot tracking');
  }
  if (
    s.lowThreshold !== null &&
    s.overstockThreshold !== null &&
    new Decimal(s.overstockThreshold).lessThanOrEqualTo(s.lowThreshold)
  ) {
    throw new AppError('VALIDATION_FAILED', 'The overstock level must be above the low level');
  }
}

/** Maps the guards of migration 0017 and unique names to messages people can act on. */
function friendly(error: unknown, duplicate: string): never {
  const e = error as { code?: string; message?: string };
  if (e.code === '23505') throw new AppError('VALIDATION_FAILED', duplicate);
  if (e.code === '23514' && e.message && !e.message.includes('violates check constraint')) {
    throw new AppError('VALIDATION_FAILED', e.message);
  }
  throw error;
}

// ------------------------------------------------------------------ items

export async function createItem(
  pool: pg.Pool,
  who: AuditContext,
  input: InventoryItemInput,
): Promise<{ id: string }> {
  checkSettings({
    trackLots: input.trackLots ?? false,
    trackExpiry: input.trackExpiry ?? false,
    lowThreshold: input.lowThreshold ?? null,
    overstockThreshold: input.overstockThreshold ?? null,
  });
  return withTransaction(pool, async (tx) => {
    const created = await createInventoryItem(tx, who, input);
    await publish(tx, {
      type: 'inventory.changed',
      entityType: 'inventory_item',
      entityId: created.id,
      version: 1,
      topics: ['inventory'],
    });
    return created;
  });
}

export interface ItemUpdate {
  expectedVersion: number;
  name?: string | undefined;
  category?: string | null | undefined;
  baseUom?: BaseUnit | undefined;
  trackLots?: boolean | undefined;
  trackExpiry?: boolean | undefined;
  lowThreshold?: string | null | undefined;
  overstockThreshold?: string | null | undefined;
  nearExpiryDays?: number | null | undefined;
}

export async function updateItem(
  pool: pg.Pool,
  who: AuditContext,
  id: string,
  input: ItemUpdate,
): Promise<{ id: string; version: number }> {
  return withTransaction(pool, async (tx) => {
    const before = await lockItem(tx, id, input.expectedVersion);
    const next = {
      name: input.name ?? before.name,
      category: input.category === undefined ? before.category : input.category,
      baseUom: input.baseUom ?? before.base_uom,
      trackLots: input.trackLots ?? before.track_lots,
      trackExpiry: input.trackExpiry ?? before.track_expiry,
      lowThreshold: input.lowThreshold === undefined ? before.low_threshold : input.lowThreshold,
      overstockThreshold:
        input.overstockThreshold === undefined
          ? before.overstock_threshold
          : input.overstockThreshold,
      nearExpiryDays:
        input.nearExpiryDays === undefined ? before.near_expiry_days : input.nearExpiryDays,
    };
    checkSettings(next);
    try {
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE cl.inventory_items
            SET name = $2, category = $3, base_uom = $4, track_lots = $5, track_expiry = $6,
                low_threshold = $7, overstock_threshold = $8, near_expiry_days = $9
          WHERE id = $1 RETURNING version`,
        [
          id,
          next.name,
          next.category,
          next.baseUom,
          next.trackLots,
          next.trackExpiry,
          next.lowThreshold,
          next.overstockThreshold,
          next.nearExpiryDays,
        ],
      );
      const version = rows[0]?.version ?? 0;
      await changed(
        tx,
        who,
        {
          action: 'stock.item.update',
          entityType: 'inventory_item',
          entityId: id,
          before,
          after: input,
        },
        id,
      );
      return { id, version };
    } catch (error) {
      friendly(error, 'That name is already used');
    }
  });
}

/**
 * Archive (D-31): only with nothing on hand or reserved and no active recipe or modifier
 * rule using it (RECIPE_INVENTORY.md §2). Its barcodes are freed, its packs deactivated.
 */
export async function archiveItem(
  pool: pg.Pool,
  who: AuditContext,
  id: string,
  expectedVersion: number,
): Promise<{ id: string; version: number }> {
  return withTransaction(pool, async (tx) => {
    // Balance before item, as every stock posting locks them (postOpeningBalance).
    const [balance] = await tx.lock<{ on_hand: string; reserved: string }>('inventory_balances', [
      id,
    ]);
    const before = await lockItem(tx, id, expectedVersion);
    if (balance && (Number(balance.on_hand) > 0 || Number(balance.reserved) > 0)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${before.name} still has stock (${qtyText(balance.on_hand, before.base_uom)} on hand, ` +
          `${qtyText(balance.reserved, before.base_uom)} reserved). Waste, count or return it first.`,
      );
    }
    const users = await tx.query<{ what: string }>(
      `SELECT mi.name || ' (' || mv.name || ')' AS what
         FROM cl.recipe_components c
         JOIN cl.recipe_versions rv ON rv.id = c.recipe_version_id AND rv.status = 'active'
         JOIN cl.menu_variants mv ON mv.id = rv.variant_id
         JOIN cl.menu_items mi ON mi.id = mv.item_id
        WHERE c.inventory_item_id = $1
       UNION
       SELECT 'the choice ' || mo.name
         FROM cl.modifier_recipe_rules r
         JOIN cl.modifier_options mo ON mo.id = r.modifier_option_id
        WHERE r.retired_at IS NULL AND (r.inventory_item_id = $1 OR r.replacement_item_id = $1)
       ORDER BY 1`,
      [id],
    );
    if (users.rows.length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${before.name} is used by ${users.rows.map((r) => r.what).join(', ')}. Change those recipes first.`,
      );
    }
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE cl.inventory_items SET archived_at = now(), is_active = false
        WHERE id = $1 RETURNING version`,
      [id],
    );
    await tx.query('UPDATE cl.barcodes SET is_active = false WHERE item_id = $1 AND is_active', [
      id,
    ]);
    await tx.query(
      'UPDATE cl.item_pack_sizes SET is_active = false WHERE item_id = $1 AND is_active',
      [id],
    );
    await changed(
      tx,
      who,
      { action: 'stock.item.archive', entityType: 'inventory_item', entityId: id, before },
      id,
    );
    return { id, version: rows[0]?.version ?? 0 };
  });
}

function qtyText(value: string, uom: BaseUnit): string {
  return `${new Decimal(value).toString()} ${uom}`;
}

// ------------------------------------------------------------------ pack sizes

/**
 * A pack entered in any unit of the item's dimension ("1 l" for an item kept in ml) and
 * stored in the base unit (AT-31). Another dimension is refused (AT-32).
 */
export async function addPackSize(
  pool: pg.Pool,
  who: AuditContext,
  itemId: string,
  input: { name: string; qty: string; uom: UnitCode },
): Promise<{ id: string; qtyBase: string }> {
  return withTransaction(pool, async (tx) => {
    const item = await lockItem(tx, itemId);
    let qtyBase: Decimal;
    try {
      qtyBase = convertQty(new Decimal(input.qty), input.uom, item.base_uom);
    } catch (error) {
      if (error instanceof UnitConversionError) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${item.name} is kept in ${item.base_uom} (${UNITS[item.base_uom].dimension}); ` +
            `a pack in ${input.uom} (${UNITS[input.uom].dimension}) cannot be converted`,
        );
      }
      throw error;
    }
    if (qtyBase.lessThanOrEqualTo(0)) {
      throw new AppError('VALIDATION_FAILED', 'A pack must hold more than zero');
    }
    try {
      const { rows } = await tx.query<{ id: string; qty_base: string }>(
        `INSERT INTO cl.item_pack_sizes (item_id, name, qty_base) VALUES ($1, $2, $3)
         RETURNING id::text, qty_base::text`,
        [itemId, input.name, qty.format(qtyBase)],
      );
      const id = rows[0]?.id ?? '';
      const stored = rows[0]?.qty_base ?? '';
      await changed(
        tx,
        who,
        {
          action: 'stock.pack.create',
          entityType: 'item_pack_size',
          entityId: id,
          after: { ...input, itemId, qtyBase: stored },
        },
        itemId,
      );
      return { id, qtyBase: stored };
    } catch (error) {
      friendly(error, `${item.name} already has a pack called ${input.name}`);
    }
  });
}

/** Rename, deactivate or reactivate a pack; deactivating also frees its barcodes. */
export async function updatePackSize(
  pool: pg.Pool,
  who: AuditContext,
  packId: string,
  input: { expectedVersion: number; name?: string | undefined; isActive?: boolean | undefined },
): Promise<{ id: string; version: number }> {
  return withTransaction(pool, async (tx) => {
    const { rows: found } = await tx.query<{ item_id: string }>(
      'SELECT item_id::text FROM cl.item_pack_sizes WHERE id = $1',
      [packId],
    );
    const itemId = found[0]?.item_id;
    if (itemId === undefined) throw new AppError('NOT_FOUND', 'Pack size not found');
    const item = await lockItem(tx, itemId);
    const { rows } = await tx.query<{ name: string; is_active: boolean; version: number }>(
      'SELECT name, is_active, version FROM cl.item_pack_sizes WHERE id = $1 FOR UPDATE',
      [packId],
    );
    const before = rows[0];
    if (!before) throw new AppError('NOT_FOUND', 'Pack size not found');
    if (before.version !== input.expectedVersion) {
      throw new AppError(
        'STALE_STATE',
        'This pack was changed by someone else. Reload it and try again.',
        { currentVersion: before.version },
      );
    }
    try {
      const updated = await tx.query<{ version: number }>(
        `UPDATE cl.item_pack_sizes SET name = COALESCE($2, name), is_active = COALESCE($3, is_active)
          WHERE id = $1 RETURNING version`,
        [packId, input.name ?? null, input.isActive ?? null],
      );
      if (input.isActive === false) {
        await tx.query(
          'UPDATE cl.barcodes SET is_active = false WHERE pack_size_id = $1 AND is_active',
          [packId],
        );
      }
      await changed(
        tx,
        who,
        {
          action: 'stock.pack.update',
          entityType: 'item_pack_size',
          entityId: packId,
          before,
          after: input,
        },
        itemId,
      );
      return { id: packId, version: updated.rows[0]?.version ?? 0 };
    } catch (error) {
      friendly(
        error,
        `${item.name} already has an active pack called ${input.name ?? before.name}`,
      );
    }
  });
}

// ------------------------------------------------------------------ barcodes

/**
 * Links a code to an item and, usually, one of its packs. A code has one active owner:
 * a duplicate is refused naming that owner (AT-14), also when two people link it at once.
 */
export async function addBarcode(
  pool: pg.Pool,
  who: AuditContext,
  itemId: string,
  input: { code: string; packSizeId?: string | undefined },
): Promise<{ id: string }> {
  return withTransaction(pool, async (tx) => {
    const item = await lockItem(tx, itemId);
    if (input.packSizeId !== undefined) {
      const { rows } = await tx.query<{ is_active: boolean }>(
        'SELECT is_active FROM cl.item_pack_sizes WHERE id = $1 AND item_id = $2',
        [input.packSizeId, itemId],
      );
      if (!rows[0])
        throw new AppError('VALIDATION_FAILED', `That pack is not one of ${item.name}'s`);
      if (!rows[0].is_active)
        throw new AppError('VALIDATION_FAILED', 'That pack is no longer used');
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cl.barcodes (code, item_id, pack_size_id) VALUES ($1, $2, $3)
       ON CONFLICT (code) WHERE is_active DO NOTHING RETURNING id::text`,
      [input.code, itemId, input.packSizeId ?? null],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      const { match } = await lookupBarcode(tx, input.code);
      const owner = match
        ? `${match.name} (${match.sku})${match.pack ? `, ${match.pack.name}` : ''}`
        : 'another item';
      throw new AppError('BARCODE_IN_USE', `Barcode ${input.code} already belongs to ${owner}`, {
        owner,
      });
    }
    await changed(
      tx,
      who,
      {
        action: 'stock.barcode.create',
        entityType: 'barcode',
        entityId: id,
        after: { ...input, itemId },
      },
      itemId,
    );
    return { id };
  });
}

export async function deactivateBarcode(
  pool: pg.Pool,
  who: AuditContext,
  barcodeId: string,
  expectedVersion: number,
): Promise<{ id: string }> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{
      code: string;
      item_id: string;
      is_active: boolean;
      version: number;
    }>('SELECT code, item_id::text, is_active, version FROM cl.barcodes WHERE id = $1 FOR UPDATE', [
      barcodeId,
    ]);
    const before = rows[0];
    if (!before) throw new AppError('NOT_FOUND', 'Barcode not found');
    if (before.version !== expectedVersion || !before.is_active) {
      throw new AppError(
        'STALE_STATE',
        'This barcode was changed by someone else. Reload it and try again.',
        { currentVersion: before.version },
      );
    }
    await tx.query('UPDATE cl.barcodes SET is_active = false WHERE id = $1', [barcodeId]);
    await changed(
      tx,
      who,
      { action: 'stock.barcode.deactivate', entityType: 'barcode', entityId: barcodeId, before },
      before.item_id,
    );
    return { id: barcodeId };
  });
}
