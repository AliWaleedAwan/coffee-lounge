/**
 * The asset register (DATABASE.md §10; D-31; Phase 5 step 5.4).
 *
 *  - Registered with a tag (typed, or the next `AST-NNNN`, P5-4); the history starts with
 *    `acquired`.
 *  - Every change is an event: a move, a new condition, a corrected value (with a reason),
 *    in use / in repair / retired, other details (before and after). The row is only the
 *    asset as it is now (AT-106, AT-23).
 *  - Maintenance is recorded, never edited, optionally pointing at the expense that paid
 *    for it (step 5.3).
 *  - Disposal is a status with how and why; the asset stays, and never changes again.
 *  - Edits name the version they saw, so two people cannot overwrite each other.
 */
import { money } from '@cl/shared';
import { z } from 'zod';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { readSetting, shopDateOf } from '../../platform/settings.ts';

export const CONDITIONS = ['new', 'good', 'fair', 'poor'] as const;
export const ACTIVE_STATUSES = ['in_use', 'in_repair', 'retired'] as const;
export const DISPOSALS = ['sold', 'broken', 'lost', 'scrapped', 'donated', 'returned'] as const;
type Condition = (typeof CONDITIONS)[number];
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export interface AssetFields {
  name: string;
  category: string;
  quantity: number;
  purchaseDate: string | null;
  purchasePrice: string | null;
  supplierId: string | null;
  location: string | null;
  condition: Condition | null;
  responsibleUserId: string | null;
  notes: string | null;
}

/** Every field may be left out (or sent as undefined by a parser). */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };

export type AssetInput = Loose<AssetFields> & {
  name: string;
  category: string;
  assetTag?: string | undefined;
};

export interface Asset extends AssetFields {
  id: string;
  assetTag: string;
  supplier: string | null;
  responsible: string | null;
  status: ActiveStatus | 'disposed';
  version: number;
  lastMaintenance: string | null;
  nextDue: string | null;
  createdAt: string;
}

/** Who acts and when: from a request, or from an import run. */
export interface By {
  who: AuditContext & { actor: { kind: 'user'; userId: string } };
  now: Date;
}

async function changed(tx: Tx, assetId: string): Promise<void> {
  await publish(tx, {
    type: 'asset.changed',
    entityType: 'asset',
    entityId: assetId,
    topics: ['assets'],
  });
}

async function event(
  tx: Tx,
  by: By,
  assetId: string,
  type: string,
  data: object,
  reason?: string | null,
): Promise<void> {
  await tx.query(
    'INSERT INTO cl.asset_events (asset_id, event_type, data, actor, reason) VALUES ($1, $2, $3, $4, $5)',
    [assetId, type, JSON.stringify(data), by.who.actor.userId, reason ?? null],
  );
}

// ---------------------------------------------------------------- reading

const SELECT_ASSET = `
  SELECT a.id::text, a.asset_tag AS "assetTag", a.name, a.category, a.quantity,
         a.purchase_date::text AS "purchaseDate", a.purchase_price::text AS "purchasePrice",
         a.supplier_id::text AS "supplierId", s.name AS supplier, a.location, a.condition,
         a.responsible_user_id::text AS "responsibleUserId", u.display_name AS responsible,
         a.status, a.notes, a.version, a.created_at AS "createdAt",
         (SELECT max(m.performed_on)::text FROM cl.asset_maintenance m WHERE m.asset_id = a.id) AS "lastMaintenance",
         (SELECT m.next_due::text FROM cl.asset_maintenance m WHERE m.asset_id = a.id
           ORDER BY m.performed_on DESC, m.id DESC LIMIT 1) AS "nextDue"
    FROM cl.assets a
    LEFT JOIN cl.suppliers s ON s.id = a.supplier_id
    LEFT JOIN cl.users u ON u.id = a.responsible_user_id`;

export async function listAssets(
  db: Queryable,
  filter: { q?: string | undefined; status?: string | undefined; category?: string | undefined },
): Promise<{ items: Asset[]; categories: string[]; locations: string[] }> {
  const q = filter.q?.trim() ?? '';
  const { rows } = await db.query<Asset>(
    `${SELECT_ASSET}
      WHERE ($1 = '' OR a.asset_tag ILIKE '%' || $1 || '%' OR a.name ILIKE '%' || $1 || '%'
             OR a.location ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR a.status = $2 OR ($2 = 'active' AND a.status <> 'disposed'))
        AND ($3::text IS NULL OR lower(a.category) = lower($3))
      ORDER BY a.status = 'disposed', lower(a.category), lower(a.name), a.id
      LIMIT 1000`,
    [q, filter.status ?? null, filter.category ?? null],
  );
  const { rows: names } = await db.query<{ kind: string; value: string }>(
    `SELECT DISTINCT 'category' AS kind, category AS value FROM cl.assets
     UNION SELECT DISTINCT 'location', location FROM cl.assets WHERE location IS NOT NULL
     ORDER BY 1, 2`,
  );
  // The owner's lists (step 5.6) first, then any other name already on an asset.
  const merge = (offered: string[], used: string[]) => [
    ...offered,
    ...used.filter((u) => !offered.some((o) => o.toLowerCase() === u.toLowerCase())),
  ];
  const list = z.array(z.string());
  return {
    items: rows,
    categories: merge(
      await readSetting(db, 'assets.categories', list),
      names.filter((n) => n.kind === 'category').map((n) => n.value),
    ),
    locations: merge(
      await readSetting(db, 'assets.locations', list),
      names.filter((n) => n.kind === 'location').map((n) => n.value),
    ),
  };
}

export async function readAsset(db: Queryable, id: string) {
  const { rows } = await db.query<Asset>(`${SELECT_ASSET} WHERE a.id = $1`, [id]);
  const asset = rows[0];
  if (!asset) throw new AppError('NOT_FOUND', 'Asset not found');
  const { rows: history } = await db.query<{
    id: string;
    type: string;
    data: Record<string, unknown>;
    reason: string | null;
    by: string;
    at: string;
  }>(
    `SELECT e.id::text, e.event_type AS type, e.data, e.reason, u.display_name AS by, e.created_at AS at
       FROM cl.asset_events e JOIN cl.users u ON u.id = e.actor
      WHERE e.asset_id = $1 ORDER BY e.id`,
    [id],
  );
  const { rows: maintenance } = await db.query<{
    id: string;
    performedOn: string;
    vendor: string | null;
    cost: string | null;
    description: string;
    nextDue: string | null;
    expenseId: string | null;
    expenseNo: string | null;
    by: string;
  }>(
    `SELECT m.id::text, m.performed_on::text AS "performedOn", m.vendor, m.cost::text, m.description,
            m.next_due::text AS "nextDue", m.expense_id::text AS "expenseId", x.expense_no AS "expenseNo",
            u.display_name AS by
       FROM cl.asset_maintenance m JOIN cl.users u ON u.id = m.created_by
       LEFT JOIN cl.expenses x ON x.id = m.expense_id
      WHERE m.asset_id = $1 ORDER BY m.performed_on DESC, m.id DESC`,
    [id],
  );
  return { asset, history, maintenance };
}

// ---------------------------------------------------------------- writing

async function checkRefs(tx: Tx, fields: Loose<AssetFields>, today: string): Promise<void> {
  if (fields.supplierId) {
    const { rows } = await tx.query('SELECT 1 FROM cl.suppliers WHERE id = $1 AND is_active', [
      fields.supplierId,
    ]);
    if (rows.length === 0) throw new AppError('VALIDATION_FAILED', 'Choose an active supplier');
  }
  if (fields.responsibleUserId) {
    const { rows } = await tx.query(`SELECT 1 FROM cl.users WHERE id = $1 AND status = 'active'`, [
      fields.responsibleUserId,
    ]);
    if (rows.length === 0) throw new AppError('VALIDATION_FAILED', 'Choose an active person');
  }
  if (fields.purchaseDate && fields.purchaseDate > today) {
    throw new AppError('VALIDATION_FAILED', 'The purchase date cannot be in the future');
  }
}

function tagTaken(error: unknown, tag: string): never {
  if ((error as { code?: string; constraint?: string }).code === '23505') {
    throw new AppError('VALIDATION_FAILED', `Tag ${tag} is already on another asset`);
  }
  throw error;
}

const clean = (v: string | null | undefined) =>
  v === undefined || v === null || v.trim() === '' ? null : v.trim();

export async function registerAsset(
  tx: Tx,
  by: By,
  input: AssetInput,
): Promise<{ id: string; assetTag: string }> {
  await checkRefs(tx, input, await shopDateOf(tx, by.now));
  let tag = clean(input.assetTag);
  if (tag === null) {
    // The next free AST-NNNN; a tag someone typed in that form is skipped.
    for (let i = 0; i < 100 && tag === null; i++) {
      const candidate = `AST-${(await tx.nextNumber('asset', 'all')).padStart(4, '0')}`;
      const { rows } = await tx.query(
        'SELECT 1 FROM cl.assets WHERE upper(asset_tag) = upper($1)',
        [candidate],
      );
      if (rows.length === 0) tag = candidate;
    }
    if (tag === null) throw new Error('no free AST tag found');
  }
  const fields: AssetFields = {
    name: input.name.trim(),
    category: input.category.trim(),
    quantity: input.quantity ?? 1,
    purchaseDate: input.purchaseDate ?? null,
    purchasePrice: input.purchasePrice ? money.format(money.parse(input.purchasePrice)) : null,
    supplierId: input.supplierId ?? null,
    location: clean(input.location),
    condition: input.condition ?? null,
    responsibleUserId: input.responsibleUserId ?? null,
    notes: clean(input.notes),
  };
  const { rows } = await tx
    .query<{ id: string }>(
      `INSERT INTO cl.assets (asset_tag, name, category, quantity, purchase_date, purchase_price, supplier_id,
         location, condition, responsible_user_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id::text`,
      [
        tag,
        fields.name,
        fields.category,
        fields.quantity,
        fields.purchaseDate,
        fields.purchasePrice,
        fields.supplierId,
        fields.location,
        fields.condition,
        fields.responsibleUserId,
        fields.notes,
        by.who.actor.userId,
      ],
    )
    .catch((error: unknown) => tagTaken(error, tag));
  const id = rows[0]?.id ?? '';
  await event(tx, by, id, 'acquired', { assetTag: tag, ...fields });
  await writeAudit(tx, by.who, {
    action: 'asset.register',
    entityType: 'asset',
    entityId: id,
    after: { assetTag: tag, ...fields },
  });
  await changed(tx, id);
  return { id, assetTag: tag };
}

interface AssetRow {
  asset_tag: string;
  name: string;
  category: string;
  quantity: number;
  purchase_date: string | null;
  purchase_price: string | null;
  supplier_id: string | null;
  location: string | null;
  condition: Condition | null;
  responsible_user_id: string | null;
  notes: string | null;
  status: string;
  version: number;
}

async function lockAsset(tx: Tx, id: string): Promise<AssetRow> {
  const { rows } = await tx.query<AssetRow>(
    `SELECT asset_tag, name, category, quantity, purchase_date::text, purchase_price::text, supplier_id::text,
            location, condition, responsible_user_id::text, notes, status, version
       FROM cl.assets WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'Asset not found');
  if (row.status === 'disposed')
    throw new AppError('STALE_STATE', `${row.asset_tag} is disposed and no longer changes`);
  return row;
}

export type AssetChanges = Loose<AssetFields> & {
  assetTag?: string | undefined;
  status?: ActiveStatus | undefined;
};

/**
 * Applies the differences as events: moved, condition_changed, value_corrected (needs a
 * reason), status_changed, details_changed. Nothing different, nothing recorded.
 */
export async function changeAsset(
  tx: Tx,
  by: By,
  id: string,
  changes: AssetChanges,
  options: { version?: number | undefined; reason?: string | undefined },
): Promise<{ id: string; version: number; events: string[] }> {
  const old = await lockAsset(tx, id);
  if (options.version !== undefined && options.version !== old.version) {
    throw new AppError('STALE_STATE', 'Someone changed this asset first: check it and try again', {
      version: old.version,
    });
  }
  await checkRefs(tx, changes, await shopDateOf(tx, by.now));
  const reason = options.reason?.trim() || null;
  const next = {
    asset_tag: changes.assetTag !== undefined ? changes.assetTag.trim() : old.asset_tag,
    name: changes.name !== undefined ? changes.name.trim() : old.name,
    category: changes.category !== undefined ? changes.category.trim() : old.category,
    quantity: changes.quantity ?? old.quantity,
    purchase_date: changes.purchaseDate !== undefined ? changes.purchaseDate : old.purchase_date,
    purchase_price:
      changes.purchasePrice !== undefined
        ? changes.purchasePrice === null
          ? null
          : money.format(money.parse(changes.purchasePrice))
        : old.purchase_price,
    supplier_id: changes.supplierId !== undefined ? changes.supplierId : old.supplier_id,
    location: changes.location !== undefined ? clean(changes.location) : old.location,
    condition: changes.condition !== undefined ? changes.condition : old.condition,
    responsible_user_id:
      changes.responsibleUserId !== undefined ? changes.responsibleUserId : old.responsible_user_id,
    notes: changes.notes !== undefined ? clean(changes.notes) : old.notes,
    status: changes.status ?? old.status,
  };
  const events: string[] = [];
  if (next.location !== old.location) {
    await event(tx, by, id, 'moved', { from: old.location, to: next.location }, reason);
    events.push('moved');
  }
  if (next.condition !== old.condition) {
    await event(
      tx,
      by,
      id,
      'condition_changed',
      { from: old.condition, to: next.condition },
      reason,
    );
    events.push('condition_changed');
  }
  if (next.purchase_price !== old.purchase_price) {
    if (!reason || reason.length < 3) {
      throw new AppError('VALIDATION_FAILED', 'Say why the value is corrected');
    }
    await event(
      tx,
      by,
      id,
      'value_corrected',
      { from: old.purchase_price, to: next.purchase_price },
      reason,
    );
    events.push('value_corrected');
  }
  if (next.status !== old.status) {
    await event(tx, by, id, 'status_changed', { from: old.status, to: next.status }, reason);
    events.push('status_changed');
  }
  const detailKeys = [
    'asset_tag',
    'name',
    'category',
    'quantity',
    'purchase_date',
    'supplier_id',
    'responsible_user_id',
    'notes',
  ] as const;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of detailKeys) {
    if (next[k] !== old[k]) {
      before[k] = old[k];
      after[k] = next[k];
    }
  }
  if (Object.keys(after).length > 0) {
    await event(tx, by, id, 'details_changed', { before, after }, reason);
    events.push('details_changed');
  }
  if (events.length === 0) return { id, version: old.version, events };
  const { rows } = await tx
    .query<{ version: number }>(
      `UPDATE cl.assets SET asset_tag = $2, name = $3, category = $4, quantity = $5, purchase_date = $6,
              purchase_price = $7, supplier_id = $8, location = $9, condition = $10, responsible_user_id = $11,
              notes = $12, status = $13, updated_at = now(), version = version + 1
        WHERE id = $1 RETURNING version`,
      [
        id,
        next.asset_tag,
        next.name,
        next.category,
        next.quantity,
        next.purchase_date,
        next.purchase_price,
        next.supplier_id,
        next.location,
        next.condition,
        next.responsible_user_id,
        next.notes,
        next.status,
      ],
    )
    .catch((error: unknown) => tagTaken(error, next.asset_tag));
  await writeAudit(tx, by.who, {
    action: 'asset.change',
    entityType: 'asset',
    entityId: id,
    ...(reason ? { reason } : {}),
    before: { ...old },
    after: { ...next },
  });
  await changed(tx, id);
  return { id, version: rows[0]?.version ?? old.version + 1, events };
}

export async function recordMaintenance(
  tx: Tx,
  by: By,
  id: string,
  input: {
    performedOn: string;
    vendor?: string | undefined;
    cost?: string | undefined;
    description: string;
    nextDue?: string | undefined;
    expenseNo?: string | undefined;
  },
): Promise<{ id: string }> {
  const asset = await lockAsset(tx, id);
  // The calendar date: a machine serviced at 01:00 was serviced that day, not the day before.
  const today = await shopDateOf(tx, by.now);
  if (input.performedOn > today)
    throw new AppError('VALIDATION_FAILED', 'Maintenance is recorded once it is done');
  if (input.nextDue && input.nextDue <= input.performedOn) {
    throw new AppError('VALIDATION_FAILED', 'The next service is after this one');
  }
  let expenseId: string | null = null;
  if (input.expenseNo?.trim()) {
    const { rows } = await tx.query<{ id: string; status: string; linked: boolean }>(
      `SELECT x.id::text, x.status, EXISTS (SELECT 1 FROM cl.asset_maintenance m WHERE m.expense_id = x.id) AS linked
         FROM cl.expenses x WHERE upper(x.expense_no) = upper($1)`,
      [input.expenseNo.trim()],
    );
    const expense = rows[0];
    if (!expense) throw new AppError('VALIDATION_FAILED', `No expense ${input.expenseNo.trim()}`);
    if (expense.status !== 'recorded')
      throw new AppError('VALIDATION_FAILED', `${input.expenseNo.trim()} is voided`);
    if (expense.linked) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${input.expenseNo.trim()} already pays for another maintenance`,
      );
    }
    expenseId = expense.id;
  }
  const cost = input.cost ? money.format(money.parse(input.cost)) : null;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.asset_maintenance (asset_id, performed_on, vendor, cost, description, next_due, expense_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text`,
    [
      id,
      input.performedOn,
      clean(input.vendor),
      cost,
      input.description.trim(),
      input.nextDue ?? null,
      expenseId,
      by.who.actor.userId,
    ],
  );
  const maintenanceId = rows[0]?.id ?? '';
  await event(tx, by, id, 'maintenance', {
    maintenanceId,
    performedOn: input.performedOn,
    description: input.description.trim(),
    vendor: clean(input.vendor),
    cost,
    nextDue: input.nextDue ?? null,
    expenseNo: expenseId ? input.expenseNo?.trim().toUpperCase() : null,
  });
  await tx.query('UPDATE cl.assets SET updated_at = now(), version = version + 1 WHERE id = $1', [
    id,
  ]);
  await writeAudit(tx, by.who, {
    action: 'asset.maintenance',
    entityType: 'asset',
    entityId: id,
    after: { assetTag: asset.asset_tag, maintenanceId, cost, expenseId },
  });
  await changed(tx, id);
  return { id: maintenanceId };
}

/** The end of an asset's life in the register: a status with how and why, never a delete. */
export async function disposeAsset(
  tx: Tx,
  by: By,
  id: string,
  input: { how: (typeof DISPOSALS)[number]; reason: string },
): Promise<{ id: string }> {
  const old = await lockAsset(tx, id);
  await event(tx, by, id, 'disposed', { how: input.how, from: old.status }, input.reason.trim());
  await tx.query(
    `UPDATE cl.assets SET status = 'disposed', updated_at = now(), version = version + 1 WHERE id = $1`,
    [id],
  );
  await writeAudit(tx, by.who, {
    action: 'asset.dispose',
    entityType: 'asset',
    entityId: id,
    reason: input.reason.trim(),
    before: { status: old.status },
    after: { status: 'disposed', how: input.how },
  });
  await changed(tx, id);
  return { id };
}
