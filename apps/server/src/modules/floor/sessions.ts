/**
 * Dining sessions and guest phones (ORDER_STATE_MACHINE.md §1, API.md §4, D-09, D-10).
 *
 * - A session opens when staff open a table (S1) or when a guest first submits an order
 *   (step 3.4 calls `openOrJoinFromQr`). Browsing never opens one (AT-74).
 * - Two guests at an empty table end up in one session (CT-03): the table row is locked
 *   first (DATABASE.md §14) and the partial unique index backs it up.
 * - A phone holds a guest token bound to one session; closing the session or "reset
 *   guests" revokes it (401 VISIT_ENDED, AT-40). Scanning again starts fresh (AT-12).
 * Every session gets its invoice when it opens (S1, step 3.7); it stays open with total 0
 * if the session is cancelled (S8).
 * - Takeaway (S2, step 3.9): every first order from the counter QR opens a session of its
 *   own, so two guests at the counter never see each other's order (AT-75); a cashier
 *   opens one for a guest at the counter.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import { withTransaction, type Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf, readSetting } from '../../platform/settings.ts';
import { z } from 'zod';
import type { Who } from './tables.ts';
import { hashToken, newToken } from './tokens.ts';

const ACTIVE = ['open', 'checkout_requested', 'checkout_locked'] as const;
const ACTIVE_SQL = `status IN ('open','checkout_requested','checkout_locked')`;

export interface SessionRow {
  id: string;
  session_no: string;
  order_type: 'dine_in' | 'takeaway' | 'delivery';
  table_id: string | null;
  status: string;
  guest_count: number | null;
  opened_at: Date;
}

async function sessionChanged(
  tx: Tx,
  s: { id: string; table_id: string | null },
  extraTables: string[] = [],
) {
  const tables = [s.table_id, ...extraTables].filter((t): t is string => t !== null);
  await publish(tx, {
    type: 'session.changed',
    entityType: 'dining_session',
    entityId: s.id,
    topics: ['floor', 'cashier', `session:${s.id}`, ...tables.map((t) => `table:${t}`)],
  });
}

async function nextSessionNo(tx: Tx, businessDate: string): Promise<string> {
  const n = await tx.nextNumber('session', businessDate);
  return `S-${businessDate.replaceAll('-', '')}-${n.padStart(4, '0')}`;
}

/** The table, locked; refuses archived tables and, for QR guests, unavailable ones. */
async function lockOrderableTable(tx: Tx, tableId: string, forGuest: boolean) {
  const rows = await tx.lock<{
    id: string;
    name: string;
    availability: string;
    archived_at: Date | null;
  }>('dining_tables', [tableId]);
  const table = rows[0];
  if (!table || table.archived_at) throw new AppError('NOT_FOUND', 'Table not found');
  if (table.availability !== 'active') {
    throw new AppError(
      'VALIDATION_FAILED',
      forGuest
        ? 'This table is not taking orders right now. Please ask a member of staff.'
        : `This table is marked ${table.availability}. Make it active first.`,
      { availability: table.availability },
    );
  }
  return table;
}

async function activeSessionAt(tx: Tx, tableId: string): Promise<SessionRow | undefined> {
  const { rows } = await tx.query<SessionRow>(
    `SELECT id::text, session_no, order_type, table_id::text, status, guest_count, opened_at
       FROM cl.dining_sessions WHERE table_id = $1 AND ${ACTIVE_SQL} FOR UPDATE`,
    [tableId],
  );
  return rows[0];
}

async function insertSession(
  tx: Tx,
  input: {
    /** null: a takeaway (or, with `orderType`, a delivery). */
    tableId: string | null;
    orderType?: 'takeaway' | 'delivery';
    via: 'qr' | 'staff';
    userId?: string;
    entryPointId?: string;
    guestCount?: number;
    customerName?: string | undefined;
    customerPhone?: string | undefined;
    customerEmail?: string | undefined;
  },
): Promise<SessionRow> {
  const businessDate = await businessDateOf(tx, new Date());
  const { rows } = await tx.query<SessionRow>(
    `INSERT INTO cl.dining_sessions
       (session_no, order_type, table_id, entry_point_id, opened_via, opened_by_user_id, guest_count, business_date,
        customer_name, customer_phone, customer_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id::text, session_no, order_type, table_id::text, status, guest_count, opened_at`,
    [
      await nextSessionNo(tx, businessDate),
      input.tableId === null ? (input.orderType ?? 'takeaway') : 'dine_in',
      input.tableId,
      input.entryPointId ?? null,
      input.via,
      input.userId ?? null,
      input.guestCount ?? null,
      businessDate,
      input.customerName?.trim() || null,
      input.customerPhone?.trim() || null,
      input.customerEmail?.trim() || null,
    ],
  );
  const session = rows[0];
  if (!session) throw new Error('session insert returned nothing');
  await tx.query('INSERT INTO cl.invoices (session_id) VALUES ($1)', [session.id]);
  return session;
}

// ---------------------------------------------------------------- staff

/** S1 by staff: open a dine-in session at a free, active table. */
export async function openTableSession(
  tx: Tx,
  who: Who,
  tableId: string,
  input: { guestCount?: number | undefined },
): Promise<SessionRow> {
  await lockOrderableTable(tx, tableId, false);
  const existing = await activeSessionAt(tx, tableId);
  if (existing) {
    throw new AppError('TABLE_OCCUPIED', `This table already has session ${existing.session_no}`, {
      sessionId: existing.id,
    });
  }
  const session = await insertSession(tx, {
    tableId,
    via: 'staff',
    userId: who.actor.userId,
    ...(input.guestCount ? { guestCount: input.guestCount } : {}),
  });
  await writeAudit(tx, who, {
    action: 'session.open',
    entityType: 'dining_session',
    entityId: session.id,
    after: { tableId },
  });
  await sessionChanged(tx, session);
  return session;
}

/**
 * S2 / S3 by staff: a takeaway for a guest at the counter, or a delivery taken by phone,
 * WhatsApp or in person. Every customer detail is optional (D-05).
 */
export async function openStaffSession(
  tx: Tx,
  who: Who,
  input: {
    orderType: 'takeaway' | 'delivery';
    customerName?: string | undefined;
    customerPhone?: string | undefined;
    customerEmail?: string | undefined;
  },
): Promise<SessionRow> {
  const session = await insertSession(tx, {
    tableId: null,
    orderType: input.orderType,
    via: 'staff',
    userId: who.actor.userId,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerEmail: input.customerEmail,
  });
  await writeAudit(tx, who, {
    action: 'session.open',
    entityType: 'dining_session',
    entityId: session.id,
    after: { orderType: input.orderType },
  });
  await sessionChanged(tx, session);
  return session;
}

/** S2 by staff: a takeaway for a guest at the counter (optional name for calling it out). */
export function openTakeawaySession(
  tx: Tx,
  who: Who,
  input: { customerName?: string | undefined },
): Promise<SessionRow> {
  return openStaffSession(tx, who, { orderType: 'takeaway', ...input });
}

/** S9 (D-10): move a dine-in session to another free, active table. */
export async function transferSession(
  tx: Tx,
  who: Who,
  sessionId: string,
  input: { toTableId: string; reason?: string | undefined },
): Promise<SessionRow> {
  const { rows: found } = await tx.query<{ table_id: string | null }>(
    'SELECT table_id::text FROM cl.dining_sessions WHERE id = $1',
    [sessionId],
  );
  const fromTableId = found[0]?.table_id;
  if (found.length === 0) throw new AppError('NOT_FOUND', 'Session not found');
  if (!fromTableId)
    throw new AppError('VALIDATION_FAILED', 'Only a dine-in session sits at a table');
  if (fromTableId === input.toTableId)
    throw new AppError('VALIDATION_FAILED', 'The session is already at that table');

  // Both tables in ascending id order, then the sessions (DATABASE.md §14).
  const tables = await tx.lock<{ id: string; availability: string; archived_at: Date | null }>(
    'dining_tables',
    [fromTableId, input.toTableId],
  );
  const target = tables.find((t) => t.id === input.toTableId);
  if (!target || target.archived_at) throw new AppError('NOT_FOUND', 'Target table not found');
  if (target.availability !== 'active') {
    throw new AppError('VALIDATION_FAILED', `That table is marked ${target.availability}`);
  }
  const session = await activeSessionAt(tx, fromTableId);
  if (session?.id !== sessionId) {
    throw new AppError(
      'STALE_STATE',
      'This session is no longer open at that table. Reload the floor.',
    );
  }
  const occupant = await activeSessionAt(tx, input.toTableId);
  if (occupant) {
    throw new AppError('TABLE_OCCUPIED', `That table already has session ${occupant.session_no}`, {
      sessionId: occupant.id,
    });
  }
  const { rows } = await tx.query<SessionRow>(
    `UPDATE cl.dining_sessions SET table_id = $2 WHERE id = $1
     RETURNING id::text, session_no, order_type, table_id::text, status, guest_count, opened_at`,
    [sessionId, input.toTableId],
  );
  await tx.query(
    'INSERT INTO cl.session_table_moves (session_id, from_table_id, to_table_id, moved_by, reason) VALUES ($1, $2, $3, $4, $5)',
    [sessionId, fromTableId, input.toTableId, who.actor.userId, input.reason ?? null],
  );
  await writeAudit(tx, who, {
    action: 'session.transfer',
    entityType: 'dining_session',
    entityId: sessionId,
    before: { tableId: fromTableId },
    after: { tableId: input.toTableId },
    ...(input.reason ? { reason: input.reason } : {}),
  });
  const moved = rows[0];
  if (!moved) throw new Error('transfer update returned nothing');
  await sessionChanged(tx, moved, [fromTableId]);
  return moved;
}

/** The session, locked, if it is active; its table id for scope checks. */
export async function lockActiveSession(tx: Tx, sessionId: string): Promise<SessionRow> {
  const { rows } = await tx.query<{ table_id: string | null }>(
    'SELECT table_id::text FROM cl.dining_sessions WHERE id = $1',
    [sessionId],
  );
  if (rows.length === 0) throw new AppError('NOT_FOUND', 'Session not found');
  const tableId = rows[0]?.table_id ?? null;
  if (tableId) await tx.lock('dining_tables', [tableId]);
  const { rows: locked } = await tx.query<SessionRow>(
    `SELECT id::text, session_no, order_type, table_id::text, status, guest_count, opened_at
       FROM cl.dining_sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  const session = locked[0];
  if (!session) throw new AppError('NOT_FOUND', 'Session not found');
  if (!(ACTIVE as readonly string[]).includes(session.status)) {
    throw new AppError('STALE_STATE', 'This session is already closed', { status: session.status });
  }
  return session;
}

async function revokeTokens(
  tx: Tx,
  sessionId: string,
  reason: 'session_closed' | 'staff_reset',
): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE cl.session_guest_tokens SET revoked_at = now(), revoke_reason = $2
      WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  return rowCount ?? 0;
}

/** Revoke every guest phone of the session; the next scan joins as a new phone (D-09). */
export async function resetGuests(
  tx: Tx,
  who: Who,
  session: SessionRow,
): Promise<{ revoked: number }> {
  const revoked = await revokeTokens(tx, session.id, 'staff_reset');
  await writeAudit(tx, who, {
    action: 'session.reset_guests',
    entityType: 'dining_session',
    entityId: session.id,
    after: { revoked },
  });
  await sessionChanged(tx, session);
  return { revoked };
}

/** S8: close a session with nothing billable (rounds arrive in step 3.4). */
export async function cancelSession(
  tx: Tx,
  who: Who,
  session: SessionRow,
  reason: string,
): Promise<void> {
  if (session.status !== 'open') {
    throw new AppError('STALE_STATE', 'Only an open session can be cancelled', {
      status: session.status,
    });
  }
  const { rows: billable } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cl.order_lines l JOIN cl.order_rounds r ON r.id = l.round_id
      WHERE l.session_id = $1 AND r.status = 'accepted'
        AND l.qty - l.qty_cancelled_unprepared - l.qty_cancelled_prepared > 0`,
    [session.id],
  );
  if ((billable[0]?.n ?? 0) > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Items were already accepted for this table. Cancel them first, or take payment.',
    );
  }
  const { rows: pending } = await tx.query<{ id: string }>(
    `UPDATE cl.order_rounds SET status = 'cancelled', decided_at = now(), decided_by = $2
      WHERE session_id = $1 AND status = 'pending_approval' RETURNING id::text`,
    [session.id, who.actor.userId],
  );
  for (const r of pending) {
    await tx.query(
      `INSERT INTO cl.order_events (round_id, event_type, actor_kind, actor_user_id, reason, event_key, correlation_id)
       VALUES ($1, 'round_cancelled', 'user', $2, $3, $4, $5)`,
      [
        r.id,
        who.actor.userId,
        reason,
        `round_cancelled:session_cancel:${session.id}:${r.id}`,
        who.correlationId,
      ],
    );
  }
  await tx.query(
    `UPDATE cl.dining_sessions SET status = 'cancelled', closed_at = now(), close_reason = $2 WHERE id = $1`,
    [session.id, reason],
  );
  await revokeTokens(tx, session.id, 'session_closed');
  await tx.query(
    `UPDATE cl.operational_alerts SET state = 'resolved', resolved_at = now(), resolved_by = $2
      WHERE kind = 'stale_session' AND entity_type = 'dining_session' AND entity_id = $1 AND state <> 'resolved'`,
    [session.id, who.actor.userId],
  );
  await writeAudit(tx, who, {
    action: 'session.cancel',
    entityType: 'dining_session',
    entityId: session.id,
    reason,
  });
  await sessionChanged(tx, session);
}

// ---------------------------------------------------------------- checkout (step 3.7)

/** S5 / S6: the bill was prepared (locked) or reopened. The caller holds the session lock. */
export async function setCheckoutLocked(
  tx: Tx,
  session: SessionRow,
  locked: boolean,
): Promise<void> {
  await tx.query(
    locked
      ? `UPDATE cl.dining_sessions SET status = 'checkout_locked', locked_at = now() WHERE id = $1`
      : `UPDATE cl.dining_sessions SET status = 'open', locked_at = NULL WHERE id = $1`,
    [session.id],
  );
  await sessionChanged(tx, session);
}

/**
 * S7: the last payment settled the bill. The visit ends: guest phones are signed out
 * (VISIT_ENDED) and the table is free for the next guests.
 */
export async function settleSession(tx: Tx, who: Who, session: SessionRow): Promise<void> {
  await tx.query(
    `UPDATE cl.dining_sessions SET status = 'settled', closed_at = now(), close_reason = 'settled' WHERE id = $1`,
    [session.id],
  );
  await revokeTokens(tx, session.id, 'session_closed');
  await tx.query(
    `UPDATE cl.operational_alerts SET state = 'resolved', resolved_at = now(), resolved_by = $2
      WHERE kind = 'stale_session' AND entity_type = 'dining_session' AND entity_id = $1 AND state <> 'resolved'`,
    [session.id, who.actor.userId],
  );
  await sessionChanged(tx, session);
}

/**
 * R6 → S8 by the system: an unpaid counter-QR takeaway whose order expired (D-40). The
 * caller holds the session lock and has checked nothing is billable.
 */
export async function expireSession(tx: Tx, session: SessionRow, reason: string): Promise<void> {
  await tx.query(
    `UPDATE cl.dining_sessions SET status = 'cancelled', closed_at = now(), close_reason = $2 WHERE id = $1`,
    [session.id, reason],
  );
  await revokeTokens(tx, session.id, 'session_closed');
  await writeAudit(
    tx,
    { actor: { kind: 'system' }, correlationId: randomUUID() },
    { action: 'session.expire', entityType: 'dining_session', entityId: session.id, reason },
  );
  await sessionChanged(tx, session);
}

export async function listActiveSessions(db: Queryable) {
  const { rows } = await db.query<SessionRow & { table_code: string | null; guests: number }>(
    `SELECT s.id::text, s.session_no, s.order_type, s.table_id::text, s.status, s.guest_count, s.opened_at,
            t.code AS table_code,
            (SELECT count(*)::int FROM cl.session_guest_tokens g WHERE g.session_id = s.id AND g.revoked_at IS NULL) AS guests
       FROM cl.dining_sessions s LEFT JOIN cl.dining_tables t ON t.id = s.table_id
      WHERE s.${ACTIVE_SQL} ORDER BY s.opened_at`,
  );
  return rows.map(sessionView);
}

export function sessionView(r: SessionRow & { table_code?: string | null; guests?: number }) {
  return {
    id: r.id,
    sessionNo: r.session_no,
    orderType: r.order_type,
    tableId: r.table_id,
    ...(r.table_code !== undefined ? { tableCode: r.table_code } : {}),
    status: r.status,
    guestCount: r.guest_count,
    openedAt: r.opened_at.toISOString(),
    ...(r.guests !== undefined ? { guestPhones: r.guests } : {}),
  };
}

// ---------------------------------------------------------------- guests

export interface EntryPoint {
  id: string;
  kind: 'table' | 'counter_takeaway';
  tableId: string | null;
}

async function issueGuestToken(
  tx: Tx,
  sessionId: string,
  entryPointId: string,
): Promise<{ token: string; tokenId: string }> {
  const { token, hash } = newToken();
  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO cl.session_guest_tokens (session_id, entry_point_id, token_hash) VALUES ($1, $2, $3) RETURNING id::text',
    [sessionId, entryPointId, hash],
  );
  return { token, tokenId: rows[0]?.id ?? '' };
}

/**
 * On scan (GET /entry): if the table already has a session, this phone joins it (D-09)
 * and gets a guest token. Otherwise nothing happens: browsing never opens a session.
 */
export async function joinIfActive(
  pool: pg.Pool,
  entry: EntryPoint,
): Promise<{ session: SessionRow; token: string } | null> {
  if (entry.kind !== 'table' || entry.tableId === null) return null;
  const tableId = entry.tableId;
  return withTransaction(pool, async (tx) => {
    await tx.lock('dining_tables', [tableId]);
    const session = await activeSessionAt(tx, tableId);
    if (!session) return null;
    const { token } = await issueGuestToken(tx, session.id, entry.id);
    await sessionChanged(tx, session);
    return { session, token };
  });
}

/**
 * S1 by a guest (first order from a table QR, step 3.4): join the table's session, or
 * open it. S2 from the counter QR (step 3.9): always a new takeaway session of this phone's
 * own. Inside the caller's transaction, so the order and the session commit together.
 */
export async function openOrJoinFromQr(
  tx: Tx,
  entry: EntryPoint,
  options: { customerName?: string | undefined } = {},
): Promise<{ session: SessionRow; token: string; tokenId: string; opened: boolean }> {
  if (entry.kind === 'counter_takeaway' || entry.tableId === null) {
    const session = await insertSession(tx, {
      tableId: null,
      via: 'qr',
      entryPointId: entry.id,
      customerName: options.customerName,
    });
    const { token, tokenId } = await issueGuestToken(tx, session.id, entry.id);
    await sessionChanged(tx, session);
    return { session, token, tokenId, opened: true };
  }
  await lockOrderableTable(tx, entry.tableId, true);
  const existing = await activeSessionAt(tx, entry.tableId);
  const session =
    existing ??
    (await insertSession(tx, { tableId: entry.tableId, via: 'qr', entryPointId: entry.id }));
  const { token, tokenId } = await issueGuestToken(tx, session.id, entry.id);
  await sessionChanged(tx, session);
  return { session, token, tokenId, opened: !existing };
}

export interface GuestContext {
  tokenId: string;
  entryPointId: string;
  session: SessionRow;
}

/**
 * The session behind a guest token. A revoked token, or one whose session has closed,
 * answers 401 VISIT_ENDED with no data (AT-40); so does a token never issued.
 */
export async function guestFromToken(db: Queryable, token: string): Promise<GuestContext> {
  const { rows } = await db.query<
    SessionRow & {
      token_id: string;
      entry_point_id: string;
      revoked_at: Date | null;
      seen_age: number;
    }
  >(
    `SELECT g.id::text AS token_id, g.entry_point_id::text, g.revoked_at,
            extract(epoch FROM now() - g.last_seen_at)::int AS seen_age,
            s.id::text, s.session_no, s.order_type, s.table_id::text, s.status, s.guest_count, s.opened_at
       FROM cl.session_guest_tokens g JOIN cl.dining_sessions s ON s.id = g.session_id
      WHERE g.token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || row.revoked_at !== null || !(ACTIVE as readonly string[]).includes(row.status)) {
    throw new AppError(
      'VISIT_ENDED',
      'This visit has ended. Scan the QR code on your table to start again.',
    );
  }
  if (row.seen_age > 60) {
    await db.query('UPDATE cl.session_guest_tokens SET last_seen_at = now() WHERE id = $1', [
      row.token_id,
    ]);
  }
  return { tokenId: row.token_id, entryPointId: row.entry_point_id, session: row };
}

// ---------------------------------------------------------------- stale sessions (T1)

/**
 * Raises one `stale_session` alert per session open longer than the setting
 * (`sessions.stale_alert_hours`, D-xx default 3 h). No state change (T1).
 */
export async function scanStaleSessions(pool: pg.Pool, now: Date): Promise<number> {
  const hours = await readSetting(pool, 'sessions.stale_alert_hours', z.number().positive());
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string; session_no: string; table_id: string | null }>(
      `INSERT INTO cl.operational_alerts (kind, entity_type, entity_id, detail)
       SELECT 'stale_session', 'dining_session', s.id,
              jsonb_build_object('sessionNo', s.session_no, 'openedAt', s.opened_at, 'tableId', s.table_id::text)
         FROM cl.dining_sessions s
        WHERE s.${ACTIVE_SQL} AND s.opened_at < $1::timestamptz - make_interval(hours => $2)
       ON CONFLICT (kind, entity_type, entity_id) WHERE state <> 'resolved' DO NOTHING
       RETURNING entity_id::text AS id, detail->>'sessionNo' AS session_no, detail->>'tableId' AS table_id`,
      [now, hours],
    );
    for (const r of rows) {
      await publish(tx, {
        type: 'alert.raised',
        entityType: 'dining_session',
        entityId: r.id,
        topics: ['alerts', 'floor'],
      });
    }
    return rows.length;
  });
}
