import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AREAS, homePath, visibleAreas } from './areas.ts';

// Vitest runs from the repository root.
const RBAC = readFileSync(resolve(process.cwd(), 'docs/RBAC.md'), 'utf8');

/** Role column of RBAC.md: ✔ marks the default grants, possibly scoped ("✔ S …"). */
function defaultPermissions(column: number): Set<string> {
  const keys = new Set<string>();
  for (const line of RBAC.split('\n')) {
    const match = /^\| `([a-z_]+\.[a-z_]+)` \|/.exec(line);
    if (!match?.[1]) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells[3 + column]?.startsWith('✔')) keys.add(match[1]);
  }
  return keys;
}
const OWNER = 0;
const WAITER = 2;
const CASHIER = 3;
const CLERK = 4;

describe('navigation from permissions', () => {
  it('only uses permission keys from the RBAC catalogue', () => {
    for (const area of AREAS) {
      for (const key of area.anyOf) expect(RBAC, `${area.id}: ${key}`).toContain(`| \`${key}\` |`);
    }
  });

  it('gives each role the areas its default permissions allow', () => {
    const ids = (column: number) => visibleAreas(defaultPermissions(column)).map((a) => a.id);
    expect(ids(WAITER)).toEqual(['floor', 'approvals', 'pickup']);
    expect(ids(CASHIER)).toEqual(
      expect.arrayContaining(['floor', 'approvals', 'pickup', 'counter', 'deliveries']),
    );
    expect(ids(CASHIER)).not.toContain('devices');
    expect(ids(CLERK)).toEqual(expect.arrayContaining(['inventory', 'menu']));
    expect(ids(CLERK)).not.toContain('counter');
    expect(ids(OWNER)).toEqual(AREAS.map((a) => a.id));
  });

  it('sends a user to their first area, or to their account if they have none', () => {
    expect(homePath(defaultPermissions(WAITER))).toBe('/floor');
    expect(homePath(new Set(['inventory.read']))).toBe('/inventory');
    expect(homePath(new Set())).toBe('/account');
  });
});
