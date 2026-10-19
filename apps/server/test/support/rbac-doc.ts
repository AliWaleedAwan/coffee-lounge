/**
 * Reads the permission catalog from docs/RBAC.md §2 so the seed migration can be
 * generated from it and the database can be checked against it.
 *
 * Cell legend (RBAC.md): ✔ granted · 🔒 owner-only, granted · S scoped grant ·
 * ○ grantable (off by default) · ✕ never grantable.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROLE_KEYS = [
  'owner',
  'manager',
  'waiter',
  'cashier',
  'inventory_clerk',
  'kitchen',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export type CellPolicy = 'granted' | 'grantable' | 'forbidden';

export interface CatalogEntry {
  key: string;
  module: string;
  description: string;
  isProtected: boolean;
  scopeKind: 'none' | 'acceptance_scope' | 'own_records' | 'limit';
  roles: Record<RoleKey, { policy: CellPolicy; scoped: boolean }>;
}

/** Scope data for scoped grants; the doc marks them with "S", the shape lives here. */
export const SCOPES: Record<string, Partial<Record<RoleKey, Record<string, string>>>> = {
  'orders.accept': {
    waiter: { acceptance: 'assigned_tables' },
    cashier: { acceptance: 'cashier' },
  },
  'orders.reject': {
    waiter: { acceptance: 'assigned_tables' },
    cashier: { acceptance: 'cashier' },
  },
  'orders.void': { waiter: { tables: 'own' } },
  'sessions.reset_guests': { waiter: { tables: 'own' } },
  'invoices.read': { waiter: { tables: 'own' } },
  'discounts.apply': { manager: { limit: 'role' }, cashier: { limit: 'role' } },
  'cash_shifts.operate': { cashier: { shift: 'own' } },
};

const SCOPE_KINDS: Record<string, CatalogEntry['scopeKind']> = {
  'orders.accept': 'acceptance_scope',
  'orders.reject': 'acceptance_scope',
  'orders.void': 'own_records',
  'sessions.reset_guests': 'own_records',
  'invoices.read': 'own_records',
  'cash_shifts.operate': 'own_records',
  'discounts.apply': 'limit',
};

const KEY_PATTERN = /`([a-z_]+(?:\.[a-z_]+)+)`/g;

function classify(cell: string): { policy: CellPolicy; scoped: boolean; locked: boolean } {
  const text = cell.trim();
  const scoped = /^S\b/.test(text) || /\sS\b/.test(text);
  if (text.startsWith('🔒')) return { policy: 'granted', scoped: false, locked: true };
  if (text.startsWith('✔') || text.startsWith('S '))
    return { policy: 'granted', scoped, locked: false };
  if (text.startsWith('○')) return { policy: 'grantable', scoped: false, locked: false };
  if (text.startsWith('✕')) return { policy: 'forbidden', scoped: false, locked: false };
  throw new Error(`Unrecognised RBAC.md cell "${text}"`);
}

const stripMarkdown = (s: string): string =>
  s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();

export function readRbacCatalog(
  path = fileURLToPath(new URL('../../../../docs/RBAC.md', import.meta.url)),
): CatalogEntry[] {
  const doc = readFileSync(path, 'utf8');
  const start = doc.indexOf('## 2. Catalog and defaults');
  const end = doc.indexOf('## 3.', start);
  if (start < 0 || end < 0) throw new Error('RBAC.md §2 not found');

  const entries: CatalogEntry[] = [];
  for (const line of doc.slice(start, end).split('\n')) {
    if (!line.startsWith('| `')) continue; // data rows begin with a permission key
    const cells = line.split('|').slice(1, -1);
    if (cells.length !== 8) throw new Error(`RBAC.md row has ${cells.length} cells: ${line}`);
    const [permCell = '', descCell = '', ...roleCells] = cells;
    const keys = [...permCell.matchAll(KEY_PATTERN)].map((m) => m[1] ?? '');
    const classified = roleCells.map(classify);
    for (const key of keys) {
      const roles = {} as CatalogEntry['roles'];
      ROLE_KEYS.forEach((role, i) => {
        const c = classified[i];
        if (!c) throw new Error(`Missing cell for ${role} in ${key}`);
        roles[role] = { policy: c.policy, scoped: c.scoped };
      });
      entries.push({
        key,
        module: key.split('.')[0] ?? key,
        description: stripMarkdown(descCell),
        isProtected: classified[0]?.locked ?? false,
        scopeKind: SCOPE_KINDS[key] ?? 'none',
        roles,
      });
    }
  }
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.key)) throw new Error(`Duplicate permission ${e.key} in RBAC.md`);
    seen.add(e.key);
  }
  return entries;
}
