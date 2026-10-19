/**
 * Audit writer (SECURITY.md §3, ORD-009, AT-95). Called inside the same transaction as
 * the change it describes, so an audited change and its audit row commit together.
 * cl.audit_events is append-only.
 */
import type { Queryable } from './db/pool.ts';

export type Actor =
  | { kind: 'user'; userId: string; deviceId?: string }
  | { kind: 'guest'; deviceId?: undefined }
  | { kind: 'system'; deviceId?: undefined };

export interface AuditContext {
  actor: Actor;
  correlationId: string;
  ip?: string;
}

export interface AuditEntry {
  /** Dotted action name, e.g. 'role.grant', 'settings.update'. */
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  approvedBy?: string;
}

export async function writeAudit(
  db: Queryable,
  context: AuditContext,
  entry: AuditEntry,
): Promise<string> {
  const { actor } = context;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cl.audit_events
       (actor_kind, actor_user_id, device_id, action, entity_type, entity_id,
        before, after, reason, approved_by, correlation_id, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id::text`,
    [
      actor.kind,
      actor.kind === 'user' ? actor.userId : null,
      actor.deviceId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      entry.approvedBy ?? null,
      context.correlationId,
      context.ip ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('audit insert returned no id');
  return id;
}
