/**
 * T3 (ORDER_STATE_MACHINE.md §3, D-33): an accepted line not picked up within the setting
 * (`orders.uncollected_alert_minutes`, 30) raises one `uncollected_item` alert for waiters
 * and cashiers. Pickup or cancellation resolves it; so does this scan, as a safety net.
 */
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../platform/db/tx.ts';
import { publish } from '../../platform/outbox.ts';
import { readSetting } from '../../platform/settings.ts';

export async function scanUncollected(pool: pg.Pool, now: Date): Promise<number> {
  const minutes = await readSetting(
    pool,
    'orders.uncollected_alert_minutes',
    z.number().positive(),
  );
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cl.operational_alerts (kind, entity_type, entity_id, detail)
       SELECT 'uncollected_item', 'order_line', l.id,
              jsonb_build_object('item', l.item_name_snap, 'open', l.qty - l.qty_picked_up - l.qty_cancelled_unprepared,
                                 'sessionId', l.session_id::text, 'acceptedAt', r.decided_at)
         FROM cl.order_lines l JOIN cl.order_rounds r ON r.id = l.round_id
        WHERE r.status = 'accepted' AND l.qty_picked_up + l.qty_cancelled_unprepared < l.qty
          AND r.decided_at < $1::timestamptz - make_interval(mins => $2)
       ON CONFLICT (kind, entity_type, entity_id) WHERE state <> 'resolved' DO NOTHING
       RETURNING entity_id::text AS id`,
      [now, minutes],
    );
    await tx.query(
      `UPDATE cl.operational_alerts a SET state = 'resolved', resolved_at = now()
         FROM cl.order_lines l
        WHERE a.kind = 'uncollected_item' AND a.entity_type = 'order_line' AND a.entity_id = l.id
          AND a.state <> 'resolved' AND l.qty_picked_up + l.qty_cancelled_unprepared = l.qty`,
    );
    for (const r of rows) {
      await publish(tx, {
        type: 'alert.raised',
        entityType: 'order_line',
        entityId: r.id,
        topics: ['alerts', 'kitchen'],
      });
    }
    return rows.length;
  });
}
