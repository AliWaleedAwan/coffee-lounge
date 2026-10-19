/**
 * Identity and access (RBAC.md, SECURITY.md §2.2, API.md §4): owner bootstrap and
 * recovery, device registration, password/PIN login with lockouts, sessions, step-up
 * approvals, user and permission administration. Every change is audited.
 */
import type pg from 'pg';
import { writeAudit, type Actor } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { loadEffectivePermissions, type EffectivePermissions } from './permissions.ts';
import {
  hashSecret,
  hashToken,
  newRecoveryCode,
  newRegistrationCode,
  newToken,
  passwordProblem,
  pinProblem,
  verifyAgainstDummy,
  verifySecret,
} from './secrets.ts';

// ---------------------------------------------------------------- policy (RBAC.md §4)
export const DEVICE_KINDS = ['waiter', 'reception', 'manager', 'inventory', 'kitchen'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

const MINUTE = 60_000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * MINUTE;
export const SESSION_IDLE_MS: Record<DeviceKind, number> = {
  reception: 10 * MINUTE, // counter PC: auto-lock to PIN after 10 min
  inventory: 10 * MINUTE,
  waiter: 5 * MINUTE, // tablets and phones: 5 min
  manager: 5 * MINUTE,
  kitchen: 12 * 60 * MINUTE, // device-bound kitchen screen (inactive while D-33 holds)
};
export const REGISTRATION_CODE_TTL_MS = 10 * MINUTE;
export const STEP_UP_TTL_MS = 2 * MINUTE;
const MAX_FAILURES = 5;

/** Lock minutes after `failures` consecutive failures: 5, then doubling every 5 more, max 60. */
export function lockMinutes(failures: number): number {
  if (failures < MAX_FAILURES) return 0;
  return Math.min(60, 5 * 2 ** Math.floor((failures - MAX_FAILURES) / MAX_FAILURES));
}

/** Who may approve which step-up action (RBAC.md §1.4). */
export const STEP_UP_ACTIONS = {
  'discount.over_limit': 'discounts.apply',
  'refund.approve': 'payments.refund',
  'payment.correct': 'payments.refund',
  'invoice.reopen_with_payments': 'invoices.reopen',
  'shift.variance': 'cash_shifts.approve_variance',
  'count.variance': 'inventory.count_approve',
  'line.void_prepared': 'orders.void_prepared',
} as const;
export type StepUpAction = keyof typeof STEP_UP_ACTIONS;

// ---------------------------------------------------------------- types
export interface DeviceInfo {
  id: string;
  name: string;
  kind: DeviceKind;
  ownership: 'shop' | 'personal';
  status: 'active' | 'revoked';
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  isOwner: boolean;
  mustChangePassword: boolean;
}

export interface AuthContext {
  user: AuthUser;
  device: DeviceInfo;
  sessionId: string;
  permissions: EffectivePermissions;
}

/** Request facts needed for auditing. */
export interface RequestFacts {
  correlationId: string;
  ip?: string;
}

const userActor = (auth: Pick<AuthContext, 'user' | 'device'>): Actor => ({
  kind: 'user',
  userId: auth.user.id,
  deviceId: auth.device.id,
});
const SYSTEM: Actor = { kind: 'system' };

function audit(
  db: Queryable,
  actor: Actor,
  facts: RequestFacts,
  entry: Parameters<typeof writeAudit>[2],
) {
  return writeAudit(
    db,
    { actor, correlationId: facts.correlationId, ...(facts.ip ? { ip: facts.ip } : {}) },
    entry,
  );
}

function pgCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

/** Turns database rule violations into clear API errors. */
function translateDbError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (pgCode(error) === '23514' && message.includes('active owner')) {
    throw new AppError('VALIDATION_FAILED', 'At least one active owner must remain');
  }
  if (pgCode(error) === '23514' && message.includes('owner-only')) {
    throw new AppError('FORBIDDEN', 'This permission is owner-only and cannot be granted');
  }
  if (pgCode(error) === '23514' && message.includes('may not be granted')) {
    throw new AppError('FORBIDDEN', 'This permission can never be granted to this role');
  }
  if (pgCode(error) === '23505') {
    throw new AppError('VALIDATION_FAILED', 'That value is already in use');
  }
  throw error;
}

// ---------------------------------------------------------------- owner bootstrap & recovery
export async function createOwner(
  pool: pg.Pool,
  input: { username: string; displayName: string; password: string },
  facts: RequestFacts,
): Promise<{ userId: string; recoveryCode: string }> {
  const problem = passwordProblem(input.password);
  if (problem) throw new AppError('VALIDATION_FAILED', problem);
  const passwordHash = await hashSecret(input.password);
  const recoveryCode = newRecoveryCode();
  const recoveryHash = await hashSecret(recoveryCode);
  const userId = await withTransaction(pool, async (tx) => {
    const { rows: existing } = await tx.query('SELECT 1 FROM cl.users LIMIT 1');
    if (existing.length > 0) throw new AppError('VALIDATION_FAILED', 'Users already exist');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cl.users (username, display_name, password_hash, is_owner, must_change_password)
       VALUES ($1, $2, $3, true, false) RETURNING id::text`,
      [input.username, input.displayName, passwordHash],
    );
    const id = rows[0]?.id ?? '';
    await tx.query(
      `INSERT INTO cl.user_roles (user_id, role_id) SELECT $1, id FROM cl.roles WHERE key = 'owner'`,
      [id],
    );
    await tx.query('INSERT INTO cl.owner_recovery_codes (code_hash) VALUES ($1)', [recoveryHash]);
    await audit(tx, SYSTEM, facts, {
      action: 'owner.create',
      entityType: 'user',
      entityId: id,
      after: { username: input.username },
    });
    return id;
  });
  return { userId, recoveryCode };
}

export async function recoverOwner(
  pool: pg.Pool,
  input: { username: string; recoveryCode: string; newPassword: string },
  facts: RequestFacts,
): Promise<{ recoveryCode: string }> {
  const problem = passwordProblem(input.newPassword);
  if (problem) throw new AppError('VALIDATION_FAILED', problem);
  const { rows: codes } = await pool.query<{ id: string; code_hash: string }>(
    'SELECT id::text, code_hash FROM cl.owner_recovery_codes WHERE used_at IS NULL',
  );
  const active = codes[0];
  if (!active || !(await verifySecret(input.recoveryCode.trim().toUpperCase(), active.code_hash))) {
    await audit(pool, SYSTEM, facts, { action: 'owner.recovery_failed', entityType: 'user' });
    throw new AppError('UNAUTHENTICATED', 'Recovery code is not valid');
  }
  const nextCode = newRecoveryCode();
  const [passwordHash, nextHash] = await Promise.all([
    hashSecret(input.newPassword),
    hashSecret(nextCode),
  ]);
  await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE cl.users SET password_hash = $2, failed_attempts = 0, locked_until = NULL,
              must_change_password = false, status = 'active'
        WHERE lower(username) = lower($1) AND is_owner RETURNING id::text`,
      [input.username, passwordHash],
    );
    const id = rows[0]?.id;
    if (!id) throw new AppError('NOT_FOUND', 'No owner with that username');
    const used = await tx.query(
      'UPDATE cl.owner_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL',
      [active.id],
    );
    if (used.rowCount !== 1)
      throw new AppError('UNAUTHENTICATED', 'Recovery code was already used');
    await tx.query('INSERT INTO cl.owner_recovery_codes (code_hash) VALUES ($1)', [nextHash]);
    await tx.query(
      `UPDATE cl.auth_sessions SET revoked_at = now(), revoke_reason = 'owner_recovery'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
    await audit(tx, SYSTEM, facts, { action: 'owner.recovered', entityType: 'user', entityId: id });
  });
  return { recoveryCode: nextCode };
}

// ---------------------------------------------------------------- devices
export async function createRegistrationCode(
  db: Queryable,
  createdBy: { actor: Actor; userId: string },
  input: { deviceName: string; kind: DeviceKind; ownership: 'shop' | 'personal' },
  facts: RequestFacts,
): Promise<{ code: string; expiresAt: Date }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newRegistrationCode();
    try {
      const { rows } = await db.query<{ id: string; expires_at: Date }>(
        `INSERT INTO cl.device_registration_codes (code_hash, device_name, kind, ownership, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) RETURNING id::text, expires_at`,
        [
          hashToken(code),
          input.deviceName,
          input.kind,
          input.ownership,
          createdBy.userId,
          REGISTRATION_CODE_TTL_MS / 1000,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('registration code insert returned nothing');
      await audit(db, createdBy.actor, facts, {
        action: 'device.registration_code',
        entityType: 'device_registration_code',
        entityId: row.id,
        after: input,
      });
      return { code, expiresAt: row.expires_at };
    } catch (error) {
      if (pgCode(error) !== '23505') throw error; // retry only on a code collision
    }
  }
  throw new Error('could not create a unique registration code');
}

export async function registerDevice(
  pool: pg.Pool,
  code: string,
  facts: RequestFacts,
): Promise<{ token: string; device: DeviceInfo }> {
  const { token, hash } = newToken();
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      device_name: string;
      kind: DeviceKind;
      ownership: 'shop' | 'personal';
      created_by: string | null;
      valid: boolean;
    }>(
      `SELECT id::text, device_name, kind, ownership, created_by::text,
              (used_at IS NULL AND expires_at > now()) AS valid
         FROM cl.device_registration_codes WHERE code_hash = $1 FOR UPDATE`,
      [hashToken(code)],
    );
    const row = rows[0];
    if (!row?.valid || row.created_by === null) {
      throw new AppError('VALIDATION_FAILED', 'Registration code is not valid or has expired');
    }
    const { rows: devices } = await tx.query<{ id: string }>(
      `INSERT INTO cl.devices (name, kind, ownership, token_hash, registered_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
      [row.device_name, row.kind, row.ownership, hash, row.created_by],
    );
    const deviceId = devices[0]?.id ?? '';
    await tx.query(
      'UPDATE cl.device_registration_codes SET used_at = now(), device_id = $2 WHERE id = $1',
      [row.id, deviceId],
    );
    await audit(tx, SYSTEM, facts, {
      action: 'device.register',
      entityType: 'device',
      entityId: deviceId,
      after: { name: row.device_name, kind: row.kind, ownership: row.ownership },
    });
    return {
      token,
      device: {
        id: deviceId,
        name: row.device_name,
        kind: row.kind,
        ownership: row.ownership,
        status: 'active',
      },
    };
  });
}

export async function deviceForToken(db: Queryable, token: string): Promise<DeviceInfo | null> {
  const { rows } = await db.query<DeviceInfo>(
    `UPDATE cl.devices SET last_seen_at = now()
      WHERE token_hash = $1 AND status = 'active'
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')
      RETURNING id::text, name, kind, ownership, status`,
    [hashToken(token)],
  );
  if (rows[0]) return rows[0];
  const { rows: current } = await db.query<DeviceInfo>(
    `SELECT id::text, name, kind, ownership, status FROM cl.devices WHERE token_hash = $1 AND status = 'active'`,
    [hashToken(token)],
  );
  return current[0] ?? null;
}

export async function listDevices(
  db: Queryable,
): Promise<(DeviceInfo & { lastSeenAt: Date | null })[]> {
  const { rows } = await db.query<DeviceInfo & { lastSeenAt: Date | null }>(
    `SELECT id::text, name, kind, ownership, status, last_seen_at AS "lastSeenAt"
       FROM cl.devices ORDER BY status, name`,
  );
  return rows;
}

export async function revokeDevice(
  pool: pg.Pool,
  auth: AuthContext,
  deviceId: string,
  facts: RequestFacts,
): Promise<DeviceInfo> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<DeviceInfo>(
      `UPDATE cl.devices SET status = 'revoked', revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND status = 'active'
        RETURNING id::text, name, kind, ownership, status`,
      [deviceId, auth.user.id],
    );
    const device = rows[0];
    if (!device) throw new AppError('NOT_FOUND', 'No active device with that id');
    await tx.query(
      `UPDATE cl.auth_sessions SET revoked_at = now(), revoke_reason = 'device_revoked'
        WHERE device_id = $1 AND revoked_at IS NULL`,
      [deviceId],
    );
    await audit(tx, userActor(auth), facts, {
      action: 'device.revoke',
      entityType: 'device',
      entityId: deviceId,
    });
    return device;
  });
}

// ---------------------------------------------------------------- login, PIN switch, sessions
interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  pin_hash: string | null;
  is_owner: boolean;
  status: string;
  must_change_password: boolean;
  failed_attempts: number;
  locked_seconds: number;
}

async function lockUser(
  tx: Tx,
  where: { username: string } | { id: string },
): Promise<UserRow | undefined> {
  const byName = 'username' in where;
  const { rows } = await tx.query<UserRow>(
    `SELECT id::text, username, display_name, password_hash, pin_hash, is_owner, status,
            must_change_password, failed_attempts,
            GREATEST(0, EXTRACT(EPOCH FROM (locked_until - now())))::int AS locked_seconds
       FROM cl.users WHERE ${byName ? 'lower(username) = lower($1)' : 'id = $1'} FOR UPDATE`,
    [byName ? where.username : where.id],
  );
  return rows[0];
}

type CheckOutcome = { ok: true; user: UserRow } | { ok: false; error: AppError };

const BAD_LOGIN = (): AppError =>
  new AppError('UNAUTHENTICATED', 'Username or password is incorrect');
const locked = (seconds: number): AppError =>
  new AppError('UNAUTHENTICATED', 'Too many failed attempts. Try again later.', {
    retryAfterSeconds: seconds,
  });

/**
 * Verifies a password or PIN inside the transaction, recording failures and lockouts.
 * Never throws for a wrong secret: the failure must be committed, so the caller
 * throws after the transaction ends.
 */
async function checkSecret(
  tx: Tx,
  user: UserRow | undefined,
  secret: string,
  kind: 'password' | 'pin',
  facts: RequestFacts,
): Promise<CheckOutcome> {
  if (!user || user.status !== 'active' || (kind === 'pin' && user.pin_hash === null)) {
    await verifyAgainstDummy(secret);
    return { ok: false, error: BAD_LOGIN() };
  }
  if (user.locked_seconds > 0) return { ok: false, error: locked(user.locked_seconds) };
  const hash = kind === 'password' ? user.password_hash : (user.pin_hash ?? '');
  if (await verifySecret(secret, hash)) {
    if (user.failed_attempts > 0) {
      await tx.query('UPDATE cl.users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [
        user.id,
      ]);
    }
    return { ok: true, user };
  }
  const failures = user.failed_attempts + 1;
  const minutes = lockMinutes(failures);
  await tx.query(
    `UPDATE cl.users SET failed_attempts = $2,
            locked_until = CASE WHEN $3::int > 0 THEN now() + make_interval(mins => $3) ELSE locked_until END
      WHERE id = $1`,
    [user.id, failures, minutes],
  );
  await audit(tx, SYSTEM, facts, {
    action: minutes > 0 ? 'auth.locked_out' : 'auth.failed',
    entityType: 'user',
    entityId: user.id,
    after: { kind, failures },
  });
  return { ok: false, error: minutes > 0 ? locked(minutes * 60) : BAD_LOGIN() };
}

async function startSession(
  tx: Tx,
  user: UserRow,
  device: DeviceInfo,
  facts: RequestFacts,
  how: string,
): Promise<string> {
  const { token, hash } = newToken();
  await tx.query(
    `UPDATE cl.auth_sessions SET revoked_at = now(), revoke_reason = 'replaced'
      WHERE device_id = $1 AND revoked_at IS NULL`,
    [device.id],
  );
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.auth_sessions (token_hash, user_id, device_id, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), now() + make_interval(secs => $5))
     RETURNING id::text`,
    [hash, user.id, device.id, SESSION_IDLE_MS[device.kind] / 1000, SESSION_ABSOLUTE_MS / 1000],
  );
  await tx.query('UPDATE cl.users SET last_login_at = now() WHERE id = $1', [user.id]);
  await writeAudit(
    tx,
    {
      actor: { kind: 'user', userId: user.id, deviceId: device.id },
      correlationId: facts.correlationId,
      ...(facts.ip ? { ip: facts.ip } : {}),
    },
    { action: `auth.${how}`, entityType: 'auth_session', entityId: rows[0]?.id ?? '' },
  );
  return token;
}

export async function login(
  pool: pg.Pool,
  device: DeviceInfo,
  input: { username: string; password: string },
  facts: RequestFacts,
): Promise<{ token: string; userId: string }> {
  const outcome = await withTransaction(pool, async (tx) => {
    const check = await checkSecret(
      tx,
      await lockUser(tx, { username: input.username }),
      input.password,
      'password',
      facts,
    );
    if (!check.ok) return check;
    return {
      ok: true as const,
      token: await startSession(tx, check.user, device, facts, 'login'),
      userId: check.user.id,
    };
  });
  if (!outcome.ok) throw outcome.error;
  return { token: outcome.token, userId: outcome.userId };
}

export async function pinSwitch(
  pool: pg.Pool,
  device: DeviceInfo,
  input: { username: string; pin: string },
  facts: RequestFacts,
): Promise<{ token: string; userId: string }> {
  const outcome = await withTransaction(pool, async (tx) => {
    const user = await lockUser(tx, { username: input.username });
    // D-24: owners and users who must still change their first password log in with a password.
    if (user && (user.is_owner || user.must_change_password)) {
      return {
        ok: false as const,
        error: new AppError('UNAUTHENTICATED', 'Use your password to log in'),
      };
    }
    const check = await checkSecret(tx, user, input.pin, 'pin', facts);
    if (!check.ok) return check;
    return {
      ok: true as const,
      token: await startSession(tx, check.user, device, facts, 'pin_switch'),
      userId: check.user.id,
    };
  });
  if (!outcome.ok) throw outcome.error;
  return { token: outcome.token, userId: outcome.userId };
}

/** Resolves a session cookie on a device; null when missing, expired, revoked or mismatched. */
export async function sessionForToken(
  db: Queryable,
  token: string,
  device: DeviceInfo,
): Promise<Omit<AuthContext, 'permissions' | 'device'> | null> {
  const { rows } = await db.query<{
    session_id: string;
    user_id: string;
    username: string;
    display_name: string;
    is_owner: boolean;
    must_change_password: boolean;
  }>(
    `UPDATE cl.auth_sessions s
        SET last_seen_at = now(),
            idle_expires_at = LEAST(now() + make_interval(secs => $3), s.absolute_expires_at)
       FROM cl.users u
      WHERE s.token_hash = $1 AND s.device_id = $2 AND s.revoked_at IS NULL
        AND s.idle_expires_at > now() AND s.absolute_expires_at > now()
        AND u.id = s.user_id AND u.status = 'active'
      RETURNING s.id::text AS session_id, u.id::text AS user_id, u.username, u.display_name,
                u.is_owner, u.must_change_password`,
    [hashToken(token), device.id, SESSION_IDLE_MS[device.kind] / 1000],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      isOwner: row.is_owner,
      mustChangePassword: row.must_change_password,
    },
  };
}

export async function logout(db: Queryable, auth: AuthContext, facts: RequestFacts): Promise<void> {
  await db.query(
    `UPDATE cl.auth_sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`,
    [auth.sessionId],
  );
  await audit(db, userActor(auth), facts, {
    action: 'auth.logout',
    entityType: 'auth_session',
    entityId: auth.sessionId,
  });
}

export async function changePassword(
  pool: pg.Pool,
  auth: AuthContext,
  input: { currentPassword: string; newPassword: string },
  facts: RequestFacts,
): Promise<void> {
  const problem = passwordProblem(input.newPassword);
  if (problem) throw new AppError('VALIDATION_FAILED', problem);
  const newHash = await hashSecret(input.newPassword);
  const outcome = await withTransaction(pool, async (tx) => {
    const check = await checkSecret(
      tx,
      await lockUser(tx, { id: auth.user.id }),
      input.currentPassword,
      'password',
      facts,
    );
    if (!check.ok) return check;
    await tx.query(
      'UPDATE cl.users SET password_hash = $2, must_change_password = false WHERE id = $1',
      [auth.user.id, newHash],
    );
    await audit(tx, userActor(auth), facts, {
      action: 'user.password_change',
      entityType: 'user',
      entityId: auth.user.id,
    });
    return { ok: true as const };
  });
  if (!outcome.ok) throw outcome.error;
}

export async function setOwnPin(
  pool: pg.Pool,
  auth: AuthContext,
  input: { password: string; pin: string },
  facts: RequestFacts,
): Promise<void> {
  const problem = pinProblem(input.pin);
  if (problem) throw new AppError('VALIDATION_FAILED', problem);
  const pinHash = await hashSecret(input.pin);
  const outcome = await withTransaction(pool, async (tx) => {
    const check = await checkSecret(
      tx,
      await lockUser(tx, { id: auth.user.id }),
      input.password,
      'password',
      facts,
    );
    if (!check.ok) return check;
    await tx.query('UPDATE cl.users SET pin_hash = $2 WHERE id = $1', [auth.user.id, pinHash]);
    await audit(tx, userActor(auth), facts, {
      action: 'user.pin_set',
      entityType: 'user',
      entityId: auth.user.id,
    });
    return { ok: true as const };
  });
  if (!outcome.ok) throw outcome.error;
}

// ---------------------------------------------------------------- step-up approvals
export async function createStepUp(
  pool: pg.Pool,
  auth: AuthContext,
  input: {
    action: StepUpAction;
    entityType: string;
    entityId: string;
    approverUsername: string;
    approverPin: string;
    reason: string;
  },
  facts: RequestFacts,
): Promise<{ stepUpId: string; expiresAt: Date }> {
  const outcome = await withTransaction(pool, async (tx) => {
    const approver = await lockUser(tx, { username: input.approverUsername });
    if (approver?.id === auth.user.id) {
      return {
        ok: false as const,
        error: new AppError('FORBIDDEN', 'Another person must approve this'),
      };
    }
    const check = await checkSecret(tx, approver, input.approverPin, 'pin', facts);
    if (!check.ok) return check;
    const permissions = await loadEffectivePermissions(tx, check.user.id);
    if (!permissions.has(STEP_UP_ACTIONS[input.action])) {
      return {
        ok: false as const,
        error: new AppError('FORBIDDEN', 'The approver may not approve this action'),
      };
    }
    const { rows } = await tx.query<{ id: string; expires_at: Date }>(
      `INSERT INTO cl.step_up_approvals (action, requested_by, approved_by, device_id, entity_type, entity_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text, created_at + make_interval(secs => $8) AS expires_at`,
      [
        input.action,
        auth.user.id,
        check.user.id,
        auth.device.id,
        input.entityType,
        input.entityId,
        input.reason,
        STEP_UP_TTL_MS / 1000,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('step-up insert returned nothing');
    await audit(tx, userActor(auth), facts, {
      action: 'stepup.grant',
      entityType: input.entityType,
      entityId: input.entityId,
      after: { action: input.action, stepUpId: row.id },
      reason: input.reason,
      approvedBy: check.user.id,
    });
    return { ok: true as const, stepUpId: row.id, expiresAt: row.expires_at };
  });
  if (!outcome.ok) throw outcome.error;
  return { stepUpId: outcome.stepUpId, expiresAt: outcome.expiresAt };
}

/**
 * Uses a step-up approval inside the protected operation's transaction. It must match
 * the action, entity, requester and device, be under 2 minutes old and unused.
 * Returns the approver's user id.
 */
export async function consumeStepUp(
  tx: Tx,
  auth: Pick<AuthContext, 'user' | 'device'>,
  input: { stepUpId: string; action: StepUpAction; entityType: string; entityId: string },
): Promise<string> {
  const { rows } = await tx.query<{ approved_by: string }>(
    `SELECT approved_by::text FROM cl.step_up_approvals
      WHERE id = $1 AND action = $2 AND entity_type = $3 AND entity_id = $4
        AND requested_by = $5 AND device_id = $6
        AND created_at > now() - make_interval(secs => $7)`,
    [
      input.stepUpId,
      input.action,
      input.entityType,
      input.entityId,
      auth.user.id,
      auth.device.id,
      STEP_UP_TTL_MS / 1000,
    ],
  );
  const approvedBy = rows[0]?.approved_by;
  if (approvedBy === undefined) {
    throw new AppError(
      'STEP_UP_REQUIRED',
      'Approval is missing, expired or for a different action',
    );
  }
  const used = await tx.query(
    'INSERT INTO cl.step_up_uses (step_up_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [input.stepUpId],
  );
  if (used.rowCount !== 1) throw new AppError('STEP_UP_REQUIRED', 'This approval was already used');
  return approvedBy;
}

// ---------------------------------------------------------------- users and permissions
export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  isOwner: boolean;
  status: string;
  roles: string[];
  hasPin: boolean;
}

export async function listUsers(db: Queryable): Promise<UserSummary[]> {
  const { rows } = await db.query<UserSummary>(
    `SELECT u.id::text, u.username, u.display_name AS "displayName", u.is_owner AS "isOwner", u.status,
            COALESCE(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles,
            u.pin_hash IS NOT NULL AS "hasPin"
       FROM cl.users u
       LEFT JOIN cl.user_roles ur ON ur.user_id = u.id
       LEFT JOIN cl.roles r ON r.id = ur.role_id
      GROUP BY u.id ORDER BY u.status, u.display_name`,
  );
  return rows;
}

export async function createUser(
  pool: pg.Pool,
  auth: AuthContext,
  input: {
    username: string;
    displayName: string;
    password: string;
    pin?: string | undefined;
    roles: string[];
  },
  facts: RequestFacts,
): Promise<{ userId: string }> {
  const problem =
    passwordProblem(input.password) ?? (input.pin === undefined ? null : pinProblem(input.pin));
  if (problem) throw new AppError('VALIDATION_FAILED', problem);
  const makesOwner = input.roles.includes('owner');
  if (makesOwner && !auth.user.isOwner)
    throw new AppError('FORBIDDEN', 'Only an owner can create an owner');
  const [passwordHash, pinHash] = await Promise.all([
    hashSecret(input.password),
    input.pin === undefined ? Promise.resolve(null) : hashSecret(input.pin),
  ]);
  try {
    return await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cl.users (username, display_name, password_hash, pin_hash, is_owner, must_change_password)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id::text`,
        [input.username, input.displayName, passwordHash, pinHash, makesOwner],
      );
      const userId = rows[0]?.id ?? '';
      const assigned = await tx.query(
        'INSERT INTO cl.user_roles (user_id, role_id) SELECT $1, id FROM cl.roles WHERE key = ANY($2::text[])',
        [userId, input.roles],
      );
      if (assigned.rowCount !== input.roles.length)
        throw new AppError('VALIDATION_FAILED', 'Unknown role');
      await audit(tx, userActor(auth), facts, {
        action: 'user.create',
        entityType: 'user',
        entityId: userId,
        after: { username: input.username, roles: input.roles },
      });
      return { userId };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    return translateDbError(error);
  }
}

export async function setUserStatus(
  pool: pg.Pool,
  auth: AuthContext,
  userId: string,
  status: 'active' | 'disabled',
  facts: RequestFacts,
): Promise<void> {
  try {
    await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ is_owner: boolean; before: string }>(
        `UPDATE cl.users u SET status = $2 FROM (SELECT status AS before FROM cl.users WHERE id = $1) old
          WHERE u.id = $1 RETURNING u.is_owner, old.before`,
        [userId, status],
      );
      const row = rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'No such user');
      if (row.is_owner && !auth.user.isOwner)
        throw new AppError('FORBIDDEN', 'Only an owner can change an owner');
      if (status === 'disabled') {
        await tx.query(
          `UPDATE cl.auth_sessions SET revoked_at = now(), revoke_reason = 'user_disabled'
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        );
      }
      await audit(tx, userActor(auth), facts, {
        action: 'user.status',
        entityType: 'user',
        entityId: userId,
        before: { status: row.before },
        after: { status },
      });
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    translateDbError(error);
  }
}

export async function setPermissionOverride(
  pool: pg.Pool,
  auth: AuthContext,
  input: { userId: string; permissionKey: string; effect: 'grant' | 'deny'; reason: string },
  facts: RequestFacts,
): Promise<void> {
  try {
    await withTransaction(pool, async (tx) => {
      const { rows: before } = await tx.query<{ effect: string }>(
        'SELECT effect FROM cl.user_permission_overrides WHERE user_id = $1 AND permission_key = $2',
        [input.userId, input.permissionKey],
      );
      await tx.query(
        `INSERT INTO cl.user_permission_overrides (user_id, permission_key, effect, reason, granted_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, permission_key)
         DO UPDATE SET effect = EXCLUDED.effect, reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by`,
        [input.userId, input.permissionKey, input.effect, input.reason, auth.user.id],
      );
      await audit(tx, userActor(auth), facts, {
        action: 'permission.override_set',
        entityType: 'user',
        entityId: input.userId,
        before: before[0] ? { [input.permissionKey]: before[0].effect } : null,
        after: { [input.permissionKey]: input.effect },
        reason: input.reason,
      });
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (pgCode(error) === '23503') throw new AppError('NOT_FOUND', 'Unknown user or permission');
    translateDbError(error);
  }
}

export async function removePermissionOverride(
  pool: pg.Pool,
  auth: AuthContext,
  input: { userId: string; permissionKey: string; reason: string },
  facts: RequestFacts,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ effect: string }>(
      'DELETE FROM cl.user_permission_overrides WHERE user_id = $1 AND permission_key = $2 RETURNING effect',
      [input.userId, input.permissionKey],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND', 'No such override');
    await audit(tx, userActor(auth), facts, {
      action: 'permission.override_remove',
      entityType: 'user',
      entityId: input.userId,
      before: { [input.permissionKey]: rows[0].effect },
      reason: input.reason,
    });
  });
}

/** Records a refused permission check (AT-18: rejected server-side and audited). */
export async function auditAccessDenied(
  db: Queryable,
  auth: AuthContext,
  facts: RequestFacts,
  detail: { permission: string; route: string },
): Promise<void> {
  await audit(db, userActor(auth), facts, {
    action: 'access.denied',
    entityType: 'route',
    after: detail,
  });
}
