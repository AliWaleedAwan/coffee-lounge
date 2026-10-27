/**
 * The audit log viewer (SECURITY.md §4; Phase 5 step 5.5): who did what to which record,
 * when, on which device, with the before and after, the reason and who approved it
 * (AT-95). Read only: audit events are append-only (DATABASE.md §12).
 */
import type { Queryable } from '../../platform/db/pool.ts';

export interface AuditFilter {
  from?: string | undefined;
  to?: string | undefined;
  userId?: string | undefined;
  action?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  /** Older than this event id (the next page). */
  before?: string | undefined;
  limit?: number | undefined;
}

export interface AuditItem {
  id: string;
  at: string;
  actorKind: 'user' | 'guest' | 'system';
  actor: string | null;
  device: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  approvedBy: string | null;
  ip: string | null;
  correlationId: string;
}

/** Newest first, a page at a time; dates are the shop's calendar days. */
export async function readAudit(
  db: Queryable,
  filter: AuditFilter,
): Promise<{ items: AuditItem[]; nextBefore: string | null }> {
  const limit = Math.min(filter.limit ?? 100, 200);
  const { rows } = await db.query<AuditItem>(
    `WITH tz AS (SELECT value #>> '{}' AS zone FROM cl.system_settings WHERE key = 'shop.timezone')
     SELECT a.id::text, a.occurred_at AS at, a.actor_kind AS "actorKind", u.display_name AS actor,
            d.name AS device, a.action, a.entity_type AS "entityType", a.entity_id::text AS "entityId",
            a.before, a.after, a.reason, ap.display_name AS "approvedBy", host(a.ip) AS ip,
            a.correlation_id::text AS "correlationId"
       FROM cl.audit_events a CROSS JOIN tz
       LEFT JOIN cl.users u ON u.id = a.actor_user_id
       LEFT JOIN cl.users ap ON ap.id = a.approved_by
       LEFT JOIN cl.devices d ON d.id = a.device_id
      WHERE ($1::date IS NULL OR a.occurred_at >= ($1::date::timestamp AT TIME ZONE tz.zone))
        AND ($2::date IS NULL OR a.occurred_at < (($2::date + 1)::timestamp AT TIME ZONE tz.zone))
        AND ($3::bigint IS NULL OR a.actor_user_id = $3 OR a.approved_by = $3)
        AND ($4::text IS NULL OR a.action = $4 OR a.action LIKE $4 || '.%')
        AND ($5::text IS NULL OR a.entity_type = $5)
        AND ($6::bigint IS NULL OR a.entity_id = $6)
        AND ($7::bigint IS NULL OR a.id < $7)
      ORDER BY a.id DESC
      LIMIT $8`,
    [
      filter.from ?? null,
      filter.to ?? null,
      filter.userId ?? null,
      filter.action ?? null,
      filter.entityType ?? null,
      filter.entityId ?? null,
      filter.before ?? null,
      limit + 1,
    ],
  );
  const items = rows.slice(0, limit);
  return { items, nextBefore: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

/** What the filters can be set to: the actions and record types seen, and the people. */
export async function auditFilters(db: Queryable): Promise<{
  actions: string[];
  entityTypes: string[];
  people: { id: string; name: string }[];
}> {
  const { rows: actions } = await db.query<{ action: string }>(
    'SELECT DISTINCT action FROM cl.audit_events ORDER BY action',
  );
  const { rows: types } = await db.query<{ entity_type: string }>(
    'SELECT DISTINCT entity_type FROM cl.audit_events ORDER BY entity_type',
  );
  const { rows: people } = await db.query<{ id: string; name: string }>(
    'SELECT id::text, display_name AS name FROM cl.users ORDER BY lower(display_name), users.id',
  );
  return {
    actions: actions.map((a) => a.action),
    entityTypes: types.map((t) => t.entity_type),
    people,
  };
}
