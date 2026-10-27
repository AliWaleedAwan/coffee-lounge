/**
 * The RBAC review (Phase 5 step 5.6, docs/phase-5/RBAC_REVIEW.md): its generated part is the
 * real route inventory with each route's access, the ○ grants per role, the step-up actions
 * and the permissions no route names, so the document cannot drift from the code. After an
 * intended change:
 *   UPDATE_RBAC_REVIEW=1 corepack pnpm exec vitest run --project server apps/server/test/identity/rbac-review.test.ts
 * and review the diff. Every permission a route names must exist in the catalogue.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STEP_UP_ACTIONS } from '../../src/modules/identity/service.ts';
import { identityFixture, type IdentityFixture } from '../support/identity.ts';

const DOC = new URL('../../../../docs/phase-5/RBAC_REVIEW.md', import.meta.url);
const START = '<!-- generated:start (rbac-review.test.ts) -->';
const END = '<!-- generated:end -->';

let fx: IdentityFixture;
beforeAll(async () => {
  fx = await identityFixture();
});
afterAll(async () => {
  await fx.close();
});

describe('RBAC review (step 5.6)', () => {
  it('matches the routes, grants and step-up actions as built', async () => {
    const { rows: catalog } = await fx.pool.query<{ key: string; is_protected: boolean }>(
      'SELECT key, is_protected FROM cl.permissions ORDER BY key',
    );
    const known = new Set(catalog.map((p) => p.key));
    const routes = fx.routes
      .map((r) => ({
        method: r.method,
        url: r.url.replace(/^\/api\/staff\/v1/, ''),
        access: r.config.permission ? `\`${r.config.permission}\`` : (r.config.auth ?? 'session'),
        permission: r.config.permission,
      }))
      .sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
    for (const r of routes) {
      if (r.permission) expect(known, `${r.method} ${r.url}`).toContain(r.permission);
    }
    const used = new Set(routes.flatMap((r) => (r.permission ? [r.permission] : [])));
    const { rows: grantable } = await fx.pool.query<{ role: string; keys: string[] }>(
      `SELECT r.key AS role, array_agg(p.permission_key ORDER BY p.permission_key) AS keys
         FROM cl.role_permission_policy p JOIN cl.roles r ON r.id = p.role_id
        WHERE p.policy = 'grantable' GROUP BY r.key, r.id ORDER BY r.id`,
    );
    const lines = [
      START,
      '',
      `### A. Every staff route (${String(routes.length)})`,
      '',
      'Access: a permission key (checked before the handler, SEC-ALL), `session` (any logged-in user: their own data only), `device` (a registered device, before login), `public` (no device yet).',
      '',
      '| Method | Path | Access |',
      '|---|---|---|',
      ...routes.map((r) => `| ${r.method} | \`${r.url}\` | ${r.access} |`),
      '',
      '### B. ○ grants: what the owner may give each role (RBAC.md)',
      '',
      '| Role | May be given |',
      '|---|---|',
      ...grantable.map((g) => `| ${g.role} | ${g.keys.map((k) => `\`${k}\``).join(', ')} |`),
      '',
      '### C. Step-up actions (approver ≠ requester, same device, 2 minutes, used once)',
      '',
      '| Action | Approver needs |',
      '|---|---|',
      ...Object.entries(STEP_UP_ACTIONS).map(([a, p]) => `| \`${a}\` | \`${p}\` |`),
      '',
      '### D. Owner-only (🔒) permissions',
      '',
      catalog
        .filter((p) => p.is_protected)
        .map((p) => `\`${p.key}\``)
        .join(', '),
      '',
      '### E. Permissions no route names (checked inside services, or for later phases)',
      '',
      catalog
        .filter((p) => !used.has(p.key))
        .map((p) => `\`${p.key}\``)
        .join(', '),
      '',
      END,
    ];
    const generated = lines.join('\n');
    const doc = readFileSync(DOC, 'utf8');
    const start = doc.indexOf(START);
    const end = doc.indexOf(END);
    expect(start, 'the review has its generated section').toBeGreaterThanOrEqual(0);
    const current = doc.slice(start, end + END.length);
    if (process.env['UPDATE_RBAC_REVIEW'] === '1') {
      writeFileSync(DOC, doc.slice(0, start) + generated + doc.slice(end + END.length));
      return;
    }
    expect(
      current,
      'docs/phase-5/RBAC_REVIEW.md differs from the code: see the comment above',
    ).toBe(generated);
  });
});
