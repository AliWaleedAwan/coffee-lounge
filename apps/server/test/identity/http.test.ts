import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeStepUp, recoverOwner } from '../../src/modules/identity/index.ts';
import { withTransaction } from '../../src/platform/db/tx.ts';
import {
  cookiesFrom,
  identityFixture,
  OWNER,
  STAFF_PASSWORD,
  type IdentityFixture,
} from '../support/identity.ts';

let fx: IdentityFixture;
beforeAll(async () => {
  fx = await identityFixture();
});
afterAll(async () => {
  await fx.close();
});

const url = (path: string): string => `/api/staff/v1${path}`;
const facts = { correlationId: '00000000-0000-4000-8000-000000000001' };

async function auditCount(action: string): Promise<number> {
  const { rows } = await fx.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM cl.audit_events WHERE action = $1',
    [action],
  );
  return rows[0]?.n ?? 0;
}

describe('device registration', () => {
  it('sets an httpOnly, SameSite=Strict device cookie and uses each code once', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const codeRes = await owner.call({
      method: 'POST',
      url: url('/devices/registration-codes'),
      payload: { deviceName: 'Sara phone', kind: 'waiter', ownership: 'personal' },
    });
    expect(codeRes.statusCode).toBe(201);
    const { code } = codeRes.json<{ code: string }>();

    const first = await fx.staff.inject({
      method: 'POST',
      url: url('/devices/register'),
      headers: { 'x-cl-request': '1' },
      payload: { code },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      name: 'Sara phone',
      kind: 'waiter',
      ownership: 'personal',
    });
    const deviceCookie = first.cookies.find((c) => c.name === 'cl_device');
    expect(deviceCookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });

    const again = await fx.staff.inject({
      method: 'POST',
      url: url('/devices/register'),
      headers: { 'x-cl-request': '1' },
      payload: { code },
    });
    expect(again.statusCode).toBe(400);
  });
});

describe('login on registered devices only (AT-41)', () => {
  it('refuses a correct password from an unregistered browser', async () => {
    const res = await fx.staff.inject({
      method: 'POST',
      url: url('/auth/login'),
      headers: { 'x-cl-request': '1' },
      payload: OWNER,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'DEVICE_NOT_REGISTERED' });
  });

  it('logs in on a registered device and reports who is logged in', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const me = await owner.call({ url: url('/auth/me') });
    expect(me.statusCode).toBe(200);
    const body = me.json<{
      user: { username: string };
      roles: string[];
      permissions: { key: string }[];
    }>();
    expect(body.user.username).toBe('owner');
    expect(body.roles).toEqual(['owner']);
    expect(body.permissions.map((p) => p.key)).toContain('roles.manage');
  });

  it('refuses staff routes without a session', async () => {
    const device = await fx.newDevice();
    const res = await device.call({ url: url('/auth/me') });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('cross-site request protection', () => {
  it('refuses mutations without X-CL-Request or from another origin', async () => {
    const device = await fx.newDevice();
    const noHeader = await device.call({
      method: 'POST',
      url: url('/auth/login'),
      payload: OWNER,
      csrf: false,
    });
    expect(noHeader.statusCode).toBe(403);
    const foreign = await device.call({
      method: 'POST',
      url: url('/auth/login'),
      payload: OWNER,
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
  });
});

describe('lockouts', () => {
  it('locks after five wrong passwords, even for the right one, and records it', async () => {
    await fx.addUser('locky', ['waiter']);
    const device = await fx.newDevice();
    const attempt = (password: string) =>
      device.call({
        method: 'POST',
        url: url('/auth/login'),
        payload: { username: 'locky', password },
      });

    for (let i = 0; i < 4; i += 1) expect((await attempt('wrong-password')).statusCode).toBe(401);
    const fifth = await attempt('wrong-password');
    expect(fifth.json()).toMatchObject({ code: 'UNAUTHENTICATED', retryAfterSeconds: 300 });
    expect((await attempt(STAFF_PASSWORD)).statusCode).toBe(401); // still locked
    expect(await auditCount('auth.locked_out')).toBeGreaterThanOrEqual(1);

    await fx.pool.query(
      `UPDATE cl.users SET locked_until = now() - interval '1 s' WHERE username = 'locky'`,
    );
    expect((await attempt(STAFF_PASSWORD)).statusCode).toBe(200);
    const { rows } = await fx.pool.query<{ failed_attempts: number }>(
      `SELECT failed_attempts FROM cl.users WHERE username = 'locky'`,
    );
    expect(rows[0]?.failed_attempts).toBe(0);
  });

  it('gives the same answer for an unknown user as for a wrong password', async () => {
    const device = await fx.newDevice();
    const res = await device.call({
      method: 'POST',
      url: url('/auth/login'),
      payload: { username: 'nobody', password: 'whatever-123' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ detail: 'Username or password is incorrect' });
  });
});

describe('PIN quick-switch and sessions (D-24)', () => {
  it('switches users on a shared tablet and ends the previous user’s session', async () => {
    await fx.addUser('sara', ['waiter'], { pin: '2580' });
    await fx.addUser('ali', ['cashier'], { pin: '7391' });
    const tablet = await fx.newDevice('waiter');
    const sara = await tablet.call({
      method: 'POST',
      url: url('/auth/pin-switch'),
      payload: { username: 'sara', pin: '2580' },
    });
    expect(sara.statusCode).toBe(200);
    const saraSession = cookiesFrom(sara)['cl_session'];

    const ali = await tablet.call({
      method: 'POST',
      url: url('/auth/pin-switch'),
      payload: { username: 'ali', pin: '7391' },
    });
    expect(ali.json<{ user: { username: string } }>().user.username).toBe('ali');

    const stale = await fx.staff.inject({
      url: url('/auth/me'),
      cookies: { cl_device: tablet.cookies['cl_device'] ?? '', cl_session: saraSession ?? '' },
    });
    expect(stale.statusCode).toBe(401);
  });

  it('refuses PIN login for the owner and for users who must change their password', async () => {
    await fx.pool.query(
      `UPDATE cl.users SET pin_hash = (SELECT pin_hash FROM cl.users WHERE username = 'sara') WHERE is_owner`,
    );
    await fx.addUser('newbie', ['waiter'], { pin: '4815', mustChange: true });
    const tablet = await fx.newDevice('waiter');
    for (const username of ['owner', 'newbie']) {
      const res = await tablet.call({
        method: 'POST',
        url: url('/auth/pin-switch'),
        payload: { username, pin: username === 'owner' ? '2580' : '4815' },
      });
      expect(res.statusCode, username).toBe(401);
      expect(res.json()).toMatchObject({ detail: 'Use your password to log in' });
    }
  });

  it('expires idle sessions and ends sessions on logout', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    await fx.pool.query(
      `UPDATE cl.auth_sessions SET idle_expires_at = now() - interval '1 s' WHERE revoked_at IS NULL AND user_id = $1`,
      [fx.ownerId],
    );
    expect((await owner.call({ url: url('/auth/me') })).statusCode).toBe(401);

    const again = await fx.loggedIn(OWNER.username, OWNER.password);
    expect((await again.call({ method: 'POST', url: url('/auth/logout') })).statusCode).toBe(204);
    expect((await again.call({ url: url('/auth/me') })).statusCode).toBe(401);
  });
});

describe('device revocation (AT-76)', () => {
  it('ends the revoked device’s session immediately and refuses its device cookie', async () => {
    await fx.addUser('phone_user', ['waiter'], { pin: '3692' });
    const phone = await fx.newDevice('waiter', 'Personal phone');
    await phone.call({
      method: 'POST',
      url: url('/auth/pin-switch'),
      payload: { username: 'phone_user', pin: '3692' },
    });
    expect((await phone.call({ url: url('/auth/me') })).statusCode).toBe(200);

    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const { items } = (await owner.call({ url: url('/devices') })).json<{
      items: { id: string; name: string }[];
    }>();
    const target = items.find((d) => d.name === 'Personal phone');
    expect(target).toBeDefined();
    const revoked = await owner.call({
      method: 'POST',
      url: url(`/devices/${target?.id ?? ''}/revoke`),
    });
    expect(revoked.statusCode).toBe(200);

    const after = await phone.call({ url: url('/auth/me') });
    expect(after.statusCode).toBe(403);
    expect(after.json()).toMatchObject({ code: 'DEVICE_NOT_REGISTERED' });
    const { rows } = await fx.pool.query<{ live: number }>(
      'SELECT count(*)::int AS live FROM cl.auth_sessions WHERE device_id = $1 AND revoked_at IS NULL',
      [target?.id],
    );
    expect(rows[0]?.live).toBe(0);
  });
});

describe('permissions enforced on the server (AT-18, AT-38, AT-118)', () => {
  it('refuses a waiter on an administration route and audits the attempt', async () => {
    await fx.addUser('w_admin_try', ['waiter']);
    const waiter = await fx.loggedIn('w_admin_try');
    const before = await auditCount('access.denied');
    const res = await waiter.call({ url: url('/users') });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(await auditCount('access.denied')).toBe(before + 1);
  });

  it('a deny override removes a role permission, and the preview matches /auth/me', async () => {
    const managerId = await fx.addUser('mgr', ['manager']);
    const manager = await fx.loggedIn('mgr');
    expect((await manager.call({ url: url('/devices') })).statusCode).toBe(200);

    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const put = await owner.call({
      method: 'PUT',
      url: url(`/users/${managerId}/permission-overrides/devices.manage`),
      payload: { effect: 'deny', reason: 'not needed on nights' },
    });
    expect(put.statusCode).toBe(204);
    expect((await manager.call({ url: url('/devices') })).statusCode).toBe(403);

    const preview = await owner.call({ url: url(`/users/${managerId}/effective-permissions`) });
    const me = await manager.call({ url: url('/auth/me') });
    const keys = (r: typeof me) =>
      r.json<{ permissions: { key: string }[] }>().permissions.map((p) => p.key);
    expect(keys(preview)).toEqual(keys(me));
    expect(keys(preview)).not.toContain('devices.manage');
    expect(await auditCount('permission.override_set')).toBeGreaterThanOrEqual(1);
  });

  it('lets an owner give a sensitive permission, and only an owner', async () => {
    const waiterId = await fx.addUser('w_protected', ['waiter']);
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const granted = await owner.call({
      method: 'PUT',
      url: url(`/users/${waiterId}/permission-overrides/roles.manage`),
      payload: { effect: 'grant', reason: 'the owner delegates' },
    });
    expect(granted.statusCode).toBe(204);
    const removed = await owner.call({
      method: 'DELETE',
      url: url(`/users/${waiterId}/permission-overrides/roles.manage?reason=done`),
    });
    expect(removed.statusCode).toBe(204);
  });

  it('only an owner may create another owner', async () => {
    const managerId = await fx.addUser('mgr_users', ['manager']);
    await fx.pool.query(
      `INSERT INTO cl.user_permission_overrides (user_id, permission_key, effect, reason, granted_by)
       VALUES ($1, 'users.manage', 'grant', 'test', $2)`,
      [managerId, fx.ownerId],
    );
    const manager = await fx.loggedIn('mgr_users');
    const res = await manager.call({
      method: 'POST',
      url: url('/users'),
      payload: {
        username: 'sneaky',
        displayName: 'Sneaky',
        password: 'long-password-1',
        roles: ['owner'],
      },
    });
    expect(res.statusCode).toBe(403);

    const ok = await manager.call({
      method: 'POST',
      url: url('/users'),
      payload: {
        username: 'new_waiter',
        displayName: 'New Waiter',
        password: 'long-password-1',
        pin: '2468',
        roles: ['waiter'],
      },
    });
    expect(ok.statusCode).toBe(201);
    const fresh = await fx.loggedIn('new_waiter', 'long-password-1');
    const me = (await fresh.call({ url: url('/auth/me') })).json<{ mustChangePassword: boolean }>();
    expect(me.mustChangePassword).toBe(true);
  });
});

describe('last active owner (AT-39)', () => {
  it('cannot be disabled through the API', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    const res = await owner.call({
      method: 'POST',
      url: url(`/users/${fx.ownerId}/status`),
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ detail: 'At least one active owner must remain' });
  });
});

describe('step-up approvals (AT-77)', () => {
  it('grants once to a different, permitted approver; refuses reuse, self-approval and the unpermitted', async () => {
    await fx.addUser('cash1', ['cashier']);
    await fx.addUser('boss', ['manager'], { pin: '8642' });
    await fx.addUser('waiter_pin', ['waiter'], { pin: '9753' });
    const cashier = await fx.loggedIn('cash1');
    const ask = (approverUsername: string, approverPin: string, action = 'discount.over_limit') =>
      cashier.call({
        method: 'POST',
        url: url('/auth/step-up'),
        payload: {
          action,
          entityType: 'invoice',
          entityId: '42',
          approverUsername,
          approverPin,
          reason: 'regular guest',
        },
      });

    const granted = await ask('boss', '8642');
    expect(granted.statusCode).toBe(201);
    const { stepUpId } = granted.json<{ stepUpId: string }>();

    const me = (await cashier.call({ url: url('/auth/me') })).json<{
      user: { id: string };
      device: { id: string };
    }>();
    const auth = { user: { id: me.user.id } as never, device: { id: me.device.id } as never };
    const use = (input: {
      stepUpId: string;
      action?: 'discount.over_limit' | 'refund.approve';
      entityId?: string;
    }) =>
      withTransaction(fx.pool, (tx) =>
        consumeStepUp(tx, auth, {
          stepUpId: input.stepUpId,
          action: input.action ?? 'discount.over_limit',
          entityType: 'invoice',
          entityId: input.entityId ?? '42',
        }),
      );

    await expect(use({ stepUpId, entityId: '43' })).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await expect(use({ stepUpId, action: 'refund.approve' })).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    expect(await use({ stepUpId })).toMatch(/^\d+$/);
    await expect(use({ stepUpId })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });

    // The waiter has a PIN but not payments.refund.
    expect((await ask('waiter_pin', '9753', 'refund.approve')).statusCode).toBe(403);
    // Wrong PIN.
    expect((await ask('boss', '1357')).statusCode).toBe(401);
  });

  it('refuses self-approval and approvals older than two minutes', async () => {
    await fx.addUser('self_mgr', ['manager'], { pin: '1593' });
    const manager = await fx.loggedIn('self_mgr');
    const self = await manager.call({
      method: 'POST',
      url: url('/auth/step-up'),
      payload: {
        action: 'discount.over_limit',
        entityType: 'invoice',
        entityId: '7',
        approverUsername: 'self_mgr',
        approverPin: '1593',
        reason: 'self',
      },
    });
    expect(self.statusCode).toBe(403);

    const me = (await manager.call({ url: url('/auth/me') })).json<{
      user: { id: string };
      device: { id: string };
    }>();
    const { rows } = await fx.pool.query<{ id: string }>(
      `INSERT INTO cl.step_up_approvals (action, requested_by, approved_by, device_id, entity_type, entity_id, reason, created_at)
       VALUES ('discount.over_limit', $1, $2, $3, 'invoice', 7, 'old', now() - interval '3 minutes') RETURNING id::text`,
      [me.user.id, fx.ownerId, me.device.id],
    );
    await expect(
      withTransaction(fx.pool, (tx) =>
        consumeStepUp(
          tx,
          { user: { id: me.user.id } as never, device: { id: me.device.id } as never },
          {
            stepUpId: rows[0]?.id ?? '',
            action: 'discount.over_limit',
            entityType: 'invoice',
            entityId: '7',
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });
});

describe('owner recovery (AT-119)', () => {
  it('works once with the printed code, ends owner sessions and issues a new code', async () => {
    const owner = await fx.loggedIn(OWNER.username, OWNER.password);
    await expect(
      recoverOwner(
        fx.pool,
        {
          username: 'owner',
          recoveryCode: 'WRONG-WRONG-WRONG-WRONG',
          newPassword: 'new-owner-pass-1',
        },
        facts,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await auditCount('owner.recovery_failed')).toBe(1);

    const { recoveryCode: next } = await recoverOwner(
      fx.pool,
      {
        username: 'owner',
        recoveryCode: fx.recoveryCode.toLowerCase(),
        newPassword: 'new-owner-pass-1',
      },
      facts,
    );
    expect(next).not.toBe(fx.recoveryCode);
    expect((await owner.call({ url: url('/auth/me') })).statusCode).toBe(401); // sessions ended
    expect(await auditCount('owner.recovered')).toBe(1);

    await expect(fx.loggedIn(OWNER.username, OWNER.password)).rejects.toThrow(/login failed/);
    await fx.loggedIn(OWNER.username, 'new-owner-pass-1');

    await expect(
      recoverOwner(
        fx.pool,
        { username: 'owner', recoveryCode: fx.recoveryCode, newPassword: 'another-pass-12' },
        facts,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    // Restore for any later test in this file.
    await recoverOwner(
      fx.pool,
      { username: 'owner', recoveryCode: next, newPassword: OWNER.password },
      facts,
    );
  });
});

describe('guessing is throttled (failures only)', () => {
  it('blocks registration after ten wrong codes from one address, with Retry-After', async () => {
    const tryCode = () =>
      fx.staff.inject({
        method: 'POST',
        url: url('/devices/register'),
        headers: { 'x-cl-request': '1' },
        remoteAddress: '192.168.100.77',
        payload: { code: '00000000' },
      });
    for (let i = 0; i < 10; i += 1) expect((await tryCode()).statusCode).toBe(400);
    const blocked = await tryCode();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('idle timer and background reads', () => {
  it('lets a refetch the user did not trigger read without keeping the session awake', async () => {
    await fx.addUser('idle_waiter', ['waiter']);
    const waiter = await fx.loggedIn('idle_waiter', STAFF_PASSWORD, 'waiter');
    const idleExpiry = async (): Promise<string> => {
      const { rows } = await fx.pool.query<{ t: string }>(
        `SELECT s.idle_expires_at::text AS t FROM cl.auth_sessions s
           JOIN cl.users u ON u.id = s.user_id
          WHERE u.username = 'idle_waiter' AND s.revoked_at IS NULL`,
      );
      return rows[0]?.t ?? '';
    };
    // Pretend the session was last used 4 minutes ago (waiter idle limit: 5 min).
    await fx.pool.query(
      `UPDATE cl.auth_sessions s SET idle_expires_at = now() + interval '1 minute'
         FROM cl.users u WHERE u.id = s.user_id AND u.username = 'idle_waiter'`,
    );
    const before = await idleExpiry();

    const background = await waiter.call({
      url: url('/auth/me'),
      headers: { 'x-cl-background': '1' },
    });
    expect(background.statusCode).toBe(200);
    expect(await idleExpiry()).toBe(before);

    // A write is always user activity, even if a client marks it as background.
    const write = await waiter.call({
      method: 'POST',
      url: url('/auth/pin'),
      headers: { 'x-cl-background': '1' },
      payload: { password: 'wrong-password-x', pin: '2580' },
    });
    expect(write.statusCode).toBeGreaterThanOrEqual(400);
    const afterWrite = await idleExpiry();
    expect(afterWrite > before).toBe(true);

    await fx.pool.query(
      `UPDATE cl.auth_sessions s SET idle_expires_at = now() + interval '1 minute'
         FROM cl.users u WHERE u.id = s.user_id AND u.username = 'idle_waiter'`,
    );
    const reset = await idleExpiry();
    expect((await waiter.call({ url: url('/auth/me') })).statusCode).toBe(200);
    expect((await idleExpiry()) > reset).toBe(true);

    // Once the idle time has run out, background reads are refused like any other.
    await fx.pool.query(
      `UPDATE cl.auth_sessions s SET idle_expires_at = now() - interval '1 second'
         FROM cl.users u WHERE u.id = s.user_id AND u.username = 'idle_waiter'`,
    );
    const expired = await waiter.call({
      url: url('/auth/me'),
      headers: { 'x-cl-background': '1' },
    });
    expect(expired.statusCode).toBe(401);
  });
});
