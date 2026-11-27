/**
 * Users & roles behind the oversight screens (Phase 5 step 5.5): the catalogue and grants,
 * a user's roles and overrides, the effective-permission preview with where each permission
 * comes from (AT-38), the last owner kept (AT-39), resets of a forgotten password or PIN,
 * and the audit log with every field (AT-95); the inbox lists counts and stock alerts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '../../src/platform/audit.ts';
import {
  identityFixture,
  OWNER,
  STAFF_PASSWORD,
  type Client,
  type IdentityFixture,
} from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let manager: Client;
let cashier: Client;
let managerId = '';
let cashierId = '';

type Body = Record<string, unknown>;
async function call(
  client: Client,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  payload?: object,
) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}
const preview = async (userId: string) =>
  (await call(owner, 'GET', `/users/${userId}/effective-permissions`)).body['permissions'] as {
    key: string;
    sources: string[];
  }[];

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  managerId = await fx.addUser('ac-mgr', ['manager']);
  cashierId = await fx.addUser('ac-cash', ['cashier']);
  manager = await fx.loggedIn('ac-mgr');
  cashier = await fx.loggedIn('ac-cash');
});
afterAll(async () => {
  await fx.close();
});

describe('the catalogue and role grants', () => {
  it('lists permissions with their policies, and keeps the owner role whole', async () => {
    const catalog = (await call(owner, 'GET', '/access/catalog')).body as {
      permissions: { key: string; isProtected: boolean }[];
      roles: { key: string; grants: { key: string }[]; policies: Record<string, string> }[];
    };
    expect(catalog.permissions.find((p) => p.key === 'roles.manage')?.isProtected).toBe(true);
    const mgr = catalog.roles.find((r) => r.key === 'manager');
    expect(mgr?.policies['ledger.read']).toBe('grantable');
    expect(mgr?.grants.map((g) => g.key)).not.toContain('ledger.read');

    // ○: grantable to the manager role; every manager gets it, and the preview names the role.
    const granted = await call(owner, 'PUT', '/roles/manager/permissions/ledger.read', {
      reason: 'Managers check the money',
    });
    expect(granted.status).toBe(204);
    expect((await preview(managerId)).find((p) => p.key === 'ledger.read')?.sources).toEqual([
      'role:manager',
    ]);
    expect((await call(manager, 'GET', '/ledger')).status).toBe(200);
    expect(
      (await call(owner, 'PUT', '/roles/owner/permissions/ledger.read', { reason: 'Try it' }))
        .status,
    ).toBe(400);
    const revoked = await call(
      owner,
      'DELETE',
      '/roles/manager/permissions/ledger.read?reason=Back%20to%20default',
    );
    expect(revoked.status).toBe(204);
    expect((await call(manager, 'GET', '/ledger')).status).toBe(403);
    // Only the owner changes roles (roles.manage is owner-only); a manager may read users only if granted.
    expect(
      (await call(manager, 'PUT', '/roles/manager/permissions/ledger.read', { reason: 'Self' }))
        .status,
    ).toBe(403);
    expect((await call(manager, 'GET', '/access/catalog')).status).toBe(403);
  });
});

describe('a user’s roles, overrides and the preview (AT-38)', () => {
  it('a deny override wins over the role grant, server side and in the preview', async () => {
    expect((await preview(cashierId)).find((p) => p.key === 'payments.collect')?.sources).toEqual([
      'role:cashier',
    ]);
    const denied = await call(
      owner,
      'PUT',
      `/users/${cashierId}/permission-overrides/payments.refund_request`,
      {
        effect: 'deny',
        reason: 'Under review',
      },
    );
    expect(denied.status).toBe(204);
    expect((await preview(cashierId)).map((p) => p.key)).not.toContain('payments.refund_request');
    expect((await call(cashier, 'GET', '/refunds/bills')).status).toBe(403);
    const overrides = (await call(owner, 'GET', `/users/${cashierId}/permission-overrides`)).body[
      'items'
    ];
    expect(overrides).toEqual([
      expect.objectContaining({
        key: 'payments.refund_request',
        effect: 'deny',
        reason: 'Under review',
        grantedBy: 'Owner',
      }),
    ]);
    // A role added later shows with both sources.
    expect(
      (
        await call(owner, 'PUT', `/users/${cashierId}/roles`, {
          roles: ['cashier', 'waiter'],
          reason: 'Covers the floor',
        })
      ).status,
    ).toBe(204);
    expect((await preview(cashierId)).find((p) => p.key === 'tables.read')?.sources).toEqual(
      expect.arrayContaining(['role:cashier', 'role:waiter']),
    );
    expect(
      (
        await call(owner, 'PUT', `/users/${cashierId}/roles`, {
          roles: ['barista'],
          reason: 'No such role',
        })
      ).status,
    ).toBe(400);
  });
});

describe('the last owner stays (AT-39)', () => {
  it('cannot be disabled or lose the owner role; a second owner can', async () => {
    const res = await call(owner, 'PUT', `/users/${fx.ownerId}/roles`, {
      roles: ['manager'],
      reason: 'Step back',
    });
    expect(res.status).toBe(400);
    expect(res.body['detail']).toBe('At least one active owner must remain');
    expect(
      (await call(owner, 'POST', `/users/${fx.ownerId}/status`, { status: 'disabled' })).status,
    ).toBe(400);
    const second = await fx.addUser('ac-owner2', ['owner']);
    expect(
      (
        await call(owner, 'PUT', `/users/${second}/roles`, {
          roles: ['manager'],
          reason: 'Partner left',
        })
      ).status,
    ).toBe(204);
    const { rows } = await fx.pool.query<{ is_owner: boolean }>(
      'SELECT is_owner FROM cl.users WHERE id = $1',
      [second],
    );
    expect(rows[0]?.is_owner).toBe(false);
  });
});

describe('a forgotten password or PIN', () => {
  it('is reset by someone with users.manage; the person changes it at the next login', async () => {
    expect(
      (await call(owner, 'POST', `/users/${cashierId}/credentials`, { password: 'short' })).status,
    ).toBe(400);
    const reset = await call(owner, 'POST', `/users/${cashierId}/credentials`, {
      password: 'a-new-long-password-1',
      pin: '8642',
    });
    expect(reset.status).toBe(204);
    // The old session ended; the new password works and must be changed.
    expect((await call(cashier, 'GET', '/auth/me')).status).toBe(401);
    const again = await fx.loggedIn('ac-cash', 'a-new-long-password-1');
    const me = (await call(again, 'GET', '/auth/me')).body;
    expect(me['mustChangePassword']).toBe(true);
    expect(
      (
        await call(owner, 'POST', `/users/${fx.ownerId}/credentials`, {
          password: 'a-new-long-password-1',
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(manager, 'POST', `/users/${cashierId}/credentials`, { password: STAFF_PASSWORD }))
        .status,
    ).toBe(403);
  });
});

describe('the audit log (AT-95)', () => {
  it('shows actor, device, record, before and after, reason and approver; filters and pages', async () => {
    const page = await call(owner, 'GET', `/audit?entityType=user&entityId=${cashierId}`);
    const items = page.body['items'] as Body[];
    const roles = items.find((i) => i['action'] === 'user.roles');
    expect(roles).toMatchObject({
      actorKind: 'user',
      actor: 'Owner',
      entityType: 'user',
      entityId: cashierId,
      before: { roles: ['cashier'] },
      after: { roles: ['cashier', 'waiter'] },
      reason: 'Covers the floor',
    });
    expect(typeof roles?.['device']).toBe('string');
    expect(roles?.['correlationId']).toMatch(/^[0-9a-f-]{36}$/);
    // Newest first, a page at a time.
    const first = await call(owner, 'GET', '/audit?limit=2');
    const next = String(first.body['nextBefore']);
    const second = await call(owner, 'GET', `/audit?limit=2&before=${next}`);
    const ids = [...(first.body['items'] as Body[]), ...(second.body['items'] as Body[])].map((i) =>
      Number(i['id']),
    );
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(4);
    // By action family and by person (as actor or approver).
    const grants = (await call(owner, 'GET', '/audit?action=role')).body['items'] as Body[];
    expect(grants.map((g) => g['action'])).toEqual(['role.revoke', 'role.grant']);
    const byManager = (await call(owner, 'GET', `/audit?userId=${managerId}`)).body[
      'items'
    ] as Body[];
    expect(byManager.every((i) => i['actor'] === 'ac-mgr' || i['approvedBy'] === 'ac-mgr')).toBe(
      true,
    );
    const filters = (await call(owner, 'GET', '/audit/filters')).body;
    expect(filters['actions']).toEqual(expect.arrayContaining(['user.roles', 'role.grant']));
    expect((await call(owner, 'GET', '/audit?from=2026-10-27&to=2026-10-01')).status).toBe(400);
    expect((await call(manager, 'GET', '/audit')).status).toBe(403);
    expect((await call(cashier, 'GET', '/audit')).status).toBe(401);
  });

  it('names the approver of an approved action', async () => {
    await writeAudit(
      fx.pool,
      { actor: { kind: 'user', userId: cashierId }, correlationId: randomUUID() },
      {
        action: 'payment.refund',
        entityType: 'invoice',
        entityId: '1',
        reason: 'Cold coffee',
        approvedBy: fx.ownerId,
        before: { refunded: '0.00' },
        after: { amount: '500.00' },
      },
    );
    const items = (await call(owner, 'GET', '/audit?action=payment.refund')).body[
      'items'
    ] as Body[];
    expect(items[0]).toMatchObject({
      actor: 'ac-cash',
      approvedBy: 'Owner',
      reason: 'Cold coffee',
      before: { refunded: '0.00' },
      after: { amount: '500.00' },
    });
  });
});

describe('the inbox completed (step 5.5)', () => {
  it('lists counts waiting for approval and critical stock alerts, with links', async () => {
    const { rows: items } = await fx.pool.query<{ id: string }>(
      `INSERT INTO cl.inventory_items (sku, name, category, base_uom) VALUES ('AC-MILK', 'Inbox milk', 'Dairy', 'ml')
       RETURNING id::text`,
    );
    await fx.pool.query(`INSERT INTO cl.inventory_alerts (item_id, kind) VALUES ($1, 'zero')`, [
      items[0]?.id,
    ]);
    await fx.pool.query(
      `INSERT INTO cl.stock_counts (count_no, status, scope_kind, scope_category, started_by, submitted_by, submitted_at)
       VALUES ('CNT-2026-00099', 'submitted', 'category', 'Dairy', $1, $1, now())`,
      [cashierId],
    );
    const inbox = (await call(owner, 'GET', '/operations')).body['inbox'] as Body[];
    expect(inbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'count_waiting',
          title: 'Stock count CNT-2026-00099 waits for approval',
          detail: 'Dairy, counted by ac-cash',
          link: '/inventory?tab=counts',
        }),
        expect.objectContaining({
          kind: 'stock_alert',
          title: '1 item out of stock',
          detail: 'Inbox milk',
          link: '/inventory',
        }),
      ]),
    );
  });
});

describe('hardening from the RBAC review (step 5.6)', () => {
  it('a manager given users.manage resets staff only, never a manager or someone with extra grants', async () => {
    await call(owner, 'PUT', `/users/${managerId}/permission-overrides/users.manage`, {
      effect: 'grant',
      reason: 'Looks after staff accounts',
    });
    const waiterId = await fx.addUser('ac-waiter', ['waiter']);
    const otherManager = await fx.addUser('ac-mgr2', ['manager']);
    const body = { password: 'a-new-long-password-2' };
    expect((await call(manager, 'POST', `/users/${waiterId}/credentials`, body)).status).toBe(204);
    const refused = await call(manager, 'POST', `/users/${otherManager}/credentials`, body);
    expect(refused.status).toBe(403);
    await call(owner, 'PUT', `/users/${waiterId}/permission-overrides/payments.collect`, {
      effect: 'grant',
      reason: 'Takes payments at the table',
    });
    expect((await call(manager, 'POST', `/users/${waiterId}/credentials`, body)).status).toBe(403);
    expect((await call(owner, 'POST', `/users/${otherManager}/credentials`, body)).status).toBe(
      204,
    );
  });

  it('nobody approves with a PIN someone else set until they chose their own password', async () => {
    const approver = await fx.addUser('ac-approver', ['manager'], {
      pin: '1357',
      mustChange: true,
    });
    const stepUp = (pin: string) =>
      call(owner, 'POST', '/auth/step-up', {
        action: 'shift.variance',
        entityType: 'cash_shift',
        entityId: '1',
        approverUsername: 'ac-approver',
        approverPin: pin,
        reason: 'Count checked',
      });
    const refused = await stepUp('1357');
    expect(refused.status).toBe(403);
    expect(refused.body['detail']).toBe(
      'This approver must first log in and choose their own password',
    );
    await fx.pool.query('UPDATE cl.users SET must_change_password = false WHERE id = $1', [
      approver,
    ]);
    expect((await stepUp('1357')).status).toBe(201);
  });
});

describe('the owner’s lists (step 5.6)', () => {
  it('keeps refund reasons and asset lists as settings, checked and offered where used', async () => {
    const settings = (await call(owner, 'GET', '/settings')).body['items'] as Body[];
    const reasons = settings.find((x) => x['key'] === 'refunds.reasons');
    expect(reasons).toMatchObject({ group: 'Billing', editable: true });
    const patch = (value: unknown) =>
      owner.call({
        method: 'PATCH',
        url: '/api/staff/v1/settings/refunds.reasons',
        payload: { value, expectedVersion: reasons?.['version'] },
      });
    expect((await patch(['Wrong order', 'wrong order'])).statusCode).toBe(400);
    expect((await patch([])).statusCode).toBe(400);
    expect((await patch(['Wrong order', 'Quality', 'Other'])).statusCode).toBe(200);
    const assets = (await call(owner, 'GET', '/assets')).body;
    expect(assets['categories']).toEqual(
      expect.arrayContaining(['Coffee equipment', 'POS hardware']),
    );
    expect(assets['locations']).toEqual(expect.arrayContaining(['Bar', 'Store room']));
  });
});

describe('financial settings stay the owner’s (RBAC review, step 5.6)', () => {
  it('a manager given settings.manage changes operational settings, not money ones', async () => {
    await call(owner, 'PUT', `/users/${managerId}/permission-overrides/settings.manage`, {
      effect: 'grant',
      reason: 'Runs the floor settings',
    });
    const items = (await call(manager, 'GET', '/settings')).body['items'] as Body[];
    const patch = (client: Client, key: string, value: unknown) =>
      client.call({
        method: 'PATCH',
        url: `/api/staff/v1/settings/${key}`,
        payload: { value, expectedVersion: items.find((x) => x['key'] === key)?.['version'] },
      });
    expect(items.find((x) => x['key'] === 'billing.cash_rounding_unit')).toMatchObject({
      financial: true,
    });
    expect((await patch(manager, 'orders.escalation_minutes', 5)).statusCode).toBe(200);
    const rounding = await patch(manager, 'billing.cash_rounding_unit', '5.00');
    expect(rounding.statusCode).toBe(403);
    expect((await patch(manager, 'inventory.count_variance_pct', 10)).statusCode).toBe(403);
    expect((await patch(owner, 'billing.cash_rounding_unit', '5.00')).statusCode).toBe(200);
  });
});
