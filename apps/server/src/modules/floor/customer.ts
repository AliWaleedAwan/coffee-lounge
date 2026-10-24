/**
 * Guest side of the floor on the customer listener (API.md §4, §5.1). A guest is known
 * only by cookies: the signed entry cookie (which QR code was scanned) and, once at a
 * session, the guest token. The table always comes from the QR code: no customer route
 * takes a table or session id (AT-127). Browsing never opens a session (AT-74).
 */
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import { AppError } from '../../platform/errors.ts';
import { parseInput } from '../../platform/validation.ts';
import { guestOrderingOpen, readBranding } from '../settings/index.ts';
import { readMenu } from '../catalog/index.ts';
import { guestFromToken, joinIfActive, type EntryPoint } from './sessions.ts';
import {
  ENTRY_COOKIE,
  ENTRY_TTL_SECONDS,
  entryKey,
  GUEST_COOKIE,
  GUEST_TTL_SECONDS,
  hashToken,
  looksLikeToken,
  signEntry,
  verifyEntry,
} from './tokens.ts';

interface EntryRow {
  id: string;
  kind: 'table' | 'counter_takeaway';
  table_id: string | null;
  label: string;
  table_code: string | null;
  table_name: string | null;
  availability: string | null;
  table_archived: boolean;
}

const ENTRY_SQL = `SELECT q.id::text, q.kind, q.table_id::text, q.label, t.code AS table_code, t.name AS table_name,
                          t.availability, t.archived_at IS NOT NULL AS table_archived
                     FROM cl.qr_entry_points q LEFT JOIN cl.dining_tables t ON t.id = q.table_id
                    WHERE q.is_active AND `;

async function activeEntry(
  db: Queryable,
  where: string,
  value: unknown,
): Promise<EntryRow | undefined> {
  const { rows } = await db.query<EntryRow>(`${ENTRY_SQL}${where}`, [value]);
  const row = rows[0];
  return row && !row.table_archived ? row : undefined;
}

const toEntryPoint = (e: EntryRow): EntryPoint => ({ id: e.id, kind: e.kind, tableId: e.table_id });

export function setGuestCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  maxAge: number,
): void {
  // Plain HTTP on the shop Wi-Fi (SECURITY.md SR-3): httpOnly, never Secure; Lax so the
  // cookie also travels when the phone's camera app opens the QR link.
  void reply.setCookie(name, value, { httpOnly: true, sameSite: 'lax', path: '/', maxAge });
}

/**
 * The entry point behind a phone's entry cookie: valid signature, under 12 hours old,
 * QR code still in use, table not archived. Null otherwise.
 */
export async function resolveEntry(
  pool: pg.Pool,
  cookieValue: unknown,
  now: Date,
): Promise<EntryPoint | null> {
  const entryPointId = verifyEntry(await entryKey(pool), cookieValue, now);
  const entry = entryPointId ? await activeEntry(pool, 'q.id = $1', entryPointId) : undefined;
  return entry ? toEntryPoint(entry) : null;
}

export interface CustomerFloorOptions {
  pool: pg.Pool;
  now?: () => Date;
}

export async function customerFloorRoutes(
  app: FastifyInstance,
  options: CustomerFloorOptions,
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());
  await app.register(cookie);

  /** The entry point behind this phone's entry cookie, or VISIT_ENDED. */
  const entryOf = async (request: FastifyRequest): Promise<EntryRow> => {
    const key = await entryKey(pool);
    const entryPointId = verifyEntry(key, request.cookies[ENTRY_COOKIE], now());
    const entry = entryPointId ? await activeEntry(pool, 'q.id = $1', entryPointId) : undefined;
    if (!entry)
      throw new AppError('VISIT_ENDED', 'Scan the QR code on your table to see the menu.');
    return entry;
  };

  app.get('/entry/:qrToken', { config: { auth: 'public' } }, async (request, reply) => {
    const { qrToken } = parseInput(
      z.object({ qrToken: z.string().max(64) }).strict(),
      request.params,
    );
    parseInput(z.object({}).strict(), request.query);
    const entry = looksLikeToken(qrToken)
      ? await activeEntry(pool, 'q.token_hash = $1', hashToken(qrToken))
      : undefined;
    if (!entry) {
      throw new AppError(
        'NOT_FOUND',
        'This QR code is no longer in use. Please ask a member of staff.',
      );
    }
    setGuestCookie(
      reply,
      ENTRY_COOKIE,
      signEntry(await entryKey(pool), entry.id, now()),
      ENTRY_TTL_SECONDS,
    );

    // A phone already holding a live token for this table's session (or, at the counter,
    // for the takeaway it ordered from this code) keeps it. A token for any other visit is
    // dropped, so the next order goes where the phone just scanned.
    let session: { sessionNo: string; openedAt: string } | null = null;
    const held = request.cookies[GUEST_COOKIE];
    if (looksLikeToken(held)) {
      try {
        const guest = await guestFromToken(pool, held);
        const same =
          entry.kind === 'table'
            ? guest.session.table_id !== null && guest.session.table_id === entry.table_id
            : guest.session.table_id === null && guest.entryPointId === entry.id;
        if (same) {
          session = {
            sessionNo: guest.session.session_no,
            openedAt: guest.session.opened_at.toISOString(),
          };
        } else {
          void reply.clearCookie(GUEST_COOKIE, { path: '/' });
        }
      } catch {
        // An ended visit: forget its token so this scan starts fresh.
        void reply.clearCookie(GUEST_COOKIE, { path: '/' });
      }
    }
    if (!session && entry.availability === 'active') {
      const joined = await joinIfActive(pool, toEntryPoint(entry));
      if (joined) {
        setGuestCookie(reply, GUEST_COOKIE, joined.token, GUEST_TTL_SECONDS);
        session = {
          sessionNo: joined.session.session_no,
          openedAt: joined.session.opened_at.toISOString(),
        };
      }
    }
    const hours = await guestOrderingOpen(pool, now());
    const branding = await readBranding(pool);
    return {
      branding: { shopName: branding.shopName, primary: branding.primary },
      /** Guests order by QR within the shop's hours (AT-130); staff always can. */
      hours,
      entry: {
        kind: entry.kind,
        label: entry.label,
        table: entry.table_code ? { code: entry.table_code, name: entry.table_name } : null,
      },
      orderingOpen:
        hours.open && (entry.kind === 'counter_takeaway' || entry.availability === 'active'),
      session,
    };
  });

  app.get('/menu', { config: { auth: 'public' } }, async (request) => {
    parseInput(z.object({}).strict(), request.query);
    const entry = await entryOf(request);
    const orderType = entry.kind === 'table' ? 'dine_in' : 'takeaway';
    const menu = await readMenu(pool, { management: false, now: now(), orderType });
    const allowed = (i: { allowDineIn: boolean; allowTakeaway: boolean }) =>
      orderType === 'dine_in' ? i.allowDineIn : i.allowTakeaway;
    return {
      orderType,
      categories: menu.categories
        .map((c) => ({ ...c, items: c.items.filter(allowed) }))
        .filter((c) => c.items.length > 0),
    };
  });
}
