/**
 * Transactional outbox (02-architecture §2.8, API.md §7).
 *
 * A business transaction calls publish() alongside its changes. The row and the
 * NOTIFY commit together: if the transaction rolls back, no hint ever exists.
 * Hints carry only what changed (type, entity, version, topics), never business data;
 * clients refetch through the API.
 */
import type { Queryable } from './db/pool.ts';

export const OUTBOX_CHANNEL = 'cl_outbox';

/** "approvals", "kitchen", "session:812", "table:5" … */
const TOPIC = /^[a-z_]+(:[0-9a-z_-]{1,40})?$/;
const NAME = /^[a-z_]+(\.[a-z_]+)+$/;

export interface OutboxEvent {
  /** Dotted event name, e.g. "round.decided" (API.md §7 table). */
  type: string;
  entityType: string;
  entityId: string;
  version?: number;
  topics: readonly string[];
}

export async function publish(db: Queryable, event: OutboxEvent): Promise<string> {
  if (!NAME.test(event.type)) throw new Error(`Invalid event type "${event.type}"`);
  if (event.topics.length === 0) throw new Error('An event needs at least one topic');
  for (const topic of event.topics) {
    if (!TOPIC.test(topic)) throw new Error(`Invalid topic "${topic}"`);
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cl.outbox_events (topics, event_type, entity_type, entity_id, entity_version)
     VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
    [
      [...new Set(event.topics)],
      event.type,
      event.entityType,
      event.entityId,
      event.version ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('outbox insert returned no id');
  // Delivered to listeners only when (and if) the transaction commits.
  await db.query('SELECT pg_notify($1, $2)', [OUTBOX_CHANNEL, id]);
  return id;
}

/** A committed outbox row as read by the live hub. */
export interface OutboxRow {
  id: string;
  topics: string[];
  event_type: string;
  entity_type: string;
  entity_id: string;
  entity_version: number | null;
  created_at: Date;
}
