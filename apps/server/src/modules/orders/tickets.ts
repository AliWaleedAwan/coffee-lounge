/**
 * Kitchen tickets (ORDER_STATE_MACHINE.md §4). A ticket is made when a round is accepted
 * (K1: `new` for the visit's first ticket, else `supplement`), and a `correction` or
 * `void` ticket when accepted units are cancelled (K2). Content never changes; only the
 * status moves (K3/K4). Ticket content is built from a fixed list of fields: names, size,
 * choices, quantity and notes. Prices, payments and guest details cannot appear (AT-99).
 * Printing joins in step 3.6.
 */
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { publish } from '../../platform/outbox.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { requestPrint, stationPrinter } from '../printing/index.ts';

export interface TicketDisplay {
  item: string;
  variant: string;
  modifiers: string[];
  notes: string | null;
}

interface LineForTicket {
  id: string;
  station_id: string;
  item_name_snap: string;
  variant_name_snap: string;
  notes: string | null;
}

async function defaultStation(tx: Tx): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id::text FROM cl.stations ORDER BY stations.id LIMIT 1`,
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no kitchen station');
  return id;
}

async function kitchenTemplate(tx: Tx): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id::text FROM cl.ticket_templates WHERE kind = 'kitchen' AND is_active`,
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no active kitchen ticket template');
  return id;
}

async function ticketNo(tx: Tx, now: Date): Promise<string> {
  const businessDate = await businessDateOf(tx, now);
  const n = await tx.nextNumber('ticket', businessDate);
  return `K-${businessDate.slice(5, 7)}${businessDate.slice(8, 10)}-${n.padStart(3, '0')}`;
}

/** Stations for the round's lines: the item's station, else the shop's kitchen (D-26). */
export async function assignStations(tx: Tx, roundId: string): Promise<void> {
  const fallback = await defaultStation(tx);
  await tx.query(
    `UPDATE cl.order_lines l SET station_id = COALESCE(i.station_id, $2)
       FROM cl.menu_variants v JOIN cl.menu_items i ON i.id = v.item_id
      WHERE l.round_id = $1 AND v.id = l.variant_id`,
    [roundId, fallback],
  );
}

async function displayOf(
  tx: Tx,
  lines: readonly LineForTicket[],
): Promise<Map<string, TicketDisplay>> {
  const { rows } = await tx.query<{ line_id: string; name_snap: string; qty: number }>(
    `SELECT line_id::text, name_snap, qty FROM cl.order_line_modifiers WHERE line_id = ANY($1::bigint[]) ORDER BY id`,
    [lines.map((l) => l.id)],
  );
  return new Map(
    lines.map((l) => [
      l.id,
      {
        item: l.item_name_snap,
        variant: l.variant_name_snap,
        modifiers: rows
          .filter((m) => m.line_id === l.id)
          .map((m) => (m.qty > 1 ? `${m.name_snap} ×${String(m.qty)}` : m.name_snap)),
        notes: l.notes,
      },
    ]),
  );
}

async function insertTicket(
  tx: Tx,
  input: {
    roundId: string;
    stationId: string;
    kind: 'new' | 'supplement' | 'correction' | 'void';
    supersedes?: string;
    status: 'open' | 'completed';
    now: Date;
  },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cl.kitchen_tickets (ticket_no, round_id, station_id, kind, supersedes_ticket_id, template_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
    [
      await ticketNo(tx, input.now),
      input.roundId,
      input.stationId,
      input.kind,
      input.supersedes ?? null,
      await kitchenTemplate(tx),
      input.status,
    ],
  );
  return rows[0]?.id ?? '';
}

/** Its print job, if the station has a printer (PRINTING_HARDWARE.md §5). Staff screens show the ticket either way. */
async function printTicket(tx: Tx, ticketId: string, stationId: string): Promise<void> {
  const printerId = await stationPrinter(tx, stationId);
  if (printerId !== null)
    await requestPrint(tx, { printerId, documentType: 'kitchen_ticket', documentId: ticketId });
}

/** K1, inside the acceptance transaction (after the stock, before nothing else locks). */
export async function ticketsForRound(
  tx: Tx,
  roundId: string,
  sessionId: string,
  now: Date,
): Promise<string[]> {
  await assignStations(tx, roundId);
  const { rows: lines } = await tx.query<LineForTicket & { qty: number }>(
    `SELECT id::text, station_id::text, item_name_snap, variant_name_snap, notes, qty
       FROM cl.order_lines WHERE round_id = $1 ORDER BY line_no`,
    [roundId],
  );
  const { rows: earlier } = await tx.query(
    `SELECT 1 FROM cl.kitchen_tickets k JOIN cl.order_rounds r ON r.id = k.round_id
      WHERE r.session_id = $1 AND k.kind IN ('new','supplement') AND r.id <> $2 LIMIT 1`,
    [sessionId, roundId],
  );
  const display = await displayOf(tx, lines);
  const ids: string[] = [];
  for (const stationId of [...new Set(lines.map((l) => l.station_id))]) {
    const ticketId = await insertTicket(tx, {
      roundId,
      stationId,
      kind: earlier.length > 0 ? 'supplement' : 'new',
      status: 'open',
      now,
    });
    for (const l of lines.filter((x) => x.station_id === stationId)) {
      await tx.query(
        'INSERT INTO cl.kitchen_ticket_lines (ticket_id, order_line_id, qty, display) VALUES ($1, $2, $3, $4)',
        [ticketId, l.id, l.qty, JSON.stringify(display.get(l.id))],
      );
    }
    await printTicket(tx, ticketId, stationId);
    ids.push(ticketId);
  }
  return ids;
}

/**
 * K2 for a cancellation of `qty` units of a line: a `correction` ticket, or `void` when
 * nothing of the original ticket is left to make (the original is then cancelled, K4).
 */
export async function correctionTicket(
  tx: Tx,
  lineId: string,
  qty: number,
  now: Date,
): Promise<string | null> {
  const { rows: originals } = await tx.query<{ id: string; round_id: string; station_id: string }>(
    `SELECT k.id::text, k.round_id::text, k.station_id::text FROM cl.kitchen_tickets k
       JOIN cl.kitchen_ticket_lines kl ON kl.ticket_id = k.id
      WHERE kl.order_line_id = $1 AND k.kind IN ('new','supplement')`,
    [lineId],
  );
  const original = originals[0];
  if (!original) return null;
  const { rows: remaining } = await tx.query<{ open: number; picked: number }>(
    `SELECT COALESCE(sum(l.qty - l.qty_picked_up - l.qty_cancelled_unprepared), 0)::int AS open,
            COALESCE(sum(l.qty_picked_up), 0)::int AS picked
       FROM cl.kitchen_ticket_lines kl JOIN cl.order_lines l ON l.id = kl.order_line_id
      WHERE kl.ticket_id = $1`,
    [original.id],
  );
  const nothingLeft = (remaining[0]?.open ?? 0) === 0 && (remaining[0]?.picked ?? 0) === 0;
  const ticketId = await insertTicket(tx, {
    roundId: original.round_id,
    stationId: original.station_id,
    kind: nothingLeft ? 'void' : 'correction',
    supersedes: original.id,
    status: 'completed',
    now,
  });
  const { rows: line } = await tx.query<LineForTicket>(
    'SELECT id::text, station_id::text, item_name_snap, variant_name_snap, notes FROM cl.order_lines WHERE id = $1',
    [lineId],
  );
  const display = await displayOf(tx, line);
  await tx.query(
    'INSERT INTO cl.kitchen_ticket_lines (ticket_id, order_line_id, qty, display) VALUES ($1, $2, $3, $4)',
    [ticketId, lineId, qty, JSON.stringify({ ...display.get(lineId), cancelled: true })],
  );
  await printTicket(tx, ticketId, original.station_id);
  return ticketId;
}

/** K3/K4: original tickets of these rounds whose lines are all done. */
export async function settleTickets(tx: Tx, roundIds: readonly string[]): Promise<void> {
  await tx.query(
    `UPDATE cl.kitchen_tickets k
        SET status = CASE WHEN done.picked = 0 THEN 'cancelled' ELSE 'completed' END
       FROM (SELECT kl.ticket_id,
                    bool_and(l.qty_picked_up + l.qty_cancelled_unprepared = l.qty) AS all_done,
                    sum(l.qty_picked_up) AS picked
               FROM cl.kitchen_ticket_lines kl JOIN cl.order_lines l ON l.id = kl.order_line_id
              GROUP BY kl.ticket_id) done
      WHERE k.id = done.ticket_id AND done.all_done AND k.status = 'open'
        AND k.kind IN ('new','supplement') AND k.round_id = ANY($1::bigint[])`,
    [roundIds],
  );
}

export async function kitchenChanged(
  tx: Tx,
  session: { id: string; table_id: string | null },
  entityId: string,
): Promise<void> {
  await publish(tx, {
    type: 'line.changed',
    entityType: 'order_line',
    entityId,
    topics: [
      'kitchen',
      'floor',
      `session:${session.id}`,
      ...(session.table_id ? [`table:${session.table_id}`] : []),
    ],
  });
}

// ---------------------------------------------------------------- reading

/** Where a ticket goes: the table, or the takeaway/delivery visit number. Never a guest's name. */
function whereOf(r: { order_type: string; table_name: string | null; session_no: string }): string {
  if (r.table_name) return r.table_name;
  return `${r.order_type === 'delivery' ? 'Delivery' : 'Takeaway'} ${r.session_no}`;
}

/**
 * The pickup queue (API.md §5.4): original tickets with units still to pick up, oldest
 * first; `uncollected` once accepted longer than the setting (D-33, 30 min).
 */
export async function pickupQueue(db: Queryable, now: Date, uncollectedMinutes: number) {
  const { rows } = await db.query<{
    ticket_id: string;
    ticket_no: string;
    kind: string;
    accepted_at: Date;
    order_type: string;
    started: boolean;
    table_name: string | null;
    session_no: string;
    session_id: string;
    line_id: string;
    qty: number;
    open: number;
    display: { item: string; variant: string; modifiers: string[]; notes: string | null };
  }>(
    `SELECT k.id::text AS ticket_id, k.ticket_no, k.kind, k.started_at IS NOT NULL AS started, r.decided_at AS accepted_at, s.order_type,
            t.name AS table_name, s.session_no, s.id::text AS session_id,
            l.id::text AS line_id, l.qty, (l.qty - l.qty_picked_up - l.qty_cancelled_unprepared) AS open, kl.display
       FROM cl.kitchen_tickets k
       JOIN cl.order_rounds r ON r.id = k.round_id
       JOIN cl.dining_sessions s ON s.id = r.session_id
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
       JOIN cl.kitchen_ticket_lines kl ON kl.ticket_id = k.id
       JOIN cl.order_lines l ON l.id = kl.order_line_id
      WHERE k.status = 'open' AND k.kind IN ('new','supplement')
      ORDER BY r.decided_at, k.id, l.line_no`,
  );
  const tickets = new Map<
    string,
    {
      id: string;
      ticketNo: string;
      kind: string;
      where: string;
      sessionId: string;
      acceptedAt: string;
      started: boolean;
      uncollected: boolean;
      lines: {
        orderLineId: string;
        qty: number;
        open: number;
        item: string;
        variant: string;
        modifiers: string[];
        notes: string | null;
      }[];
    }
  >();
  for (const r of rows) {
    const t = tickets.get(r.ticket_id) ?? {
      id: r.ticket_id,
      ticketNo: r.ticket_no,
      kind: r.kind,
      where: whereOf(r),
      sessionId: r.session_id,
      acceptedAt: r.accepted_at.toISOString(),
      started: r.started,
      uncollected: now.getTime() - r.accepted_at.getTime() >= uncollectedMinutes * 60_000,
      lines: [],
    };
    t.lines.push({
      orderLineId: r.line_id,
      qty: r.qty,
      open: r.open,
      item: r.display.item,
      variant: r.display.variant,
      modifiers: r.display.modifiers,
      notes: r.display.notes,
    });
    tickets.set(r.ticket_id, t);
  }
  return { tickets: [...tickets.values()].filter((t) => t.lines.some((l) => l.open > 0)) };
}

/** One ticket as the kitchen sees it (and as it will print). */
export async function ticketView(db: Queryable, ticketId: string) {
  const { rows } = await db.query<{
    id: string;
    ticket_no: string;
    kind: string;
    status: string;
    created_at: Date;
    supersedes: string | null;
    order_type: string;
    table_name: string | null;
    session_no: string;
  }>(
    `SELECT k.id::text, k.ticket_no, k.kind, k.status, k.created_at, o.ticket_no AS supersedes,
            s.order_type, t.name AS table_name, s.session_no
       FROM cl.kitchen_tickets k
       LEFT JOIN cl.kitchen_tickets o ON o.id = k.supersedes_ticket_id
       JOIN cl.order_rounds r ON r.id = k.round_id
       JOIN cl.dining_sessions s ON s.id = r.session_id
       LEFT JOIN cl.dining_tables t ON t.id = s.table_id
      WHERE k.id = $1`,
    [ticketId],
  );
  const t = rows[0];
  if (!t) return null;
  const { rows: lines } = await db.query<{
    qty: number;
    display: TicketDisplay & { cancelled?: boolean };
  }>('SELECT qty, display FROM cl.kitchen_ticket_lines WHERE ticket_id = $1 ORDER BY id', [
    ticketId,
  ]);
  return {
    id: t.id,
    ticketNo: t.ticket_no,
    kind: t.kind,
    status: t.status,
    createdAt: t.created_at.toISOString(),
    supersedes: t.supersedes,
    where: whereOf(t),
    lines: lines.map((l) => ({
      qty: l.qty,
      item: l.display.item,
      variant: l.display.variant,
      modifiers: l.display.modifiers,
      notes: l.display.notes,
      cancelled: l.display.cancelled === true,
    })),
  };
}
