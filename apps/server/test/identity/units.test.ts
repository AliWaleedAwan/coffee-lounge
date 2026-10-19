import { describe, expect, it } from 'vitest';
import { resolveEffective } from '../../src/modules/identity/permissions.ts';
import {
  hashSecret,
  newRecoveryCode,
  newRegistrationCode,
  passwordProblem,
  pinProblem,
  verifySecret,
} from '../../src/modules/identity/secrets.ts';
import { lockMinutes } from '../../src/modules/identity/service.ts';
import { FailureThrottle } from '../../src/platform/rate-limit.ts';

describe('argon2id hashing', () => {
  it('stores PHC strings and verifies only the right secret', async () => {
    const hash = await hashSecret('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(await verifySecret('correct horse battery', hash)).toBe(true);
    expect(await verifySecret('correct horse batterz', hash)).toBe(false);
    expect(await verifySecret('anything', 'not a hash')).toBe(false);
  });

  it('salts every hash differently', async () => {
    expect(await hashSecret('same')).not.toBe(await hashSecret('same'));
  });
});

describe('password and PIN rules', () => {
  it('requires 10–128 character passwords', () => {
    expect(passwordProblem('short')).toMatch(/at least 10/);
    expect(passwordProblem('x'.repeat(129))).toMatch(/at most 128/);
    expect(passwordProblem('long-enough-1')).toBeNull();
  });

  it('accepts 4–6 digit PINs but not repeats or straight runs', () => {
    for (const ok of ['2580', '73914', '409182']) expect(pinProblem(ok), ok).toBeNull();
    for (const bad of ['123', '1234567', '12a4', '0000', '1234', '9876', '456789']) {
      expect(pinProblem(bad), bad).not.toBeNull();
    }
  });

  it('makes eight-digit registration codes and grouped recovery codes', () => {
    expect(newRegistrationCode()).toMatch(/^\d{8}$/);
    expect(newRecoveryCode()).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  });
});

describe('lockout schedule', () => {
  it('locks after 5 failures for 5 min, doubling every 5 more, capped at 60', () => {
    expect([1, 4, 5, 9, 10, 15, 20, 40].map(lockMinutes)).toEqual([0, 0, 5, 5, 10, 20, 40, 60]);
  });
});

describe('effective permissions (RBAC.md §1)', () => {
  const protectedKeys = new Set(['roles.manage']);

  it('lets a deny override win over any grant', () => {
    const result = resolveEffective({
      isOwner: false,
      roleGrants: [{ key: 'devices.manage', role: 'manager', scope: null }],
      overrides: [
        { key: 'devices.manage', effect: 'deny' },
        { key: 'reports.sales', effect: 'grant' },
      ],
      protectedKeys,
    });
    expect(result.has('devices.manage')).toBe(false);
    expect(result.get('reports.sales')?.scopes).toBe('all');
  });

  it('collects scopes, and an unscoped grant makes the permission unrestricted', () => {
    const scoped = resolveEffective({
      isOwner: false,
      roleGrants: [
        { key: 'orders.accept', role: 'waiter', scope: { acceptance: 'assigned_tables' } },
        { key: 'orders.accept', role: 'cashier', scope: { acceptance: 'cashier' } },
      ],
      overrides: [],
      protectedKeys,
    });
    expect(scoped.get('orders.accept')?.scopes).toEqual([
      { acceptance: 'assigned_tables' },
      { acceptance: 'cashier' },
    ]);
    const unscoped = resolveEffective({
      isOwner: false,
      roleGrants: [
        { key: 'orders.accept', role: 'waiter', scope: { acceptance: 'assigned_tables' } },
        { key: 'orders.accept', role: 'manager', scope: null },
      ],
      overrides: [],
      protectedKeys,
    });
    expect(unscoped.get('orders.accept')?.scopes).toBe('all');
  });

  it('removes protected permissions from anyone who is not an owner', () => {
    const input = {
      roleGrants: [{ key: 'roles.manage', role: 'owner', scope: null }],
      overrides: [],
      protectedKeys,
    };
    expect(resolveEffective({ ...input, isOwner: false }).has('roles.manage')).toBe(false);
    expect(resolveEffective({ ...input, isOwner: true }).has('roles.manage')).toBe(true);
  });
});

describe('failure throttle', () => {
  it('blocks a key only after the failure limit, per window', () => {
    let now = 0;
    const throttle = new FailureThrottle(2, 1_000, () => now);
    expect(throttle.blockedFor('ip')).toBe(0);
    throttle.recordFailure('ip');
    expect(throttle.blockedFor('ip')).toBe(0);
    throttle.recordFailure('ip');
    expect(throttle.blockedFor('ip')).toBe(1_000);
    expect(throttle.blockedFor('other')).toBe(0);
    now = 1_000;
    expect(throttle.blockedFor('ip')).toBe(0);
  });
});
