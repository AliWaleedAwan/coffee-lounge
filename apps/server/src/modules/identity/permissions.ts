/**
 * Effective permissions (RBAC.md §1): union of role grants and override grants, minus
 * override denies (deny always wins). Protected permissions apply to owners only.
 * A permission granted without a scope is unrestricted; scoped grants accumulate.
 */
import type { Queryable } from '../../platform/db/pool.ts';

export type Scope = Readonly<Record<string, string>>;
export interface Grant {
  /** 'all' = unrestricted; otherwise the scopes under which it applies. */
  scopes: 'all' | Scope[];
  sources: string[];
}
export type EffectivePermissions = ReadonlyMap<string, Grant>;

export interface PermissionInputs {
  isOwner: boolean;
  roleGrants: { key: string; role: string; scope: Scope | null }[];
  overrides: { key: string; effect: 'grant' | 'deny' }[];
  protectedKeys: ReadonlySet<string>;
}

export function resolveEffective(input: PermissionInputs): Map<string, Grant> {
  const result = new Map<string, Grant>();
  const add = (key: string, scope: Scope | null, source: string): void => {
    const current = result.get(key);
    if (!current) {
      result.set(key, { scopes: scope ? [scope] : 'all', sources: [source] });
      return;
    }
    current.sources.push(source);
    if (current.scopes === 'all') return;
    if (scope === null) current.scopes = 'all';
    else current.scopes.push(scope);
  };

  for (const g of input.roleGrants) add(g.key, g.scope, `role:${g.role}`);
  for (const o of input.overrides) if (o.effect === 'grant') add(o.key, null, 'override:grant');
  for (const o of input.overrides) if (o.effect === 'deny') result.delete(o.key);
  if (!input.isOwner) for (const key of input.protectedKeys) result.delete(key);
  return result;
}

export async function loadEffectivePermissions(
  db: Queryable,
  userId: string,
): Promise<Map<string, Grant>> {
  // One after another: db may be a transaction client, which runs one query at a time.
  const user = await db.query<{ is_owner: boolean }>(
    `SELECT is_owner FROM cl.users WHERE id = $1 AND status = 'active'`,
    [userId],
  );
  const grants = await db.query<{ key: string; role: string; scope: Scope | null }>(
    `SELECT rp.permission_key AS key, r.key AS role, rp.scope
       FROM cl.user_roles ur
       JOIN cl.roles r ON r.id = ur.role_id
       JOIN cl.role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = $1`,
    [userId],
  );
  const overrides = await db.query<{ key: string; effect: 'grant' | 'deny' }>(
    `SELECT permission_key AS key, effect FROM cl.user_permission_overrides WHERE user_id = $1`,
    [userId],
  );
  const protectedRows = await db.query<{ key: string }>(
    `SELECT key FROM cl.permissions WHERE is_protected`,
  );
  const row = user.rows[0];
  if (!row) return new Map();
  return resolveEffective({
    isOwner: row.is_owner,
    roleGrants: grants.rows,
    overrides: overrides.rows,
    protectedKeys: new Set(protectedRows.rows.map((r) => r.key)),
  });
}

/** Serialisable form for /auth/me and the owner's effective-permission preview. */
export function describePermissions(
  permissions: EffectivePermissions,
): { key: string; scopes: 'all' | Scope[]; sources: string[] }[] {
  return [...permissions.entries()]
    .map(([key, g]) => ({ key, scopes: g.scopes, sources: g.sources }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
