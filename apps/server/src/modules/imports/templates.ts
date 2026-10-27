/**
 * The nine data-entry templates (docs/templates, README "How the import behaves"; AT-82).
 * Each runner first checks every row and collects every problem with its row number;
 * only when there is none does it apply the rows, inside the caller's transaction, so a
 * file is imported completely or not at all. Re-importing updates what exists (matched
 * by SKU, name or item and size) instead of adding it twice. Example SKUs (`EX-`) are
 * refused. Recipes always arrive as drafts. Each template needs the permission the same
 * change needs on screen.
 */
import {
  convertQty,
  Decimal,
  money,
  qty,
  unitCost,
  UNITS,
  UnitConversionError,
  type UnitCode,
} from '@cl/shared';
import type { AuditContext } from '../../platform/audit.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { changeAsset, registerAsset, type By } from '../assets/index.ts';
import {
  addRule,
  postOpeningBalance,
  reevaluateAlerts,
  retireRule,
  saveDraft,
  startDraft,
} from '../stock/index.ts';

export interface ImportError {
  row: number;
  column?: string;
  message: string;
}

export interface ImportChange {
  row: number;
  action: 'create' | 'update' | 'unchanged';
  what: string;
}

export interface Run {
  tx: Tx;
  who: AuditContext & { actor: { kind: 'user'; userId: string } };
  can: (permission: string) => boolean;
  rows: Row[];
  errors: ImportError[];
  changes: ImportChange[];
  businessDate: string;
}

/** One data row: its line in the file and its values by column. */
export interface Row {
  line: number;
  get: (column: string) => string;
}

export interface Template {
  key: string;
  file: string;
  title: string;
  columns: readonly string[];
  /** Needed to import this file at all. */
  permission: string;
  run: (r: Run) => Promise<void>;
}

// ------------------------------------------------------------------ cell checks

const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const QTY = /^\d{1,10}(\.\d{1,4})?$/;
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const RUPEES = /^\d{1,9}(\.00?)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function check(r: Run, row: Row) {
  const fail = (column: string, message: string) => {
    r.errors.push({ row: row.line, column, message });
    return null;
  };
  return {
    fail,
    text(column: string, max: number, required = true): string | null {
      const v = row.get(column);
      if (!v) return required ? fail(column, 'Required') : '';
      if (v.length > max) return fail(column, `At most ${String(max)} characters`);
      return v;
    },
    sku(column: string, required = true): string | null {
      const v = row.get(column);
      if (!v) return required ? fail(column, 'Required') : '';
      if (!SKU.test(v)) return fail(column, 'Letters, digits, dot, dash or underscore');
      if (/^EX-/i.test(v))
        return fail(column, 'EX- is an example SKU: replace the example rows with your own');
      return v.toUpperCase();
    },
    yesNo(column: string): boolean | null {
      const v = row.get(column).toLowerCase();
      if (v === 'yes') return true;
      if (v === 'no') return false;
      return fail(column, 'yes or no');
    },
    qty(column: string, required = true): string | null {
      const v = row.get(column);
      if (!v) return required ? fail(column, 'Required') : '';
      if (!QTY.test(v)) return fail(column, 'A quantity such as 500 or 2.5 (no commas)');
      return v;
    },
    money(column: string, pattern = MONEY): string | null {
      const v = row.get(column);
      if (!v) return fail(column, 'Required');
      if (!pattern.test(v)) {
        return fail(
          column,
          pattern === RUPEES
            ? 'Whole rupees, e.g. 650 or 650.00'
            : 'Rupees with up to 2 decimals, no commas',
        );
      }
      return v;
    },
    unit(column: string, required = true): UnitCode | '' | null {
      const v = row.get(column).toLowerCase();
      if (!v) return required ? fail(column, 'Required') : '';
      if (!Object.hasOwn(UNITS, v)) return fail(column, 'g, kg, ml, l or pcs');
      return v as UnitCode;
    },
    int(column: string, min: number, max: number, required = true): number | null {
      const v = row.get(column);
      if (!v) return required ? fail(column, 'Required') : null;
      if (!/^\d{1,4}$/.test(v) || Number(v) < min || Number(v) > max) {
        return fail(column, `A whole number from ${String(min)} to ${String(max)}`);
      }
      return Number(v);
    },
    date(column: string): string | null {
      const v = row.get(column);
      if (!v) return '';
      if (!DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))
        return fail(column, 'A date as YYYY-MM-DD');
      return v;
    },
  };
}

/** Quantity in the item's base unit, or an error on the row. */
function toBase(
  c: ReturnType<typeof check>,
  column: string,
  value: string,
  uom: UnitCode,
  base: 'g' | 'ml' | 'pcs',
): Decimal | null {
  try {
    const q = convertQty(new Decimal(value), uom, base);
    if (q.lessThanOrEqualTo(0)) return c.fail(column, 'More than zero');
    return q;
  } catch (error) {
    if (error instanceof UnitConversionError) {
      return c.fail(
        column,
        `The item is kept in ${base} (${UNITS[base].dimension}); ${uom} cannot be converted`,
      );
    }
    throw error;
  }
}

const key = (s: string) => s.trim().toLowerCase();

interface ItemRow {
  id: string;
  sku: string;
  name: string;
  base_uom: 'g' | 'ml' | 'pcs';
  track_lots: boolean;
  track_expiry: boolean;
  stock_control_active: boolean;
  archived: boolean;
}

async function itemsBySku(tx: Tx, skus: readonly string[]): Promise<Map<string, ItemRow>> {
  const { rows } = await tx.query<ItemRow>(
    `SELECT id::text, sku, name, base_uom, track_lots, track_expiry, stock_control_active,
            archived_at IS NOT NULL AS archived
       FROM cl.inventory_items WHERE sku = ANY($1::text[])`,
    [[...new Set(skus)]],
  );
  return new Map(rows.map((r) => [r.sku, r]));
}

function knownItem(
  c: ReturnType<typeof check>,
  items: Map<string, ItemRow>,
  column: string,
  sku: string | null,
) {
  if (!sku) return null;
  const item = items.get(sku);
  if (!item)
    return c.fail(column, `No inventory item ${sku}: import it in 01_inventory_items first`);
  if (item.archived) return c.fail(column, `${sku} is archived`);
  return item;
}

interface VariantRef {
  variantId: string;
  itemId: string;
  label: string;
}

/** Menu sizes by "item|variant" (names, any case), and items by name. */
async function menuIndex(tx: Tx) {
  const { rows } = await tx.query<{
    item_id: string;
    item: string;
    variant_id: string;
    variant: string;
  }>(
    `SELECT mi.id::text AS item_id, mi.name AS item, v.id::text AS variant_id, v.name AS variant
       FROM cl.menu_items mi JOIN cl.menu_variants v ON v.item_id = mi.id AND v.archived_at IS NULL
      WHERE mi.archived_at IS NULL ORDER BY mi.id, v.id`,
  );
  const variants = new Map<string, VariantRef>();
  const items = new Map<string, string[]>();
  for (const r of rows) {
    variants.set(`${key(r.item)}|${key(r.variant)}`, {
      variantId: r.variant_id,
      itemId: r.item_id,
      label: `${r.item} · ${r.variant}`,
    });
    items.set(key(r.item), [...new Set([...(items.get(key(r.item)) ?? []), r.item_id])]);
  }
  return { variants, items };
}

// ------------------------------------------------------------------ 01 inventory items

const items: Template = {
  key: 'items',
  file: '01_inventory_items.csv',
  title: 'Inventory items',
  columns: [
    'sku',
    'name',
    'category',
    'base_uom',
    'track_lots',
    'track_expiry',
    'low_threshold',
    'overstock_threshold',
    'near_expiry_days',
  ],
  permission: 'inventory.items_manage',
  async run(r) {
    const plan: {
      row: Row;
      sku: string;
      name: string;
      category: string | null;
      baseUom: 'g' | 'ml' | 'pcs';
      trackLots: boolean;
      trackExpiry: boolean;
      low: string | null;
      over: string | null;
      days: number | null;
    }[] = [];
    const seen = new Map<string, number>();
    for (const row of r.rows) {
      const c = check(r, row);
      const sku = c.sku('sku');
      const name = c.text('name', 80);
      const category = c.text('category', 40, false);
      const base = row.get('base_uom').toLowerCase();
      if (!['g', 'ml', 'pcs'].includes(base))
        c.fail('base_uom', 'g, ml or pcs (the unit stock is kept in)');
      const trackLots = c.yesNo('track_lots');
      const trackExpiry = c.yesNo('track_expiry');
      const low = c.qty('low_threshold', false);
      const over = c.qty('overstock_threshold', false);
      const days = c.int('near_expiry_days', 0, 365, false);
      if (trackExpiry && trackLots === false)
        c.fail('track_expiry', 'Expiry dates need track_lots yes');
      if (low && over && new Decimal(over).lessThanOrEqualTo(low))
        c.fail('overstock_threshold', 'Must be above low_threshold');
      if (sku) {
        const first = seen.get(sku);
        if (first !== undefined) c.fail('sku', `Also on row ${String(first)}`);
        seen.set(sku, row.line);
      }
      if (
        sku &&
        name !== null &&
        category !== null &&
        trackLots !== null &&
        trackExpiry !== null &&
        low !== null &&
        over !== null
      ) {
        plan.push({
          row,
          sku,
          name,
          category: category || null,
          baseUom: base as 'g' | 'ml' | 'pcs',
          trackLots,
          trackExpiry,
          low: low || null,
          over: over || null,
          days: trackExpiry ? days : null,
        });
      }
    }
    const existing = await itemsBySku(
      r.tx,
      plan.map((p) => p.sku),
    );
    const { rows: usage } = await r.tx.query<{ id: string; in_use: boolean; on_hand: string }>(
      `SELECT i.id::text, b.on_hand::text,
              (EXISTS (SELECT 1 FROM cl.item_pack_sizes WHERE item_id = i.id)
               OR EXISTS (SELECT 1 FROM cl.stock_movements WHERE item_id = i.id)
               OR EXISTS (SELECT 1 FROM cl.recipe_components WHERE inventory_item_id = i.id)
               OR EXISTS (SELECT 1 FROM cl.modifier_recipe_rules WHERE inventory_item_id = i.id OR replacement_item_id = i.id)) AS in_use
         FROM cl.inventory_items i JOIN cl.inventory_balances b ON b.item_id = i.id
        WHERE i.id = ANY($1::bigint[])`,
      [[...existing.values()].map((e) => e.id)],
    );
    const use = new Map(usage.map((u) => [u.id, u]));
    for (const p of plan) {
      const e = existing.get(p.sku);
      if (!e) continue;
      const c = check(r, p.row);
      if (e.archived) c.fail('sku', `${p.sku} is archived`);
      if (e.base_uom !== p.baseUom && use.get(e.id)?.in_use)
        c.fail('base_uom', `${p.sku} is in use: its base unit stays ${e.base_uom}`);
      if (e.track_lots !== p.trackLots && Number(use.get(e.id)?.on_hand ?? 0) > 0) {
        c.fail(
          'track_lots',
          `${p.sku} has stock: switch lots on or off on screen (it asks for the expiry of what is there)`,
        );
      }
    }
    if (r.errors.length > 0) return;
    const ids = plan.flatMap((p) => (existing.get(p.sku) ? [existing.get(p.sku)?.id ?? ''] : []));
    await r.tx.lock('inventory_balances', ids);
    for (const p of plan) {
      const e = existing.get(p.sku);
      const values = [
        p.name,
        p.category,
        p.baseUom,
        p.trackLots,
        p.trackExpiry,
        p.low,
        p.over,
        p.days,
      ];
      if (!e) {
        await r.tx.query(
          `INSERT INTO cl.inventory_items (name, category, base_uom, track_lots, track_expiry, low_threshold,
             overstock_threshold, near_expiry_days, sku)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [...values, p.sku],
        );
        r.changes.push({ row: p.row.line, action: 'create', what: `Item ${p.sku} ${p.name}` });
        continue;
      }
      const { rowCount } = await r.tx.query(
        `UPDATE cl.inventory_items
            SET name = $1, category = $2, base_uom = $3, track_lots = $4, track_expiry = $5, low_threshold = $6,
                overstock_threshold = $7, near_expiry_days = $8
          WHERE sku = $9 AND (name, COALESCE(category, ''), base_uom, track_lots, track_expiry,
                              COALESCE(low_threshold, -1), COALESCE(overstock_threshold, -1), COALESCE(near_expiry_days, -1))
                IS DISTINCT FROM ($1, COALESCE($2, ''), $3, $4, $5, COALESCE($6::numeric, -1),
                                  COALESCE($7::numeric, -1), COALESCE($8::int, -1))`,
        [...values, p.sku],
      );
      if (rowCount) await reevaluateAlerts(r.tx, e.id);
      r.changes.push({
        row: p.row.line,
        action: rowCount ? 'update' : 'unchanged',
        what: `Item ${p.sku} ${p.name}`,
      });
    }
  },
};

// ------------------------------------------------------------------ 02 pack sizes and barcodes

const packs: Template = {
  key: 'packs',
  file: '02_pack_sizes_barcodes.csv',
  title: 'Pack sizes and barcodes',
  columns: ['sku', 'pack_name', 'pack_qty', 'pack_uom', 'barcode'],
  permission: 'inventory.items_manage',
  async run(r) {
    const known = await itemsBySku(
      r.tx,
      r.rows.map((row) => row.get('sku').toUpperCase()),
    );
    const plan: { row: Row; item: ItemRow; name: string; qtyBase: Decimal; barcode: string }[] = [];
    const codes = new Map<string, number>();
    const names = new Map<string, number>();
    for (const row of r.rows) {
      const c = check(r, row);
      const item = knownItem(c, known, 'sku', c.sku('sku'));
      const name = c.text('pack_name', 60);
      const q = c.qty('pack_qty');
      const uom = c.unit('pack_uom');
      const barcode = row.get('barcode');
      if (barcode && !/^[!-~]{1,64}$/.test(barcode))
        c.fail('barcode', 'No spaces: the characters under the bars');
      if (barcode) {
        const first = codes.get(barcode);
        if (first !== undefined) c.fail('barcode', `Also on row ${String(first)}`);
        codes.set(barcode, row.line);
      }
      if (item && name) {
        const k = `${item.id}|${key(name)}`;
        const first = names.get(k);
        if (first !== undefined) c.fail('pack_name', `Also on row ${String(first)}`);
        names.set(k, row.line);
      }
      const qtyBase = item && q && uom ? toBase(c, 'pack_qty', q, uom, item.base_uom) : null;
      if (item && name && qtyBase) plan.push({ row, item, name, qtyBase, barcode });
    }
    const { rows: packRows } = await r.tx.query<{
      id: string;
      item_id: string;
      name: string;
      qty_base: string;
    }>(
      `SELECT id::text, item_id::text, name, qty_base::text FROM cl.item_pack_sizes
        WHERE is_active AND item_id = ANY($1::bigint[])`,
      [[...new Set(plan.map((p) => p.item.id))]],
    );
    const packOf = new Map(packRows.map((p) => [`${p.item_id}|${key(p.name)}`, p]));
    const { rows: owners } = await r.tx.query<{
      code: string;
      item_id: string;
      pack_size_id: string | null;
      owner: string;
    }>(
      `SELECT c.code, c.item_id::text, c.pack_size_id::text, i.name || ' (' || i.sku || ')' AS owner
         FROM cl.barcodes c JOIN cl.inventory_items i ON i.id = c.item_id
        WHERE c.is_active AND c.code = ANY($1::text[])`,
      [[...codes.keys()]],
    );
    const ownerOf = new Map(owners.map((o) => [o.code, o]));
    for (const p of plan) {
      const c = check(r, p.row);
      const pack = packOf.get(`${p.item.id}|${key(p.name)}`);
      if (pack && !new Decimal(pack.qty_base).equals(p.qtyBase)) {
        c.fail(
          'pack_qty',
          `${p.name} already holds ${new Decimal(pack.qty_base).toString()} ${p.item.base_uom}; a pack keeps its size: use another name`,
        );
      }
      const owner = p.barcode ? ownerOf.get(p.barcode) : undefined;
      if (owner && !(owner.item_id === p.item.id && pack && owner.pack_size_id === pack.id)) {
        c.fail('barcode', `Barcode ${p.barcode} already belongs to ${owner.owner}`);
      }
    }
    if (r.errors.length > 0) return;
    for (const p of plan) {
      let pack = packOf.get(`${p.item.id}|${key(p.name)}`);
      const what = `${p.item.sku} ${p.name}`;
      let created = false;
      if (!pack) {
        const { rows } = await r.tx.query<{ id: string }>(
          'INSERT INTO cl.item_pack_sizes (item_id, name, qty_base) VALUES ($1, $2, $3) RETURNING id::text',
          [p.item.id, p.name, qty.format(p.qtyBase)],
        );
        pack = {
          id: rows[0]?.id ?? '',
          item_id: p.item.id,
          name: p.name,
          qty_base: qty.format(p.qtyBase),
        };
        created = true;
      }
      let linked = false;
      if (p.barcode && !ownerOf.has(p.barcode)) {
        await r.tx.query(
          'INSERT INTO cl.barcodes (code, item_id, pack_size_id) VALUES ($1, $2, $3)',
          [p.barcode, p.item.id, pack.id],
        );
        linked = true;
      }
      r.changes.push({
        row: p.row.line,
        action: created ? 'create' : linked ? 'update' : 'unchanged',
        what: `Pack ${what}${p.barcode ? ` · barcode ${p.barcode}` : ''}`,
      });
    }
  },
};

// ------------------------------------------------------------------ 03 opening stock

const opening: Template = {
  key: 'opening',
  file: '03_opening_stock.csv',
  title: 'Opening stock',
  columns: ['sku', 'lot_code', 'expiry_date', 'quantity', 'uom', 'total_value'],
  permission: 'inventory.opening_balance',
  async run(r) {
    const known = await itemsBySku(
      r.tx,
      r.rows.map((row) => row.get('sku').toUpperCase()),
    );
    const plan: {
      row: Row;
      item: ItemRow;
      q: Decimal;
      value: Decimal;
      lot: string | null;
      expiry: string | null;
    }[] = [];
    const seen = new Map<string, number>();
    for (const row of r.rows) {
      const c = check(r, row);
      const item = knownItem(c, known, 'sku', c.sku('sku'));
      const q = c.qty('quantity');
      const uom = c.unit('uom');
      const value = c.money('total_value');
      const lot = row.get('lot_code');
      const expiry = c.date('expiry_date');
      if (!item) continue;
      const first = seen.get(item.id);
      if (first !== undefined)
        c.fail('sku', `Also on row ${String(first)}: one opening line per item`);
      seen.set(item.id, row.line);
      if (item.stock_control_active)
        c.fail('sku', `${item.sku} already has its opening stock; correct it with a stock count`);
      if ((lot || expiry) && !item.track_lots)
        c.fail(lot ? 'lot_code' : 'expiry_date', `${item.sku} does not track lots`);
      if (lot.length > 40) c.fail('lot_code', 'At most 40 characters');
      if (item.track_expiry && !expiry)
        c.fail('expiry_date', `Required: ${item.sku} tracks expiry dates`);
      if (expiry && expiry < r.businessDate)
        c.fail('expiry_date', 'Already expired: do not count it as stock');
      const base = q && uom ? toBase(c, 'quantity', q, uom, item.base_uom) : null;
      if (base && value !== null && expiry !== null) {
        plan.push({
          row,
          item,
          q: base,
          value: new Decimal(value),
          lot: lot || null,
          expiry: expiry || null,
        });
      }
    }
    if (r.errors.length > 0) return;
    // Balances are locked in ascending item id, as every posting does (DATABASE.md §14).
    for (const p of [...plan].sort((a, b) => Number(BigInt(a.item.id) - BigInt(b.item.id)))) {
      const cost = unitCost.round(p.value.dividedBy(p.q));
      await postOpeningBalance(
        r.tx,
        { actorUserId: r.who.actor.userId, businessDate: r.businessDate },
        r.who,
        { itemId: p.item.id, qty: p.q, unitCost: cost, lotCode: p.lot, expiryDate: p.expiry },
      );
      r.changes.push({
        row: p.row.line,
        action: 'create',
        what: `Opening ${p.item.sku}: ${p.q.toString()} ${p.item.base_uom} at Rs ${unitCost.format(cost)} each`,
      });
    }
  },
};

// ------------------------------------------------------------------ 04 menu

const menu: Template = {
  key: 'menu',
  file: '04_menu.csv',
  title: 'Menu items, sizes and prices',
  columns: [
    'category',
    'item',
    'description',
    'variant',
    'price',
    'is_default',
    'allow_dine_in',
    'allow_takeaway',
    'allow_delivery',
  ],
  permission: 'menu.manage',
  async run(r) {
    interface ItemPlan {
      row: Row;
      name: string;
      category: string;
      description: string | null;
      allow: [boolean, boolean, boolean];
      variants: { row: Row; name: string; price: string; isDefault: boolean }[];
    }
    const plans = new Map<string, ItemPlan>();
    for (const row of r.rows) {
      const c = check(r, row);
      const category = c.text('category', 80);
      const item = c.text('item', 80);
      const description = c.text('description', 500, false);
      const variant = c.text('variant', 80);
      const price = c.money('price', RUPEES);
      const isDefault = c.yesNo('is_default');
      const a = [c.yesNo('allow_dine_in'), c.yesNo('allow_takeaway'), c.yesNo('allow_delivery')];
      if (
        !category ||
        !item ||
        description === null ||
        !variant ||
        !price ||
        isDefault === null ||
        a.includes(null)
      )
        continue;
      const allow = a as [boolean, boolean, boolean];
      if (!allow.some(Boolean))
        c.fail('allow_dine_in', 'At least one of dine-in, takeaway or delivery');
      const plan = plans.get(key(item));
      if (!plan) {
        plans.set(key(item), {
          row,
          name: item,
          category,
          description: description || null,
          allow,
          variants: [{ row, name: variant, price: price.split('.')[0] ?? price, isDefault }],
        });
        continue;
      }
      if (key(plan.category) !== key(category))
        c.fail('category', `Row ${String(plan.row.line)} puts ${item} in ${plan.category}`);
      if ((plan.description ?? '') !== (description || ''))
        c.fail('description', `Differs from row ${String(plan.row.line)}`);
      if (plan.allow.some((x, i) => x !== allow[i]))
        c.fail('allow_dine_in', `Order types differ from row ${String(plan.row.line)}`);
      if (plan.variants.some((v) => key(v.name) === key(variant)))
        c.fail('variant', `${variant} is listed twice for ${item}`);
      plan.variants.push({ row, name: variant, price: price.split('.')[0] ?? price, isDefault });
    }
    for (const p of plans.values()) {
      if (p.variants.filter((v) => v.isDefault).length > 1) {
        check(r, p.row).fail('is_default', `Only one size of ${p.name} can be the default`);
      }
    }
    const { rows: existingItems } = await r.tx.query<{ id: string; name: string; n: number }>(
      `SELECT min(id)::text AS id, lower(name) AS name, count(*)::int AS n FROM cl.menu_items
        WHERE archived_at IS NULL AND lower(name) = ANY($1::text[]) GROUP BY lower(name)`,
      [[...plans.keys()]],
    );
    const itemId = new Map(existingItems.map((e) => [e.name, e]));
    const { rows: existingVariants } = await r.tx.query<{
      id: string;
      item_id: string;
      name: string;
      price: string;
    }>(
      `SELECT id::text, item_id::text, lower(name) AS name, price::text FROM cl.menu_variants
        WHERE archived_at IS NULL AND item_id = ANY($1::bigint[])`,
      [existingItems.map((e) => e.id)],
    );
    const variantOf = new Map(existingVariants.map((v) => [`${v.item_id}|${v.name}`, v]));
    for (const p of plans.values()) {
      const e = itemId.get(key(p.name));
      if (e && e.n > 1)
        check(r, p.row).fail(
          'item',
          `There are ${String(e.n)} menu items called ${p.name}: rename one on screen first`,
        );
      for (const v of p.variants) {
        const ev = e ? variantOf.get(`${e.id}|${key(v.name)}`) : undefined;
        if (ev && !new Decimal(ev.price).equals(v.price) && !r.can('menu.price_change')) {
          check(r, v.row).fail('price', 'Changing a price needs menu.price_change');
        }
      }
    }
    if (r.errors.length > 0) return;
    const { rows: cats } = await r.tx.query<{ id: string; name: string }>(
      'SELECT id::text, lower(name) AS name FROM cl.menu_categories WHERE archived_at IS NULL ORDER BY menu_categories.id',
    );
    const category = new Map(cats.map((c) => [c.name, c.id]));
    for (const p of plans.values()) {
      let catId = category.get(key(p.category));
      if (!catId) {
        const { rows } = await r.tx.query<{ id: string }>(
          `INSERT INTO cl.menu_categories (name, sort)
           SELECT $1, COALESCE(max(sort), 0) + 1 FROM cl.menu_categories RETURNING id::text`,
          [p.category],
        );
        catId = rows[0]?.id ?? '';
        category.set(key(p.category), catId);
        r.changes.push({ row: p.row.line, action: 'create', what: `Category ${p.category}` });
      }
      const e = itemId.get(key(p.name));
      let id = e?.id;
      if (!id) {
        const { rows } = await r.tx.query<{ id: string }>(
          `INSERT INTO cl.menu_items (category_id, name, description, allow_dine_in, allow_takeaway, allow_delivery)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
          [catId, p.name, p.description, ...p.allow],
        );
        id = rows[0]?.id ?? '';
        r.changes.push({ row: p.row.line, action: 'create', what: `Menu item ${p.name}` });
      } else {
        const { rowCount } = await r.tx.query(
          `UPDATE cl.menu_items SET category_id = $2, description = $3, allow_dine_in = $4, allow_takeaway = $5,
                  allow_delivery = $6
            WHERE id = $1 AND (category_id, COALESCE(description, ''), allow_dine_in, allow_takeaway, allow_delivery)
                  IS DISTINCT FROM ($2::bigint, COALESCE($3, ''), $4, $5, $6)`,
          [id, catId, p.description, ...p.allow],
        );
        r.changes.push({
          row: p.row.line,
          action: rowCount ? 'update' : 'unchanged',
          what: `Menu item ${p.name}`,
        });
      }
      const chosen = p.variants.find((v) => v.isDefault) ?? (e ? undefined : p.variants[0]);
      if (chosen)
        await r.tx.query(
          'UPDATE cl.menu_variants SET is_default = false WHERE item_id = $1 AND is_default',
          [id],
        );
      for (const v of p.variants) {
        const ev = variantOf.get(`${id}|${key(v.name)}`);
        const isDefault = v === chosen;
        if (!ev) {
          const { rows } = await r.tx.query<{ id: string }>(
            `INSERT INTO cl.menu_variants (item_id, name, price, is_default, sort)
             SELECT $1, $2, $3, $4, COALESCE(max(sort), 0) + 1 FROM cl.menu_variants WHERE item_id = $1 RETURNING id::text`,
            [id, v.name, v.price, isDefault],
          );
          await r.tx.query(
            `INSERT INTO cl.menu_variant_price_history (variant_id, old_price, new_price, changed_by, reason)
             VALUES ($1, NULL, $2, $3, 'initial price (import)')`,
            [rows[0]?.id, v.price, r.who.actor.userId],
          );
          r.changes.push({
            row: v.row.line,
            action: 'create',
            what: `${p.name} · ${v.name} at Rs ${v.price}`,
          });
          continue;
        }
        if (isDefault)
          await r.tx.query('UPDATE cl.menu_variants SET is_default = true WHERE id = $1', [ev.id]);
        if (!new Decimal(ev.price).equals(v.price)) {
          await r.tx.query('UPDATE cl.menu_variants SET price = $2 WHERE id = $1', [
            ev.id,
            v.price,
          ]);
          await r.tx.query(
            `INSERT INTO cl.menu_variant_price_history (variant_id, old_price, new_price, changed_by, reason)
             VALUES ($1, $2, $3, $4, 'Imported from 04_menu.csv')`,
            [ev.id, ev.price, v.price, r.who.actor.userId],
          );
          r.changes.push({
            row: v.row.line,
            action: 'update',
            what: `${p.name} · ${v.name}: Rs ${money.format(new Decimal(ev.price))} → Rs ${v.price}`,
          });
        } else {
          r.changes.push({ row: v.row.line, action: 'unchanged', what: `${p.name} · ${v.name}` });
        }
      }
    }
  },
};

// ------------------------------------------------------------------ 05 modifiers

const modifiers: Template = {
  key: 'modifiers',
  file: '05_modifiers.csv',
  title: 'Choices (modifiers)',
  columns: ['group', 'min_select', 'max_select', 'option', 'price_delta', 'applies_to_items'],
  permission: 'menu.manage',
  async run(r) {
    interface GroupPlan {
      row: Row;
      name: string;
      min: number;
      max: number;
      options: { row: Row; name: string; delta: string }[];
      items: Set<string>;
    }
    const { items: menuItems } = await menuIndex(r.tx);
    const groups = new Map<string, GroupPlan>();
    for (const row of r.rows) {
      const c = check(r, row);
      const group = c.text('group', 80);
      const min = c.int('min_select', 0, 20);
      const max = c.int('max_select', 1, 20);
      const option = c.text('option', 80);
      const delta = c.money('price_delta', RUPEES);
      const applies = row
        .get('applies_to_items')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      if (min !== null && max !== null && min > max)
        c.fail('min_select', 'Cannot be above max_select');
      const itemIds: string[] = [];
      for (const name of applies) {
        const ids = menuItems.get(key(name));
        if (!ids) c.fail('applies_to_items', `No menu item called ${name}: import 04_menu first`);
        else if (ids.length > 1)
          c.fail('applies_to_items', `Several menu items are called ${name}`);
        else itemIds.push(...ids);
      }
      if (!group || min === null || max === null || !option || !delta) continue;
      const plan = groups.get(key(group)) ?? {
        row,
        name: group,
        min,
        max,
        options: [],
        items: new Set<string>(),
      };
      if (plan.min !== min || plan.max !== max)
        c.fail('min_select', `Differs from row ${String(plan.row.line)} for ${group}`);
      if (plan.options.some((o) => key(o.name) === key(option)))
        c.fail('option', `${option} is listed twice in ${group}`);
      plan.options.push({ row, name: option, delta: delta.split('.')[0] ?? delta });
      for (const id of itemIds) plan.items.add(id);
      groups.set(key(group), plan);
    }
    const { rows: existingGroups } = await r.tx.query<{ id: string; name: string }>(
      `SELECT min(id)::text AS id, lower(name) AS name FROM cl.modifier_groups
        WHERE is_active AND lower(name) = ANY($1::text[]) GROUP BY lower(name)`,
      [[...groups.keys()]],
    );
    const groupId = new Map(existingGroups.map((g) => [g.name, g.id]));
    const { rows: existingOptions } = await r.tx.query<{
      id: string;
      group_id: string;
      name: string;
      delta: string;
    }>(
      `SELECT id::text, group_id::text, lower(name) AS name, price_delta::text AS delta FROM cl.modifier_options
        WHERE group_id = ANY($1::bigint[])`,
      [existingGroups.map((g) => g.id)],
    );
    const optionOf = new Map(existingOptions.map((o) => [`${o.group_id}|${o.name}`, o]));
    for (const g of groups.values()) {
      const gid = groupId.get(key(g.name));
      for (const o of g.options) {
        const eo = gid ? optionOf.get(`${gid}|${key(o.name)}`) : undefined;
        if (eo && !new Decimal(eo.delta).equals(o.delta) && !r.can('menu.price_change')) {
          check(r, o.row).fail('price_delta', 'Changing a price needs menu.price_change');
        }
      }
    }
    if (r.errors.length > 0) return;
    for (const g of groups.values()) {
      let gid = groupId.get(key(g.name));
      if (!gid) {
        const { rows } = await r.tx.query<{ id: string }>(
          'INSERT INTO cl.modifier_groups (name, min_select, max_select) VALUES ($1, $2, $3) RETURNING id::text',
          [g.name, g.min, g.max],
        );
        gid = rows[0]?.id ?? '';
        r.changes.push({ row: g.row.line, action: 'create', what: `Choice group ${g.name}` });
      } else {
        const { rowCount } = await r.tx.query(
          'UPDATE cl.modifier_groups SET min_select = $2, max_select = $3 WHERE id = $1 AND (min_select, max_select) <> ($2, $3)',
          [gid, g.min, g.max],
        );
        r.changes.push({
          row: g.row.line,
          action: rowCount ? 'update' : 'unchanged',
          what: `Choice group ${g.name}`,
        });
      }
      for (const [i, o] of g.options.entries()) {
        const eo = optionOf.get(`${gid}|${key(o.name)}`);
        if (!eo) {
          await r.tx.query(
            'INSERT INTO cl.modifier_options (group_id, name, price_delta, sort) VALUES ($1, $2, $3, $4)',
            [gid, o.name, o.delta, i],
          );
          r.changes.push({
            row: o.row.line,
            action: 'create',
            what: `${g.name}: ${o.name} +Rs ${o.delta}`,
          });
        } else if (!new Decimal(eo.delta).equals(o.delta)) {
          await r.tx.query('UPDATE cl.modifier_options SET price_delta = $2 WHERE id = $1', [
            eo.id,
            o.delta,
          ]);
          r.changes.push({
            row: o.row.line,
            action: 'update',
            what: `${g.name}: ${o.name} +Rs ${o.delta}`,
          });
        } else {
          r.changes.push({ row: o.row.line, action: 'unchanged', what: `${g.name}: ${o.name}` });
        }
      }
      for (const item of g.items) {
        await r.tx.query(
          `INSERT INTO cl.menu_item_modifier_groups (item_id, group_id, sort)
           SELECT $1, $2, COALESCE(max(sort), 0) + 1 FROM cl.menu_item_modifier_groups WHERE item_id = $1
           ON CONFLICT (item_id, group_id) DO NOTHING`,
          [item, gid],
        );
      }
    }
  },
};

// ------------------------------------------------------------------ 06 recipes

const recipes: Template = {
  key: 'recipes',
  file: '06_recipes.csv',
  title: 'Recipes (imported as drafts)',
  columns: [
    'item',
    'variant',
    'ingredient_sku',
    'quantity',
    'uom',
    'waste_factor_percent',
    'for_dine_in',
    'for_takeaway',
    'for_delivery',
    'prep_note',
  ],
  permission: 'recipes.manage',
  async run(r) {
    const { variants } = await menuIndex(r.tx);
    const known = await itemsBySku(
      r.tx,
      r.rows.map((row) => row.get('ingredient_sku').toUpperCase()),
    );
    interface Plan {
      row: Row;
      variant: VariantRef;
      components: {
        itemId: string;
        qty: string;
        uom: UnitCode;
        wastePercent: string;
        forDineIn: boolean;
        forTakeaway: boolean;
        forDelivery: boolean;
      }[];
      notes: string[];
    }
    const plans = new Map<string, Plan>();
    for (const row of r.rows) {
      const c = check(r, row);
      const itemName = c.text('item', 80);
      const variantName = c.text('variant', 80);
      const ingredient = knownItem(c, known, 'ingredient_sku', c.sku('ingredient_sku'));
      const q = c.qty('quantity');
      const uom = c.unit('uom');
      const waste = row.get('waste_factor_percent') || '0';
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(waste))
        c.fail('waste_factor_percent', 'A percentage from 0 to under 100, e.g. 5');
      const flags = [c.yesNo('for_dine_in'), c.yesNo('for_takeaway'), c.yesNo('for_delivery')];
      const note = row.get('prep_note');
      if (note.length > 300) c.fail('prep_note', 'At most 300 characters');
      if (flags.every((f) => f === false)) c.fail('for_dine_in', 'At least one kind of order');
      if (!itemName || !variantName) continue;
      const variant = variants.get(`${key(itemName)}|${key(variantName)}`);
      if (!variant) {
        c.fail(
          'variant',
          `No size ${variantName} of ${itemName} on the menu: import 04_menu first`,
        );
        continue;
      }
      if (ingredient && q && uom) toBase(c, 'quantity', q, uom, ingredient.base_uom);
      if (!ingredient || !q || !uom || flags.includes(null)) continue;
      const plan = plans.get(variant.variantId) ?? { row, variant, components: [], notes: [] };
      if (plan.components.some((x) => x.itemId === ingredient.id)) {
        c.fail(
          'ingredient_sku',
          `${ingredient.sku} is listed twice for ${variant.label}: add the quantities together`,
        );
      }
      plan.components.push({
        itemId: ingredient.id,
        qty: q,
        uom,
        wastePercent: waste,
        forDineIn: flags[0] ?? true,
        forTakeaway: flags[1] ?? true,
        forDelivery: flags[2] ?? true,
      });
      if (note) plan.notes.push(note);
      plans.set(variant.variantId, plan);
    }
    if (r.errors.length > 0) return;
    for (const p of plans.values()) {
      const draft = await startDraft(r.tx, r.who, p.variant.variantId);
      const { rows } = await r.tx.query<{ version: number }>(
        'SELECT version FROM cl.recipe_versions WHERE id = $1',
        [draft.id],
      );
      await saveDraft(r.tx, r.who, draft.id, {
        expectedVersion: rows[0]?.version ?? 1,
        components: p.components,
        prepInstructions: p.notes.length > 0 ? p.notes.join('; ') : null,
      });
      r.changes.push({
        row: p.row.line,
        action: 'create',
        what: `Draft v${String(draft.versionNo)} of ${p.variant.label} (${String(p.components.length)} ingredients): activate it on screen`,
      });
    }
  },
};

// ------------------------------------------------------------------ 07 modifier recipe rules

const rules: Template = {
  key: 'modifier-rules',
  file: '07_modifier_recipe_rules.csv',
  title: 'How choices change ingredients',
  columns: [
    'modifier_option',
    'item',
    'variant',
    'action',
    'ingredient_sku',
    'replacement_sku',
    'quantity',
    'uom',
    'scale_factor',
  ],
  permission: 'recipes.manage',
  async run(r) {
    const { variants, items: menuItems } = await menuIndex(r.tx);
    const skus = r.rows.flatMap((row) =>
      [row.get('ingredient_sku'), row.get('replacement_sku')]
        .filter(Boolean)
        .map((s) => s.toUpperCase()),
    );
    const known = await itemsBySku(r.tx, skus);
    const { rows: options } = await r.tx.query<{ id: string; item_id: string; name: string }>(
      `SELECT o.id::text, mg.item_id::text, lower(o.name) AS name
         FROM cl.menu_item_modifier_groups mg JOIN cl.modifier_options o ON o.group_id = mg.group_id AND o.is_active`,
    );
    const plan: {
      row: Row;
      optionId: string;
      variantId?: string;
      action: 'add' | 'remove' | 'replace' | 'scale';
      itemId: string;
      replacementItemId?: string;
      qty?: string;
      uom?: UnitCode;
      scaleFactor?: string;
      qtyBase?: string;
      label: string;
    }[] = [];
    for (const row of r.rows) {
      const c = check(r, row);
      const optionName = c.text('modifier_option', 80);
      const itemName = c.text('item', 80);
      const variantName = row.get('variant');
      const action = row.get('action').toLowerCase();
      if (!['add', 'remove', 'replace', 'scale'].includes(action))
        c.fail('action', 'add, remove, replace or scale');
      const ingredient = knownItem(c, known, 'ingredient_sku', c.sku('ingredient_sku'));
      const replacement =
        action === 'replace'
          ? knownItem(c, known, 'replacement_sku', c.sku('replacement_sku'))
          : null;
      const q = action === 'add' ? c.qty('quantity') : null;
      const uom = action === 'add' ? c.unit('uom') : null;
      const scale = row.get('scale_factor');
      if (action === 'scale' && !/^\d{1,4}(\.\d{1,4})?$/.test(scale))
        c.fail('scale_factor', 'A factor such as 1.5');
      if (!optionName || !itemName) continue;
      const itemIds = menuItems.get(key(itemName));
      if (!itemIds) {
        c.fail('item', `No menu item called ${itemName}`);
        continue;
      }
      const variant = variantName
        ? variants.get(`${key(itemName)}|${key(variantName)}`)
        : undefined;
      if (variantName && !variant) c.fail('variant', `No size ${variantName} of ${itemName}`);
      const matches = options.filter(
        (o) => itemIds.includes(o.item_id) && o.name === key(optionName),
      );
      if (matches.length === 0) {
        c.fail(
          'modifier_option',
          `${itemName} offers no choice called ${optionName}: import 05_modifiers first`,
        );
        continue;
      }
      if (new Set(matches.map((m) => m.id)).size > 1) {
        c.fail('modifier_option', `${itemName} offers more than one choice called ${optionName}`);
        continue;
      }
      if (action === 'add' && ingredient && !ingredient.stock_control_active) {
        c.fail(
          'ingredient_sku',
          `Count ${ingredient.sku} first (03_opening_stock): a choice can only add counted stock`,
        );
      }
      if (replacement && !replacement.stock_control_active) {
        c.fail('replacement_sku', `Count ${replacement.sku} first (03_opening_stock)`);
      }
      if (
        replacement &&
        ingredient &&
        UNITS[replacement.base_uom].dimension !== UNITS[ingredient.base_uom].dimension
      ) {
        c.fail(
          'replacement_sku',
          `${ingredient.sku} and ${replacement.sku} are not kept in the same kind of unit`,
        );
      }
      const qtyBase =
        q && uom && ingredient ? toBase(c, 'quantity', q, uom, ingredient.base_uom) : null;
      if (!ingredient || (action === 'replace' && !replacement)) continue;
      plan.push({
        row,
        optionId: matches[0]?.id ?? '',
        ...(variant ? { variantId: variant.variantId } : {}),
        action: action as 'add',
        itemId: ingredient.id,
        ...(replacement ? { replacementItemId: replacement.id } : {}),
        ...(q ? { qty: q } : {}),
        ...(uom ? { uom } : {}),
        ...(action === 'scale' ? { scaleFactor: scale } : {}),
        ...(qtyBase ? { qtyBase: qty.format(qtyBase) } : {}),
        label: `${optionName} on ${variant?.label ?? itemName}: ${action} ${ingredient.sku}${replacement ? ` → ${replacement.sku}` : ''}`,
      });
    }
    if (r.errors.length > 0) return;
    for (const p of plan) {
      // The same rule again changes nothing; a different one for the same choice, size,
      // action and ingredient replaces it from now on.
      const { rows: same } = await r.tx.query<{ id: string; same: boolean }>(
        `SELECT id::text,
            (replacement_item_id IS NOT DISTINCT FROM $5::bigint AND scale_factor IS NOT DISTINCT FROM $6::numeric
             AND qty_base IS NOT DISTINCT FROM $7::numeric) AS same
       FROM cl.modifier_recipe_rules
      WHERE retired_at IS NULL AND modifier_option_id = $1 AND variant_id IS NOT DISTINCT FROM $2::bigint
        AND action = $3 AND inventory_item_id = $4
      ORDER BY modifier_recipe_rules.id`,
        [
          p.optionId,
          p.variantId ?? null,
          p.action,
          p.itemId,
          p.replacementItemId ?? null,
          p.scaleFactor ?? null,
          p.qtyBase ?? null,
        ],
      );
      if (same.some((x) => x.same)) {
        r.changes.push({ row: p.row.line, action: 'unchanged', what: p.label });
        continue;
      }
      for (const old of same) await retireRule(r.tx, r.who, old.id);
      await addRule(r.tx, r.who, {
        optionId: p.optionId,
        ...(p.variantId ? { variantId: p.variantId } : {}),
        action: p.action,
        itemId: p.itemId,
        ...(p.replacementItemId ? { replacementItemId: p.replacementItemId } : {}),
        ...(p.qty ? { qty: p.qty } : {}),
        ...(p.uom ? { uom: p.uom } : {}),
        ...(p.scaleFactor ? { scaleFactor: p.scaleFactor } : {}),
      });
      r.changes.push({
        row: p.row.line,
        action: same.length > 0 ? 'update' : 'create',
        what: p.label,
      });
    }
  },
};

// ------------------------------------------------------------------ 08 suppliers

const suppliers: Template = {
  key: 'suppliers',
  file: '08_suppliers.csv',
  title: 'Suppliers',
  columns: ['name', 'phone', 'email', 'address', 'notes'],
  permission: 'suppliers.manage',
  async run(r) {
    const plan: {
      row: Row;
      name: string;
      phone: string | null;
      email: string | null;
      address: string | null;
      notes: string | null;
    }[] = [];
    const seen = new Map<string, number>();
    for (const row of r.rows) {
      const c = check(r, row);
      const name = c.text('name', 80);
      const phone = c.text('phone', 30, false);
      const email = c.text('email', 120, false);
      const address = c.text('address', 200, false);
      const notes = c.text('notes', 500, false);
      if (!name) continue;
      const first = seen.get(key(name));
      if (first !== undefined) c.fail('name', `Also on row ${String(first)}`);
      seen.set(key(name), row.line);
      if (phone !== null && email !== null && address !== null && notes !== null) {
        plan.push({
          row,
          name,
          phone: phone || null,
          email: email || null,
          address: address || null,
          notes: notes || null,
        });
      }
    }
    if (r.errors.length > 0) return;
    for (const p of plan) {
      const { rows } = await r.tx.query<{ id: string }>(
        `SELECT id::text FROM cl.suppliers WHERE is_active AND lower(btrim(name)) = $1 ORDER BY suppliers.id LIMIT 1`,
        [key(p.name)],
      );
      const id = rows[0]?.id;
      if (!id) {
        await r.tx.query(
          'INSERT INTO cl.suppliers (name, phone, email, address, notes) VALUES ($1, $2, $3, $4, $5)',
          [p.name, p.phone, p.email, p.address, p.notes],
        );
        r.changes.push({ row: p.row.line, action: 'create', what: `Supplier ${p.name}` });
        continue;
      }
      const { rowCount } = await r.tx.query(
        `UPDATE cl.suppliers SET phone = $2, email = $3, address = $4, notes = $5
          WHERE id = $1 AND (phone, email, address, notes) IS DISTINCT FROM ($2, $3, $4, $5)`,
        [id, p.phone, p.email, p.address, p.notes],
      );
      r.changes.push({
        row: p.row.line,
        action: rowCount ? 'update' : 'unchanged',
        what: `Supplier ${p.name}`,
      });
    }
  },
};

// ------------------------------------------------------------------ 09 assets (P5-7)

const CONDITION_VALUES = ['new', 'good', 'fair', 'poor'] as const;

const assets: Template = {
  key: 'assets',
  file: '09_assets.csv',
  title: 'Assets',
  columns: [
    'asset_tag',
    'name',
    'category',
    'quantity',
    'purchase_date',
    'purchase_price',
    'supplier',
    'location',
    'condition',
    'responsible',
    'notes',
  ],
  permission: 'assets.manage',
  async run(r) {
    const { rows: supplierRows } = await r.tx.query<{ id: string; name: string }>(
      'SELECT id::text, name FROM cl.suppliers WHERE is_active ORDER BY suppliers.id',
    );
    const supplierByName = new Map(supplierRows.map((x) => [key(x.name), x.id]));
    const { rows: people } = await r.tx.query<{ id: string; username: string }>(
      `SELECT id::text, username FROM cl.users WHERE status = 'active' ORDER BY users.id`,
    );
    const personByUsername = new Map(people.map((x) => [key(x.username), x.id]));
    const { rows: existing } = await r.tx.query<{
      id: string;
      tag: string;
      status: string;
      version: number;
    }>(
      'SELECT id::text, upper(asset_tag) AS tag, status, version FROM cl.assets ORDER BY assets.id',
    );
    const byTag = new Map(existing.map((x) => [x.tag, x]));
    const plan: {
      row: Row;
      tag: string;
      fields: {
        name: string;
        category: string;
        quantity: number;
        purchaseDate: string | null;
        purchasePrice: string | null;
        supplierId: string | null;
        location: string | null;
        condition: (typeof CONDITION_VALUES)[number] | null;
        responsibleUserId: string | null;
        notes: string | null;
      };
    }[] = [];
    const seen = new Map<string, number>();
    for (const row of r.rows) {
      const c = check(r, row);
      // The tag is how a re-import finds the asset again, so the file always names it.
      const tag = c.sku('asset_tag');
      const name = c.text('name', 80);
      const category = c.text('category', 40);
      const quantity = row.get('quantity') ? c.int('quantity', 1, 9999) : 1;
      const purchaseDate = c.date('purchase_date');
      const price = row.get('purchase_price') ? c.money('purchase_price') : '';
      const supplierName = c.text('supplier', 80, false);
      const location = c.text('location', 60, false);
      const conditionText = row.get('condition').toLowerCase();
      const responsible = c.text('responsible', 40, false);
      const notes = c.text('notes', 500, false);
      let condition: (typeof CONDITION_VALUES)[number] | null = null;
      if (conditionText) {
        const found = CONDITION_VALUES.find((x) => x === conditionText);
        if (found) condition = found;
        else c.fail('condition', 'new, good, fair or poor');
      }
      if (purchaseDate && purchaseDate > r.businessDate)
        c.fail('purchase_date', 'Not in the future');
      let supplierId: string | null = null;
      if (supplierName) {
        supplierId = supplierByName.get(key(supplierName)) ?? null;
        if (!supplierId)
          c.fail('supplier', `No supplier ${supplierName}: import it in 08_suppliers first`);
      }
      let responsibleUserId: string | null = null;
      if (responsible) {
        responsibleUserId = personByUsername.get(key(responsible)) ?? null;
        if (!responsibleUserId)
          c.fail('responsible', `No active user ${responsible} (use their username)`);
      }
      if (!tag) continue;
      const first = seen.get(tag);
      if (first !== undefined) c.fail('asset_tag', `Also on row ${String(first)}`);
      seen.set(tag, row.line);
      if (byTag.get(tag)?.status === 'disposed')
        c.fail('asset_tag', `${tag} is disposed and no longer changes`);
      if (
        name &&
        category &&
        quantity !== null &&
        purchaseDate !== null &&
        price !== null &&
        location !== null &&
        notes !== null
      ) {
        plan.push({
          row,
          tag,
          fields: {
            name,
            category,
            quantity,
            purchaseDate: purchaseDate || null,
            purchasePrice: price || null,
            supplierId,
            location: location || null,
            condition,
            responsibleUserId,
            notes: notes || null,
          },
        });
      }
    }
    if (r.errors.length > 0) return;
    const by: By = { who: r.who, now: new Date() };
    for (const p of plan) {
      const found = byTag.get(p.tag);
      if (!found) {
        await registerAsset(r.tx, by, { assetTag: p.tag, ...p.fields });
        r.changes.push({
          row: p.row.line,
          action: 'create',
          what: `Asset ${p.tag} ${p.fields.name}`,
        });
        continue;
      }
      const result = await changeAsset(r.tx, by, found.id, p.fields, {
        version: found.version,
        reason: 'Imported from 09_assets.csv',
      });
      r.changes.push({
        row: p.row.line,
        action: result.events.length > 0 ? 'update' : 'unchanged',
        what: `Asset ${p.tag} ${p.fields.name}`,
      });
    }
  },
};

/** In the weekly order of docs/templates/README.md. */
export const TEMPLATES: readonly Template[] = [
  items,
  packs,
  opening,
  suppliers,
  menu,
  modifiers,
  recipes,
  rules,
  assets,
];

export function templateOf(templateKey: string): Template {
  const t = TEMPLATES.find((x) => x.key === templateKey);
  if (!t) throw new AppError('NOT_FOUND', 'Unknown template');
  return t;
}
