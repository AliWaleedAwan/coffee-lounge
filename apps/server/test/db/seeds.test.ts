import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { readRbacCatalog, ROLE_KEYS, SCOPES } from '../support/rbac-doc.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

const docs = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../docs/${path}`, import.meta.url)), 'utf8');

describe('access seed matches docs/RBAC.md', () => {
  const catalog = readRbacCatalog();

  it('has the six roles', async () => {
    const { rows } = await db.client.query<{ key: string }>('SELECT key FROM cl.roles ORDER BY id');
    expect(rows.map((r) => r.key)).toEqual([...ROLE_KEYS]);
  });

  it('has exactly the permissions in RBAC.md, with module, scope kind and protection', async () => {
    const { rows } = await db.client.query<{
      key: string;
      module: string;
      scope_kind: string;
      is_protected: boolean;
    }>('SELECT key, module, scope_kind, is_protected FROM cl.permissions ORDER BY key');
    expect(rows).toEqual(
      catalog
        .map((p) => ({
          key: p.key,
          module: p.module,
          scope_kind: p.scopeKind,
          is_protected: p.isProtected,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
    expect(rows.filter((r) => r.is_protected).map((r) => r.key)).toEqual([
      'backup.restore',
      'roles.manage',
      'settings.financial',
      'settings.mailbox',
      'system.update',
    ]);
  });

  it('grants, scopes and policies match every role × permission cell', async () => {
    const grants = await db.client.query<{ role: string; perm: string; scope: unknown }>(
      `SELECT r.key AS role, rp.permission_key AS perm, rp.scope
         FROM cl.role_permissions rp JOIN cl.roles r ON r.id = rp.role_id`,
    );
    const policies = await db.client.query<{ role: string; perm: string; policy: string }>(
      `SELECT r.key AS role, p.permission_key AS perm, p.policy
         FROM cl.role_permission_policy p JOIN cl.roles r ON r.id = p.role_id`,
    );
    const grantMap = new Map(grants.rows.map((g) => [`${g.role}|${g.perm}`, g.scope]));
    const policyMap = new Map(policies.rows.map((p) => [`${p.role}|${p.perm}`, p.policy]));

    let cells = 0;
    for (const p of catalog) {
      for (const role of ROLE_KEYS) {
        const cell = p.roles[role];
        const id = `${role}|${p.key}`;
        cells += 1;
        if (cell.policy === 'granted') {
          expect(grantMap.has(id), `${id} should be granted`).toBe(true);
          expect(grantMap.get(id) ?? null, `${id} scope`).toEqual(SCOPES[p.key]?.[role] ?? null);
          expect(policyMap.has(id), `${id} should have no policy row`).toBe(false);
        } else {
          expect(grantMap.has(id), `${id} should not be granted`).toBe(false);
          expect(policyMap.get(id), `${id} policy`).toBe(cell.policy);
        }
      }
    }
    expect(cells).toBe(grants.rows.length + policies.rows.length);
  });

  it('sets discount limits: cashier 10 %, manager 20 % (D-14)', async () => {
    const { rows } = await db.client.query<{ key: string; max_percent: string }>(
      `SELECT r.key, l.max_percent::text FROM cl.role_discount_limits l
         JOIN cl.roles r ON r.id = l.role_id ORDER BY r.key`,
    );
    expect(rows).toEqual([
      { key: 'cashier', max_percent: '10.00' },
      { key: 'manager', max_percent: '20.00' },
    ]);
  });

  it('every permission named in the API contract exists', async () => {
    const yaml = docs('openapi/phase3.yaml');
    const named = new Set<string>();
    for (const m of yaml.matchAll(/x-permission:\s*(\[[^\]]*\]|\S+)/g)) {
      for (const key of (m[1] ?? '').replace(/[[\]]/g, '').split(',')) named.add(key.trim());
    }
    const { rows } = await db.client.query<{ key: string }>('SELECT key FROM cl.permissions');
    const known = new Set(rows.map((r) => r.key));
    expect([...named].filter((k) => !known.has(k))).toEqual([]);
    expect(named.size).toBeGreaterThan(30);
  });
});

describe('settings seed matches docs/DECISIONS.md §4', () => {
  it('has every documented setting with its initial value', async () => {
    const section = docs('DECISIONS.md').split('## 4. Operational parameters')[1] ?? '';
    const documented = new Set<string>();
    for (const m of section.matchAll(/^\| `([a-z_.]+)`(?: \/ `(_[a-z_]+)`)? \|/gm)) {
      const key = m[1] ?? '';
      documented.add(key);
      if (m[2]) documented.add(key.replace(/_[a-z]+$/, '') + m[2]);
    }

    const { rows } = await db.client.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM cl.system_settings ORDER BY key',
    );
    expect(new Set(rows.map((r) => r.key))).toEqual(documented);
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({
      'assets.categories': [
        'Furniture',
        'Cutlery & crockery',
        'Kitchen equipment',
        'Coffee equipment',
        'Refrigeration',
        'Devices & electronics',
        'POS hardware',
        'Decoration',
        'Cleaning',
        'Other',
      ],
      'assets.locations': ['Bar', 'Kitchen', 'Dining area', 'Store room', 'Office'],
      'billing.cash_rounding_unit': '1.00',
      'brand.primary': '#6B4435',
      'inventory.count_variance_amount': '1000.00',
      'inventory.count_variance_pct': 2,
      'orders.escalation_minutes': 3,
      'orders.pickup_marks_served_dine_in': true,
      'orders.price_lock_minutes': 30,
      'orders.takeaway_unpaid_expiry_minutes': 30,
      'orders.uncollected_alert_minutes': 30,
      'privacy.delivery_pii_retention_months': 12,
      'security.logout_counter_minutes': 10,
      'security.logout_manager_minutes': 5,
      'security.logout_waiter_minutes': 5,
      'refunds.reasons': [
        'Wrong order',
        'Quality',
        'Cold or late',
        'Order cancelled',
        'Charged twice',
        'Other',
      ],
      'sessions.stale_alert_hours': 3,
      'shop.business_day_cutoff': '04:00',
      'shop.business_hours': { opens: '00:00', closes: '00:00' },
      'shop.timezone': 'Asia/Karachi',
    });
  });
});
