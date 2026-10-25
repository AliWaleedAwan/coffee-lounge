/**
 * Generates migrations/0002_seed_access.sql from docs/RBAC.md.
 * Run (from apps/server): node scripts/generate-access-seed.ts
 * The seed is committed; the database test re-reads RBAC.md and compares.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRbacCatalog, ROLE_KEYS, SCOPES } from '../test/support/rbac-doc.ts';

const ROLE_NAMES: Record<(typeof ROLE_KEYS)[number], [string, string]> = {
  owner: ['Owner', 'Full access; protected permissions are owner-only'],
  manager: ['Manager', 'Live operations, approvals and permitted reports'],
  waiter: ['Waiter', 'Tables, orders and approvals for assigned tables'],
  cashier: ['Cashier', 'Bills, payments, takeaway, deliveries and cash shift'],
  inventory_clerk: ['Inventory clerk', 'Stock, receiving, counts, recipes and imports'],
  kitchen: ['Kitchen', 'Inactive while there is no kitchen device (D-33)'],
};

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const catalog = readRbacCatalog();

const lines: string[] = [
  '-- 0002 Seed: roles, permission catalog, default grants and grantability.',
  '-- GENERATED from docs/RBAC.md by scripts/generate-access-seed.ts. Do not edit by hand;',
  '-- change RBAC.md, regenerate as a NEW migration, and keep this file unchanged once applied.',
  '',
  'INSERT INTO cl.roles (key, name, is_system, description) VALUES',
  ROLE_KEYS.map((k) => `  (${q(k)}, ${q(ROLE_NAMES[k][0])}, true, ${q(ROLE_NAMES[k][1])})`).join(
    ',\n',
  ) + ';',
  '',
  'INSERT INTO cl.permissions (key, module, description, scope_kind, is_protected) VALUES',
  catalog
    .map(
      (p) =>
        `  (${q(p.key)}, ${q(p.module)}, ${q(p.description)}, ${q(p.scopeKind)}, ${p.isProtected})`,
    )
    .join(',\n') + ';',
  '',
  '-- Policies first, so the grant trigger can check them.',
  'INSERT INTO cl.role_permission_policy (role_id, permission_key, policy)',
  'SELECT r.id, v.permission_key, v.policy FROM (VALUES',
];

const policyRows: string[] = [];
const grantRows: string[] = [];
for (const p of catalog) {
  for (const role of ROLE_KEYS) {
    const cell = p.roles[role];
    if (cell.policy === 'granted') {
      const scope = SCOPES[p.key]?.[role];
      if (cell.scoped && !scope)
        throw new Error(`Scoped grant ${p.key}/${role} has no SCOPES entry`);
      if (!cell.scoped && scope)
        throw new Error(`SCOPES entry ${p.key}/${role} not marked S in RBAC.md`);
      grantRows.push(
        `  (${q(role)}, ${q(p.key)}, ${scope ? `${q(JSON.stringify(scope))}::jsonb` : 'NULL::jsonb'})`,
      );
    } else {
      policyRows.push(`  (${q(role)}, ${q(p.key)}, ${q(cell.policy)})`);
    }
  }
}
lines.push(policyRows.join(',\n'));
lines.push(') AS v(role_key, permission_key, policy) JOIN cl.roles r ON r.key = v.role_key;');
lines.push('');
lines.push('INSERT INTO cl.role_permissions (role_id, permission_key, scope)');
lines.push('SELECT r.id, v.permission_key, v.scope FROM (VALUES');
lines.push(grantRows.join(',\n'));
lines.push(') AS v(role_key, permission_key, scope) JOIN cl.roles r ON r.key = v.role_key;');
lines.push('');
lines.push(
  '-- Discount limits (D-14): cashier 10 %, manager 20 %; above that needs step-up approval.',
);
lines.push('INSERT INTO cl.role_discount_limits (role_id, max_percent)');
lines.push("SELECT id, CASE key WHEN 'cashier' THEN 10 WHEN 'manager' THEN 20 END");
lines.push("  FROM cl.roles WHERE key IN ('cashier','manager');");
lines.push('');

const out = fileURLToPath(new URL('../migrations/0002_seed_access.sql', import.meta.url));
writeFileSync(out, lines.join('\n'));
console.log(
  `Wrote ${out}: ${catalog.length} permissions, ${grantRows.length} grants, ${policyRows.length} policies`,
);
