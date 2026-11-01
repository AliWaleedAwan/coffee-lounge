/**
 * Loads the demo shop (docs/phase-8/DEMO.md): the owner's own item list as the real menu and
 * inventory, then made-up people, tables, suppliers, stock, 14 days of sales, expenses, assets
 * and deliveries, all through the real API so the ledger and reports add up. The person using
 * it can then switch roles with a click and, once, delete all of the made-up part.
 * Refuses a database with sales in it, or one that has had a demo already.
 *
 *   node --env-file=../../.env scripts/demo-shop.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Decimal } from '@cl/shared';
import { applyImport } from '../src/modules/imports/service.ts';
import { createRegistrationCode } from '../src/modules/identity/index.ts';
import { hashSecret } from '../src/modules/identity/secrets.ts';
import {
  activateRecipe,
  createInventoryItem,
  createRecipeDraft,
  postOpeningBalance,
  setStockMode,
} from '../src/modules/stock/index.ts';
import { buildApps } from '../src/platform/app.ts';
import { loadConfig } from '../src/platform/config.ts';
import { createPool } from '../src/platform/db/pool.ts';
import { withTransaction } from '../src/platform/db/tx.ts';
import { HealthMonitor } from '../src/platform/health.ts';
import { LiveHub } from '../src/platform/live-hub.ts';
import { Readiness, runStartupChecks } from '../src/platform/readiness.ts';
import { loadMigrations } from '../src/platform/db/migrate.ts';
import { businessDateOf } from '../src/platform/settings.ts';
import { registerStaffRoutes } from '../src/staff-routes.ts';
import { readSampleShop } from './sample-shop.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const config = loadConfig(process.env);
const admin = createPool({ connectionString: config.DATABASE_URL, max: 2 });
const pool = createPool({ connectionString: config.DATABASE_URL, max: 6, sessionRole: 'cl_app' });
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)] as T;
const between = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const problems: string[] = [];

// --over-test-sales: a development database with test bills, which the wipe would also delete.
const { rows: hadDemo } = await admin.query('SELECT 1 FROM cl.demo_state');
const { rows: sales } = await admin.query('SELECT 1 FROM cl.invoices LIMIT 1');
if (hadDemo.length > 0) throw new Error('This database has had a demo.');
if (sales.length > 0 && !process.argv.includes('--over-test-sales'))
  throw new Error('This database has sales. A demo is only for a shop that has not started.');
const { rows: owners } = await admin.query<{ id: string }>(
  `SELECT id::text FROM cl.users WHERE is_owner AND status = 'active' ORDER BY id LIMIT 1`,
);
const ownerId = owners[0]?.id;
if (!ownerId) throw new Error('Set up the owner first.');
const facts = { correlationId: randomUUID() };
const who = {
  actor: { kind: 'user' as const, userId: ownerId },
  correlationId: facts.correlationId,
};

// ------------------------------------------------------------------ the owner's real items
const { rows: hasMenu } = await admin.query('SELECT 1 FROM cl.menu_items LIMIT 1');
if (hasMenu.length === 0) {
  const csv = readFileSync(here('../../../docs/shop-data/04_menu_owner.csv'), 'utf8');
  await withTransaction(pool, (tx) => applyImport(tx, who, () => true, 'menu', csv, new Date()));
}
const ctx = { actorUserId: ownerId, businessDate: await businessDateOf(pool, new Date()) };
const tsv = readFileSync(here('../../../docs/shop-data/owner-items-2026-11-01.tsv'), 'utf8');
const goods = tsv
  .split('\n')
  .slice(1)
  .map((l) => l.split('\t'))
  .filter((c) => (c[2] ?? '').trim().length > 6 && (c[1] ?? '').trim() !== '');
const { rows: variants } = await pool.query<{ id: string; item: string; variant: string }>(
  `SELECT v.id::text, i.name AS item, v.name AS variant FROM cl.menu_variants v JOIN cl.menu_items i ON i.id = v.item_id`,
);
const used = new Set<string>();
for (const [i, c] of goods.entries()) {
  const name = (c[1] ?? '').replace(/\s+/g, ' ').trim();
  const code = (c[2] ?? '').trim();
  const price = Number(c[3] ?? 0);
  if (used.has(code)) continue;
  used.add(code);
  try {
    await withTransaction(pool, async (tx) => {
      const { id } = await createInventoryItem(tx, who, {
        sku: `GD-${String(i + 1).padStart(3, '0')}`,
        name,
        category: (c[5] ?? 'Packaged').trim(),
        baseUom: 'pcs',
        lowThreshold: '6',
        trackExpiry: true,
        trackLots: true,
      });
      await tx.query(
        `INSERT INTO cl.barcodes (item_id, code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, code],
      );
      await postOpeningBalance(tx, ctx, who, {
        itemId: id,
        qty: new Decimal(String(between(12, 60))),
        unitCost: new Decimal(String(Math.max(1, Math.round(price * 0.7)))),
      });
      const v = variants.find((x) => x.item.toLowerCase() === name.toLowerCase());
      if (v) {
        const draft = await createRecipeDraft(tx, {
          variantId: v.id,
          components: [{ itemId: id, qtyBase: '1', wasteFactor: '0' }],
        });
        await activateRecipe(tx, who, draft.id);
        await setStockMode(tx, who, v.id, 'recipe');
      }
    });
  } catch (e) {
    problems.push(`item ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const ingredients = new Map<string, string>();
await withTransaction(pool, async (tx) => {
  for (const i of readSampleShop().ingredients) {
    const { id } = await createInventoryItem(tx, who, {
      sku: i.sku,
      name: i.name,
      category: i.category,
      baseUom: i.uom,
      lowThreshold: i.low,
    });
    ingredients.set(i.sku, id);
    await postOpeningBalance(tx, ctx, who, {
      itemId: id,
      qty: new Decimal(i.opening),
      unitCost: new Decimal(i.unitCost),
    });
  }
});

// ------------------------------------------------------------------ made-up people
const secret = await hashSecret(`demo-${randomUUID()}`);
const people = [
  { username: 'demo_owner', name: 'Demo Owner', role: 'owner' },
  { username: 'demo_manager', name: 'Hamza', role: 'manager' },
  { username: 'demo_waiter', name: 'Bilal', role: 'waiter' },
  { username: 'demo_waiter2', name: 'Ayesha', role: 'waiter' },
  { username: 'demo_cashier', name: 'Usman', role: 'cashier' },
  { username: 'demo_clerk', name: 'Zainab', role: 'inventory_clerk' },
  { username: 'demo_kitchen', name: 'Imran', role: 'kitchen' },
];
const userIds: string[] = [];
for (const p of people) {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO cl.users (username, display_name, password_hash, pin_hash, must_change_password, is_owner)
     VALUES ($1, $2, $3, $3, false, $4) RETURNING id::text`,
    [p.username, p.name, secret, p.role === 'owner'],
  );
  const id = rows[0]?.id ?? '';
  userIds.push(id);
  await admin.query(
    'INSERT INTO cl.user_roles (user_id, role_id) SELECT $1, id FROM cl.roles WHERE key = $2',
    [id, p.role],
  );
}
await admin.query('INSERT INTO cl.demo_state (user_ids) VALUES ($1::bigint[])', [userIds]);

// ------------------------------------------------------------------ the API, in this process
let clock = new Date();
const readiness = new Readiness();
await runStartupChecks({
  db: pool,
  migrations: await loadMigrations(here('../migrations')),
  now: new Date(),
  clockToleranceMs: 120_000,
  readiness,
});
const health = new HealthMonitor({ db: pool, readiness, version: 'demo', internetTarget: null });
const apps = buildApps(
  { config: { LOG_LEVEL: 'silent' }, pool, readiness, health },
  {
    customer: async () => undefined,
    staff: (app) =>
      registerStaffRoutes(app, {
        pool,
        secureCookies: false,
        health,
        // Never started: nothing here listens to live updates.
        hub: new LiveHub({
          pool,
          connectListener: () => Promise.reject(new Error('not used')),
          pollMs: 60_000,
        }),
        now: () => clock,
        guestBaseUrl: 'http://127.0.0.1:8080',
        filesDir: process.env['FILES_DIR'] ?? here('../../../.local/files'),
        mail: { keyFile: here('../../../.local/mail.key') },
      }),
  },
);
await apps.staff.ready();
interface Reply {
  id: string;
  items: { id: string; tableCode: string; token: string }[];
  categories: { items: { allowDineIn?: boolean; variants: { id: string }[] }[] }[];
  rounds?: { lines?: { id: string; qty: number }[] }[];
  invoice: { id: string };
  lockVersion: number;
  total: string;
}
class Device {
  cookies = new Map<string, string>();
  async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
    const res = await apps.staff.inject({
      method,
      url: `/api/staff/v1${path}`,
      headers: {
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID(), 'x-cl-request': '1' }),
      },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    for (const c of res.cookies) this.cookies.set(c.name, c.value);
    if (res.statusCode >= 400)
      throw new Error(`${method} ${path}: ${String(res.statusCode)} ${res.body.slice(0, 200)}`);
    return (res.body ? JSON.parse(res.body) : {}) as Reply;
  }
}
async function deviceAs(username: string, kind: 'reception' | 'waiter'): Promise<Device> {
  const { code } = await createRegistrationCode(
    pool,
    { actor: { kind: 'system' }, userId: ownerId as string },
    { deviceName: `Demo ${username}`, kind, ownership: 'shop' },
    facts,
  );
  const d = new Device();
  await d.call('POST', '/devices/register', { code });
  await d.call('POST', '/demo/switch', { username });
  return d;
}
const boss = await deviceAs('demo_owner', 'reception');
const waiter = await deviceAs('demo_waiter', 'waiter');
const cashier = await deviceAs('demo_cashier', 'reception');
const clerk = await deviceAs('demo_clerk', 'reception');
const attempt = async (what: string, f: () => Promise<unknown>) => {
  try {
    return await f();
  } catch (e) {
    problems.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

// ------------------------------------------------------------------ tables and guest links
const tableIds: string[] = [];
for (let t = 1; t <= 12; t++) {
  const r = await boss.call('POST', '/tables', {
    code: `T${String(t)}`,
    name: `Table ${String(t)}`,
  });
  tableIds.push(r.id);
}
const qr = await boss.call('POST', '/qr-entry-points/generate', { tableIds, counter: false });
await admin.query('UPDATE cl.demo_state SET guest_links = $1::jsonb', [
  JSON.stringify(
    qr.items.map((i) => ({
      label: i.tableCode,
      token: i.token,
    })),
  ),
]);

// ------------------------------------------------------------------ suppliers, deliveries in
const suppliers: string[] = [];
for (const name of [
  'Metro Cash & Carry',
  'Al-Madina Meat',
  'Pepsi Distributor Lahore',
  'Green Valley Dairy',
]) {
  const r = await boss.call('POST', '/suppliers', {
    name,
    phone: `0300${String(between(1000000, 9999999))}`,
  });
  suppliers.push(r.id);
}
for (const code of [...ingredients.values()].slice(0, 6)) {
  await attempt('receipt', () =>
    clerk.call('POST', '/purchase-receipts', {
      supplierId: pick(suppliers),
      supplierInvoiceRef: `INV-${String(between(1000, 9999))}`,
      paidNow: true,
      paymentChannel: 'cash',
      lines: [{ itemId: code, qty: '500', lineCost: '750' }],
    }),
  );
}
for (const code of [...ingredients.values()].slice(0, 3)) {
  await attempt('waste', () =>
    clerk.call('POST', '/inventory/waste', { itemId: code, qty: '20', reasonCode: 'expired' }),
  );
}

// ------------------------------------------------------------------ 14 days of sales
const menu = await boss.call('GET', '/menu');
const sellable: string[] = [];
for (const cat of menu.categories)
  for (const item of cat.items)
    if (item.allowDineIn !== false) for (const v of item.variants) sellable.push(v.id);
await cashier.call('POST', '/cash-shifts', { openingFloat: '5000' });
let sold = 0;
for (let back = 13; back >= 0; back--) {
  const day = new Date(Date.now() - back * 86_400_000);
  for (let n = between(6, 14); n > 0; n--) {
    clock = new Date(day.getTime() - between(0, 6) * 3_600_000);
    await attempt('sale', async () => {
      const s = await waiter.call('POST', `/tables/${pick(tableIds)}/sessions`, {});
      const lines = Array.from({ length: between(1, 4) }, () => ({
        variantId: pick(sellable),
        qty: between(1, 3),
        modifierOptionIds: [],
      }));
      await waiter.call('POST', `/sessions/${s.id}/rounds`, { lines });
      const view = await waiter.call('GET', `/sessions/${s.id}`);
      for (const r of view.rounds ?? [])
        for (const l of r.lines ?? [])
          await waiter.call('POST', `/lines/${l.id}/pickup`, { qty: l.qty });
      const bill = await cashier.call('GET', `/sessions/${s.id}/bill`);
      const id = bill.invoice.id;
      const locked = await cashier.call('POST', `/invoices/${id}/lock`, {});
      await cashier.call('POST', `/invoices/${id}/payments`, {
        lockVersion: locked.lockVersion,
        amount: locked.total,
        ...(Math.random() < 0.6
          ? { method: 'cash', tendered: locked.total }
          : { method: 'card_manual' }),
      });
      sold += 1;
    });
  }
}
clock = new Date();

// ------------------------------------------------------------------ money out, things owned
const cats = await boss.call('GET', '/expense-categories');
const categoryIds = cats.items.map((c) => c.id);
for (const [payee, amount] of [
  ['LESCO electricity', '48500'],
  ['Shop rent', '120000'],
  ['Gas bill', '18200'],
  ['Cleaning supplies', '3400'],
] as const) {
  if (categoryIds.length)
    await attempt('expense', () =>
      boss.call('POST', '/expenses', {
        categoryId: pick(categoryIds),
        amount,
        payee,
        paidVia: 'cash',
      }),
    );
}
await attempt('ledger', () =>
  boss.call('POST', '/ledger/entries', {
    direction: 'in',
    amount: '25000',
    channel: 'cash',
    memo: 'Owner put cash in',
  }),
);
for (const [name, category, location, price, quantity] of [
  ['Espresso machine', 'Coffee equipment', 'Counter', '285000', 1],
  ['Coffee grinder', 'Coffee equipment', 'Counter', '62000', 2],
  ['Display fridge', 'Refrigeration', 'Hall', '145000', 1],
  ['Wooden table', 'Furniture', 'Hall', '18000', 12],
  ['Chair', 'Furniture', 'Hall', '6500', 48],
  ['Dinner plate set', 'Cutlery & crockery', 'Kitchen', '9500', 6],
  ['Pizza oven', 'Kitchen equipment', 'Kitchen', '320000', 1],
  ['Counter PC', 'Devices & electronics', 'Counter', '95000', 1],
  ['Receipt printer', 'POS hardware', 'Counter', '24000', 1],
  ['Wall art', 'Decoration', 'Hall', '12000', 4],
] as const) {
  await attempt('asset', () =>
    boss.call('POST', '/assets', {
      name,
      category,
      location,
      purchasePrice: price,
      quantity,
      condition: pick(['new', 'good', 'fair']),
      purchaseDate: '2026-03-15',
    }),
  );
}
const riderA = await attempt('rider', () =>
  boss.call('POST', '/riders', { name: 'Kamran', phone: '03001234567' }),
);
if (riderA)
  await attempt('delivery', () =>
    boss.call('POST', '/sessions/delivery', {
      channel: 'phone',
      paymentMode: 'cod_cash',
      customerName: 'Sana Tariq',
      customerPhone: '03211234567',
      address: 'House 12, Street 4, Model Town',
    }),
  );

console.log(
  `Demo loaded: ${String(variants.length)} menu sizes, ${String(used.size)} barcoded goods, ${String(people.length)} people, ${String(sold)} paid orders.`,
);
if (problems.length > 0) {
  const counted = new Map<string, number>();
  for (const p of problems.map((x) =>
    x
      .replace(/\d+/g, '#')
      .replace(/item [^:]*:/, 'item:')
      .replace(/"correlationId.*/, '')
      .replace(/.*"detail":/, ''),
  ))
    counted.set(p, (counted.get(p) ?? 0) + 1);
  console.log(`${String(problems.length)} steps failed:`);
  for (const [p, n] of [...counted].slice(0, 15)) console.log(`  ${String(n)}x ${p}`);
}
await apps.staff.close();
await pool.end();
await admin.end();
