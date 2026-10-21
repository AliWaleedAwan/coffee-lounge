/**
 * The floor (API.md §5.3 `GET /floor`): every table with its derived state, the waiter
 * it is assigned to, and its session with orders waiting for approval and accepted units
 * not yet picked up.
 */
import { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import { readSetting } from '../../platform/settings.ts';

export type TableState =
  'available' | 'occupied' | 'checkout_requested' | 'checkout_locked' | 'blocked' | 'maintenance';

export async function readFloor(db: Queryable, now: Date) {
  const hours = await readSetting(db, 'sessions.stale_alert_hours', z.number().positive());
  const { rows } = await db.query<{
    id: string;
    code: string;
    name: string;
    area: string | null;
    seats: number | null;
    layout_x: number | null;
    layout_y: number | null;
    availability: 'active' | 'blocked' | 'maintenance';
    waiter_id: string | null;
    waiter_name: string | null;
    session_id: string | null;
    session_no: string | null;
    session_status: string | null;
    guest_count: number | null;
    opened_at: Date | null;
    guest_phones: number;
    pending_rounds: number;
    uncollected: number;
  }>(
    `SELECT t.id::text, t.code, t.name, t.area, t.seats, t.layout_x, t.layout_y, t.availability,
            a.user_id::text AS waiter_id, u.display_name AS waiter_name,
            s.id::text AS session_id, s.session_no, s.status AS session_status, s.guest_count, s.opened_at,
            COALESCE((SELECT count(*)::int FROM cl.session_guest_tokens g
                       WHERE g.session_id = s.id AND g.revoked_at IS NULL), 0) AS guest_phones,
            COALESCE((SELECT count(*)::int FROM cl.order_rounds r
                       WHERE r.session_id = s.id AND r.status = 'pending_approval'), 0) AS pending_rounds,
            COALESCE((SELECT sum(l.qty - l.qty_picked_up - l.qty_cancelled_unprepared)::int
                        FROM cl.order_lines l JOIN cl.order_rounds r ON r.id = l.round_id
                       WHERE l.session_id = s.id AND r.status = 'accepted'), 0) AS uncollected
       FROM cl.dining_tables t
       LEFT JOIN cl.table_assignments a ON a.table_id = t.id AND a.ended_at IS NULL
       LEFT JOIN cl.users u ON u.id = a.user_id
       LEFT JOIN cl.dining_sessions s ON s.table_id = t.id
             AND s.status IN ('open','checkout_requested','checkout_locked')
      WHERE t.archived_at IS NULL
      ORDER BY t.sort, t.code`,
  );
  const staleBefore = now.getTime() - hours * 3600_000;
  return {
    tables: rows.map((r) => {
      const state: TableState =
        r.availability !== 'active'
          ? r.availability
          : r.session_status === 'checkout_requested' || r.session_status === 'checkout_locked'
            ? r.session_status
            : r.session_id
              ? 'occupied'
              : 'available';
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        area: r.area,
        seats: r.seats,
        layoutX: r.layout_x,
        layoutY: r.layout_y,
        availability: r.availability,
        state,
        waiter: r.waiter_id ? { id: r.waiter_id, name: r.waiter_name ?? '' } : null,
        session:
          r.session_id && r.opened_at
            ? {
                id: r.session_id,
                sessionNo: r.session_no ?? '',
                status: r.session_status ?? '',
                guestCount: r.guest_count,
                openedAt: r.opened_at.toISOString(),
                guestPhones: r.guest_phones,
                pendingRounds: r.pending_rounds,
                notPickedUp: r.uncollected,
                stale: r.opened_at.getTime() < staleBefore,
              }
            : null,
      };
    }),
  };
}
