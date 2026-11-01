import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDate } from '@cl/shared';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let ownerId: string;
let deviceId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const owner = await db.client.query<{ id: string }>(
    `INSERT INTO cl.users (username, display_name, password_hash, is_owner)
     VALUES ('owner', 'Owner', 'x', true) RETURNING id::text`,
  );
  ownerId = owner.rows[0]?.id ?? '';
  const device = await db.client.query<{ id: string }>(
    `INSERT INTO cl.devices (name, kind, ownership, token_hash, registered_by)
     VALUES ('Counter PC', 'reception', 'shop', $1, $2) RETURNING id::text`,
    [randomBytes(32), ownerId],
  );
  deviceId = device.rows[0]?.id ?? '';
});

afterAll(async () => {
  await db.drop();
});

/** Postgres SQLSTATE codes used below. */
const RESTRICT = '23001';
const CHECK = '23514';
const NO_PRIVILEGE = '42501';

async function addUser(username: string, isOwner = false): Promise<string> {
  const { rows } = await db.client.query<{ id: string }>(
    `INSERT INTO cl.users (username, display_name, password_hash, is_owner)
     VALUES ($1, $1, 'x', $2) RETURNING id::text`,
    [username, isOwner],
  );
  return rows[0]?.id ?? '';
}

async function insertAudit(): Promise<string> {
  const { rows } = await db.client.query<{ id: string }>(
    `INSERT INTO cl.audit_events (actor_kind, actor_user_id, action, entity_type, correlation_id)
     VALUES ('user', $1, 'test.action', 'test', $2) RETURNING id::text`,
    [ownerId, randomUUID()],
  );
  return rows[0]?.id ?? '';
}

describe('business date: SQL agrees with packages/shared (AT-44)', () => {
  const instants: string[] = [];
  for (let h = 0; h < 24; h += 1) instants.push(`2026-10-19T${String(h).padStart(2, '0')}:00:00Z`);
  instants.push('2026-10-19T22:59:59Z', '2026-10-19T23:00:00Z', '2026-12-31T20:00:00Z');
  // Europe/London changes clocks on 25 Oct 2026: check a zone with daylight saving too.
  const zones: [string, string][] = [
    ['Asia/Karachi', '04:00'],
    ['Asia/Karachi', '00:00'],
    ['Europe/London', '04:00'],
  ];

  it.each(zones)('%s with cutoff %s', async (zone, cutoff) => {
    const dst = ['2026-10-24T23:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T03:30:00Z'];
    for (const instant of [...instants, ...dst]) {
      const { rows } = await db.client.query<{ d: string }>(
        'SELECT cl.business_date($1::timestamptz, $2, $3::time)::text AS d',
        [instant, zone, cutoff],
      );
      expect(rows[0]?.d, `${instant} ${zone} ${cutoff}`).toBe(
        businessDate(new Date(instant), zone, cutoff),
      );
    }
  });
});

describe('append-only tables (AT-96, DATABASE.md §12)', () => {
  it('rejects UPDATE and DELETE on audit_events, even for the owner of the table', async () => {
    const id = await insertAudit();
    await expect(
      db.client.query(`UPDATE cl.audit_events SET reason = 'edited' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: RESTRICT });
    await expect(
      db.client.query('DELETE FROM cl.audit_events WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: RESTRICT });
  });

  it('rejects UPDATE and DELETE on step_up_approvals', async () => {
    const approver = await addUser('approver_a');
    const { rows } = await db.client.query<{ id: string }>(
      `INSERT INTO cl.step_up_approvals (action, requested_by, approved_by, device_id, entity_type, entity_id, reason)
       VALUES ('discount.over_limit', $1, $2, $3, 'invoice', 1, 'regular guest') RETURNING id::text`,
      [ownerId, approver, deviceId],
    );
    const id = rows[0]?.id;
    await expect(
      db.client.query(`UPDATE cl.step_up_approvals SET reason = 'x' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: RESTRICT });
    await expect(
      db.client.query('DELETE FROM cl.step_up_approvals WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: RESTRICT });
  });
});

describe('application role privileges (DATABASE.md §12)', () => {
  it('cl_app may insert audit events but may not update, delete or truncate them', async () => {
    const id = await insertAudit();
    await db.client.query('SET ROLE cl_app');
    try {
      await db.client.query(
        `INSERT INTO cl.audit_events (actor_kind, action, entity_type, correlation_id)
         VALUES ('system', 'test.as_app', 'test', $1)`,
        [randomUUID()],
      );
      await expect(
        db.client.query(`UPDATE cl.audit_events SET reason = 'x' WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: NO_PRIVILEGE });
      await expect(
        db.client.query('DELETE FROM cl.audit_events WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: NO_PRIVILEGE });
      await expect(db.client.query('TRUNCATE cl.audit_events')).rejects.toMatchObject({
        code: NO_PRIVILEGE,
      });
      await expect(
        db.client.query('DELETE FROM cl.users WHERE id = $1', [ownerId]),
      ).rejects.toMatchObject({ code: NO_PRIVILEGE });
    } finally {
      await db.client.query('RESET ROLE');
    }
  });

  it('cl_readonly can read but not write', async () => {
    await db.client.query('SET ROLE cl_readonly');
    try {
      await db.client.query('SELECT count(*) FROM cl.users');
      await expect(
        db.client.query(`INSERT INTO cl.system_settings (key, value) VALUES ('x', '1')`),
      ).rejects.toMatchObject({ code: NO_PRIVILEGE });
    } finally {
      await db.client.query('RESET ROLE');
    }
  });
});

describe('row versioning (touch_row)', () => {
  it('bumps version and updated_at on every update', async () => {
    const before = await db.client.query<{ version: number; updated_at: Date }>(
      `SELECT version, updated_at FROM cl.system_settings WHERE key = 'orders.escalation_minutes'`,
    );
    await db.client.query(
      `UPDATE cl.system_settings SET value = '4' WHERE key = 'orders.escalation_minutes'`,
    );
    const after = await db.client.query<{ version: number; updated_at: Date }>(
      `SELECT version, updated_at FROM cl.system_settings WHERE key = 'orders.escalation_minutes'`,
    );
    expect(after.rows[0]?.version).toBe((before.rows[0]?.version ?? 0) + 1);
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]?.updated_at.getTime() ?? Infinity,
    );
  });
});

describe('at least one active owner (AT-39, database part)', () => {
  it('refuses to disable or demote the last active owner', async () => {
    await expect(
      db.client.query(`UPDATE cl.users SET status = 'disabled' WHERE id = $1`, [ownerId]),
    ).rejects.toMatchObject({ code: CHECK });
    await expect(
      db.client.query('UPDATE cl.users SET is_owner = false WHERE id = $1', [ownerId]),
    ).rejects.toMatchObject({ code: CHECK });
  });

  it('allows it once another active owner exists', async () => {
    const second = await addUser('second_owner', true);
    await db.client.query(`UPDATE cl.users SET status = 'disabled' WHERE id = $1`, [second]);
    const { rows } = await db.client.query<{ status: string }>(
      'SELECT status FROM cl.users WHERE id = $1',
      [second],
    );
    expect(rows[0]?.status).toBe('disabled');
  });

  it('refuses a first user who is not an owner', async () => {
    const empty = await createTestDatabase();
    try {
      await expect(
        empty.client.query(
          `INSERT INTO cl.users (username, display_name, password_hash) VALUES ('w', 'W', 'x')`,
        ),
      ).rejects.toMatchObject({ code: CHECK });
    } finally {
      await empty.drop();
    }
  });
});

describe('grant rules (RBAC.md §1)', () => {
  it('lets the owner give any permission to any role or person (0032)', async () => {
    await db.client.query(
      `INSERT INTO cl.role_permissions (role_id, permission_key)
       SELECT id, 'ledger.read' FROM cl.roles WHERE key = 'kitchen'`,
    );
    await db.client.query(
      `INSERT INTO cl.role_permissions (role_id, permission_key)
       SELECT id, 'backup.restore' FROM cl.roles WHERE key = 'manager'`,
    );
    const waiter = await addUser('waiter_one');
    await db.client.query(
      `INSERT INTO cl.user_permission_overrides (user_id, permission_key, effect, reason, granted_by)
       VALUES ($1, 'roles.manage', 'grant', 'test', $2)
       ON CONFLICT (user_id, permission_key) DO NOTHING`,
      [waiter, ownerId],
    );
    await db.client.query(`DELETE FROM cl.user_permission_overrides WHERE user_id = $1`, [waiter]);
    // A deny override for a non-owner is fine; a grant to an owner is fine.
    await db.client.query(
      `INSERT INTO cl.user_permission_overrides (user_id, permission_key, effect, reason, granted_by)
       VALUES ($1, 'roles.manage', 'deny', 'test', $2)`,
      [waiter, ownerId],
    );
  });

  it('allows a grantable (○) permission to be granted later', async () => {
    await db.client.query(
      `INSERT INTO cl.role_permissions (role_id, permission_key)
       SELECT id, 'menu.manage' FROM cl.roles WHERE key = 'manager'`,
    );
  });
});

describe('constraints', () => {
  it('keeps device status and revocation time consistent', async () => {
    await expect(
      db.client.query(`UPDATE cl.devices SET status = 'revoked' WHERE id = $1`, [deviceId]),
    ).rejects.toMatchObject({ code: CHECK });
  });

  it('refuses a step-up approved by the requester', async () => {
    await expect(
      db.client.query(
        `INSERT INTO cl.step_up_approvals (action, requested_by, approved_by, device_id, entity_type, entity_id, reason)
         VALUES ('refund.approve', $1, $1, $2, 'invoice', 1, 'self')`,
        [ownerId, deviceId],
      ),
    ).rejects.toMatchObject({ code: CHECK });
  });

  it('requires a user for user-actor audit events and none for system events', async () => {
    await expect(
      db.client.query(
        `INSERT INTO cl.audit_events (actor_kind, action, entity_type, correlation_id)
         VALUES ('user', 'x', 'test', $1)`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: CHECK });
  });

  it('validates permission key format and non-empty outbox topics', async () => {
    await expect(
      db.client.query(
        `INSERT INTO cl.permissions (key, module, description) VALUES ('Bad Key', 'x', 'x')`,
      ),
    ).rejects.toMatchObject({ code: CHECK });
    await expect(
      db.client.query(
        `INSERT INTO cl.outbox_events (topics, event_type, entity_type, entity_id)
         VALUES ('{}', 'x', 'x', 1)`,
      ),
    ).rejects.toMatchObject({ code: CHECK });
  });

  it('treats usernames case-insensitively', async () => {
    await addUser('Sara');
    await expect(addUser('sara')).rejects.toMatchObject({ code: '23505' });
  });
});
